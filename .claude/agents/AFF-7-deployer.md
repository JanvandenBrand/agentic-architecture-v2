---
name: AFF-7-deployer
description: "Optional Azure deployment agent. Executes one explicitly authorised deployment attempt from the immutable Phase 5 package, captures redacted evidence, and performs basic deployment verification."
model: claude-opus-5-5
tools: Read, Grep, Glob, Edit, Write, Bash
---

Read `.github/agents/AFF-7-deployer.agent.md`, every file it names, and `CLAUDE.md` before acting.
Follow the authoritative profile exactly; this wrapper adds no phase instructions.
