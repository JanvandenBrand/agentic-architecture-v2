# Claude Code adapter

## Status

The adapter has offline configuration and record checks. **Live Claude behaviour is not
runtime-qualified.** Claude Code `2.1.263` is the first qualification target, not a supported version
range. Do not use real customer cases until the separate live qualification passes.

Authoritative instructions stay in `.github/agents` and `.github/skills`. The `.claude` wrappers
contain metadata and exact pointers, not a fork of the phase instructions. The operating contract
always takes precedence over host-specific guidance.

## Offline checks

From the repository root:

```powershell
npm ci --no-audit --no-fund
npm run validate -- --framework-only
npm run smoke:contoso
npm run smoke:contoso -- --host github-copilot --schema-version 1.1.0
npm run smoke:contoso -- --host claude-code --schema-version 1.1.0
```

The original smoke is the legacy Copilot regression fixture. The other commands exercise new-contract
synthetic records. None invokes a live model, accesses Azure, or records real human approval.

## Host and model selection

New cases use schema `1.1.0`. Confirm `claude-code` in the model plan and every journal event.
Existing `1.0.0` cases stay on Copilot. Do not switch hosts or mix schema versions within a case.
The first journal event fixes the host; the model plan and every later event must agree.
Preserve existing evidence without migration, normalisation, re-signing, or rewriting.

The checked wrappers declare the repository defaults: `claude-opus-5-5` for phase owners and AFF-B,
and `claude-sonnet-5-5` for AFF-A. The generated README roster reads these defaults directly.
A human-confirmed change needs an `approvalReference` in the case model plan. AFF-A must remain
different from every phase owner. Reviewer records must match the case assignments.

An accepted model-name prefix proves syntax only. Confirm actual availability and the observed
runtime model using operator-visible host evidence, comparing each expected case assignment with the
observed coordinator, phase-owner, and reviewer model. A prompt asking a model to name itself is not
attestation. Stop on missing evidence, a mismatch, or an unavailable assignment; do not fall back
silently. Offline schema and case validation establish record consistency, not runtime attestation
or proof of which executable produced a record.

## Main-session coordination

After human authorisation for a synthetic live qualification:

```powershell
claude --version
claude --agent AFF-0-coordinator
```

AFF-0 runs as the main conversation. Nesting and tool restrictions depend on the qualified Claude Code
version; do not rely on a blanket claim that subagents cannot delegate.

AFF-1 remains the interview author. It returns one question with its stable decision ID to AFF-0.
AFF-0 presents the question and choices unchanged, waits for the human, and sends the exact answer
and ID back to AFF-1. AFF-0 does not answer, reinterpret the response, or decide the next question.
Only AFF-1 writes the interview decision record. Cancellation, silence, and an interrupted session
are not consent. Resume from the recorded evidence rather than assuming a transient subagent still exists.
Use ordinary main-conversation interaction; do not add or assume subagent `AskUserQuestion`, command
execution, or delegation capabilities for AFF-1.

Persist the stable ID, authored question, and exact human answer in the existing `interview-decisions`
fields `decisions[].id`, `decisions[].question`, and `decisions[].answer`. Keep interpretation in
`rationale` and append corrections to `corrections`, never replacing earlier evidence.
An unanswered material decision remains open; never invent an answer or human confirmation.

## Permissions and human decisions

Reviewer wrappers have no `Bash` or `Agent` grant. Their editing tools exist only for their own
review records. MCP configuration must match the shared profiles.
AFF-0 renders their review HTML from the authored Markdown and JSON, and renders phase HTML for
owners that cannot execute commands. This operator role does not transfer authorship or review
authority. See the [renderer commands](aff-renderer.md).

Committed settings deny the approval and identity npm command patterns. These are safeguards, not
an operating-system security boundary or proof that every alternative invocation is blocked.
Inspect effective project/local, user, and enterprise settings during qualification; each can alter
runtime behaviour despite the committed configuration checks.

The human closes the agent session and runs signing in their own terminal. An agent must never
request the passphrase, access the private key, or treat an unsigned/synthetic record as verified
human approval. Deployment and runtime testing retain their separate optional-phase gates.
AFF-0 must never automatically dispatch AFF-7 or AFF-8. Both remain human-invocable only, and their
currently uncatalogued pre-execution authorisations remain blocked.
That record-level block does not prove the host cannot dispatch an optional agent. Copilot's
declared invocation flags and Claude's current wrapper/prompt rules must each be checked in a live
qualification; do not assume identical runtime enforcement.

## Live host qualification

This gate requires separate human authorisation for paid model calls, account access, and signing.
It has **not been completed** by the offline implementation.

Record a sanitised result for each check:

1. CLI version, platform, effective configuration sources, model entitlement, and exact available IDs.
2. Discovery of all 11 agents and both skills, with evidence that the authoritative files were read.
3. Expected case assignments versus operator-visible observed coordinator, author, and reviewer
   models; missing identity evidence and the unavailable/mismatched-model paths must stop. Model
   self-report does not count as evidence.
4. Effective reviewer tool and MCP grants, and the limits of the approval/identity denial patterns.
5. An interview round trip, correction, cancellation, and restart with question IDs and answers preserved.
   Include the AFF-0 rendering handoff for a restricted phase owner and both reviewer HTML records.
6. Human-only approval outside the agent session, followed by successful validation, rendering, and resume.
7. A representative Copilot journey confirming its unchanged defaults and interaction.

Use a synthetic case. Keep detailed runtime evidence local; do not commit identities, account details,
passphrases, or customer content. A failed or unexecuted check leaves live support unqualified.
The existing uncatalogued authorisations for phases 7 and 8 remain outside this change.

## Sources and attribution

- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code skills](https://code.claude.com/docs/en/skills)
- [Claude Code permission limits](https://code.claude.com/docs/en/permissions)
- [Adapter contribution](https://github.com/JanvandenBrand/agentic-architecture-v2/tree/242ee17719e9d4bc7daa608004cc3d6118d60b00),
  adapted under Apache-2.0.
- [Version compatibility](migrations/1.0.0-to-1.1.0.md)
