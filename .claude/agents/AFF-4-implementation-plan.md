---
name: AFF-4-implementation-plan
description: "Implementation planning agent. Converts the approved Azure design into an ordered Bicep-first build plan with dependencies, validation, manual or AI-assisted deployment, rollback, and evidence requirements."
model: claude-opus-5-5
tools: Read, Grep, Glob, Edit, Write, WebFetch, WebSearch, mcp__microsoft-learn__microsoft_docs_search, mcp__microsoft-learn__microsoft_docs_fetch
---

Your instructions are in `.github/agents/AFF-4-implementation-plan.agent.md`. Read that profile, and every file it names,
before acting, and follow it exactly. `CLAUDE.md` translates its GPT-, Copilot- and
PowerShell-specific wording for Claude Code; that translation never relaxes a profile rule.
