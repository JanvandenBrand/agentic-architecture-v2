import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import fg from "fast-glob";
import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import { validateFramework } from "../src/index.js";
import { parseProfile } from "../src/framework/frontmatter.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const securityAdvisoryUrl =
  "https://github.com/aramsmith/agentic-architecture-v2/security/advisories/new";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(repositoryRoot, file), "utf8"));
}

async function readYaml(file: string): Promise<unknown> {
  const document = parseDocument(
    await readFile(path.join(repositoryRoot, file), "utf8"),
    { prettyErrors: false },
  );
  expect(document.errors, `${file} must contain valid YAML`).toEqual([]);
  return document.toJS();
}

describe("repository governance", () => {
  it("keeps the public community contract and package licence metadata complete", async () => {
    const requiredFiles = [
      "LICENSE",
      "SECURITY.md",
      "CONTRIBUTING.md",
      "CODE_OF_CONDUCT.md",
      "SUPPORT.md",
      ".github/CODEOWNERS",
      ".github/pull_request_template.md",
    ];

    for (const file of requiredFiles) {
      expect(
        (await stat(path.join(repositoryRoot, file))).size,
        `${file} must be non-empty`,
      ).toBeGreaterThan(0);
    }

    const packageJson = await readJson("package.json");
    const packageLock = await readJson("package-lock.json");
    expect(isRecord(packageJson) && packageJson.license).toBe("Apache-2.0");
    expect(
      isRecord(packageLock) &&
        isRecord(packageLock.packages) &&
        isRecord(packageLock.packages[""]) &&
        packageLock.packages[""].license,
    ).toBe("Apache-2.0");
    expect(await readFile(path.join(repositoryRoot, "LICENSE"), "utf8")).toMatch(
      /Apache License\s+Version 2\.0/u,
    );
  });

  it("keeps issue forms structured and routes security reports privately", async () => {
    const config = await readYaml(".github/ISSUE_TEMPLATE/config.yml");
    expect(isRecord(config)).toBe(true);
    if (!isRecord(config)) {
      return;
    }

    expect(config.blank_issues_enabled).toBe(false);
    expect(config.contact_links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: securityAdvisoryUrl }),
      ]),
    );

    const formFiles = await fg(".github/ISSUE_TEMPLATE/*.yml", {
      cwd: repositoryRoot,
      onlyFiles: true,
      ignore: [".github/ISSUE_TEMPLATE/config.yml"],
    });
    expect(formFiles.sort()).toEqual([
      ".github/ISSUE_TEMPLATE/bug.yml",
      ".github/ISSUE_TEMPLATE/documentation.yml",
      ".github/ISSUE_TEMPLATE/framework-proposal.yml",
    ]);

    for (const file of formFiles) {
      const form = await readYaml(file);
      expect(isRecord(form), `${file} must be a YAML mapping`).toBe(true);
      if (!isRecord(form)) {
        continue;
      }

      expect(typeof form.name).toBe("string");
      expect(typeof form.description).toBe("string");
      expect(Array.isArray(form.body)).toBe(true);
      if (!Array.isArray(form.body)) {
        continue;
      }

      const ids = form.body.flatMap((item) =>
        isRecord(item) && typeof item.id === "string" ? [item.id] : [],
      );
      expect(new Set(ids).size, `${file} field IDs must be unique`).toBe(
        ids.length,
      );
      expect(ids.length, `${file} must collect structured fields`).toBeGreaterThan(
        0,
      );

      const serialized = JSON.stringify(form);
      expect(serialized).toContain(securityAdvisoryUrl);
      expect(serialized).toMatch(/security vulnerability requiring private disclosure/u);

      const requiredFields = form.body.filter(
        (item) =>
          isRecord(item) &&
          isRecord(item.validations) &&
          item.validations.required === true,
      );
      expect(
        requiredFields.length,
        `${file} must require actionable report data`,
      ).toBeGreaterThan(0);
    }
  });

  it("keeps all relative Markdown links inside the repository resolvable", async () => {
    const markdown = new MarkdownIt({ html: false, linkify: false });
    const files = await fg("**/*.md", {
      cwd: repositoryRoot,
      onlyFiles: true,
      ignore: ["node_modules/**", "dist/**", ".aff-smoke/**"],
    });
    const failures: string[] = [];

    for (const file of files) {
      const content = await readFile(path.join(repositoryRoot, file), "utf8");
      const tokens = markdown.parse(content, {});
      for (const token of tokens) {
        if (token.type !== "link_open") {
          continue;
        }
        const href = token.attrGet("href");
        if (
          !href ||
          href.startsWith("#") ||
          href.startsWith("//") ||
          /^[a-z][a-z0-9+.-]*:/iu.test(href)
        ) {
          continue;
        }

        const reference = decodeURIComponent(href.split(/[?#]/u)[0] ?? "");
        if (reference === "") {
          continue;
        }
        const target = reference.startsWith("/")
          ? path.resolve(repositoryRoot, `.${reference}`)
          : path.resolve(repositoryRoot, path.dirname(file), reference);
        const relativeTarget = path.relative(repositoryRoot, target);
        if (
          relativeTarget.startsWith("..") ||
          path.isAbsolute(relativeTarget)
        ) {
          failures.push(`${file}: ${href} escapes the repository`);
          continue;
        }

        try {
          await access(target);
        } catch {
          failures.push(`${file}: ${href} does not exist`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps CODEOWNERS syntax and critical-surface coverage fail closed", async () => {
    const content = await readFile(
      path.join(repositoryRoot, ".github", "CODEOWNERS"),
      "utf8",
    );
    const entries = content
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => line.split(/\s+/u));
    const patterns = new Set(entries.map(([pattern]) => pattern));

    for (const entry of entries) {
      expect(entry.length, `Invalid CODEOWNERS entry: ${entry.join(" ")}`).toBeGreaterThan(
        1,
      );
      expect(entry.slice(1).every((owner) => owner?.startsWith("@"))).toBe(true);
    }

    for (const pattern of [
      "/LICENSE",
      "/SECURITY.md",
      "/CONTRIBUTING.md",
      "/CODE_OF_CONDUCT.md",
      "/SUPPORT.md",
      "/README.md",
      "/agentic-architecture-v2.html",
      "/.github/CODEOWNERS",
      "/.github/dependabot.yml",
      "/.github/ISSUE_TEMPLATE/",
      "/.github/pull_request_template.md",
      "/.github/agents/",
      "/.github/skills/",
      "/.claude/",
      "/CLAUDE.md",
      "/.mcp.json",
      "/.github/workflows/",
      "/schemas/",
      "/package.json",
      "/package-lock.json",
      "/tsconfig.json",
      "/vitest.config.ts",
      "/src/",
      "/test/",
      "/cases/_template/",
      "/cases/contoso-permit-services/",
    ]) {
      expect(patterns, `${pattern} must have a CODEOWNER`).toContain(pattern);
    }
  });

  it("keeps workflow YAML pinned, bounded, and least privilege", async () => {
    const workflowFiles = await fg(".github/workflows/*.yml", {
      cwd: repositoryRoot,
      onlyFiles: true,
    });

    for (const file of workflowFiles) {
      const workflow = await readFile(path.join(repositoryRoot, file), "utf8");
      await readYaml(file);
      const uses = [
        ...workflow.matchAll(/^\s*uses:\s*(\S+)(?:\s+#\s*(.+?))?\s*$/gmu),
      ];
      for (const match of uses) {
        expect(
          match[1],
          `${file} action references must use a full commit SHA`,
        ).toMatch(/^[^@\s]+@[0-9a-f]{40}$/u);
        expect(match[2], `${file} action pins need a readable version comment`).toMatch(
          /^v\d/u,
        );
      }
      expect(workflow, `${file} must declare permissions`).toMatch(
        /^permissions:\s*$/mu,
      );
      expect(workflow, `${file} must declare concurrency`).toMatch(
        /^concurrency:\s*$/mu,
      );
      expect(workflow, `${file} jobs must have explicit timeouts`).toMatch(
        /^\s+timeout-minutes:\s*\d+\s*$/mu,
      );
    }
  });

  it("keeps Dependabot limited to maintained repository ecosystems", async () => {
    const dependabot = await readYaml(".github/dependabot.yml");
    expect(isRecord(dependabot) && dependabot.version).toBe(2);
    expect(isRecord(dependabot) && Array.isArray(dependabot.updates)).toBe(true);
    if (!isRecord(dependabot) || !Array.isArray(dependabot.updates)) {
      return;
    }

    const ecosystems = dependabot.updates.flatMap((update) =>
      isRecord(update) && typeof update["package-ecosystem"] === "string"
        ? [update["package-ecosystem"]]
        : [],
    );
    expect(ecosystems.sort()).toEqual(["github-actions", "npm"]);
  });

  it("runs every test on Windows and Ubuntu behind the stable validation check", async () => {
    const workflow = await readYaml(".github/workflows/validate.yml");
    if (!isRecord(workflow) || !isRecord(workflow.jobs)) {
      throw new Error("Repository validation must declare jobs.");
    }
    const checks = workflow.jobs.checks;
    const gate = workflow.jobs.validate;
    if (
      !isRecord(checks) ||
      !isRecord(checks.strategy) ||
      !isRecord(checks.strategy.matrix) ||
      !Array.isArray(checks.steps) ||
      !isRecord(gate) ||
      !Array.isArray(gate.steps)
    ) {
      throw new Error("Repository validation needs a platform matrix and aggregate gate.");
    }

    expect(checks.strategy.matrix.os).toEqual(["ubuntu-latest", "windows-latest"]);
    expect(checks.strategy["fail-fast"]).toBe(false);
    expect(checks["runs-on"]).toBe("${{ matrix.os }}");
    const commands = checks.steps.flatMap((step) =>
      isRecord(step) && typeof step.run === "string" ? [step.run] : [],
    );
    expect(commands).toEqual(expect.arrayContaining([
      "npm test",
      "npm run docs:check",
      "npm run typecheck",
      "npm run build",
      "npm run validate -- --framework-only",
      "npm run smoke:contoso",
      "npm run smoke:contoso -- --host github-copilot --schema-version 1.1.0",
      "npm run smoke:contoso -- --host claude-code --schema-version 1.1.0",
    ]));
    expect(gate.name).toBe("Repository validation");
    expect(gate.needs).toBe("checks");
    expect(gate.if).toBe("always()");
    expect(gate.steps).toContainEqual(expect.objectContaining({
      env: { CHECKS_RESULT: "${{ needs.checks.result }}" },
      run: 'test "$CHECKS_RESULT" = success',
    }));
  });

  it("keeps lifecycle, profiles, skills, and AFF safety boundaries synchronised", async () => {
    const lifecycle = await readJson(".github/agents/AFF-LIFECYCLE.json");
    expect(isRecord(lifecycle)).toBe(true);
    if (!isRecord(lifecycle)) {
      return;
    }

    const owners = [
      ...(Array.isArray(lifecycle.phases) ? lifecycle.phases : []),
      ...(Array.isArray(lifecycle.reviewers) ? lifecycle.reviewers : []),
    ];
    for (const owner of owners) {
      expect(isRecord(owner)).toBe(true);
      if (
        !isRecord(owner) ||
        typeof owner.owner !== "string" ||
        typeof owner.model !== "string"
      ) {
        continue;
      }
      const file = `.github/agents/${owner.owner}.agent.md`;
      const profile = await parseProfile(
        path.join(repositoryRoot, file),
        file,
        "agent",
      );
      expect(profile.errors).toEqual([]);
      expect(profile.frontmatter?.model).toBe(owner.model);
    }

    const skillFiles = await fg(".github/skills/*/SKILL.md", {
      cwd: repositoryRoot,
      onlyFiles: true,
    });
    const agentContract = (
      await Promise.all(
        [
          ".github/agents/AFF-OPERATING-CONTRACT.md",
          ...(await fg(".github/agents/*.agent.md", {
            cwd: repositoryRoot,
            onlyFiles: true,
          })),
        ].map((file) => readFile(path.join(repositoryRoot, file), "utf8")),
      )
    ).join("\n");

    for (const file of skillFiles) {
      const profile = await parseProfile(
        path.join(repositoryRoot, file),
        file,
        "skill",
      );
      expect(profile.errors).toEqual([]);
      expect(profile.frontmatter?.name).toBe(
        path.posix.basename(path.posix.dirname(file)),
      );
      expect(agentContract).toContain(file);
    }

    expect(lifecycle.reviewOrder).toEqual(
      expect.arrayContaining([
        "AFF-A-and-AFF-B-same-hash-convergence",
        "human-approval",
      ]),
    );
    expect(Array.isArray(lifecycle.reviewOrder)).toBe(true);
    if (Array.isArray(lifecycle.reviewOrder)) {
      expect(lifecycle.reviewOrder.at(-1)).toBe("human-approval");
    }
    expect(lifecycle.executionRules).toEqual(
      expect.objectContaining({
        githubOidcAllowed: false,
        storedCredentialsAllowed: false,
        phase5DeploymentAllowed: false,
        databasePublicAccessAllowed: false,
        environmentCodeForksAllowed: false,
      }),
    );

    const phases = Array.isArray(lifecycle.phases) ? lifecycle.phases : [];
    for (const phaseId of ["7", "8"]) {
      expect(phases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: phaseId,
            humanInvocableOnly: true,
          }),
        ]),
      );
    }

    const expectations = await readJson(
      "cases/contoso-permit-services/input/phase-0-test-expectations.json",
    );
    expect(expectations).toEqual(
      expect.objectContaining({
        mustHold: expect.arrayContaining([
          "The human approval is the last Phase 0 gate action",
          "Phase 7 cannot start automatically",
          "Phase 8 cannot start without an approved successful Phase 7 deployment",
        ]),
        mustNotOccur: expect.arrayContaining([
          "Azure deployment",
          "Live runtime testing",
          "Stored credentials",
          "GitHub OIDC",
          "Automatic human approval",
        ]),
      }),
    );

    expect((await validateFramework(repositoryRoot)).errors).toEqual([]);
  });

  it("keeps shared host policy and interview authority explicit", async () => {
    const [contract, coordinator, requirements, claude] = await Promise.all(
      [
        ".github/agents/AFF-OPERATING-CONTRACT.md",
        ".github/agents/AFF-0-coordinator.agent.md",
        ".github/agents/AFF-1-requirements.agent.md",
        "CLAUDE.md",
      ].map(async (file) =>
        (await readFile(path.join(repositoryRoot, file), "utf8"))
          .replace(/\s+/gu, " "),
      ),
    );
    expect(contract).toContain("New cases use AFF contract version `1.1.0`");
    expect(contract).toContain("existing `1.0.0` cases retain their version");
    expect(contract).toContain("Never migrate, normalise, re-sign, or rewrite existing case evidence.");
    expect(contract).toContain("The first journal event establishes the host");
    expect(contract).toContain("A substitution requires an explicit human decision and `approvalReference`");
    expect(contract).toContain("different model from every phase owner");
    expect(contract).toContain("Model-generated self-identification is not attestation.");
    expect(contract).toContain("execution remains blocked");
    expect(contract).not.toContain("All agents use GPT models");
    expect(coordinator).toContain("Return the exact human answer and decision ID to AFF-1");
    expect(coordinator).toContain("Only AFF-1 updates `interview-decisions` and chooses the next question");
    expect(requirements).toContain("decisions[].question");
    expect(requirements).toContain("decisions[].answer");
    expect(requirements).toContain("Append corrections to `corrections` without rewriting earlier evidence.");
    expect(requirements).toContain("cancellation, and interruption are not consent");
    expect(claude).toContain("not an operating-system security boundary");

    const expectedTools: Record<string, string[]> = {
      "AFF-0-coordinator": ["read", "search", "edit", "execute", "agent", "todo"],
      "AFF-1-requirements": ["read", "search", "edit", "web"],
      "AFF-A-rubber-duck": ["read", "search", "edit", "web"],
    };
    for (const [owner, tools] of Object.entries(expectedTools)) {
      const file = `.github/agents/${owner}.agent.md`;
      const profile = await parseProfile(path.join(repositoryRoot, file), file, "agent");
      expect(profile.errors).toEqual([]);
      expect(profile.frontmatter?.tools).toEqual(tools);
      expect(profile.frontmatter?.model).toBe(
        owner === "AFF-A-rubber-duck" ? "gpt-5.4" : "gpt-5.6-sol",
      );
    }
  });
});
