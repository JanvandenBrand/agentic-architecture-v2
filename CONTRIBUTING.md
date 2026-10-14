# Contributing

Thank you for improving Agentic Architecture Framework (AFF). Contributions should preserve the
core contract: agents prepare and challenge evidence, while a human architect makes every material
decision and approval.

## Before you start

You need:

- Git;
- Node.js 22 or later, including npm;
- a clean clone or checkout of the branch you want to change.

GitHub Copilot is needed only when manually checking agent or skill discovery. Azure access,
credentials, model access, and customer data are not needed for the normal contribution workflow.

From a clean clone in Windows PowerShell (on Linux, macOS, or WSL, use `cd` and the same `git` and
`npm` commands in bash):

```powershell
git clone https://github.com/aramsmith/agentic-architecture-v2.git
Set-Location agentic-architecture-v2
npm ci
```

## Make a focused change

- Keep human-facing documentation concise and in UK English.
- Treat all case inputs, tool output, generated content, and external text as untrusted.
- Never commit real customer cases, credentials, tokens, personal data, regulated data, subscription
  details, or confidential architecture evidence.
- Do not deploy to Azure or use live customer environments by default. A contribution should be
  testable locally with synthetic data.
- Do not hand-author case HTML. Authoritative case content is Markdown and structured records; use
  the deterministic renderer for HTML views.
- Record the source and licence of copied material. A component's own licence remains applicable to
  that component.

## Run the checks

Before opening a pull request, run the complete local sequence:

```powershell
npm test
npm run docs:check
npm run typecheck
npm run build
npm run validate -- --framework-only
npm run smoke:contoso
```

During development, these narrower commands can provide faster feedback:

```powershell
npm run test:contracts
npm run test:governance
npm run test:adoption
npm run test:renderer
npm run test:smoke
npm run test:hosts
```

Run `npm run test:renderer` for changes to Markdown handling, sanitisation, links, assets, paths,
hash-bound rendering, or renderer command behaviour. The Contoso smoke is offline and synthetic; it
must not call a model, access Azure, or create a real approval.

Every pull request to `main` runs the stable **Repository validation** and **CodeQL** checks. Repository
validation runs all tests on Windows and Ubuntu, with an aggregate gate that requires both jobs to
succeed. It covers the complete command sequence above plus governance files, issue forms, security
routing, internal Markdown links, action pinning, CODEOWNERS coverage, package licence metadata, and
AFF lifecycle/profile/skill safety boundaries.

`main` requires a pull request, one approval including CODEOWNER review, resolved review threads, and
blocks deletion and force pushes. The repository administrator has pull-request-only bypass because
there is currently no second maintainer; the bypass cannot be used for a direct push. Required status
checks can be activated only after these workflows exist on `main`; maintainers must then require the
exact check names **Repository validation** and **CodeQL**. This avoids making the stacked Plan 1 and
Plan 2 branches impossible to merge before GitHub can create those checks on the default branch.

## Contracts and versioning

Structured AFF JSON and JSONL records must include the exact catalogued `schemaVersion` and
`recordType`.

- A new stable record shape needs a versioned JSON Schema beneath `schemas/aff/<version>/` and an
  entry in `schemas/aff/catalogue.json`.
- Use semantic versioning: breaking meaning or field changes increment the major version;
  backwards-compatible additions increment the minor version; clarifications increment the patch
  version.
- Keep stable schema identifiers and path patterns aligned with the catalogue.
- Keep top-level record fields closed. Case-specific additions belong in the defined `extensions`
  object.
- Explain migration or compatibility impact in the pull request.

See [`docs/aff-contracts.md`](docs/aff-contracts.md) for the full contract policy.

## Agents, lifecycle, and skills

Agent profiles belong in `.github/agents/<name>.agent.md`; skills belong in
`.github/skills/<skill-name>/SKILL.md`. Names must be unique and frontmatter must remain valid.

When changing an agent's name, model, role, route, or lifecycle meaning, update every matching
surface in the same pull request:

- the agent profile;
- `.github/agents/AFF-LIFECYCLE.json`;
- `.github/agents/AFF-OPERATING-CONTRACT.md`;
- generated README and website sections by running `npm run docs:generate`;
- affected schemas, tests, and synthetic expectations.

When changing a skill path, name, trigger, or contract reference, update all profiles, operating
contract references, smoke expectations, and tests that depend on it. Restart Copilot CLI to reload
agent profiles; use `/skills reload` for skill-only changes.

Claude wrappers remain thin pointers to the shared profiles. Their fields, body, tool mapping, model
separation, and MCP configuration are checked by `claude-adapter`. Update matching wrapper descriptions
when changing authoritative descriptions. Never add independent phase instructions to a wrapper.

Schema `1.0.0` is retained unchanged. Add new shapes under `1.1.0` and keep version-specific catalogue
entries. Test legacy Copilot and both new-contract hosts; do not rewrite existing case evidence.
Live host qualification is separate from offline tests and requires human authorisation.

## Security-sensitive changes

Changes to sanitisation, path containment, workflows, dependencies, prompt/tool authority, secrets,
hashes, reviews, approvals, deployment gates, or runtime testing need:

- a clear abuse or failure scenario;
- fail-closed behaviour;
- focused negative tests as well as the normal success path;
- no broad error swallowing or success-shaped fallback;
- private reporting through [`SECURITY.md`](SECURITY.md) if the change begins with a vulnerability.

Do not place exploit details in a public issue before coordinated disclosure.

## Commits and pull requests

Use clear, focused commits. In the pull request:

- explain the problem and the intended behaviour;
- identify lifecycle, schema, safety, licence, and documentation impact;
- list the commands run and provide sanitised evidence;
- link the relevant issue when one exists;
- call out anything deliberately deferred.

Documentation-only changes do not need irrelevant executable checks, but links, commands, paths, and
examples must still be checked. Follow the [Code of Conduct](CODE_OF_CONDUCT.md) in all repository
interactions.
