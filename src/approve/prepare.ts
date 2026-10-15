import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

import fg from "fast-glob";

import { resolveCasePolicy, validateLoadedCase } from "../case/index.js";
import { resolveCasePath } from "../case/path.js";
import { loadCaseRecords, type LoadedCaseRecords, type LoadedRecord } from "../case/records.js";
import { hashArtifactBytes } from "../case/hash.js";
import { prerequisitesFor } from "../case/sequence.js";
import {
  asApproval,
  latestApprovals,
  latestCandidateEvents,
  latestReviews,
  type Approval,
  type Binding,
} from "../case/review-records.js";
import { readLifecycle } from "../framework/lifecycle.js";
import {
  IdentityError,
  readEncryptedPrivateKey,
  readIdentity,
} from "../identity/keys.js";
import { readSignature, signApproval, verifyKeyTransition, type KeyRotationProof } from "../identity/signature.js";
import type { ContractVersion } from "../schema/catalogue.js";
import { createSchemaRegistry, validateRecordSchema } from "../schema/validator.js";
import type { ValidationError } from "../types.js";

export interface ApprovalContext {
  schemaVersion: ContractVersion;
  caseRoot: string;
  caseName: string;
  artifactPrefix: string;
  phaseId: string;
  artifacts: Binding[];
  reviewBindings: Binding[];
  verdicts: { reviewer: string; verdict: string; round: number }[];
  /** Naming template; recordSignedDecision returns the timestamped published file. */
  outputPath: string;
  approverLabel: string;
  keyFingerprint: string;
}

interface PreparedSnapshot {
  repositoryRoot: string;
  home: string | undefined;
  identity: string;
  context: string;
  evidence: string;
}

const preparedSnapshots = new WeakMap<ApprovalContext, PreparedSnapshot>();

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

async function evidenceSnapshot(caseRoot: string): Promise<string> {
  const files = await fg("**/*", { cwd: caseRoot, onlyFiles: true, dot: true, followSymbolicLinks: false });
  const hashes = await Promise.all(files.sort().map(async (file) => [
    file, createHash("sha256").update(await readFile(path.join(caseRoot, file))).digest("hex"),
  ]));
  return JSON.stringify(hashes);
}

function refuseErrors(errors: ValidationError[]): void {
  if (errors.length > 0) {
    throw new ApproveError(
      `The case does not currently validate: ${[...new Set(errors.map(({ invariant }) => invariant))].join(", ")}. ${errors[0]!.message}`,
      "Resolve the reported contract failures before recording a human decision.",
    );
  }
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
  intent?: Omit<DecisionOptions, "context" | "home">;
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
  const evidence = await evidenceSnapshot(caseRoot);
  const lifecycle = await readLifecycle(options.repositoryRoot);
  const phase = lifecycle.phases.find(({ id }) => id === options.phaseId);
  if (!phase) {
    throw new ApproveError(`Unknown phase "${options.phaseId}".`, "Select a catalogued lifecycle phase.");
  }
  const prerequisites = prerequisitesFor(lifecycle, phase);
  if (prerequisites.unverifiable.length > 0) {
    throw new ApproveError(
      `Phase ${options.phaseId} requires uncatalogued authorisation: ${prerequisites.unverifiable.join(", ")}.`,
      "Keep optional phases blocked until an approved contract can evidence every prerequisite.",
    );
  }
  const loaded = await loadCaseRecords(options.repositoryRoot, caseRoot);
  const resolvedPolicy = resolveCasePolicy(loaded.records);
  if (!resolvedPolicy.policy) {
    throw new ApproveError(
      resolvedPolicy.errors[0]?.message ?? "The case policy cannot be resolved.",
      "Resolve the case contract version and host before recording a decision.",
    );
  }
  refuseErrors(loaded.errors);

  const approvals = latestApprovals(
    loaded.records
      .map(asApproval)
      .filter((value): value is Approval => value !== undefined),
  );
  for (const { phaseId: required } of prerequisites.approvals) {
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

  const context: ApprovalContext = {
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
  preparedSnapshots.set(context, {
    repositoryRoot: options.repositoryRoot,
    home: options.home,
    identity: JSON.stringify(identity),
    context: JSON.stringify(context),
    evidence,
  });
  await assertDecisionReady({
    context,
    decision: context.verdicts.some(({ verdict }) => verdict === "DIVERGES") ? "REJECTED" : "APPROVED",
    ...options.intent,
    ...(options.home ? { home: options.home } : {}),
  });
  return context;
}

export interface DecisionOptions {
  context: ApprovalContext;
  decision: "APPROVED" | "REJECTED";
  decidedAt?: string;
  residualGapAcceptance?: string[];
  keyRotation?: KeyRotationProof;
  home?: string;
}

async function unchangedSnapshot(context: ApprovalContext, home?: string): Promise<PreparedSnapshot> {
  const snapshot = preparedSnapshots.get(context);
  if (!snapshot || snapshot.context !== JSON.stringify(context) || home !== snapshot.home) {
    throw new ApproveError("The prepared approval context has changed or was not prepared here.", "Prepare and present the current evidence again.");
  }
  if (snapshot.identity !== JSON.stringify(await readIdentity(home))) {
    throw new ApproveError("The approval identity has changed since evidence was presented.", "Prepare and present the evidence with the intended identity again.");
  }
  if (snapshot.evidence !== await evidenceSnapshot(context.caseRoot)) {
    throw new ApproveError("The case evidence has changed since it was presented.", "Prepare and review the new evidence before signing.");
  }
  return snapshot;
}

function decisionRecord(options: DecisionOptions, decidedAt: string): Record<string, unknown> {
  const { context } = options;
  return structuredClone({
    schemaVersion: context.schemaVersion,
    recordType: "human-approval",
    caseName: context.caseName,
    artifactPrefix: context.artifactPrefix,
    phaseId: context.phaseId,
    artifactHashes: context.artifacts,
    reviewRecords: context.reviewBindings,
    decision: options.decision,
    approver: context.approverLabel,
    decidedAt,
    residualGapAcceptance: options.residualGapAcceptance ?? [],
    extensions: {
      approvalMode: "human-verified",
      keyFingerprint: context.keyFingerprint,
      ...(options.keyRotation ? { keyRotation: options.keyRotation } : {}),
    },
  });
}

function decisionFile(context: ApprovalContext, decidedAt: string): string {
  const instant = new Date(decidedAt).toISOString().replace(/[-:.]/gu, "");
  return context.outputPath.replace(/\.json$/u, `-${instant}.json`);
}

async function validateProspectiveDecision(
  options: DecisionOptions,
  decidedAt: string,
): Promise<{ record: Record<string, unknown>; file: string; loaded: LoadedCaseRecords; snapshot: PreparedSnapshot }> {
  const { context } = options;
  const snapshot = await unchangedSnapshot(context, options.home);
  const record = decisionRecord(options, decidedAt);
  const registry = await createSchemaRegistry(snapshot.repositoryRoot);
  refuseErrors([...registry.errors, ...validateRecordSchema(registry, context.outputPath, record, "human-approval")]);
  if (Date.parse(decidedAt) > Date.now()) {
    throw new ApproveError("The decision time is in the future.", "Record an accurate current or historical decision instant.");
  }
  const file = decisionFile(context, decidedAt);
  const loaded = await loadCaseRecords(snapshot.repositoryRoot, context.caseRoot);
  const candidateFile = latestCandidateEvents(loaded.records).get(context.phaseId)?.file;
  const evidenceTimes = loaded.records.flatMap(({ file: evidenceFile, value }) => {
    const timestamp = evidenceFile === candidateFile ? value.timestamp
      : context.reviewBindings.some(({ path: reviewPath }) => reviewPath === evidenceFile) ? value.reviewedAt
      : undefined;
    return typeof timestamp === "string" ? [timestamp] : [];
  });
  if (evidenceTimes.some((timestamp) => Date.parse(timestamp) > Date.parse(decidedAt))) {
    throw new ApproveError(
      "The decision time precedes the current candidate or final reviews.",
      "Use an accurate decision timestamp after all evidence under review exists.",
    );
  }
  const historical = loaded.records.map(asApproval).filter((value): value is Approval => value !== undefined);
  const historicalInstants = new Set<string>();
  for (const approval of historical) {
    const instant = `${approval.phaseId}:${Date.parse(approval.decidedAt)}`;
    if (historicalInstants.has(instant)) {
      throw new ApproveError(
        "Historical approvals contain duplicate decisions for the same phase at the same decision time.",
        "Preserve the ambiguous evidence and resolve it with the accountable architect; a new decision cannot erase the ambiguity.",
      );
    }
    historicalInstants.add(instant);
  }
  if (historical.some((approval) => Date.parse(approval.decidedAt) > Date.parse(decidedAt))) {
    throw new ApproveError("The decision time precedes recorded approval history.", "Use a new decision instant; never insert backdated approval evidence.");
  }
  const prospective: LoadedRecord = {
    file,
    absolutePath: path.join(context.caseRoot, file),
    value: record,
    snapshotSha256: hashArtifactBytes(file, Buffer.from(JSON.stringify(record))),
  };
  const validation = await validateLoadedCase(snapshot.repositoryRoot, context.caseRoot, {
    records: [...loaded.records, prospective], errors: loaded.errors,
  }, { ...(options.home ? { home: options.home } : {}) });
  // Only this still-unsigned prospective record awaits cryptographic evidence.
  // All historical records remain present: stale-current errors can disappear
  // naturally, while binding, chronology and historical assurance still apply.
  refuseErrors(validation.errors.filter((error) => !(error.file === file && error.invariant === "approval-mode")));
  const previous = historical.filter(({ signatureVerified }) => signatureVerified)
    .sort((left, right) => Date.parse(left.decidedAt) - Date.parse(right.decidedAt) ||
      (left.file < right.file ? -1 : left.file > right.file ? 1 : 0))
    .at(-1);
  const previousRecord = previous ? loaded.records.find(({ file: oldFile }) => oldFile === previous.file) : undefined;
  const identity = await readIdentity(options.home);
  if (!identity) throw new ApproveError("The approval identity has changed.", "Prepare the decision again.");
  const transition = verifyKeyTransition(record, identity.publicKeyPem, previousRecord ? readSignature(previousRecord.value)?.publicKeyPem : undefined);
  if (!transition.verified) {
    throw new ApproveError(`The approval key transition is not authorised: ${transition.reason}.`, "Use the established key or its countersignature over the exact new decision. Lost-key recovery remains blocked.");
  }
  await unchangedSnapshot(context, options.home);
  return { record, file, loaded, snapshot };
}

/** Run after the decision is selected and before asking for a passphrase. */
export async function assertDecisionReady(options: DecisionOptions): Promise<void> {
  await validateProspectiveDecision(options, options.decidedAt ?? new Date().toISOString());
}

export async function recordSignedDecision(options: DecisionOptions & {
  passphrase: string;
}): Promise<{ file: string; keyFingerprint: string }> {
  const { context } = options;
  const decidedAt = options.decidedAt ?? new Date().toISOString();
  const { record, file, loaded, snapshot } = await validateProspectiveDecision(options, decidedAt);
  const encryptedPrivateKey = await readEncryptedPrivateKey(options.home);
  const identity = await readIdentity(options.home);
  if (!identity) throw new ApproveError("The approval identity has changed.", "Prepare the decision again.");
  await unchangedSnapshot(context, options.home);

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

  const signedRecord: LoadedRecord = {
    file, absolutePath: path.join(context.caseRoot, file), value: signed,
    snapshotSha256: hashArtifactBytes(file, Buffer.from(JSON.stringify(signed))),
  };
  refuseErrors((await validateLoadedCase(snapshot.repositoryRoot, context.caseRoot, {
    records: [...loaded.records, signedRecord], errors: loaded.errors,
  }, { ...(options.home ? { home: options.home } : {}) })).errors);
  await unchangedSnapshot(context, options.home);

  const absolute = path.join(context.caseRoot, ...file.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true });
  const staging = `${absolute}.${randomUUID()}.pending`;
  const handle = await open(staging, "wx", 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(signed, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // A hard link publishes complete bytes atomically and cannot replace an
    // existing name, including when two publishers raced after validation.
    await link(staging, absolute);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new ApproveError("A decision already exists at this instant.", "Keep the existing evidence and prepare a decision at a distinct instant.");
    }
    throw error;
  } finally {
    await unlink(staging);
  }
  return { file, keyFingerprint: identity.fingerprint };
}
