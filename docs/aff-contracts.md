# AFF data contracts and validation

AFF contracts turn the operating rules into deterministic JSON Schema Draft 2020-12 records.
The schema catalogue is `schemas/aff/catalogue.json`. It supports `1.0.0` and `1.1.0`, with separate
schema directories and `1.1.0` as the default for new cases.

## Version policy

- Every structured AFF JSON or JSONL record carries `schemaVersion` and `recordType`.
- The schema version uses semantic versioning. A breaking field or meaning change increments the major
  version. Backwards-compatible additions use a minor version. Clarifications that do not change valid
  data use a patch version.
- A record is validated only against its exact catalogued version. Unsupported versions fail closed.
- Top-level record fields are closed with `additionalProperties: false`. Deliberate case-specific
  additions belong in the open `extensions` object.
- The lifecycle's existing `version` describes lifecycle content. `schemaVersion` describes its data
  shape; the two versions are independent.
- Catalogue entries are keyed by `schemaVersion` and `recordType`. A failed old-version record is never
  retried against a newer schema.
- Existing cases keep `1.0.0`; new cases use `1.1.0`. Do not mix versions within a case or rewrite old
  evidence to upgrade it. The repository lifecycle manifest is outside the case and retains its own
  `1.0.0` data shape.

## Host and model policy

Legacy `1.0.0` cases use GitHub Copilot and GPT models. Contract `1.1.0` requires `host` on the model
plan and every run-journal event: `github-copilot` or `claude-code`. The first event establishes the host;
the model plan and all later events must agree. Host changes within a case are rejected.

The selected host determines default models. Copilot uses the lifecycle manifest. Claude uses the
validated `.claude/agents/*.md` wrappers. This rollout permits GPT assignments on Copilot and Claude
assignments on Claude Code. A change from that host's default requires a human decision reference.
AFF-A must remain on a different model from every phase owner, and each reviewer record must match its
case assignment. A valid model-name prefix does not prove availability or runtime identity.

Case validation and rendering remain offline and do not require an installed host CLI. They check
record consistency, not the identity of the executing process. Live qualification and observed model
evidence are separate requirements. See [Claude Code](claude-code.md) and the
[compatibility note](migrations/1.0.0-to-1.1.0.md).

## Install and run

Use Node.js 22 or later from the repository root:

```powershell
npm ci
npm run validate -- --framework-only
```

Validate the framework and one local case:

```powershell
npm run validate -- --case cases/<case-name>
```

The case argument must be one direct child directory beneath `cases/`. Absolute paths, parent
traversal, and nested artifact paths are rejected.

Run the complete local quality sequence:

```powershell
npm test
npm run typecheck
npm run build
npm run validate -- --framework-only
```

Failures identify the file, the broken invariant, and the required correction. Exit code `1` means
contract validation failed. Exit code `2` means the validator could not run because a required file or
schema is unreadable or structurally invalid. Exit code `64` means the command-line arguments are
invalid.

## Canonical SHA-256 representation

Hash bindings use lower-case SHA-256 over these canonical bytes:

- JSON: parse the document and serialize it with deterministic JSON canonicalization, independent of
  indentation or property order.
- JSONL: canonicalize each non-empty JSON event, join events with LF, and end a non-empty journal with
  one LF.
- Text formats: UTF-8 without a byte-order mark, with CRLF and CR normalized to LF. Other whitespace is
  unchanged. Known source/document extensions are text; an unknown extension is treated as text only
  when it is valid UTF-8 and contains no NUL character.
- Binary formats: exact file bytes when the content is not classified as text by the rule above.

Paths in records use `/`, are relative to the case root, and cannot contain parent traversal. Editing
an artifact after review changes its canonical hash and invalidates the review and approval bindings.

## Phase sequence

The `phase-sequence` invariant enforces the lifecycle order against case records instead of trusting
agent behaviour. For every phase that has a human approval, an `ARTIFACTS-RECORDED` candidate, or a
`PHASE-ENTERED` journal event, the validator requires that:

- the preceding phase in `standardRoute` holds a latest human approval with decision `APPROVED`;
- every `approved-phase-<id>` entry in the phase's `requires` list holds the same;
- an approval instant is never earlier than the approval instant of a phase it depends on.

A phase therefore cannot be entered, evidenced, or approved before its predecessor is approved.

Phases 7 and 8 additionally declare `scoped-attempt-authorisation`, `scoped-test-attempt-authorisation`,
and `phase-7-succeeded`. These have no catalogued record type in contracts `1.0.0` or `1.1.0`, so the validator
cannot verify them and **fails closed**: entering Phase 7 or Phase 8 reports a `phase-sequence` error
until the prerequisite is either catalogued as a case record or removed from
`.github/agents/AFF-LIFECYCLE.json`.

## Approval assurance modes

An approval record declares the assurance it carries in `extensions.approvalMode`:

| Mode | Meaning |
|---|---|
| `synthetic` | Generated by the offline harness. No human decision was made. |
| `self-asserted` | A human recorded the decision, but the approver's identity was not verified. |
| `human-verified` | The approver signature verifies against the case approval key. |

The `approval-mode` invariant enforces one rule: **the declared mode must match the mode the recorded
evidence supports.** The validator resolves the mode from evidence and never reads the declaration when
deciding what is true — a claim is the thing being checked, not the check. Declaring
`human-verified` without verifiable evidence is therefore a validation failure, not a stronger approval.

An absent declaration is treated as `self-asserted`, the weakest claim, so omission can never overstate
assurance.

Rendered views derive the displayed assurance the same way. `solution-overview.html` reports it per
phase. Phase HTML is generated before review and approval exist — and adding approval state to it later
would change its hash and invalidate the approval bound to it — so a phase document instead states that
it carries no approval of its own.

## Approver identity

The architect creates one Ed25519 key pair, once, outside any case:

```powershell
npm run identity:create
```

The private key is written to `%USERPROFILE%\.aff\identity\architect.key`, encrypted with a passphrase
that is **never stored**. The label chosen at creation travels with every decision that key signs, so the
approver is not retyped per approval. The key lives outside the case and outside the work area agents are
contracted to, so an agent touching it is an unmistakable contract violation.

Record a decision with:

```powershell
npm run approve -- --case cases/<case-name> --phase <id>
```

Run it yourself, in your own terminal, **outside any agent session**. It prints the artifact hashes, both
final reviewer verdicts, and the reviewer records; refuses to offer a decision the evidence does not
support; then asks for the passphrase and writes a signed record. Approvals and rejections are both
signed — a decision is a decision.

The signature covers the canonical JSON of the whole approval record with only `extensions.signature`
removed, so the phase, decision, approver, decision time, artifact hashes, reviewer records, key
fingerprint, and declared mode are all protected. Signing the artifact hashes alone would let a valid
signature be lifted onto a modified record.

Two continuity rules follow:

- **No downgrade.** Once a case holds a verified decision, every decision recorded from that moment must
  also be verified.
- **One key per case.** A decision signed by a different key than the case is anchored to is rejected
  unless it records an explicit `extensions.keyRotation` naming the previous fingerprint and the reason.
  A forgotten passphrase cannot be cryptographically bridged, so a rotation is a visible break in the
  chain rather than a silent substitution.

> **What this does not do.** Verification is not access control. An agent may still write an approval
> file; it simply cannot produce a valid signature without the passphrase, so its record fails
> validation. Two limits remain, and are accepted deliberately: a human who types the passphrase on an
> agent's request has delegated their authority, which is not forgery; and a machine that has never held
> an approval key has no expectation to measure against, so `self-asserted` remains legitimate there.
> The control moves forgery from writing one JSON file to obtaining a passphrase that is never stored.

## Machine approval policy

Creating an architect identity also sets a policy on that machine: **a real human decision must be
signed.** `requireSignedApprovals` is written into `architect.pub` as `true`, and validation reads it.

This closes the remaining gap. Without it, an agent never needed to forge a signature — it could simply
write an *unsigned* approval and have it accepted as `self-asserted`, because that mode is legitimate.
With a key present, an unsigned real decision becomes a validation failure, so there is no route to a
valid approval on your machine that does not pass through your passphrase.

The policy degrades correctly rather than spreading:

- **A machine with no identity** — continuous integration, the offline evaluation, a colleague trying the
  framework — has no policy, so `self-asserted` still validates and the ten-minute quick start is
  unaffected.
- **Synthetic harness evidence is always exempt.** It never claims to be a human decision, so it is not
  measured against one.
- **A truncated or damaged identity file reads as the stricter policy**, so the protection cannot be
  quietly lost by corruption.

Removing the policy is a deliberate edit to your own identity file. It is not a step any failure ever
pushes you towards, which is why the policy lives on the machine rather than in per-case bookkeeping that
would raise false alarms on renames, restores, and second machines.

## Schema catalogue

| Record | `recordType` | Contracted location |
|---|---|---|
| Lifecycle manifest | `lifecycle-manifest` | `.github/agents/AFF-LIFECYCLE.json` |
| Input inventory | `input-inventory` | `0-coordination/*-input-inventory.json` |
| Model plan | `model-plan` | `0-coordination/*-model-plan.json` |
| Interview decisions | `interview-decisions` | `1-requirements/*-interview-decisions.json` |
| Requirements catalogue | `requirements-catalogue` | `1-requirements/*-requirements-catalogue.json` |
| Architecture catalogue | `architecture-catalogue` | `2-togaf-architecture/*-architecture-catalogue.json` |
| Azure design catalogue | `azure-design-catalogue` | `3-azure-design/*-design-catalogue.json` |
| Implementation catalogue | `implementation-catalogue` | `4-implementation-plan/*-implementation-catalogue.json` |
| Release manifest | `release-manifest` | `5-coding/*-release-manifest.json` |
| Claim catalogue | `claim-catalogue` | `6-presentation/*-claim-catalogue.json` |
| Deployment attempts | `deployment-attempts` | `7-deployment/*-deployment-attempts.json` |
| Test catalogue | `test-catalogue` | `8-testing/*-test-catalogue.json` |
| AFF-A/AFF-B review | `review-record` | `reviews/aff-a|aff-b/<phase>/round-<n>/*.json` |
| Human approval | `human-approval` | `approvals/phase-<id>/*.json` |
| Regulatory coverage | `regulatory-coverage` | `reviews/aff-b/*-compliance-coverage.json` |
| Run-journal event | `run-journal-event` | case-root `*-run-journal.jsonl` |

The authoritative phase narratives, human decisions log, risk log, and regulatory register remain
compact Markdown by operating-contract design; they are not JSON records. Phase HTML is a generated
view and is deferred to the secure renderer in Plan 1C. Open-ended evidence files are not a single
record type. If a future profile promises a stable JSON shape, it must receive a versioned schema and
catalogue entry before use. Arbitrary JSON supplied beneath `input/` is treated as untrusted source
material and receives syntax validation only.
