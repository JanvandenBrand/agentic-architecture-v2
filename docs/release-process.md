# Release process

AFF uses `v1.0.0` as its initial repository release line. A changelog entry alone does not create the
corresponding GitHub tag or release. The repository tool package is `1.3.0`, the lifecycle is `2.2.0`,
and the schema write default is `1.1.0`, with `1.0.0` still supported. These versions describe different
contracts and must not be collapsed into one number.

## Version decisions

- **Package/tool version:** validator, renderer, smoke harness, and documentation generator behaviour in
  `package.json`.
- **Lifecycle version:** workflow phases, routes, gates, model assignments, and execution boundaries in
  `.github/agents/AFF-LIFECYCLE.json`.
- **Schema contract version:** structured record shapes and meanings in `schemas/aff/catalogue.json`.
- **Repository release tag:** a tested bundle of the package, lifecycle, schemas, profiles, skills,
  documentation, and website.

Use semantic versioning for each contract. Change only the version whose public behaviour changes.
Document cross-contract dependencies in the changelog and, when users must act, in
[`docs/migrations/`](migrations/README.md).

## Release prerequisites

1. All intended stack layers are merged to `main`; do not release an intermediate stacked branch.
2. `CHANGELOG.md` describes user-visible changes and version impacts.
3. Any required migration note exists and has been tested against a synthetic case.
4. Generated documentation is current and the representative Contoso evidence regenerates exactly.
5. Repository validation and CodeQL pass on the release commit.
6. Main protection, required review, and resolved-thread controls remain active.
7. The release commit contains no real case data, credentials, secrets, generated mutable workspace, or
   unreviewed binary evidence.
8. A human maintainer confirms the tag, release notes, licence, support boundary, and rollback approach.
9. Any live Claude support claim has passed the separate [host qualification](claude-code.md#live-host-qualification)
   gate. Otherwise the release must label that behaviour unqualified. Synthetic checks are not a substitute.

Run from a clean checkout of the proposed release commit:

```powershell
npm ci --no-audit --no-fund
npm run docs:check
npm test
npm run typecheck
npm run build
npm run validate -- --framework-only
npm run smoke:contoso
npm run smoke:contoso -- --host github-copilot --schema-version 1.1.0
npm run smoke:contoso -- --host claude-code --schema-version 1.1.0
git status --short
```

The final command must produce no output. Do not create a GitHub release when any prerequisite is
missing, when required checks have not run on `main`, or when the release would represent an unmerged
stack.

## Release record

For a future release:

1. Move relevant `CHANGELOG.md` entries from **Unreleased** to the exact tag and date.
2. Update package metadata only when the executable tool contract changes.
3. Update lifecycle or schema versions only when their respective contracts change.
4. Create an annotated tag from the protected `main` commit.
5. Publish release notes that link the changelog, migration notes, checks, and known limitations.

No release is published by documentation generation or normal repository validation.
