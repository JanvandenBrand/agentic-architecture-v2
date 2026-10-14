# Claude Code host adapter

## Status and authority

This optional adapter is configuration-validated, not runtime-qualified. Claude Code 2.1.263 is
a qualification target, not evidence of a successful AFF journey. Do not start real Claude cases
until human-authorised runtime qualification passes.

The operating contract `.github/agents/AFF-OPERATING-CONTRACT.md`, lifecycle
`.github/agents/AFF-LIFECYCLE.json`, agent profiles, and `.github/skills/*/SKILL.md` are authoritative.
This file maps host tools and interaction; it cannot reinterpret or override the shared policy.
A conflict blocks work; it is not permission to substitute a host, model, schema version, or
unsigned approval.

The `.claude/agents/` and `.claude/skills/` wrappers contain only metadata and exact pointers to those
sources and this file. `npm run validate -- --framework-only` checks the adapter when present.
Copilot-only copies can omit `.claude`; selecting Claude without a valid adapter must fail.

## Qualification target

After the separate qualification gate, the proposed entry point is
`claude --agent AFF-0-coordinator` from the repository root. AFF-0 must be the main conversation,
not a nested subagent. Nesting and tool availability depend on the qualified host version.
AFF-1 owns the interview.

### Interview round trip

1. AFF-1 authors one question with its stable decision ID and any choices, then returns it to AFF-0.
2. AFF-0 presents the question and any choices unchanged in the main conversation and waits.
3. AFF-0 does not answer it, reinterpret the answer, or conduct the interview.
4. After the human responds, AFF-0 returns the exact answer and decision ID to AFF-1.
5. Only AFF-1 updates the interview decision record and chooses the next question.

Use ordinary main-conversation interaction. Do not assume `AskUserQuestion` is exposed to subagents,
or grant AFF-1 command execution or delegation just to surface a question. Persist stable IDs,
questions, and exact answers in the existing `interview-decisions` shape: `decisions[].id`,
`decisions[].question`, and `decisions[].answer`. Interpretation belongs in `rationale`; append
corrections to `corrections` without rewriting history. Resume from those records, not transient
subagent identifiers. No response, cancellation, or an interrupted session is not consent.
Leave unanswered material decisions open; do not fabricate an answer or human confirmation.

AFF-0 must never automatically dispatch AFF-7 or AFF-8. These remain optional, human-invocable-only
phases with the existing explicit, attempt-bound authorisation and evidence requirements. Finishing
Phase 6 is not deployment authorisation. Routing language in other profiles does not waive these gates.
Their currently uncatalogued pre-execution authorisations remain blocked.

## Case contract

New cases on either host use `1.1.0`. Record `host` in the model plan and every run-journal event;
the first event fixes the host and all later events and the model plan must agree. Existing `1.0.0`
cases retain implicit `github-copilot` and unchanged evidence. Do not mix case versions, change hosts,
migrate, normalise, re-sign, or rewrite existing evidence.

## Models

Claude defaults are read from validated wrapper `model` fields: `claude-opus-5-5` for AFF-0 through
AFF-8 and AFF-B; `claude-sonnet-5-5` for AFF-A. Copilot defaults remain in the lifecycle/profile
combination and are not replaced. Human-confirmed per-case assignments are authoritative; a departure
from the selected host's defaults needs the existing `approvalReference`.

AFF-A must differ from every phase-owner assignment. Reviewer records must match the active case
assignments. A `claude-*` prefix only establishes syntax, not availability or observed identity.
Compare the expected case assignment with operator-visible host evidence of the observed runtime
model for the coordinator, phase owners, and reviewers. Verify entitlement, exact model availability,
dispatch selection, and runtime identity during qualification. Model-generated self-identification
is not attestation. On missing evidence, mismatch, or unavailability, stop without fallback.
Offline schema and case validation establish internal consistency, not runtime attestation or proof
of which executable produced the records.

## Tools and configuration boundary

| Authoritative capability | Claude tools |
|---|---|
| `read` | `Read` |
| `search` | `Grep`, `Glob` |
| `edit` | `Edit`, `Write` |
| `execute` | `Bash` |
| `web` | `WebFetch`, `WebSearch` |
| `agent` | `Agent` |
| `todo` | `TodoWrite` |
| Declared `<server>/<tool>` | `mcp__<server>__<tool>` |

Wrappers grant exactly the mapped profile capabilities. Reviewers retain writing tools only to
write their own records; they must not edit the subject, execute commands, or dispatch agents.
They receive neither `Bash` nor `Agent`. The committed `.mcp.json` server set, HTTP type and URL
must match the authoritative profiles; credentials, extra servers, and configuration overrides
are not part of this adapter.

The human runs `npm run identity:create` and `npm run approve` in their own terminal with no agent
session running. Never ask for, accept, repeat, or access the approval passphrase or private key.
`.claude/settings.json` denies the corresponding npm command patterns. These checks validate committed
configuration, not every user-level setting or alternative program invocation. Denial patterns,
tool lists, and prompt instructions are not an operating-system security boundary. Qualification
must inspect effective host permissions, including project/local, user, and enterprise settings that
can alter runtime behaviour, and separately enforce any required isolation.

Shell examples in shared documentation use PowerShell. Do not mechanically translate commands,
especially cleanup commands, into broader recursive operations. Use the explicitly approved
procedure for the actual shell and platform.

## Attribution

Adapter packaging, tool mapping, validator structure, and test helpers were adapted from
[JanvandenBrand/agentic-architecture-v2 at 242ee17719e9d4bc7daa608004cc3d6118d60b00](https://github.com/JanvandenBrand/agentic-architecture-v2/tree/242ee17719e9d4bc7daa608004cc3d6118d60b00),
under the repository's Apache-2.0 licence. The source was retrieved read-only; its policy-translation
claim was not adopted. Local changes harden wrapper/configuration checks and separate host defaults.
