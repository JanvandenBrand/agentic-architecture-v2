# AFF deterministic HTML renderer

`aff-render` creates portable HTML views from authoritative AFF Markdown and validated case records. It
does not use a model, browser runtime, CDN, remote asset, or network request.

## Commands

Render one phase from the repository root:

```powershell
npm run render -- phase --case cases\contoso-permit-services --phase 0 `
  --source 0-coordination\contoso-coordination.md `
  --metadata 0-coordination\contoso-input-inventory.json 0-coordination\contoso-model-plan.json `
  --output 0-coordination\contoso-coordination.html
```

Render one review round, before convergence or human approval:

```powershell
npm run render -- review --case cases\contoso-permit-services --phase 1 --reviewer AFF-A --round 1 `
  --source reviews\aff-a\1\round-1\contoso-aff-a-review.md `
  --metadata reviews\aff-a\1\round-1\contoso-aff-a-review.json `
  --output reviews\aff-a\1\round-1\contoso-aff-a-review.html
```

Use `AFF-B` and `aff-b` in the corresponding paths for the Security and Compliance Reviewer.
All three files must share the exact contracted basename and reviewer/phase/round directory.

Render the cumulative view after case validation and human approval:

```powershell
npm run render -- overview --case cases\contoso-permit-services
```

The equivalent built commands are `aff-render phase ...`, `aff-render review ...`, and
`aff-render overview ...`.

## Producer handoff and hashing order

1. The phase owner writes authoritative Markdown and catalogues. Owners without `execute` (AFF-1,
   AFF-2, AFF-4) return the case, phase, source/metadata paths, and exact HTML output path to AFF-0.
   AFF-0 executes `phase` rendering and returns the generated path/hash for the owner's fidelity check.
   Owners with `execute` may render their own phase through the same skill.
2. Record the complete candidate hashes, including phase HTML, before review.
3. Each reviewer writes the round's Markdown and JSON against those candidate hashes and returns
   reviewer, phase, round, and the three exact paths to AFF-0. AFF-0 executes `review` rendering without
   changing either authoritative source, then returns the output path/hash for reviewer fidelity checking.
   Reviewers never execute commands, dispatch another agent, or hand-write HTML.
4. Resolve findings, regenerate affected phase HTML, and repeat reviews as needed. Render both final
   reviews before the human gate; only after approval regenerate `solution-overview.html`.

Review rendering requires the canonical `0-coordination\<artifactPrefix>-model-plan.json`, validates
the declared contract, host/provider and active assignments, identity and subject hashes, but does not
run completed-case validation. A non-final or `DIVERGES` record is renderable; rendering is neither
approval nor evidence that both reviewers converged. Runtime model identity is not attested by rendering.
Never bind a review's own Markdown, JSON, or HTML in its `subjectArtifacts`, or edit JSON to add the
generated HTML hash. The HTML embeds hashes of the two sources and model plan, avoiding a circular hash.

Approval records bind the review JSON, not the separate reviewer Markdown/HTML files. The source
hashes embedded in review HTML describe the rendering inputs; `validateCase` does not compare those
HTML metadata hashes with current reviewer Markdown. Regenerate and check fidelity when a review
source changes. Do not present the separate narrative/view as independently signed approval evidence.

Phase metadata auto-discovery includes only catalogued AFF JSON paths in the phase source folder.
Ordinary application JSON (for example `package.json`) remains case evidence and can still be
hash-bound, but is not automatically treated as an AFF metadata record. Explicitly passing non-AFF
metadata fails rather than silently ignoring it.

Nonzero phase rendering also reads the Phase 0 identity anchors for consistent case name, prefix and
schema version. Those anchors are validation context, not displayed phase metadata; they need not be
repeated in `--metadata`. This does not require a completed case or human approval.

The exported API is `renderReviewHtml(options: RenderReviewOptions): Promise<void>`. Options are
`repositoryRoot`, repository-relative `casePath`, `phaseId`, `reviewer` (`AFF-A` or `AFF-B`), positive
integer `round`, case-relative `sourcePath`, `metadataPath`, `outputPath`, and optional
`requireVisualDiagrams`. Both the function and option type are exported from the package entry point.

## Contract compatibility

The renderer accepts schema contracts `1.0.0` and `1.1.0` using each record's exact declared version.
It does not upgrade source records, change signatures, invoke a model, or require either host CLI.
New cases use one declared host and one schema version; mixed versions or host changes fail case
validation. Existing Copilot evidence stays unchanged. See [AFF contracts](aff-contracts.md).

## Trust model

All case content is untrusted. The renderer:

- rejects raw HTML instead of silently removing required meaning;
- allows page anchors, contained local links, HTTPS links, and `mailto` links;
- rejects source `javascript:`, `data:`, `file:`, protocol-relative, and escaping paths;
- embeds contained PNG, JPEG, GIF, WebP, or validated static SVG assets;
- rejects SVG scripts, event handlers, styles, `foreignObject`, unsupported elements, and URL references;
- escapes Mermaid source and labels it as not visually rendered;
- sanitizes generated Markdown HTML with maintained parser and sanitizer libraries;
- embeds fixed CSS and, for overview tabs only, a small fixed script with no case-supplied code;
- declares a restrictive `Content-Security-Policy` meta element in every generated document, so a
  browser blocks remote loading, framing, form submission, and base-URI rewriting even if sanitisation
  were ever bypassed. Phase and review HTML use `script-src 'none'`; only the tabbed solution overview relaxes
  this to `'unsafe-inline'` for its fixed navigation script;
- validates case records and journal-to-approval hash bindings before an overview can look approved;
- writes through an atomic same-directory replacement.

Local source, metadata, assets, and output must remain inside the physical case directory. Symbolic-link
and junction escapes are rejected where the operating system exposes them.

## Limits

| Input | Limit |
| --- | ---: |
| Phase or review Markdown | 1 MiB |
| Each metadata JSON file | 512 KiB |
| Each embedded image | 5 MiB |
| Generated HTML | 10 MiB |

Link large evidence or code instead of embedding it. Inputs must be valid UTF-8. Images require
descriptive alternative text.

## Output and accessibility

Phase and review HTML include semantic landmarks, a skip link, stable phase-prefixed heading IDs, a generated
table of contents, visible keyboard focus, responsive and print styles, table headers, code labels, and
source SHA-256 metadata. Review HTML also displays the complete escaped structured review record.
The cumulative overview adds keyboard-operable tabs with explicit selected and
hidden state.

The HTML is a generated view. Markdown, catalogues, journal events, reviews, and approvals remain
authoritative.

## Failure remediation

- **Raw HTML or unsafe URL:** replace it with Markdown or a contained reviewed asset.
- **Unsafe SVG:** export a static basic-shape SVG without scripts, styles, links, or external references.
- **Mermaid visual required:** provide a reviewed static SVG; browser-side Mermaid execution is not used.
- **Stale hash:** do not edit reviewed evidence in place. Create the next review and approval records.
- **Containment failure:** remove traversal, symbolic links, or junctions and use a physical case file.
- **Atomic write failure:** correct output permissions or path type; no partial success page is retained.
