import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalTextBytes, hashArtifact } from "../src/case/hash.js";
import { isRecord } from "../src/common/json.js";
import {
  buildContosoSmokeWorkspace,
  runContosoSmoke,
  verifyContosoSmokeWorkspace,
} from "../src/smoke/contoso.js";
import { runSmokeCli } from "../src/smoke/cli.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createSmokeWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "aff-contoso-negative-"));
  temporaryDirectories.push(workspaceRoot);
  await buildContosoSmokeWorkspace(repositoryRoot, workspaceRoot);
  return workspaceRoot;
}

async function mutateJson(
  file: string,
  mutate: (value: Record<string, unknown>) => void,
): Promise<void> {
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!isRecord(value)) {
    throw new TypeError(`${file} must contain a JSON object.`);
  }
  mutate(value);
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("offline Contoso smoke journey", () => {
  it.each([
    ["--host", "claude-code"],
    ["--schema-version", "1.1.0"],
    ["--host", "unknown", "--schema-version", "1.1.0"],
    ["--host", "github-copilot", "--schema-version", "2.0.0"],
    ["--host", "claude-code", "--schema-version", "1.0.0"],
  ])("rejects invalid CLI policy %j with usage status", async (...flags) => {
    expect(await runSmokeCli(["node", "smoke:contoso", ...flags])).toBe(64);
  });

  it("rejects a legacy Claude workspace before writing evidence", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "aff-invalid-host-"));
    temporaryDirectories.push(workspace);
    await expect(buildContosoSmokeWorkspace(repositoryRoot, workspace, {
      host: "claude-code", schemaVersion: "1.0.0",
    })).rejects.toThrow(/1\.0\.0.*github-copilot/u);
    expect(await readdir(workspace)).toEqual([]);
  });

  it("copies only the allowlisted synthetic case inputs", async () => {
    const source = await createSmokeWorkspace();
    const unrelated = path.join(source, "cases", "unrelated-local-case");
    await mkdir(unrelated);
    await writeFile(path.join(unrelated, "do-not-copy.txt"), "Synthetic isolation sentinel");
    await writeFile(path.join(source, "cases", "contoso-permit-services", "input", "local-only.txt"), "Synthetic isolation sentinel");
    const workspace = await mkdtemp(path.join(tmpdir(), "aff-smoke-isolation-"));
    temporaryDirectories.push(workspace);
    await buildContosoSmokeWorkspace(source, workspace);
    expect(await readdir(path.join(workspace, "cases"))).toEqual(
      expect.arrayContaining(["_template", "contoso-permit-services"]),
    );
    expect(await readdir(path.join(workspace, "cases"))).not.toContain("unrelated-local-case");
    expect(await readdir(path.join(workspace, "cases", "contoso-permit-services", "input")))
      .not.toContain("local-only.txt");
  });

  it("uses platform-independent text bytes in governed inventories", async () => {
    const brief = await readFile(
      path.join(
        repositoryRoot,
        "cases",
        "contoso-permit-services",
        "input",
        "architecture-brief.md",
      ),
    );
    const lf = canonicalTextBytes(brief);
    const crlf = Buffer.from(
      brief.toString("utf8").replace(/\r?\n/gu, "\r\n"),
      "utf8",
    );

    expect(canonicalTextBytes(crlf)).toEqual(lf);
    expect(canonicalTextBytes(crlf).byteLength).toBe(lf.byteLength);
  });

  it("proves Phase 0 through the first Phase 1 question without live execution", async () => {
    const retainedOutput = await mkdtemp(path.join(tmpdir(), "aff-contoso-output-"));
    temporaryDirectories.push(retainedOutput);
    const sourceBrief = path.join(
      repositoryRoot,
      "cases",
      "contoso-permit-services",
      "input",
      "architecture-brief.md",
    );
    const sourceHashBefore = await hashArtifact(sourceBrief);

    const result = await runContosoSmoke({
      repositoryRoot,
      keepOutputPath: retainedOutput,
    });

    expect(result.assertionsPassed).toBeGreaterThan(20);
    expect(result.boundary).toMatch(/offline contract\/smoke harness/u);
    expect(result.liveModelCalls).toBe(0);
    expect(result.azureActions).toBe(0);
    expect(result.questionsEmitted).toHaveLength(1);
    expect(result.requirementsBaselined).toEqual([]);
    expect(result.routeReady).toBe("AFF-1");
    expect(result.syntheticApproval).toBe(true);
    expect(result.phase7Or8Routed).toBe(false);
    expect(await hashArtifact(sourceBrief)).toBe(sourceHashBefore);

    const caseRoot = path.join(
      retainedOutput,
      "cases",
      "contoso-permit-services",
    );
    expect(
      await readFile(
        path.join(caseRoot, "0-coordination", "contoso-coordination.html"),
        "utf8",
      ),
    ).toContain("Diagram shown as escaped Mermaid source");
    const overview = await readFile(
      path.join(caseRoot, "solution-overview.html"),
      "utf8",
    );
    expect(overview).toContain("Synthetic test approval and exited");
    expect(overview).toContain('href="input/architecture-brief.md"');
    expect(
      await readFile(path.join(retainedOutput, "smoke-report.json"), "utf8"),
    ).toContain("Synthetic test evidence");
  });

  it("rejects mismatched final reviewer hashes", async () => {
    const workspaceRoot = await createSmokeWorkspace();
    const reviewPath = path.join(
      workspaceRoot,
      "cases",
      "contoso-permit-services",
      "reviews",
      "aff-b",
      "0",
      "round-1",
      "contoso-aff-b-review.json",
    );
    await mutateJson(reviewPath, (review) => {
      if (!Array.isArray(review.subjectArtifacts) || !isRecord(review.subjectArtifacts[0])) {
        throw new TypeError("Review fixture has no subject artifact.");
      }
      review.subjectArtifacts[0].sha256 = "0".repeat(64);
    });

    await expect(verifyContosoSmokeWorkspace(workspaceRoot)).rejects.toThrow(
      /validation failed/u,
    );
  });

  it("rejects a stale candidate hash", async () => {
    const workspaceRoot = await createSmokeWorkspace();
    await writeFile(
      path.join(
        workspaceRoot,
        "cases",
        "contoso-permit-services",
        "0-coordination",
        "contoso-coordination.md",
      ),
      "# Phase 0\n\nStale mutation.\n",
      "utf8",
    );

    await expect(verifyContosoSmokeWorkspace(workspaceRoot)).rejects.toThrow(
      /validation failed/u,
    );
  });

  it("rejects a malformed synthetic approval", async () => {
    const workspaceRoot = await createSmokeWorkspace();
    const approvalPath = path.join(
      workspaceRoot,
      "cases",
      "contoso-permit-services",
      "approvals",
      "phase-0",
      "contoso-phase-0-synthetic-approval.json",
    );
    await mutateJson(approvalPath, (approval) => {
      delete approval.decision;
    });

    await expect(verifyContosoSmokeWorkspace(workspaceRoot)).rejects.toThrow(
      /validation failed/u,
    );
  });

  it("rejects a model plan that breaks AFF-A separation", async () => {
    const workspaceRoot = await createSmokeWorkspace();
    const modelPath = path.join(
      workspaceRoot,
      "cases",
      "contoso-permit-services",
      "0-coordination",
      "contoso-model-plan.json",
    );
    await mutateJson(modelPath, (modelPlan) => {
      if (!Array.isArray(modelPlan.assignments)) {
        throw new TypeError("Model plan has no assignments.");
      }
      const affA = modelPlan.assignments.find(
        (assignment) =>
          isRecord(assignment) && assignment.agent === "AFF-A-rubber-duck",
      );
      if (!isRecord(affA)) {
        throw new TypeError("Model plan has no AFF-A assignment.");
      }
      affA.model = "gpt-5.6-sol";
    });

    await expect(verifyContosoSmokeWorkspace(workspaceRoot)).rejects.toThrow(
      /validation failed/u,
    );
  });

  it("rejects an attempted route to optional Phase 8", async () => {
    const workspaceRoot = await createSmokeWorkspace();
    const journalPath = path.join(
      workspaceRoot,
      "cases",
      "contoso-permit-services",
      "contoso-run-journal.jsonl",
    );
    await writeFile(
      journalPath,
      `${await readFile(journalPath, "utf8")}${JSON.stringify({
        schemaVersion: "1.0.0",
        recordType: "run-journal-event",
        caseName: "contoso-permit-services",
        artifactPrefix: "contoso",
        eventId: "CONTOSO-SMOKE-008",
        sequence: 8,
        timestamp: "2026-01-01T09:08:00.000Z",
        phaseId: "8",
        eventType: "PHASE-ENTERED",
        actor: "AFF-8-testing",
        summary: "Forbidden automatic smoke route.",
      })}\n`,
      "utf8",
    );

    await expect(verifyContosoSmokeWorkspace(workspaceRoot)).rejects.toThrow(
      /validation failed: .*phase-sequence/u,
    );
  });

  it("rejects accidental forbidden action evidence", async () => {
    const workspaceRoot = await createSmokeWorkspace();
    const actionsPath = path.join(
      workspaceRoot,
      "cases",
      "contoso-permit-services",
      "input",
      "smoke-actions.json",
    );
    await mutateJson(actionsPath, (actions) => {
      if (!Array.isArray(actions.actionsPerformed)) {
        throw new TypeError("Smoke action evidence is malformed.");
      }
      actions.actionsPerformed.push("azure-deployment");
    });

    await expect(verifyContosoSmokeWorkspace(workspaceRoot)).rejects.toThrow(
      /forbidden action/u,
    );
  });

  it("rejects AFF-0 acting as the Phase 1 interviewer", async () => {
    const workspaceRoot = await createSmokeWorkspace();
    const openingPath = path.join(
      workspaceRoot,
      "cases",
      "contoso-permit-services",
      "input",
      "smoke-phase-1-opening.json",
    );
    await mutateJson(openingPath, (opening) => {
      opening.actor = "AFF-0-coordinator";
    });

    await expect(verifyContosoSmokeWorkspace(workspaceRoot)).rejects.toThrow(
      /prepares but does not conduct|AFF-1 invokes/u,
    );
  });

  it("rejects AFF-0 owning the Phase 1 journal entry", async () => {
    const workspaceRoot = await createSmokeWorkspace();
    const journalPath = path.join(
      workspaceRoot,
      "cases",
      "contoso-permit-services",
      "contoso-run-journal.jsonl",
    );
    const events = (await readFile(journalPath, "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line))
      .map((event: unknown) => {
        if (
          isRecord(event) &&
          event.phaseId === "1" &&
          event.eventType === "PHASE-ENTERED"
        ) {
          event.actor = "AFF-0-coordinator";
        }
        return event;
      });
    await writeFile(
      journalPath,
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );

    await expect(verifyContosoSmokeWorkspace(workspaceRoot)).rejects.toThrow(
      /prepares but does not conduct|AFF-1 invokes/u,
    );
  });

  it("rejects a post-approval blocker before Phase 1 routing", async () => {
    const workspaceRoot = await createSmokeWorkspace();
    const journalPath = path.join(
      workspaceRoot,
      "cases",
      "contoso-permit-services",
      "contoso-run-journal.jsonl",
    );
    await writeFile(
      journalPath,
      `${await readFile(journalPath, "utf8")}${JSON.stringify({
        schemaVersion: "1.0.0",
        recordType: "run-journal-event",
        caseName: "contoso-permit-services",
        artifactPrefix: "contoso",
        eventId: "CONTOSO-SMOKE-008",
        sequence: 8,
        timestamp: "2026-01-01T09:08:00.000Z",
        phaseId: "0",
        eventType: "BLOCKER",
        actor: "AFF-0-coordinator",
        summary: "A late blocker invalidates readiness.",
      })}\n`,
      "utf8",
    );

    await expect(verifyContosoSmokeWorkspace(workspaceRoot)).rejects.toThrow(
      /last Phase 0 gate action|solution-overview/u,
    );
  });

  it("supports the documented retained-output CLI flag", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "aff-contoso-cli-"));
    temporaryDirectories.push(parent);
    const retainedOutput = path.join(parent, "retained");

    const exitCode = await runSmokeCli([
      "node",
      "smoke:contoso",
      "--root",
      repositoryRoot,
      "--keep-output",
      retainedOutput,
    ]);

    expect(exitCode).toBe(0);
    expect(
      await readFile(path.join(retainedOutput, "smoke-report.json"), "utf8"),
    ).toContain("offline contract/smoke harness");
  });
});
