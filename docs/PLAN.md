# Build plan

Each milestone ends with acceptance criteria. Do not start the next milestone until they pass.

## Milestone 0: Verify and scaffold (half a day)

- [ ] Work through `OPEN_QUESTIONS.md` items marked **M0**; record findings with dates and URLs.
- [ ] Check the name `agentsync` on npm and GitHub; pick an alternative if taken and update docs.
- [ ] pnpm workspace with `packages/protocol`, `packages/relay-node`, `packages/mcp`, `packages/cli`.
- [ ] Shared `tsconfig`, lint and format config, vitest, tsup, a root `pnpm -r test` script.
- [ ] GitHub Actions CI: install, typecheck, lint, test on Node 20 and 22.
- [ ] MIT or Apache-2.0 license (decide; Apache-2.0 includes a patent grant).

**Accept:** `pnpm -r build && pnpm -r test` green locally and in CI.

## Milestone 1: Core loop, encrypted (weekend 1)

Goal: two Claude Code sessions on two machines exchange a real question.

Encryption is in M1, not M2, because the M1 real-world test runs through a deployed relay, and invariant 1 says the relay never sees plaintext. With libsodium it is a small task.

- [ ] `protocol`: `Envelope` schema, relay wire schemas, ULID ids, share-code generate and parse.
- [ ] `protocol` crypto: HKDF room_id and key derivation, XChaCha20-Poly1305 envelopes, associated data = room_id. Tests: round trip, tamper, wrong key, wrong room.
- [ ] `relay-node`: rooms, ring buffer, seq numbers, resume with `since`, idle TTL, size limit.
- [ ] `mcp`: stdio server with `room_status`, `send`, `inbox`, `wait`; local room state file; reconnect with backoff; drop envelopes whose id was already seen (relay replay).
- [ ] `cli`: `up`, `join`, `status`, `install claude` (writes MCP config via `claude mcp add` or settings, whichever is current).
- [ ] Inbound framing as untrusted data in `inbox` and `wait` results.
- [ ] Conformance test: two scripted MCP clients against a local relay exchange messages, resume after disconnect, see each other's presence, and the relay's stored blobs contain no plaintext.
- [ ] Deploy `relay-node` somewhere reachable for the real test (Fly.io, Railway, or a small VM behind TLS). **Human step:** needs a hosting account.

**Accept (agent-checkable):** `pnpm -r build && pnpm -r test` green, including the conformance test.

**Accept (human step):** Andrew and coworker each run Claude Code, one asks a question about the other's platform, the other's agent answers via `inbox`, and the answer arrives. Recorded in `docs/LOG.md`.

## Milestone 2: Safe to use (week 2)

- [ ] Creator-only `down` (signed close).
- [ ] Chain limit in `protocol`, enforced in `mcp` `send`, with tests for reset on human message and on `approve`.
- [ ] Secret scanner in `protocol` with fixtures; wired into `send`.
- [ ] `cli`: `say` and `approve` with TTY check and refusal when an agent environment marker is set (e.g. `CLAUDECODE`); `export` to markdown and `gh-issue`; `down`.
- [ ] `handoff` tool with fixed template.
- [ ] Max age TTL, rate limit, member cap, `room_expired` handling end to end.
- [ ] `agentsync-rules` MCP prompt.
- [ ] Threat model section in README.

**Accept:** relay logs show only ciphertext; an agent cannot exceed the chain limit; a fake AWS key in a message is blocked; an agent running `agentsync say` from its shell fails; the MCP server has no code path that emits `agent: "human"`.

## Milestone 3: Claude Code plugin and humans (week 3)

- [ ] `plugins/claude-code`: manifest bundling the MCP server, slash commands (`/sync`, `/say`, `/ask`, `/handoff`, `/approve`, `/sync-mode`), `UserPromptSubmit` hook, status line script.
- [ ] Hook-based human sending with prompt blocking; draft-and-approve flow for `/ask` and `/handoff`.
- [ ] Delivery modes: `between` (default) via the hook, `manual`, and `live` via channels if available.
- [ ] Desktop notifications for `requiresHuman` and direct questions.
- [ ] `agentsync watch` terminal pane with input line.

**Accept:** a full day of real use on the client SDK without copy-pasting between agents; neither person missed a message that needed them.

## Milestone 4: Agnostic (week 4)

- [ ] Adapters: `install codex`, `install gemini`, `install cursor` (MCP config plus `AGENTS.md` / `GEMINI.md` snippet).
- [ ] Confirm each agent calls `inbox` and `wait` when instructed; document actual behavior honestly in README.
- [ ] `relay-cf`: Cloudflare Worker plus Durable Object with hibernation and alarms; passes the shared relay conformance suite.
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
