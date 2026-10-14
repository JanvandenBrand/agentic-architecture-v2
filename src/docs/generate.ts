import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import writeFileAtomic from "write-file-atomic";

import { isRecord } from "../common/json.js";
import { readLifecycle } from "../framework/lifecycle.js";
import { readHostModelDefaults } from "../framework/hosts.js";
import { runContosoSmoke } from "../smoke/contoso.js";
import type {
  LifecycleManifest,
  LifecyclePhase,
  LifecycleReviewer,
} from "../types.js";

const README_PATH = "README.md";
const SITE_PATH = "agentic-architecture-v2.html";
const CONTOSO_EVIDENCE_PATH = "docs/examples/contoso-phase-0-evidence.md";
const README_MARKER = "AFF-LIFECYCLE-ROSTER";
const SITE_MARKER = "AFF-LIFECYCLE-ROSTER";

export interface DocumentationGenerationResult {
  changedFiles: string[];
}

function markdownMarkers(name: string): [string, string] {
  return [
    `<!-- BEGIN GENERATED: ${name} -->`,
    `<!-- END GENERATED: ${name} -->`,
  ];
}

function replaceGeneratedSection(
  content: string,
  name: string,
  generated: string,
): string {
  const [start, end] = markdownMarkers(name);
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex < 0 || endIndex < startIndex) {
    throw new Error(`Missing generated section markers for ${name}.`);
  }
  const afterEnd = endIndex + end.length;
  return `${content.slice(0, startIndex)}${start}\n${generated.trimEnd()}\n${end}${content.slice(afterEnd)}`;
}

function routeLabel(phase: LifecyclePhase): string {
  if (phase.humanInvocableOnly) {
    return `Optional; human invocation only. Requires: ${(phase.requires ?? []).join(", ")}`;
  }
  return phase.next === null
    ? "Standard route end"
    : `Standard route to Phase ${phase.next}`;
}

function claudeDefault(models: ReadonlyMap<string, string>, owner: string): string {
  const model = models.get(owner);
  if (!model) {
    throw new Error(`Claude default model is missing for ${owner}.`);
  }
  return model;
}

export function renderReadmeRoster(
  lifecycle: LifecycleManifest,
  claudeModels?: ReadonlyMap<string, string>,
): string {
  const claudeCell = (owner: string): string =>
    claudeModels ? ` \`${claudeDefault(claudeModels, owner)}\` |` : "";
  const phaseRows = lifecycle.phases.map(
    (phase) =>
      `| AFF-${phase.id} | \`${phase.owner}\` | ${phase.displayName} | \`${phase.model}\` |${claudeCell(phase.owner)} ${routeLabel(phase)} |`,
  );
  const reviewerRows = lifecycle.reviewers.map(
    (reviewer) =>
      `| ${reviewer.id} | \`${reviewer.owner}\` | ${reviewer.displayName} | \`${reviewer.model}\` |${claudeCell(reviewer.owner)} ${reviewer.mustDifferFromPhaseOwner ? "Independent model required" : "Independent assurance role"} |`,
  );
  return [
    `Lifecycle \`${lifecycle.version}\`; lifecycle-manifest schema \`${lifecycle.schemaVersion}\`. Source: [\`.github/agents/AFF-LIFECYCLE.json\`](.github/agents/AFF-LIFECYCLE.json).`,
    "",
    `| ID | Agent profile | Display name | Copilot default |${claudeModels ? " Claude default |" : ""} Route or gate |`,
    `|---|---|---|---|---|${claudeModels ? "---|" : ""}`,
    ...phaseRows,
    ...reviewerRows,
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function modelLabel(
  agent: { owner: string; model: string },
  claudeModels?: ReadonlyMap<string, string>,
): string {
  return escapeHtml(claudeModels
    ? `Copilot: ${agent.model} | Claude: ${claudeDefault(claudeModels, agent.owner)}`
    : `Copilot: ${agent.model}`);
}

function renderPhaseCard(
  phase: LifecyclePhase,
  claudeModels?: ReadonlyMap<string, string>,
): string {
  const track = phase.humanInvocableOnly ? "optional" : "standard";
  return [
    `          <article class="agent-card" data-track="${track}">`,
    `            <div class="agent-meta"><span class="agent-id">AFF-${escapeHtml(phase.id)}</span><span class="model">${modelLabel(phase, claudeModels)}</span></div>`,
    `            <h3>${escapeHtml(phase.displayName)}</h3>`,
    `            <p><code>${escapeHtml(phase.owner)}</code><br>${escapeHtml(routeLabel(phase))}</p>`,
    "          </article>",
  ].join("\n");
}

function renderReviewerCard(
  reviewer: LifecycleReviewer,
  claudeModels?: ReadonlyMap<string, string>,
): string {
  const gate = reviewer.mustDifferFromPhaseOwner
    ? "Must use a different model from every phase owner."
    : "Independent assurance role; same-model use is permitted by the lifecycle.";
  return [
    '          <article class="agent-card" data-track="review">',
    `            <div class="agent-meta"><span class="agent-id">${escapeHtml(reviewer.id)}</span><span class="model">${modelLabel(reviewer, claudeModels)}</span></div>`,
    `            <h3>${escapeHtml(reviewer.displayName)}</h3>`,
    `            <p><code>${escapeHtml(reviewer.owner)}</code><br>${escapeHtml(gate)}</p>`,
    "          </article>",
  ].join("\n");
}

export function renderSiteRoster(
  lifecycle: LifecycleManifest,
  claudeModels?: ReadonlyMap<string, string>,
): string {
  const standardRoute = lifecycle.standardRoute
    .map((phaseId) => `Phase ${phaseId}`)
    .join(" → ");
  return [
    `        <p class="generated-route"><strong>Manifest route:</strong> ${escapeHtml(standardRoute)}. Phases 7 and 8 remain outside the standard route and require explicit human invocation.</p>`,
    ...(claudeModels
      ? ['        <p>Defaults are read from each host configuration. Offline checks do not prove live Claude qualification.</p>']
      : []),
    '        <div class="roster">',
    ...lifecycle.phases.map((phase) => renderPhaseCard(phase, claudeModels)),
    ...lifecycle.reviewers.map((reviewer) => renderReviewerCard(reviewer, claudeModels)),
    "        </div>",
  ].join("\n");
}

interface Binding {
  path: string;
  sha256: string;
}

function readBindings(value: unknown, field: string): Binding[] {
  if (!isRecord(value) || !Array.isArray(value[field])) {
    throw new Error(`Contoso evidence record is missing ${field}.`);
  }
  return value[field].map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      typeof entry.sha256 !== "string"
    ) {
      throw new Error(`Contoso evidence record contains an invalid ${field} binding.`);
    }
    return { path: entry.path, sha256: entry.sha256 };
  });
}

export async function renderContosoEvidence(
  repositoryRoot: string,
): Promise<string> {
  const retainedOutput = await mkdtemp(path.join(tmpdir(), "aff-doc-evidence-"));
  try {
    const report = await runContosoSmoke({
      repositoryRoot,
      keepOutputPath: retainedOutput,
    });
    const caseRoot = path.join(
      retainedOutput,
      "cases",
      "contoso-permit-services",
    );
    const [approval, affA, affB, opening] = await Promise.all([
      readFile(
        path.join(
          caseRoot,
          "approvals",
          "phase-0",
          "contoso-phase-0-synthetic-approval.json",
        ),
        "utf8",
      ).then((value) => JSON.parse(value) as unknown),
      readFile(
        path.join(
          caseRoot,
          "reviews",
          "aff-a",
          "0",
          "round-1",
          "contoso-aff-a-review.json",
        ),
        "utf8",
      ).then((value) => JSON.parse(value) as unknown),
      readFile(
        path.join(
          caseRoot,
          "reviews",
          "aff-b",
          "0",
          "round-1",
          "contoso-aff-b-review.json",
        ),
        "utf8",
      ).then((value) => JSON.parse(value) as unknown),
      readFile(
        path.join(caseRoot, "input", "smoke-phase-1-opening.json"),
        "utf8",
      ).then((value) => JSON.parse(value) as unknown),
    ]);
    if (
      !isRecord(approval) ||
      !isRecord(affA) ||
      !isRecord(affB) ||
      !isRecord(opening) ||
      typeof approval.approver !== "string" ||
      typeof approval.decision !== "string" ||
      !isRecord(approval.extensions) ||
      !Array.isArray(opening.questionsEmitted) ||
      typeof opening.questionsEmitted[0] !== "string"
    ) {
      throw new Error("Generated Contoso evidence records are malformed.");
    }
    const approvalBindings = readBindings(approval, "artifactHashes");
    const affABindings = readBindings(affA, "subjectArtifacts");
    const affBBindings = readBindings(affB, "subjectArtifacts");
    if (
      JSON.stringify(approvalBindings) !== JSON.stringify(affABindings) ||
      JSON.stringify(affABindings) !== JSON.stringify(affBBindings)
    ) {
      throw new Error("Generated Contoso reviewer and approval bindings differ.");
    }

    const bindingRows = approvalBindings.map(
      ({ path: artifactPath, sha256 }) =>
        `| \`${artifactPath}\` | \`${sha256}\` |`,
    );
    return [
      "# Contoso Phase 0 representative evidence",
      "",
      "> **Synthetic test evidence only.** This snapshot is generated by the offline smoke harness. It is not a real human or architecture approval and contains no customer data.",
      "",
      "## What this demonstrates",
      "",
      "- Phase 0 inventories and hashes the synthetic architecture brief.",
      "- AFF-A and AFF-B review the same unchanged candidate artifacts.",
      "- A deliberately synthetic approval binds to those artifact hashes and both review records.",
      "- The journal exits Phase 0 before AFF-1 opens and asks one question.",
      "- Safe phase HTML and `solution-overview.html` are generated without live model calls or Azure actions.",
      "",
      "## Candidate hash bindings",
      "",
      "| Candidate artifact | SHA-256 |",
      "|---|---|",
      ...bindingRows,
      "",
      "Both final reviewer records and the synthetic approval contain this exact binding set.",
      "",
      "## Synthetic approval boundary",
      "",
      `- Decision field: \`${approval.decision}\``,
      `- Approver label: \`${approval.approver}\``,
      `- \`extensions.syntheticTestEvidence\`: \`${String(approval.extensions.syntheticTestEvidence)}\``,
      `- \`extensions.realApproval\`: \`${String(approval.extensions.realApproval)}\``,
      "",
      "A real case still requires an accountable human to review the final candidate, reviewer convergence, decisions, and residual risks before recording approval.",
      "",
      "## Opening of Phase 1",
      "",
      `AFF-1 asks: “${opening.questionsEmitted[0]}”`,
      "",
      "No requirement is baselined by this harness. The human interview must supply and confirm the answer.",
      "",
      "## Generated rendered outputs",
      "",
      "- `0-coordination/contoso-coordination.html` — self-contained Phase 0 view.",
      "- `solution-overview.html` — journal-derived cumulative view showing synthetic approval and Phase 1 entry.",
      "- `smoke-report.json` — machine-readable evidence of the offline boundary and passed assertions.",
      "",
      `The generation run passed ${report.assertionsPassed} executable assertions, made ${report.liveModelCalls} live model calls, and performed ${report.azureActions} Azure actions.`,
      "",
      "## Regenerate and inspect",
      "",
      "From the repository root in PowerShell:",
      "",
      "```powershell",
      "npm ci --no-audit --no-fund",
      "npm run docs:generate",
      "npm run docs:check",
      "npm run smoke:contoso -- --keep-output .\\.aff-smoke\\contoso-review",
      "Invoke-Item .\\.aff-smoke\\contoso-review\\cases\\contoso-permit-services\\solution-overview.html",
      "```",
      "",
      "The retained workspace is ignored by Git. Delete it when the review is complete:",
      "",
      "```powershell",
      "Remove-Item -Recurse -Force .\\.aff-smoke\\contoso-review",
      "```",
      "",
      "Generator: [`src/docs/generate.ts`](../../src/docs/generate.ts). Synthetic source: [`cases/contoso-permit-services/input/`](../../cases/contoso-permit-services/input/).",
      "",
    ].join("\n");
  } finally {
    await rm(retainedOutput, { recursive: true, force: true });
  }
}

async function updateFile(
  repositoryRoot: string,
  relativePath: string,
  expected: string,
  checkOnly: boolean,
  changedFiles: string[],
): Promise<void> {
  const file = path.join(repositoryRoot, ...relativePath.split("/"));
  let current = "";
  try {
    current = await readFile(file, "utf8");
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  if (current === expected) {
    return;
  }
  changedFiles.push(relativePath);
  if (!checkOnly) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, expected, { encoding: "utf8" });
  }
}

export async function generateDocumentation(
  repositoryRoot: string,
  checkOnly = false,
): Promise<DocumentationGenerationResult> {
  const lifecycle = await readLifecycle(repositoryRoot);
  const claude = existsSync(path.join(repositoryRoot, ".claude"))
    ? await readHostModelDefaults(repositoryRoot, "claude-code", lifecycle)
    : undefined;
  if (claude && claude.errors.length > 0) {
    throw new Error(`Claude defaults cannot be documented: ${claude.errors[0]?.message}`);
  }
  const [readme, site] = await Promise.all([
    readFile(path.join(repositoryRoot, README_PATH), "utf8"),
    readFile(path.join(repositoryRoot, SITE_PATH), "utf8"),
  ]);
  const expectedReadme = replaceGeneratedSection(
    readme,
    README_MARKER,
    renderReadmeRoster(lifecycle, claude?.models),
  );
  const expectedSite = replaceGeneratedSection(
    site,
    SITE_MARKER,
    renderSiteRoster(lifecycle, claude?.models),
  );
  const expectedEvidence = await renderContosoEvidence(repositoryRoot);
  const changedFiles: string[] = [];
  await Promise.all([
    updateFile(
      repositoryRoot,
      README_PATH,
      expectedReadme,
      checkOnly,
      changedFiles,
    ),
    updateFile(
      repositoryRoot,
      SITE_PATH,
      expectedSite,
      checkOnly,
      changedFiles,
    ),
    updateFile(
      repositoryRoot,
      CONTOSO_EVIDENCE_PATH,
      expectedEvidence,
      checkOnly,
      changedFiles,
    ),
  ]);
  changedFiles.sort();
  return { changedFiles };
}
