import type {
  LifecycleManifest,
  LifecyclePhase,
  ValidationError,
} from "../types.js";
import type { LoadedRecord } from "./records.js";
import {
  asApproval,
  firstPhaseEntries,
  latestApprovals,
  latestCandidateEvents,
  type Approval,
} from "./review-records.js";

const invariant = "phase-sequence";
const approvedPhasePattern = /^approved-phase-([0-8])$/u;

interface Prerequisite {
  phaseId: string;
  reason: string;
}

export interface PhasePrerequisites {
  approvals: Prerequisite[];
  unverifiable: string[];
}

export function prerequisitesFor(
  lifecycle: LifecycleManifest,
  phase: LifecyclePhase,
): PhasePrerequisites {
  const approvals = new Map<string, Prerequisite>();
  const unverifiable: string[] = [];
  const routeIndex = lifecycle.standardRoute.indexOf(phase.id);
  const routePredecessor =
    routeIndex > 0 ? lifecycle.standardRoute[routeIndex - 1] : undefined;

  if (routePredecessor) {
    approvals.set(routePredecessor, {
      phaseId: routePredecessor,
      reason: "the standard route order",
    });
  }

  for (const requirement of phase.requires ?? []) {
    const match = approvedPhasePattern.exec(requirement);
    if (match?.[1]) {
      approvals.set(match[1], {
        phaseId: match[1],
        reason: `the declared prerequisite "${requirement}"`,
      });
      continue;
    }
    unverifiable.push(requirement);
  }

  return { approvals: [...approvals.values()], unverifiable };
}

export function validatePhaseSequence(
  records: LoadedRecord[],
  lifecycle: LifecycleManifest,
): ValidationError[] {
  const history = records
    .map(asApproval)
    .filter((approval): approval is Approval => approval !== undefined);
  const approvals = latestApprovals(history);
  const candidates = latestCandidateEvents(records);
  const entries = firstPhaseEntries(records);
  const errors: ValidationError[] = [];

  for (const phase of lifecycle.phases) {
    const approval = approvals.get(phase.id);
    const evidence =
      approval ?? candidates.get(phase.id) ?? entries.get(phase.id);
    if (!evidence) {
      continue;
    }

    const activity = approval
      ? "was approved"
      : candidates.get(phase.id)
        ? "recorded candidate artifacts"
        : "was entered";
    const { approvals: required, unverifiable } = prerequisitesFor(
      lifecycle,
      phase,
    );

    for (const prerequisite of required) {
      const predecessor = approvals.get(prerequisite.phaseId);
      if (!predecessor || predecessor.decision !== "APPROVED") {
        errors.push({
          file: evidence.file,
          invariant,
          message: `Phase ${phase.id} ${activity} while phase ${prerequisite.phaseId} has no approved human decision, required by ${prerequisite.reason}.`,
          remediation: `Complete phase ${prerequisite.phaseId} and record its human approval before entering or approving phase ${phase.id}.`,
        });
        continue;
      }

      if (
        approval &&
        Date.parse(approval.decidedAt) < Date.parse(predecessor.decidedAt)
      ) {
        errors.push({
          file: `${predecessor.file}; ${approval.file}`,
          invariant,
          message: `Phase ${phase.id} was approved at ${approval.decidedAt}, before phase ${prerequisite.phaseId} was approved at ${predecessor.decidedAt}.`,
          remediation:
            "Record human decisions in lifecycle order using accurate RFC 3339 instants.",
        });
      }
    }

    for (const requirement of unverifiable) {
      errors.push({
        file: evidence.file,
        invariant,
        message: `Phase ${phase.id} ${activity} but its declared prerequisite "${requirement}" has no catalogued case record, so it cannot be verified.`,
        remediation: `Keep phase ${phase.id} blocked until "${requirement}" has an approved evidence contract; do not remove or waive the prerequisite.`,
      });
    }
  }

  const journal = records.filter(({ value }) => value.recordType === "run-journal-event");
  const activities = [
    ...history.map((decision) => ({
      file: decision.file,
      phaseId: decision.phaseId,
      timestamp: decision.decidedAt,
    })),
    ...journal.flatMap(({ file, value }) =>
      (value.eventType === "PHASE-ENTERED" || value.eventType === "ARTIFACTS-RECORDED") &&
      typeof value.phaseId === "string" && typeof value.timestamp === "string"
        ? [{ file, phaseId: value.phaseId, timestamp: value.timestamp }]
        : [],
    ),
  ];
  for (const activity of activities) {
    const phase = lifecycle.phases.find(({ id }) => id === activity.phaseId);
    if (!phase) {
      continue;
    }
    const instant = Date.parse(activity.timestamp);
    for (const prerequisite of prerequisitesFor(lifecycle, phase).approvals) {
      // Current-state failures are already reported above. Historical checks must
      // still reject work that preceded approval even if the case was approved later.
      if (approvals.get(prerequisite.phaseId)?.decision !== "APPROVED") {
        continue;
      }
      const prior = latestApprovals(history.filter((decision) =>
        decision.phaseId === prerequisite.phaseId &&
        Date.parse(decision.decidedAt) <= instant,
      )).get(prerequisite.phaseId);
      if (prior?.decision !== "APPROVED") {
        errors.push({
          file: activity.file,
          invariant,
          message: `Phase ${activity.phaseId} activity at ${activity.timestamp} occurred before approval or while phase ${prerequisite.phaseId} had no approved prerequisite decision at that time.`,
          remediation: "Do not backfill an approval to legitimise earlier work. Preserve the history and resolve the chronology with the accountable architect.",
        });
        continue;
      }
      const invalidation = journal.find(({ value }) =>
        value.phaseId === prerequisite.phaseId &&
        ["PHASE-REOPENED", "BLOCKER", "ARTIFACTS-RECORDED"].includes(String(value.eventType)) &&
        typeof value.timestamp === "string" &&
        Date.parse(value.timestamp) > Date.parse(prior.decidedAt) &&
        Date.parse(value.timestamp) <= instant,
      );
      if (invalidation) {
        errors.push({
          file: `${activity.file}; ${invalidation.file}`,
          invariant,
          message: `Phase ${activity.phaseId} activity at ${activity.timestamp} follows invalidated phase ${prerequisite.phaseId} evidence and requires fresh approval.`,
          remediation: "Complete the reopened prerequisite and obtain a new human approval before downstream activity.",
        });
      }
    }
  }

  return errors;
}
