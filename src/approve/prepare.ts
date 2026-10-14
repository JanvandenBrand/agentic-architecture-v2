import { mkdir } from "node:fs/promises";
import path from "node:path";

import writeFileAtomic from "write-file-atomic";

import { resolveCasePolicy, validateLoadedCase } from "../case/index.js";
import { resolveCasePath } from "../case/path.js";
import { loadCaseRecords } from "../case/records.js";
import {
  asApproval,
  latestApprovals,
  latestCandidateEvents,
  latestReviews,
  type Approval,
  type Binding,
  type Review,
} from "../case/review-records.js";
import { readLifecycle } from "../framework/lifecycle.js";
import {
  IdentityError,
  readEncryptedPrivateKey,
  readIdentity,
} from "../identity/keys.js";
import { signApproval } from "../identity/signature.js";
import type { ContractVersion } from "../schema/catalogue.js";

export interface ApprovalContext {
  schemaVersion: ContractVersion;
  caseRoot: string;
  caseName: string;
  artifactPrefix: string;
  phaseId: string;
  artifacts: Binding[];
  reviewBindings: Binding[];
  verdicts: { reviewer: string; verdict: string; round: number }[];
  outputPath: string;
  approverLabel: string;
  keyFingerprint: string;
}

export class ApproveError extends Error {
  public constructor(
    message: string,
    public readonly remediation: string,
  ) {
    super(`${message} Fix: ${remediation}`);
    this.name = "ApproveError";
  }
}

function bindingKey(bindings: Binding[]): string {
  return bindings
    .map(({ path: bindingPath, sha256 }) => `${bindingPath}=${sha256}`)
    .sort()
    .join("\n");
}

function byPath(left: Binding, right: Binding): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

/**
 * The phases that must already hold an approved decision before this one may be
 * approved: the preceding standard-route phase, plus any explicit
 * `approved-phase-<id>` prerequisite the lifecycle declares.
 */
async function requiredApprovedPhases(
  repositoryRoot: string,
  phaseId: string,
): Promise<string[]> {
  const lifecycle = await readLifecycle(repositoryRoot);
  const required = new Set<string>();
  const routeIndex = lifecycle.standardRoute.indexOf(phaseId);
  const routePredecessor =
    routeIndex > 0 ? lifecycle.standardRoute[routeIndex - 1] : undefined;
  if (routePredecessor) {
    required.add(routePredecessor);
  }
  const phase = lifecycle.phases.find(({ id }) => id === phaseId);
  for (const requirement of phase?.requires ?? []) {
    const match = /^approved-phase-([0-8])$/u.exec(requirement);
    if (match?.[1]) {
      required.add(match[1]);
    }
  }
  return [...required];
}

/**
 * Gathers everything the architect must see before deciding, and fails closed
 * when the phase is not actually ready. The command refuses to offer a decision
 * the evidence does not support, so approval cannot become a reflex.
 */
export async function prepareApproval(options: {
  repositoryRoot: string;
  casePath: string;
  phaseId: string;
  home?: string;
}): Promise<ApprovalContext> {
  const identity = await readIdentity(options.home);
  if (!identity) {
    throw new ApproveError(
      "No architect approval identity exists on this machine.",
      "Create the architect identity once before approving a phase.",
    );
  }

  const resolved = await resolveCasePath(
    options.repositoryRoot,
    options.casePath,
  );
  if (!resolved.caseRoot) {
    throw new ApproveError(
      resolved.errors[0]?.message ?? "The case path is invalid.",
      resolved.errors[0]?.remediation ?? "Pass cases/<case-name>.",
    );
  }
  const caseRoot = resolved.caseRoot;

  const loaded = await loadCaseRecords(options.repositoryRoot, caseRoot);
  const resolvedPolicy = resolveCasePolicy(loaded.records);
  if (!resolvedPolicy.policy) {
    throw new ApproveError(
      resolvedPolicy.errors[0]?.message ?? "The case policy cannot be resolved.",
      "Resolve the case contract version and host before recording a decision.",
    );
  }
  const validation = await validateLoadedCase(
    options.repositoryRoot,
    caseRoot,
    loaded,
    { ...(options.home ? { home: options.home } : {}) },
  );
  // The approval being recorded is precisely what settles convergence, approval
  // binding, assurance mode, and phase sequence. Blocking on those would be
  // circular: the case cannot satisfy them until this decision exists. Every
  // other invariant describes evidence that must already be sound, so it blocks.
  const decidedByThisApproval = new Set([
    "review-convergence",
    "approval-binding",
    "approval-mode",
    "phase-sequence",
  ]);
  const blocking = [
    ...new Set(
      validation.errors
        .filter(({ invariant }) => !decidedByThisApproval.has(invariant))
        .map(({ invariant }) => invariant),
    ),
  ];
  if (blocking.length > 0) {
    throw new ApproveError(
      `The case does not currently validate: ${blocking.join(", ")}.`,
      "Resolve the reported contract failures before recording a human decision.",
    );
  }

  const approvals = latestApprovals(
    loaded.records
      .map(asApproval)
      .filter((value): value is Approval => value !== undefined),
  );
  for (const required of await requiredApprovedPhases(
    options.repositoryRoot,
    options.phaseId,
  )) {
    if (approvals.get(required)?.decision !== "APPROVED") {
      throw new ApproveError(
        `Phase ${options.phaseId} cannot be approved while phase ${required} has no approved human decision.`,
        `Approve phase ${required} first. Phases are approved in lifecycle order.`,
      );
    }
  }

  const reviews = latestReviews(loaded.records);
  const affA = reviews.get(`${options.phaseId}:AFF-A`);
  const affB = reviews.get(`${options.phaseId}:AFF-B`);
  if (!affA?.final || !affB?.final) {
    throw new ApproveError(
      `Phase ${options.phaseId} has no final record from both AFF-A and AFF-B.`,
      "Complete both independent final reviews before approving.",
    );
  }
  if (bindingKey(affA.subjectArtifacts) !== bindingKey(affB.subjectArtifacts)) {
    throw new ApproveError(
      `The Phase ${options.phaseId} reviewers cover different artifacts or hashes.`,
      "Re-run both final reviews against the identical current artifact set.",
    );
  }

  const candidate = latestCandidateEvents(loaded.records).get(options.phaseId);
  if (!candidate) {
    throw new ApproveError(
      `Phase ${options.phaseId} has no current ARTIFACTS-RECORDED journal event.`,
      "Append the complete candidate hash set to the run journal before approval.",
    );
  }
  if (bindingKey(candidate.artifacts) !== bindingKey(affA.subjectArtifacts)) {
    throw new ApproveError(
      `The Phase ${options.phaseId} reviews do not cover the complete journalled candidate.`,
      "Review every artifact in the latest ARTIFACTS-RECORDED hash set.",
    );
  }

  const snapshots = new Map(
    loaded.records.map((record) => [record.file, record.snapshotSha256]),
  );
  const reviewBindings: Binding[] = [];
  for (const review of [affA, affB]) {
    const sha256 = snapshots.get(review.file);
    if (!sha256) {
      throw new ApproveError(
        `The review record ${review.file} could not be hashed.`,
        "Ensure both final review records are present and valid before approving.",
      );
    }
    reviewBindings.push({ path: review.file, sha256 });
  }

  return {
    schemaVersion: resolvedPolicy.policy.schemaVersion,
    caseRoot,
    caseName: path.basename(caseRoot),
    artifactPrefix: candidate.artifactPrefix,
    phaseId: options.phaseId,
    artifacts: [...affA.subjectArtifacts].sort(byPath),
    reviewBindings: reviewBindings.sort(byPath),
    verdicts: [affA, affB].map(({ reviewer, verdict, round }) => ({
      reviewer,
      verdict,
      round,
    })),
    outputPath: `approvals/phase-${options.phaseId}/${candidate.artifactPrefix}-phase-${options.phaseId}-approval.json`,
    approverLabel: identity.label,
    keyFingerprint: identity.fingerprint,
  };
}

export async function recordSignedDecision(options: {
  context: ApprovalContext;
  decision: "APPROVED" | "REJECTED";
  passphrase: string;
  decidedAt?: string;
  residualGapAcceptance?: string[];
  keyRotation?: { previousKeyFingerprint: string; reason: string };
  home?: string;
}): Promise<{ file: string; keyFingerprint: string }> {
  const { context } = options;
  const identity = await readIdentity(options.home);
  if (!identity) {
    throw new ApproveError(
      "No architect approval identity exists on this machine.",
      "Create the architect identity once before approving a phase.",
    );
  }
  const encryptedPrivateKey = await readEncryptedPrivateKey(options.home);

  const record: Record<string, unknown> = {
    schemaVersion: context.schemaVersion,
    recordType: "human-approval",
    caseName: context.caseName,
    artifactPrefix: context.artifactPrefix,
    phaseId: context.phaseId,
    artifactHashes: context.artifacts,
    reviewRecords: context.reviewBindings,
    decision: options.decision,
    approver: identity.label,
    decidedAt: options.decidedAt ?? new Date().toISOString(),
    residualGapAcceptance: options.residualGapAcceptance ?? [],
    ...(options.keyRotation
      ? { extensions: { keyRotation: options.keyRotation } }
      : {}),
  };

  let signed: Record<string, unknown>;
  try {
    signed = signApproval(
      record,
      encryptedPrivateKey,
      options.passphrase,
      identity.publicKeyPem,
    );
  } catch (error: unknown) {
    if (error instanceof IdentityError) {
      throw new ApproveError(
        error.message.replace(/ Fix:.*$/su, ""),
        error.remediation,
      );
    }
    throw error;
  }

  const absolute = path.join(context.caseRoot, ...context.outputPath.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFileAtomic(absolute, `${JSON.stringify(signed, null, 2)}\n`, {
    encoding: "utf8",
  });

  return { file: context.outputPath, keyFingerprint: identity.fingerprint };
}
