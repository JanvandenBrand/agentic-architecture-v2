import {
  readLifecycle,
  validateLifecycleRouting,
  validateReviewerModelSeparation,
} from "./lifecycle.js";
import type { ValidationResult } from "../types.js";
import { validateProfiles } from "./profiles.js";
import { validateReferences } from "./references.js";
import {
  createSchemaRegistry,
  validateRecordSchema,
} from "../schema/validator.js";
import { validateRepositoryJson } from "./json.js";
import { validateClaudeAdapter } from "./claude-adapter.js";

export { validateClaudeAdapter } from "./claude-adapter.js";
export { readHostModelDefaults, type ExecutionHost, type HostModelDefaults } from "./hosts.js";

export async function validateFramework(
  repositoryRoot: string,
): Promise<ValidationResult> {
  const lifecycle = await readLifecycle(repositoryRoot);
  const registry = await createSchemaRegistry(repositoryRoot);
  const [profileErrors, referenceErrors, jsonErrors, adapterErrors] = await Promise.all([
    validateProfiles(repositoryRoot, lifecycle),
    validateReferences(repositoryRoot),
    validateRepositoryJson(repositoryRoot),
    validateClaudeAdapter(repositoryRoot, lifecycle),
  ]);
  const schemaErrors = validateRecordSchema(
    registry,
    ".github/agents/AFF-LIFECYCLE.json",
    lifecycle,
    "lifecycle-manifest",
  );

  return {
    errors: [
      ...registry.errors,
      ...schemaErrors,
      ...validateLifecycleRouting(lifecycle),
      ...validateReviewerModelSeparation(lifecycle),
      ...profileErrors,
      ...referenceErrors,
      ...jsonErrors,
      ...adapterErrors,
    ],
  };
}
