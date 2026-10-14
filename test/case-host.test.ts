import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import * as caseValidation from "../src/case/index.js";
import { validateModelPlans, validateReviewModels } from "../src/case/models.js";
import type { LoadedRecord } from "../src/case/records.js";
import { readHostModelDefaults, type ExecutionHost } from "../src/framework/hosts.js";
import * as hostDefaults from "../src/framework/hosts.js";
import { readLifecycle } from "../src/framework/lifecycle.js";
import { createSchemaRegistry, validateRecordSchema, type SchemaRegistry } from "../src/schema/validator.js";
import type { LifecycleManifest } from "../src/types.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const syntheticCaseRoot = path.join(repositoryRoot, "test", "fixtures", "cases", "valid-case");
const syntheticHome = path.join(syntheticCaseRoot, "unused-home");
let lifecycle: LifecycleManifest;
let registry: SchemaRegistry;
let copilotDefaults: Map<string, string>;
let claudeDefaults: Map<string, string>;

beforeAll(async () => {
  lifecycle = await readLifecycle(repositoryRoot);
  registry = await createSchemaRegistry(repositoryRoot);
  const copilot = await readHostModelDefaults(repositoryRoot, "github-copilot", lifecycle);
  const claude = await readHostModelDefaults(repositoryRoot, "claude-code", lifecycle);
  expect(copilot.errors).toEqual([]);
  expect(claude.errors).toEqual([]);
  copilotDefaults = copilot.models;
  claudeDefaults = claude.models;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function record(value: Record<string, unknown>, file = "synthetic-policy-record.json"): LoadedRecord {
  return {
    file,
    absolutePath: path.resolve(file),
    snapshotSha256: "a".repeat(64),
    value,
  };
}

function plan(host: ExecutionHost = "claude-code") {
  return {
    schemaVersion: "1.1.0",
    recordType: "model-plan",
    host,
    caseName: "valid-case",
    artifactPrefix: "sample",
    assignments: [...lifecycle.phases, ...lifecycle.reviewers].map(({ owner, model }) => ({
      agent: owner,
      model: host === "github-copilot" ? model
        : owner === "AFF-A-rubber-duck" ? "claude-sonnet-5-5" : "claude-opus-5-5",
      rationale: "Synthetic offline assignment",
      available: true,
      separationStatus: owner === "AFF-A-rubber-duck" ? "SATISFIED" : "NOT-APPLICABLE",
      approvalReference: undefined as string | undefined,
    })),
  };
}

function journal(host: unknown, sequence = 1): LoadedRecord {
  return record({
    recordType: "run-journal-event",
    schemaVersion: "1.1.0",
    host,
    sequence,
  }, `sample-run-journal.jsonl:${sequence}`);
}

function review(model: string): LoadedRecord {
  return record({
    recordType: "review-record",
    schemaVersion: "1.1.0",
    reviewer: "AFF-A",
    phaseId: "0",
    round: 1,
    model,
    final: false,
    verdict: "PASS",
    subjectArtifacts: [],
  }, "reviews/aff-a/0/round-1/sample-review.json");
}

async function validate(records: LoadedRecord[]) {
  return caseValidation.validateLoadedCase(
    repositoryRoot, syntheticCaseRoot, { records, errors: [] }, { home: syntheticHome },
  );
}

describe("host-aware case validation", () => {
  it("accepts Claude defaults without demanding Copilot substitution evidence", async () => {
    const value = plan();
    expect(validateRecordSchema(registry, "sample-model-plan.json", value)).toEqual([]);
    expect((await validate([record(value)])).errors).toEqual([]);
  });

  it("keeps new Copilot defaults valid under the legacy repository manifest", async () => {
    expect(lifecycle.schemaVersion).toBe("1.0.0");
    expect((await validate([record(plan("github-copilot"))])).errors).toEqual([]);
  });

  it("rejects the same Claude assignments under the legacy schema", () => {
    const { host: _host, ...value } = plan();
    expect(validateRecordSchema(registry, "sample-model-plan.json", {
      ...value, schemaVersion: "1.0.0",
    })).toContainEqual(expect.objectContaining({ invariant: "schema-validation" }));
  });

  it.each(["claude-code", "github-copilot"] as const)(
    "rejects the other provider on %s even with substitution approval", async (host) => {
      const value = plan(host);
      value.assignments[0]!.model = host === "claude-code" ? "gpt-5.6-sol" : "claude-opus-5-5";
      value.assignments[0]!.approvalReference = "human-approved-substitution";
      expect(validateRecordSchema(registry, "sample-model-plan.json", value)).toEqual([]);
      expect((await validate([record(value)])).errors).toContainEqual(
        expect.objectContaining({ invariant: "case-host", message: expect.stringContaining(host) }),
      );
    },
  );

  it("rejects review models from the wrong provider", async () => {
    expect((await validate([record(plan()), review("gpt-5.4")])).errors).toContainEqual(
      expect.objectContaining({ invariant: "case-host", file: "reviews/aff-a/0/round-1/sample-review.json" }),
    );
  });

  it("rejects an explicitly unavailable active assignment in a new case", async () => {
    const value = plan();
    value.assignments[0]!.available = false;
    expect((await validate([record(value)])).errors).toContainEqual(
      expect.objectContaining({ invariant: "model-plan-consistency", message: expect.stringContaining("unavailable") }),
    );
  });

  it("does not change legacy availability semantics", async () => {
    const { host: _host, ...value } = plan("github-copilot");
    value.schemaVersion = "1.0.0";
    value.assignments[0]!.available = false;
    expect((await validate([record(value)])).errors).toEqual([]);
  });

  it("returns policy errors without misleading model substitution errors", async () => {
    vi.spyOn(hostDefaults, "readHostModelDefaults").mockRejectedValue(
      new Error("Invalid case policy must not trigger host-default loading."),
    );
    const result = await validate([record(plan()), journal("github-copilot")]);
    expect(result.errors).toContainEqual(expect.objectContaining({ invariant: "case-host" }));
    expect(result.errors.some(({ invariant }) => invariant === "model-plan-consistency")).toBe(false);
  });

  it("includes structured adapter failures without falling back to lifecycle models", async () => {
    const error = {
      file: ".claude/agents/aff-0-coordinator.md",
      invariant: "claude-adapter",
      message: "Synthetic invalid adapter configuration.",
      remediation: "Restore the validated wrapper.",
    };
    vi.spyOn(hostDefaults, "readHostModelDefaults").mockResolvedValue({
      models: new Map(), errors: [error],
    });
    expect((await validate([record(plan())])).errors).toEqual([error]);
  });

  it("preserves the empty legacy case", async () => {
    expect((await validate([])).errors).toEqual([]);
  });
});

describe("case policy", () => {
  it("treats legacy records as Copilot without changing them", () => {
    const records = [record({ recordType: "model-plan", schemaVersion: "1.0.0", assignments: [] })];
    const before = JSON.stringify(records);
    expect(caseValidation.resolveCasePolicy(records)).toEqual({
      policy: { schemaVersion: "1.0.0", host: "github-copilot" }, errors: [],
    });
    expect(JSON.stringify(records)).toBe(before);
  });

  it("resolves an empty or partial legacy case", () => {
    for (const records of [[], [record({ recordType: "input-inventory", schemaVersion: "1.0.0" })]]) {
      expect(caseValidation.resolveCasePolicy(records)).toEqual({
        policy: { schemaVersion: "1.0.0", host: "github-copilot" }, errors: [],
      });
    }
  });

  it.each(["claude-code", "github-copilot"] as const)("resolves a consistent %s case", (host) => {
    expect(caseValidation.resolveCasePolicy([record(plan(host)), journal(host, 1), journal(host, 2)])).toEqual({
      policy: { schemaVersion: "1.1.0", host }, errors: [],
    });
  });

  it("rejects mixed case versions, including records other than plans and journals", () => {
    const result = caseValidation.resolveCasePolicy([
      record(plan()), record({ recordType: "input-inventory", schemaVersion: "1.0.0" }),
    ]);
    expect(result.policy).toBeUndefined();
    expect(result.errors).toContainEqual(expect.objectContaining({ invariant: "case-contract" }));
  });

  it.each([undefined, "2.0.0"])("rejects an unsupported or absent version %s", (schemaVersion) => {
    const result = caseValidation.resolveCasePolicy([record({ recordType: "model-plan", schemaVersion })]);
    expect(result.policy).toBeUndefined();
    expect(result.errors).toContainEqual(expect.objectContaining({ invariant: "case-contract" }));
  });

  it.each([undefined, "other-host"])("does not infer a missing or invalid model-plan host %s", (host) => {
    const result = caseValidation.resolveCasePolicy([record({ ...plan(), host }), journal("claude-code")]);
    expect(result.policy).toBeUndefined();
    expect(result.errors).toContainEqual(expect.objectContaining({ invariant: "case-host" }));
  });

  it.each([undefined, "other-host"])("requires every journal event to have a valid host %s", (host) => {
    const result = caseValidation.resolveCasePolicy([record(plan()), journal("claude-code"), journal(host, 2)]);
    expect(result.policy).toBeUndefined();
    expect(result.errors).toContainEqual(expect.objectContaining({ invariant: "case-host" }));
  });

  it("requires exactly one new model plan even when the journal has a host", () => {
    for (const records of [[journal("claude-code")], [record(plan()), record(plan())]]) {
      const result = caseValidation.resolveCasePolicy(records);
      expect(result.policy).toBeUndefined();
      expect(result.errors).toContainEqual(expect.objectContaining({ invariant: "case-host" }));
    }
  });

  it("rejects a journal that switches hosts after its first event", () => {
    const result = caseValidation.resolveCasePolicy([
      record(plan()), journal("claude-code"), journal("github-copilot", 2),
    ]);
    expect(result.policy).toBeUndefined();
    expect(result.errors).toContainEqual(expect.objectContaining({
      invariant: "case-host", file: "sample-run-journal.jsonl:2",
    }));
  });

  it("rejects a plan contradicting an existing journal prefix", () => {
    const result = caseValidation.resolveCasePolicy([journal("github-copilot"), record(plan())]);
    expect(result.policy).toBeUndefined();
    expect(result.errors).toContainEqual(expect.objectContaining({ invariant: "case-host" }));
  });
});

describe("host model assignments", () => {
  it("uses the selected host defaults rather than the lifecycle's provider", () => {
    expect(validateModelPlans([record(plan())], lifecycle, claudeDefaults)).toEqual([]);
    expect(validateModelPlans([record(plan("github-copilot"))], lifecycle, copilotDefaults)).toEqual([]);
  });

  it("accepts an approved substitution and binds the review to it, not a wrapper default", () => {
    const value = plan();
    const affA = value.assignments.find(({ agent }) => agent === "AFF-A-rubber-duck")!;
    affA.model = "claude-sonnet-synthetic";
    affA.approvalReference = "human-approved-substitution";
    const records = [record(value), review(affA.model)];
    expect(validateModelPlans(records, lifecycle, claudeDefaults)).toEqual([]);
    expect(validateReviewModels(records, lifecycle, claudeDefaults)).toEqual([]);
    expect(validateReviewModels([record(value), review("claude-sonnet-5-5")], lifecycle, claudeDefaults))
      .toContainEqual(expect.objectContaining({ invariant: "lifecycle-profile-consistency" }));
  });

  it("rejects an unapproved substitution", () => {
    const value = plan();
    value.assignments[0]!.model = "claude-opus-synthetic";
    expect(validateModelPlans([record(value)], lifecycle, claudeDefaults)).toEqual([
      expect.objectContaining({ invariant: "model-plan-consistency", message: expect.stringContaining("AFF-0") }),
    ]);
  });

  it("retains missing and duplicate assignment checks", () => {
    const value = plan();
    value.assignments[0] = { ...value.assignments[1]! };
    expect(validateModelPlans([record(value)], lifecycle, claudeDefaults)).toEqual(expect.arrayContaining([
      expect.objectContaining({ invariant: "model-plan-consistency", message: expect.stringContaining("repeats") }),
      expect.objectContaining({ invariant: "model-plan-consistency", message: expect.stringContaining("omits") }),
    ]));
  });

  it("rejects AFF-A colliding with a later owner, even for an approved substitution", () => {
    const value = plan();
    const laterOwner = value.assignments.find(({ agent }) => agent === "AFF-8-testing")!;
    laterOwner.model = "claude-sonnet-5-5";
    laterOwner.approvalReference = "human-approved-substitution";
    expect(validateModelPlans([record(value), review("claude-sonnet-5-5")], lifecycle, claudeDefaults))
      .toContainEqual(expect.objectContaining({ invariant: "reviewer-model-separation" }));
  });

  it("requires satisfied reviewer separation, not just a distinct model", () => {
    const value = plan();
    value.assignments.find(({ agent }) => agent === "AFF-A-rubber-duck")!.separationStatus = "NOT-APPLICABLE";
    expect(validateModelPlans([record(value)], lifecycle, claudeDefaults))
      .toContainEqual(expect.objectContaining({ invariant: "reviewer-model-separation" }));
  });
});
