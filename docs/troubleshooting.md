# Troubleshooting

Use the first matching symptom. Keep error output sanitised; never post credentials, customer evidence,
tenant or subscription details, personal data, or private URLs.

| Symptom | Plain-English action | Deeper reference |
|---|---|---|
| `npm ci` rejects Node or dependency metadata | Run `node --version`; install Node.js 22 or later, then run `npm ci --no-audit --no-fund` again from the repository root. Do not replace the lockfile with a hand-edited dependency set. | [Compatibility matrix](compatibility.md) |
| WSL: `explorer.exe` returns exit code 1 when opening the overview, or commands are slow | `explorer.exe` reports exit code 1 even when the file opens; check the browser. Pass a Windows path with `explorer.exe "$(wslpath -w <file>)"`. Keep the clone in the Linux file system (`~/...`), not under `/mnt/c`, for speed and Linux file semantics. | [WSL file systems](https://learn.microsoft.com/en-us/windows/wsl/filesystems) |
| `AFF-0-coordinator` is missing | Confirm `.github\agents\AFF-0-coordinator.agent.md` exists in the checked-out branch. Start Copilot CLI from the repository root and restart it. A user-level agent with the same name can override a repository agent. | [GitHub custom-agent documentation](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli) |
| `grill-me` or `render-case-html` is missing | Confirm `.github\skills\<skill-name>\SKILL.md` exists. Run `/skills reload`, then `/skills info <skill-name>`. | [GitHub skill documentation](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills) |
| Framework validation reports lifecycle/profile drift | Treat `.github\agents\AFF-LIFECYCLE.json` as authoritative. Align the affected profile and operating contract, then run `npm run docs:generate` and validation again. Do not bypass the failing invariant. | [AFF contracts](aff-contracts.md) |
| `npm run docs:check` reports drift | Run `npm run docs:generate`, inspect the README, website, and Contoso evidence changes, then rerun `npm run docs:check`. Do not edit generated sections by hand. | [Release process](release-process.md) |
| Case validation reports a hash mismatch | A governed artifact changed after review or approval. Regenerate the artifact, rerun both reviews against the same final hashes, and obtain a new human decision. | [AFF contracts](aff-contracts.md) |
| Approval command says no identity exists | Close agent sessions and create your identity yourself with `npm run identity:create`. The command does not offer unsigned decisions. Do not replace an existing key or share its passphrase. | [Approval identity](aff-contracts.md#approver-identity) |
| A new case requires exactly one model plan | Finish the Phase 0 model plan with the chosen host before validating a new-contract case. A partially written case is not yet a valid baseline; do not fabricate a plan to silence the error. | [Host policy](aff-contracts.md#host-and-model-policy) |
| Approval reports a changed key or missing rotation authorisation | Keep the existing history intact. A claimed previous fingerprint is not proof. Use an authorised transition or stop; lost-key recovery is not automated. | [Tool upgrade](migrations/tool-1.2.0-to-1.3.0.md) |
| Chronology fails after an upgrade | Preserve the evidence and inspect the event/decision times. A later approval cannot legitimise earlier work. Do not backdate records; resolve the invalid history with the accountable architect. | [Phase sequence](aff-contracts.md#phase-sequence) |
| A Word, PDF, PowerPoint or Excel brief cannot be read | Have a human convert and review it, retain the original, and record conversion provenance and losses. Do not invent a conversion result. | [README manual](../README.md) |
| A Claude model fails schema `1.0.0` | This rejection is intentional. Start a new `1.1.0` case after host qualification; do not relabel old signed evidence. | [Version compatibility](migrations/1.0.0-to-1.1.0.md) |
| Case validation reports a host or version mismatch | Restore the case's original host and version. Do not rewrite journal history or use a schema fallback. | [AFF contracts](aff-contracts.md#host-and-model-policy) |
| Claude adapter validation fails | Restore the checked wrapper template, exact tool mapping, and expected MCP configuration. Do not add tools or weaken rules to bypass the error. | [Claude adapter](claude-code.md) |
| A requested model is unavailable or differs from the observed runtime | Stop and obtain a human-approved assignment. Model self-identification is not sufficient evidence. | [Claude qualification](claude-code.md#live-host-qualification) |
| Renderer rejects a path, link, asset, SVG, or size | Keep every input inside the case folder, use supported local assets, and correct the reported item. Do not weaken containment or sanitisation. | [AFF renderer](aff-renderer.md) |
| Mermaid appears as source text | This is expected. The renderer escapes Mermaid as labelled source instead of executing a diagram library. Use a separately reviewed static image if a visual is required. | [AFF renderer](aff-renderer.md) |
| `smoke:contoso` says the retained folder is not empty | Choose a new empty path or remove the previous ignored `.aff-smoke` output after reviewing it. | [Quick start](quick-start.md) |
| Smoke validation rejects reviewer, approval, or route evidence | Do not edit the generated workspace to force success. Rerun from a clean checkout; if it still fails, capture the exact sanitised error and commit SHA for a bug report. | [Support boundaries](../SUPPORT.md) |
| Azure deployment or runtime testing is requested during evaluation | Stop. Local evaluation authorises neither. Phase 7 and Phase 8 require separate human invocation and case-specific approval. | [Quick start](quick-start.md#3-optional-human-authorised-azure-deployment-and-testing) |

This repository has no vendor support contract, warranty, response-time commitment, or authority to
approve a production architecture. Use [`SUPPORT.md`](../SUPPORT.md) for repository issue routes and
boundaries.
