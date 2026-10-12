---
title: Milestone 4 Agnostic (agent-doable parts) - Plan
type: feat
date: 2026-10-12
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Milestone 4 Agnostic (agent-doable parts) - Plan

## Goal Capsule

- **Objective:** A Codex, Gemini CLI or Cursor user can join an agentroom room with one command and talk to a Claude Code user through either relay, `relay-node` (self-hosted) or `relay-cf` (Cloudflare). Two people who pick the same member name still see each other's messages.
- **Means:** Track own posts by envelope id instead of by member name (U1). Add per-agent config writers and an `AGENTS.md`/`GEMINI.md` snippet, and send the MCP `instructions` (U2). Move room rules into a transport-agnostic core and build a Durable Object relay on it that runs the shared conformance suite (U3). Write the README and a manual release checklist (U4).
- **Authority:** `CLAUDE.md` invariants and stack, then `docs/ARCHITECTURE.md`, `docs/UX.md`, `docs/PLAN.md` Milestone 4, then this plan. The M1-M3 plans in `docs/plans/` stay in force unless a KTD here names a change. `docs/OPEN_QUESTIONS.md` items 10-12 (Codex, Gemini, Cursor) and the relay-cf note under item 16 (hibernation, alarms) are settled inputs, verified 2026-10-12.
- **Scope:** U1-U4 only. Out of scope (human steps): npm publish and the v0.1.0 tag, hosted relay deploy and its DNS, the demo GIF, the real Claude Code plus Codex room test (PLAN acceptance), the five-minute "does the agent poll unprompted" check (OPEN_QUESTIONS 13), and ticking `docs/PLAN.md` or writing `docs/LOG.md`.
- **Stop conditions:**
  - Stop if any change lets `packages/mcp/src` build a `from.agent = "human"` envelope (invariant 2), or lets the relay see plaintext, the share code or the key (invariant 1).
  - Stop if a test would touch the real `~/.agentroom`, `~/.codex`, `~/.gemini`, `~/.cursor` or `~/.claude`, run a real agent binary, or reach the network. Tests must not reach Cloudflare: `relay-cf` tests run on local workerd only.
  - Stop if CI on Node 20 or 22 goes red. A relay-cf test that cannot run on Node 20 is skipped there on purpose, and the skip is visible in the output (KTD9). It must never fail on Node 20.
- **Execution profile:** TypeScript library, CLI and Worker code, file-format writers, unit, spawned-process and local-workerd tests. No deploy, no publish.

---

## Product Contract

### Summary

Four units, in order. U1 fixes the M3 review item: a session decides a message is "own" because its envelope id was posted from this machine, not because the sender's member name matches. U2 adds `agentroom install|uninstall codex|gemini|cursor [--project]` and wires `up`/`join --agent` to it. U3 adds `packages/relay-cf` on a shared room core and runs one wire conformance suite against both relays. U4 documents quickstarts, self-hosting and the honest delivery model, and adds `docs/RELEASE_CHECKLIST.md`.

### Requirements

**Own-post tracking (U1)**

- R1. A session treats an inbound envelope as own only when its id is one this process is waiting to see echoed back, or an id recorded in the room's `queue.jsonl` as a `sent` record. Both cases also require the envelope not to be human-tagged. The member-name comparison in `packages/mcp/src/session.ts` is gone, both in the own decision and in the notification filter.
- R2. Every local post appends `{ t: "sent", ids: [id] }` to `queue.jsonl` before the `put`: MCP `send`/`handoff`, CLI posts through `connectForPost` (say, approve, watch input), and the hook draft release. A post that then fails leaves a harmless stale id.
- R3. Two members on different machines both named `dev` see each other's messages as unread, and each gets notified when the other's message needs them. A second local session of the same member still treats the first session's agent posts as own. This member's human messages stay unread for this member's agent (M3 KTD14).

**Adapters (U2)**

- R4. `agentroom install codex|gemini|cursor [--project]` writes a stdio MCP server entry named `agentroom` that runs the CLI's `mcp` subcommand without `--room` (KTD4):
  - Codex: `~/.codex/config.toml` `[mcp_servers.agentroom]` with `command` and `args`. With `--project`, `.codex/config.toml` in the repo root.
  - Gemini: `~/.gemini/settings.json` `mcpServers.agentroom` with `{ command, args }`. With `--project`, `.gemini/settings.json`.
  - Cursor: `~/.cursor/mcp.json` `mcpServers.agentroom` with `{ type: "stdio", command, args }`. With `--project`, `.cursor/mcp.json`.
  - Every other key, table and comment in the file survives byte for byte. Running install a second time leaves the file identical.
- R5. Install also writes the UX.md snippet (inbox at task start and after each step, `wait` when blocked) to the repo root's `AGENTS.md` (codex, cursor) or `GEMINI.md` (gemini), between `<!-- agentroom:start -->` and `<!-- agentroom:end -->` markers. If the markers exist, the block is replaced; if not, it is appended; if the file is missing, it is created. Writing it twice gives the same file.
- R6. `agentroom uninstall codex|gemini|cursor [--project]` removes the MCP entry and the marker block. Everything else stays. A file that ends up empty because only our content was in it is deleted. When there is nothing to remove, uninstall says so and exits 0.
- R7. `up --agent X` and `join --agent X`, for X in codex, gemini or cursor, run the same install at user scope after the room is ready. They print which files they changed and tell the user to restart the agent.
- R8. The MCP server's `instructions` field contains the intro sentence, `RULES_TEXT`, and the inbox/wait guidance, so Codex and Gemini see the room rules without a skill. The no-room stub keeps its own instructions.
- R9. A config file that is not valid JSON, or a TOML file that defines `agentroom` in a form the writer does not handle (KTD5), aborts. The error names the file and changes nothing.

**relay-cf (U3)**

- R10. `packages/relay-cf` is a Worker that routes each WebSocket upgrade to one Durable Object per room via `idFromName(room_id)`. The Durable Object implements the ARCHITECTURE wire protocol and its "wire behavior fixed in milestone 1" list with the same limits as relay-node: 500-envelope buffer, 64 KiB decoded envelope, 96 KiB frame, 8 members, 2 closers with oldest evicted, 10 s closer grace, token bucket burst 20 at 2/s, idle TTL capped at 8 h, max age capped at 24 h, and tombstones until `createdAt + maxAge`.
- R11. It uses the Hibernation API: `ctx.acceptWebSocket` with tags, plus `webSocketMessage` and `webSocketClose`. Per-connection nonce, role, rate-limit tokens and closer deadline live in `serializeAttachment`. Room state, the buffer and the tombstone live in `ctx.storage`. Alarms handle idle expiry, max-age expiry, closer grace and tombstone expiry. Close and expiry call `storage.deleteAll()`, then write only the tombstone.
- R12. Room rules (frame parsing, create/join decisions, caps, rate limit, envelope size, expiry deadline, close-signature check) live once in a shared core used by both relays (KTD6). The core has no Node or Workers imports.
- R13. One wire conformance suite runs against relay-node on every Node version and against relay-cf on local workerd under Node 22+ (KTD9). An end-to-end CLI plus MCP question-and-answer test also runs against relay-cf.
- R14. Invariant 1 holds for relay-cf: storage, logs and error frames carry no plaintext, signature or blob outside the stored ciphertext.

**Docs (U4)**

- R15. `README.md` has a quickstart for Claude Code, Codex, Gemini CLI and Cursor; self-hosting guides for relay-node (plain `node`, env vars, TLS through a reverse proxy) and relay-cf (`wrangler deploy`); a plain statement that non-Claude agents get messages only when they call `inbox` or `wait`; and the existing threat model kept or linked.
- R16. `docs/RELEASE_CHECKLIST.md` is a manual checklist that runs Claude Code, Codex and Gemini CLI against one room on one relay.

### Acceptance Examples

- AE1. alice (`dev`, machine A) and bob (`dev`, machine B, a separate `AGENTROOM_HOME`) are in one room. alice sends a question to bob. bob's `inbox` returns it framed. alice's `inbox` does not return her own message.
- AE2. alice's agent drafts a message, and alice releases it with `/agentroom:send <hash>`. Her MCP session records the released envelope as own and does not count it as unread. bob, also named `dev`, gets it as unread.
- AE3. `~/.codex/config.toml` holds `model = "o5"`, a `# comment`, `[profiles.fast]` and `[mcp_servers.other]` with an `env` subtable. `install codex` adds `[mcp_servers.agentroom]` and keeps everything else unchanged. A second install leaves the file identical. `uninstall codex` restores the original bytes, apart from at most one trailing newline.
- AE4. In a repo whose `AGENTS.md` has user content, `install cursor --project` writes `.cursor/mcp.json` and appends the marker block. Running it again changes nothing. `uninstall cursor --project` leaves the user content as it was.
- AE5. On relay-cf, a room created with `idleTtlSec: 2` pushes `error{room_expired}` to connected clients within a few seconds of going idle. A later `hello` with `create` for the same id gets `room_expired`.
- AE6. On relay-cf, a valid `close` sends `closed` to every connection. Rejoining gets `room_expired`. A wrong key gets `bad_signature` and the room survives.

### Scope Boundaries

- No Codex, Gemini or Cursor hooks (BeforeAgent, beforeSubmitPrompt). Human input for those users is the `watch` pane and the CLI, per OPEN_QUESTIONS 10-12.
- No push delivery to non-Claude agents. No `live` channels.
- No per-IP room-creation cap on relay-cf. That belongs to the hosted deployment (human step, OPEN_QUESTIONS item 16 note).
- No change to `DEFAULT_RELAY`. The hosted URL is a human step.
- Same-name members are not disambiguated for `to:` routing. `to: "dev"` still matches both `dev`s, as before.

### Sources

- `docs/OPEN_QUESTIONS.md` items 10-12 and the item 16 relay-cf note (2026-10-12, URLs inline there).
- `npm view` on 2026-10-12: `wrangler@4.149.0` declares `engines.node >=22.0.0` and peer `@cloudflare/workers-types ^5.20261006.1`. `@cloudflare/vitest-pool-workers@0.23.0` peers `vitest ^4.1.0` (the repo uses vitest 3.2). `miniflare@latest` is `5.20261006.1-alpha` with node `>=22`. `smol-toml@1.9.1` exists, but it does not preserve comments.
- Code read: `packages/relay-node/src/relay.ts`, `packages/relay-node/test/relay.test.ts`, `tests/conformance/test/*`, `packages/mcp/src/{session,state,server,relay-client}.ts`, `packages/cli/src/{room-post.ts,hook/release.ts,commands/install.ts,commands/uninstall.ts,claude-settings.ts}`.

---

## Planning Contract

### Key Technical Decisions

- **KTD1. Own is decided by envelope id, recorded in `queue.jsonl`.** `QueueRecord` gains `{ t: "sent", ids: string[] }`. `replayQueue` returns `sentIds`, and `readQueueTail` returns `sentIds` alongside `readIds`, with its fast filter extended to `"t":"sent"`. The session keeps `localIds` (pending echoes plus sent ids). On an inbound envelope whose id is not already known, it reads the queue tail once before deciding, so a CLI post written just before its `put` is always seen. Then `own = local && !isHuman(env)`, and notification is skipped when `local`. Writers append the `sent` record before the `put`, so the record can never arrive after the echo. Old readers skip the unknown record type, because unparseable lines are already ignored.
- **KTD2. The MCP session also writes `sent` for its own sends.** Without this, a second local MCP session of the same member (a second agent window) would treat the first session's posts as unread, which the old name rule covered.
- **KTD3. One adapter module per agent behind a small table.** `packages/cli/src/adapters/{codex,gemini,cursor}.ts` each export `{ configPath(scope, env, root), writeEntry(text, cmd), removeEntry(text), snippetFile }`. Shared code: `adapters/json-config.ts` (read, set or delete `mcpServers.agentroom`, write two-space JSON), `adapters/toml.ts` (KTD5), `adapters/snippet.ts` (marker block). The ARCHITECTURE layout line for top-level `adapters/` is updated to `packages/cli/src/adapters/`, since adapters ship with the CLI.
- **KTD4. Adapter entries run `mcp` without `--room`.** The M3 `mcp` subcommand already serves `~/.agentroom/current` and falls back to the no-room stub. So the entry stays the same across rooms and never names a room id, which makes project-scope files safe to commit. `mcpServerCommand` gets an optional room id. Claude's M1 paths keep passing it. `install codex|gemini|cursor` does not require a room.
- **KTD5. A line-based TOML writer, no TOML dependency.** Scan the lines while tracking multi-line string state (`"""`, `'''`). Remove the `[mcp_servers.agentroom]` table and its `[mcp_servers.agentroom.*]` subtables, including quoted-key spellings (`[mcp_servers."agentroom"]`), each up to the next table header. Append the new block at the end of the file, preceded by one blank line. Values go through `JSON.stringify`, which produces valid TOML basic strings for the arrays and strings we write. If `agentroom` appears in a form we do not rewrite (an inline `mcp_servers = { ... }`, a dotted `agentroom.command =` under `[mcp_servers]`, or `[[mcp_servers...]]`), refuse with an error that names the file (R9). A parse-and-restringify library would drop the user's comments and layout.
- **KTD6. The shared room core lives in `packages/protocol/src/relay-core.ts`, exported as `@agentroom/protocol/relay-core`.** This is the smallest move. relay-node already depends on `@agentroom/protocol`, so no new package needs publishing or bundling. The module imports only `zod` and `./wire.js`, uses only Web platform globals (`crypto.getRandomValues`, `crypto.subtle`, `atob`, `btoa`, `TextEncoder`), and avoids Node APIs and libsodium, so the Worker bundle stays free of `node:crypto` and WebAssembly. Exports: `parseClientFrame`, `decideHello`, `newRoomState`, `admitPut` (size and rate-limit check plus token refill), `applyPut` (seq, buffer trim, lastActivity), `expiresAt`, `decodedLength`, `newNonce`, `verifyCloseWebCrypto`, the limit defaults, and the `RelayEvent` type. relay-node's `relay.ts` is refactored onto it with its behavior unchanged. Its existing unit tests are the regression net. protocol's tsup gets a second entry, and its `package.json` gets a second export. A guard test asserts that `relay-core.ts` and its import graph contain no `node:` import, no `Buffer` and no `libsodium`.
- **KTD7. relay-cf checks close signatures with Web Crypto Ed25519.** libsodium-wrappers compiles WebAssembly from bytes at runtime, and workerd blocks that, so relay-cf cannot use protocol's `verifyClose`. `verifyCloseWebCrypto` builds the same message, utf8(hex room_id) followed by the decoded nonce bytes, applies the same strict base64 and length checks, and calls `crypto.subtle.verify("Ed25519", ...)`. This calls a platform primitive and does not reimplement one. A cross-check test signs with libsodium (`signClose`) and verifies with both `verifyClose` and `verifyCloseWebCrypto` over valid, tampered, wrong-key, replayed-nonce and malformed-base64 cases, and asserts both give the same result. relay-node keeps libsodium. ARCHITECTURE's crypto section records the deviation.
- **KTD8. The room id travels in the WebSocket URL as `?room=<room_id>`.** A Worker has to pick the Durable Object at upgrade time, before any `hello` arrives. All three connect sites in `packages/mcp/src/relay-client.ts` use a new `roomUrl(relay, roomId)` helper in `wire.ts`, which sets the query parameter with the `URL` API so relay URLs that have paths still work. relay-cf refuses an upgrade whose `room` is missing or is not 64 lowercase hex with HTTP 400, and answers a `hello` whose `room` differs from the URL with `bad_proto`. relay-node ignores the query, so old clients still work against it. The room id is already visible to the relay, so this exposes nothing new. The extra exposure is only that Cloudflare request logs can record the opaque id. ARCHITECTURE's wire section records the change.
- **KTD9. relay-cf runs locally with wrangler's `unstable_startWorker`, on Node 22+ only.** Current wrangler and miniflare require Node 22, and `@cloudflare/vitest-pool-workers` requires vitest 4, so it is not used. The conformance package gets a `startCfRelay(vars)` helper that calls `unstable_startWorker({ config: "packages/relay-cf/wrangler.jsonc", dev: { server: { port: 0 }, inspector: false } })`, overrides the limit vars per test group, and returns `{ url, close }`. Test files that use it are wrapped in `describe.skipIf(nodeMajor < 22)`, and the skip reason names the wrangler engines requirement. Tests set `WRANGLER_SEND_METRICS=false`, and workerd runs offline once installed. `workerd` is added to `pnpm.onlyBuiltDependencies`. `pnpm install` on Node 20 warns about wrangler's engines field but succeeds, because pnpm's engine-strict is off by default. The implementer confirms this on Node 20 and records it. relay-cf has no `build` script, so `pnpm -r build` never runs wrangler on Node 20. It has `typecheck`, `test`, `dev` and `deploy` scripts, and `deploy` is never run by agents. If `unstable_startWorker` turns out not to work offline in CI, the fallback is: keep the relay-core tests, keep the relay-cf tests behind `AGENTROOM_CF_TESTS=1`, and add a manual `wrangler dev` conformance step to `docs/RELEASE_CHECKLIST.md`. Record the outcome in OPEN_QUESTIONS.
- **KTD10. Durable Object storage layout.** Keys are `room` (the RoomState fields without the buffer: seq, meta, closeKey, TTLs, createdAt, lastActivity), `b:<seq zero-padded to 10>` (one blob per key, about 87 KiB at most as base64), and `tomb` (the until time in ms). Data is loaded in the constructor under `blockConcurrencyWhile`. Buffer entries are read with `storage.list({ prefix: "b:", start })` only for `since` replay. Each `put` writes `room` and the new `b:` key together, and deletes `b:<seq-500>`. The Durable Object output gate holds the `msg` broadcast until the write commits. The alarm runs at `min(expiresAt, earliest closer deadline, tomb)`. A `put` does not move the alarm, because idle activity only pushes the deadline later: an alarm that fires early recomputes and reschedules. The alarm handler reads storage rather than memory, as the item 16 note requires. Close or expiry: send the frames, close the sockets, `deleteAll()`, then `deleteAlarm()` in case `deleteAll` does not clear it, then `put("tomb")` and `setAlarm(tomb)`. The tomb alarm calls `deleteAll()` and `deleteAlarm()`. The implementer reads the Storage API page for `deleteAll` and alarm semantics before writing this code and records the finding.
- **KTD11. relay-cf configuration lives in wrangler `vars`.** `IDLE_TTL_SEC`, `MAX_AGE_SEC`, `BUFFER_SIZE`, `MAX_MEMBERS`, `MAX_CLOSERS`, `RATE_BURST`, `RATE_PER_SEC`, `CLOSE_GRACE_MS`, with relay-node's defaults. relay-node's `bin.ts` env vars are documented with the same names in the README. `compatibility_date` is `2026-10-12`, which is later than 2026-04-07 when the runtime started auto-replying to Close frames. No `nodejs_compat` is needed. The binding is `ROOMS` with class `Room`, and migration `v1` uses `new_sqlite_classes: ["Room"]`. Logs are single-line JSON `RelayEvent` values written with `console.log`.
- **KTD12. One wire conformance suite, defined once and run per relay.** `tests/conformance/test/wire-suite.ts` exports `defineWireSuite(name, start)`. It talks raw `ws` with real short TTLs and no injected clock. It covers create and join, sender echo, `since` replay and no replay without it, presence, the 500-entry buffer, `too_large` (and exactly 64 KiB accepted), a frame over 96 KiB refused, `bad_proto` cases, rate limit, the room cap, closers (admitted at cap, eviction, grace), close (valid, bad key, replayed nonce), tombstones, idle and max-age expiry with a pushed `room_expired`, and URL/hello room mismatch (relay-cf only). `wire-node.test.ts` runs it against `startRelay`, with `sweepIntervalMs: 200` so expiry gets pushed in real time. `wire-cf.test.ts` runs it against `startCfRelay`. relay-node's own `relay.test.ts` keeps its clock-driven, `snapshot`, `inject` and invariant-1 tests unchanged.

### Assumptions

- The Codex config dir is `$HOME/.codex` unless `CODEX_HOME` is set. The implementer checks `CODEX_HOME` against the Codex docs before honoring it and records the result. Gemini and Cursor use `$HOME`. Tests set `HOME` (and unset `CODEX_HOME`) to a temp dir.
- The "repo root" for snippets and project config is the nearest ancestor of `cwd` that contains `.git`, falling back to `cwd`. This needs no `git` binary.
- OPEN_QUESTIONS 12 left open whether Cursor reads `AGENTS.md`. The implementer re-checks Cursor's rules docs once. If `AGENTS.md` is not supported, `install cursor` also writes `.cursor/rules/agentroom.mdc` with the same marker-delimited snippet, and the finding is recorded.

### Risks

- `unstable_startWorker` may change shape between wrangler minors. Pin wrangler to an exact version in `packages/relay-cf/package.json`. The KTD9 fallback keeps CI green either way.
- A Durable Object holding 500 envelopes of 64 KiB each is about 44 MB of storage per busy room. That is within SQLite-backed DO limits, and it is deleted on close or expiry.
- The relay-node refactor could change wire behavior without anyone noticing. `relay.test.ts` is the guard: it stays unchanged and green through U3 step 1.

### Documentation Plan

- `docs/ARCHITECTURE.md`: the `?room=` query (KTD8), the relay-cf storage, alarms and Web Crypto close check (KTD7, KTD10), the location of the relay core (KTD6), the layout line for adapters (KTD3), and the `sent` queue record under local state (KTD1).
- `docs/UX.md` non-Claude section: install and uninstall commands, the `--project` flag, files touched, the markers.
- `docs/OPEN_QUESTIONS.md`: dated findings on wrangler/Node 22 and the `unstable_startWorker` outcome, `deleteAll` and alarm semantics, `CODEX_HOME`, and Cursor `AGENTS.md` support.
- `README.md` and `docs/RELEASE_CHECKLIST.md` (U4).

---

## Implementation Units

| U-ID | Title | Key files | Depends on |
|---|---|---|---|
| U1 | Own-post tracking by envelope id | `packages/mcp/src/{state,session}.ts`, `packages/cli/src/room-post.ts` | M3 |
| U2 | Codex, Gemini, Cursor adapters and MCP instructions | `packages/cli/src/adapters/*`, `commands/{install,uninstall}.ts`, `packages/mcp/src/server.ts` | U1 |
| U3 | Shared relay core and relay-cf | `packages/protocol/src/relay-core.ts`, `packages/relay-node/src/relay.ts`, `packages/relay-cf/**`, `tests/conformance/test/wire-*` | U1 |
| U4 | README and release checklist | `README.md`, `docs/RELEASE_CHECKLIST.md` | U2, U3 |

### U1. Own-post tracking by envelope id

- **Goal:** R1-R3, AE1, AE2.
- **Files:** `packages/mcp/src/state.ts`, `packages/mcp/src/session.ts`, `packages/cli/src/room-post.ts`, `packages/mcp/test/{session,notify,state}.test.ts`, `packages/cli/test/{say-approve,hook-expansion}.test.ts` (extended).
- **Approach:**
  1. Add the `sent` variant to `QueueRecord`. `replayQueue` collects `sentIds` and ignores the record for seq and history. `readQueueTail` returns `{ readIds, sentIds, bytes }`.
  2. Session: seed `localIds` from the replay. `send`/`handoff` append `sent` before the `put` (KTD2). In the inbound handler, when the id is neither pending nor in `localIds`, run the tail read (the existing `syncExternalReads` path, extended to merge `sentIds`), then compute `local` and `own` per KTD1. `maybeNotify` returns early when `local`, replacing the member-name check. Update the "Own:" comment.
  3. `connectForPost().post` appends `sent` with the envelope id before the `put`. This covers say, approve, watch input and hook release. Update the "never writes queue.jsonl" docstring.
- **Test scenarios:**
  - Two sessions named `dev` with separate homes on one relay (AE1): each sees the other's question as unread, framed. Neither sees its own.
  - notify: a needs-you message from another `dev` raises a notification. A needs-you message this machine sent does not.
  - A second session sharing one home and member: the first session's agent post is own for the second (KTD2).
  - A CLI-released agent draft (via `connectForPost`) is own for the local session, and the `sent` record precedes the echo (AE2).
  - A local human `say` is not own: it stays unread for the agent (M3 KTD14 regression).
  - `replayQueue` and `readQueueTail` with `sent` lines, a torn tail, and an old queue without `sent`.
  - The existing invariant 2 source guard is still green.
- **Verification:** mcp and cli suites green. `tests/conformance` two-agents and claude-plugin tests green.

### U2. Codex, Gemini, Cursor adapters and MCP instructions

- **Goal:** R4-R9, AE3, AE4.
- **Files:** `packages/cli/src/adapters/{index,codex,gemini,cursor,json-config,toml,snippet}.ts`, `packages/cli/src/commands/{install,uninstall}.ts`, `packages/cli/src/args.ts` (the `--project` flag and usage text), `packages/mcp/src/server.ts`, tests `packages/cli/test/{adapters-toml,adapters-json,adapters-snippet,install-agents}.test.ts`, `packages/mcp/test/server.test.ts`, and fixtures under `packages/cli/test/fixtures/adapters/`.
- **Approach:**
  1. `toml.ts` per KTD5: `setAgentroomTable(text, {command, args}) -> text` and `removeAgentroomTable(text) -> text`. Both throw a typed error for unsupported forms.
  2. `json-config.ts`: read the file (missing becomes `{}`, a non-object throws naming the file), set or delete `mcpServers.agentroom`, drop `mcpServers` if it becomes empty and we were the only entry, then write the file atomically with a trailing newline. Follow `writeProjectMcp` in `install.ts`.
  3. `snippet.ts`: `upsertBlock(text, body)` and `removeBlock(text)` with the markers. The body is the UX.md sentence verbatim.
  4. The adapters table maps the agent to its config path (user or project, KTD3 and the Assumptions), its writer and its snippet file. `install`/`uninstall` dispatch `claude` to the existing code and the others to the table. Each changed file is printed once, followed by a restart line. `afterRoomReady` calls the table for non-Claude agents instead of printing the raw command.
  5. `mcpServerCommand(entryPath, roomId?)` (KTD4).
  6. `server.ts`: `instructions` becomes the intro sentence, then `RULES_TEXT`, then "Call `inbox` at the start of each task and after each step; call `wait` when you are blocked on the other side."
- **Test scenarios:**
  - TOML: the AE3 fixture round-trip (install, install again, uninstall). An existing `[mcp_servers.agentroom]` with an `env` subtable gets replaced. A quoted-key header gets replaced. A `"""` string containing `[mcp_servers.agentroom]` is left alone. Inline-table and dotted-key forms are refused with the file named. An empty or missing file works.
  - JSON: Gemini and Cursor shapes exactly (Cursor has `type: "stdio"`, Gemini has no `type`). Other servers and keys survive. Invalid JSON aborts and leaves the file unchanged. Uninstall of the last entry removes `mcpServers`.
  - Snippet: append to an existing file, create a missing file, replace an existing block, idempotent, remove, and delete the file when only our block remained (AE4).
  - The `--project` scope picks the repo-root files. User scope picks temp-HOME files. A spawned `up --agent codex` (with the relay from test helpers) writes `~/.codex/config.toml` and `AGENTS.md` and prints both paths.
  - `install bogus` exits 2 with usage. `uninstall gemini` with nothing installed exits 0 with "nothing to remove".
  - server: the client's `getInstructions()` contains `RULES_TEXT` and the inbox/wait sentence. The no-room server's instructions are unchanged.
- **Verification:** cli and mcp suites green. No real home dir touched (tests assert that `HOME` is the temp dir).

### U3. Shared relay core and relay-cf

- **Goal:** R10-R14, AE5, AE6.
- **Files:** `packages/protocol/src/{relay-core,wire}.ts`, `packages/protocol/{tsup.config.ts,package.json}`, `packages/protocol/test/relay-core.test.ts`, `packages/relay-node/src/relay.ts`, `packages/mcp/src/relay-client.ts`, `packages/relay-cf/{package.json,tsconfig.json,wrangler.jsonc,src/index.ts,src/room.ts}`, `tests/conformance/{package.json,test/wire-suite.ts,test/wire-node.test.ts,test/wire-cf.test.ts,test/relay-cf-e2e.test.ts,test/cf-helpers.ts}`, root `package.json` (`onlyBuiltDependencies`), `.gitignore` (`.wrangler/`).
- **Approach:**
  1. Write `relay-core.ts` (KTD6) and `roomUrl` (KTD8). Refactor relay-node onto the core without changing `relay.test.ts`. relay-node passes protocol's libsodium `verifyClose` as the verifier. The core takes `verify` as a parameter.
  2. Switch the relay-client connect sites to `roomUrl`.
  3. Scaffold `packages/relay-cf`: exact-pinned `wrangler` and `@cloudflare/workers-types` dev deps (current majors per Sources), and a tsconfig with `types: ["@cloudflare/workers-types"]` and no Node types. The tsconfig includes only `src`, so the Workers types and `@types/node` never meet.
  4. `src/index.ts`: validate the upgrade and `room` (KTD8), then forward to `env.ROOMS.get(env.ROOMS.idFromName(room))`.
  5. `src/room.ts`: a `Room` Durable Object per KTD10 and KTD11. Its `fetch` accepts the socket with `acceptWebSocket(server, ["pending"])`. `webSocketMessage` parses through the core. On `hello` it decides through `decideHello`, then re-tags the socket by writing the attachment `{ role, nonce, tokens, refilledAt, closeBy? }`, because tags are fixed at accept. Membership is counted from `getWebSockets()` filtered by attachment role. Binary frames get `bad_proto`. Frames over 96 KiB are closed with code 1009. `webSocketClose` broadcasts presence. `alarm` handles expiry, closer grace and the tomb.
  6. Conformance: `wire-suite.ts`, the node and cf runners, `cf-helpers.ts` (KTD9), and a relay-cf e2e that reuses the two-agents setup (`up`/`join` with `AGENTROOM_RELAY` set to the cf URL, two MCP children, question then answer, both framed).
  7. Invariant 1 on cf: after a session with a known plaintext marker, fetch the Durable Object's storage through a test-only path and assert no plaintext, no `sig`, and nothing outside `b:` blobs. The test-only path is the `unstable_startWorker` `getDurableObjectStorage`-style API if wrangler exposes one, or else a route compiled in only when the var `TEST_INSPECT=1` is set, which the deployed `wrangler.jsonc` never sets. Also capture worker stdout logs and assert they contain no blob.
- **Test scenarios:**
  - relay-core unit: `decideHello` for each outcome (create, room_exists, room_not_found, tombstone giving room_expired, room_full, closer eviction, closeOnly with create or since giving bad_proto). TTL capping. `expiresAt` uses the earlier deadline. Token refill and limit. `decodedLength` with 0, 1 and 2 padding characters, checked against `Buffer` in the test only. Exactly 64 KiB accepted. Nonce uniqueness. The import guard.
  - The KTD7 cross-check vectors: libsodium and Web Crypto agree on every case.
  - `wire-suite` against relay-node: all KTD12 cases. Against relay-cf on Node 22: the same cases plus URL routing (missing room gives 400, mismatched hello room gives `bad_proto`), AE5, AE6, and a hibernation-safe state check (a member joins after other sockets have gone idle and still gets the buffer through `since`).
  - relay-cf e2e: question and answer framed on both sides, `down` closes the room for the peer.
  - `relay.test.ts` passes unchanged.
- **Verification:** `pnpm -r build`, `pnpm typecheck`, `pnpm lint` and `pnpm -r test` green on Node 22 with the cf tests running, and on Node 20 with the cf tests reported as skipped. Report the real counts. The `unstable_startWorker` outcome and the Storage API findings are recorded in OPEN_QUESTIONS.

### U4. README and release checklist

- **Goal:** R15, R16.
- **Files:** `README.md`, `docs/RELEASE_CHECKLIST.md`, `docs/UX.md` (non-Claude section), `docs/ARCHITECTURE.md` (Documentation Plan items not already landed with U1-U3).
- **Approach:**
  1. README quickstart per agent: `npx agentroom up --agent <x>` and `npx agentroom join <code> --agent <x>`, then restart the agent and use the human paths (Claude plugin commands, or `agentroom watch` for the others).
  2. The honest delivery note: Codex, Gemini and Cursor see messages only when they call `inbox`/`wait`, the `AGENTS.md`/`GEMINI.md` snippet asks them to, and whether each one does so unprompted is still being measured (OPEN_QUESTIONS 13). Cursor support covers the local agent only.
  3. Self-hosting: relay-node with `node packages/relay-node/dist/bin.js` (or the published bin), env vars and defaults, binding to `127.0.0.1` behind Caddy or nginx for TLS with WebSocket upgrade, pointing clients at it with `--relay wss://...` or `AGENTROOM_RELAY`. relay-cf with `pnpm --filter @agentroom/relay-cf exec wrangler deploy`, the vars table, and the note that a per-IP creation cap is the operator's job.
  4. The threat model stays, or links to ARCHITECTURE.
  5. `RELEASE_CHECKLIST.md`: prerequisites (Node 22, a relay URL, three terminals or machines). Steps: Claude Code `up`; Codex and Gemini `join --agent`; a question from Claude answered by Codex; a Gemini `inbox` showing both, framed; a chain limit hit and a human approve through `watch`; a fake secret blocked; `down` closing the room for all three; a final check that state dirs are removed. Each step has an expected result and a pass/fail box. Include the KTD9 fallback step if it was used.
- **Test scenarios:** none. Docs only. Commands named in the README are checked against `agentroom --help` output by hand.
- **Verification:** `pnpm lint` green. Every command in the README exists in the CLI usage text.

---

## Verification Contract

| Gate | Command | Applies |
|---|---|---|
| Install | `pnpm install --frozen-lockfile` on Node 20 and Node 22 (an engines warning from wrangler on 20 is expected and noted) | U3 onward |
| Build | `pnpm -r build` (relay-cf has no build script) | all |
| Typecheck | `pnpm typecheck` | all |
| Lint | `pnpm lint` | all |
| Tests | `pnpm -r test` | all |
| Node 20 | the same sequence. relay-cf files are reported as skipped, with the count given | all |
| Isolation | temp `AGENTROOM_HOME`, `HOME`, `CLAUDE_CONFIG_DIR`, no `CODEX_HOME`, `AGENTROOM_NOTIFY=off`, `WRANGLER_SEND_METRICS=false`, local workerd only | U1-U3 |

The tree is green after every unit.

M4 items in `docs/PLAN.md`, mapped to proof:

| PLAN item | Proof |
|---|---|
| Adapters `install codex/gemini/cursor` | U2 tests, AE3, AE4 |
| Agents call `inbox`/`wait` when instructed; README honest | U2 instructions and snippet; U4 README. Real-agent check is a human step |
| relay-cf passes the shared conformance suite | U3 `wire-cf` and e2e on Node 22 |
| Manual pre-release checklist | U4 `docs/RELEASE_CHECKLIST.md` |
| README quickstart, threat model, self-hosting | U4. The demo GIF is a human step |
| Publish, tag, Claude plus Codex public-relay acceptance | Human steps |

## Definition of Done

- Every gate passes with real output reported, including the Node 20 run and its skip count.
- R1-R16 hold. AE1-AE6 each have a passing test, except R15 and R16, which are docs.
- Invariant regression tests: 1 (relay-cf storage and logs, relay-node unchanged), 2 (MCP source guard unchanged; `sent` records never make a human envelope own), 5 (inbound still framed in the two-`dev` test and the cf e2e), 7 (relay-cf `deleteAll` on close and expiry, tomb removed at max age).
- Docs updated per the Documentation Plan. `docs/PLAN.md` and `docs/LOG.md` are not touched.
- New dependencies are limited to `wrangler` and `@cloudflare/workers-types` (dev, relay-cf). No TOML library, no telemetry, no network calls other than to the configured relay.

## Deferred to Implementation

- The exact `unstable_startWorker` options, and whether it exposes Durable Object storage for the invariant 1 test (KTD9, U3 step 7).
- Whether `deleteAll()` clears the alarm at the chosen compatibility date (KTD10). The plan calls `deleteAlarm()` either way.
- Whether Codex honors `CODEX_HOME`, and whether Cursor reads `AGENTS.md` (Assumptions).

## Open Questions

Deferred to humans. None block implementation.

- Should `install codex|gemini|cursor` default to project scope, which is Gemini's own default, instead of user scope? This plan uses user scope for all three for consistency. The entry carries no room id (KTD4), so either scope is safe.
- Should Gemini's `BeforeAgent` or Cursor's `beforeSubmitPrompt` hook get a `/say` path in a later milestone? Out of v0 scope per OPEN_QUESTIONS 11 and 12.
