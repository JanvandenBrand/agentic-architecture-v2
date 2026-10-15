# Changelog

All notable user-visible changes are recorded here. Versions follow the separate contracts explained in
[`docs/release-process.md`](docs/release-process.md).

## [Unreleased]

## [1.3.0] - 2026-10-15

### Fixed

- Preserve each signed phase decision in its own file with exclusive publication instead of
  overwriting earlier decisions.
- Check decision readiness before signing; blocked reviewer verdicts and uncatalogued optional-phase
  authorisations do not become valid by collecting a signature.
- Derive approval-key identity from verified signature data and require verifiable predecessor-key
  authorisation for rotation; redundant fingerprint claims cannot bypass continuity.
- Validate entry and candidate chronology against historical prerequisite decisions and reopening
  events rather than accepting an approval added afterwards.
- Treat ordinary application/domain JSON as covered artifacts, retain misplaced AFF-record checks,
  and report malformed journal or encoding errors with actionable file diagnostics.
- Make case-prefix diagnostics independent of filesystem traversal order.

### Added

- Deterministic reviewer HTML rendering and an explicit AFF-0 rendering handoff for reviewers and
  phase owners that cannot execute commands. Reviewer tool grants remain unchanged.
- Regression coverage for immutable publication, signing readiness, key continuity, artifact loading,
  chronology, and reviewer rendering.

### Changed

- Tool package `1.3.0` and lifecycle `2.2.0`; schema contracts `1.0.0` and `1.1.0` are unchanged.
- Clarify mandatory CLI signing identity, human-reviewed binary-input conversion, initial-key trust,
  declared host permissions, and the difference between generated-evidence and policy-declaration
  smoke assertions. Zero model/Azure counters are by construction, not runtime measurements.
- Previously accepted invalid chronology and unverified rotation claims now fail closed. Do not edit
  old evidence to bypass a failure; see [tool upgrade guidance](docs/migrations/tool-1.2.0-to-1.3.0.md).

Live-host qualification and phase 7/8 authorisation contracts remain separate gates. This version
entry does not create a Git tag or published release.

## [1.2.0] - 2026-10-14

### Added

- Optional Claude Code packaging over the authoritative AFF profiles, with strict wrapper, tool,
  model-separation, and MCP configuration checks. Based on
  [JanvandenBrand's adapter contribution](https://github.com/JanvandenBrand/agentic-architecture-v2/tree/242ee17719e9d4bc7daa608004cc3d6118d60b00).
- Schema contract `1.1.0` alongside unchanged `1.0.0`, exact version/type selection, and a fixed host
  recorded by each new case's model plan and journal.
- Offline compatibility journeys for legacy Copilot, new-contract Copilot, and new-contract Claude.
- A documented Claude interview relay: AFF-1 authors questions and records decisions; AFF-0 passes
  questions and human answers unchanged.

### Changed

- Tool package `1.2.0` and lifecycle `2.1.0` add host compatibility without replacing existing Copilot
  defaults, workflow phases, or signed evidence.
- Repository validation discovers every test and runs on Windows and Ubuntu behind the stable
  `Repository validation` check.
- Live Claude behaviour remains explicitly unqualified until a human-authorised host qualification
  passes. Offline model labels are synthetic evidence, not proof of live model execution.

Existing cases need no conversion. See the [compatibility note](docs/migrations/1.0.0-to-1.1.0.md).

## [1.1.0] - 2026-09-04

### Added

- A `phase-sequence` contract invariant. Case validation now enforces lifecycle order from the records
  themselves: a phase cannot be entered, evidenced, or approved until its predecessor holds an approved
  human decision, and approval instants must follow lifecycle order.
- Fail-closed handling for Phase 7 and Phase 8 prerequisites that have no catalogued record type
  (`scoped-attempt-authorisation`, `scoped-test-attempt-authorisation`, and `phase-7-succeeded`).
- A `tool-least-privilege` invariant. Agent capability grants are now enforced: `read` is mandatory,
  only supported capabilities are accepted, every namespaced MCP grant must match a server and tool
  declared in the same profile, and **AFF-A and AFF-B may never hold `execute` or `agent`**.
- A restrictive `Content-Security-Policy` on every generated phase document and solution overview, so a
  browser blocks remote loading, framing, form submission, and base-URI rewriting even if sanitisation
  were bypassed. Phase HTML uses `script-src 'none'`.
- A `.gitattributes` file pinning text files to LF in the working tree on every platform.
- Approval assurance modes. Every approval declares `synthetic`, `self-asserted`, or `human-verified`
  in `extensions.approvalMode`, and the new `approval-mode` invariant rejects any declaration the
  recorded evidence does not support. The solution overview reports the resolved mode per phase.
- An executable assertion that the Contoso harness can only ever emit `synthetic` approval evidence.
- Signed human approvals. `npm run identity:create` creates one passphrase-protected Ed25519 key per
  architect, outside any case. `npm run approve -- --case <path> --phase <id>` presents the artifact
  hashes and both final reviewer verdicts, refuses decisions the evidence does not support, and writes a
  signed record. Approvals and rejections are both signed.
- Signature continuity: once a case holds a verified decision every later decision must also be verified,
  and a decision signed by a different key is rejected unless it records an explicit `keyRotation`.
- A per-machine approval policy. Creating an architect identity sets `requireSignedApprovals`, so an
  unsigned real decision is rejected on that machine. Without it an agent never needed to forge a
  signature: it could write an unsigned approval and have it accepted as `self-asserted`. Machines with
  no identity are unaffected, and synthetic harness evidence is always exempt.

### Changed

- The Contoso smoke harness now names the contract invariants that failed instead of reporting a
  generic validation message.
- Documentation now states plainly what an AFF approval proves: reviewer convergence on identical
  hashes and record integrity, but **not** who decided or that a human decided.
- Phase HTML states that it carries no approval of its own. Approval state and assurance live in
  `solution-overview.html`, because re-rendering a phase document after approval would change its hash
  and invalidate the approval bound to it.
- `latestApprovals` is defined once in `src/case/review-records.ts` instead of being reimplemented in
  both the approval and hash-binding validators.

### Fixed

- Skill-location validation ran once per agent Markdown file. A single misplaced skill produced twelve
  duplicate errors, and the check was skipped entirely when the agents directory held no Markdown.
- Windows checkouts rewrote text files to CRLF while the documentation generator emits LF, so
  `npm run docs:check` reported permanent false drift on the documented primary platform.

## [1.0.0] - 2026-09-04

### Added

- A ten-minute, offline architect evaluation path with explicit Copilot and Azure boundaries.
- Compatibility, support, troubleshooting, release, and migration guidance.
- Deterministic lifecycle-derived README and website roster generation with drift checks.
- A generated, verified Contoso Phase 0 evidence snapshot that is explicitly not a real approval.
- Practical installation and operating guidance on the self-contained public website.

### Changed

- Repository validation now checks generated adoption content and related accessibility/security
  invariants.
