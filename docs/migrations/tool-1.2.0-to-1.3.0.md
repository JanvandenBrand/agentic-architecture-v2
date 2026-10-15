# Tool 1.2.0 to 1.3.0

This is a tool and lifecycle update, not a schema migration. Tool `1.3.0` keeps schema contracts
`1.0.0` and `1.1.0` unchanged. Lifecycle `2.2.0` adds explicit AFF-0 rendering handoffs without
granting execution or delegation to reviewers.

## What changes

- New signed decisions get immutable individual files instead of replacing the previous decision.
  Exclusive hard-link publication is required; unsupported filesystems fail without replacing-write
  fallback. Use the published filename returned by the command, not the former fixed phase filename.
- Approval readiness is checked before signing; blockers and unsupported phase 7/8 prerequisites
  cannot be waived by the command.
- Key identity comes from verified signature data. A different key needs a verifiable predecessor
  authorisation, not just a rotation statement. Lost-key recovery is not automated.
- Phase entries and candidate events must have an approved prerequisite at their recorded time.
  Later approval does not legitimise earlier work; upstream changes require fresh approval.
- Ordinary application/domain JSON is evidence rather than an AFF record unless a catalogue path
  or recognised AFF type identifies it. Its hash and coverage obligations remain.
- Case identity is anchored to consistently named Phase 0 inventory/model-plan records. Missing or
  conflicting anchors are reported as ambiguous rather than guessing from file order.
  Later-phase rendering now also requires those readable, schema-valid anchors.
- Review HTML is generated through the renderer by AFF-0 from reviewer-authored Markdown/JSON.
  The approval binds review JSON only; separate review Markdown/HTML are not independently
  hash-bound by case validation. Embedded source hashes describe the rendering inputs, not a new
  signature over the narrative.

## Existing cases

Do not migrate or rewrite case files, signatures, journal events, or historical schemas.
Valid histories remain readable. Previously accepted invalid chronology or unsupported rotation
claims now fail closed; this is an intentional acceptance tightening, not a request to alter evidence.
Retain the original history and refer the failure to the accountable architect.

The initial case key must still be verified by the human through a trusted channel. This update
does not introduce an external identity authority or prove the integrity of a replaced entire history.

## Verify the upgrade

Run with no real signing or live host invocation:

```powershell
npm ci --no-audit --no-fund
npm test
npm run docs:check
npm run typecheck
npm run build
npm run validate -- --framework-only
npm run smoke:contoso
npm run smoke:contoso -- --host github-copilot --schema-version 1.1.0
npm run smoke:contoso -- --host claude-code --schema-version 1.1.0
npm run validate -- --case cases\<case-name>
```

The final command reads your selected case; it does not repair it. Agent sessions must never request
your signing passphrase. Keep new evidence local and obtain human review through the existing process.

The smoke still writes a fixed synthetic approval fixture directly. Immutable real-decision
publication and concurrency are exercised separately by `test/approval-integrity.test.ts`; do not
cite the smoke alone as proof of those writer controls.

## Rollback and limitations

Keep an untouched copy of the original evidence and the tool version used to evaluate it. Do not
downgrade record versions or use an old validator's acceptance to override a newly discovered control
failure. If the new validation blocks a case, stop its progression while the finding is reviewed.

Live Claude qualification and phase 7/8 authorisation contracts remain separate, uncompleted gates.
Creating this version does not publish a release, deploy anything, or authorise paid model calls.
