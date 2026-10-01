import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { validateFramework } from "../src/index.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories: string[] = [];

async function copyFramework(withAdapter = true): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "aff-claude-adapter-"));
  temporaryDirectories.push(root);
  const entries = [".github", "README.md", "docs", "cases", "schemas"];
  if (withAdapter) {
    entries.push(".claude", "CLAUDE.md", ".mcp.json");
  }
  for (const entry of entries) {
    await cp(path.join(repositoryRoot, entry), path.join(root, entry), {
      recursive: true,
    });
  }
  return root;
}

async function edit(
  root: string,
  file: string,
  change: (content: string) => string,
): Promise<void> {
  const target = path.join(root, file);
  const before = await readFile(target, "utf8");
  const after = change(before);
  expect(after, `${file} edit had no effect`).not.toBe(before);
  await writeFile(target, after);
}

async function adapterErrors(root: string): Promise<string[]> {
  const { errors } = await validateFramework(root);
  return errors
    .filter(({ invariant }) => invariant === "claude-adapter")
    .map(({ file, message }) => `${file}: ${message}`);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Claude Code adapter", () => {
  it("is packaged and accepted by framework validation", async () => {
    expect(existsSync(path.join(repositoryRoot, ".claude", "agents"))).toBe(true);
    expect(existsSync(path.join(repositoryRoot, "CLAUDE.md"))).toBe(true);

    const result = await validateFramework(repositoryRoot);

    expect(result.errors).toEqual([]);
  });

  it("is optional when no .claude directory exists", async () => {
    const root = await copyFramework(false);

    expect(await adapterErrors(root)).toEqual([]);
  });

  it("rejects a missing agent wrapper", async () => {
    const root = await copyFramework();
    await rm(path.join(root, ".claude", "agents", "AFF-B-security-compliance.md"));

    expect(await adapterErrors(root)).toEqual([
      expect.stringContaining("AFF-B-security-compliance"),
    ]);
  });

  it("rejects a wrapper for an agent outside the lifecycle", async () => {
    const root = await copyFramework();
    await cp(
      path.join(root, ".claude", "agents", "AFF-1-requirements.md"),
      path.join(root, ".claude", "agents", "AFF-9-rogue.md"),
    );

    expect(await adapterErrors(root)).toEqual(
      expect.arrayContaining([expect.stringContaining("AFF-9-rogue")]),
    );
  });

  it("rejects a wrapper whose name differs from its file", async () => {
    const root = await copyFramework();
    await edit(root, ".claude/agents/AFF-1-requirements.md", (content) =>
      content.replace("name: AFF-1-requirements", "name: AFF-1-other"),
    );

    expect(await adapterErrors(root)).not.toEqual([]);
  });

  it("rejects a wrapper that does not defer to its authoritative profile", async () => {
    const root = await copyFramework();
    await edit(root, ".claude/agents/AFF-1-requirements.md", (content) =>
      content.replaceAll(".github/agents/AFF-1-requirements.agent.md", "elsewhere"),
    );

    expect(await adapterErrors(root)).toEqual([
      expect.stringContaining(".github/agents/AFF-1-requirements.agent.md"),
    ]);
  });

  it("rejects a reviewer wrapper granted command execution", async () => {
    const root = await copyFramework();
    await edit(root, ".claude/agents/AFF-A-rubber-duck.md", (content) =>
      content.replace(/^tools: (.*)$/mu, "tools: $1, Bash"),
    );

    expect(await adapterErrors(root)).toEqual([expect.stringContaining("Bash")]);
  });

  it("rejects a wrapper that drops a tool its profile grants", async () => {
    const root = await copyFramework();
    await edit(root, ".claude/agents/AFF-0-coordinator.md", (content) =>
      content.replace(/^tools: (.*)$/mu, (_line, tools: string) =>
        `tools: ${tools.split(", ").filter((tool) => tool !== "TodoWrite").join(", ")}`,
      ),
    );

    expect(await adapterErrors(root)).toEqual([expect.stringContaining("TodoWrite")]);
  });

  it("rejects a non-Claude model", async () => {
    const root = await copyFramework();
    await edit(root, ".claude/agents/AFF-B-security-compliance.md", (content) =>
      content.replace(/^model: .*$/mu, "model: gpt-5.6-sol"),
    );

    expect(await adapterErrors(root)).toEqual([expect.stringContaining("gpt-5.6-sol")]);
  });

  it("rejects an AFF-A default model shared with a phase owner", async () => {
    const root = await copyFramework();
    const owner = await readFile(
      path.join(root, ".claude", "agents", "AFF-1-requirements.md"),
      "utf8",
    );
    const ownerModel = /^model: (.*)$/mu.exec(owner)?.[1];
    expect(ownerModel).toBeDefined();
    await edit(root, ".claude/agents/AFF-A-rubber-duck.md", (content) =>
      content.replace(/^model: .*$/mu, `model: ${ownerModel}`),
    );

    expect(await adapterErrors(root)).toEqual([
      expect.stringContaining("AFF-A-rubber-duck"),
    ]);
  });

  it("rejects a missing skill wrapper", async () => {
    const root = await copyFramework();
    await rm(path.join(root, ".claude", "skills", "grill-me"), { recursive: true });

    expect(await adapterErrors(root)).toEqual([expect.stringContaining("grill-me")]);
  });

  it("rejects settings that let agents run the approval or identity commands", async () => {
    const root = await copyFramework();
    await edit(root, ".claude/settings.json", (content) =>
      content.replace('"Bash(npm run approve*)",', ""),
    );

    expect(await adapterErrors(root)).toEqual([
      expect.stringContaining("Bash(npm run approve*)"),
    ]);
  });
});
