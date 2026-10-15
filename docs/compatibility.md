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
| Claude Code | `.claude/agents/*.md`, `.claude/skills/*/SKILL.md`, and the shared `.github` instructions | **Offline adapter and contract checks only; live behaviour unqualified** | CLI `2.1.263` is a qualification target, not a verified support range. Complete the [live qualification procedure](claude-code.md#live-host-qualification) before real cases. |
| GitHub Copilot app or coding workspace | Repository and selected-branch discovery | **Expected** for hosts that implement current GitHub custom-agent and skill discovery | Normal repository-wide discovery can depend on the files being on the default branch. Confirm in the selected host before a real case. |
| Other IDE hosts | No blanket claim | **Not verified** | Use only if the host’s current official documentation supports the same repository locations and frontmatter. |
| Declared models | Copilot defaults in the lifecycle manifest; Claude defaults in the checked wrappers | **Contractually checked**, not availability-tested | Exact model availability and observed runtime identity must be checked on the selected host. A model's self-description is not independent evidence. |
| Model substitution | Human-approved replacement within the selected host's provider policy, recorded with `approvalReference` | **Supported with review** | A per-case choice does not rewrite repository defaults. AFF-A must differ from every phase owner. A silent fallback is not supported. |
| AFF lifecycle | `2.2.0` | **Checked** by the lifecycle manifest and framework validator | Names AFF-0 as the rendering operator for restricted owners and reviewers; phase and review ownership remains unchanged. |
| AFF schema contract | `1.1.0` default for new cases; `1.0.0` retained | **Checked** by `schemas/aff/catalogue.json` and JSON Schema tests | Exact version/type selection. One version and one host per case; no automatic migration or host switching. |
| Validator/tool package | `1.3.0`, private package | **Checked** by `package.json` and `package-lock.json` | Tightens approval and chronology checks without rewriting historical evidence; see the tool upgrade note. |
| Renderer | Deterministic, self-contained HTML; contained local assets only; sanitised SVG; Mermaid shown as escaped source | **Verified** by renderer tests and the Contoso smoke | It does not execute Mermaid, remote scripts, or model-authored HTML. |
| Azure | Not required for install, validation, rendering, or the Contoso smoke | **Verified boundary** | Only optional Phase 7/8 work needs Azure, case-specific authorisation, approved parameters, and organisation-approved identity. |
| Human approval | `extensions.approvalMode` declares `synthetic`, `self-asserted`, or `human-verified`; the declaration must match the evidence | **Checked for record integrity and key continuity** | Verify the first case key's fingerprint independently. Signature checks do not prove personal identity or isolate the signing process from agents. The command requires a local identity; the validator can still read permitted unsigned legacy evidence. |

Declared tool restrictions are not runtime attestation. Copilot profiles declare optional-phase
invocation controls; Claude wrappers map allowed capabilities and rely on the shared human-invocation
policy. Observe both hosts during qualification. The record validator refuses the still-uncatalogued
phase 7/8 authorisations; that is not proof that a host cannot dispatch an agent.

Binary-input conversion is not bundled. Supply human-reviewed Markdown/text with original-source
provenance, or record an unreadable-source blocker.

Official host references:

- [Create and use custom agents for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli)
- [Add agent skills for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills)
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code permissions and their limits](https://code.claude.com/docs/en/permissions)

Repository validation is configured to run every test suite on Windows and Ubuntu, with one stable
`Repository validation` gate. Configuration alone does not prove that a remote run passed; inspect the
checks on the exact release commit. Offline synthetic tests do not qualify live host behaviour.

## Supported-version policy

- Before the first GitHub release, only the current `main` branch is the supported evaluation baseline.
- After release, the latest tagged framework release is the supported stable baseline; `main` is the
  next-release development line.
- Older tags remain available but fixes are best effort. Maintainers may ask reporters to reproduce on
  the latest supported tag or `main`.
- A schema contract remains readable only where its version is still present in
  `schemas/aff/catalogue.json`. Removal or incompatible meaning requires a major schema-contract change
  and a migration note.
- Existing signed `1.0.0` evidence stays unchanged. An older tool that supports only `1.0.0` cannot
  continue a `1.1.0` case. See the [version compatibility note](migrations/1.0.0-to-1.1.0.md).
- Tool `1.3.0` rejects some histories previously accepted by incomplete checks, including early phase
  activity and unauthorised rotations. See [tool upgrade guidance](migrations/tool-1.2.0-to-1.3.0.md).
- A lifecycle version describes the workflow contract. A package/tool version describes executable
  validator, renderer, smoke, and generator code. Neither silently changes the other.
- Repository support never replaces GitHub, model-provider, Azure, legal, security, compliance, or
  production support.
