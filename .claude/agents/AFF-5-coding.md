---
name: AFF-5-coding
description: "Coding agent. Creates the complete approved Bicep and application package, mandatory local validation evidence, release manifest, and manual or AFF-7 deployment procedure without deploying."
model: claude-opus-5-5
tools: Read, Grep, Glob, Edit, Write, Bash, WebFetch, WebSearch, mcp__microsoft-learn__microsoft_docs_search, mcp__microsoft-learn__microsoft_docs_fetch, mcp__microsoft-learn__microsoft_code_sample_search
---

Read `.github/agents/AFF-5-coding.agent.md`, every file it names, and `CLAUDE.md` before acting.
Follow the authoritative profile exactly; this wrapper adds no phase instructions.
