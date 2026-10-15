---
name: render-case-html
description: Use when an AFF phase document or cumulative case overview must be rendered as safe self-contained HTML without changing authoritative source meaning.
---

# render-case-html

Read `.github/agents/AFF-OPERATING-CONTRACT.md` and `.github/agents/AFF-LIFECYCLE.json`. HTML is a
generated view; Markdown, catalogues, journal events, and review records remain authoritative. Use the
deterministic `aff-render` implementation through `npm run render -- ...`; do not transform AFF content
into HTML through prose generation.

## Phase rendering

The owner returns case, phase ID, authoritative Markdown, metadata, and exact HTML output path to
AFF-0. AFF-0 executes the renderer and returns the generated path/hash for the owner's fidelity check,
then records the complete candidate hashes including phase HTML. This is the required producer handoff
for AFF-1, AFF-2, and AFF-4, which lack `execute`; owners with `execute` may render their own phase.
Do not wait for review convergence or human approval. Rendering does not transfer authorship.

For the current phase, run the renderer with the authoritative Markdown and structured records:

```powershell
npm run render -- phase --case cases\<case-name> --phase <id> `
  --source <phase-folder>\<artifactPrefix>-<artifact>.md `
  --metadata <phase-folder>\<artifactPrefix>-<catalogue>.json `
  --output <phase-folder>\<artifactPrefix>-<artifact>.html
```

The renderer verifies canonical hashes in structured metadata, enforces case containment and input
limits, rejects raw HTML and unsafe URLs, embeds only approved local image types, and writes atomically.
Mermaid is shown as escaped accessible source with an explicit warning. If a visual diagram is a
required completion condition, provide a reviewed static SVG or use `--require-visual-diagrams` to fail
closed.

Do not add claims, summaries, decisions, or status that are absent from authoritative sources. A source
change makes the rendered HTML stale and requires regeneration.

Automatic phase metadata discovery considers only catalogued AFF record paths in the phase folder.
Application JSON remains evidence, not renderer metadata; explicitly supplied non-AFF JSON fails.

## Review rendering

Reviewers write only their authoritative Markdown and JSON. They return case, reviewer, phase ID,
round, both source paths, and the exact matching HTML output path to AFF-0. AFF-0 runs:

```powershell
npm run render -- review --case cases\<case-name> --phase <id> --reviewer AFF-A --round <n> `
  --source reviews\aff-a\<id>\round-<n>\<artifactPrefix>-aff-a-review.md `
  --metadata reviews\aff-a\<id>\round-<n>\<artifactPrefix>-aff-a-review.json `
  --output reviews\aff-a\<id>\round-<n>\<artifactPrefix>-aff-a-review.html
```

For AFF-B, use `--reviewer AFF-B` and `aff-b` in all three paths. AFF-0 returns the generated path/hash
for the reviewer's fidelity check before the human gate. Reviewers never gain `execute` or `agent`,
dispatch the renderer themselves, or hand-write fallback HTML.

The renderer checks the canonical Phase 0 model plan, source identity, matching reviewer/phase/round,
schema version, prefix, contained paths, and subject hashes. It uses the same safe Markdown pipeline
as phase rendering. It accepts non-final and `DIVERGES` rounds: convergence and human approval happen
later. It never modifies the review Markdown or JSON.

Order: render phase HTML, record candidate hashes, write reviewer Markdown/JSON against that candidate,
then render review HTML. Never include the review's own Markdown, JSON, or HTML in `subjectArtifacts`,
and never edit JSON to bind the generated page. HTML contains source hashes, not a circular self-hash.

## Solution overview

AFF-0 uses this mode only after human approval:

```powershell
npm run render -- overview --case cases\<case-name>
```

This mode validates the case first, derives invoked and reopened state only from validated journal
events, verifies that journal decision hashes match the human approval record, preserves approved phase
content, shows separate AFF-A and AFF-B review tabs, and writes the atomic case-root
`solution-overview.html`.

## Failure conditions

Stop and report the renderer error when an authoritative source is missing, hashes do not match,
required content cannot be rendered safely, SVG sanitisation fails, a limit is exceeded, or phase state
cannot be resolved from the journal. Never hand-write a fallback page or produce success-looking output
from incomplete evidence. See `docs/aff-renderer.md` for the trust model and remediation guidance.
