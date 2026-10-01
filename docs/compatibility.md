# Compatibility and support matrix

This matrix separates verified behaviour from reasonable expectations. “Supported” means maintainers can
accept a reproducible repository issue; it is not a service-level or vendor support commitment.

| Area | Baseline | Status | Boundary |
|---|---|---|---|
| Node.js | `>=22` | **Verified** by package metadata and repository validation | Older Node.js versions are unsupported. |
| npm | The npm supplied with a supported Node.js 22+ installation; install with `npm ci` | **Verified** with the committed lockfile | Alternative package managers are not part of the validation contract. |
| Windows | Windows PowerShell with Node.js 22+ | **Verified** for the documented clean-clone and repository validation path | Commands use Windows path syntax. |
| Linux | GitHub-hosted Ubuntu runner with Node.js 22 | **Verified** by `.github/workflows/validate.yml` | Distribution-specific shells outside the workflow are expected, not exhaustively tested. |
| Windows Subsystem for Linux | WSL 2 with a Linux distribution and Node.js 22+ inside it | **Expected**; manually exercised on WSL 2 (Ubuntu 22.04, Node.js 24) | Use the Linux shell commands. Keep the clone in the Linux file system, not under `/mnt/c`. Not exercised by repository automation. |
| macOS | Node.js 22+ and equivalent shell commands | **Expected**, because executable paths use cross-platform Node APIs | Not currently exercised by repository automation. |
| GitHub Copilot CLI | Repository agents in `.github/agents/*.agent.md`; skills in `.github/skills/*/SKILL.md` | **Supported and locally discoverable** using `/agent`, `/skills list`, and `/skills info` | Restart CLI for agent changes; `/skills reload` reloads skill changes. A user-level agent with the same name can take precedence. |
| GitHub Copilot app or coding workspace | Repository and selected-branch discovery | **Expected** for hosts that implement current GitHub custom-agent and skill discovery | Normal repository-wide discovery can depend on the files being on the default branch. Confirm in the selected host before a real case. |
| Other IDE hosts | No blanket claim | **Not verified** | Use only if the host’s current official documentation supports the same repository locations and frontmatter. |
| Declared models | `gpt-5.6-sol`, `gpt-5.3-codex`, and `gpt-5.4` as generated from the lifecycle manifest | **Contractually verified**, not availability-tested | Model entitlement and regional availability belong to the selected Copilot host. |
| Model substitution | Human-approved GPT replacement; update profiles, operating contract, lifecycle manifest, generated docs, and tests together | **Supported with review** | AFF-A must remain on a different model from every phase owner. A silent fallback is not supported. |
| AFF lifecycle | `2.0.0` | **Verified** by the lifecycle manifest and framework validator | Lifecycle meaning changes require an explicit lifecycle-version decision. |
| AFF schema contract | `1.0.0` | **Verified** by `schemas/aff/catalogue.json` and JSON Schema tests | Records are validated only against their declared catalogued version. |
| Validator/tool package | `1.1.0`, private package | **Verified** by `package.json` and `package-lock.json` | This is repository tooling metadata, not the lifecycle or schema version and not proof of a published npm package. |
| Renderer | Deterministic, self-contained HTML; contained local assets only; sanitised SVG; Mermaid shown as escaped source | **Verified** by renderer tests and the Contoso smoke | It does not execute Mermaid, remote scripts, or model-authored HTML. |
| Azure | Not required for install, validation, rendering, or the Contoso smoke | **Verified boundary** | Only optional Phase 7/8 work needs Azure, case-specific authorisation, approved parameters, and organisation-approved identity. |
| Human approval | `extensions.approvalMode` declares `synthetic`, `self-asserted`, or `human-verified`; the declaration must match the evidence | **Verified for record integrity and, when signed, for key custody** | A `human-verified` approval proves the record was signed by the case's approval key and is unchanged. A machine holding an approval key requires every real decision to be signed; a machine without one accepts `self-asserted`. Neither proves the passphrase holder acted unassisted. |

Official host references:

- [Create and use custom agents for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli)
- [Add agent skills for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills)

## Supported-version policy

- Before the first GitHub release, only the current `main` branch is the supported evaluation baseline.
- After release, the latest tagged framework release is the supported stable baseline; `main` is the
  next-release development line.
- Older tags remain available but fixes are best effort. Maintainers may ask reporters to reproduce on
  the latest supported tag or `main`.
- A schema contract remains readable only where its version is still present in
  `schemas/aff/catalogue.json`. Removal or incompatible meaning requires a major schema-contract change
  and a migration note.
- A lifecycle version describes the workflow contract. A package/tool version describes executable
  validator, renderer, smoke, and generator code. Neither silently changes the other.
- Repository support never replaces GitHub, model-provider, Azure, legal, security, compliance, or
  production support.
