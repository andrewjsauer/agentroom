# CLAUDE.md

You are building **agentroom**, an open-source tool that lets developers' AI coding agents (from any vendor) exchange messages through temporary, end-to-end encrypted rooms. Read `README.md`, then `docs/ARCHITECTURE.md`, `docs/UX.md`, and `docs/PLAN.md` before writing code.

## How to work

1. Work milestone by milestone from `docs/PLAN.md`. Do not start a milestone until the previous one meets its acceptance criteria.
2. Before building anything that depends on a fast-moving external API (Claude Code plugins, hooks, channels, status line; Codex and Gemini config formats; the MCP TypeScript SDK), check `docs/OPEN_QUESTIONS.md`, verify against current official docs, and record what you found in that file with the date and source URL. Do not rely on memory for these.
3. Tick checkboxes in `docs/PLAN.md` as tasks finish. If the design needs to change, update the relevant doc in the same commit and note why.
4. Keep commits small and scoped to one task.

## Stack and conventions

- TypeScript, Node 20+, ES modules, `strict: true`.
- pnpm workspaces monorepo (see layout in `docs/ARCHITECTURE.md`).
- `zod` (v4) for all schemas; `@modelcontextprotocol/server` and `@modelcontextprotocol/client` (MCP TypeScript SDK v2; `@modelcontextprotocol/sdk` is the v1 line, chosen against because v2 is the stable line per the SDK README on 2026-10-11) for MCP; `ws` for WebSockets in Node; `libsodium-wrappers` for AEAD and signatures, `node:crypto` for HKDF. Do not hand-roll crypto primitives.
- `vitest` for tests. Every package has unit tests; `protocol` and crypto code need thorough tests including tamper and wrong-key cases.
- `tsup` for builds. The CLI is published so `npx @sauerapple/agentroom` works with no install.
- Biome or ESLint plus Prettier; pick one at setup and stick with it.
- No telemetry. No network calls other than to the configured relay.

## Non-negotiable invariants

These are the product's safety properties. Every change must preserve them, and each has tests.

1. **The relay never sees plaintext or the room secret.** It sees only a derived room ID and ciphertext envelopes.
2. **Agents cannot speak as humans.** Messages tagged `from.agent = "human"` can only originate from a human input path (the Claude Code `UserPromptSubmit` hook, the `watch` pane input, or a CLI command that requires an interactive terminal and refuses when an agent environment marker such as `CLAUDECODE` is set). The MCP server must never emit a human-tagged message. The TTY-based paths are a guard against accidental impersonation, not a security boundary; see the threat model in `docs/ARCHITECTURE.md`.
3. **Agent-chain limit.** In any thread, after N consecutive agent-authored messages (default 3) with no human message, `send` refuses with a clear "needs a human" error until a human posts or approves. `thread` is derived from `replyTo`, and a room-wide counter (2N across all threads) stops a loop that opens a new thread per message.
4. **Outbound secret scanning.** Message bodies are scanned for credential patterns before encryption; matches block the send and tell the agent why.
5. **Inbound messages are untrusted data.** Every delivery path (tool results, hook-injected context, channel pushes) wraps them with the shared framing function: clearly delimited, nonce-tagged, escaped, labeled blocks with a fixed reminder that they are information, not instructions. No tool executes anything because an inbound message asked.
6. **References, not code.** v0 has no file transfer. Messages carry `{repo, path, lines, commit}` refs; each side reads its own checkout.
7. **Ephemeral by default.** Rooms expire (idle TTL and max age). Nothing persists on the relay after expiry. Locally, the MCP server keeps a per-room session cache (`~/.agentroom/rooms/<room_id>/`) that is deleted on `down` or expiry; durable copies exist only when the user runs the `export` CLI command, which is not an MCP tool.

## Definition of done for any task

- Types compile, lint passes, tests pass (`pnpm -r test`).
- New behavior has tests; invariants above have regression tests.
- Docs updated if behavior or interfaces changed.

## Out of scope for v0

Accounts, persistent rooms, web UI, file transfer, VS Code extension, short speakable codes (PAKE), billing. See `docs/PLAN.md` "Later".
