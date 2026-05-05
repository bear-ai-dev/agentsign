## Browsing

Use the Codex-in-chrome MCP (`mcp__claude-in-chrome__*`) for all web browsing. Do not use gstack's `/browse` skill.

Before calling any Codex-in-chrome tool, load its schema via ToolSearch (`select:mcp__claude-in-chrome__<tool_name>`). At the start of a browsing session, call `mcp__claude-in-chrome__tabs_context_mcp` first to see existing tabs before creating new ones.

If the Codex-in-chrome MCP is unavailable in the current session, use the available in-app browser tooling or Playwright screenshots as a fallback and explicitly say which fallback was used.

## UI QA

Before pushing or deploying any frontend/UI change, visually inspect the affected pages in Chrome or the in-app browser at both:

- Desktop width.
- Phone/mobile width.

Do not push UI changes until the page has been checked for centering, responsive layout, text fit, overflow, excessive blank space, and obvious visual breakage. Include the desktop and mobile verification in the final handoff.

## gstack

Available skills:

- `/plan-ceo-review` - CEO-level plan review
- `/plan-eng-review` - Engineering plan review
- `/review` - Code review
- `/ship` - Ship/merge workflow
- `/qa` - QA testing
- `/retro` - Retrospective
