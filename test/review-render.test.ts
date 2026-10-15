import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { renderReviewHtml, type RenderReviewOptions } from "../src/index.js";
import { validateReviewConvergence } from "../src/case/convergence.js";
import { validateCandidateFileCoverage } from "../src/case/coverage.js";
import { hashArtifact, validateHashBindings } from "../src/case/hash.js";
import { loadCaseRecords } from "../src/case/records.js";
import { runRenderCli } from "../src/render/cli.js";
import { renderPhaseHtml } from "../src/render/index.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaces: string[] = [];
type Json = Record<string, unknown>;

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function changeJson(file: string, mutate: (value: Json) => void): Promise<void> {
  const value: Json = JSON.parse(await readFile(file, "utf8"));
  mutate(value);
  await writeJson(file, value);
}

async function createReview(
  reviewer: "AFF-A" | "AFF-B" = "AFF-A",
  schemaVersion = "1.0.0",
  phaseId = "0",
  host = "github-copilot",
): Promise<{ options: RenderReviewOptions; caseRoot: string; planPath: string }> {
  const repositoryRoot = await mkdtemp(path.join(projectRoot, ".review-render-test-"));
  workspaces.push(repositoryRoot);
  await cp(path.join(projectRoot, "schemas"), path.join(repositoryRoot, "schemas"), { recursive: true });
  await cp(path.join(projectRoot, ".github", "agents"), path.join(repositoryRoot, ".github", "agents"), { recursive: true });
  if (host === "claude-code") {
    await cp(path.join(projectRoot, ".claude"), path.join(repositoryRoot, ".claude"), { recursive: true });
    await cp(path.join(projectRoot, ".github", "skills"), path.join(repositoryRoot, ".github", "skills"), { recursive: true });
    await cp(path.join(projectRoot, "CLAUDE.md"), path.join(repositoryRoot, "CLAUDE.md"));
    await cp(path.join(projectRoot, ".mcp.json"), path.join(repositoryRoot, ".mcp.json"));
  }
  const caseRoot = path.join(repositoryRoot, "cases", "sample");
  await mkdir(path.join(caseRoot, "0-coordination"), { recursive: true });
  const modelPlan: Json = JSON.parse(await readFile(path.join(
    projectRoot, "test", "fixtures", "cases", "valid-case", "0-coordination", "sample-model-plan.json",
  ), "utf8"));
  modelPlan.schemaVersion = schemaVersion;
  modelPlan.caseName = "sample";
  if (schemaVersion === "1.1.0") {
    modelPlan.host = host;
  }
  if (host === "claude-code") {
    for (const assignment of modelPlan.assignments as Json[]) {
      assignment.model = assignment.agent === "AFF-A-rubber-duck" ? "claude-sonnet-5-5" : "claude-opus-5-5";
    }
  }
  const planPath = path.join(caseRoot, "0-coordination", "sample-model-plan.json");
  await writeJson(planPath, modelPlan);
  await writeFile(path.join(caseRoot, "0-coordination", "sample-coordination.md"), "# Candidate\n\nSynthetic evidence.\n");
  const basename = `reviews/${reviewer.toLowerCase()}/${phaseId}/round-1/sample-${reviewer.toLowerCase()}-review`;
  await mkdir(path.dirname(path.join(caseRoot, basename)), { recursive: true });
  const options: RenderReviewOptions = {
    repositoryRoot,
    casePath: path.join("cases", "sample"),
    phaseId,
    reviewer,
    round: 1,
    sourcePath: `${basename}.md`,
    metadataPath: `${basename}.json`,
    outputPath: `${basename}.html`,
  };
  await writeFile(path.join(caseRoot, options.sourcePath), "# Review\n\n## Findings\n\nSynthetic review.\n");
  const review: Json = JSON.parse(await readFile(path.join(
    projectRoot, "test", "fixtures", "cases", "valid-case", "reviews", "aff-a", "0", "round-1", "sample-aff-a-review.json",
  ), "utf8"));
  Object.assign(review, {
    schemaVersion, caseName: "sample", reviewer, phaseId, final: false, verdict: "DIVERGES",
    model: host === "claude-code"
      ? reviewer === "AFF-A" ? "claude-sonnet-5-5" : "claude-opus-5-5"
      : reviewer === "AFF-A" ? "gpt-5.4" : "gpt-5.6-sol",
    subjectArtifacts: [{
      path: "0-coordination/sample-coordination.md",
      sha256: await hashArtifact(path.join(caseRoot, "0-coordination", "sample-coordination.md")),
    }],
  });
  await writeJson(path.join(caseRoot, options.metadataPath), review);
  return { options, caseRoot, planPath };
}

function reviewArguments(options: RenderReviewOptions): string[] {
  return [
    "node", "aff-render", "review", "--root", options.repositoryRoot,
    "--case", options.casePath, "--phase", options.phaseId,
    "--reviewer", options.reviewer, "--round", String(options.round),
    "--source", options.sourcePath, "--metadata", options.metadataPath, "--output", options.outputPath,
  ];
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(workspaces.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("review HTML rendering", () => {
  it.each([
    ["AFF-A", "1.0.0", "github-copilot"],
    ["AFF-B", "1.0.0", "github-copilot"],
    ["AFF-A", "1.1.0", "github-copilot"],
    ["AFF-B", "1.1.0", "github-copilot"],
    ["AFF-A", "1.1.0", "claude-code"],
    ["AFF-B", "1.1.0", "claude-code"],
  ] as const)("renders %s contract %s on %s before convergence/approval without changing sources", async (reviewer, version, host) => {
    const { options, caseRoot, planPath } = await createReview(reviewer, version, "0", host);
    const files = [path.join(caseRoot, options.sourcePath), path.join(caseRoot, options.metadataPath), planPath];
    const before = await Promise.all(files.map((file) => readFile(file)));
    const hashes = await Promise.all(files.map((file) => hashArtifact(file)));
    await renderReviewHtml(options);
    const html = await readFile(path.join(caseRoot, options.outputPath), "utf8");
    expect(html).toContain("Reviewer verdict: DIVERGES. Final: no.");
    expect(html).toContain("not human approval or proof of reviewer convergence");
    expect(html).toContain("script-src 'none'");
    expect(html).toContain('id="phase-0-findings"');
    expect(html).toContain("Authoritative structured review record");
    for (const hash of hashes) {
      expect(html).toContain(hash);
    }
    await renderReviewHtml(options);
    expect(await readFile(path.join(caseRoot, options.outputPath), "utf8")).toBe(html);
    expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(before);
  });

  it.each([
    ["phaseId", "1"],
    ["reviewer", "AFF-B"],
    ["round", 2],
    ["caseName", "other"],
    ["artifactPrefix", "other"],
    ["model", "gpt-5.6-sol"],
    ["recordType", "input-inventory"],
    ["schemaVersion", "1.1.0"],
  ])("rejects inconsistent review %s", async (field, value) => {
    const { options, caseRoot } = await createReview();
    await changeJson(path.join(caseRoot, options.metadataPath), (record) => { record[String(field)] = value; });
    await expect(renderReviewHtml(options)).rejects.toThrow();
    await expect(readFile(path.join(caseRoot, options.outputPath))).rejects.toThrow();
  });

  it("rejects a review that disagrees with the case's other identity anchor", async () => {
    const { options, caseRoot } = await createReview();
    await writeJson(path.join(caseRoot, "0-coordination", "other-input-inventory.json"), {
      schemaVersion: "1.0.0", recordType: "input-inventory", caseName: "sample",
      artifactPrefix: "other", sources: [{
        sourcePath: "0-coordination/sample-coordination.md",
        governedArtifact: {
          path: "0-coordination/sample-coordination.md",
          sha256: await hashArtifact(path.join(caseRoot, "0-coordination", "sample-coordination.md")),
        },
        readable: true,
      }],
    });
    await expect(renderReviewHtml(options)).rejects.toThrow(/artifactPrefix is ambiguous/u);
  });

  it("rejects unavailable or unapproved active models", async () => {
    const { options, planPath } = await createReview("AFF-A", "1.1.0");
    await changeJson(planPath, (plan) => {
      (plan.assignments as Json[])[0]!.available = false;
    });
    await expect(renderReviewHtml(options)).rejects.toThrow(/unavailable/u);
    await changeJson(planPath, (plan) => {
      (plan.assignments as Json[])[0]!.available = true;
      (plan.assignments as Json[])[0]!.model = "gpt-other";
    });
    await expect(renderReviewHtml(options)).rejects.toThrow(/without human approval/u);
  });

  it("requires the canonical model plan but not an approval or journal", async () => {
    const { options, planPath } = await createReview();
    await rm(planPath);
    await expect(renderReviewHtml(options)).rejects.toThrow(/does not exist/u);
  });

  it.each(["{broken", Buffer.from([0xff])])("rejects malformed review metadata", async (content) => {
    const { options, caseRoot } = await createReview();
    await writeFile(path.join(caseRoot, options.metadataPath), content);
    await expect(renderReviewHtml(options)).rejects.toThrow();
    await expect(readFile(path.join(caseRoot, options.outputPath))).rejects.toThrow();
  });

  it.each([
    ["sourcePath", "..\\outside.md"],
    ["metadataPath", "..\\outside.json"],
    ["outputPath", "..\\outside.html"],
    ["sourcePath", "reviews/aff-a/0/round-1/other-aff-a-review.md"],
    ["metadataPath", "0-coordination/sample-model-plan.json"],
    ["outputPath", "0-coordination/sample-coordination.html"],
    ["outputPath", "reviews/aff-a/0/round-1/sample-aff-a-other.html"],
    ["phaseId", "1"],
    ["round", 2],
    ["casePath", "..\\sample"],
  ])("rejects unsafe or mismatched option %s=%s", async (field, value) => {
    const { options } = await createReview();
    await expect(renderReviewHtml({ ...options, [field]: value })).rejects.toThrow();
  });

  it("rejects stale subject hashes and circular review HTML bindings", async () => {
    const { options, caseRoot } = await createReview();
    const metadata = path.join(caseRoot, options.metadataPath);
    await changeJson(metadata, (record) => {
      (record.subjectArtifacts as Json[])[0]!.sha256 = "0".repeat(64);
    });
    await expect(renderReviewHtml(options)).rejects.toThrow(/hash/u);
    await changeJson(metadata, (record) => {
      (record.subjectArtifacts as Json[])[0]!.path = options.outputPath;
    });
    await expect(renderReviewHtml(options)).rejects.toThrow(/cannot bind its own/u);
  });

  it.each([
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "[unsafe](javascript:alert(1))",
    "[unsafe](data:text/html,evil)",
    "[escape](../../../../../../outside.md)",
    "![remote](https://example.com/remote.png)",
    "![unsafe](bad.svg)",
  ])("fails closed for unsafe review Markdown: %s", async (payload) => {
    const { options, caseRoot } = await createReview();
    await writeFile(path.join(caseRoot, options.sourcePath), `# Review\n\n${payload}\n`);
    await writeFile(path.join(caseRoot, path.dirname(options.sourcePath), "bad.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await expect(renderReviewHtml(options)).rejects.toThrow();
    await expect(readFile(path.join(caseRoot, options.outputPath))).rejects.toThrow();
  });

  it("escapes untrusted structured review fields rather than executing HTML", async () => {
    const { options, caseRoot } = await createReview();
    await changeJson(path.join(caseRoot, options.metadataPath), (record) => {
      record.rationale = "<script>alert(1)</script>";
    });
    await renderReviewHtml(options);
    const html = await readFile(path.join(caseRoot, options.outputPath), "utf8");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("uses safe local SVG, relative links and escaped Mermaid with the visual fail-closed switch", async () => {
    const { options, caseRoot } = await createReview();
    const reviewRoot = path.join(caseRoot, path.dirname(options.sourcePath));
    await writeFile(path.join(reviewRoot, "diagram.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    await writeFile(path.join(caseRoot, options.sourcePath),
      "# Review\n\n[Findings](#findings)\n\n## Findings\n\n" +
      "[Candidate](../../../../0-coordination/sample-coordination.md)\n\n" +
      "![Reviewed rectangle](diagram.svg)\n\n```mermaid\nflowchart LR\nA-->B\n```\n");
    await renderReviewHtml(options);
    const html = await readFile(path.join(caseRoot, options.outputPath), "utf8");
    expect(html).toContain('href="#phase-0-findings"');
    expect(html).toContain('href="../../../../0-coordination/sample-coordination.md"');
    expect(html).toContain("data:image/svg+xml;base64,");
    expect(html).toContain("Diagram shown as escaped Mermaid source");
    await expect(renderReviewHtml({ ...options, requireVisualDiagrams: true })).rejects.toThrow(/Visual Mermaid/u);
    expect(await readFile(path.join(caseRoot, options.outputPath), "utf8")).toBe(html);
  });

  it("enforces Markdown/metadata byte and UTF-8 limits without overwriting existing output", async () => {
    const { options, caseRoot } = await createReview();
    const source = path.join(caseRoot, options.sourcePath);
    const output = path.join(caseRoot, options.outputPath);
    await writeFile(output, "prior evidence");
    await writeFile(source, `# Review\n${"x".repeat(1_048_576)}`);
    await expect(renderReviewHtml(options)).rejects.toThrow(/byte limit/u);
    await writeFile(source, Buffer.from([0xff, 0xfe]));
    await expect(renderReviewHtml(options)).rejects.toThrow(/UTF-8/u);
    await writeFile(source, "# Review\n");
    await writeFile(path.join(caseRoot, options.metadataPath), " ".repeat(524_289));
    await expect(renderReviewHtml(options)).rejects.toThrow(/byte limit/u);
    expect(await readFile(output, "utf8")).toBe("prior evidence");
  });

  it("rejects a review directory junction escaping the physical case", async () => {
    const { options, caseRoot } = await createReview();
    const directory = path.join(caseRoot, path.dirname(options.sourcePath));
    const outside = path.join(options.repositoryRoot, "outside");
    await cp(directory, outside, { recursive: true });
    await rm(directory, { recursive: true });
    await symlink(outside, directory, process.platform === "win32" ? "junction" : "dir");
    await expect(renderReviewHtml(options)).rejects.toThrow(/outside the case/u);
  });

  it("does not relax phase renderer paths to accommodate reviews", async () => {
    const { options, caseRoot } = await createReview();
    await expect(renderPhaseHtml({
      caseRoot, phaseId: options.phaseId, sourcePath: options.sourcePath,
      outputPath: options.outputPath, metadataPaths: [options.metadataPath],
    })).rejects.toThrow(/lifecycle folder/u);
  });

  it("CLI renders reviews and reports invalid rounds and unsafe sources", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { options, caseRoot } = await createReview();
    expect(await runRenderCli(reviewArguments(options))).toBe(0);
    expect(await readFile(path.join(caseRoot, options.outputPath), "utf8")).toContain("AFF-A");
    expect(await runRenderCli(reviewArguments({ ...options, round: 0 }))).toBe(1);
    await writeFile(path.join(caseRoot, options.sourcePath), "# Review\n\n<script>bad()</script>");
    expect(await runRenderCli(reviewArguments(options))).toBe(1);
  });
});

describe("phase metadata and AFF-0 handoff", () => {
  it.each(["1.0.0", "1.1.0"])("completes Phase 1 rendering and both reviews on %s without live agents or human approval", async (schemaVersion) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { options, caseRoot } = await createReview("AFF-A", schemaVersion, "1");
    const phaseRoot = path.join(caseRoot, "1-requirements");
    await mkdir(phaseRoot);
    const common = { schemaVersion, caseName: "sample", artifactPrefix: "sample" };
    await writeFile(path.join(phaseRoot, "sample-requirements.md"), "# Requirements\n\nSynthetic handoff test.\n");
    await writeJson(path.join(phaseRoot, "sample-requirements-catalogue.json"), {
      ...common, recordType: "requirements-catalogue", revision: "1", requirements: [],
    });
    await writeJson(path.join(phaseRoot, "sample-interview-decisions.json"), {
      ...common, recordType: "interview-decisions", goal: "Synthetic rendering handoff",
      confidence: {
        ...Object.fromEntries(["business", "data", "application", "technology", "security"]
          .map((domain) => [domain, { score: 100, rationale: "Synthetic test only." }])),
        overall: 100,
      },
      decisions: [], assumptions: [], nonScope: [], openItems: [],
      humanConfirmation: { confirmedBy: "Synthetic test actor", confirmedAt: "2026-01-01T09:00:00Z" },
      extensions: { syntheticTestEvidence: true },
    });
    await writeJson(path.join(phaseRoot, "package.json"), { name: "application-evidence" });
    await writeJson(path.join(phaseRoot, "domain.json"), { recordType: "domain-event", value: 3 });
    const phaseOptions = {
      caseRoot, phaseId: "1", sourcePath: "1-requirements/sample-requirements.md",
      outputPath: "1-requirements/sample-requirements.html", metadataPaths: [],
    };
    expect(await runRenderCli([
      "node", "aff-render", "phase", "--root", options.repositoryRoot, "--case", options.casePath,
      "--phase", "1", "--source", phaseOptions.sourcePath, "--output", phaseOptions.outputPath,
    ])).toBe(0);
    const phaseHtml = await readFile(path.join(caseRoot, phaseOptions.outputPath), "utf8");
    expect(phaseHtml).toContain("sample-requirements-catalogue.json");
    expect(phaseHtml).not.toContain("sample-model-plan.json");
    expect(phaseHtml).not.toContain("package.json");
    await expect(renderPhaseHtml({
      ...phaseOptions, metadataPaths: ["1-requirements/package.json"],
    })).rejects.toThrow(/recordType/u);
    await expect(renderPhaseHtml({
      ...phaseOptions, metadataPaths: ["1-requirements/domain.json"],
    })).rejects.toThrow(/schemaVersion/u);
    const candidatePaths = [
      phaseOptions.sourcePath, phaseOptions.outputPath,
      "1-requirements/sample-requirements-catalogue.json",
      "1-requirements/sample-interview-decisions.json",
      "1-requirements/package.json", "1-requirements/domain.json",
    ];
    const artifactHashes = await Promise.all(candidatePaths.map(async (file) => ({
      path: file, sha256: await hashArtifact(path.join(caseRoot, file)),
    })));
    const journal = {
      ...common, recordType: "run-journal-event", eventId: "EVT-001", sequence: 1,
      ...(schemaVersion === "1.1.0" ? { host: "github-copilot" } : {}),
      timestamp: "2026-01-01T09:50:00Z", phaseId: "1", eventType: "ARTIFACTS-RECORDED",
      actor: "AFF-0-coordinator", summary: "Synthetic complete Phase 1 candidate.", artifactHashes,
    };
    await writeFile(path.join(caseRoot, "sample-run-journal.jsonl"), `${JSON.stringify(journal)}\n`);
    await changeJson(path.join(caseRoot, options.metadataPath), (record) => {
      Object.assign(record, { final: true, verdict: "CONFORMS", subjectArtifacts: artifactHashes });
    });
    const affBOptions = {
      ...options, reviewer: "AFF-B" as const,
      sourcePath: options.sourcePath.replaceAll("aff-a", "aff-b"),
      metadataPath: options.metadataPath.replaceAll("aff-a", "aff-b"),
      outputPath: options.outputPath.replaceAll("aff-a", "aff-b"),
    };
    await mkdir(path.dirname(path.join(caseRoot, affBOptions.sourcePath)), { recursive: true });
    await cp(path.join(caseRoot, options.sourcePath), path.join(caseRoot, affBOptions.sourcePath));
    await cp(path.join(caseRoot, options.metadataPath), path.join(caseRoot, affBOptions.metadataPath));
    await changeJson(path.join(caseRoot, affBOptions.metadataPath), (record) => {
      record.reviewer = "AFF-B";
      record.model = "gpt-5.6-sol";
    });
    const sourceFiles = [options.sourcePath, options.metadataPath, affBOptions.sourcePath, affBOptions.metadataPath];
    const before = await Promise.all(sourceFiles.map((file) => hashArtifact(path.join(caseRoot, file))));
    expect(await runRenderCli(reviewArguments(options))).toBe(0);
    expect(await runRenderCli(reviewArguments(affBOptions))).toBe(0);
    expect(await Promise.all(sourceFiles.map((file) => hashArtifact(path.join(caseRoot, file))))).toEqual(before);
    const loaded = await loadCaseRecords(options.repositoryRoot, caseRoot);
    expect(loaded.errors).toEqual([]);
    expect(validateReviewConvergence(loaded.records)).toEqual([]);
    expect(await validateHashBindings(caseRoot, loaded.records)).toEqual([]);
    expect(await validateCandidateFileCoverage(caseRoot, loaded.records)).toEqual([]);
    await writeJson(path.join(phaseRoot, "domain.json"), { recordType: "domain-event", value: 4 });
    await expect(renderReviewHtml(options)).rejects.toThrow(/hash/u);
  });
});
