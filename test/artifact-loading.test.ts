import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { validateCandidateFileCoverage } from "../src/case/coverage.js";
import { validateHashBindings } from "../src/case/hash.js";
import { validateRecordIdentity } from "../src/case/identity.js";
import * as recordLoader from "../src/case/records.js";
import { createSchemaRegistry } from "../src/schema/validator.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directories: string[] = [];
const versions = ["1.0.0", "1.1.0"];

async function syntheticCase(): Promise<string> {
  const root = await mkdtemp(path.join(repositoryRoot, ".artifact-loading-"));
  directories.push(root);
  const caseRoot = path.join(root, "synthetic");
  await mkdir(caseRoot);
  return caseRoot;
}

async function put(caseRoot: string, file: string, value: string | Buffer): Promise<void> {
  const destination = path.join(caseRoot, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, value);
}

function inventory(schemaVersion: string, artifactPrefix = "sample") {
  return {
    schemaVersion,
    recordType: "input-inventory",
    caseName: "synthetic",
    artifactPrefix,
    sources: [{
      sourcePath: "input/brief.txt",
      governedArtifact: { path: "input/brief.txt", sha256: "0".repeat(64) },
      readable: true,
    }],
  };
}

function event(schemaVersion: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion,
    recordType: "run-journal-event",
    caseName: "synthetic",
    artifactPrefix: "sample",
    eventId: "EVT-001",
    sequence: 1,
    timestamp: "2026-01-01T09:00:00Z",
    phaseId: "0",
    eventType: "PHASE-ENTERED",
    actor: "AFF-0-coordinator",
    summary: "Synthetic event.",
    ...(schemaVersion === "1.1.0" ? { host: "github-copilot" } : {}),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

describe.each(versions)("artifact classification for contract %s", (version) => {
  it("accepts app settings, package data, scalars and unknown domain record types without loading AFF records", async () => {
    const root = await syntheticCase();
    await put(root, "5-coding/package.json", '{"name":"synthetic","version":"1.0.0"}');
    await put(root, "5-coding/appsettings.json", '{"Logging":{"Level":"Debug"}}');
    await put(root, "5-coding/domain.json", JSON.stringify({
      recordType: "order-created", schemaVersion: version,
    }));
    await put(root, "5-coding/data.json", "[null,1,true]");
    await put(root, "5-coding/events.jsonl", '{"recordType":"order-created"}\n42\n');

    expect(await recordLoader.loadCaseRecords(repositoryRoot, root)).toEqual({
      records: [], errors: [],
    });
  });

  it("loads a correctly placed AFF record and rejects a relocated known AFF type", async () => {
    const root = await syntheticCase();
    const content = JSON.stringify(inventory(version));
    await put(root, "0-coordination/sample-input-inventory.json", content);
    await put(root, "5-coding/stray.json", content);
    await put(root, "5-coding/stray.jsonl", `${JSON.stringify(event(version))}\n`);

    const loaded = await recordLoader.loadCaseRecords(repositoryRoot, root);
    expect(loaded.records.map(({ file }) => file)).toEqual([
      "0-coordination/sample-input-inventory.json",
    ]);
    expect(loaded.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "5-coding/stray.json", invariant: "record-location" }),
      expect.objectContaining({ file: "5-coding/stray.jsonl:1", invariant: "record-location" }),
    ]));
  });

  it.each(["missing", "unsupported", "numeric"])("rejects %s versions at catalogued paths", async (kind) => {
    const root = await syntheticCase();
    const value: Record<string, unknown> = inventory(version);
    if (kind === "missing") delete value.schemaVersion;
    else value.schemaVersion = kind === "numeric" ? 1 : "1.1.1";
    await put(root, "0-coordination/sample-input-inventory.json", JSON.stringify(value));
    const journal: Record<string, unknown> = event(version);
    if (kind === "missing") delete journal.schemaVersion;
    else journal.schemaVersion = value.schemaVersion;
    await put(root, "sample-run-journal.jsonl", JSON.stringify(journal));

    const loaded = await recordLoader.loadCaseRecords(repositoryRoot, root);
    expect(loaded.records).toEqual([]);
    expect(loaded.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "0-coordination/sample-input-inventory.json", invariant: "schema-validation" }),
      expect.objectContaining({ file: "sample-run-journal.jsonl:1", invariant: "schema-validation" }),
    ]));
  });

  it("enforces expected types at catalogued JSON and JSONL paths", async () => {
    const root = await syntheticCase();
    await put(root, "0-coordination/sample-input-inventory.json", JSON.stringify(event(version)));
    await put(root, "sample-run-journal.jsonl", JSON.stringify(inventory(version)));
    const loaded = await recordLoader.loadCaseRecords(repositoryRoot, root);
    expect(loaded.records).toEqual([]);
    expect(loaded.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "0-coordination/sample-input-inventory.json", invariant: "schema-validation", message: expect.stringContaining('Expected recordType "input-inventory"') }),
      expect.objectContaining({ file: "sample-run-journal.jsonl:1", invariant: "schema-validation", message: expect.stringContaining('Expected recordType "run-journal-event"') }),
    ]));
  });

  it("still rejects unknown domain data at a reserved AFF record path", async () => {
    const root = await syntheticCase();
    await put(root, "0-coordination/sample-input-inventory.json", '{"recordType":"order-created"}');
    const loaded = await recordLoader.loadCaseRecords(repositoryRoot, root);
    expect(loaded.records).toEqual([]);
    expect(loaded.errors).toContainEqual(expect.objectContaining({ invariant: "schema-validation" }));
  });

  it("does not let missing or unsupported versions hide relocated known AFF records", async () => {
    const root = await syntheticCase();
    await put(root, "5-coding/stray.json", '{"recordType":"human-approval"}');
    await put(root, "5-coding/stray.jsonl", '{"recordType":"run-journal-event","schemaVersion":"9.0.0"}');
    const loaded = await recordLoader.loadCaseRecords(repositoryRoot, root);
    expect(loaded.records).toEqual([]);
    for (const file of ["5-coding/stray.json", "5-coding/stray.jsonl:1"]) {
      expect(loaded.errors).toContainEqual(expect.objectContaining({ file, invariant: "record-location" }));
      expect(loaded.errors).toContainEqual(expect.objectContaining({ file, invariant: "schema-validation" }));
    }
  });

  it("uses the exact declared contract, not the other supported version", async () => {
    const root = await syntheticCase();
    const value: Record<string, unknown> = event(version);
    if (version === "1.0.0") value.host = "github-copilot";
    else delete value.host;
    await put(root, "sample-run-journal.jsonl", JSON.stringify(value));
    const loaded = await recordLoader.loadCaseRecords(repositoryRoot, root);
    expect(loaded.records).toEqual([]);
    expect(loaded.errors).toContainEqual(expect.objectContaining({
      file: "sample-run-journal.jsonl:1", invariant: "schema-validation",
    }));
  });

  it("requires non-record artifacts in candidate coverage and catches their hash tampering", async () => {
    const root = await syntheticCase();
    const file = "5-coding/package.json";
    const domain = "5-coding/domain.json";
    const payload = '{"name":"synthetic"}';
    const domainPayload = '{"recordType":"order-created"}';
    await put(root, file, payload);
    await put(root, domain, domainPayload);
    const candidate = event(version, {
      phaseId: "5", eventType: "ARTIFACTS-RECORDED",
      artifactHashes: [
        { path: file, sha256: createHash("sha256").update(payload).digest("hex") },
        { path: domain, sha256: createHash("sha256").update(domainPayload).digest("hex") },
      ],
    });
    await put(root, "sample-run-journal.jsonl", JSON.stringify(candidate));

    const loaded = await recordLoader.loadCaseRecords(repositoryRoot, root);
    expect(loaded.errors).toEqual([]);
    expect(loaded.records).toHaveLength(1);
    expect(await validateHashBindings(root, loaded.records)).toEqual([]);
    expect(await validateCandidateFileCoverage(root, loaded.records)).toEqual([]);

    await put(root, file, '{"name":"changed"}');
    await put(root, domain, '{"recordType":"order-cancelled"}');
    const errors = await validateHashBindings(root, loaded.records);
    expect(errors).toHaveLength(2);
    expect(errors.every(({ invariant }) => invariant === "artifact-hash-binding")).toBe(true);

    await put(root, "5-coding/uncovered.json", '{"recordType":"order-created"}');
    expect(await validateCandidateFileCoverage(root, loaded.records)).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("5-coding/uncovered.json") }),
    );
  });

  it("keeps schema-valid lines of a syntactically valid journal without accepting invalid record lines", async () => {
    const root = await syntheticCase();
    await put(root, "sample-run-journal.jsonl", [
      JSON.stringify(event(version)),
      JSON.stringify(event(version, { sequence: 0 })),
    ].join("\n"));
    const loaded = await recordLoader.loadCaseRecords(repositoryRoot, root);
    expect(loaded.records.map(({ file }) => file)).toEqual(["sample-run-journal.jsonl:1"]);
    expect(loaded.records[0]?.snapshotSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(loaded.errors).toContainEqual(expect.objectContaining({
      file: "sample-run-journal.jsonl:2", invariant: "schema-validation",
    }));
  });
});

describe("artifact parse diagnostics", () => {
  it.each(versions)("does not load any line from malformed %s journals or fabricate a hash", async (version) => {
    const root = await syntheticCase();
    await put(root, "sample-run-journal.jsonl", [
      JSON.stringify(event(version)), "", "{bad", JSON.stringify(event(version, { sequence: 2 })),
    ].join("\r\n"));
    const loaded = await recordLoader.loadCaseRecords(repositoryRoot, root);
    expect(loaded.records).toEqual([]);
    expect(loaded.errors).toContainEqual(expect.objectContaining({
      file: "sample-run-journal.jsonl:3", invariant: "json-syntax",
    }));
  });

  it.each(["input/source.json", "5-coding/package.json"])("reports malformed JSON in %s", async (file) => {
    const root = await syntheticCase();
    await put(root, file, "{broken");
    expect((await recordLoader.loadCaseRecords(repositoryRoot, root)).errors).toContainEqual(
      expect.objectContaining({ file, invariant: "json-syntax" }),
    );
  });

  it.each(["input/source.jsonl", "5-coding/events.jsonl"])("reports malformed lines even in non-record %s", async (file) => {
    const root = await syntheticCase();
    await put(root, file, '{"recordType":"order-created"}\n{broken\n');
    const loaded = await recordLoader.loadCaseRecords(repositoryRoot, root);
    expect(loaded.records).toEqual([]);
    expect(loaded.errors).toContainEqual(
      expect.objectContaining({ file: `${file}:2`, invariant: "json-syntax" }),
    );
  });

  it.each(["input/source.json", "5-coding/package.json"])("reports invalid UTF-8 in %s", async (file) => {
    const root = await syntheticCase();
    await put(root, file, Buffer.from([0xff]));
    expect((await recordLoader.loadCaseRecords(repositoryRoot, root)).errors).toContainEqual(
      expect.objectContaining({ file, invariant: "json-syntax", message: expect.stringContaining("UTF-8") }),
    );
  });

  it.each(["sample-run-journal.jsonl", "input/source.jsonl"])("locates invalid UTF-8 by line in %s", async (file) => {
    const root = await syntheticCase();
    await put(root, file, Buffer.concat([
      Buffer.from(`${JSON.stringify(event("1.0.0"))}\n\n`), Buffer.from([0xff]),
    ]));
    const loaded = await recordLoader.loadCaseRecords(repositoryRoot, root);
    expect(loaded.records).toEqual([]);
    expect(loaded.errors).toContainEqual(expect.objectContaining({
      file: `${file}:3`, invariant: "json-syntax", message: expect.stringContaining("UTF-8"),
    }));
  });

  it("preserves input syntax-only treatment even for known AFF types with invalid versions", async () => {
    const root = await syntheticCase();
    await put(root, "input/source.json", '{"recordType":"human-approval","schemaVersion":"wrong"}');
    await put(root, "input/source.jsonl", '{"recordType":"human-approval","schemaVersion":"wrong"}\n');
    expect(await recordLoader.loadCaseRecords(repositoryRoot, root)).toEqual({ records: [], errors: [] });
  });

  it("preserves canonical valid hashes across BOM, whitespace and CRLF", async () => {
    const root = await syntheticCase();
    const canonical = '{"actor":"AFF-0-coordinator","artifactPrefix":"sample","caseName":"synthetic","eventId":"EVT-001","eventType":"PHASE-ENTERED","phaseId":"0","recordType":"run-journal-event","schemaVersion":"1.0.0","sequence":1,"summary":"Synthetic event.","timestamp":"2026-01-01T09:00:00Z"}\n';
    await put(root, "sample-run-journal.jsonl", `\uFEFF${JSON.stringify(event("1.0.0"))}\r\n\r\n`);
    const loaded = await recordLoader.loadCaseRecords(repositoryRoot, root);
    expect(loaded.errors).toEqual([]);
    expect(loaded.records[0]?.snapshotSha256).toBe(
      createHash("sha256").update(canonical).digest("hex"),
    );
  });

  it("preserves JSON canonical hashes across BOM and formatting changes", async () => {
    const root = await syntheticCase();
    const canonical = '{"artifactPrefix":"sample","caseName":"synthetic","recordType":"input-inventory","schemaVersion":"1.0.0","sources":[{"governedArtifact":{"path":"input/brief.txt","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},"readable":true,"sourcePath":"input/brief.txt"}]}';
    await put(root, "0-coordination/sample-input-inventory.json",
      `\uFEFF${JSON.stringify(inventory("1.0.0"), null, 2).replaceAll("\n", "\r\n")}\r\n`);
    const loaded = await recordLoader.loadCaseRecords(repositoryRoot, root);
    expect(loaded.errors).toEqual([]);
    expect(loaded.records[0]?.snapshotSha256).toBe(
      createHash("sha256").update(canonical).digest("hex"),
    );
  });

  it("does not silently strip a BOM from a later JSONL record", async () => {
    const root = await syntheticCase();
    await put(root, "sample-run-journal.jsonl",
      `${JSON.stringify(event("1.0.0"))}\n\uFEFF${JSON.stringify(event("1.0.0", { sequence: 2 }))}`);
    const loaded = await recordLoader.loadCaseRecords(repositoryRoot, root);
    expect(loaded.records).toEqual([]);
    expect(loaded.errors).toContainEqual(expect.objectContaining({
      file: "sample-run-journal.jsonl:2", invariant: "json-syntax",
    }));
  });
});

describe("catalogued metadata discovery", () => {
  it("exports a path-only predicate across supported versions, not a recordType heuristic", async () => {
    const registry = await createSchemaRegistry(repositoryRoot);
    const isCatalogued = recordLoader.isCataloguedRecordPath;
    expect(isCatalogued(registry, "5-coding/sample-release-manifest.json")).toBe(true);
    expect(isCatalogued(registry, "sample-run-journal.jsonl")).toBe(true);
    expect(isCatalogued(registry, "5-coding/package.json")).toBe(false);
    expect(isCatalogued(registry, "5-coding/domain.json")).toBe(false);
    expect(isCatalogued(registry, "input/sample-release-manifest.json")).toBe(false);
    expect(isCatalogued(registry, "5-coding\\sample-release-manifest.json")).toBe(true);
  });
});

function identityRecord(file: string, recordType: string, artifactPrefix: string, caseName = "synthetic"): recordLoader.LoadedRecord {
  return {
    file, absolutePath: path.join(repositoryRoot, file), snapshotSha256: "0".repeat(64),
    value: { recordType, artifactPrefix, caseName },
  };
}

describe("deterministic case identity", () => {
  const input = identityRecord("0-coordination/sample-input-inventory.json", "input-inventory", "sample");
  const plan = identityRecord("0-coordination/sample-model-plan.json", "model-plan", "sample");
  const stray = identityRecord("5-coding/wrong-release-manifest.json", "release-manifest", "wrong");
  const caseRoot = path.join(repositoryRoot, "synthetic");

  it("uses agreeing Phase 0 anchors regardless of input order or non-anchor majority", () => {
    const records = [stray, { ...stray, file: "6-presentation/wrong-claim-catalogue.json" }, input, plan];
    const errors = validateRecordIdentity(caseRoot, records);
    expect(errors).toEqual(validateRecordIdentity(caseRoot, [...records].reverse()));
    expect(errors).toHaveLength(2);
    expect(errors.every(({ message }) => message.includes('differs from "sample"'))).toBe(true);
  });

  it("uses a single trustworthy Phase 0 anchor without guessing from unrelated records", () => {
    const errors = validateRecordIdentity(caseRoot, [stray, input]);
    expect(errors).toEqual(validateRecordIdentity(caseRoot, [input, stray]));
    expect(errors).toContainEqual(expect.objectContaining({
      file: stray.file, message: expect.stringContaining('differs from "sample"'),
    }));
  });

  it("reports ambiguity when Phase 0 anchors disagree, not an arbitrary winner", () => {
    const conflict = identityRecord("0-coordination/other-model-plan.json", "model-plan", "other");
    const records = [input, conflict, stray];
    const errors = validateRecordIdentity(caseRoot, records);
    expect(errors).toEqual(validateRecordIdentity(caseRoot, [...records].reverse()));
    expect(errors).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/ambiguous/iu) }));
    expect(errors.some(({ message }) => message.includes("differs from"))).toBe(false);
  });

  it("reports ambiguity with no trustworthy Phase 0 anchor", () => {
    const records = [stray, identityRecord("stray-input-inventory.json", "input-inventory", "sample")];
    const errors = validateRecordIdentity(caseRoot, records);
    expect(errors).toEqual(validateRecordIdentity(caseRoot, [...records].reverse()));
    expect(errors).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/ambiguous/iu) }));
  });

  it("does not trust a Phase 0 identity with a different case name", () => {
    const records = [
      identityRecord(input.file, "input-inventory", "sample", "different-case"), stray,
    ];
    const errors = validateRecordIdentity(caseRoot, records);
    expect(errors).toContainEqual(expect.objectContaining({
      file: input.file, message: expect.stringContaining('directory "synthetic"'),
    }));
    expect(errors).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/ambiguous/iu) }));
  });

  it("does not silently ignore a canonical anchor whose filename and prefix conflict", () => {
    const records = [input, identityRecord(plan.file, "model-plan", "different")];
    const errors = validateRecordIdentity(caseRoot, records);
    expect(errors).toEqual(validateRecordIdentity(caseRoot, [...records].reverse()));
    expect(errors).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/ambiguous/iu) }));
  });

  it("preserves the empty legacy case where there are no record identities to compare", () => {
    expect(validateRecordIdentity(caseRoot, [])).toEqual([]);
  });
});
