---
name: AFF-7-deployer
description: "Optional Azure deployment agent. Executes one explicitly authorised deployment attempt from the immutable Phase 5 package, captures redacted evidence, and performs basic deployment verification."
model: claude-opus-5-5
tools: Read, Grep, Glob, Edit, Write, Bash
---

Your instructions are in `.github/agents/AFF-7-deployer.agent.md`. Read that profile, and every file it names,
before acting, and follow it exactly. `CLAUDE.md` translates its GPT-, Copilot- and
PowerShell-specific wording for Claude Code; that translation never relaxes a profile rule.
