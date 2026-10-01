# Claude Code host adapter

This repository is written for GitHub Copilot. These rules let Claude Code run the same AFF agents
without changing them. They translate host-specific wording only; they never relax a rule.

## Authority

1. `.github/agents/AFF-OPERATING-CONTRACT.md`, `.github/agents/AFF-LIFECYCLE.json`, and the
   `.github/agents/*.agent.md` and `.github/skills/*/SKILL.md` profiles are authoritative.
2. `.claude/agents/` and `.claude/skills/` hold thin wrappers that point to those files. Never put
   instructions in a wrapper. `npm run validate -- --framework-only` checks every wrapper.
3. Where this file and a profile disagree on anything other than host wording, the profile wins.

## Start a case

Run `claude --agent AFF-0-coordinator` from the repository root. AFF-0 runs as the main session so it
can dispatch phase agents and reviewers as subagents; Claude Code subagents cannot dispatch further
subagents. Do not start with AFF-1.

## Models

Read "GPT model" in any profile as "the Claude model assigned to that agent". Every other model rule
still applies, including exact model IDs, recorded availability, and human approval of any change.

Defaults are the `model:` line in each `.claude/agents/<agent>.md` wrapper:

| Agent | Default model |
|---|---|
| AFF-0 to AFF-8, AFF-B | `claude-opus-5-5` |
| AFF-A | `claude-sonnet-5-5` |

The validator rejects a wrapper default that is not an exact `claude-*` ID, and an AFF-A default
shared with any phase owner.

### Reviewer model selection

AFF-A and AFF-B models are chosen per case in Phase 0:

1. AFF-0 shows the human the default AFF-A and AFF-B models and asks whether to keep or change them.
2. AFF-0 records the human's choice in the Phase 0 model plan. A model that differs from the default
   carries an `approvalReference` to the recorded human decision. AFF-0 never chooses on the human's
   behalf.
3. When dispatching AFF-A or AFF-B, AFF-0 passes the model-plan model as the subagent model.
4. Stop and report a blocker if the chosen model is unavailable, or if AFF-A would share a model with
   any phase owner.
5. A reviewer confirms that its own runtime model ID matches its model-plan assignment before
   reviewing. On a mismatch it refuses and blocks the gate.

### Known limitation

The 1.0.0 schemas for `model-plan`, `review-record`, and `lifecycle-manifest` accept only `gpt-*`
model IDs. A case model plan or review record that truthfully records a Claude model therefore fails
`npm run validate -- --case`. Never record a GPT model ID for work a Claude model did. Until the schema
contract accepts Claude model IDs, stop at the Phase 0 model plan and report the blocker.

## Tools

| Profile tool | Claude Code tools |
|---|---|
| `read` | `Read` |
| `search` | `Grep`, `Glob` |
| `edit` | `Edit`, `Write` |
| `execute` | `Bash` |
| `web` | `WebFetch`, `WebSearch` |
| `agent` | `Agent` |
| `todo` | `TodoWrite` |
| `<server>/<tool>` | `mcp__<server>__<tool>` |

Wrappers grant exactly the mapped tools of their profile, so reviewers never get `Bash` or `Agent`.
`.mcp.json` declares the Microsoft Learn server with the same type and URL as the profiles.

## Shell

Commands in the documentation use Windows PowerShell. In bash, use `/` path separators
(`cases/<case-name>`), `cd`, `cat`, `mkdir -p`, and `rm -rf` for the equivalent steps.

## Human-only actions

- `npm run identity:create` and `npm run approve` are run by the human, in their own terminal, with
  no agent session running. `.claude/settings.json` denies both to every agent.
- Never ask for, accept, or repeat the approval passphrase.
- Phases 7 and 8 are never routed automatically.
