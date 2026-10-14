import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { prepareApproval, recordSignedDecision } from "../src/approve/prepare.js";
import { validateCase } from "../src/case/index.js";
import { loadCaseRecords } from "../src/case/records.js";
import { createIdentity } from "../src/identity/keys.js";
import { verifyApprovalSignature } from "../src/identity/signature.js";
import { renderPhaseHtml, renderSolutionOverview } from "../src/render/index.js";
import { buildContosoSmokeWorkspace, runContosoSmoke } from "../src/smoke/contoso.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const combinations = [
  ["github-copilot", "1.0.0"],
  ["github-copilot", "1.1.0"],
  ["claude-code", "1.1.0"],
] as const;
const casePath = "cases/contoso-permit-services";

async function sourceBytes(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.name !== "solution-overview.html") {
        files.set(path.relative(root, absolute), await readFile(absolute));
      }
    }
  }
  await walk(root);
  return files;
}

describe("offline host compatibility", () => {
  it.each(combinations)("validates and renders %s with %s", async (host, schemaVersion) => {
    const output = await mkdtemp(path.join(tmpdir(), "aff-host-matrix-"));
    try {
      const result = await runContosoSmoke({
        repositoryRoot, host, schemaVersion, keepOutputPath: output,
      });
      expect(result.liveModelCalls).toBe(0);
      expect(result.azureActions).toBe(0);
      expect(result.syntheticApproval).toBe(true);
      expect(result.syntheticEvidenceNotice).toContain("never a real human");
      const caseRoot = path.join(output, casePath);
      const loaded = await loadCaseRecords(repositoryRoot, caseRoot);
      expect(loaded.errors).toEqual([]);
      expect(loaded.records.length).toBeGreaterThan(10);
      for (const { value } of loaded.records) {
        expect(value.schemaVersion).toBe(schemaVersion);
        if (value.recordType === "model-plan" || value.recordType === "run-journal-event") {
          expect(value.host).toBe(schemaVersion === "1.1.0" ? host : undefined);
        }
      }
      expect(await readFile(path.join(caseRoot, "solution-overview.html"), "utf8"))
        .toContain("Synthetic test approval and exited");
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it.each(combinations)("preserves copied signed %s %s evidence byte-for-byte", async (host, schemaVersion) => {
    const root = await mkdtemp(path.join(tmpdir(), "aff-signed-compatibility-"));
    try {
      const fixture = path.join(root, "fixture");
      const workspace = path.join(root, "copy");
      const home = path.join(root, "isolated-home");
      const passphrase = "synthetic fixture passphrase only";
      await buildContosoSmokeWorkspace(repositoryRoot, fixture, { host, schemaVersion });
      const caseRoot = path.join(fixture, casePath);
      await rm(path.join(caseRoot, "approvals", "phase-0", "contoso-phase-0-synthetic-approval.json"));
      await createIdentity({ label: "Isolated test architect", passphrase, home });
      const journalPath = path.join(caseRoot, "contoso-run-journal.jsonl");
      const events = (await readFile(journalPath, "utf8")).trim().split(/\r?\n/u)
        .map((line) => JSON.parse(line));
      for (const event of events) {
        if (event.eventType === "HUMAN-DECISION") {
          event.actor = "Isolated test architect";
          event.summary = "Isolated signed regression fixture; not a real architecture approval.";
        }
      }
      await writeFile(journalPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      const context = await prepareApproval({
        repositoryRoot: fixture, casePath, phaseId: "0", home,
      });
      expect(context.schemaVersion).toBe(schemaVersion);
      const decision = await recordSignedDecision({
        context, decision: "APPROVED", passphrase, home,
        decidedAt: "2026-01-01T09:05:00Z",
      });
      const original = JSON.parse(await readFile(path.join(caseRoot, decision.file), "utf8"));
      expect(original.schemaVersion).toBe(schemaVersion);
      expect(verifyApprovalSignature(original)).toEqual({ verified: true });
      await cp(fixture, workspace, { recursive: true });
      const copiedCase = path.join(workspace, casePath);
      const before = await sourceBytes(copiedCase);
      expect((await validateCase(workspace, casePath, { home })).errors).toEqual([]);
      await renderPhaseHtml({
        caseRoot: copiedCase,
        phaseId: "0",
        sourcePath: "0-coordination/contoso-coordination.md",
        outputPath: "0-coordination/contoso-coordination.html",
        metadataPaths: [
          "0-coordination/contoso-input-inventory.json",
          "0-coordination/contoso-model-plan.json",
        ],
      });
      await renderSolutionOverview({ repositoryRoot: workspace, casePath });
      expect(await sourceBytes(copiedCase)).toEqual(before);
      expect(await sourceBytes(caseRoot)).toEqual(before);
      expect(verifyApprovalSignature(JSON.parse(
        await readFile(path.join(copiedCase, decision.file), "utf8"),
      ))).toEqual({ verified: true });
      expect((await validateCase(workspace, casePath, { home })).errors).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
