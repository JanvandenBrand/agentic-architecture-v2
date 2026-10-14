import { isRecord } from "../common/json.js";
import type { ExecutionHost } from "../framework/hosts.js";
import type { LifecycleManifest, ValidationError } from "../types.js";
import type { LoadedRecord } from "./records.js";
import { asReview, type Review } from "./review-records.js";

interface ModelAssignment {
  agent: string;
  model: string;
  separationStatus: string;
  approvalReference?: string;
  available?: boolean;
}

function isModelAssignment(value: unknown): value is ModelAssignment {
  return (
    isRecord(value) &&
    typeof value.agent === "string" &&
    typeof value.model === "string" &&
    typeof value.separationStatus === "string" &&
    (value.approvalReference === undefined ||
      typeof value.approvalReference === "string")
  );
}

export function validateModelPlans(
  records: LoadedRecord[],
  lifecycle: LifecycleManifest,
  defaults: ReadonlyMap<string, string>,
): ValidationError[] {
  const expectedAgents = [...lifecycle.phases, ...lifecycle.reviewers].map(({ owner }) => owner);
  const phaseOwners = new Set(lifecycle.phases.map(({ owner }) => owner));
  const errors: ValidationError[] = [];
  const modelPlans = records.filter(
    ({ value }) => value.recordType === "model-plan",
  );
  if (modelPlans.length > 1) {
    errors.push({
      file: modelPlans.map(({ file }) => file).join("; "),
      invariant: "model-plan-consistency",
      message: "The case contains more than one active model-plan record.",
      remediation:
        "Keep one append-updated model plan at the contracted Phase 0 path.",
    });
  }

  for (const record of modelPlans) {
    const assignments = record.value.assignments;
    if (!Array.isArray(assignments) || !assignments.every(isModelAssignment)) {
      continue;
    }
    const byAgent = new Map<string, ModelAssignment>();
    for (const assignment of assignments) {
      if (byAgent.has(assignment.agent)) {
        errors.push({
          file: record.file,
          invariant: "model-plan-consistency",
          message: `Model plan repeats agent "${assignment.agent}".`,
          remediation: "Record exactly one active assignment per AFF agent.",
        });
      }
      byAgent.set(assignment.agent, assignment);
      if (record.value.schemaVersion === "1.1.0" && assignment.available === false) {
        errors.push({
          file: record.file,
          invariant: "model-plan-consistency",
          message: `${assignment.agent} has an active assignment explicitly marked unavailable.`,
          remediation: "Verify model availability before use and record any approved substitution explicitly; do not silently fall back.",
        });
      }
    }

    for (const agent of expectedAgents) {
      const assignment = byAgent.get(agent);
      if (!assignment) {
        errors.push({
          file: record.file,
          invariant: "model-plan-consistency",
          message: `Model plan omits lifecycle agent "${agent}".`,
          remediation: "Add every phase owner and both declared reviewers.",
        });
        continue;
      }
      if (assignment.model !== defaults.get(agent) && !assignment.approvalReference) {
        errors.push({
          file: record.file,
          invariant: "model-plan-consistency",
          message: `${agent} changes the default model without human approval evidence.`,
          remediation:
            "Restore the selected host's default model or add the explicit approval record reference.",
        });
      }
    }

    const affA = byAgent.get("AFF-A-rubber-duck");
    const ownerModels = new Set(
      [...byAgent.values()]
        .filter(({ agent }) => phaseOwners.has(agent))
        .map(({ model }) => model),
    );
    if (
      !affA ||
      ownerModels.has(affA.model) ||
      affA.separationStatus !== "SATISFIED"
    ) {
      errors.push({
        file: record.file,
        invariant: "reviewer-model-separation",
        message:
          "The case model plan does not keep AFF-A on a different model from every phase owner.",
        remediation:
          "Assign AFF-A a different available model allowed by the case host and record separationStatus SATISFIED.",
      });
    }
  }

  return errors;
}

export function validateReviewModels(
  records: LoadedRecord[],
  lifecycle: LifecycleManifest,
  defaults: ReadonlyMap<string, string>,
): ValidationError[] {
  const activeModels = new Map(defaults);
  const modelPlan = records.find(
    ({ value }) => value.recordType === "model-plan",
  );
  if (modelPlan && Array.isArray(modelPlan.value.assignments)) {
    for (const assignment of modelPlan.value.assignments) {
      if (isModelAssignment(assignment)) {
        activeModels.set(assignment.agent, assignment.model);
      }
    }
  }
  const reviewerOwners = new Map(
    lifecycle.reviewers.map(({ id, owner }) => [id, owner]),
  );
  const phaseOwners = new Map(
    lifecycle.phases.map(({ id, owner }) => [id, owner]),
  );

  return records
    .map(asReview)
    .filter((review): review is Review => review !== undefined)
    .flatMap((review) => {
      const errors: ValidationError[] = [];
      const reviewerOwner = reviewerOwners.get(review.reviewer);
      const expectedReviewerModel = reviewerOwner
        ? activeModels.get(reviewerOwner)
        : undefined;
      if (review.model !== expectedReviewerModel) {
        errors.push({
          file: review.file,
          invariant: "lifecycle-profile-consistency",
          message: `${review.reviewer} review model "${review.model}" differs from the active assignment.`,
          remediation:
            "Use the active case assignment or the selected host's default for a partial legacy case.",
        });
      }

      if (
        review.reviewer === "AFF-A" &&
        review.model === activeModels.get(phaseOwners.get(review.phaseId) ?? "")
      ) {
        errors.push({
          file: review.file,
          invariant: "reviewer-model-separation",
          message: `AFF-A uses the same model as phase ${review.phaseId}.`,
          remediation:
            "Repeat the review with the declared independent AFF-A model.",
        });
      }

      const expectedPrefix = `reviews/${review.reviewer.toLowerCase()}/${review.phaseId}/round-${review.round}/`;
      if (!review.file.startsWith(expectedPrefix)) {
        errors.push({
          file: review.file,
          invariant: "record-location",
          message: `${review.reviewer} phase/round fields do not match the review directory.`,
          remediation: `Store the record beneath ${expectedPrefix}.`,
        });
      }
      return errors;
    });
}

export function validateModelProviders(
  records: LoadedRecord[],
  host: ExecutionHost,
): ValidationError[] {
  const prefix = host === "github-copilot" ? "gpt-" : "claude-";
  return records.flatMap(({ file, value }) => {
    const models = value.recordType === "model-plan" && Array.isArray(value.assignments)
      ? value.assignments.filter(isRecord).map(({ model }) => model)
      : value.recordType === "review-record" ? [value.model] : [];
    return models
      .filter((model): model is string => typeof model === "string" && !model.startsWith(prefix))
      .map((model) => ({
        file,
        invariant: "case-host",
        message: `Model "${model}" is not allowed on "${host}"; this host requires the "${prefix}" provider prefix.`,
        remediation: "Use the selected host's provider and record any approved substitution; approval cannot change the case host.",
      }));
  });
}
