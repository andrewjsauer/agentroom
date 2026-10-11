# Open questions

Verify each item against current official docs before building the part that depends on it. Record the answer, the date, and the source URL under each item. These APIs changed several times in 2026, so do not trust memory or older blog posts.

## M0: before writing code

1. **Name availability.** Is `agentsync` free on npm and as a GitHub org or repo? If not, choose another name.
2. **MCP TypeScript SDK.** Current package name, version, stdio server API, and how to declare tools and prompts.
3. **Claude Code MCP config.** Current way to add a stdio MCP server per project and per user (`claude mcp add` flags, `.mcp.json` format).

## M3: Claude Code plugin

4. **Plugin manifest.** Current plugin format: can one plugin bundle an MCP server, slash commands, hooks, and a status line?
5. **Status line.** Can a plugin set it, or must settings be edited? How to chain with a user's existing status line?
6. **`UserPromptSubmit` hook.** Can it (a) read the raw prompt, (b) block the prompt from reaching the model, and (c) inject additional context? Exact output format.
7. **Slash commands and hooks.** When the user types a plugin slash command, does the `UserPromptSubmit` hook see the raw text before command expansion? If not, how should `/say` be implemented so the model never sees it?
8. **Channels.** Current status of Claude Code channels (research preview since v2.1.80 per the October 2026 research): capability name, how an MCP server pushes events, launch flag, Team/Enterprise admin requirement.
9. **Cross-session messaging.** Confirm it remains single-user (if Anthropic ships cross-account messaging, revisit scope).

## M4: other agents

10. **Codex CLI.** MCP config file location and format; tool-call timeout (sets the max `wait` duration); whether it has hooks equivalent to `UserPromptSubmit`.
11. **Gemini CLI / Antigravity CLI.** Which CLI is current for paid users; MCP config format; tool timeout; hooks.
12. **Cursor.** MCP config location; whether background agents can use local stdio MCP servers.
13. **Unprompted polling.** Does each agent reliably call `inbox` at task boundaries when told to in `AGENTS.md` / `GEMINI.md`? Test for five minutes each.

## Product and legal

14. **Client contract.** Confirm the client allows this tool on their project. Refs-only messages, end-to-end encryption, and secret scanning help, but it is the client's call.
15. **License.** MIT or Apache-2.0.
16. **Hosted relay abuse.** Rate limits and size caps are enough for v0? Consider a per-IP room creation cap.
