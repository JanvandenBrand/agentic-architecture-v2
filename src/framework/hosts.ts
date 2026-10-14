import type { LifecycleManifest, ValidationError } from "../types.js";
import { readClaudeAdapterDefaults } from "./claude-adapter.js";

export type ExecutionHost = "github-copilot" | "claude-code";

export interface HostModelDefaults {
  models: Map<string, string>;
  errors: ValidationError[];
}

export async function readHostModelDefaults(
  repositoryRoot: string,
  host: ExecutionHost,
  lifecycle: LifecycleManifest,
): Promise<HostModelDefaults> {
  if (host === "github-copilot") {
    return {
      models: new Map([...lifecycle.phases, ...lifecycle.reviewers].map(({ owner, model }) => [owner, model])),
      errors: [],
    };
  }
  if (host === "claude-code") {
    return readClaudeAdapterDefaults(repositoryRoot, lifecycle);
  }
  return {
    models: new Map(),
    errors: [{
      file: ".github/agents/AFF-LIFECYCLE.json",
      invariant: "execution-host",
      message: `Unsupported execution host "${String(host)}".`,
      remediation: "Select github-copilot or claude-code explicitly; no host fallback is supported.",
    }],
  };
}
