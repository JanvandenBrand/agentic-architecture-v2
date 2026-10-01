# Claude Code host

AFF agents are written for GitHub Copilot. The optional Claude Code adapter runs the same agents
without changing them: `.claude/` holds thin wrappers that point to the `.github` profiles, and
[`CLAUDE.md`](../CLAUDE.md) translates host-specific wording.

> **Status:** packaging is verified by framework validation. Real cases are **blocked**: the 1.0.0
> schemas accept only `gpt-*` model IDs, so a case that truthfully records Claude models fails
> `npm run validate -- --case`. Use the adapter for evaluation until the schema contract changes.

## Prerequisites

- The offline path from the [quick start](quick-start.md) passes.
- Claude Code is installed and signed in, with access to the models in the table below.

## What the adapter contains

| Path | Purpose |
|---|---|
| `.claude/agents/<agent>.md` | One wrapper per lifecycle agent: name, description, default model, mapped tools |
| `.claude/skills/<skill>/SKILL.md` | One wrapper per `.github` skill |
| `.claude/settings.json` | Denies `npm run approve` and `npm run identity:create` to every agent |
| `.mcp.json` | Microsoft Learn MCP server, matching the profiles |
| `CLAUDE.md` | Model, tool, and shell translation rules |

`npm run validate -- --framework-only` checks the adapter whenever `.claude/` exists. A wrapper must
defer to its profile, grant exactly the profile's mapped tools, and use an exact `claude-*` model.

## Check discovery

From the repository root:

```bash
claude --agent AFF-0-coordinator -p "State only your agent profile name and model ID. Do not read or modify files."
```

In an interactive session, `/agents` lists all eleven AFF agents.

## Choose reviewer models

AFF-A (rubber duck) and AFF-B (security and compliance) models are configurable at two levels.

| Level | Where | When |
|---|---|---|
| Repository default | `model:` line in `.claude/agents/AFF-A-rubber-duck.md` or `AFF-B-security-compliance.md` | Applies to every new case |
| Per case | Phase 0 model plan, chosen by the human when AFF-0 asks | Applies to that case only |

Defaults: phase agents and AFF-B use `claude-opus-5-5`; AFF-A uses `claude-sonnet-5-5`.

Rules that hold at both levels:

- AFF-A must never share a model with any phase owner. Validation rejects a repository default that
  does, and the case validator rejects a model plan that does.
- A per-case change needs an `approvalReference` to the human's recorded decision.
- An unavailable model, or a reviewer whose runtime model differs from its assignment, blocks the gate.

After changing a repository default, run `npm run validate -- --framework-only`.

## Run a case

Once the schema contract accepts Claude model IDs:

1. Create your approval identity in your own terminal: `npm run identity:create`.
2. `mkdir -p cases/<case-name>/input` and add the brief, starting from
   `cases/_template/input/architecture-brief.md`.
3. Start AFF-0 as the main session: `claude --agent AFF-0-coordinator`.
4. After both reviews converge, close the agent session and approve in your own terminal:

   ```bash
   npm run approve -- --case cases/<case-name> --phase 0
   npm run validate -- --case cases/<case-name>
   ```

5. Repeat for each phase. Never type your passphrase into an agent session.
