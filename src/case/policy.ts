import type { ExecutionHost } from "../framework/hosts.js";
import type { ContractVersion } from "../schema/catalogue.js";
import type { ValidationError } from "../types.js";
import type { LoadedRecord } from "./records.js";

export interface CasePolicy {
  schemaVersion: ContractVersion;
  host: ExecutionHost;
}

export interface CasePolicyResult {
  policy?: CasePolicy;
  errors: ValidationError[];
}

function isExecutionHost(value: unknown): value is ExecutionHost {
  return value === "github-copilot" || value === "claude-code";
}

export function resolveCasePolicy(records: LoadedRecord[]): CasePolicyResult {
  const errors: ValidationError[] = [];
  const versions = new Set(records.map(({ value }) => value.schemaVersion));
  for (const { file, value } of records) {
    if (value.schemaVersion !== "1.0.0" && value.schemaVersion !== "1.1.0") {
      errors.push({
        file,
        invariant: "case-contract",
        message: `Unsupported or missing case schemaVersion "${String(value.schemaVersion)}".`,
        remediation: "Declare a supported schemaVersion on every AFF record.",
      });
    }
  }
  if (versions.size > 1) {
    errors.push({
      file: records.map(({ file }) => file).join("; "),
      invariant: "case-contract",
      message: "The case mixes AFF record schema versions.",
      remediation: "Keep all AFF records in a case on its original contract version; do not migrate existing evidence.",
    });
  }
  if (errors.length > 0) {
    return { errors };
  }
  if (!versions.has("1.1.0")) {
    return { policy: { schemaVersion: "1.0.0", host: "github-copilot" }, errors };
  }

  const plans = records.filter(({ value }) => value.recordType === "model-plan");
  if (plans.length !== 1) {
    return {
      errors: [{
        file: records.map(({ file }) => file).join("; "),
        invariant: "case-host",
        message: "A 1.1.0 case requires exactly one model plan declaring its execution host.",
        remediation: "Supply the single active model plan; never infer a host from models or installed tools.",
      }],
    };
  }
  const plan = plans[0]!;
  const host = plan.value.host;
  if (!isExecutionHost(host)) {
    return {
      errors: [{
        file: plan.file,
        invariant: "case-host",
        message: "The 1.1.0 model plan has a missing or invalid execution host.",
        remediation: "Declare github-copilot or claude-code consistently with the case's first journal event.",
      }],
    };
  }

  for (const { file, value } of records) {
    if (value.recordType === "run-journal-event" && value.host !== host) {
      errors.push({
        file,
        invariant: "case-host",
        message: `Journal host "${String(value.host)}" must match the case host "${host}"; missing hosts and host changes are not allowed.`,
        remediation: "Keep the first journal host and model plan consistent throughout the case; start a separate case to use another host.",
      });
    }
  }
  return errors.length > 0
    ? { errors }
    : { policy: { schemaVersion: "1.1.0", host }, errors };
}
