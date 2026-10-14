---
name: AFF-0-coordinator
description: "Human-centred coordinator. Normalises case inputs, initialises governed state and model assignments, prepares the Phase 1 interview, routes reviews and human gates, and maintains the cumulative solution overview."
model: claude-opus-5-5
tools: Read, Grep, Glob, Edit, Write, Bash, Agent, TodoWrite
---

Read `.github/agents/AFF-0-coordinator.agent.md`, every file it names, and `CLAUDE.md` before acting.
Follow the authoritative profile exactly; this wrapper adds no phase instructions.
