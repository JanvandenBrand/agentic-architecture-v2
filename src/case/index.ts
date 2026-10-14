import { resolveCasePath } from "./path.js";
import type { ValidationResult } from "../types.js";
import { loadCaseRecords, type LoadedCaseRecords } from "./records.js";
import { validateHashBindings } from "./hash.js";
import { readLifecycle } from "../framework/lifecycle.js";
import { readHostModelDefaults } from "../framework/hosts.js";
import { validateApprovals } from "./approvals.js";
import { validateApprovalModes } from "./approval-mode.js";
import { readIdentity } from "../identity/keys.js";
import { validateReviewConvergence } from "./convergence.js";
import { validateCandidateFileCoverage } from "./coverage.js";
import { validateRecordIdentity } from "./identity.js";
import { validateImplementationGraphs } from "./implementation.js";
import { validateRunJournals } from "./journal.js";
import { validateModelPlans, validateModelProviders, validateReviewModels } from "./models.js";
import { resolveCasePolicy } from "./policy.js";
import { validatePhaseSequence } from "./sequence.js";

export { resolveCasePolicy, type CasePolicy, type CasePolicyResult } from "./policy.js";

export interface ValidateCaseOptions {
  /** Overrides the home directory used to locate the architect approval key. */
  home?: string;
}

export async function validateCase(
  repositoryRoot: string,
  casePath: string,
  options: ValidateCaseOptions = {},
): Promise<ValidationResult> {
  const resolved = await resolveCasePath(repositoryRoot, casePath);
  if (!resolved.caseRoot) {
    return { errors: resolved.errors };
  }

  const loaded = await loadCaseRecords(repositoryRoot, resolved.caseRoot);
  return validateLoadedCase(repositoryRoot, resolved.caseRoot, loaded, options);
}

export async function validateLoadedCase(
  repositoryRoot: string,
  caseRoot: string,
  loaded: LoadedCaseRecords,
  options: ValidateCaseOptions = {},
): Promise<ValidationResult> {
  const resolvedPolicy = resolveCasePolicy(loaded.records);
  const lifecycle = await readLifecycle(repositoryRoot);
  const defaults = resolvedPolicy.policy
    ? await readHostModelDefaults(repositoryRoot, resolvedPolicy.policy.host, lifecycle)
    : undefined;
  const modelErrors = defaults && defaults.errors.length === 0
    ? [
        ...validateModelPlans(loaded.records, lifecycle, defaults.models),
        ...validateReviewModels(loaded.records, lifecycle, defaults.models),
      ]
    : [];
  const identity = await readIdentity(options.home);
  const hashErrors = await validateHashBindings(
    caseRoot,
    loaded.records,
  );
  const coverageErrors = await validateCandidateFileCoverage(
    caseRoot,
    loaded.records,
  );
  return {
    errors: [
      ...loaded.errors,
      ...resolvedPolicy.errors,
      ...(defaults?.errors ?? []),
      ...validateRecordIdentity(caseRoot, loaded.records),
      ...(resolvedPolicy.policy
        ? validateModelProviders(loaded.records, resolvedPolicy.policy.host)
        : []),
      ...modelErrors,
      ...coverageErrors,
      ...validateImplementationGraphs(loaded.records),
      ...validateRunJournals(loaded.records),
      ...hashErrors,
      ...validateReviewConvergence(loaded.records),
      ...validateApprovals(loaded.records),
      ...validateApprovalModes(loaded.records, {
        ...(identity
          ? { requireSignedApprovals: identity.requireSignedApprovals }
          : {}),
      }),
      ...validatePhaseSequence(loaded.records, lifecycle),
    ],
  };
}
