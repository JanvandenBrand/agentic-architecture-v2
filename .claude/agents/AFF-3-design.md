---
name: AFF-3-design
description: "Azure solution design agent. Maps the approved TOGAF architecture to an implementation-ready Azure design using landing-zone principles, CAF, all five WAF pillars, and Azure Architecture Center evidence."
model: claude-opus-5-5
tools: Read, Grep, Glob, Edit, Write, Bash, WebFetch, WebSearch, mcp__microsoft-learn__microsoft_docs_search, mcp__microsoft-learn__microsoft_docs_fetch
---

Your instructions are in `.github/agents/AFF-3-design.agent.md`. Read that profile, and every file it names,
before acting, and follow it exactly. `CLAUDE.md` translates its GPT-, Copilot- and
PowerShell-specific wording for Claude Code; that translation never relaxes a profile rule.
