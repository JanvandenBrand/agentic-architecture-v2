import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { loadCaseRecords } from "../src/case/records.js";
import { readLifecycle } from "../src/framework/lifecycle.js";
import { readSchemaCatalogue, type SchemaCatalogue } from "../src/schema/catalogue.js";
import { createSchemaRegistry, getSchemaEntry, validateRecordSchema } from "../src/schema/validator.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratchDirectories: string[] = [];
const versions = ["1.0.0", "1.1.0"] as const;

async function copySchemas(): Promise<string> {
  const root = await mkdtemp(path.join(repositoryRoot, ".aff-schema-test-"));
  scratchDirectories.push(root);
  await cp(path.join(repositoryRoot, "schemas"), path.join(root, "schemas"), {
    recursive: true,
  });
  return root;
}

async function editCatalogue(
  root: string,
  edit: (catalogue: SchemaCatalogue) => void,
): Promise<void> {
  const catalogue = await readSchemaCatalogue(root);
  edit(catalogue);
  await writeFile(
    path.join(root, "schemas", "aff", "catalogue.json"),
    JSON.stringify(catalogue),
  );
}

async function readFixture(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(
    path.join(repositoryRoot, "test", "fixtures", "cases", "valid-case", file),
    "utf8",
  )) as Record<string, unknown>;
}

function journal(version: string): Record<string, unknown> {
  return {
    schemaVersion: version,
    recordType: "run-journal-event",
    caseName: "synthetic-case",
    artifactPrefix: "synthetic",
    eventId: "EVT-001",
    sequence: 1,
    timestamp: "2026-01-01T00:00:00Z",
    phaseId: "0",
    eventType: "PHASE-ENTERED",
    actor: "AFF-0",
    summary: "Synthetic schema test.",
    ...(version === "1.1.0" ? { host: "claude-code" } : {}),
  };
}

afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

const requiredRecordTypes = [
  "architecture-catalogue",
  "azure-design-catalogue",
  "claim-catalogue",
  "deployment-attempts",
  "human-approval",
  "implementation-catalogue",
  "input-inventory",
  "interview-decisions",
  "lifecycle-manifest",
  "model-plan",
  "regulatory-coverage",
  "release-manifest",
  "requirements-catalogue",
  "review-record",
  "run-journal-event",
  "test-catalogue",
];

describe("schema catalogue", () => {
  it("compiles both versions independently with every promised record", async () => {
    const registry = await createSchemaRegistry(repositoryRoot);

    expect(registry.errors).toEqual([]);
    expect(registry.catalogue.contractVersion).toBe("1.1.0");
    expect(registry.catalogue.supportedContractVersions).toEqual(versions);
    expect([...registry.validators.keys()].sort()).toEqual(versions);
    for (const version of versions) {
      expect([...registry.validators.get(version)!.keys()].sort()).toEqual(requiredRecordTypes);
      expect([...registry.entries.get(version)!.keys()].sort()).toEqual(requiredRecordTypes);
    }
  });

  it("widens model names only for 1.1.0 records", async () => {
    const registry = await createSchemaRegistry(repositoryRoot);
    const lifecycle = await readLifecycle(repositoryRoot);
    const candidate = structuredClone(lifecycle);
    candidate.schemaVersion = "1.1.0";
    candidate.phases[0]!.model = "claude-opus-5-5";
    expect(validateRecordSchema(registry, "lifecycle.json", candidate)).toEqual([]);
    candidate.schemaVersion = "1.0.0";
    expect(validateRecordSchema(registry, "lifecycle.json", candidate).length)
      .toBeGreaterThan(0);
    candidate.schemaVersion = "9.9.9";
    expect(validateRecordSchema(registry, "lifecycle.json", candidate).length)
      .toBeGreaterThan(0);
  });

  it("looks up entries by exact version and type without using the default", async () => {
    const registry = await createSchemaRegistry(repositoryRoot);
    for (const version of versions) {
      expect(getSchemaEntry(registry, version, "model-plan")).toMatchObject({
        schemaVersion: version,
        file: `${version}/model-plan.schema.json`,
      });
    }
    expect(getSchemaEntry(registry, "9.9.9", "model-plan")).toBeUndefined();
    expect(getSchemaEntry(registry, "1.1.0", "unknown-type")).toBeUndefined();
  });

  it("changes only version metadata, model prefixes, and required host fields in the new schemas", async () => {
    for (const recordType of [...requiredRecordTypes, "shared"]) {
      const file = `${recordType}.schema.json`;
      let expected = await readFile(path.join(repositoryRoot, "schemas", "aff", "1.0.0", file), "utf8");
      expected = expected.replaceAll("1.0.0", "1.1.0");
      if (["model-plan", "review-record", "lifecycle-manifest"].includes(recordType)) {
        expected = expected.replaceAll('"^gpt-"', '"^(?:gpt-|claude-)"');
      }
      const expectedSchema = JSON.parse(expected) as {
        title: string;
        required: string[];
        properties: Record<string, unknown>;
        $defs: Record<string, unknown>;
      };
      if (recordType === "shared") {
        expectedSchema.title = "AFF shared contract definitions 1.1.0";
        expectedSchema.$defs.host = {
          type: "string",
          enum: ["github-copilot", "claude-code"],
        };
      }
      if (["model-plan", "run-journal-event"].includes(recordType)) {
        expectedSchema.required.push("host");
        expectedSchema.properties.host = { $ref: "shared.schema.json#/$defs/host" };
      }
      const actual: unknown = JSON.parse(await readFile(
        path.join(repositoryRoot, "schemas", "aff", "1.1.0", file), "utf8",
      ));
      expect(actual, file).toEqual(expectedSchema);
    }
  });

  it.each(versions)("rejects duplicate version/type entries for %s", async (version) => {
    const root = await copySchemas();
    await editCatalogue(root, (catalogue) => {
      catalogue.schemas.push({
        ...catalogue.schemas.find((entry) => entry.schemaVersion === version)!,
      });
    });

    const registry = await createSchemaRegistry(root);
    expect(registry.errors).toContainEqual(expect.objectContaining({
      invariant: "schema-catalogue",
      message: expect.stringContaining("repeats"),
    }));
  });

  it.each(versions)("requires all record types in version %s", async (version) => {
    const root = await copySchemas();
    await editCatalogue(root, (catalogue) => {
      catalogue.schemas = catalogue.schemas.filter((entry) =>
        !(entry.schemaVersion === version && entry.recordType === "model-plan"),
      );
    });

    const registry = await createSchemaRegistry(root);
    expect(registry.errors).toContainEqual(expect.objectContaining({
      invariant: "schema-catalogue",
      message: expect.stringContaining(`"${version}"`),
    }));
    expect(registry.validators.get(version)?.has("model-plan")).toBe(false);
  });

  it.each(versions)("reports a missing shared schema for %s without fallback", async (version) => {
    const root = await copySchemas();
    await rm(path.join(root, "schemas", "aff", version, "shared.schema.json"));

    const registry = await createSchemaRegistry(root);
    expect(registry.errors).toContainEqual(expect.objectContaining({
      invariant: "schema-catalogue",
      file: `schemas/aff/${version}/shared.schema.json`,
    }));
    expect(registry.validators.get(version)?.size ?? 0).toBe(0);
    const otherVersion = version === "1.0.0" ? "1.1.0" : "1.0.0";
    expect(registry.validators.get(otherVersion)?.size).toBe(16);
  });

  it.each(["$id", "schemaVersion"])("rejects cross-version shared %s metadata", async (field) => {
    const root = await copySchemas();
    const file = path.join(root, "schemas", "aff", "1.1.0", "shared.schema.json");
    const schema = JSON.parse(await readFile(file, "utf8")) as {
      $id: string;
      $defs: { schemaVersion: { const: string } };
    };
    if (field === "$id") schema.$id = schema.$id.replace("1.1.0", "1.0.0");
    else schema.$defs.schemaVersion.const = "1.0.0";
    await writeFile(file, JSON.stringify(schema));

    const registry = await createSchemaRegistry(root);
    expect(registry.errors).toContainEqual(expect.objectContaining({
      invariant: "schema-catalogue",
      file: "schemas/aff/1.1.0/shared.schema.json",
    }));
    expect(registry.validators.get("1.1.0")?.size).toBe(0);
    expect(registry.validators.get("1.0.0")?.size).toBe(16);
  });

  it("rejects a record schema referencing the other version's shared constant", async () => {
    const root = await copySchemas();
    const file = path.join(root, "schemas", "aff", "1.1.0", "model-plan.schema.json");
    const schema = JSON.parse(await readFile(file, "utf8")) as {
      properties: { schemaVersion: { $ref: string } };
    };
    schema.properties.schemaVersion.$ref = "../1.0.0/shared.schema.json#/$defs/schemaVersion";
    await writeFile(file, JSON.stringify(schema));

    const registry = await createSchemaRegistry(root);
    expect(registry.errors).toContainEqual(expect.objectContaining({
      invariant: "schema-catalogue",
      file: "schemas/aff/1.1.0/model-plan.schema.json",
    }));
    expect(registry.validators.get("1.1.0")?.has("model-plan")).toBe(false);
  });

  it.each([
    "../1.0.0/model-plan.schema.json",
    "1.1.0/../1.0.0/model-plan.schema.json",
    "1.1.0/..\\1.0.0\\model-plan.schema.json",
    "1.0.0/model-plan.schema.json",
    "/1.1.0/model-plan.schema.json",
    "C:\\1.1.0\\model-plan.schema.json",
  ])("rejects an escaping or cross-version schema path %s", async (file) => {
    const root = await copySchemas();
    await editCatalogue(root, (catalogue) => {
      catalogue.schemas.find((entry) =>
        entry.schemaVersion === "1.1.0" && entry.recordType === "model-plan",
      )!.file = file;
    });

    const registry = await createSchemaRegistry(root);
    expect(registry.errors).toContainEqual(expect.objectContaining({
      invariant: "schema-catalogue",
      message: expect.stringContaining("outside"),
    }));
    expect(registry.validators.get("1.1.0")?.has("model-plan")).toBe(false);
  });

  it.each([
    ["missing entry version", (catalogue: Record<string, unknown>) => {
      delete (catalogue.schemas as Record<string, unknown>[])[0]!.schemaVersion;
    }],
    ["unknown entry version", (catalogue: Record<string, unknown>) => {
      (catalogue.schemas as Record<string, unknown>[])[0]!.schemaVersion = "9.9.9";
    }],
    ["missing supported versions", (catalogue: Record<string, unknown>) => {
      delete catalogue.supportedContractVersions;
    }],
    ["empty supported versions", (catalogue: Record<string, unknown>) => {
      catalogue.supportedContractVersions = [];
    }],
    ["unknown supported version", (catalogue: Record<string, unknown>) => {
      catalogue.supportedContractVersions = ["1.0.0", "9.9.9"];
    }],
    ["duplicate supported version", (catalogue: Record<string, unknown>) => {
      catalogue.supportedContractVersions = ["1.0.0", "1.1.0", "1.1.0"];
    }],
    ["unknown default version", (catalogue: Record<string, unknown>) => {
      catalogue.contractVersion = "9.9.9";
    }],
    ["unsupported default version", (catalogue: Record<string, unknown>) => {
      catalogue.supportedContractVersions = ["1.0.0"];
    }],
    ["unsupported entry version", (catalogue: Record<string, unknown>) => {
      catalogue.contractVersion = "1.0.0";
      catalogue.supportedContractVersions = ["1.0.0"];
    }],
  ] as const)("rejects catalogue metadata with %s", async (_description, edit) => {
    const root = await copySchemas();
    const file = path.join(root, "schemas", "aff", "catalogue.json");
    const catalogue = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    edit(catalogue);
    await writeFile(file, JSON.stringify(catalogue));

    await expect(createSchemaRegistry(root)).rejects.toThrow("valid schema catalogue");
  });
});

describe("exact-version record validation", () => {
  it("rejects non-object records and non-string record types", async () => {
    const registry = await createSchemaRegistry(repositoryRoot);
    for (const candidate of [null, [], 1, {}, { recordType: null }, { recordType: 1 }]) {
      expect(validateRecordSchema(registry, "record.json", candidate))
        .toContainEqual(expect.objectContaining({
          invariant: "schema-validation",
          message: expect.stringContaining('"recordType"'),
        }));
    }
  });

  it.each([undefined, null, 1, {}, "9.9.9", ""])(
    "rejects malformed or unsupported version %s with supported choices",
    async (version) => {
      const registry = await createSchemaRegistry(repositoryRoot);
      const candidate = { ...journal("1.0.0"), schemaVersion: version };

      const errors = validateRecordSchema(registry, "journal.jsonl:1", candidate);
      expect(errors).toContainEqual(expect.objectContaining({
        invariant: "schema-validation",
        message: expect.stringContaining("schemaVersion"),
      }));
      expect(JSON.stringify(errors)).toContain("1.0.0");
      expect(JSON.stringify(errors)).toContain("1.1.0");
    },
  );

  it.each(versions)("rejects unknown record types in version %s", async (version) => {
    const registry = await createSchemaRegistry(repositoryRoot);
    const errors = validateRecordSchema(registry, "record.json", {
      schemaVersion: version,
      recordType: "unknown-type",
    });

    expect(errors).toContainEqual(expect.objectContaining({
      invariant: "schema-validation",
      message: expect.stringContaining("unknown-type"),
    }));
    expect(JSON.stringify(errors)).toContain("model-plan");
  });

  it("preserves the expected record type check", async () => {
    const registry = await createSchemaRegistry(repositoryRoot);
    expect(validateRecordSchema(registry, "record.json", journal("1.1.0"), "model-plan"))
      .toContainEqual(expect.objectContaining({
        invariant: "schema-validation",
        message: expect.stringContaining('Expected recordType "model-plan"'),
      }));
  });

  it.each([
    ["model-plan", path.join("0-coordination", "sample-model-plan.json")],
    ["review-record", path.join("reviews", "aff-a", "0", "round-1", "sample-aff-a-review.json")],
  ])("allows Claude models only in new %s records", async (recordType, fixture) => {
    const registry = await createSchemaRegistry(repositoryRoot);
    const candidate = await readFixture(fixture);
    expect(validateRecordSchema(registry, fixture, candidate)).toEqual([]);
    const modelOwner = recordType === "model-plan"
      ? (candidate.assignments as Record<string, unknown>[])[0]!
      : candidate;
    modelOwner.model = "claude-opus-5-5";
    expect(validateRecordSchema(registry, fixture, candidate).length).toBeGreaterThan(0);
    candidate.schemaVersion = "1.1.0";
    if (recordType === "model-plan") candidate.host = "claude-code";
    expect(validateRecordSchema(registry, fixture, candidate)).toEqual([]);
    modelOwner.model = "unsupported-provider";
    expect(validateRecordSchema(registry, fixture, candidate).length).toBeGreaterThan(0);
  });

  it.each(["model-plan", "run-journal-event"])(
    "requires a valid host only on 1.1.0 %s records and keeps fields closed",
    async (recordType) => {
      const registry = await createSchemaRegistry(repositoryRoot);
      const candidate = recordType === "model-plan"
        ? await readFixture(path.join("0-coordination", "sample-model-plan.json"))
        : journal("1.0.0");
      expect(validateRecordSchema(registry, "record.json", candidate)).toEqual([]);
      candidate.host = "github-copilot";
      expect(validateRecordSchema(registry, "record.json", candidate).length).toBeGreaterThan(0);
      candidate.schemaVersion = "1.1.0";
      expect(validateRecordSchema(registry, "record.json", candidate)).toEqual([]);
      candidate.host = "claude-code";
      expect(validateRecordSchema(registry, "record.json", candidate)).toEqual([]);
      candidate.host = "unknown-host";
      expect(validateRecordSchema(registry, "record.json", candidate).length).toBeGreaterThan(0);
      delete candidate.host;
      expect(validateRecordSchema(registry, "record.json", candidate).length).toBeGreaterThan(0);
      candidate.host = "claude-code";
      candidate.unknownField = true;
      expect(validateRecordSchema(registry, "record.json", candidate).length).toBeGreaterThan(0);
    },
  );
});

describe("version-aware record locations", () => {
  it("does not apply another version's expected record type at the same path", async () => {
    const root = await copySchemas();
    await editCatalogue(root, (catalogue) => {
      for (const entry of catalogue.schemas) {
        if (entry.schemaVersion === "1.0.0" && entry.recordType === "input-inventory") {
          entry.patterns = ["new-model-plan.json", "new-journal.jsonl"];
        }
        if (entry.schemaVersion === "1.1.0" && entry.recordType === "model-plan") {
          entry.patterns = ["new-model-plan.json"];
        }
        if (entry.schemaVersion === "1.1.0" && entry.recordType === "run-journal-event") {
          entry.patterns = ["new-journal.jsonl"];
        }
      }
    });
    const caseRoot = path.join(root, "synthetic-case");
    await mkdir(caseRoot);
    const modelPlan = await readFixture(path.join("0-coordination", "sample-model-plan.json"));
    modelPlan.schemaVersion = "1.1.0";
    modelPlan.host = "github-copilot";
    await writeFile(path.join(caseRoot, "new-model-plan.json"), JSON.stringify(modelPlan));
    await writeFile(path.join(caseRoot, "new-journal.jsonl"), JSON.stringify(journal("1.1.0")));

    const result = await loadCaseRecords(root, caseRoot);
    expect(result.errors).toEqual([]);
    expect(result.records).toHaveLength(2);
  });

  it.each(versions)("rejects wrong JSON and JSONL locations in %s", async (version) => {
    const root = await copySchemas();
    const caseRoot = path.join(root, "synthetic-case");
    await mkdir(caseRoot);
    const modelPlan = await readFixture(path.join("0-coordination", "sample-model-plan.json"));
    modelPlan.schemaVersion = version;
    if (version === "1.1.0") modelPlan.host = "claude-code";
    await writeFile(path.join(caseRoot, "wrong.json"), JSON.stringify(modelPlan));
    await writeFile(path.join(caseRoot, "wrong.jsonl"), JSON.stringify(journal(version)));

    const result = await loadCaseRecords(root, caseRoot);
    expect(result.errors.filter((error) => error.invariant === "schema-validation")).toEqual([]);
    expect(result.errors.filter((error) => error.invariant === "record-location"))
      .toHaveLength(2);
  });

  it.each(versions)("uses only %s patterns for JSON and JSONL records", async (version) => {
    const root = await copySchemas();
    await editCatalogue(root, (catalogue) => {
      for (const entry of catalogue.schemas) {
        if (entry.schemaVersion !== "1.1.0") continue;
        if (entry.recordType === "model-plan") entry.patterns = ["new-model-plan.json"];
        if (entry.recordType === "run-journal-event") entry.patterns = ["new-journal.jsonl"];
      }
    });
    const caseRoot = path.join(root, "synthetic-case");
    await mkdir(caseRoot);
    const modelPlan = await readFixture(path.join("0-coordination", "sample-model-plan.json"));
    modelPlan.schemaVersion = version;
    if (version === "1.1.0") modelPlan.host = "claude-code";
    await writeFile(path.join(caseRoot, "new-model-plan.json"), JSON.stringify(modelPlan));
    await writeFile(path.join(caseRoot, "new-journal.jsonl"), JSON.stringify(journal(version)));

    const result = await loadCaseRecords(root, caseRoot);
    expect(result.errors.filter((error) => error.invariant === "schema-validation")).toEqual([]);
    expect(result.errors.filter((error) => error.invariant === "record-location"))
      .toHaveLength(version === "1.1.0" ? 0 : 2);
  });

  it("does not let a malformed version bypass record validation", async () => {
    const root = await copySchemas();
    const caseRoot = path.join(root, "synthetic-case");
    await mkdir(caseRoot);
    await writeFile(path.join(caseRoot, "wrong.json"), JSON.stringify(journal("9.9.9")));
    await writeFile(path.join(caseRoot, "wrong.jsonl"), JSON.stringify({
      ...journal("1.0.0"),
      schemaVersion: null,
    }));

    const result = await loadCaseRecords(root, caseRoot);
    expect(result.records).toEqual([]);
    expect(result.errors.filter((error) => error.invariant === "schema-validation"))
      .toHaveLength(2);
  });
});
