import { isRecord } from "../common/json.js";
import { readSignature, verifyApprovalSignature } from "../identity/signature.js";
import type { LoadedRecord } from "./records.js";

export interface Binding {
  path: string;
  sha256: string;
}

export interface Review {
  file: string;
  reviewer: "AFF-A" | "AFF-B";
  model: string;
  phaseId: string;
  round: number;
  final: boolean;
  verdict: string;
  subjectArtifacts: Binding[];
}

export interface Approval {
  file: string;
  phaseId: string;
  decision: string;
  decidedAt: string;
  approver: string;
  artifactHashes: Binding[];
  reviewRecords: Binding[];
  syntheticTestEvidence: boolean;
  signatureVerified: boolean;
  keyFingerprint?: string;
  keyRotation?: { previousKeyFingerprint: string; reason: string };
  claimedMode?: string;
}

export interface CandidateEvent {
  file: string;
  phaseId: string;
  artifactPrefix: string;
  sequence: number;
  artifacts: Binding[];
}

export interface PhaseEntryEvent {
  file: string;
  phaseId: string;
  sequence: number;
}

function isBinding(value: unknown): value is Binding {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.sha256 === "string"
  );
}

export function asReview(record: LoadedRecord): Review | undefined {
  const value = record.value;
  if (
    value.recordType !== "review-record" ||
    (value.reviewer !== "AFF-A" && value.reviewer !== "AFF-B") ||
    typeof value.model !== "string" ||
    typeof value.phaseId !== "string" ||
    typeof value.round !== "number" ||
    typeof value.final !== "boolean" ||
    typeof value.verdict !== "string" ||
    !Array.isArray(value.subjectArtifacts) ||
    !value.subjectArtifacts.every(isBinding)
  ) {
    return undefined;
  }
  return {
    file: record.file,
    reviewer: value.reviewer,
    model: value.model,
    phaseId: value.phaseId,
    round: value.round,
    final: value.final,
    verdict: value.verdict,
    subjectArtifacts: value.subjectArtifacts,
  };
}

export function asApproval(record: LoadedRecord): Approval | undefined {
  const value = record.value;
  if (
    value.recordType !== "human-approval" ||
    typeof value.phaseId !== "string" ||
    typeof value.decision !== "string" ||
    typeof value.decidedAt !== "string" ||
    typeof value.approver !== "string" ||
    !Array.isArray(value.artifactHashes) ||
    !value.artifactHashes.every(isBinding) ||
    !Array.isArray(value.reviewRecords) ||
    !value.reviewRecords.every(isBinding)
  ) {
    return undefined;
  }
  const signatureVerified = verifyApprovalSignature(value).verified;
  const signature = signatureVerified ? readSignature(value) : undefined;
  return {
    file: record.file,
    phaseId: value.phaseId,
    decision: value.decision,
    decidedAt: value.decidedAt,
    approver: value.approver,
    artifactHashes: value.artifactHashes,
    reviewRecords: value.reviewRecords,
    syntheticTestEvidence:
      isRecord(value.extensions) &&
      value.extensions.syntheticTestEvidence === true &&
      value.extensions.realApproval === false,
    signatureVerified,
    ...(signature
      ? { keyFingerprint: signature.keyFingerprint }
      : {}),
    ...(isRecord(value.extensions) &&
    isRecord(value.extensions.keyRotation) &&
    typeof value.extensions.keyRotation.previousKeyFingerprint === "string" &&
    typeof value.extensions.keyRotation.reason === "string"
      ? {
          keyRotation: {
            previousKeyFingerprint:
              value.extensions.keyRotation.previousKeyFingerprint,
            reason: value.extensions.keyRotation.reason,
          },
        }
      : {}),
    ...(isRecord(value.extensions) &&
    typeof value.extensions.approvalMode === "string"
      ? { claimedMode: value.extensions.approvalMode }
      : {}),
  };
}

export function bindingSet(bindings: Binding[]): string {
  return bindings
    .map(({ path, sha256 }) => `${path}=${sha256}`)
    .sort()
    .join("\n");
}

export function allReviews(records: LoadedRecord[]): Review[] {
  return records
    .map(asReview)
    .filter((review): review is Review => review !== undefined);
}

export function latestReviews(records: LoadedRecord[]): Map<string, Review> {
  const latest = new Map<string, Review>();
  for (const review of allReviews(records)) {
    const key = `${review.phaseId}:${review.reviewer}`;
    const current = latest.get(key);
    if (!current || review.round > current.round) {
      latest.set(key, review);
    }
  }
  return latest;
}

export function asCandidateEvent(
  record: LoadedRecord,
): CandidateEvent | undefined {
  const value = record.value;
  if (
    value.recordType !== "run-journal-event" ||
    value.eventType !== "ARTIFACTS-RECORDED" ||
    typeof value.phaseId !== "string" ||
    typeof value.artifactPrefix !== "string" ||
    typeof value.sequence !== "number" ||
    !Array.isArray(value.artifactHashes) ||
    value.artifactHashes.length === 0 ||
    !value.artifactHashes.every(isBinding)
  ) {
    return undefined;
  }
  const paths = value.artifactHashes.map(({ path: artifactPath }) => artifactPath);
  if (new Set(paths).size !== paths.length) {
    return undefined;
  }
  return {
    file: record.file,
    phaseId: value.phaseId,
    artifactPrefix: value.artifactPrefix,
    sequence: value.sequence,
    artifacts: value.artifactHashes,
  };
}

export function latestCandidateEvents(
  records: LoadedRecord[],
): Map<string, CandidateEvent> {
  const latest = new Map<string, CandidateEvent>();
  for (const event of records
    .map(asCandidateEvent)
    .filter((value): value is CandidateEvent => value !== undefined)) {
    const current = latest.get(event.phaseId);
    if (!current || event.sequence > current.sequence) {
      latest.set(event.phaseId, event);
    }
  }
  return latest;
}

export function latestApprovals(approvals: Approval[]): Map<string, Approval> {
  const latest = new Map<string, Approval>();
  for (const approval of approvals) {
    const current = latest.get(approval.phaseId);
    if (
      !current ||
      Date.parse(approval.decidedAt) > Date.parse(current.decidedAt)
    ) {
      latest.set(approval.phaseId, approval);
    }
  }
  return latest;
}

export function asPhaseEntryEvent(
  record: LoadedRecord,
): PhaseEntryEvent | undefined {
  const value = record.value;
  if (
    value.recordType !== "run-journal-event" ||
    value.eventType !== "PHASE-ENTERED" ||
    typeof value.phaseId !== "string" ||
    typeof value.sequence !== "number"
  ) {
    return undefined;
  }
  return {
    file: record.file,
    phaseId: value.phaseId,
    sequence: value.sequence,
  };
}

export function firstPhaseEntries(
  records: LoadedRecord[],
): Map<string, PhaseEntryEvent> {
  const first = new Map<string, PhaseEntryEvent>();
  for (const event of records
    .map(asPhaseEntryEvent)
    .filter((value): value is PhaseEntryEvent => value !== undefined)) {
    const current = first.get(event.phaseId);
    if (!current || event.sequence < current.sequence) {
      first.set(event.phaseId, event);
    }
  }
  return first;
}

export const phaseArtifactNames: Readonly<Record<string, readonly string[]>> = {
  "0": [
    "coordination.md",
    "coordination.html",
    "input-inventory.json",
    "model-plan.json",
  ],
  "1": [
    "requirements.md",
    "requirements.html",
    "requirements-catalogue.json",
    "interview-decisions.json",
  ],
  "2": [
    "architecture.md",
    "architecture.html",
    "architecture-catalogue.json",
  ],
  "3": [
    "azure-design.md",
    "azure-design.html",
    "design-catalogue.json",
  ],
  "4": [
    "implementation-plan.md",
    "implementation-plan.html",
    "implementation-catalogue.json",
  ],
  "5": ["build-report.md", "build-report.html", "release-manifest.json"],
  "6": ["presentation.md", "presentation.html", "claim-catalogue.json"],
  "7": [
    "deployment-report.md",
    "deployment-report.html",
    "deployment-attempts.json",
  ],
  "8": ["test-report.md", "test-report.html", "test-catalogue.json"],
};

export const phaseFolders: Readonly<Record<string, string>> = {
  "0": "0-coordination",
  "1": "1-requirements",
  "2": "2-togaf-architecture",
  "3": "3-azure-design",
  "4": "4-implementation-plan",
  "5": "5-coding",
  "6": "6-presentation",
  "7": "7-deployment",
  "8": "8-testing",
};
