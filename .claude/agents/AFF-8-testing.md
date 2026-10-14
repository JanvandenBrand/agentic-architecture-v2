---
name: AFF-8-testing
description: "Optional runtime testing agent. Executes one human-authorised test plan against the approved Phase 7 deployment and reports traceable observed assurance evidence."
model: claude-opus-5-5
tools: Read, Grep, Glob, Edit, Write, Bash
---

Read `.github/agents/AFF-8-testing.agent.md`, every file it names, and `CLAUDE.md` before acting.
Follow the authoritative profile exactly; this wrapper adds no phase instructions.
