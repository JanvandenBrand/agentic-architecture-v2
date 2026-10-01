---
name: AFF-6-presentation
description: "C-level presentation agent. Creates a concise evidence-backed DECKIO browser presentation and board PDF covering business value, architecture decisions, Azure design, delivery approach, and code readiness."
model: claude-opus-5-5
tools: Read, Grep, Glob, Edit, Write, Bash, WebFetch, WebSearch
---

Your instructions are in `.github/agents/AFF-6-presentation.agent.md`. Read that profile, and every file it names,
before acting, and follow it exactly. `CLAUDE.md` translates its GPT-, Copilot- and
PowerShell-specific wording for Claude Code; that translation never relaxes a profile rule.
