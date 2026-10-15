import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "parse5";

import {
  generateDocumentation,
  renderReadmeRoster,
  renderSiteRoster,
} from "../src/docs/generate.js";
import { readLifecycle } from "../src/framework/lifecycle.js";
import { readHostModelDefaults } from "../src/framework/hosts.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function read(relativePath: string): Promise<string> {
  return readFile(
    path.join(repositoryRoot, ...relativePath.split("/")),
    "utf8",
  );
}

describe("architect adoption and release surfaces", () => {
  it("keeps lifecycle-derived documentation deterministic and current", async () => {
    const lifecycle = await readLifecycle(repositoryRoot);
    const claude = await readHostModelDefaults(repositoryRoot, "claude-code", lifecycle);
    expect(claude.errors).toEqual([]);
    const [readme, site, result] = await Promise.all([
      read("README.md"),
      read("agentic-architecture-v2.html"),
      generateDocumentation(repositoryRoot, true),
    ]);

    expect(result.changedFiles).toEqual([]);
    expect(readme).toContain(renderReadmeRoster(lifecycle, claude.models));
    expect(site).toContain(renderSiteRoster(lifecycle, claude.models));
    expect(readme.match(/BEGIN GENERATED: AFF-LIFECYCLE-ROSTER/gu)).toHaveLength(
      1,
    );
    expect(site.match(/BEGIN GENERATED: AFF-LIFECYCLE-ROSTER/gu)).toHaveLength(1);
  });

  it("derives both host rosters from their supplied defaults", async () => {
    const lifecycle = await readLifecycle(repositoryRoot);
    const claudeModels = new Map(
      [...lifecycle.phases, ...lifecycle.reviewers].map(({ owner }) => [
        owner,
        owner === "AFF-A-rubber-duck" ? "claude-sonnet-5-5" : "claude-opus-5-5",
      ]),
    );
    const readme = renderReadmeRoster(lifecycle, claudeModels);
    const site = renderSiteRoster(lifecycle, claudeModels);
    expect(readme).toContain("Copilot default");
    expect(readme).toContain("Claude default");
    expect(readme).toContain("`gpt-5.4` | `claude-sonnet-5-5`");
    expect(site).toContain("Copilot: gpt-5.4");
    expect(site).toContain("Claude: claude-sonnet-5-5");
    expect(site).toContain("live Claude qualification");
  });

  it("documents one clear offline path and separates optional live actions", async () => {
    const quickStart = await read("docs/quick-start.md");

    for (const command of [
      "npm ci --no-audit --no-fund",
      "npm run validate -- --framework-only",
      "npm run smoke:contoso -- --keep-output .\\.aff-smoke\\contoso-review",
      "Get-Content .\\.aff-smoke\\contoso-review\\smoke-report.json",
      "Invoke-Item .\\.aff-smoke\\contoso-review\\cases\\contoso-permit-services\\solution-overview.html",
    ]) {
      expect(quickStart).toContain(command);
    }
    expect(quickStart).toContain("## 1. Local deterministic evaluation");
    expect(quickStart).toContain("## 2. Optional GitHub Copilot agent trial");
    expect(quickStart).toContain(
      "## 3. Optional human-authorised Azure deployment and testing",
    );
    expect(quickStart).toMatch(/Safe stop point/gu);
    expect(quickStart).toContain(
      "does not call a model, access Azure, deploy anything, or create a real",
    );
  });

  it("provides a safe Claude tester manual directly in the README", async () => {
    const readme = await read("README.md");
    expect(readme).toContain("## Claude Code manual for testers");
    for (const command of [
      "claude --version",
      "claude --agent AFF-0-coordinator",
      "npm run smoke:contoso -- --host claude-code --schema-version 1.1.0",
      "npm run approve -- --case cases\\claude-evaluation --phase 0",
      "npm run validate -- --case cases\\claude-evaluation",
      "Invoke-Item .\\cases\\claude-evaluation\\solution-overview.html",
    ]) {
      expect(readme).toContain(command);
    }
    expect(readme).toContain("No customer data or Azure deployment is needed.");
    expect(readme).toContain("starts live model calls");
    expect(readme).toContain("no agent session running");
    expect(readme).toContain("do not overwrite existing evidence");
    expect(readme).toContain("matching HUMAN-DECISION journal event");
    expect(readme).toContain("Cancellation or an interrupted session never becomes consent.");
  });

  it("keeps compatibility versions aligned with authoritative metadata", async () => {
    const [compatibility, packageJson, packageLock, lifecycle, catalogue] = await Promise.all([
      read("docs/compatibility.md"),
      read("package.json").then((value) => JSON.parse(value) as { version: string }),
      read("package-lock.json").then((value) => JSON.parse(value) as {
        version: string;
        packages: { "": { version: string } };
      }),
      readLifecycle(repositoryRoot),
      read("schemas/aff/catalogue.json").then(
        (value) => JSON.parse(value) as {
          contractVersion: string;
          supportedContractVersions: string[];
        },
      ),
    ]);

    expect(compatibility).toContain(`| AFF lifecycle | \`${lifecycle.version}\``);
    expect(compatibility).toContain(
      `| AFF schema contract | \`${catalogue.contractVersion}\``,
    );
    expect(compatibility).toContain(
      `| Validator/tool package | \`${packageJson.version}\`, private package`,
    );
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages[""].version).toBe(packageJson.version);
    expect(catalogue.supportedContractVersions).toEqual(["1.0.0", "1.1.0"]);
    for (const version of catalogue.supportedContractVersions) {
      expect(compatibility).toContain(`\`${version}\``);
    }
    expect(compatibility).toContain("| Windows |");
    expect(compatibility).toContain("| Linux |");
    expect(compatibility).toContain("| macOS |");
    expect(compatibility).toContain("| GitHub Copilot CLI |");
    expect(compatibility).toContain("| Claude Code |");
    expect(compatibility).toContain("| Azure |");
    expect(compatibility).toContain("A silent fallback is not supported.");
  });

  it("separates offline host compatibility from live qualification", async () => {
    const [compatibility, migration, quickStart, renderer] = await Promise.all([
      read("docs/compatibility.md"),
      read("docs/migrations/1.0.0-to-1.1.0.md"),
      read("docs/quick-start.md"),
      read("docs/aff-renderer.md"),
    ]);

    expect(compatibility).toContain("live behaviour unqualified");
    expect(compatibility).toContain("not a verified support range");
    expect(migration).toContain("No case conversion is required or supported.");
    expect(migration).toContain("Do not edit `schemaVersion`");
    expect(migration).toContain("cannot continue a `1.1.0` case");
    expect(renderer).toContain("does not upgrade source records");
    for (const host of ["github-copilot", "claude-code"]) {
      expect(quickStart).toContain(
        `npm run smoke:contoso -- --host ${host} --schema-version 1.1.0`,
      );
    }
  });

  it("publishes representative evidence without presenting synthetic approval as real", async () => {
    const evidence = await read("docs/examples/contoso-phase-0-evidence.md");
    const hashes = [...evidence.matchAll(/`([0-9a-f]{64})`/gu)].map(
      (match) => match[1],
    );

    expect(hashes).toHaveLength(4);
    expect(new Set(hashes).size).toBe(4);
    expect(evidence).toContain("Synthetic test evidence only.");
    expect(evidence).toContain("not a real human or architecture approval");
    expect(evidence).toContain("`extensions.realApproval`: `false`");
    expect(evidence).toContain("Both final reviewer records");
    expect(evidence).toContain("AFF-1 asks:");
    expect(evidence).toContain("No requirement is baselined");
    expect(evidence).toContain("solution-overview.html");
    expect(evidence).toContain("npm run docs:generate");
  });

  it("keeps the public website self-contained, accessible, and operationally useful", async () => {
    const [site, pagesWorkflow] = await Promise.all([
      read("agentic-architecture-v2.html"),
      read(".github/workflows/pages.yml"),
    ]);
    const parseErrors: string[] = [];
    parse(site, {
      onParseError: (error) => {
        parseErrors.push(error.code);
      },
    });
    const ids = [...site.matchAll(/\bid="([^"]+)"/gu)].map((match) => match[1]);

    expect(parseErrors).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(site).toContain('<html lang="en">');
    expect(site).toContain('http-equiv="Content-Security-Policy"');
    expect(site).toContain("default-src 'none'");
    expect(site).toContain("connect-src 'none'");
    expect(site).toContain('id="evaluate"');
    expect(site).toContain('id="operate"');
    expect(site).toContain("npm run smoke:contoso");
    expect(site).toContain("Safe stop point");
    expect(site).toContain("zero live model calls");
    expect(site).not.toMatch(/<(?:script|img|link)[^>]+(?:src|href)="https?:/iu);
    expect(site).not.toMatch(/\b(?:eval|document\.write|innerHTML)\s*\(/u);
    expect(site.match(/<button\b[^>]*type="button"/gu)?.length ?? 0).toBeGreaterThan(
      4,
    );
    expect(site).toContain('aria-label="Page navigation"');
    expect(site).toContain('aria-labelledby="ringTitle ringDesc"');
    for (const document of [
      "compatibility.md",
      "troubleshooting.md",
      "release-process.md",
      "claude-code.md",
    ]) {
      expect(pagesWorkflow).toContain(`cp docs/${document} _site/docs/${document}`);
    }
  });

  it("defines release and migration gates consistently", async () => {
    const [changelog, release, migrations] = await Promise.all([
      read("CHANGELOG.md"),
      read("docs/release-process.md"),
      read("docs/migrations/README.md"),
    ]);

    expect(changelog).toContain("## [Unreleased]");
    expect(changelog).toContain("## [1.0.0] - 2026-09-04");
    expect(release).toMatch(
      /A changelog entry alone does not create the\s+corresponding GitHub tag or release\./u,
    );
    expect(release).toContain("npm run docs:check");
    expect(release).toContain("Repository validation and CodeQL pass");
    expect(release).toContain("git status --short");
    expect(migrations).toContain(
      "docs/migrations/<from-version>-to-<to-version>.md",
    );
    expect(migrations).toContain("rollback or safe-stop guidance");
  });

  it("documents the remediation upgrade without weakening historical evidence", async () => {
    const [readme, contracts, migration, changelog] = await Promise.all([
      read("README.md"),
      read("docs/aff-contracts.md"),
      read("docs/migrations/tool-1.2.0-to-1.3.0.md"),
      read("CHANGELOG.md"),
    ]);
    expect(readme).toContain("The approval command requires an identity.");
    expect(readme).toContain("AFF does not bundle converters");
    expect(readme).toContain("by construction, not measured host activity");
    expect(contracts).toContain("Historical decisions are used for historical events");
    expect(contracts).toContain("claimed previous fingerprint and reason alone do not");
    expect(contracts).toContain("Do not remove it, make it");
    expect(migration).toContain("Do not migrate or rewrite case files");
    expect(migration).toContain("Lost-key recovery is not automated.");
    expect(changelog).toContain("## [1.3.0]");
  });
});
