import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import fg from "fast-glob";
import { parseDocument } from "yaml";

import { isRecord } from "../common/json.js";
import { toRepositoryPath } from "../common/path.js";
import type { LifecycleManifest, ValidationError } from "../types.js";
import { parseProfile } from "./frontmatter.js";

// Optional Claude Code host adapter. The .github profiles stay authoritative; .claude/ only holds
// thin wrappers whose names, tool grants, and reviewer separation must match them exactly.

const invariant = "claude-adapter";

const claudeToolsFor: Record<string, string[]> = {
  read: ["Read"],
  search: ["Grep", "Glob"],
  edit: ["Edit", "Write"],
  execute: ["Bash"],
  web: ["WebFetch", "WebSearch"],
  agent: ["Agent"],
  todo: ["TodoWrite"],
};

const claudeModel = /^claude-[a-z0-9][a-z0-9.-]*$/u;

const requiredDenials = ["Bash(npm run approve*)", "Bash(npm run identity*)"];

interface Wrapper {
  file: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

function error(file: string, message: string, remediation: string): ValidationError {
  return { file, invariant, message, remediation };
}

async function readWrapper(
  repositoryRoot: string,
  file: string,
  errors: ValidationError[],
): Promise<Wrapper | undefined> {
  const content = await readFile(path.join(repositoryRoot, file), "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(content);
  const document = match?.[1] ? parseDocument(match[1], { prettyErrors: false }) : undefined;
  const frontmatter: unknown = document?.errors.length === 0 ? document.toJS() : undefined;
  if (!isRecord(frontmatter)) {
    errors.push(
      error(file, "The wrapper must start with valid YAML frontmatter.", "Restore the --- delimited frontmatter."),
    );
    return undefined;
  }
  return { file, frontmatter, body: match?.[2] ?? "" };
}

function listField(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter((item) => item !== "");
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  return undefined;
}

function expectedTools(profileTools: string[]): string[] {
  return profileTools.flatMap((tool) => {
    const separator = tool.indexOf("/");
    return separator < 0
      ? (claudeToolsFor[tool] ?? [])
      : [`mcp__${tool.slice(0, separator)}__${tool.slice(separator + 1)}`];
  });
}

function checkName(wrapper: Wrapper, expected: string, errors: ValidationError[]): void {
  if (wrapper.frontmatter.name !== expected) {
    errors.push(
      error(wrapper.file, `Wrapper name must be "${expected}".`, "Use the file's base name as the name field."),
    );
  }
  if (typeof wrapper.frontmatter.description !== "string" || wrapper.frontmatter.description.trim() === "") {
    errors.push(error(wrapper.file, "Wrapper description must be a non-empty string.", "Copy the profile description."));
  }
}

function checkDefers(wrapper: Wrapper, source: string, errors: ValidationError[]): void {
  for (const reference of [source, "CLAUDE.md"]) {
    if (!wrapper.body.includes(reference)) {
      errors.push(
        error(
          wrapper.file,
          `Wrapper body must defer to ${reference}.`,
          "Keep the instructions in the authoritative .github file; the wrapper only points to it and to CLAUDE.md.",
        ),
      );
    }
  }
}

async function validateAgents(
  repositoryRoot: string,
  lifecycle: LifecycleManifest,
  mcpServers: Map<string, unknown>,
  errors: ValidationError[],
): Promise<void> {
  const owners = [...lifecycle.phases, ...lifecycle.reviewers].map(({ owner }) => owner);
  const files = (await fg(".claude/agents/*.md", { cwd: repositoryRoot, onlyFiles: true })).map(toRepositoryPath);
  for (const file of files) {
    if (!owners.includes(path.posix.basename(file, ".md"))) {
      errors.push(
        error(file, "Wrapper does not match a lifecycle agent.", "Remove it or add the agent to the lifecycle first."),
      );
    }
  }

  const models = new Map<string, string>();
  for (const owner of owners) {
    const file = `.claude/agents/${owner}.md`;
    const source = `.github/agents/${owner}.agent.md`;
    if (!files.includes(file)) {
      errors.push(error(file, `Missing Claude wrapper for ${owner}.`, `Add ${file} pointing to ${source}.`));
      continue;
    }
    const wrapper = await readWrapper(repositoryRoot, file, errors);
    const profile = await parseProfile(path.join(repositoryRoot, source), source, "agent");
    if (!wrapper || !profile.frontmatter?.tools) {
      continue;
    }
    checkName(wrapper, owner, errors);
    checkDefers(wrapper, source, errors);

    const model = wrapper.frontmatter.model;
    if (typeof model !== "string" || !claudeModel.test(model)) {
      errors.push(
        error(file, `Model "${String(model)}" is not an exact Claude model ID.`, "Set model to an exact claude-* ID."),
      );
    } else {
      models.set(owner, model);
    }

    const granted = listField(wrapper.frontmatter.tools) ?? [];
    const expected = expectedTools(profile.frontmatter.tools);
    const extra = granted.filter((tool) => !expected.includes(tool));
    const missing = expected.filter((tool) => !granted.includes(tool));
    if (extra.length > 0 || missing.length > 0) {
      errors.push(
        error(
          file,
          `Tools must mirror ${source}; extra: [${extra.join(", ")}], missing: [${missing.join(", ")}].`,
          `Set tools to: ${expected.join(", ")}.`,
        ),
      );
    }

    for (const [server, configuration] of Object.entries(profile.frontmatter.mcpServers ?? {})) {
      const declared = mcpServers.get(server);
      if (
        !isRecord(configuration) ||
        !isRecord(declared) ||
        declared.type !== configuration.type ||
        declared.url !== configuration.url
      ) {
        errors.push(
          error(
            ".mcp.json",
            `MCP server "${server}" must match the type and url declared in ${source}.`,
            `Declare ${server} in .mcp.json with the profile's type and url.`,
          ),
        );
      }
    }
  }

  const phaseOwnerModels = new Set(lifecycle.phases.map(({ owner }) => models.get(owner)));
  for (const reviewer of lifecycle.reviewers) {
    const model = models.get(reviewer.owner);
    if (reviewer.mustDifferFromPhaseOwner && model && phaseOwnerModels.has(model)) {
      errors.push(
        error(
          `.claude/agents/${reviewer.owner}.md`,
          `${reviewer.owner} default model ${model} matches a phase owner.`,
          "Choose a reviewer default model that no phase-owner wrapper uses.",
        ),
      );
    }
  }
}

async function validateSkills(repositoryRoot: string, errors: ValidationError[]): Promise<void> {
  const sources = (await fg(".github/skills/*/SKILL.md", { cwd: repositoryRoot, onlyFiles: true })).map(toRepositoryPath);
  const wrappers = (await fg(".claude/skills/**/*", { cwd: repositoryRoot, onlyFiles: true })).map(toRepositoryPath);
  const expected = sources.map((source) => source.replace(/^\.github\//u, ".claude/"));
  for (const file of wrappers.filter((wrapper) => !expected.includes(wrapper))) {
    errors.push(error(file, "Skill wrapper does not match a .github skill.", "Remove it or add the .github skill first."));
  }
  for (const [index, file] of expected.entries()) {
    const source = sources[index] ?? "";
    if (!wrappers.includes(file)) {
      errors.push(error(file, `Missing Claude wrapper for skill ${source}.`, `Add ${file} pointing to ${source}.`));
      continue;
    }
    const wrapper = await readWrapper(repositoryRoot, file, errors);
    if (wrapper) {
      checkName(wrapper, path.posix.basename(path.posix.dirname(file)), errors);
      checkDefers(wrapper, source, errors);
    }
  }
}

async function readJson(repositoryRoot: string, file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path.join(repositoryRoot, file), "utf8"));
  } catch (caught: unknown) {
    // A missing or malformed file yields no settings, so the checks below fail closed.
    if (caught instanceof SyntaxError || (caught instanceof Error && "code" in caught && caught.code === "ENOENT")) {
      return undefined;
    }
    throw caught;
  }
}

export async function validateClaudeAdapter(
  repositoryRoot: string,
  lifecycle: LifecycleManifest,
): Promise<ValidationError[]> {
  if (!existsSync(path.join(repositoryRoot, ".claude"))) {
    return [];
  }
  const errors: ValidationError[] = [];

  if (!existsSync(path.join(repositoryRoot, "CLAUDE.md"))) {
    errors.push(error("CLAUDE.md", "The adapter rules file is missing.", "Restore CLAUDE.md."));
  }

  const settings = await readJson(repositoryRoot, ".claude/settings.json");
  const deny =
    isRecord(settings) && isRecord(settings.permissions) ? listField(settings.permissions.deny) ?? [] : [];
  for (const rule of requiredDenials.filter((denial) => !deny.includes(denial))) {
    errors.push(
      error(
        ".claude/settings.json",
        `permissions.deny must contain "${rule}".`,
        "Approval and identity commands are human-only; deny them to every agent.",
      ),
    );
  }

  const mcp = await readJson(repositoryRoot, ".mcp.json");
  const mcpServers = new Map(
    isRecord(mcp) && isRecord(mcp.mcpServers) ? Object.entries(mcp.mcpServers) : [],
  );

  await validateAgents(repositoryRoot, lifecycle, mcpServers, errors);
  await validateSkills(repositoryRoot, errors);
  return errors;
}
