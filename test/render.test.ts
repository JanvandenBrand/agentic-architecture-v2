import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { hashArtifact } from "../src/case/hash.js";
import {
  renderPhaseHtml,
  renderSolutionOverview,
} from "../src/render/index.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const temporaryDirectories: string[] = [];

async function createCase(markdown: string): Promise<{
  caseRoot: string;
  outputPath: string;
}> {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "aff-render-"));
  temporaryDirectories.push(repositoryRoot);
  const caseRoot = path.join(repositoryRoot, "cases", "sample");
  const phaseRoot = path.join(caseRoot, "0-coordination");
  await mkdir(phaseRoot, { recursive: true });
  await cp(path.join(projectRoot, "schemas"), path.join(repositoryRoot, "schemas"), {
    recursive: true,
  });
  const sourcePath = path.join(phaseRoot, "sample-coordination.md");
  await writeFile(sourcePath, markdown);
  await writeFile(
    path.join(phaseRoot, "sample-input-inventory.json"),
    `${JSON.stringify({
      schemaVersion: "1.0.0",
      recordType: "input-inventory",
      caseName: "sample",
      artifactPrefix: "sample",
      sources: [
        {
          sourcePath: "0-coordination/sample-coordination.md",
          governedArtifact: {
            path: "0-coordination/sample-coordination.md",
            sha256: await hashArtifact(sourcePath),
          },
          readable: true,
        },
      ],
    })}\n`,
  );
  return {
    caseRoot,
    outputPath: path.join(phaseRoot, "sample-coordination.html"),
  };
}

async function renderMarkdown(
  markdown: string,
  configure?: (caseRoot: string) => Promise<void>,
): Promise<string> {
  const { caseRoot, outputPath } = await createCase(markdown);
  await configure?.(caseRoot);
  await renderPhaseHtml({
    caseRoot,
    phaseId: "0",
    sourcePath: "0-coordination/sample-coordination.md",
    outputPath: "0-coordination/sample-coordination.html",
    metadataPaths: [],
  });
  return readFile(outputPath, "utf8");
}

async function createValidatedOverviewCase(): Promise<{
  repositoryRoot: string;
  caseRoot: string;
}> {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "aff-overview-"));
  temporaryDirectories.push(repositoryRoot);
  const fixtureRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "cases",
    "valid-case",
  );
  const caseRoot = path.join(repositoryRoot, "cases", "valid-case");
  await cp(path.join(projectRoot, "schemas"), path.join(repositoryRoot, "schemas"), {
    recursive: true,
  });
  await cp(
    path.join(projectRoot, ".github", "agents", "AFF-LIFECYCLE.json"),
    path.join(repositoryRoot, ".github", "agents", "AFF-LIFECYCLE.json"),
  );
  await cp(fixtureRoot, caseRoot, { recursive: true });

  const approval: unknown = JSON.parse(
    await readFile(
      path.join(
        caseRoot,
        "approvals",
        "phase-0",
        "sample-phase-0-approval.json",
      ),
      "utf8",
    ),
  );
  if (
    typeof approval !== "object" ||
    approval === null ||
    !("artifactHashes" in approval) ||
    !Array.isArray(approval.artifactHashes) ||
    !("reviewRecords" in approval) ||
    !Array.isArray(approval.reviewRecords)
  ) {
    throw new TypeError("Approval fixture does not expose artifact and review hashes.");
  }
  const events = [
    {
      schemaVersion: "1.0.0",
      recordType: "run-journal-event",
      caseName: "valid-case",
      artifactPrefix: "sample",
      eventId: "EVT-002",
      sequence: 2,
      timestamp: "2026-01-01T10:06:00Z",
      phaseId: "0",
      eventType: "REVIEW-RECORDED",
      actor: "AFF-0-coordinator",
      summary: "Both final reviews recorded.",
      reviewHashes: approval.reviewRecords,
    },
    {
      schemaVersion: "1.0.0",
      recordType: "run-journal-event",
      caseName: "valid-case",
      artifactPrefix: "sample",
      eventId: "EVT-003",
      sequence: 3,
      timestamp: "2026-01-01T10:10:00Z",
      phaseId: "0",
      eventType: "HUMAN-DECISION",
      actor: "Human Architect",
      summary: "Synthetic test evidence: Phase 0 approved.",
      artifactHashes: approval.artifactHashes,
      reviewHashes: approval.reviewRecords,
      decision: "APPROVED",
    },
    {
      schemaVersion: "1.0.0",
      recordType: "run-journal-event",
      caseName: "valid-case",
      artifactPrefix: "sample",
      eventId: "EVT-004",
      sequence: 4,
      timestamp: "2026-01-01T10:11:00Z",
      phaseId: "0",
      eventType: "PHASE-EXITED",
      actor: "AFF-0-coordinator",
      summary: "Phase 0 exited after the synthetic approval.",
    },
    {
      schemaVersion: "1.0.0",
      recordType: "run-journal-event",
      caseName: "valid-case",
      artifactPrefix: "sample",
      eventId: "EVT-005",
      sequence: 5,
      timestamp: "2026-01-01T10:12:00Z",
      phaseId: "1",
      eventType: "PHASE-ENTERED",
      actor: "AFF-1-requirements",
      summary: "Opening interview question prepared; no requirement baselined.",
    },
  ];
  const journalPath = path.join(caseRoot, "sample-run-journal.jsonl");
  await writeFile(
    journalPath,
    `${await readFile(journalPath, "utf8")}${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  return { repositoryRoot, caseRoot };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("phase HTML renderer", () => {
  it("renders partial new-version metadata before model plan and approval exist", async () => {
    const html = await renderMarkdown("# Phase 0\n\nPartial metadata.\n", async (caseRoot) => {
      const metadataPath = path.join(caseRoot, "0-coordination", "sample-input-inventory.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      metadata.schemaVersion = "1.1.0";
      await writeFile(metadataPath, JSON.stringify(metadata));
    });
    expect(html).toContain("Partial metadata.");
  });

  it("rejects mixed-version phase metadata without requiring an approval", async () => {
    await expect(renderMarkdown("# Phase 0\n\nMixed metadata.\n", async (caseRoot) => {
      const phaseRoot = path.join(caseRoot, "0-coordination");
      const metadata = JSON.parse(await readFile(
        path.join(phaseRoot, "sample-input-inventory.json"), "utf8",
      ));
      metadata.schemaVersion = "1.1.0";
      await writeFile(path.join(phaseRoot, "sample-second-input-inventory.json"), JSON.stringify(metadata));
    })).rejects.toThrow(/mixes AFF record schema versions/u);
  });

  it("renders safe Markdown as accessible standalone HTML", async () => {
    const { caseRoot, outputPath } = await createCase(
      "# Phase 0\n\n[Jump to scope](#scope).\n\n## Scope\n\n| Item | State |\n| --- | --- |\n| Permit | Ready |\n",
    );

    await renderPhaseHtml({
      caseRoot,
      phaseId: "0",
      sourcePath: "0-coordination/sample-coordination.md",
      outputPath: "0-coordination/sample-coordination.html",
      metadataPaths: [],
    });

    const html = await readFile(outputPath, "utf8");
    expect(html).toContain('<a class="skip-link" href="#main-content">');
    expect(html).toContain('<nav aria-label="Table of contents">');
    expect(html).toContain('id="phase-0-phase-0"');
    expect(html).toContain('id="phase-0-scope"');
    expect(html).toContain('href="#phase-0-scope"');
    expect(html).toContain('<th scope="col">Item</th>');
    expect(html).not.toMatch(/https?:\/\/[^"]+\.(?:js|css)/u);
  });

  it("rejects raw HTML rather than silently dropping it", async () => {
    const { caseRoot } = await createCase(
      "# Phase 0\n\n<script>alert('unsafe')</script>\n",
    );

    await expect(
      renderPhaseHtml({
        caseRoot,
        phaseId: "0",
        sourcePath: "0-coordination/sample-coordination.md",
        outputPath: "0-coordination/sample-coordination.html",
        metadataPaths: [],
      }),
    ).rejects.toThrow(/raw HTML/u);
  });

  it.each([
    "[unsafe](javascript:alert(1))",
    "[unsafe](data:text/html;base64,PHNjcmlwdD4=)",
    "[unsafe](file:///etc/passwd)",
    "![unsafe](javascript:alert(1))",
    "![unsafe](data:image/svg+xml;base64,PHN2Zz4=)",
    "![unsafe](file:///etc/passwd)",
  ])("rejects dangerous Markdown URL: %s", async (markdown) => {
    const { caseRoot } = await createCase(`# Phase 0\n\n${markdown}\n`);

    await expect(
      renderPhaseHtml({
        caseRoot,
        phaseId: "0",
        sourcePath: "0-coordination/sample-coordination.md",
        outputPath: "0-coordination/sample-coordination.html",
        metadataPaths: [],
      }),
    ).rejects.toThrow(/disallowed|plain local asset/u);
  });

  it("rejects event handlers and style injection in raw HTML", async () => {
    const { caseRoot } = await createCase(
      '# Phase 0\n\n<img src="x" onerror="alert(1)" style="display:none">\n',
    );

    await expect(
      renderPhaseHtml({
        caseRoot,
        phaseId: "0",
        sourcePath: "0-coordination/sample-coordination.md",
        outputPath: "0-coordination/sample-coordination.html",
        metadataPaths: [],
      }),
    ).rejects.toThrow(/raw HTML/u);
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>unsafe</div></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/a.svg#x"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:url(https://evil.example/x)" d="M0 0"/></svg>',
  ])("rejects unsafe SVG assets", async (svg) => {
    const { caseRoot } = await createCase("# Phase 0\n\n![Diagram](diagram.svg)\n");
    await writeFile(path.join(caseRoot, "0-coordination", "diagram.svg"), svg);

    await expect(
      renderPhaseHtml({
        caseRoot,
        phaseId: "0",
        sourcePath: "0-coordination/sample-coordination.md",
        outputPath: "0-coordination/sample-coordination.html",
        metadataPaths: [],
      }),
    ).rejects.toThrow(/SVG/u);
  });

  it("embeds a safe static SVG without external references", async () => {
    const html = await renderMarkdown(
      "# Phase 0\n\n![Permit flow](diagram.svg)\n",
      async (caseRoot) => {
        await writeFile(
          path.join(caseRoot, "0-coordination", "diagram.svg"),
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" role="img" aria-label="Permit flow"><title>Permit flow</title><rect x="1" y="1" width="18" height="18" fill="#174ea6"/></svg>',
        );
      },
    );

    expect(html).toContain("data:image/svg+xml;base64,");
    expect(html).not.toContain("<svg");
  });

  it("renders Mermaid as escaped accessible source with an explicit warning", async () => {
    const html = await renderMarkdown(
      "# Phase 0\n\n```mermaid\nflowchart LR\nA[<script>alert(1)</script>] --> B\n```\n",
    );

    expect(html).toContain("Diagram shown as escaped Mermaid source");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("fails a mode that claims visual Mermaid completion", async () => {
    const { caseRoot } = await createCase(
      "# Phase 0\n\n```mermaid\nflowchart LR\nA --> B\n```\n",
    );

    await expect(
      renderPhaseHtml({
        caseRoot,
        phaseId: "0",
        sourcePath: "0-coordination/sample-coordination.md",
        outputPath: "0-coordination/sample-coordination.html",
        metadataPaths: [],
        requireVisualDiagrams: true,
      }),
    ).rejects.toThrow(/does not execute Mermaid/u);
  });

  it("rejects asset path traversal", async () => {
    const { caseRoot } = await createCase("# Phase 0\n\n![Outside](../../outside.png)\n");

    await expect(
      renderPhaseHtml({
        caseRoot,
        phaseId: "0",
        sourcePath: "0-coordination/sample-coordination.md",
        outputPath: "0-coordination/sample-coordination.html",
        metadataPaths: [],
      }),
    ).rejects.toThrow(/case directory/u);
  });

  it("rejects a symbolic-link asset escape where symbolic links are supported", async () => {
    const { caseRoot } = await createCase("# Phase 0\n\n![Outside](outside.png)\n");
    const outside = path.join(path.dirname(caseRoot), `${path.basename(caseRoot)}-outside.png`);
    await writeFile(outside, "not-an-image");
    try {
      await symlink(outside, path.join(caseRoot, "0-coordination", "outside.png"));
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "EPERM") {
        await rm(outside, { force: true });
        return;
      }
      throw error;
    }

    await expect(
      renderPhaseHtml({
        caseRoot,
        phaseId: "0",
        sourcePath: "0-coordination/sample-coordination.md",
        outputPath: "0-coordination/sample-coordination.html",
        metadataPaths: [],
      }),
    ).rejects.toThrow(/symbolic link|junction/u);
    await rm(outside, { force: true });
  });

  it("rejects an existing output symlink where symbolic links are supported", async () => {
    const { caseRoot } = await createCase("# Phase 0\n\nSafe.\n");
    const outside = path.join(path.dirname(caseRoot), `${path.basename(caseRoot)}-outside.html`);
    await writeFile(outside, "outside remains unchanged");
    const output = path.join(
      caseRoot,
      "0-coordination",
      "sample-coordination.html",
    );
    try {
      await symlink(outside, output);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "EPERM") {
        await rm(outside, { force: true });
        return;
      }
      throw error;
    }

    await expect(
      renderPhaseHtml({
        caseRoot,
        phaseId: "0",
        sourcePath: "0-coordination/sample-coordination.md",
        outputPath: "0-coordination/sample-coordination.html",
        metadataPaths: [],
      }),
    ).rejects.toThrow(/symbolic link|junction/u);
    expect(await readFile(outside, "utf8")).toBe("outside remains unchanged");
    await rm(outside, { force: true });
  });

  it("rejects malformed UTF-8 input", async () => {
    const { caseRoot } = await createCase("# replaced");
    await writeFile(
      path.join(caseRoot, "0-coordination", "sample-coordination.md"),
      Buffer.from([0xc3, 0x28]),
    );

    await expect(
      renderPhaseHtml({
        caseRoot,
        phaseId: "0",
        sourcePath: "0-coordination/sample-coordination.md",
        outputPath: "0-coordination/sample-coordination.html",
        metadataPaths: [],
      }),
    ).rejects.toThrow(/valid UTF-8/u);
  });

  it("rejects oversized Markdown input", async () => {
    const { caseRoot } = await createCase(`/${"a".repeat(1_048_576)}`);

    await expect(
      renderPhaseHtml({
        caseRoot,
        phaseId: "0",
        sourcePath: "0-coordination/sample-coordination.md",
        outputPath: "0-coordination/sample-coordination.html",
        metadataPaths: [],
      }),
    ).rejects.toThrow(/limit/u);
  });

  it("creates unique deterministic IDs for duplicate and naturally suffixed headings", async () => {
    const html = await renderMarkdown(
      "# Phase 0\n\n## Scope\n\nFirst.\n\n## Scope\n\nSecond.\n\n## Scope 2\n\nThird.\n",
    );

    expect(html.match(/id="phase-0-scope"/gu)).toHaveLength(1);
    expect(html.match(/id="phase-0-scope-2"/gu)).toHaveLength(1);
    expect(html.match(/id="phase-0-scope-2-2"/gu)).toHaveLength(1);
    const toc = html.match(
      /<nav aria-label="Table of contents">[^]*?<\/nav>/u,
    )?.[0];
    const tocTargets = [...(toc ?? "").matchAll(/href="#([^"]+)"/gu)].map(
      (match) => match[1],
    );
    expect(tocTargets).toEqual([
      "phase-0-phase-0",
      "phase-0-scope",
      "phase-0-scope-2",
      "phase-0-scope-2-2",
    ]);
    const ids = [...html.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("allocates code captions through the same collision-proof ID namespace", async () => {
    const html = await renderMarkdown(
      "# Phase 0\n\n## Code 6\n\n```text\nfirst\n```\n\n```json\n{\"second\":true}\n```\n",
    );
    const ids = [...html.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]);
    const labelledBy = [
      ...html.matchAll(/<figure[^>]+aria-labelledby="([^"]+)"/gu),
    ].map((match) => match[1]);

    expect(new Set(ids).size).toBe(ids.length);
    expect(labelledBy).toHaveLength(2);
    expect(new Set(labelledBy).size).toBe(2);
    for (const captionId of labelledBy) {
      expect(html).toContain(`<figcaption id="${captionId}">`);
    }
  });

  it("rejects a heading hierarchy that skips a level", async () => {
    const { caseRoot } = await createCase(
      "# Phase 0\n\n### Skipped level\n\nUnsafe structure.\n",
    );

    await expect(
      renderPhaseHtml({
        caseRoot,
        phaseId: "0",
        sourcePath: "0-coordination/sample-coordination.md",
        outputPath: "0-coordination/sample-coordination.html",
        metadataPaths: [],
      }),
    ).rejects.toThrow(/Heading hierarchy/u);
  });

  it("rejects authoritative Markdown without a leading heading", async () => {
    const { caseRoot } = await createCase("Plain text without a heading.\n");

    await expect(
      renderPhaseHtml({
        caseRoot,
        phaseId: "0",
        sourcePath: "0-coordination/sample-coordination.md",
        outputPath: "0-coordination/sample-coordination.html",
        metadataPaths: [],
      }),
    ).rejects.toThrow(/no semantic heading/u);
  });

  it("rejects schema-valid metadata from another case", async () => {
    const { caseRoot } = await createCase("# Phase 0\n");
    const metadataPath = path.join(
      caseRoot,
      "0-coordination",
      "sample-input-inventory.json",
    );
    const metadata = await readFile(metadataPath, "utf8");
    await writeFile(
      metadataPath,
      metadata.replace('"caseName":"sample"', '"caseName":"other-case"'),
    );

    await expect(
      renderPhaseHtml({
        caseRoot,
        phaseId: "0",
        sourcePath: "0-coordination/sample-coordination.md",
        outputPath: "0-coordination/sample-coordination.html",
        metadataPaths: [],
      }),
    ).rejects.toThrow(/differs from directory/u);
  });

  it("rejects stale artifact hashes in structured metadata", async () => {
    const { caseRoot } = await createCase("# Phase 0\n");
    await writeFile(
      path.join(caseRoot, "0-coordination", "metadata.json"),
      JSON.stringify({
        schemaVersion: "1.0.0",
        recordType: "input-inventory",
        caseName: "sample",
        artifactPrefix: "sample",
        sources: [
          {
            sourcePath: "0-coordination/sample-coordination.md",
            governedArtifact: {
              path: "0-coordination/sample-coordination.md",
              sha256: "0".repeat(64),
            },
            readable: true,
          },
        ],
      }),
    );

    await expect(
      renderPhaseHtml({
        caseRoot,
        phaseId: "0",
        sourcePath: "0-coordination/sample-coordination.md",
        outputPath: "0-coordination/sample-coordination.html",
        metadataPaths: ["0-coordination/metadata.json"],
      }),
    ).rejects.toThrow(/not recorded/u);
  });

  it("rejects structured metadata that fails its versioned schema", async () => {
    const { caseRoot } = await createCase("# Phase 0\n");
    await writeFile(
      path.join(
        caseRoot,
        "0-coordination",
        "sample-input-inventory.json",
      ),
      '{"schemaVersion":"1.0.0","recordType":"input-inventory"}\n',
    );

    await expect(
      renderPhaseHtml({
        caseRoot,
        phaseId: "0",
        sourcePath: "0-coordination/sample-coordination.md",
        outputPath: "0-coordination/sample-coordination.html",
        metadataPaths: [],
      }),
    ).rejects.toThrow(/required property|schema/u);
  });

  it("requires structured metadata for phase rendering", async () => {
    const { caseRoot } = await createCase("# Phase 0\n");
    await rm(
      path.join(
        caseRoot,
        "0-coordination",
        "sample-input-inventory.json",
      ),
    );

    await expect(
      renderPhaseHtml({
        caseRoot,
        phaseId: "0",
        sourcePath: "0-coordination/sample-coordination.md",
        outputPath: "0-coordination/sample-coordination.html",
        metadataPaths: [],
      }),
    ).rejects.toThrow(/metadata/u);
  });

  it("rejects a phase output path that does not match its source", async () => {
    const { caseRoot } = await createCase("# Phase 0\n");

    await expect(
      renderPhaseHtml({
        caseRoot,
        phaseId: "0",
        sourcePath: "0-coordination/sample-coordination.md",
        outputPath: "0-coordination/other.html",
        metadataPaths: ["0-coordination/sample-input-inventory.json"],
      }),
    ).rejects.toThrow(/contracted/u);
  });

  it("rejects a matching source/output pair with a non-contracted artifact name", async () => {
    const { caseRoot } = await createCase("# Phase 0\n");
    await writeFile(
      path.join(caseRoot, "0-coordination", "arbitrary.md"),
      "# Arbitrary\n",
    );

    await expect(
      renderPhaseHtml({
        caseRoot,
        phaseId: "0",
        sourcePath: "0-coordination/arbitrary.md",
        outputPath: "0-coordination/arbitrary.html",
        metadataPaths: ["0-coordination/sample-input-inventory.json"],
      }),
    ).rejects.toThrow(/artifact prefix|primary phase/u);
  });

  it("does not leave a partial file after an atomic write failure", async () => {
    const { caseRoot } = await createCase("# Phase 0\n");
    const outputDirectory = path.join(
      caseRoot,
      "0-coordination",
      "sample-coordination.html",
    );
    await mkdir(outputDirectory);

    await expect(
      renderPhaseHtml({
        caseRoot,
        phaseId: "0",
        sourcePath: "0-coordination/sample-coordination.md",
        outputPath: "0-coordination/sample-coordination.html",
        metadataPaths: [],
      }),
    ).rejects.toThrow();

    expect(await readdir(path.join(caseRoot, "0-coordination"))).toEqual([
      "sample-coordination.html",
      "sample-coordination.md",
      "sample-input-inventory.json",
    ]);
  });

  it("contains landmarks, linked headings, labels, and no remote dependencies", async () => {
    const html = await renderMarkdown(
      "# Phase 0\n\n## Scope\n\n```json\n{\"state\":\"safe\"}\n```\n\n| Item | State |\n| --- | --- |\n| Permit | Ready |\n",
    );

    expect(html).toMatch(/<header>/u);
    expect(html).toMatch(/<main id="main-content">/u);
    expect(html).toMatch(/<article aria-label=/u);
    expect(html).toMatch(/<footer>/u);
    expect(html).toContain('href="#phase-0-scope"');
    expect(html).toMatch(
      /href="#phase-0-phase-0"[^]*<ol>[^]*href="#phase-0-scope"/u,
    );
    expect(html).toContain('aria-labelledby="phase-0-generated-code-');
    expect(html).toContain('<th scope="col">');
    expect(html).not.toMatch(/<(?:link|iframe)\b/iu);
    expect(html).not.toMatch(/<script\b/iu);
    expect(html).not.toMatch(/(?:src|href)="https?:/iu);
  });

  it("declares a fail-closed content security policy on phase HTML", async () => {
    const html = await renderMarkdown("# Phase 0\n\n## Scope\n\nSafe content.\n");

    expect(html).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(html).toMatch(/content="default-src 'none';[^"]*script-src 'none'"/u);
    expect(html).toMatch(/img-src data:/u);
    expect(html).toMatch(/base-uri 'none'/u);
    expect(html).toMatch(/form-action 'none'/u);
  });

  it("renders a cumulative overview only from validated journal, review, and approval evidence", async () => {
    const { repositoryRoot, caseRoot } = await createValidatedOverviewCase();

    await renderSolutionOverview({
      repositoryRoot,
      casePath: "cases/valid-case",
    });

    const html = await readFile(
      path.join(caseRoot, "solution-overview.html"),
      "utf8",
    );
    expect(html).toContain('role="tablist"');
    expect(html).toContain("Phase 0");
    expect(html).toContain("Approved and exited");
    expect(html).toContain("Phase 1");
    expect(html).toContain("In progress");
    expect(html).toContain("Rubber Duck Reviewer (AFF-A) review");
    expect(html).toContain("Security and Compliance Reviewer (AFF-B) review");
    expect(html).toContain("Approval record SHA-256");
    expect(html).toContain("aria-selected=");
    expect(html).not.toMatch(/(?:src|href)="https?:/iu);
    expect(html).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(html).toMatch(
      /content="default-src 'none';[^"]*script-src 'unsafe-inline'"/u,
    );
    const ids = [...html.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const reference of html.matchAll(
      /aria-(?:controls|labelledby)="([^"]+)"/gu,
    )) {
      expect(ids).toContain(reference[1]);
    }
  });

  it("represents an explicit reopened phase without losing approved content", async () => {
    const { repositoryRoot, caseRoot } = await createValidatedOverviewCase();
    const journalPath = path.join(caseRoot, "sample-run-journal.jsonl");
    await writeFile(
      journalPath,
      `${await readFile(journalPath, "utf8")}${JSON.stringify({
        schemaVersion: "1.0.0",
        recordType: "run-journal-event",
        caseName: "valid-case",
        artifactPrefix: "sample",
        eventId: "EVT-006",
        sequence: 6,
        timestamp: "2026-01-01T10:13:00Z",
        phaseId: "0",
        eventType: "PHASE-REOPENED",
        actor: "AFF-0-coordinator",
        summary: "Phase 0 explicitly reopened.",
      })}\n`,
    );

    await renderSolutionOverview({
      repositoryRoot,
      casePath: "cases/valid-case",
    });

    const html = await readFile(
      path.join(caseRoot, "solution-overview.html"),
      "utf8",
    );
    expect(html).toContain("Reopened");
    expect(html).toContain("Approved candidate.");
  });

  it("refuses to create an overview from stale candidate evidence", async () => {
    const { repositoryRoot, caseRoot } = await createValidatedOverviewCase();
    await writeFile(
      path.join(caseRoot, "0-coordination", "sample-coordination.md"),
      "# Phase 0\n\nChanged after approval.\n",
    );

    await expect(
      renderSolutionOverview({
        repositoryRoot,
        casePath: "cases/valid-case",
      }),
    ).rejects.toThrow(/validation/u);
    await expect(
      readFile(path.join(caseRoot, "solution-overview.html"), "utf8"),
    ).rejects.toThrow();
  });

  it("refuses to create a cumulative overview before any validated approval", async () => {
    const { repositoryRoot, caseRoot } = await createValidatedOverviewCase();
    await rm(
      path.join(
        caseRoot,
        "approvals",
        "phase-0",
        "sample-phase-0-approval.json",
      ),
    );

    await expect(
      renderSolutionOverview({
        repositoryRoot,
        casePath: "cases/valid-case",
      }),
    ).rejects.toThrow(/approval/u);
  });

  it("does not reactivate an old approval when a reopened phase exits", async () => {
    const { repositoryRoot, caseRoot } = await createValidatedOverviewCase();
    const journalPath = path.join(caseRoot, "sample-run-journal.jsonl");
    const extraEvents = [
      {
        schemaVersion: "1.0.0",
        recordType: "run-journal-event",
        caseName: "valid-case",
        artifactPrefix: "sample",
        eventId: "EVT-006",
        sequence: 6,
        timestamp: "2026-01-01T10:13:00Z",
        phaseId: "0",
        eventType: "PHASE-REOPENED",
        actor: "AFF-0-coordinator",
        summary: "Phase 0 explicitly reopened.",
      },
      {
        schemaVersion: "1.0.0",
        recordType: "run-journal-event",
        caseName: "valid-case",
        artifactPrefix: "sample",
        eventId: "EVT-007",
        sequence: 7,
        timestamp: "2026-01-01T10:14:00Z",
        phaseId: "0",
        eventType: "PHASE-EXITED",
        actor: "AFF-0-coordinator",
        summary: "Invalid exit without a new approval.",
      },
    ];
    await writeFile(
      journalPath,
      `${await readFile(journalPath, "utf8")}${extraEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );

    await renderSolutionOverview({
      repositoryRoot,
      casePath: "cases/valid-case",
    });

    const html = await readFile(
      path.join(caseRoot, "solution-overview.html"),
      "utf8",
    );
    expect(html).not.toContain("Approved and exited");
    expect(html).toContain("Not approved");
  });

  it("cannot render tampered unapproved content after a later hash-less candidate event", async () => {
    const { repositoryRoot, caseRoot } = await createValidatedOverviewCase();
    const phaseRoot = path.join(caseRoot, "1-requirements");
    await mkdir(phaseRoot, { recursive: true });
    const markdownPath = path.join(phaseRoot, "sample-requirements.md");
    await writeFile(markdownPath, "# Phase 1\n\nRecorded candidate.\n");
    const recordedHash = await hashArtifact(markdownPath);
    const journalPath = path.join(caseRoot, "sample-run-journal.jsonl");
    const events = [
      {
        schemaVersion: "1.0.0",
        recordType: "run-journal-event",
        caseName: "valid-case",
        artifactPrefix: "sample",
        eventId: "EVT-006",
        sequence: 6,
        timestamp: "2026-01-01T10:13:00Z",
        phaseId: "1",
        eventType: "ARTIFACTS-RECORDED",
        actor: "AFF-1-requirements",
        summary: "Phase 1 candidate recorded.",
        artifactHashes: [
          {
            path: "1-requirements/sample-requirements.md",
            sha256: recordedHash,
          },
        ],
      },
      {
        schemaVersion: "1.0.0",
        recordType: "run-journal-event",
        caseName: "valid-case",
        artifactPrefix: "sample",
        eventId: "EVT-007",
        sequence: 7,
        timestamp: "2026-01-01T10:14:00Z",
        phaseId: "1",
        eventType: "ARTIFACTS-RECORDED",
        actor: "AFF-1-requirements",
        summary: "Invalid hash-less candidate suppression attempt.",
      },
    ];
    await writeFile(
      journalPath,
      `${await readFile(journalPath, "utf8")}${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    await writeFile(markdownPath, "# Phase 1\n\nTampered unapproved content.\n");

    await expect(
      renderSolutionOverview({
        repositoryRoot,
        casePath: "cases/valid-case",
      }),
    ).rejects.toThrow(/validation failed/u);
    await expect(
      readFile(path.join(caseRoot, "solution-overview.html"), "utf8"),
    ).rejects.toThrow();
  });
});
