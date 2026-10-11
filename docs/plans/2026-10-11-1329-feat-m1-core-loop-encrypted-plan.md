---
title: Milestone 1 Core Loop, Encrypted - Plan
type: feat
date: 2026-10-11
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Milestone 1 Core Loop, Encrypted - Plan

## Goal Capsule

- **Objective:** Two developers can each run one CLI command (`up` on one side, `join` with the share code on the other), restart their Claude Code session, and have their agents exchange a question and its answer through a relay that only ever holds ciphertext. The whole loop is proven by an automated two-agent conformance test before anyone deploys a relay.
- **Means:** Shared crypto, schemas and inbound framing in `@agentroom/protocol`. An in-memory `ws` relay in `@agentroom/relay-node`. A stdio MCP server with a reconnecting relay client and a local room directory in `@agentroom/mcp`. `parseArgs` commands in `agentroom` (the CLI). A private conformance workspace package (KTD1-KTD16).
- **Authority:** `CLAUDE.md` invariants 1-7 and stack, then `docs/ARCHITECTURE.md`, then `docs/PLAN.md` Milestone 1, then this plan. `docs/OPEN_QUESTIONS.md` items 2 and 3 (verified 2026-10-11) are settled inputs. The M0 plan's KTD6 pins are settled. Where this plan defines behavior the docs leave open, it updates `docs/ARCHITECTURE.md` in the same unit (Documentation Plan).
- **Stop conditions:**
  - Stop if a pinned dependency cannot run on Node 20.19 or cannot build with tsup's dts step.
  - Stop if `@modelcontextprotocol/server` 2.3.x lacks `McpServer.registerTool` with a zod v4 object schema or `serveStdio`, which OPEN_QUESTIONS item 2 records.
  - Stop if any test would touch the real `~/.agentroom` or run the real `claude` binary. A test that cannot be isolated is a blocker, not a skip.
- **Execution profile:** TypeScript library, server and CLI code with unit, integration and stdio end-to-end tests. No deployment.
- **Who finishes:** The implementing agent builds and verifies locally. Deploying `relay-node` and the two-person test are human steps (out of scope). The orchestrator ticks `docs/PLAN.md` and writes `docs/LOG.md`; this work edits neither.

---

## Product Contract

### Summary

Build the encrypted core loop. `protocol` gets the envelope, wire and meta schemas, ULIDs, share codes, HKDF, XChaCha20-Poly1305 sealing, close keypairs and `frameInbound`. `relay-node` gets a create-versus-join WebSocket relay with a bounded buffer, sequence numbers, resume and idle expiry. `mcp` gets a stdio server with `room_status`, `send`, `inbox` and `wait` over a local room directory. `agentroom` (the CLI) gets `up`, `join`, `status`, `install claude` and `mcp`. A conformance test runs two real MCP server processes against an in-process relay.

### Problem Frame

Milestone 0 left four skeleton packages that export a version constant. The product's reason to exist is that two people's agents can talk without humans copy-pasting, and `docs/PLAN.md` puts encryption in M1 because the first real test runs through a deployed relay that must never see plaintext (invariant 1). Every later milestone (chain limit, secret scanner, plugin, other agents, relay-cf) builds on the formats fixed here, the wire protocol, the envelope, the share code and the local room directory, so mistakes in them get expensive once a relay is deployed and a second relay implementation must conform.

### Requirements

**Protocol and crypto (`@agentroom/protocol`)**

- R1. The `Envelope` zod schema matches `docs/ARCHITECTURE.md` "Message envelope" field for field, including `refs` (`{repo, path, lines?, commit?}`, max 20) and no field that could carry file contents (invariant 6).
- R2. Relay wire schemas cover client-to-relay `hello` (with optional `since` and optional `create` block), `put` and `close`, and relay-to-client `welcome`, `msg`, `presence`, `closed` and `error` with the eight error codes in ARCHITECTURE. A discriminated union parses each direction.
- R3. Ids are ULIDs: 26 Crockford base32 characters, time-sortable (KTD3).
- R4. A share code is `ar1_` plus unpadded base64url of 32 random bytes. Parsing rejects a wrong prefix, wrong length, padding, characters outside base64url, and non-canonical encodings.
- R5. `room_id` (lowercase hex) and the room key derive from the secret with HKDF-SHA256, empty salt, info `agentroom/v1/room` and `agentroom/v1/key`.
- R6. Envelopes and room `meta` are sealed with XChaCha20-Poly1305, a fresh 24-byte nonce each time, `room_id` as associated data (KTD5), blob = base64(nonce || ciphertext). Opening fails on any flipped byte, the wrong key, or the wrong `room_id`.
- R7. Room `meta` is `{ name?, maxAgentChain }` (default 3), sealed like an envelope.
- R8. `up` can generate an Ed25519 close keypair; the public key travels in the `create` block. Verification of `close` is M2.
- R9. `frameInbound` renders envelopes per ARCHITECTURE "Inbound framing" with a fresh random tag suffix per call and escaping (KTD9), so no body, ref or attribute value can close the tag, open a forged tag, or break out of an attribute.

**Relay (`@agentroom/relay-node`)**

- R10. A `hello` with `create` creates the room and pins `closeKey`, the idle TTL (capped at the relay default) and `meta`. A `create` for a live id gets `room_exists`. A `hello` without `create` for an unknown id gets `room_not_found`.
- R11. Each room keeps the last 500 envelopes with relay-assigned seq starting at 1 and increasing by one per `put`. `msg` frames go to every connection in the room, the sender included (KTD7).
- R12. `hello` with `since: n` replays buffered envelopes with seq > n before any live frame. `hello` without `since` replays nothing. `welcome.seq` is the head seq at the moment of the welcome (KTD7).
- R13. `welcome` carries `seq`, `members` (connection count including the new one), `expiresAt`, a fresh per-connection `nonce`, and the stored `meta`. Every connect and disconnect broadcasts `presence` with the new count.
- R14. A room expires after the idle TTL (default 8 h) with no `put` and no `hello`. On expiry the relay sends `error{room_expired}` to each open connection, closes them and drops all room state.
- R15. A `put` whose decoded blob exceeds 64 KiB gets `too_large` and is not stored. Malformed JSON, schema failures, `proto` other than 1, a frame before `hello`, or a second `hello` get `bad_proto` and the connection closes. `close` is rejected with `bad_proto` and a "not supported until M2" message (KTD8).
- R16. The relay stores only `room_id`, seq, ciphertext blobs, the meta blob, the close public key and timestamps, and never logs blobs or meta.
- R17. `startRelay({ port, ... })` starts the relay in-process and returns a handle for tests. A `bin` entry runs it from `PORT`/`HOST` env.

**MCP server (`@agentroom/mcp`)**

- R18. `agentroom mcp --room <room_id>` serves MCP over stdio with tools `room_status`, `send`, `inbox`, `wait` per the ARCHITECTURE tool table. `draft` and `handoff` are M2. Nothing but protocol traffic goes to stdout.
- R19. Local state follows KTD11: `$AGENTROOM_HOME` (default `~/.agentroom`) holds `current` and `rooms/<room_id>/` with `room.json` (0600), `queue.jsonl` (0600) and `status.json` (0600) in a 0700 directory.
- R20. On startup the server connects with `since=0`, drops any envelope id already in `queue.jsonl`, and appends new ones. After a drop it reconnects with exponential backoff and resumes from the highest seq seen. It stops reconnecting on `room_not_found` or `room_expired`.
- R21. The MCP server never emits an envelope with `from.agent = "human"`. Every outgoing `from` is built from `room.json`'s agent, typed to a non-human enum, with `via: "mcp"`, and a runtime guard in the single seal path refuses `human` (invariant 2, KTD12).
- R22. `inbox` and `wait` return unread messages wrapped by `frameInbound` and mark them read. `wait` returns at once when unread messages exist, otherwise blocks up to `timeoutSec` (default 30, max 50) (KTD13).
- R23. `send` validates against `Envelope`, derives `thread`, seals, posts, and returns the id and seq once the relay echoes it. It calls a send-policy hook that is a no-op in M1 and is where M2 adds the chain limit and secret scanner.
- R24. On room expiry or `room_not_found` the server deletes the room directory and clears `current` if it names this room. It keeps not-yet-read messages in memory for one final `inbox`/`wait`, then every tool returns the `room_expired` instruction to run `agentroom up` again (invariant 7).
- R25. A decryption or schema failure on an inbound envelope drops it, increments a counter, and `room_status` shows the count.

**CLI (`agentroom`)**

- R26. `up [--agent claude|codex|gemini|cursor] [--name <member>] [--relay <url>] [--max-chain <n>]` generates the secret and close keypair, sends the creating `hello`, writes the room directory, sets `current`, runs `install` for `--agent claude`, and prints the share code, the join command, and when the room expires.
- R27. `join [code] [--agent ...] [--name ...] [--relay <url>]` prompts for the code on a TTY when it is omitted, refuses without a TTY, joins with a plain `hello`, and writes nothing locally when the relay answers `room_not_found` or is unreachable.
- R28. `status [--room <id>]` prints the room, member, relay, live connection count, expiry, and unread counts from `status.json` when present.
- R29. `install claude [--room <id>]` registers the MCP server with Claude Code per KTD15, or writes a project `.mcp.json` entry when `claude` is not on PATH and says so.
- R30. `--relay` and `AGENTROOM_RELAY` override the default relay URL. The default is the placeholder constant `wss://relay.agentroom.dev` until a relay is deployed (KTD14). The chosen URL is stored in `room.json`.
- R31. The package declares `bin: { agentroom: "./dist/bin.js" }`. There is no `--log` flag and no command writes decrypted messages anywhere except the room directory (invariant 7).

**Conformance**

- R32. An automated test runs two `agentroom mcp` processes (spawned from the built CLI, driven by `@modelcontextprotocol/client` over stdio) against an in-process relay on an ephemeral port. The two agents exchange a question and an answer, see each other in `room_status`, resume after a forced disconnect without loss or duplicates, and the relay's stored state contains no plaintext marker.

### Acceptance Examples

- AE1. **Covers R10, R26, R27.** Given a relay with no rooms, when Bob runs `join` with a valid code nobody has `up`-ed, then `join` prints that the room was not found (expired, closed, or the relay restarted; check `--relay`) and `$AGENTROOM_HOME` has no new room directory and an unchanged `current`.
- AE2. **Covers R11, R12, R20.** Given Alice's MCP server has seen seq 1-4, when its socket drops, Bob's message becomes seq 5, and Alice reconnects, then Alice sends `hello{since: 4}`, receives only seq 5, and her next `inbox` shows it exactly once.
- AE3. **Covers R20, R22.** Given Alice's server restarts with seq 1-5 already in `queue.jsonl` and seq 3 still unread, when it rebuilds from `since=0`, then no envelope is appended twice and `inbox` returns only seq 3.
- AE4. **Covers R22.** Given one unread message, when the agent calls `wait`, then it returns immediately with that message framed. Given none, `wait{timeoutSec: 1}` returns a non-error "no new messages" result after about one second.
- AE5. **Covers R14, R24.** Given an MCP server with one unread message, when the relay expires the room, then the room directory is gone, the next `inbox` returns the unread message plus the expiry notice, and the call after that returns the `room_expired` instruction without reconnecting.
- AE6. **Covers R21.** Given a hand-edited `room.json` with `agent: "human"`, when `agentroom mcp` starts, then it exits with a schema error and posts nothing.

### Scope Boundaries

- No relay deployment and no default hosted relay (human step).
- No chain limit, secret scanner, `draft`, `handoff`, `agentroom-rules` prompt, `down`, `say`, `approve`, `watch`, `export`, Claude Code plugin, or adapters for other agents (M2-M4).
- `close` signature verification, tombstones for closed or expired ids, max age, rate limits and the member cap are M2. Config knobs for them may exist on `startRelay` but do nothing beyond storing values.
- No `relay-cf`. The conformance package is written so a second relay can be plugged in (KTD1), but M1 runs only `relay-node`.
- No `--log` flag, no file transfer, no telemetry.

Considered and not built:

- **Detecting a seq gap after buffer roll-over.** ARCHITECTURE already states relay drops are not detected in v0. Revisit if the human test loses a message.
- **Distinguishing a relay restart from expiry.** relay-node is in memory, so after a restart every room is `room_not_found`. The error text names the possibility and unread messages survive in memory (R24). A persistent relay is relay-cf's job.
- **A wire-level `put` ack with a client correlation id.** The echo to the sender plus one-at-a-time sends gives `send` its confirmation and error attribution without changing the documented wire protocol (KTD7). Revisit if relay-cf needs concurrent puts.
- **Cross-process locking of the room directory.** Two MCP servers for one room on one machine append with `O_APPEND` and dedupe by id on read. Each keeps its own read state until restart (KTD11). Revisit if two-window use proves common.
- **Sweeping stale room directories whose expiry was never observed.** The next MCP start or `status` detects expiry and deletes the directory. Revisit in M2 with `down`.

#### Deferred to Follow-Up Work

- M2 fills the `send` policy hook (chain limit with `thread`/`replyTo` mismatch rejection, room-wide counter, secret scanner), verifies `close`, remembers closed and expired ids, and enforces max age.
- `.gitignore` still lists `.agentsync/`. M1 adds no repo-local state, so the rename stays deferred.
- Publishing `agentroom` to npm (M4). Until then `install claude` writes an absolute local command when the CLI runs from a checkout (KTD15).

### Sources

- `CLAUDE.md`, `docs/ARCHITECTURE.md` (Relay, Crypto, Message envelope, MCP server, Local state and process model, Failure handling), `docs/UX.md` CLI section, `docs/PLAN.md` Milestone 1, `docs/OPEN_QUESTIONS.md` items 2 and 3.
- `docs/plans/2026-10-11-1246-chore-m0-workspace-scaffold-plan.md` KTD2 (typecheck after build), KTD4 (tsup), KTD5 (vitest layout), KTD6 (pins).
- Package manifests and type declarations checked 2026-10-11 with `npm view` and `npm pack`: `libsodium-wrappers@0.8.4` (ESM default export plus named `ready`, `crypto_aead_xchacha20poly1305_ietf_*`, `crypto_sign_keypair`), `@modelcontextprotocol/server@2.3.1` (`McpServer`, `InMemoryTransport`; `./stdio` exports `serveStdio(factory)` and `StdioServerTransport`), `@modelcontextprotocol/client@2.3.1` (`Client`, `InMemoryTransport`; `./stdio` exports `StdioClientTransport`), `commander@15.0.0` (`engines.node >=22.12.0`), `ulid@3.0.2`, `ulidx@2.4.1` (depends on `layerr`), `ws@8.22.0`, `zod@4.6.6`.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Conformance lives in a private workspace package `tests/conformance` (`@agentroom/conformance`).** `pnpm-workspace.yaml` gains `tests/*`. It depends on `agentroom`, `@agentroom/relay-node`, `@agentroom/protocol` and `@modelcontextprotocol/client` via `workspace:*` and dev deps. Putting it in `relay-node` would make the relay depend on the MCP client and CLI. Putting it in `cli` would hide a cross-package suite inside one package. The suite takes a relay factory (`() => Promise<{ url, snapshot, disconnectAll, ... }>`) so relay-cf can run it in M4. It has no build script, so `pnpm -r build` skips it, and it runs after build because it spawns `packages/cli/dist/bin.js`.
- KTD2. **CLI argument parsing with `node:util.parseArgs`, no dependency.** commander 15 requires Node 22.12+ and would fail the Node 20 CI leg. commander 14 would work, but five subcommands with a handful of flags stay readable as a small dispatch table over `parseArgs` with `strict: true`.
- KTD3. **ULIDs implemented in `protocol` from `crypto.randomBytes`, no dependency.** 48-bit millisecond time plus 80 random bits, Crockford base32, about twenty lines. `ulidx` pulls a transitive dependency and `ulid` adds a package for that one function. Monotonic same-millisecond ordering is not needed because ordering uses relay seq (ARCHITECTURE "Clock skew").
- KTD4. **Crypto API is async and initializes libsodium itself.** `seal`, `open`, `sealMeta`, `openMeta` and `generateCloseKeyPair` await `sodium.ready` internally (cheap after the first call), so no caller can forget to initialize. HKDF uses `node:crypto` `hkdfSync('sha256', secret, Buffer.alloc(0), info, 32)`. libsodium is imported as the ESM default export of `libsodium-wrappers` 0.8, which ships its own types. Do not add `@types/libsodium-wrappers`.
- KTD5. **Associated data is the UTF-8 bytes of the 64-character lowercase hex `room_id`,** the same string the relay sees, for both envelopes and meta. Domain separation between meta and envelopes comes from schema parsing after decryption: a meta blob replayed as a `msg` fails `Envelope` parsing and is counted as a failure (R25). This matches ARCHITECTURE ("Associated data: room_id") without a prefix.
- KTD6. **Share code parsing is strict and canonical.** Match `^ar1_[A-Za-z0-9_-]{43}$`, decode with `Buffer.from(s, 'base64url')`, require 32 bytes, and require re-encoding to equal the input. Node's base64url decoder silently ignores invalid characters, so the regex and round-trip checks are what make rejection real.
- KTD7. **Wire semantics the docs leave open, fixed now because a deployed relay and relay-cf will pin them.**
  - `msg` goes to all connections including the sender. The sender's echo is its confirmation and carries its seq.
  - `hello` without `since` replays nothing. `since: n` replays seq > n in order before any live frame.
  - `welcome.seq` is the head seq, so a client knows catch-up is complete when it has seen that seq.
  - `presence{members}` is broadcast to the room on every connect and disconnect.
  - The 64 KiB limit applies to decoded blob bytes. The `ws` server sets `maxPayload` to 96 KiB, which bounds `hello` and `meta` too.
  - Idle means no `put` and no `hello`. An open but silent connection does not keep a room alive.
  - These go into ARCHITECTURE's Relay section in U4.
- KTD8. **`close` is rejected in M1, not accepted unsigned.** Accepting an unsigned `close` would let any member who knows the `room_id` delete the room, and M2 would have to break that behavior. The relay answers `error{bad_proto, "close is not supported until protocol M2"}`.
- KTD9. **`frameInbound` escaping rules.**
  - The tag is `agentroom_message_` plus 12 hex characters from `crypto.randomBytes(6)`, fresh per call and shared by every message in that call.
  - Attribute values (`from`, `kind`, `thread`, and `to` when present) are stripped of control characters and newlines, then entity-escaped for `&`, `<`, `>`, `"` and `'`.
  - In the body and each rendered ref line, any `<` that begins `agentroom_message` or `/agentroom_message` in any letter case becomes `&lt;`. Other `<` characters stay so code snippets such as `List<String>` remain readable.
  - Ref fields are stripped of control characters and newlines and rendered one per line as `repo/path:lines @ commit`, then escaped like the body.
  - After rendering, the function asserts that each message's open and close tags appear exactly once, and throws if not (defence in depth; unreachable unless the rules above regress).
  - Each message is followed by the fixed reminder line from ARCHITECTURE.
- KTD10. **The relay client and room-state store live in `@agentroom/mcp` and are exported for the CLI.** `up`, `join` and `status` need a one-shot relay connection and the same `room.json` format. A fifth package would add a manifest and build step for two modules. `agentroom` depends on `@agentroom/mcp` via `workspace:*`. `ws` is a dependency of `mcp` because Node 20 has no stable global `WebSocket` client.
- KTD11. **Local state contract.** Owned by `packages/mcp/src/state.ts`; ARCHITECTURE's "Local state and process model" gets these details in U5.
  - `room.json` holds `v`, `roomId`, `secret` (share code), `relay`, `member`, `agent`, `createdByMe`, and `closeSecretKey` when created here. Only `up` and `join` write it, atomically (temp file with mode 0600, then rename). It holds no fast-changing fields. The last seen seq lives in memory and in `status.json`, a small change from ARCHITECTURE's wording, made because a torn write to the file that holds the secret would lose the room.
  - `queue.jsonl` is an append-only event log of `{t:"msg", seq, env, own}` and `{t:"read", ids}` lines, each written with one `O_APPEND` write. It is never drained or rewritten, so it remains the seen-id set across restarts. Replay on startup rebuilds the seen set, unread set and history.
  - `status.json` is rewritten atomically on every state change. It holds connection state, live connection count, members seen, unread count, needs-you count (unread with `requiresHuman` or `to` equal to this member), decrypt-failure count, `expiresAt`, `lastSeq` and `updatedAt`.
  - Own messages (sent by this member through this process) and `presence` envelopes are stored but never unread. Pre-join history replayed on first start counts as unread.
  - All path resolution goes through one `agentroomHome(env)` function honoring `AGENTROOM_HOME`. Every test sets it to a fresh temp directory.
- KTD12. **Invariant 2 is structural.** `room.json`'s `agent` field is `z.enum(["claude-code", "codex", "gemini", "cursor", "other"])`. The single `buildFrom(room)` function returns `{ member, agent, via: "mcp" }` typed to that enum. The `send` tool's input schema has no `from`, `agent` or `via` fields, and its `kind` enum excludes `approve` and `presence`. The seal path re-checks `from.agent !== "human"` and throws. `up`/`join` map `--agent claude` to `claude-code` and reject anything else outside the enum.
- KTD13. **`inbox` and `wait` contract.** Both return unread non-presence messages from others, oldest seq first, up to `limit` (default 20, max 100), framed by one `frameInbound` call, and mark exactly those read with one `read` line. When more remain, the text says "N more unread". `inbox` takes an optional `thread` filter. `wait` returns immediately if anything is unread, otherwise resolves on the next qualifying arrival or after `timeoutSec` with a non-error "No new messages in Ns." When the room expires during `wait`, it resolves with the expiry result (R24).
- KTD14. **Relay URL resolution: `--relay` flag, then `AGENTROOM_RELAY`, then `DEFAULT_RELAY = "wss://relay.agentroom.dev"`.** The constant carries a comment that no relay is deployed there yet. `up` stores the URL in `room.json` and prints the exact join command including `--relay` whenever the URL is not the default, so a joiner on the wrong relay is not told the room expired. The MCP server always uses `room.json`'s relay.
- KTD15. **`install claude` command shape.** `claude` on PATH: run `claude mcp remove --scope user agentroom` (ignoring "not found"), then `claude mcp add --scope user --transport stdio agentroom -- <cmd> mcp --room <id>`. `<cmd>` is `npx -y agentroom` when the running CLI resolves inside a `node_modules` directory (an installed package). Otherwise it is the absolute `process.execPath` plus the absolute path of the running `dist/bin.js` (a checkout). No `claude` on PATH: merge an `agentroom` entry `{type:"stdio", command, args}` into `<cwd>/.mcp.json`, keeping other servers, and print that it did so and that the file should not be committed (it names the room id). Commands spawn `claude` with an argument array, never a shell string. (Conflict call-out below.)
- KTD16. **MCP wiring.** `@agentroom/mcp` exports `createRoomSession({ roomId, env })` (state, relay client, unread logic) and `createMcpServer(session)` (tool registration with zod v4 object schemas, as OPEN_QUESTIONS item 2 records). It also exports `runStdio({ roomId, env })`, which calls `serveStdio(() => createMcpServer(session))` from `@modelcontextprotocol/server/stdio` so one session outlives the per-connection server instance. The CLI's `mcp` subcommand calls `runStdio`. Unit tests drive `createMcpServer` in-process through `InMemoryTransport`, and conformance drives the real binary over stdio. Logs go to stderr.

**Conflict call-out on KTD15.** OPEN_QUESTIONS item 3 records `npx -y agentroom mcp --room <id>` as the install command. `agentroom` is not on npm until M4, so that command cannot start the server during the M1 human test. And if someone else published the name first, their code would run next to the room secrets. KTD15 keeps the recorded command for installed copies and writes an absolute local command for checkouts. Publishing a placeholder `agentroom` package early would close the name-squatting window; that is a human decision (Open Questions).

### High-Level Technical Design

Component topology:

```mermaid
flowchart TB
  subgraph Machine_A[Alice's machine]
    CC_A[Claude Code] -- stdio MCP --> MCP_A[agentroom mcp]
    CLI_A[agentroom up/status] --> STATE_A[(AGENTROOM_HOME rooms/id)]
    MCP_A --> STATE_A
  end
  subgraph Relay[relay-node]
    ROOMS[(rooms: seq, ring buffer of blobs, meta blob, closeKey, lastActivity)]
  end
  subgraph Machine_B[Bob's machine]
    CC_B[Claude Code] -- stdio MCP --> MCP_B[agentroom mcp]
    CLI_B[agentroom join/status] --> STATE_B[(AGENTROOM_HOME rooms/id)]
    MCP_B --> STATE_B
  end
  CLI_A -- one-shot wss --> ROOMS
  MCP_A -- long-lived wss --> ROOMS
  MCP_B -- long-lived wss --> ROOMS
  CLI_B -- one-shot wss --> ROOMS
  PROTO[["@agentroom/protocol: schemas, HKDF, seal/open, frameInbound"]] -.used by.-> MCP_A
  PROTO -.used by.-> MCP_B
  PROTO -.schemas only.-> ROOMS
```

Create, join, exchange and resume:

```mermaid
sequenceDiagram
  participant A as Alice CLI/MCP
  participant R as relay-node
  participant B as Bob CLI/MCP
  A->>R: hello{room, proto:1, create{closeKey, idleTtlSec, meta}}
  R-->>A: welcome{seq:0, members:1, expiresAt, nonce, meta}
  Note over A: up writes room.json, prints ar1_ code
  B->>R: hello{room, proto:1}
  R-->>B: welcome{seq:0, members:1, ...}
  Note over B: join decrypts meta to confirm, writes room.json
  A->>R: hello{room, since:0} (MCP startup)
  R-->>A: welcome{seq:0, members:1}
  B->>R: hello{room, since:0} (MCP startup)
  R-->>B: welcome{seq:0, members:2}
  R-->>A: presence{members:2}
  A->>R: put{blob: question}
  R-->>A: msg{seq:1} (echo confirms send)
  R-->>B: msg{seq:1}
  Note over A,R: socket drops
  B->>R: put{blob: answer}
  R-->>B: msg{seq:2}
  A->>R: hello{room, since:1} (after backoff)
  R-->>A: welcome{seq:2, ...}
  R-->>A: msg{seq:2}
```

MCP relay client states:

```mermaid
stateDiagram-v2
  [*] --> Connecting
  Connecting --> CatchingUp: welcome
  CatchingUp --> Live: seen seq == welcome.seq
  Live --> Backoff: socket closed or error
  CatchingUp --> Backoff: socket closed or error
  Connecting --> Backoff: connect failed
  Backoff --> Connecting: delay (0.5 s doubling to 30 s, jitter)
  Connecting --> Gone: error room_not_found or room_expired
  Live --> Gone: error room_expired
  Gone --> [*]: room dir deleted, current cleared
```

Inbound and outbound data flow inside the MCP server (directional):

```text
inbound:  msg{seq, blob} -> open(blob, key, room_id) -> Envelope.parse -> seen(id)? drop
          -> append {t:"msg", seq, env, own} -> update unread / members -> write status.json -> wake waiters
          (open or parse failure -> decryptFailures++ -> status.json)
outbound: send args -> build Envelope (ulid, ts, from=buildFrom(room), thread derivation)
          -> Envelope.parse -> sendPolicy(env, history) [M1: allow] -> assert agent != human
          -> seal -> put -> await own echo (10 s) -> append as own -> return {id, seq}
```

### Assumptions

These are agent bets made without a human to confirm them.

- The member name defaults to the OS username (`os.userInfo().username`). The room name in `meta` is unset in M1 because `docs/UX.md` defines no flag for it. `--max-chain` is stored in `meta` and enforced in M2. `--ttl` is not offered until max age exists (M2).
- `--agent` accepts `claude`, `codex`, `gemini` and `cursor`. Only `claude` runs an install in M1. The others print the manual MCP command. Without `--agent`, the agent is `other`.
- Only the MCP server posts `presence` envelopes, once per process start (not per reconnect), with `thread = id`, empty body and `via: "mcp"`. CLI commands never do. `room_status` reports "members seen" (name, agent, last seen time) alongside the relay's live connection count, because there is no leave signal.
- `status` opens a one-shot `hello` without `since` for the live count and expiry, and reads `status.json` for unread counts labeled with its `updatedAt`. If the relay says `room_not_found`, `status` deletes the room directory like the MCP server does.
- `send` while disconnected returns an error saying the relay is unreachable and reconnecting. It does not queue for later delivery. `send` serializes puts, one in flight at a time, so a `too_large` error is attributable.
- `thread` derivation in M1: when `thread` is omitted and `replyTo` names a known envelope, use that envelope's thread. When `replyTo` is unknown locally, use `replyTo` itself. With neither, `thread = id`. Rejecting a mismatch is M2's chain-limit rule.
- `join` on a machine that already has the room directory keeps `secret`, `closeSecretKey` and `createdByMe`, and updates only `member`, `agent` and `relay`.
- The relay sweeps for idle rooms on an unref'd interval (default 60 s, configurable). Tests inject `now()` and a short interval.

### Output Structure

```text
pnpm-workspace.yaml                         (modified: adds tests/*)
docs/ARCHITECTURE.md                        (modified: wire semantics, local state contract)
README.md                                   (modified: usage, placeholder relay, status)
packages/protocol/src/{index,envelope,wire,meta,ulid,share-code,crypto,frame}.ts
packages/protocol/test/{envelope,wire,ulid,share-code,crypto,frame}.test.ts
packages/relay-node/src/{index,relay,bin}.ts
packages/relay-node/test/relay.test.ts
packages/mcp/src/{index,paths,state,relay-client,session,server,stdio}.ts
packages/mcp/test/{state,relay-client,session,server}.test.ts
packages/cli/src/{index,bin,args,relay-url,commands/up,commands/join,commands/status,commands/install,commands/mcp}.ts
packages/cli/test/{args,up-join,status,install}.test.ts
tests/conformance/{package.json,tsconfig.json}
tests/conformance/test/two-agents.test.ts
```

### Risks

| Risk | Mitigation |
|---|---|
| A test runs the real `claude` binary and rewrites the developer's Claude config (it is on PATH on the dev machine). | CLI commands take an injected `{ env, cwd, stdout, stderr, isTTY }` context. Install tests pass a `PATH` that contains only a temp directory with a fake `claude` script (or nothing). Conformance never passes `--agent claude`. |
| A test writes to the real `~/.agentroom`. | One `agentroomHome(env)` resolver. Every mcp, cli and conformance test sets `AGENTROOM_HOME` to a fresh temp dir, and a unit test asserts the resolver honors it. |
| Flaky resume test because reconnect timing races the injected message. | The relay handle exposes `setAccepting(false)`, `disconnectAll()` and `inject(roomId, blob)`; the test blocks reconnects, injects, then re-allows. No sleeps tied to backoff timing. |
| libsodium-wrappers ESM import breaks under tsup or vitest. | Verified 0.8.4 exports an ESM default and `ready`. U2 tests run against source in vitest and the built `dist` is exercised by conformance. |
| `serveStdio`'s factory may be called more than once per process. | The session is created once outside the factory (KTD16), so a second call gets a fresh `McpServer` over the same session. |
| relay-node restart during the human test looks like expiry. | Error text names the possibility, and unread messages survive in memory (R24). Flag it for `docs/LOG.md` (orchestrator). |
| Name squatting on `agentroom` before publish. | KTD15 avoids `npx` from checkouts; the early placeholder publish is an open human decision. |

### Documentation Plan

- U4 adds KTD7's wire semantics and the M1 `close` rejection to ARCHITECTURE's Relay section.
- U5 adds KTD11's local state contract to "Local state and process model", noting `lastSeq` moved out of `room.json`.
- U9 records KTD15's install command choice in ARCHITECTURE (or OPEN_QUESTIONS item 3's decision line as an addendum, dated).
- U8 updates README: the CLI commands that exist, that the default relay is a placeholder until deployment, and the Status line.

---

## Implementation Units

| U-ID | Title | Key files | Depends on |
|---|---|---|---|
| U1 | Protocol schemas, ULID, share code | `packages/protocol/src/{envelope,wire,meta,ulid,share-code}.ts` | none |
| U2 | Protocol crypto | `packages/protocol/src/crypto.ts` | U1 |
| U3 | `frameInbound` | `packages/protocol/src/frame.ts` | U1 |
| U4 | relay-node server and bin | `packages/relay-node/src/{relay,bin}.ts` | U1 |
| U5 | MCP local state store | `packages/mcp/src/{paths,state}.ts` | U1 |
| U6 | MCP relay client | `packages/mcp/src/relay-client.ts` | U2, U4, U5 |
| U7 | Room session and MCP tools | `packages/mcp/src/{session,server,stdio}.ts` | U3, U6 |
| U8 | CLI `up`, `join`, `status`, `mcp`, bin | `packages/cli/src/**` | U7 |
| U9 | CLI `install claude` | `packages/cli/src/commands/install.ts` | U8 |
| U10 | Two-agent conformance package | `tests/conformance/**` | U8 |

### U1. Protocol schemas, ULID, share code

- **Goal:** All shared data shapes and identifiers exist and validate, with no crypto yet.
- **Requirements:** R1, R2, R3, R4, R7.
- **Dependencies:** None.
- **Files:** `packages/protocol/package.json` (add `zod@^4`), `packages/protocol/src/index.ts`, `packages/protocol/src/envelope.ts`, `packages/protocol/src/wire.ts`, `packages/protocol/src/meta.ts`, `packages/protocol/src/ulid.ts`, `packages/protocol/src/share-code.ts`, `packages/protocol/test/envelope.test.ts`, `packages/protocol/test/wire.test.ts`, `packages/protocol/test/ulid.test.ts`, `packages/protocol/test/share-code.test.ts`, existing `packages/protocol/test/index.test.ts` kept.
- **Approach:**
  1. `Envelope` exactly as ARCHITECTURE (R1). Use `zod` 4 and export both the schema and its inferred type.
  2. `ClientFrame` and `RelayFrame` discriminated unions on `t` (R2). `room` is `^[0-9a-f]{64}$`, `proto` is `z.literal(PROTOCOL_VERSION)`, `since` is a non-negative integer.
  3. `RoomMeta` per R7.
  4. `ulid()` and `isUlid()` per KTD3.
  5. `generateShareCode()` returns `{ code, secret }`. `parseShareCode(code)` returns the 32-byte secret or throws a typed error naming the failure (KTD6).
- **Patterns to follow:** M0 KTD4/KTD5 (tsup entry stays `src/index.ts` re-exporting modules, tests in `test/`).
- **Test scenarios:**
  - A full envelope with refs parses; one with 21 refs, a 8,001-character body, an unknown `kind`, or `via: "email"` fails.
  - `refs` defaults to `[]` and `requiresHuman` to `false` when omitted.
  - Envelope has no field beyond the documented set; an extra `file` field is stripped (zod default) and never round-trips (invariant 6).
  - Each client and relay frame from ARCHITECTURE parses; `hello` with `proto: 2`, an uppercase or 63-character `room`, a negative `since`, or an unknown `t` fails; `error` with code `nope` fails.
  - `hello` with a `create` block requires `closeKey` and `meta`.
  - `ulid()` returns 26 Crockford characters (no I, L, O, U); two ids from different milliseconds sort lexically in time order; 1,000 ids are unique.
  - `generateShareCode()` output starts with `ar1_`, has 47 characters, and `parseShareCode` returns the same 32 bytes.
  - `parseShareCode` rejects `ar2_` prefix, missing prefix, 42 and 44 payload characters, `=` padding, `+` or `/` characters, whitespace, and a 43-character payload whose last character has non-zero unused bits (non-canonical).
- **Verification:** Package builds with types; tests above pass; `pnpm typecheck` clean.

### U2. Protocol crypto

- **Goal:** Key derivation, envelope and meta sealing, and close keypair generation, with tamper-resistance proven.
- **Requirements:** R5, R6, R7, R8; invariant 1.
- **Dependencies:** U1.
- **Files:** `packages/protocol/package.json` (add `libsodium-wrappers@^0.8`), `packages/protocol/src/crypto.ts`, `packages/protocol/src/index.ts`, `packages/protocol/test/crypto.test.ts`.
- **Approach:**
  1. `deriveRoom(secret)` returns `{ roomId, key }` per R5 using `hkdfSync` (KTD4).
  2. `seal(envelope, key, roomId)` validates with `Envelope`, serializes JSON, encrypts per R6 and KTD5. `open(blob, key, roomId)` decodes, splits the nonce, decrypts and parses with `Envelope`, throwing one error type for any failure.
  3. `sealMeta`/`openMeta` do the same with `RoomMeta`.
  4. `generateCloseKeyPair()` returns base64 `{ publicKey, secretKey }` from `crypto_sign_keypair`.
- **Execution note:** Implement test-first; the tamper and wrong-key cases are the point of the unit.
- **Test scenarios:**
  - Known-answer: a fixed 32-byte secret yields a fixed `roomId` and key computed independently in the test with `hkdfSync` and the documented info strings; `roomId` is 64 lowercase hex characters and differs from the key's hex.
  - Seal then open returns a deep-equal envelope.
  - Two seals of the same envelope produce different blobs (fresh nonce).
  - Flipping one byte in the nonce, in the ciphertext body, and in the tag each makes `open` throw.
  - Opening with a key from a different secret throws.
  - Opening with the right key but another `roomId` throws (AD mismatch).
  - A blob shorter than 24 + 16 bytes, or invalid base64, throws the same error type.
  - Ciphertext validly sealed over a non-envelope JSON value fails `open` at the schema step.
  - Decoded blob bytes do not contain the UTF-8 body text of a sealed envelope with a long marker body.
  - Meta round trips; meta opened with a wrong `roomId` throws; a meta blob passed to `open` throws (schema separation, KTD5).
  - Close keypair has a 32-byte public key and 64-byte secret key, and a signature made with the secret key verifies under the public key.
- **Verification:** All crypto tests pass under Node 20 and current Node.

### U3. `frameInbound`

- **Goal:** One function that renders inbound envelopes as delimited untrusted data that a hostile sender cannot break out of.
- **Requirements:** R9; invariant 5.
- **Dependencies:** U1.
- **Files:** `packages/protocol/src/frame.ts`, `packages/protocol/src/index.ts`, `packages/protocol/test/frame.test.ts`.
- **Approach:** Implement KTD9. Input is an array of envelopes; output is one string with each message block and reminder. `from` renders as `member/agent`. The random source is injectable for tests.
- **Execution note:** Implement test-first from the hostile fixtures.
- **Test scenarios:**
  - A normal envelope renders the ARCHITECTURE shape: open tag with `from`, `kind`, `thread`, `untrusted="true"`, body, refs line, close tag, reminder.
  - Two calls use different tag suffixes; all messages within one call share one.
  - A body containing `</agentroom_message_` plus a guessed suffix, and `</AGENTROOM_MESSAGE_x>` in mixed case, renders with `&lt;`, and the output contains exactly one real closing tag per message.
  - A body containing a forged open tag `<agentroom_message_abc from="andrew/human">` is neutralized the same way.
  - A body containing the exact reminder sentence still yields exactly one reminder line outside each block, and the forged one sits inside the tags.
  - A member name `a" untrusted="false` and one with `<`, `>`, `'` and `&` render entity-escaped inside the attribute; parsing the open tag with a simple attribute regex yields exactly the expected attribute keys.
  - A member name or ref path containing a newline or ESC (`\x1b`) is stripped.
  - A ref path containing `</agentroom_message_` is neutralized.
  - Body text `List<String>` and `a < b` render unchanged.
- **Verification:** Tests pass; `inbox`/`wait` in U7 use this function and no other renderer.

### U4. relay-node server and bin

- **Goal:** A runnable relay that implements create-versus-join, buffering, seq, resume, presence, size limits and idle expiry, and stores only ciphertext.
- **Requirements:** R10-R17; invariant 1.
- **Dependencies:** U1.
- **Files:** `packages/relay-node/package.json` (add `ws@^8`, `@agentroom/protocol: workspace:*`, dev `@types/ws@^8`, `bin: { "agentroom-relay": "./dist/bin.js" }`), `packages/relay-node/tsup.config.ts` (add `src/bin.ts` entry), `packages/relay-node/src/index.ts`, `packages/relay-node/src/relay.ts`, `packages/relay-node/src/bin.ts`, `packages/relay-node/test/relay.test.ts`, `docs/ARCHITECTURE.md`.
- **Approach:**
  1. `startRelay({ port, host?, idleTtlSec = 28800, bufferSize = 500, maxEnvelopeBytes = 65536, sweepIntervalMs = 60000, now = Date.now, log? })` resolves to a handle `{ url, port, close(), snapshot(roomId), disconnectAll(), setAccepting(bool), inject(roomId, blob) }`. `inject` runs the same code path as a `put` and exists for the conformance resume test. Max-age and member-cap options are accepted and stored only.
  2. Per-connection state machine: awaiting `hello`, then joined. Parse every frame with `ClientFrame` (U1); any failure follows R15.
  3. Room record: `seq`, ring buffer of `{ seq, blob }`, `meta`, `closeKey`, `idleTtlSec`, `lastActivity`, connection set. Semantics per KTD7. `expiresAt = lastActivity + idleTtl`.
  4. Sweep on an unref'd interval; expiry per R14.
  5. `log` receives structured events (`room_created`, `room_expired`, `conn_open`, `conn_close`, `error` with code). The default writes JSON lines to stderr. No event carries a blob or meta.
  6. `bin.ts` reads `PORT` (default 8787) and `HOST` (default `0.0.0.0`), starts the relay, and closes on SIGINT/SIGTERM. TLS is the hosting proxy's job.
  7. Add KTD7 semantics and the KTD8 rejection to ARCHITECTURE's Relay section.
- **Test scenarios:** (real `ws` clients against `startRelay({ port: 0 })`)
  - Create then welcome: `seq: 0`, `members: 1`, the same `meta` back, a nonce of at least 16 random bytes, `expiresAt` equal to the injected `now` plus the idle TTL.
  - A second `create` for the same id gets `room_exists`; a plain `hello` for an unknown id gets `room_not_found` and the socket closes.
  - `idleTtlSec` above the relay default is capped.
  - Two clients: a `put` from A arrives as `msg{seq: 1}` at both A and B; seqs increase by one.
  - Each connection receives a fresh welcome nonce.
  - `since: 2` after five puts replays seq 3, 4, 5 in order before a live seq 6; no `since` replays nothing; `welcome.seq` equals 5.
  - After 502 puts, `since: 0` replays seq 3-502 (buffer bound).
  - Connect and disconnect broadcast `presence` with counts 2 then 1.
  - A blob decoding to 65,537 bytes gets `too_large` and is not stored; 65,536 bytes is accepted; a frame over 96 KiB is refused by `ws`.
  - Invalid JSON, `proto: 2`, `put` before `hello`, and a second `hello` each get `bad_proto` and close.
  - `close` gets `bad_proto` with the M2 message and the room survives.
  - Idle expiry with an injected clock: connected clients get `error{room_expired}` and are closed, and a later plain `hello` gets `room_not_found`. A `put` before the deadline pushes `expiresAt` forward.
  - Invariant 1: after putting a blob sealed (via U2) over a body containing a unique marker, neither `JSON.stringify(snapshot(roomId))` nor any decoded stored blob contains the marker, and the captured `log` events contain neither the marker nor the blob string.
  - `disconnectAll` plus `setAccepting(false)` refuses reconnects; `setAccepting(true)` accepts them; `inject` assigns the next seq and broadcasts.
- **Verification:** Tests pass; `node packages/relay-node/dist/bin.js` with `PORT=0` starts and stops cleanly on SIGTERM.

### U5. MCP local state store

- **Goal:** One module owns every path, file format and permission in `$AGENTROOM_HOME`, usable by both the MCP server and the CLI.
- **Requirements:** R19, R21 (agent enum), R24 (deletion); invariant 7.
- **Dependencies:** U1.
- **Files:** `packages/mcp/package.json` (add `@agentroom/protocol: workspace:*`, `zod@^4`), `packages/mcp/src/paths.ts`, `packages/mcp/src/state.ts`, `packages/mcp/src/index.ts`, `packages/mcp/test/state.test.ts`, `docs/ARCHITECTURE.md`.
- **Approach:**
  1. `agentroomHome(env)`: `env.AGENTROOM_HOME` or `os.homedir()/.agentroom`.
  2. `RoomFile` zod schema per KTD11 with the KTD12 agent enum.
  3. Functions: `writeRoomFile`, `readRoomFile`, `setCurrent`, `readCurrent`, `clearCurrentIf(roomId)`, `appendQueue(records)`, `replayQueue()` (returns seen ids, history, unread, last seq, and tolerates a torn final line), `writeStatus`, `readStatus`, `deleteRoomDir`.
  4. Directories are created with mode 0700, files with 0600, atomic writes via temp file and rename in the same directory.
  5. Add the KTD11 contract to ARCHITECTURE.
- **Test scenarios:**
  - With `AGENTROOM_HOME` set, every path resolves under it; with it unset, under `os.homedir()` (computed, not written).
  - `writeRoomFile` creates the room dir at 0700 and `room.json` at 0600 (checked with `fs.stat` mode bits); `queue.jsonl` and `status.json` are 0600.
  - `readRoomFile` rejects `agent: "human"` and a missing `secret` (Covers AE6 at the store level).
  - Replay: msg lines for seq 1-3 plus a `read` line for seq 1's id yield seen {1,2,3}, unread {2,3}, `lastSeq` 3; a duplicate msg line for the same id counts once; own and presence messages are never unread.
  - A truncated last line is ignored and the rest replays.
  - `clearCurrentIf` removes `current` only when it names that room.
  - `deleteRoomDir` removes the directory and is a no-op if it is already gone.
- **Verification:** Tests pass; no test path leaves `os.tmpdir()`.

### U6. MCP relay client

- **Goal:** A reconnecting relay connection with resume, for the MCP server, plus a one-shot mode for CLI commands.
- **Requirements:** R20, R24 (stop rule); invariant 1.
- **Dependencies:** U2, U4, U5.
- **Files:** `packages/mcp/package.json` (add `ws@^8`, dev `@types/ws@^8`, dev `@agentroom/relay-node: workspace:*`), `packages/mcp/src/relay-client.ts`, `packages/mcp/src/index.ts`, `packages/mcp/test/relay-client.test.ts`.
- **Approach:**
  1. `RelayClient({ url, roomId, initialSince, onWelcome, onMsg, onPresence, onGone, backoff })` follows the state diagram in the High-Level Technical Design. The `since` on each reconnect is the highest seq delivered to `onMsg`. Backoff starts at 500 ms, doubles to 30 s with full jitter, and resets on welcome.
  2. `put(blob)` resolves when the socket accepted the frame and rejects when not `Live`. Echo matching is the session's job (U7).
  3. `oneShot({ url, hello })` connects, returns the first `welcome` or `error`, and closes. `up` uses it with `create`, and `join` and `status` without `since`.
  4. Unknown or malformed relay frames are logged to stderr and ignored. `room_not_found` and `room_expired` move to `Gone` and call `onGone`. Other relay errors are logged and the socket is left to the relay.
- **Test scenarios:** (against an in-process `startRelay`)
  - First connect sends `since: 0` and receives buffered messages in order.
  - After `disconnectAll`, the client reconnects with `since` equal to its last seq and receives only newer messages (Covers AE2).
  - With `setAccepting(false)`, connection attempts back off; delays grow and stay within the 30 s cap (fake timers).
  - `room_not_found` on hello calls `onGone` once and makes no further connection attempts.
  - Relay-pushed `room_expired` while live calls `onGone` and stops.
  - `put` while in `Backoff` rejects with a "relay unreachable" error.
  - `oneShot` with `create` returns the welcome; for an unknown room it returns the `room_not_found` error.
- **Verification:** Tests pass with no open handles left (vitest exits cleanly).

### U7. Room session and MCP tools

- **Goal:** The stdio MCP server with `room_status`, `send`, `inbox` and `wait`, over the store and relay client.
- **Requirements:** R18, R20-R25; invariants 2, 5, 7.
- **Dependencies:** U3, U6.
- **Files:** `packages/mcp/package.json` (add `@modelcontextprotocol/server@^2.3.1`, dev `@modelcontextprotocol/client@^2.3.1`), `packages/mcp/tsup.config.ts` (unchanged entry), `packages/mcp/src/session.ts`, `packages/mcp/src/server.ts`, `packages/mcp/src/stdio.ts`, `packages/mcp/src/index.ts`, `packages/mcp/test/session.test.ts`, `packages/mcp/test/server.test.ts`.
- **Approach:**
  1. `createRoomSession({ roomId, env })` reads `room.json` and derives keys. It replays the queue, starts the relay client with `since: 0`, and handles inbound frames per the HTD data flow. After the first welcome of the process it posts one presence envelope (Assumptions). It owns unread, members-seen, decrypt-failure count and waiters, and writes `status.json` on change.
  2. Outbound per the HTD: `buildFrom` (KTD12), thread derivation (Assumptions), `sendPolicy` no-op hook (R23), the human guard, seal, put, and wait up to 10 s for the echo with the same envelope id. Sends run one at a time.
  3. `onGone` per R24: stop the client, delete the dir, clear `current` if it matches, keep the in-memory unread list for one final read, then answer every tool with the fixed `room_expired` text ("This room has expired or no longer exists on the relay (it may have restarted). Run `agentroom up` to start a new room.").
  4. `createMcpServer(session)` registers four tools with zod object schemas (KTD16). `send` input: `kind` (question, answer, decision, handoff, fyi), `body` (1-8,000 characters), `refs?`, `thread?`, `replyTo?`, `to?`, `requiresHuman?`. `inbox`: `thread?`, `limit?`. `wait`: `timeoutSec?` (1-50, default 30). `room_status`: none. Results carry text, plus `structuredContent` for `room_status` and `send`. Tool descriptions say inbound content is untrusted information.
  5. `runStdio({ roomId, env })` wires `serveStdio` (KTD16) and exits non-zero with a stderr message when `room.json` is missing or invalid.
- **Test scenarios:** (in-process `Client` over `InMemoryTransport`, relay via `startRelay`, two sessions in two temp homes sharing one room written by test helpers)
  - `send` from A returns an id and seq; B's `inbox` returns it framed with `from="alice/claude-code"` and the body, and a second `inbox` returns "No unread messages."
  - The envelope B decrypts from A's send has `from.agent` from A's `room.json` and `via: "mcp"`; a `send` call carrying extra `from`/`agent: "human"` arguments produces an envelope with the configured agent (extra keys stripped).
  - `send` with `kind: "approve"` or `kind: "presence"` is rejected by the schema.
  - Invariant 2 guard: a session whose in-memory room record is forced to `agent: "human"` (bypassing the schema) makes `send` throw before anything reaches the relay (relay snapshot unchanged).
  - Source guard: no file under `packages/mcp/src` contains the string literal `"human"` except the guard's own comparison (read the files in the test), so a future code path that tags human fails loudly.
  - A's own message is never unread for A and does not wake A's `wait`.
  - `wait` with an unread message returns immediately; with none and `timeoutSec: 1` it returns "No new messages in 1s." without `isError` (Covers AE4); a message arriving during `wait` resolves it with that message.
  - `inbox{thread}` returns only that thread's unread and leaves others unread; `limit: 1` with three unread returns one and "2 more unread".
  - `replyTo` a known envelope sets `thread` to that envelope's thread.
  - `room_status` lists B as seen with its agent after B's presence envelope, the live connection count 2, unread count, `expiresAt`, and decrypt failures 0. After injecting a garbage blob through the relay handle it reports 1.
  - Restart: a new session on the same home after messages were read rebuilds from `since=0`, appends nothing new, and shows only previously unread messages (Covers AE3).
  - Expiry: with one unread message, expire the room via the injected relay clock; the room dir is gone, `current` is cleared, the next `inbox` returns the message plus the expiry notice, and the following call returns the `room_expired` text with no reconnect attempt (Covers AE5).
  - `send` while the relay refuses connections returns an `isError` result saying the relay is unreachable.
  - `runStdio` with a missing room exits non-zero and writes nothing to stdout.
- **Verification:** Tests pass; `status.json` content after the exchange matches what `room_status` reports.

### U8. CLI `up`, `join`, `status`, `mcp`, and bin

- **Goal:** The `agentroom` executable with the room lifecycle commands and the `mcp` launcher.
- **Requirements:** R26, R27, R28, R30, R31; invariants 1, 7.
- **Dependencies:** U7.
- **Files:** `packages/cli/package.json` (add `@agentroom/mcp` and `@agentroom/protocol` `workspace:*`, `bin: { "agentroom": "./dist/bin.js" }`, dev `@agentroom/relay-node: workspace:*`), `packages/cli/tsup.config.ts` (add `src/bin.ts` entry with shebang), `packages/cli/src/index.ts`, `packages/cli/src/bin.ts`, `packages/cli/src/args.ts`, `packages/cli/src/relay-url.ts`, `packages/cli/src/commands/up.ts`, `packages/cli/src/commands/join.ts`, `packages/cli/src/commands/status.ts`, `packages/cli/src/commands/mcp.ts`, `packages/cli/test/args.test.ts`, `packages/cli/test/up-join.test.ts`, `packages/cli/test/status.test.ts`, `README.md`.
- **Approach:**
  1. `bin.ts` builds a context from the process (`env`, `cwd`, streams, `isTTY`) and calls `main(argv, ctx)`, which dispatches with `parseArgs` per subcommand (KTD2). Unknown commands or flags print usage to stderr and exit 2. `--room <id>` is accepted on `status`, `install` and `mcp`, otherwise `current` is used.
  2. `relay-url.ts` implements KTD14.
  3. `up`: generate code and close keypair, derive the room, seal meta, `oneShot` with `create`. On welcome write `room.json`, set `current`, run install for `--agent claude` (U9 provides it; until U9 lands, `up` prints the manual command), and print the code on its own line, the join command, and "expires after 8 h without activity". On `room_exists` or connection failure, print the error and write nothing.
  4. `join`: take the code from the argument, or prompt with `node:readline` when `ctx.isTTY`, or refuse with "pass the code or run in a terminal". Parse (KTD6) before any network call. `oneShot` without `since`. On welcome, decrypt `meta` to confirm, then write state per Assumptions and print the restart instruction. On `room_not_found` (AE1) or unreachable, write nothing.
  5. `status`: per Assumptions. Print "no current room" when `current` is unset or its directory is gone.
  6. `mcp`: calls `runStdio` and writes nothing to stdout itself.
  7. README: commands available in M1, the placeholder relay and `--relay`/`AGENTROOM_RELAY`, and the Status line.
- **Test scenarios:** (commands called through `main` with an injected context, temp `AGENTROOM_HOME`, in-process relay, `PATH` set to an empty temp dir)
  - `up --relay <local>` prints an `ar1_` code that parses, writes `room.json` (0600) with `createdByMe: true`, a close secret key, the relay URL and agent `other`, and sets `current` to the derived id.
  - `up` with a non-default relay prints a join command containing `--relay <url>`.
  - `join <code> --relay <local> --name bob --agent codex` in a second home writes `room.json` with agent `codex`, no close key, the same room id, and prints the manual MCP command for codex.
  - `join` with an unknown valid code prints the not-found message naming the relay, and the home has no room dir and no `current` (Covers AE1).
  - `join` with `ar2_...` fails before any connection (relay sees no connection).
  - `join` with no code and `isTTY: false` exits non-zero with the refusal; with `isTTY: true` and an injected input stream it reads the code.
  - `up --agent human` and `join --agent human` exit 2 with an invalid-agent message.
  - Relay URL precedence: flag beats `AGENTROOM_RELAY`, which beats the default constant.
  - `status` after `up` prints the room id, member, relay, connections 1 (its own one-shot), and expiry; with a `status.json` present it prints its unread counts and `updatedAt`; after the relay forgets the room it prints "expired" and the room dir is deleted.
  - Unknown subcommand and `--log` both exit 2 (invariant 7: there is no logging flag).
  - The built `dist/bin.js` starts with a `#!/usr/bin/env node` line and is executable.
- **Verification:** Tests pass; `node packages/cli/dist/bin.js --help` prints usage.

### U9. CLI `install claude`

- **Goal:** Register the room's MCP server with Claude Code, or fall back to a project `.mcp.json`, per KTD15.
- **Requirements:** R29; R26 and R27 (install on `--agent claude`).
- **Dependencies:** U8.
- **Files:** `packages/cli/src/commands/install.ts`, `packages/cli/src/commands/up.ts`, `packages/cli/src/commands/join.ts`, `packages/cli/test/install.test.ts`, `docs/ARCHITECTURE.md` or `docs/OPEN_QUESTIONS.md` (item 3 addendum).
- **Approach:**
  1. Find `claude` by scanning `ctx.env.PATH` (no shell).
  2. Build `<cmd>` per KTD15 from the running entry path, which is injectable for tests.
  3. `claude` found: spawn the remove and add commands with argument arrays, report the outcome, and say to restart Claude Code.
  4. `claude` missing: read `<ctx.cwd>/.mcp.json` if present (invalid JSON aborts with an error rather than overwriting), set `mcpServers.agentroom`, write it back, and print the path plus the do-not-commit note.
  5. Unsupported agent names exit 2 naming the supported one. `up`/`join` with `--agent claude` call this after writing state.
- **Test scenarios:**
  - With a fake `claude` script on the injected PATH that records its argv to a file: `install claude` records `mcp remove --scope user agentroom` then `mcp add --scope user --transport stdio agentroom -- <node> <abs bin> mcp --room <id>` when the entry path is outside `node_modules`.
  - With the entry path inside a `node_modules` directory, the recorded command is `npx -y agentroom mcp --room <id>`.
  - A fake `claude` whose `remove` exits 1 still proceeds to `add`; an `add` that exits 1 makes `install` exit non-zero with its stderr shown.
  - With no `claude` on PATH and an existing `.mcp.json` holding another server, the result keeps that server and adds `agentroom` with `type: "stdio"`, the command and args; the output names the file and the do-not-commit note.
  - An invalid existing `.mcp.json` is left byte-for-byte unchanged and the command exits non-zero.
  - `up --agent claude` with the fake `claude` runs the install for the new room id.
  - A room id containing shell metacharacters is impossible (schema), and the spawn uses an argument array (the fake records exact argv).
- **Verification:** Tests pass without the real `claude` binary ever running (the test PATH excludes it).

### U10. Two-agent conformance package

- **Goal:** Prove the full loop end to end with real processes and a real relay, and prove the relay holds no plaintext.
- **Requirements:** R32; invariants 1, 2, 5.
- **Dependencies:** U8, U9 (runs last so the CLI is complete; it never passes `--agent claude`).
- **Files:** `pnpm-workspace.yaml`, `tests/conformance/package.json` (private, `test` and `typecheck` scripts, no `build`; deps `@agentroom/relay-node`, `@agentroom/protocol`, `@agentroom/mcp`, `agentroom` via `workspace:*`, dev `@modelcontextprotocol/client@^2.3.1`), `tests/conformance/tsconfig.json`, `tests/conformance/test/two-agents.test.ts`, `biome.json` only if the new path needs inclusion.
- **Approach:**
  1. Relay factory per KTD1 wrapping `startRelay({ port: 0 })`.
  2. Two temp homes, each with `AGENTROOM_HOME`, a minimal `PATH` containing only the directory of `process.execPath`, and `AGENTROOM_RELAY` set to the local relay. Run `up --name alice --agent codex` and `join <code> --name bob --agent codex` by spawning `process.execPath packages/cli/dist/bin.js` and parsing the code from stdout.
  3. Start two `StdioClientTransport`s running `process.execPath <bin> mcp --room <id>` with those envs, and connect two `Client`s.
  4. Scenario, using unique markers in every body:
     1. Each `room_status` eventually lists the other member (poll with a deadline).
     2. Alice `send`s a question; Bob `wait`s and gets it framed.
     3. Bob `send`s an answer with `replyTo`; Alice's `inbox` gets it in the same thread.
     4. Resume: `setAccepting(false)` then `disconnectAll()`. Seal an envelope from a third member `carol/codex` with the secret from Bob's `room.json` and `inject` it. Then `setAccepting(true)`. Both Alice's and Bob's `wait` return that message exactly once, and a following `inbox` on each returns "No unread messages."
     5. Plaintext check: `JSON.stringify(snapshot(roomId))` and every decoded blob contain none of the markers, the member names, or the secret.
  5. Tear down: close clients (which ends the child processes), close the relay, remove temp dirs.
- **Test scenarios:**
  - Two agents see each other's presence in `room_status`.
  - Question and answer exchange with correct `from`, `kind`, `thread` and framing.
  - Resume after forced disconnect: the injected message arrives once on each side; neither side re-delivers already-read messages.
  - Relay stored state and decoded blobs contain no plaintext marker, member name, or secret (invariant 1).
  - Every received envelope has `via: "mcp"` and a non-human agent (invariant 2).
  - Each tool result containing a message is wrapped in an `agentroom_message_*` tag followed by the reminder (invariant 5).
- **Verification:** `pnpm -r build && pnpm -r test` runs the suite green; it finishes in under 30 s locally and leaves no child processes.

---

## Verification Contract

| Gate | Command | Applies |
|---|---|---|
| Install | `pnpm install` (lockfile updated and committed with each dependency-adding unit) | U1, U2, U4-U8, U10 |
| Build | `pnpm -r build` | all |
| Typecheck (after build, M0 KTD2) | `pnpm typecheck` | all |
| Lint and format | `pnpm lint` | all |
| Tests | `pnpm -r test` | all; U10 needs build first |
| Node 20 | Same build and test sequence once under Node 20.19+ before calling M1 done | all (KTD2, KTD4) |
| Isolation | Tests never write outside `os.tmpdir()` and never execute the real `claude` | U5-U10 |

The tree is green after every unit: each unit lands with its tests, and `pnpm install && pnpm -r build && pnpm typecheck && pnpm lint && pnpm -r test` passes before the next unit starts.

M1 acceptance (agent-checkable) from `docs/PLAN.md`: `pnpm -r build && pnpm -r test` green including the conformance test. The human acceptance (deployed relay, two people) is out of scope here.

## Definition of Done

- Every Verification Contract gate passes with real output reported, including one Node 20 run.
- R1-R32 hold. AE1-AE6 each have a passing test.
- Invariant regression tests exist and pass. 1: relay snapshot and log have no plaintext (U4, U10). 2: agent enum, send-path guard, and source guard (U5, U7, U10). 5: hostile framing fixtures (U3) and framed tool results (U7, U10). 6: envelope has refs only, extra fields stripped (U1). 7: room dir deleted on expiry and no `--log` flag (U7, U8).
- `docs/ARCHITECTURE.md` reflects KTD7, KTD8, KTD11 and KTD15. README reflects the M1 commands and the placeholder relay. `docs/PLAN.md` and `docs/LOG.md` are unchanged by this work.
- No placeholder tests, no leftover experiment code or unused exports, no unused dependencies, and no `@types/libsodium-wrappers`.
- No secrets committed, no telemetry, no network calls other than to the configured relay (and the `claude` CLI invocation during install).

## Open Questions

Deferred to humans; none block implementation.

- Publish a placeholder `agentroom` package to npm now to hold the name against squatting (KTD15 conflict call-out)?
- Own or deploy at `relay.agentroom.dev`, or pick another default before M4 (KTD14)?
