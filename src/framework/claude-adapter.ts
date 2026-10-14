// Adapted from JanvandenBrand/agentic-architecture-v2, commit
// 242ee17719e9d4bc7daa608004cc3d6118d60b00 (Apache-2.0). See CLAUDE.md.
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import fg from "fast-glob";
import { parseDocument } from "yaml";

import { isRecord } from "../common/json.js";
import { toRepositoryPath } from "../common/path.js";
import type { LifecycleManifest, ValidationError } from "../types.js";
import { parseProfile, type ParsedProfile } from "./frontmatter.js";
import { validateToolGrants } from "./tools.js";
import type { HostModelDefaults } from "./hosts.js";

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
  let frontmatter: unknown;
  try {
    frontmatter = document?.errors.length === 0 ? document.toJS() : undefined;
  } catch {
    // Alias expansion errors are invalid frontmatter, not a validator crash.
    frontmatter = undefined;
  }
  if (!isRecord(frontmatter)) {
    errors.push(error(file, "The wrapper must start with valid YAML frontmatter.", "Restore the --- delimited frontmatter."));
    return undefined;
  }
  return { file, frontmatter, body: match?.[2] ?? "" };
}

function listField(value: unknown): string[] | undefined {
  const list: unknown = typeof value === "string" ? value.split(",").map((item) => item.trim()) : value;
  if (Array.isArray(list) && list.length > 0 &&
      list.every((item) => typeof item === "string" && item.trim() !== "" && item === item.trim()) &&
      new Set(list).size === list.length) {
    return list;
  }
  return undefined;
}

function expectedTools(profileTools: string[], file: string, errors: ValidationError[]): string[] {
  return profileTools.flatMap((tool) => {
    const separator = tool.indexOf("/");
    if (separator >= 0) {
      return [`mcp__${tool.slice(0, separator)}__${tool.slice(separator + 1)}`];
    }
    if (!Object.hasOwn(claudeToolsFor, tool)) {
      errors.push(error(file, `No Claude mapping exists for profile tool "${tool}".`, "Use an explicitly mapped capability."));
      return [];
    }
    return claudeToolsFor[tool] ?? [];
  });
}

function checkName(wrapper: Wrapper, expected: string, description: string, errors: ValidationError[]): void {
  if (wrapper.frontmatter.name !== expected) {
    errors.push(error(wrapper.file, `Wrapper name must be "${expected}".`, "Use the file's base name as the name field."));
  }
  if (wrapper.frontmatter.description !== description) {
    errors.push(error(wrapper.file, "Wrapper description must equal its authoritative profile description.", "Copy the profile description exactly."));
  }
}

function closedFields(
  value: Record<string, unknown>,
  fields: string[],
  file: string,
  errors: ValidationError[],
): void {
  const extra = Object.keys(value).filter((field) => !fields.includes(field));
  const missing = fields.filter((field) => !Object.hasOwn(value, field));
  if (extra.length || missing.length) {
    errors.push(error(file, `Fields must be exactly [${fields.join(", ")}]; extra: [${extra.join(", ")}], missing: [${missing.join(", ")}].`,
      "Restore the closed adapter configuration; additional instructions or permission settings are unsupported."));
  }
}

function checkDefers(wrapper: Wrapper, source: string, kind: "profile" | "skill", errors: ValidationError[]): void {
  // Normalise line endings and surrounding blank space, not words or internal whitespace.
  const expected = `Read \`${source}\`, every file it names, and \`CLAUDE.md\` before acting.\n` +
    `Follow the authoritative ${kind} exactly; this wrapper adds no phase instructions.`;
  if (wrapper.body.replace(/\r\n/gu, "\n").trim() !== expected) {
    errors.push(error(wrapper.file, `Wrapper body must equal the pointer template for ${source} and CLAUDE.md.`,
      "Restore the exact two-line pointer template; do not append or substitute instructions."));
  }
}

async function readSource(
  repositoryRoot: string,
  source: string,
  kind: "agent" | "skill",
  errors: ValidationError[],
): Promise<ParsedProfile | undefined> {
  try {
    const profile = await parseProfile(path.join(repositoryRoot, source), source, kind);
    errors.push(...profile.errors.map((item) => ({ ...item, invariant })));
    return profile;
  } catch (caught: unknown) {
    if (!isMissingFile(caught)) {
      throw caught;
    }
    errors.push(error(source, "The authoritative profile is missing or is not a file.", "Restore the authoritative profile before validating its wrapper."));
    return undefined;
  }
}

async function validateAgents(
  repositoryRoot: string,
  lifecycle: LifecycleManifest,
  files: string[],
  expectedMcp: Map<string, { type: string; url: string }>,
  errors: ValidationError[],
): Promise<Map<string, string>> {
  const owners = [...lifecycle.phases, ...lifecycle.reviewers].map(({ owner }) => owner);
  const profiles: ParsedProfile[] = [];
  const models = new Map<string, string>();
  for (const owner of owners) {
    const file = `.claude/agents/${owner}.md`;
    const source = `.github/agents/${owner}.agent.md`;
    const profile = await readSource(repositoryRoot, source, "agent", errors);
    if (profile) {
      profiles.push(profile);
    }
    if (profile?.frontmatter && profile.frontmatter.name !== owner) {
      errors.push(error(source, `Authoritative profile name must equal lifecycle owner "${owner}".`, "Restore the profile's lifecycle name."));
    }
    for (const [server, configuration] of Object.entries(profile?.frontmatter?.mcpServers ?? {})) {
      if (!isRecord(configuration)) {
        errors.push(error(source, `MCP server "${server}" must be a mapping.`, "Restore the authoritative MCP declaration."));
        continue;
      }
      closedFields(configuration, ["type", "url", "tools"], source, errors);
      if (configuration.type !== "http" || typeof configuration.url !== "string" ||
          !configuration.url.startsWith("https://") || !Array.isArray(configuration.tools) ||
          !listField(configuration.tools)) {
        errors.push(error(source, `MCP server "${server}" requires an HTTPS HTTP endpoint and unique tools.`, "Restore the authoritative MCP declaration."));
        continue;
      }
      const previous = expectedMcp.get(server);
      if (previous && (previous.type !== configuration.type || previous.url !== configuration.url)) {
        errors.push(error(source, `Conflicting authoritative configurations for MCP server "${server}".`, "Align the authoritative server declarations."));
      }
      expectedMcp.set(server, { type: configuration.type, url: configuration.url });
    }
    if (!files.includes(file)) {
      errors.push(error(file, `Missing Claude wrapper for ${owner}.`, `Add ${file} pointing to ${source}.`));
      continue;
    }
    const wrapper = await readWrapper(repositoryRoot, file, errors);
    if (!wrapper || !profile?.frontmatter?.tools) {
      continue;
    }
    closedFields(wrapper.frontmatter, ["name", "description", "model", "tools"], file, errors);
    checkName(wrapper, owner, profile.frontmatter.description, errors);
    checkDefers(wrapper, source, "profile", errors);
    const model = wrapper.frontmatter.model;
    if (typeof model !== "string" || model !== model.trim() || !claudeModel.test(model)) {
      errors.push(error(file, `Model "${String(model)}" is not an exact Claude model ID.`, "Set model to an exact claude-* ID."));
    } else {
      models.set(owner, model);
    }
    const tools = listField(wrapper.frontmatter.tools);
    if (!tools) {
      errors.push(error(file, "Tools must be a non-empty list without empty or duplicate entries.", "Restore the exact mapped tool list."));
    }
    const granted = tools ?? [];
    const expected = expectedTools(profile.frontmatter.tools, source, errors);
    const extra = granted.filter((tool) => !expected.includes(tool));
    const missing = expected.filter((tool) => !granted.includes(tool));
    if (extra.length > 0 || missing.length > 0) {
      errors.push(error(file, `Tools must mirror ${source}; extra: [${extra.join(", ")}], missing: [${missing.join(", ")}].`, `Set tools to: ${expected.join(", ")}.`));
    }
    if (lifecycle.reviewers.some((reviewer) => reviewer.owner === owner) &&
        granted.some((tool) => tool === "Bash" || tool === "Agent")) {
      errors.push(error(file, "Reviewer wrappers must not grant Bash or Agent.", "Keep reviewer record-writing tools without execution or delegation."));
    }
    const phase = lifecycle.phases.find((entry) => entry.owner === owner);
    if (phase?.humanInvocableOnly && profile.frontmatter.disableModelInvocation !== true) {
      errors.push(error(source, `${owner} must remain human-invocable only.`, "Restore disable-model-invocation: true in the authoritative profile."));
    }
  }
  errors.push(...validateToolGrants(profiles, lifecycle).map((item) => ({ ...item, invariant })));
  const phaseOwnerModels = new Set(lifecycle.phases.map(({ owner }) => models.get(owner)));
  for (const reviewer of lifecycle.reviewers) {
    const model = models.get(reviewer.owner);
    if ((reviewer.id === "AFF-A" || reviewer.mustDifferFromPhaseOwner) && model && phaseOwnerModels.has(model)) {
      errors.push(error(`.claude/agents/${reviewer.owner}.md`, `${reviewer.owner} default model ${model} matches a phase owner.`, "Choose a reviewer default model that no phase-owner wrapper uses."));
    }
  }
  return models;
}

async function validateSkills(repositoryRoot: string, sources: string[], wrappers: string[], errors: ValidationError[]): Promise<void> {
  const expected = sources.map((source) => source.replace(/^\.github\//u, ".claude/"));
  for (const [index, file] of expected.entries()) {
    const source = sources[index] ?? "";
    if (!wrappers.includes(file)) {
      errors.push(error(file, `Missing Claude wrapper for skill ${source}.`, `Add ${file} pointing to ${source}.`));
      continue;
    }
    const wrapper = await readWrapper(repositoryRoot, file, errors);
    const profile = await readSource(repositoryRoot, source, "skill", errors);
    if (wrapper && profile?.frontmatter) {
      closedFields(wrapper.frontmatter, ["name", "description"], file, errors);
      checkName(wrapper, path.posix.basename(path.posix.dirname(file)), profile.frontmatter.description, errors);
      checkDefers(wrapper, source, "skill", errors);
    }
  }
}

function isMissingFile(caught: unknown): boolean {
  return caught instanceof Error && "code" in caught &&
    (caught.code === "ENOENT" || caught.code === "ENOTDIR" || caught.code === "EISDIR");
}

async function readJson(repositoryRoot: string, file: string): Promise<unknown> {
  try {
    const absolutePath = path.join(repositoryRoot, file);
    const stat = await lstat(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return undefined;
    }
    const text = await readFile(absolutePath, "utf8");
    const value: unknown = JSON.parse(text);
    // JSON.parse silently accepts duplicate keys; YAML's JSON-compatible parser does not.
    return parseDocument(text, { prettyErrors: false }).errors.length === 0 ? value : undefined;
  } catch (caught: unknown) {
    if (caught instanceof SyntaxError || isMissingFile(caught)) {
      return undefined;
    }
    throw caught;
  }
}

async function adapterPresent(repositoryRoot: string): Promise<boolean> {
  try {
    await lstat(path.join(repositoryRoot, ".claude"));
    return true;
  } catch (caught: unknown) {
    if (!isMissingFile(caught)) {
      throw caught;
    }
    return false;
  }
}

export async function readClaudeAdapterDefaults(
  repositoryRoot: string,
  lifecycle: LifecycleManifest,
): Promise<HostModelDefaults> {
  if (!await adapterPresent(repositoryRoot)) {
    return { models: new Map(), errors: [error(".claude", "The selected Claude host requires its adapter.", "Restore the complete Claude adapter; do not fall back to Copilot.")] };
  }
  const errors: ValidationError[] = [];
  const rootStat = await lstat(path.join(repositoryRoot, ".claude"));
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return { models: new Map(), errors: [error(".claude", "The adapter must be a real directory.", "Restore the committed adapter directory.")] };
  }
  const sources = (await fg(".github/skills/*/SKILL.md", { cwd: repositoryRoot, onlyFiles: true })).map(toRepositoryPath).sort();
  const expected = [
    ".claude/settings.json",
    ...[...lifecycle.phases, ...lifecycle.reviewers].map(({ owner }) => `.claude/agents/${owner}.md`),
    ...sources.map((source) => source.replace(/^\.github\//u, ".claude/")),
  ];
  const entries = (await fg(".claude/**/*", {
    cwd: repositoryRoot, onlyFiles: false, dot: true, followSymbolicLinks: false,
  })).map(toRepositoryPath).sort();
  const files: string[] = [];
  for (const file of entries) {
    const stat = await lstat(path.join(repositoryRoot, file));
    if (stat.isDirectory() && expected.some((item) => item.startsWith(`${file}/`))) {
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || !expected.includes(file)) {
      errors.push(error(file, "Unexpected adapter entry or symbolic link.", "Keep only the committed wrapper and settings files."));
    } else {
      files.push(file);
    }
  }
  try {
    const rules = path.join(repositoryRoot, "CLAUDE.md");
    const stat = await lstat(rules);
    if (!stat.isFile() || stat.isSymbolicLink() || !(await readFile(rules, "utf8")).trim()) {
      errors.push(error("CLAUDE.md", "The adapter rules must be a non-empty regular file.", "Restore CLAUDE.md."));
    }
  } catch (caught: unknown) {
    if (!isMissingFile(caught)) {
      throw caught;
    }
    errors.push(error("CLAUDE.md", "The adapter rules file is missing.", "Restore CLAUDE.md."));
  }
  const settings = await readJson(repositoryRoot, ".claude/settings.json");
  if (isRecord(settings)) {
    closedFields(settings, ["$schema", "permissions"], ".claude/settings.json", errors);
    if (settings.$schema !== "https://json.schemastore.org/claude-code-settings.json") {
      errors.push(error(".claude/settings.json", "Unexpected settings schema.", "Restore the committed settings schema URL."));
    }
  } else {
    errors.push(error(".claude/settings.json", "Settings must be a valid JSON object without duplicate keys.", "Restore the committed settings."));
  }
  const permissions = isRecord(settings) && isRecord(settings.permissions) ? settings.permissions : undefined;
  if (permissions) {
    closedFields(permissions, ["deny"], ".claude/settings.json", errors);
  } else {
    errors.push(error(".claude/settings.json", "permissions must be an object.", "Restore the committed deny configuration."));
  }
  const deny = permissions && Array.isArray(permissions.deny) ? listField(permissions.deny) ?? [] : [];
  for (const rule of requiredDenials.filter((denial) => !deny.includes(denial))) {
    errors.push(error(".claude/settings.json", `permissions.deny must contain "${rule}".`, "Approval and identity commands are human-only; deny them to every agent."));
  }
  if (deny.some((rule) => !requiredDenials.includes(rule))) {
    errors.push(error(".claude/settings.json", "permissions.deny must contain exactly the two required denial rules.", "Restore the approval and identity denial rules."));
  }
  const mcp = await readJson(repositoryRoot, ".mcp.json");
  const expectedMcp = new Map<string, { type: string; url: string }>();
  const models = await validateAgents(repositoryRoot, lifecycle, files, expectedMcp, errors);
  if (!isRecord(mcp) || !isRecord(mcp.mcpServers)) {
    errors.push(error(".mcp.json", "MCP configuration must contain a valid mcpServers object without duplicate keys.", "Restore .mcp.json."));
  } else {
    closedFields(mcp, ["mcpServers"], ".mcp.json", errors);
    closedFields(mcp.mcpServers, [...expectedMcp.keys()], ".mcp.json", errors);
    for (const [server, expectedServer] of expectedMcp) {
      const declared = mcp.mcpServers[server];
      if (!isRecord(declared)) {
        errors.push(error(".mcp.json", `MCP server "${server}" is missing or malformed.`, "Restore the authoritative server configuration."));
        continue;
      }
      closedFields(declared, ["type", "url"], ".mcp.json", errors);
      if (declared.type !== expectedServer.type || declared.url !== expectedServer.url) {
        errors.push(error(".mcp.json", `MCP server "${server}" must match the authoritative type and url.`, "Restore the authoritative server endpoint."));
      }
    }
  }
  await validateSkills(repositoryRoot, sources, files, errors);
  return { models: errors.length ? new Map() : models, errors };
}

export async function validateClaudeAdapter(
  repositoryRoot: string,
  lifecycle: LifecycleManifest,
): Promise<ValidationError[]> {
  if (!await adapterPresent(repositoryRoot)) {
    return [];
  }
  return (await readClaudeAdapterDefaults(repositoryRoot, lifecycle)).errors;
}
