# Build plan

Each milestone ends with acceptance criteria. Do not start the next milestone until they pass.

## Milestone 0: Verify and scaffold (half a day)

- [x] Work through `OPEN_QUESTIONS.md` items marked **M0**; record findings with dates and URLs.
- [x] Check the name `agentroom` on npm and GitHub; pick an alternative if taken and update docs.
- [x] pnpm workspace with `packages/protocol`, `packages/relay-node`, `packages/mcp`, `packages/cli`.
- [x] Shared `tsconfig`, lint and format config, vitest, tsup, a root `pnpm -r test` script.
- [x] GitHub Actions CI: install, typecheck, lint, test on Node 20 and 22.
- [x] MIT or Apache-2.0 license (decide; Apache-2.0 includes a patent grant).

**Accept:** `pnpm -r build && pnpm -r test` green locally and in CI.

Status 2026-10-11: all gates green locally (Node 26 and Node 20.20.2). The GitHub Actions run needs the repo created and pushed (waiting on Andrew, see `LOG.md`).

## Milestone 1: Core loop, encrypted (weekend 1)

Goal: two Claude Code sessions on two machines exchange a real question.

Encryption is in M1, not M2, because the M1 real-world test runs through a deployed relay, and invariant 1 says the relay never sees plaintext. With libsodium it is a small task.

- [x] `protocol`: `Envelope` schema, relay wire schemas, ULID ids, share-code generate and parse.
- [x] `protocol` crypto: HKDF room_id and key derivation, XChaCha20-Poly1305 envelopes, associated data = room_id. Tests: round trip, tamper, wrong key, wrong room.
- [x] `relay-node`: create vs join `hello` (room settings and close key pinned at creation, `room_not_found` for unknown ids), bounded buffer, seq numbers, resume with `since`, idle TTL, size limit.
- [x] `mcp`: stdio server with `room_status`, `send`, `inbox`, `wait`; local room directory (`room.json`, `queue.jsonl`, `status.json`); rebuild history from `since=0` on startup; reconnect with backoff; drop envelopes whose id was already seen (relay replay).
- [x] `cli`: `up`, `join`, `status`, `install claude` (writes MCP config via `claude mcp add` or settings, whichever is current).
- [x] Inbound framing as untrusted data (`frameInbound` in `protocol`, nonce-suffixed tag, escaping, tamper tests) used by `inbox` and `wait` results.
- [x] Conformance test: two scripted MCP clients against a local relay exchange messages, resume after disconnect, see each other's presence, and the relay's stored blobs contain no plaintext.
- [ ] Deploy `relay-node` somewhere reachable for the real test (Fly.io, Railway, or a small VM behind TLS). **Human step:** needs a hosting account.

**Accept (agent-checkable):** `pnpm -r build && pnpm -r test` green, including the conformance test.

Status 2026-10-11: agent-checkable acceptance met (155 tests across protocol, relay-node, mcp, cli and the conformance package). Relay deployment and the two-person test are waiting on Andrew (`LOG.md`).

**Accept (human step):** Andrew and coworker each run Claude Code, one asks a question about the other's platform, the other's agent answers via `inbox`, and the answer arrives. Recorded in `docs/LOG.md`.

## Milestone 2: Safe to use (week 2)

- [x] Creator-only `down`: Ed25519 close key pinned at the creating `hello`, `close` signed over `room_id || nonce`; relay tests for wrong key, non-creator, and replay.
- [x] Chain limit in `protocol`, enforced in `mcp` `send`, with tests for reset on human message and on `approve`, `thread` derived from `replyTo`, presence ignored, and the room-wide counter catching a new-thread-per-message loop.
- [x] Secret scanner in `protocol` with fixtures; enforced in the shared seal-and-post path used by MCP `send`, hook, `watch` and CLI `say`, with a blocked-fake-AWS-key test per path.
- [x] `cli`: `say` and `approve` with TTY check and refusal when an agent environment marker is set (e.g. `CLAUDECODE`); `export` to markdown and `gh-issue` (body via `--body-file`, never inline; test with a `$(touch pwned)` body); `down`.
- [x] `handoff` tool with fixed template; `draft: true` on `send` and `handoff` writes `pending.json` and returns text plus hash.
- [x] Max age TTL, rate limit, member cap, `room_expired` handling end to end.
- [x] `agentroom-rules` MCP prompt.
- [x] Threat model section in README.

**Accept:** relay logs show only ciphertext; an agent cannot exceed the chain limit; a fake AWS key in a message is blocked; an agent running `agentroom say` from its shell fails; the MCP server has no code path that emits `agent: "human"`.

Status 2026-10-12: each acceptance criterion has a passing test (relay-node invariant-1 test across create/put/close/expiry/rate_limited/room_full; mcp chain-policy and conformance chain tests; scanner tests on mcp send, drafts, cli say and the stdio path; cli human-guard tests and a conformance run of `say` with `CLAUDECODE=1`; the mcp source-scan finds one `"human"` literal, inside `refuseHuman`).

## Milestone 3: Claude Code plugin and humans (week 3)

- [x] `plugins/claude-code`: manifest bundling the MCP server, slash commands (`/sync`, `/say`, `/ask`, `/handoff`, `/send`, `/approve`, `/sync-mode`), `UserPromptSubmit` hook, status line script.
- [x] Hook-based human sending with prompt blocking; draft-and-approve flow for `/ask` and `/handoff` (`/send <hash>` refuses when `pending.json` changed after display; test it); hook-injected context uses `frameInbound`.
- [x] Delivery modes: `between` (default) via the hook, `manual`, and `live` via channels if available.
- [x] Desktop notifications for `requiresHuman` and direct questions.
- [x] `agentroom watch` terminal pane with input line; control characters stripped from rendered strings.

**Accept:** a full day of real use on the client SDK without copy-pasting between agents; neither person missed a message that needed them.

Status 2026-10-12: agent-checkable parts done (plugin validates with `claude plugin validate`; hook, release, delivery and status line covered end to end in `tests/conformance/test/claude-plugin.test.ts`). `live` delivery is deferred (channels research preview, `OPEN_QUESTIONS.md` item 8). The day of real use is waiting on Andrew.

## Milestone 4: Agnostic (week 4)

- [ ] Adapters: `install codex`, `install gemini`, `install cursor` (MCP config plus `AGENTS.md` / `GEMINI.md` snippet).
- [ ] Confirm each agent calls `inbox` and `wait` when instructed; document actual behavior honestly in README.
- [ ] `relay-cf`: Cloudflare Worker plus Durable Object with hibernation and alarms; buffer, seq, close key and meta in Durable Object storage, `deleteAll()` on expiry and close; passes the shared relay conformance suite.
- [ ] Manual pre-release checklist covering Claude Code, Codex, and Gemini against the same room.
- [ ] README: quickstart, demo GIF, threat model, self-hosting guide.
- [ ] Publish to npm; tag v0.1.0.

**Accept:** a Claude Code user and a Codex user complete a question-answer-decision thread through the public relay.

## Dogfood checkpoint (two months after M3)

Answer honestly in `docs/LOG.md`:
1. Did the agents use the room without being told each time?
2. Did it prevent at least one real parity bug or rework?
3. Does the coworker open it unprompted?

If mostly no, stop or narrow scope.

## Later

- Short speakable codes (PAKE / SPAKE2).
- Optional persistent rooms with audit log (possible hosted, paid tier).
- VS Code extension with gutter icons on referenced lines.
- Multiple rooms per session.
- Agent2Agent (A2A) protocol bridge.
- SDK-parity layer on top: shared spec, test vectors, drift detection in CI.
