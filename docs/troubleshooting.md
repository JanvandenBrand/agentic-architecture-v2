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
| Renderer rejects a path, link, asset, SVG, or size | Keep every input inside the case folder, use supported local assets, and correct the reported item. Do not weaken containment or sanitisation. | [AFF renderer](aff-renderer.md) |
| Mermaid appears as source text | This is expected. The renderer escapes Mermaid as labelled source instead of executing a diagram library. Use a separately reviewed static image if a visual is required. | [AFF renderer](aff-renderer.md) |
| `smoke:contoso` says the retained folder is not empty | Choose a new empty path or remove the previous ignored `.aff-smoke` output after reviewing it. | [Quick start](quick-start.md) |
| Smoke validation rejects reviewer, approval, or route evidence | Do not edit the generated workspace to force success. Rerun from a clean checkout; if it still fails, capture the exact sanitised error and commit SHA for a bug report. | [Support boundaries](../SUPPORT.md) |
| Azure deployment or runtime testing is requested during evaluation | Stop. Local evaluation authorises neither. Phase 7 and Phase 8 require separate human invocation and case-specific approval. | [Quick start](quick-start.md#3-optional-human-authorised-azure-deployment-and-testing) |

This repository has no vendor support contract, warranty, response-time commitment, or authority to
approve a production architecture. Use [`SUPPORT.md`](../SUPPORT.md) for repository issue routes and
boundaries.
