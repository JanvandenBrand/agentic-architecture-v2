# Ten-minute architect quick start

This path proves that the checked-out AFF framework is internally consistent and produces a safe,
synthetic Phase 0 result. It does not call a model, access Azure, deploy anything, or create a real
architecture approval.

## 1. Local deterministic evaluation

### Prerequisites

- Git.
- Node.js 22 or later, including npm.
- Windows PowerShell.
- Network access for `git clone` and `npm ci`. The validation and smoke commands run offline after
  dependencies are installed.

The PowerShell commands below are the verified Windows path. On Linux, macOS, or Windows Subsystem for
Linux (WSL), use the [bash equivalent](#bash-on-linux-macos-or-wsl) instead.

From a clean folder:

```powershell
git clone https://github.com/aramsmith/agentic-architecture-v2.git
Set-Location .\agentic-architecture-v2
node --version
npm --version
npm ci --no-audit --no-fund
npm run validate -- --framework-only
npm run smoke:contoso -- --keep-output .\.aff-smoke\contoso-review
Get-Content .\.aff-smoke\contoso-review\smoke-report.json
Invoke-Item .\.aff-smoke\contoso-review\cases\contoso-permit-services\solution-overview.html
```

If you are evaluating an unmerged branch, check out that branch before `npm ci`.

#### Bash on Linux, macOS, or WSL

```bash
git clone https://github.com/aramsmith/agentic-architecture-v2.git
cd agentic-architecture-v2
node --version
npm --version
npm ci --no-audit --no-fund
npm run validate -- --framework-only
npm run smoke:contoso -- --keep-output .aff-smoke/contoso-review
cat .aff-smoke/contoso-review/smoke-report.json
```

Open `.aff-smoke/contoso-review/cases/contoso-permit-services/solution-overview.html` with `xdg-open`
on Linux or `open` on macOS. In WSL, open it in the Windows browser with
`explorer.exe "$(wslpath -w <file>)"`. These commands are manually exercised on WSL 2 (Ubuntu 22.04,
Node.js 24) but are not automated by this repository.

### Successful evidence

- Framework validation reports no errors.
- The smoke command reports that all executable assertions passed.
- `liveModelCalls` and `azureActions` are both `0`.
- `counterBasis` is `by-construction`: these values describe an offline harness, not monitored live
  calls. `assertionBasis` separates generated-evidence checks from policy-declaration checks.
- `syntheticApproval` is `true`, and the report says the approval is synthetic test evidence.
- `routeReady` is `AFF-1`, but no requirement has been baselined.
- The retained `solution-overview.html` opens locally and labels the approval as synthetic, not human.

**Safe stop point:** stop here for a complete deterministic evaluation. Delete the ignored output when
finished:

```powershell
Remove-Item -Recurse -Force .\.aff-smoke\contoso-review
```

In bash: `rm -rf .aff-smoke/contoso-review`.

See the committed [representative evidence snapshot](examples/contoso-phase-0-evidence.md) before
retaining output if you only need to understand the result.

## 2. Optional GitHub Copilot agent trial

Use readable Markdown/text for the trial. Binary formats need human-reviewed conversion, retained
originals, and provenance/loss notes; no converter is bundled. The approval command requires an
identity created by the human outside any agent session. Offline evaluation does not require one.

This step is separate because it makes a live model call and requires GitHub Copilot access plus the
declared models.

Start Copilot CLI from the repository root, run `/agent`, and confirm `AFF-0-coordinator` is listed.
Run `/skills list`, then inspect `grill-me` and `render-case-html`.

For a minimal profile-discovery check:

```powershell
copilot --agent=AFF-0-coordinator --prompt "State only the custom agent profile name. Do not read or modify files." --silent
```

Restart Copilot CLI after changing agent profiles. Use `/skills reload` after changing skills.

**Safe stop point:** discovery proves packaging only. It does not prove model quality, reviewer
convergence, approval, Azure readiness, or production fitness.

### Claude Code evaluation

The optional [Claude adapter](claude-code.md) uses the same authoritative AFF instructions. Start with
the offline new-contract checks:

```powershell
npm run smoke:contoso -- --host github-copilot --schema-version 1.1.0
npm run smoke:contoso -- --host claude-code --schema-version 1.1.0
```

These commands do not start either host. New cases declare one host in their `1.1.0` model plan and
journal. Existing `1.0.0` cases remain unchanged on Copilot. Do not switch hosts within a case.
Real-case Claude support remains unqualified until its separate live qualification passes.

## 3. Optional human-authorised Azure deployment and testing

Local evaluation and an agent trial do not require Azure. Do not improvise deployment commands from this
quick start.

Phase 7 may be invoked only after Phase 6 is approved and a human gives scoped deployment-attempt
authorisation. Phase 8 may be invoked only after a successful approved Phase 7 deployment and separate
scoped test-attempt authorisation. Use the approved Phase 4 procedure and Phase 5 release package for the
specific case; authenticate interactively or through an organisation-approved managed identity. Stored
credentials and GitHub OIDC are outside this framework contract.

**Safe stop point:** if the target subscription, approved parameters, rollback, evidence capture, or
human authorisation is missing, stop before sign-in or any Azure change.

For failures, use [Troubleshooting](troubleshooting.md). For boundaries and versions, use the
[Compatibility and support matrix](compatibility.md).
