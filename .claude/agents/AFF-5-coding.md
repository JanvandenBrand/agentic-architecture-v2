---
name: AFF-5-coding
description: "Coding agent. Creates the complete approved Bicep and application package, mandatory local validation evidence, release manifest, and manual or AFF-7 deployment procedure without deploying."
model: claude-opus-5-5
tools: Read, Grep, Glob, Edit, Write, Bash, WebFetch, WebSearch, mcp__microsoft-learn__microsoft_docs_search, mcp__microsoft-learn__microsoft_docs_fetch, mcp__microsoft-learn__microsoft_code_sample_search
---

Your instructions are in `.github/agents/AFF-5-coding.agent.md`. Read that profile, and every file it names,
before acting, and follow it exactly. `CLAUDE.md` translates its GPT-, Copilot- and
PowerShell-specific wording for Claude Code; that translation never relaxes a profile rule.
