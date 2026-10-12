---
title: Milestone 2 Safe to Use - Plan
type: feat
date: 2026-10-11
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Milestone 2 Safe to Use - Plan

## Goal Capsule

- **Objective:** Two developers can leave their agents talking in a room without the agents looping on each other, leaking a credential into the room, or speaking as a human by accident. The creator can end the room at will, and every room ends on its own within a bounded time.
- **Means:** A pure chain-limit module and a secret scanner in `@agentroom/protocol` (KTD1-KTD5, KTD24). Signed `close`, tombstones, max age, rate limit and member cap in `@agentroom/relay-node` (KTD6-KTD11). Policy wiring, `handoff`, drafts, the rules prompt and terminal-state handling in `@agentroom/mcp` (KTD12-KTD17). Human-only `say`/`approve`, `export` and creator-only `down` in the `agentroom` CLI (KTD18-KTD23).
- **Authority:** `CLAUDE.md` invariants 1-7 and stack, then `docs/ARCHITECTURE.md`, then `docs/UX.md`, then `docs/PLAN.md` Milestone 2, then this plan. The M1 plan (`docs/plans/2026-10-11-1329-feat-m1-core-loop-encrypted-plan.md`) KTD1-KTD16 describe what exists and stay in force unless a KTD here names the change. `docs/OPEN_QUESTIONS.md` items 2 and 3 are settled inputs. Where this plan fixes behavior the docs leave open, the owning unit updates the doc in the same commit (Documentation Plan).
- **Stop conditions:**
  - Stop if any change would let the relay see plaintext, the room secret, or the close secret key (invariant 1).
  - Stop if any `packages/mcp/src` code path could build an envelope with `from.agent = "human"` (invariant 2). The human builder lives only in `packages/cli/src`.
  - Stop if a test would touch the real `~/.agentroom`, run the real `claude` or `gh` binary, or need a real pseudo-terminal dependency. A test that cannot be isolated is a blocker, not a skip.
  - Stop if a secret-scanner fixture would commit a string that GitHub push protection or gitleaks flags as a live credential (KTD5).
- **Execution profile:** TypeScript library, server and CLI code with unit, integration and stdio end-to-end tests. No deployment.
- **Who finishes:** The implementing agent builds and verifies locally. The orchestrator ticks `docs/PLAN.md` and writes `docs/LOG.md`; this work edits neither.

---

## Product Contract

### Summary

Add the safety layer M1 deferred. `protocol` gains thread resolution and the chain limit as pure functions, a gitleaks-derived secret scanner that runs inside `seal`, and Ed25519 close signing helpers. `relay-node` verifies `close`, remembers closed and expired rooms, and enforces max age, a per-connection rate limit and a connection cap. `mcp` enforces the chain limit in `send`, adds the `handoff` tool, `draft: true`, the `agentroom-rules` prompt, and clean teardown on `closed`. The CLI gains `say`, `approve`, `export` and `down`. The conformance suite covers close and expiry, and the README gains a threat model.

### Problem Frame

M1 proved two agents can exchange messages through a blind relay. It also left the failure modes that make leaving agents unattended unsafe. Two agents can reply to each other forever, burning tokens and making decisions no human saw. An agent can paste a token from its environment into a room that a coworker's agent reads and might act on. Nothing stops an agent from running a command that speaks in its human's name. The creator cannot end a room before the idle timeout, and a busy room never expires. `docs/PLAN.md` gates real use on these protections (Milestone 2, "Safe to use"), and the M1 code left explicit hooks for them: an empty `sendPolicy` in `packages/mcp/src/session.ts`, `close` rejected with `bad_proto` in `packages/relay-node/src/relay.ts`, and stored-but-unenforced `maxAgeSec` and `maxMembers`.

### Requirements

**Chain limit and threads (`protocol`, enforced in `mcp`)**

- R1. Thread resolution for an outgoing message: with `replyTo`, the parent must be a known non-presence envelope and the thread is the parent's thread; a supplied `thread` that differs is rejected. With only `thread`, it must name a known thread. With neither, the message starts a new thread (`thread = id`). Unknown ids are rejected, never turned into a new thread (KTD2).
- R2. Per-thread count: consecutive envelopes of kind `question`, `answer`, `decision`, `handoff` or `fyi` with `from.agent != "human"` since the last human-authored envelope in that thread (any kind, `approve` included). `presence` envelopes are ignored whoever sent them.
- R3. Room-wide count: consecutive agent-authored counted envelopes across all threads since the last human envelope anywhere.
- R4. MCP `send` (and `handoff`) refuses when the target thread's count is at or above `maxAgentChain`, or the room-wide count is at or above `2 * maxAgentChain`, with the texts in KTD3. Counts come from the session's full history ordered by relay seq, so a restart does not reset them.
- R5. `maxAgentChain` comes from the room `meta` in `welcome` (set by `up --max-chain`, default 3).
- R6. `room_status` lists threads waiting on a human (thread id and count) and the room-wide count against its limit, inside a labeled untrusted block (invariant 5).

**Secret scanning (`protocol`)**

- R7. A scanner with the rules in KTD4 checks the body and every ref field of every outgoing envelope. A match blocks the send and returns the rule name, the field, and a short explanation, never the matched text.
- R8. The scanner runs inside the one seal path every sender uses (`seal` in `protocol`), so MCP `send`, `handoff`, CLI `say` and `approve` are all covered, and the draft path calls it explicitly (KTD4).
- R9. Positive fixtures for every rule and negative fixtures drawn from ordinary Kotlin and Swift code, git SHAs, room ids and ULIDs pass without a block.

**Creator-only close and room lifetime (`relay-node`)**

- R10. `close` is accepted only when `sig` verifies under the pinned `closeKey` over the message defined in KTD6, using the nonce from this connection's `welcome`. A wrong key, a non-creator key, a signature made for another connection's nonce (replay), or a malformed signature gets `error{bad_signature}` and the room survives.
- R11. On a valid `close` the relay sends `closed` to every connection in the room, closes them, drops all room state, and tombstones the id (KTD7).
- R12. A `hello` carrying `closeOnly: true` is admitted even when the room is at the connection cap, receives a `welcome` with a nonce, is not counted or broadcast to, and may send only `close` (KTD8).
- R13. Rooms expire at the earlier of idle TTL and max age. Max age defaults to 24 h and the creating `hello`'s `maxAgeSec` is capped at it. `welcome.expiresAt` reports the earlier deadline. On expiry each open connection gets `error{room_expired}` before it is closed.
- R14. Closed and expired ids are remembered until their original max age has passed. Any `hello` for a remembered id, with or without `create`, gets `room_expired`.
- R15. Each connection has a token-bucket rate limit on `put` (KTD9). Over the limit, the relay answers `error{rate_limited}`, drops the frame, and keeps the connection open.
- R16. A `hello` that would exceed the per-room connection cap (default 8) gets `error{room_full}` and the connection closes.
- R17. Relay log events and stored state never contain a blob, meta, signature or plaintext; new events (`room_closed`, `rate_limited`) carry ids and codes only (invariant 1).

**MCP server (`mcp`)**

- R18. `send` gains `draft?: boolean`. A new `handoff` tool takes `summary`, `decisions[]`, `openQuestions[]`, `refs[]`, and the same optional `thread`, `replyTo`, `to`, `requiresHuman` and `draft` as `send`, and composes the body from the fixed template (KTD15).
- R19. With `draft: true`, `send` and `handoff` resolve the thread, scan for secrets, write the envelope to `<room>/pending.json`, and return the draft text plus a 12-hex-character sha256 prefix instead of posting. Drafts skip the chain check (KTD16). There is no release path in M2.
- R20. The server exposes an `agentroom-rules` prompt whose text is the four etiquette lines from `docs/ARCHITECTURE.md`, verbatim.
- R21. On `closed`, `room_expired` or `room_not_found` the server stops reconnecting, rejects any pending send at once, deletes the room directory, clears `current` if it names this room, allows one final read of unread messages, and then answers every tool with the matching terminal text (KTD17).
- R22. A non-terminal relay error (`rate_limited`, `too_large`, `room_full`) fails the in-flight send at once with a text naming the cause, instead of the 10 s "did not confirm" timeout (KTD13).
- R23. The MCP server still never emits `from.agent = "human"`. Every new path (`handoff`, drafts) builds `from` from `room.json` with a non-human agent.

**CLI (`agentroom`)**

- R24. `say [--thread <id> | --new] [--room <id>] <text>` and `approve <thread> [--room <id>]` run only when no agent environment marker from KTD18 is set and both stdin and stdout are TTYs. They are the only commands that emit `from.agent = "human"`, always with `via: "cli"`.
- R25. `say` without `--thread` or `--new` replies to the most recently updated thread, and with no history starts a new one. It prints the thread it used. `--thread` must name a known thread; `--new` starts one (KTD20).
- R26. `approve` posts an `approve` envelope to a known thread and prints the thread id.
- R27. `down [--room <id>]` works only on the machine that created the room. It signs the close over the fresh nonce through a close-only connection, and on `closed` (or a room the relay already forgot) deletes the local room directory and clears `current`. A non-creator gets a clear error and nothing is sent (KTD22).
- R28. `export [--thread <id>] [--format md|gh-issue] [--room <id>]` builds markdown from the local queue only. `md` writes to stdout. `gh-issue` writes the body to a new private temp file and prints `gh issue create --title '<fixed title>' --body-file '<path>'`; no message text, thread id or room name ever appears in the printed command (KTD23).
- R29. `export` refuses when an agent environment marker is set or stdin is not a TTY (KTD18).
- R30. `up` accepts `--ttl <n>h|<n>m` and sends it as the creating `hello`'s `maxAgeSec` (KTD10).
- R31. `say`, `approve` and `down` treat `room_not_found` and `room_expired` like `status` does: delete the local room directory, clear `current`, and tell the user to run `up` again.

**Conformance and docs**

- R32. The conformance suite gains close and expiry scenarios with real MCP processes: `down` tears down both members, a closed id cannot be re-created or joined, max-age expiry tears down both members, and the relay log and state hold no plaintext.
- R33. The README gains a threat model section covering what the relay sees, what a member can do, that human-tag paths stop accidental impersonation only (an agent running as the same OS user can read `room.json`), that refs-only is an instruction and not a control, that chain limits are per sender, and that share-code leakage is the user's responsibility.

### Acceptance Examples

- AE1. **Covers R2, R4.** Given a thread where Alice's and Bob's agents have posted `question`, `answer`, `question` (3 agent messages, limit 3), when Alice's agent sends another `answer` in that thread, then `send` returns `isError` with the per-thread text naming 3 and nothing reaches the relay. After a human `approve` for that thread arrives, the same send succeeds.
- AE2. **Covers R1, R3, R4.** Given limit 3 and no human messages, when an agent sends six messages each starting a new thread, then the sixth succeeds and the seventh is refused with the room-wide text naming 6. A `replyTo` naming an id not in history is rejected before the count is checked.
- AE3. **Covers R7, R8.** Given a body containing a fake AWS access key id, when an agent calls `send` or a human runs `say` in a faked TTY, then both are blocked with rule `aws-access-key-id`, the relay buffer is unchanged, and the error text does not contain the key.
- AE4. **Covers R10, R11, R14, R27.** Given Alice created the room and Bob joined, when Bob runs `down`, then it fails with a creator-only message and sends nothing. When Alice runs `down`, then both MCP servers receive `closed`, both room directories are deleted, and a later `join` with the code prints that the room is gone.
- AE5. **Covers R10.** Given a valid `close` signature captured from one connection, when it is sent on a second connection, then the relay answers `bad_signature` and the room survives.
- AE6. **Covers R24.** Given `CLAUDECODE=1` in the environment, when `agentroom say "hi"` runs, even with stdin and stdout faked as TTYs, then it exits non-zero naming the marker and posts nothing.
- AE7. **Covers R13, R21.** Given a room created with `maxAgeSec` 60 and continuous activity, when 60 s pass on the relay clock, then each MCP server gets `room_expired`, deletes its room directory, and answers the next tool call with the expiry text.
- AE8. **Covers R28.** Given a thread whose body contains `$(touch pwned)`, when `export --format gh-issue` runs and the printed command is executed by `/bin/sh` with a fake `gh` on `PATH`, then no `pwned` file is created and the body file contains the text verbatim.

### Scope Boundaries

- No Claude Code plugin, `UserPromptSubmit` hook, `/send <hash>` draft release, `watch` pane, delivery modes or notifications (M3). The scanner and human-tag rules are written so the M3 hook and `watch` reuse them.
- No adapters for other agents, no `relay-cf`, no npm publish (M4).
- No per-IP room-creation cap (`docs/OPEN_QUESTIONS.md` item 16 stays open).
- No `leave` command for non-creators; their local state goes on expiry or when the creator closes.

Considered and not built:

- **Closing a connection after sustained rate-limit abuse.** The bucket already drops excess puts and each refusal is one small frame. Revisit if the hosted relay sees floods.
- **Validating `closeKey` at create.** A malformed key only makes that creator's own room unclosable, and the relay and mcp tests use placeholder keys. Verification fails closed with `bad_signature`.
- **A client-side max-age clamp on the displayed `expiresAt`.** The MCP session slides its estimate on activity and cannot see the max-age cutoff, so `room_status` can overstate expiry by up to one idle window near max age. The relay pushes `room_expired` on time, so nothing acts on the wrong number. Revisit with the M3 status line by adding the cutoff to `welcome`.
- **Unique-prefix thread ids for `say --thread` and `approve`.** Thread ids are printed by `say` and visible in `room_status` and `export`. Revisit if typing full ULIDs proves painful in M3.
- **A share-code (`ar1_`) scanner rule.** Every recipient already holds the code. Not in the M2 rule list.
- **Confirm prompt before `say` posts.** `say` prints the chosen thread; a wrong-thread message is one more message, not a leak.

#### Deferred to Follow-Up Work

- M3: draft release through `/send <hash>`. The release must post `pending.json`'s envelope unchanged (the hash covers it) and then a human `approve`; it does not run the chain check (KTD16).
- M3: the `watch` input line uses the same human guard (KTD18) and seal path.
- M4: `relay-cf` must pass the updated conformance suite, including `closeOnly`, tombstones and max age.

### Sources

- `CLAUDE.md`; `docs/ARCHITECTURE.md` (Relay wire protocol, Crypto, Chain limit, Local state and process model, MCP tools, Secret scanner, Failure handling); `docs/UX.md` (CLI, Why human messages go through a hook); `docs/PLAN.md` Milestone 2; `docs/OPEN_QUESTIONS.md` items 2, 3, 14, 16.
- M1 code: `packages/mcp/src/session.ts` (`sendPolicy`, `sealOutbound`, `post`, `onGone`), `packages/mcp/src/relay-client.ts` (`RelayClient`, `oneShot`), `packages/relay-node/src/relay.ts` (`join`, sweep, `close` rejection), `packages/cli/src/commands/status.ts` (expiry cleanup pattern), `packages/cli/src/context.ts` (`CliContext`).
- `@modelcontextprotocol/server@2.3.1` installed type declarations: `registerPrompt(name, { title?, description?, argsSchema?: undefined }, cb)` overload exists, so a no-argument prompt needs no schema.
- Agent environment markers and gitleaks rules verified 2026-10-11 (sources inline in KTD4 and KTD18). Gitleaks generic rule and its false-positive controls: `id = "generic-api-key"` in https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml; entropy as Shannon bits per character (`shannonEntropy` in https://github.com/gitleaks/gitleaks/blob/master/detect/utils.go). AWS secret pattern: https://github.com/awslabs/git-secrets/blob/master/git-secrets.

---

## Planning Contract

### Key Technical Decisions

**Protocol**

- KTD1. **The chain limit is one pure module, `packages/protocol/src/chain.ts`.** It takes envelopes in relay-seq order plus `maxAgentChain` and returns per-thread counts, the room-wide count and the threads at or over the limit. A second function checks a candidate envelope against that state and returns either nothing or a refusal (`scope: "thread" | "room"`, `count`). It has no I/O, so the MCP session, a future CLI `status` and the M3 status line share one implementation. Human means `from.agent === "human"`; the module never looks at `via`.
- KTD2. **Thread resolution lives in the same module and rejects unknown ids.** M1 turned an unknown `replyTo` into a new thread id, which let a reply escape its thread's count. The MCP session keeps every envelope since join in `queue.jsonl`, so an unknown id means a typo or an attempt to sidestep the limit. Error texts: "replyTo <id> is not a message in this room; call inbox to see message ids.", "thread <id> does not match the thread of replyTo <id> (<parent thread>).", "thread <id> is not a thread in this room; omit thread to start a new one." A `replyTo` naming a `presence` envelope counts as unknown. Ids are stripped of control characters and truncated to 64 characters before they appear in an error.
- KTD3. **Refusal texts.** Per-thread: the ARCHITECTURE sentence verbatim with N replaced by the count, "This thread needs a human. N agent messages in a row without a human reply. Ask your user to respond with /say or approve with /approve." Room-wide: "This room needs a human. N agent messages in a row across threads without a human reply. Ask your user to respond with /say or approve with /approve." Both are followed by one line naming the CLI equivalents for users without the Claude Code plugin: "Outside Claude Code: agentroom say --thread <thread> \"...\" or agentroom approve <thread>." The `/say` and `/approve` slash commands do not exist until M3, and Codex or Gemini users need the CLI names now.
- KTD4. **The scanner is `packages/protocol/src/secrets.ts`, and `seal` calls it before encrypting.** Putting the check inside `seal` makes "every sender passes the scanner" structural: MCP `post`, CLI `say` and `approve`, and the M3 hook and `watch` all encrypt through `seal`. `sealMeta` is not scanned (the creator's own settings). A match throws `SecretFoundError` carrying `rule`, `field` (`body`, or `refs[i].repo|path|lines|commit`) and an explanation, with a message of the form "Blocked: this message looks like it contains a secret (rule <rule>, in <field>). <explanation> Remove it and send again." The matched text is never included. The draft path does not seal, so it calls the same scan function directly. Rules: the provider rules are ported from gitleaks `config/gitleaks.toml` (master, last changed 2025-11-20) with every inline `(?i)` replaced by a whole-regex `i` flag, because Node 20 and 22 reject inline modifier groups (they compile only from Node 24): `aws-access-token` (`AKIA`, `ASIA`, `ABIA`, `ACCA`, `A3T?` prefixes plus 16 base32 characters), `aws-secret-access-key` (gitleaks has none; the keyword-anchored git-secrets pattern: an `aws`/`secret`/`access`/`key` assignment followed by 40 base64 characters), `github-pat` (`ghp_`), `github-oauth` (`gho_`), `github-app-token` (`ghu_`, `ghs_`), `github-refresh-token` (`ghr_`), `github-fine-grained-pat` (`github_pat_`), the Slack family (`xoxb-`, `xoxp-`, `xoxe-`, `xoxa-`, `xoxr-`, `xoxo-`, `xoxs-`, `xapp-` shapes from the gitleaks slack rules), `private-key` (a `-----BEGIN ... PRIVATE KEY-----` header line alone, stricter than gitleaks, which needs the whole block, because half a key in chat is still a leak), `jwt` (two `ey`-prefixed base64url segments plus an optional signature), `gcp-api-key` (`AIza` plus 35 characters), `stripe-live-key` (`sk_live_` or `rk_live_` plus at least 10 alphanumerics, as `docs/PLAN.md` scopes it; test keys pass), and `generic-assignment` (KTD24). The gitleaks `EXAMPLE` allowlist for AWS ids is not ported: a documentation example pasted into a room is still blocked, which costs nothing and keeps the fixture rule simple. Provider rules skip gitleaks' entropy thresholds; their prefixes and lengths already make false positives rare.
- KTD5. **Fixture hygiene.** Positive fixtures are assembled at test runtime from fragments (for example `"AKIA" + "…"`) so the repository never contains a contiguous string that GitHub push protection or a gitleaks pre-commit hook would flag. Negative fixtures are realistic Kotlin and Swift snippets plus 40-hex git SHAs, 64-hex room ids, ULIDs and base64 test vectors. Because the AWS `EXAMPLE` allowlist is not ported, a fixture such as `['AKIA', 'Z7Q2K4M6N3P5R2T4'].join('')` blocks, and a test confirms the documented example id blocks too. A test compiles every rule under the running Node so an RE2-only construct fails on the Node 20 CI leg.
- KTD24. **The generic assignment rule is a tightened version of the one `docs/PLAN.md` names, because the named rule fails in both directions.** Tested on Node 20, `(key|token|secret|password)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{20,}` blocks Kotlin type annotations (`val token: AuthenticationTokenRepository`) and constructor calls (`password = PasswordEncoderFactoryImpl()`), and misses `apiKey = "..."` and `API_TOKEN=...` because it is case-sensitive. The rule here: case-insensitive; the keyword (`key`, `token`, `secret`, `password`, `passwd`) may carry up to 20 word characters of suffix (`secretKey`, `apiTokenValue`); an optional `: Type` may sit before the separator (`=`, `:`, `:=`, `=>`); the value is 20-150 characters of `[A-Za-z0-9_\-+/=.~]`, optionally quoted. A candidate is dropped when the value has no digit (the gitleaks `^[a-zA-Z_.-]+$` allowlist, which removes identifiers and class names), when it is word segments joined by `_`, `.` or `-` (`release_signing_key_2024_v1`, `R.string.preference_key_v2`), when its Shannon entropy is at or below 3.5 bits per character (the gitleaks generic threshold), or when the name is a gitleaks match-allowlist shape (`keyAlias`, `tokenUrl`, `secretLength`, `csrfToken`). The full 1 446-word gitleaks stopword list is not ported.
- KTD6. **Close signature bytes: UTF-8 of the 64-character hex `room_id` followed by the raw bytes of the base64-decoded `welcome.nonce`.** This matches KTD5 of M1, where associated data is the hex string the relay sees. `protocol/src/crypto.ts` gains `signClose(secretKey, roomId, nonce)` and `verifyClose(publicKey, sig, roomId, nonce)` over libsodium `crypto_sign_detached` and `crypto_sign_verify_detached`. `verifyClose` returns false on any decode failure or wrong length instead of throwing, so the relay maps every failure to `bad_signature`. The relay stores each connection's nonce at `welcome` time.

**Relay**

- KTD7. **Tombstones.** A closed or expired room leaves `roomId -> createdAt + maxAgeSec` in a map that the sweep prunes. A `hello` for a tombstoned id gets `room_expired` with the message "room was closed or expired", for both create and join. That keeps `room_not_found` meaning "never existed or the relay restarted". relay-node tombstones are in memory, so a restart forgets them; ids are 256-bit HKDF outputs, so nobody can re-create a closed room's id without the secret, and a fake room would fail `openMeta` for every real member.
- KTD8. **`hello` gains optional `closeOnly: true`.** The connection cap counts connections, so with eight open a creator could not close the room, which is exactly when closing matters (a leaked share code used to fill the room). A close-only connection skips the cap check, gets a `welcome` with a nonce, is not added to the room's broadcast set or counted in presence, and may send exactly one `close`; on success it receives `closed` like every member connection. Any other frame gets `bad_proto` and the connection closes. The relay closes it after 10 s without a `close`. `closeOnly` combined with `create` or `since` is `bad_proto`. This changes the wire protocol before any relay is deployed; `relay-cf` (M4) implements the same rule, and ARCHITECTURE records it in U3.
- KTD9. **Rate limit: a token bucket per connection on `put` only, burst 20, refill 2 per second,** configurable through `RelayOptions.rateLimit`. Agents post a few messages a minute, so this never binds normal use while capping a runaway loop at 2 messages a second per connection. `hello` is once per connection and `close` is once per room, so neither needs a bucket. The bucket uses the injected `now()` so tests are deterministic.
- KTD10. **Max age.** `RelayOptions.maxAgeSec` (default 86 400) becomes enforced. A room's max age is `min(create.maxAgeSec ?? default, default)`, stored on the room, and `expiresAt(room) = min(lastActivity + idleTtlSec, createdAt + maxAgeSec)` drives both `welcome.expiresAt` and the sweep. `up --ttl` accepts `<n>h` or `<n>m` with n a positive integer and sends the seconds as `maxAgeSec`; the idle TTL stays at the relay default. UX already lists `--ttl`, and the M1 plan deferred it to the milestone that enforces max age.
- KTD11. **Connection cap.** `RelayOptions.maxMembers` (default 8) becomes enforced at `hello`: a create or join that would make `conns.size` exceed it gets `room_full` and closes. One-shot CLI connections count, as ARCHITECTURE says.

**MCP server**

- KTD12. **The send pipeline order is fixed.** Gone check, then thread resolution (KTD2), then envelope build and schema parse, then for drafts: scan and write `pending.json`; for sends: chain check (KTD1), then `post` (the invariant 2 guard, then `seal`, which scans). The chain check replaces the empty `sendPolicy` hook, which is deleted. History is sorted by seq before every check because live arrivals and replayed queue lines can interleave out of order.
- KTD13. **Non-terminal relay errors reach the send that caused them.** `RelayClient` gains an `onError(code, message)` callback for every error code except the terminal ones. Sends are already serialized through `sendChain`, so the session rejects the oldest pending echo (which may be the presence post) at once with a fixed text: `rate_limited` -> "The relay rate-limited this connection; wait a few seconds and send again.", `too_large` -> "The relay refused the message as too large (64 KiB limit).", `room_full` -> "The room is full (connection cap reached); the server keeps retrying." On `room_full` the client also stays in backoff and keeps reconnecting, because members leave.
- KTD14. **`maxAgentChain` is read from `welcome.meta` on every welcome** with `openMeta`. If it fails to decrypt, the session keeps the default 3, counts a decrypt failure, and writes one stderr line. `send` cannot run before the first welcome (the client is not live), so no stale value is used.
- KTD15. **`handoff` template.** The body is four level-2 sections in this order: `## Summary` with the summary text, `## Decisions` and `## Open questions` as `- ` bullet lists, `## Refs` as one `- repo/path:lines @ commit` line per ref. An empty list renders `- None`. The refs also go into `env.refs`. If the composed body exceeds 8 000 characters, the tool returns an error naming the limit and the composed length. The renderer lives in `packages/mcp/src/handoff.ts` because the MCP tool is its only caller; M3's `/handoff` reaches it through the tool with `draft: true`.
- KTD16. **Drafts.** `pending.json` is a single slot written atomically with mode 0600: `{ v: 1, hash, createdAt, env }`. `env` is stored exactly as M3 will post it, with the drafting agent's `from.agent` and `via: "hook"` (released drafts carry `via: "hook"` per ARCHITECTURE), so the hash covers the bytes that will be posted. `hash` is the first 12 hex characters of sha256 over `JSON.stringify(env)`; 32 bits could be ground to a colliding draft in minutes, 48 bits cannot in a session. A new draft overwrites the old one. Drafts skip the chain check: a draft posts nothing without a human releasing it, and the M3 release posts a human `approve` with it, so the loop the limit guards against cannot form. The tool result is the draft rendered as plain text (it is the agent's own text, not inbound data), the hash, and a line saying it was not sent and that release arrives with the Claude Code plugin's `/send <hash>`.
- KTD17. **Terminal states share one teardown with distinct texts.** `RelayClient` treats `closed` like `room_expired`: state `gone`, stop, `onGone("closed")`. The session keeps M1's one-final-read behavior and then answers with `ROOM_CLOSED_TEXT` ("The room was closed by its creator. Run `agentroom up` to start a new room.") or the existing `ROOM_EXPIRED_TEXT`. `membersSeen` is keyed by `member/agent`, so a human message from Alice does not overwrite Alice's agent entry in `room_status`.

**CLI**

- KTD18. **Human guard: agent markers first, then terminals.** `packages/cli/src/human.ts` exports one guard used by `say`, `approve` and `export`. It refuses when any marker in the list below is set to a non-empty value, naming the variable, then refuses unless the required streams are TTYs. Checking markers first means the refusal names the real cause when an agent runs the command without a TTY. `say` and `approve` need stdin and stdout TTYs. `export` needs only stdin, so `export > file.md` works. `CliContext` gains `stdoutIsTTY`, set in `bin.ts` from `process.stdout.isTTY`. Markers, each verified 2026-10-11: `CLAUDECODE` (named in `CLAUDE.md` invariant 2 and the M2 acceptance; Claude Code sets it in every subprocess, https://code.claude.com/docs/en/env-vars), `CLAUDE_CODE_CHILD_SESSION` (set for Bash, PowerShell and Monitor tool, hook and status line subprocesses, same page), `AI_AGENT` (Claude Code sets it for subprocesses since 2.1.120, https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md; any non-empty value refuses), `CODEX_THREAD_ID` (always set for Codex shell-tool commands and not removable by `shell_environment_policy`, https://github.com/openai/codex/blob/main/codex-rs/core/src/exec_env.rs), `CODEX_CI` (Codex unified exec, https://github.com/openai/codex/blob/main/codex-rs/core/src/unified_exec/process_manager.rs), `CODEX_SANDBOX` (macOS Seatbelt only, https://github.com/openai/codex/blob/main/codex-rs/core/src/sandboxing/mod.rs), `GEMINI_CLI` (set for `run_shell_command` and `!` shell mode, https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/shell.md), and `CURSOR_AGENT` (Cursor staff forum post only, https://forum.cursor.com/t/cursor-cli-is-not-setting-cursor-agent-1-environment-variable-while-executing-bash-commands/132427). Not used: `CURSOR_TRACE_ID` and `CODEX_MANAGED_BY_NPM` mark the editor or the install, not an agent shell, so they would refuse humans. Each refusal names the variable: "Refusing: CODEX_THREAD_ID is set, so this looks like an AI agent's shell. Human messages must come from your own terminal." Known cost: Claude Code's IDE extensions also set `CLAUDECODE` in integrated terminals, so a human typing `agentroom say` in such a terminal is refused (Open Questions).
- KTD19. **One-shot relay sessions for CLI senders live in `packages/mcp/src/relay-client.ts`** (M1 KTD10 placed the relay client there for the CLI). A new `connectOnce({ url, hello })` opens a socket, sends the hello, and resolves with the welcome plus every `msg` up to `welcome.seq` when the hello asked for `since: 0`. It offers `put(blob)`, which resolves with the seq of the first `msg` whose blob string equals the sent blob, and `close(sig)`, which resolves on `closed`. Errors reject with the relay code. It handles opaque blobs only and never builds an envelope, so the invariant 2 source guard over `packages/mcp/src` stays meaningful. The M1 `oneShot` stays for `up`, `join` and `status`.
- KTD20. **`say` and `approve` history comes from the relay replay merged with the local queue.** The CLI must work with no MCP server running (a Codex user, or a human whose agent session ended), so it cannot rely on `queue.jsonl` alone. It merges `replayQueue` (if the room dir has a queue) with the `since: 0` catch-up, decrypts, drops undecryptable blobs, and dedupes by id. The CLI never writes `queue.jsonl`, which stays single-writer. "Most recently updated thread" is the thread of the highest-seq non-presence envelope from anyone. `say` sets `kind: "answer"` and `replyTo` the latest non-presence envelope when replying, and `kind: "question"` with `thread = id` for a new thread. `approve` sets `kind: "approve"`, an empty body and no `replyTo`. The text is the positional arguments joined by single spaces; empty text is a usage error.
- KTD21. **The human envelope builder is `packages/cli/src/human.ts`,** returning `{ member: room.member, agent: "human", via: "cli" }`. It is the only place outside tests that writes the human tag, and a CLI test asserts that `say` and `approve` are its only callers.
- KTD22. **`down` flow.** Read `room.json`. Without `createdByMe` and `closeSecretKey`, exit 1 with "Only the machine that created this room can close it. Ask the creator to run `agentroom down`; this room's local state goes away when the room closes or expires." and make no connection. Otherwise open a close-only one-shot connection (KTD8), sign the nonce (KTD6), send `close`, and wait for `closed`. On `closed`, `room_not_found` or `room_expired`, delete the room directory and clear `current`. On `bad_signature`, keep local state and exit 1. `down` has no TTY guard: it is not a human-tag path, and an agent closing its own creator's room is an availability event, not impersonation. It prints "Run `agentroom export` first if you need a record" only in its `--help` text, not as a prompt.
- KTD23. **`export` output.** It reads `replayQueue` only and opens no relay connection, which deviates from ARCHITECTURE's process-model list (export needs nothing from the relay). Without a room directory it exits 1 with "No local history for this room: it was closed or expired, or no MCP server ran here." Messages are grouped by thread in seq order, presence omitted, each headed `seq, ISO time, member/agent, kind` (human messages labeled `(human)`), and each body placed in a fenced code block longer than its longest backtick run, so peer markdown cannot render images, ping `@` mentions, or forge headings in a GitHub issue. `gh-issue` writes `issue.md` (0600) inside a fresh `mkdtemp` directory (0700) under `os.tmpdir()`, not the repo checkout (risk of committing decrypted text) and not the room directory (`down` would delete it before `gh` runs). The title is the literal `agentroom export YYYY-MM-DD`. Title and path are each single-quoted for POSIX `sh`, with embedded `'` written as `'\''`.

### High-Level Technical Design

**Outbound send pipeline (MCP and CLI share `seal`)**

```mermaid
flowchart TB
  A[send / handoff input] --> B{room gone?}
  B -->|yes| X1[terminal text]
  B -->|no| C[resolveThread KTD2]
  C -->|unknown or mismatch| X2[isError: thread text]
  C --> D[build envelope via buildFrom, non-human]
  D --> E{draft?}
  E -->|yes| F[scanEnvelope KTD4]
  F -->|match| X3[isError: rule and field]
  F --> G[write pending.json, return text and hash]
  E -->|no| H[checkChain KTD1]
  H -->|refused| X4[isError: KTD3 text]
  H --> I[invariant 2 guard, then seal: scan, encrypt]
  I -->|match| X3
  I --> J[put, wait for echo]
  J -->|non-terminal relay error| X5[isError: KTD13 text]
  J --> K[id and seq]
  S[CLI say / approve] --> SG[human guard KTD18]
  SG --> SH[connectOnce since 0, merge history KTD20]
  SH --> SI[resolveThread, human from KTD21]
  SI --> I2[seal: scan, encrypt]
  I2 --> SJ[put, wait for echo by blob]
```

**Creator-only close**

```mermaid
sequenceDiagram
  participant CLI as agentroom down (creator)
  participant R as relay
  participant M as MCP servers (both members)
  CLI->>R: hello {room, closeOnly: true}
  R-->>CLI: welcome {nonce}
  Note over CLI: sig = Ed25519(closeSecretKey, utf8(room_id) || nonce)
  CLI->>R: close {sig}
  alt sig verifies under pinned closeKey with this connection's nonce
    R-->>M: closed
    R-->>CLI: closed
    R->>R: drop room, tombstone until createdAt + maxAge
    M->>M: stop reconnecting, delete room dir, final read, closed text
    CLI->>CLI: delete room dir, clear current
  else wrong key, replayed nonce, malformed
    R-->>CLI: error bad_signature (room survives)
  end
```

**Room lifecycle on the relay**

```mermaid
stateDiagram-v2
  [*] --> Live: hello with create (id not live, not tombstoned)
  Live --> Live: put / hello (refresh idle)
  Live --> Tombstoned: valid close (broadcast closed)
  Live --> Tombstoned: idle TTL or max age reached (push room_expired)
  Tombstoned --> [*]: createdAt + maxAge passed (sweep prunes)
  note right of Tombstoned: any hello gets room_expired
```

**Chain counting (directional)**

```text
for env in history ordered by seq:
  if env.kind == presence: skip
  if env.from.agent == human:
      threadCount[env.thread] = 0; roomCount = 0
  else if env.kind in {question, answer, decision, handoff, fyi}:
      threadCount[env.thread] += 1; roomCount += 1
refuse candidate if threadCount[candidate.thread] >= N  (scope thread)
              or roomCount >= 2N                        (scope room)
waiting = threads with threadCount >= N
```

### Assumptions

These are agent bets made without a human to confirm them.

- A human-authored message of any kind resets both counters, including `approve` with an empty body. Human messages are never chain-checked.
- `say` posts with `requiresHuman: false` and no `to`.
- When a human's own `say` arrives at the same machine's MCP server, it is unread for that agent (not "own", not needs-you). The agent should see what its human said.
- One-shot CLI connections send a `hello`, so they refresh the idle TTL and flick the peers' presence count, as `status` already does in M1.
- `export --thread` must name a thread present in the local queue; otherwise it exits 1 listing nothing.
- `export` includes the human-readable room id prefix (first 12 hex) in the markdown heading but never in the printed `gh` command.
- The rate-limit and cap defaults (burst 20, 2/s, 8 connections) are fine for v0 and are documented in ARCHITECTURE.
- Agent environment markers are a best-effort, documented list; a vendor that adds a marker later needs a one-line change and an OPEN_QUESTIONS entry.

### Output Structure

```text
packages/protocol/src/{chain,secrets}.ts                 (new)
packages/protocol/src/{crypto,wire,index}.ts             (modified: close sign/verify, closeOnly)
packages/protocol/test/{chain,secrets}.test.ts           (new)
packages/protocol/test/{crypto,wire}.test.ts             (modified)
packages/relay-node/src/relay.ts                         (modified)
packages/relay-node/test/relay.test.ts                   (modified)
packages/mcp/src/{handoff,pending}.ts                    (new)
packages/mcp/src/{relay-client,session,server,state,index}.ts (modified)
packages/mcp/test/{chain-policy,handoff-draft,terminal}.test.ts (new)
packages/mcp/test/{relay-client,server,session,helpers}.test.ts (modified as needed)
packages/cli/src/human.ts                                (new)
packages/cli/src/commands/{say,approve,down,export}.ts   (new)
packages/cli/src/{args,context,bin,index}.ts             (modified)
packages/cli/src/commands/up.ts                          (modified: --ttl)
packages/cli/test/{human,say-approve,down,export}.test.ts (new)
tests/conformance/test/close-expiry.test.ts              (new)
tests/conformance/test/two-agents.test.ts                (modified: chain limit, scanner, marker)
README.md, docs/ARCHITECTURE.md, docs/UX.md, docs/OPEN_QUESTIONS.md (modified)
```

### Risks

| Risk | Mitigation |
|---|---|
| Two agents on two machines both at N-1 post at once and the thread reaches N+1. | Each MCP server checks its own history; the relay cannot. The overshoot is at most one per concurrent sender. Acceptance tests use one sender; the README threat model says so (R33). |
| A secret fixture committed to the repo trips GitHub push protection or the scanner of anyone who clones it. | KTD5 builds positives from fragments at runtime. |
| A gitleaks regex uses RE2 syntax that JavaScript rejects or reads differently (inline `(?i)` flags are not supported on Node 20). | KTD4 rewrites each rule with whole-regex flags; U2 tests every rule against a positive fixture. |
| The generic assignment rule blocks ordinary Kotlin or Swift code and agents stop trusting the scanner. | KTD4's tightened generic rule plus the negative fixture set in U2. |
| A put races a `close` and hangs until the echo timeout. | KTD17 rejects pending echoes on `closed`; KTD13 rejects them on non-terminal errors. |
| `down`'s local cleanup races the running MCP server writing `status.json`. | `persistStatus` already returns when the session is gone; any recreated dir is deleted again when the server receives `closed`. |
| The one-shot `say` misses history older than the 500-envelope buffer on a machine with no queue. | KTD20 merges the local queue when present; a reply to an older thread can pass `--thread`, which resolves against the merged history. |
| Changing `CliContext` breaks every CLI test that builds a context. | `stdoutIsTTY` defaults to false in `makeCtx`, matching `isTTY`. |

### Documentation Plan

- U1 adds the thread rules (KTD2) and both refusal texts (KTD3) to ARCHITECTURE "Chain limit".
- U2 adds the rule list, the in-`seal` placement and the no-echo error rule to ARCHITECTURE "Secret scanner".
- U3 adds the close message bytes (KTD6), `closeOnly` (KTD8) and tombstone semantics (KTD7) to ARCHITECTURE "Relay" and replaces the M1 "close is rejected until M2" bullet.
- U4 adds max age, rate limit and cap defaults and behavior (KTD9-KTD11) to ARCHITECTURE "Relay".
- U6 adds KTD13 and KTD17 to ARCHITECTURE "Failure handling".
- U7 adds the `pending.json` format and the draft-skips-chain rule (KTD16) to ARCHITECTURE "MCP server" and UX "Why human messages go through a hook".
- U8 records the agent environment markers (KTD18) and the gitleaks porting notes (KTD4, KTD24) with dates and source URLs as a new `docs/OPEN_QUESTIONS.md` entry, updates ARCHITECTURE and UX where they say "a marker such as `CLAUDECODE`" to name the full list, and adds the `say` kind and thread rules (KTD20) to UX "CLI".
- U10 updates ARCHITECTURE's process-model line about `export` (KTD23) and the `gh-issue` file location.
- U12 writes the README threat model (R33), the M2 usage lines, and the Status line.

---

## Implementation Units

| U-ID | Title | Key files | Depends on |
|---|---|---|---|
| U1 | Protocol thread resolution and chain limit | `packages/protocol/src/chain.ts` | none |
| U2 | Protocol secret scanner inside `seal` | `packages/protocol/src/{secrets,crypto}.ts` | none |
| U3 | Signed close, close-only hello, tombstones | `packages/protocol/src/{crypto,wire}.ts`, `packages/relay-node/src/relay.ts` | none |
| U4 | Relay max age, rate limit, connection cap | `packages/relay-node/src/relay.ts` | U3 |
| U5 | MCP relay client: terminal and non-terminal errors, `connectOnce` | `packages/mcp/src/relay-client.ts` | U3, U4 |
| U6 | MCP session: chain policy, meta, `room_status`, teardown | `packages/mcp/src/{session,server}.ts` | U1, U2, U5 |
| U7 | MCP `handoff`, drafts, `agentroom-rules` prompt | `packages/mcp/src/{handoff,pending,server,state}.ts` | U6 |
| U8 | CLI human guard, `say`, `approve` | `packages/cli/src/{human,context,bin,args}.ts`, `commands/{say,approve}.ts` | U1, U2, U5 |
| U9 | CLI `down` and `up --ttl` | `packages/cli/src/commands/{down,up}.ts` | U3, U4, U5 |
| U10 | CLI `export` | `packages/cli/src/commands/export.ts` | U8 |
| U11 | Conformance: close, expiry, chain limit, scanner, marker | `tests/conformance/test/*.test.ts` | U6-U10 |
| U12 | README threat model and usage | `README.md` | U11 |

### U1. Protocol thread resolution and chain limit

- **Goal:** One pure implementation of R1-R3 and the refusal texts that every caller uses.
- **Requirements:** R1, R2, R3, R4 (texts), R6 (waiting threads data).
- **Dependencies:** none.
- **Files:** `packages/protocol/src/chain.ts`, `packages/protocol/src/index.ts`, `packages/protocol/test/chain.test.ts`, `docs/ARCHITECTURE.md`.
- **Approach:**
  1. Thread resolution per KTD2 takes the candidate's `thread?`, `replyTo?`, the new id and the history, and returns the thread or a typed error with the KTD2 text.
  2. Chain state and the candidate check per KTD1, with counting per R2-R3 and the HTD pseudo-code.
  3. A text helper renders KTD3's per-thread and room-wide refusals with the count and thread id.
- **Patterns to follow:** `packages/protocol/src/frame.ts` (pure function, exported constants for fixed texts, `stripControl` for peer strings).
- **Test scenarios:**
  - Three agent messages in thread T with limit 3: a fourth candidate in T is refused with scope thread and count 3; a candidate in another thread is allowed.
  - A human `answer` in T after three agent messages resets T to 0 and the room count to 0.
  - A human `approve` with an empty body resets T exactly like a human message.
  - Presence envelopes between agent messages do not change any count, whether tagged human or agent.
  - Six agent messages each in a new thread with limit 3: the room count is 6 and the next candidate is refused with scope room; a human message in any thread resets the room count.
  - A human message in thread A resets the room count but leaves thread B's count unchanged.
  - Waiting threads lists exactly the threads at or over the limit.
  - History supplied out of seq order produces the same result once sorted by the caller (document that input must be seq-ordered and test the sorted path).
  - `replyTo` a known message returns its thread; `replyTo` plus a matching `thread` passes; `replyTo` plus a different `thread` is rejected with the mismatch text.
  - `replyTo` an unknown id, and `replyTo` a presence id, are rejected with the unknown-id text.
  - `thread` alone naming an existing thread passes; naming an unknown thread is rejected; neither returns the new id.
  - An id containing control characters and 200 characters appears in the error stripped and truncated to 64.
  - Refusal texts contain the ARCHITECTURE sentence verbatim with the count substituted, plus the CLI line with the thread id.
- **Verification:** Every R1-R3 rule has a named test; the module has no imports outside `envelope.ts` and `frame.ts`.

### U2. Protocol secret scanner inside `seal`

- **Goal:** Block credentials in any outgoing envelope before encryption, for every sender.
- **Requirements:** R7, R8, R9.
- **Dependencies:** none.
- **Files:** `packages/protocol/src/secrets.ts`, `packages/protocol/src/crypto.ts`, `packages/protocol/src/index.ts`, `packages/protocol/test/secrets.test.ts`, `packages/protocol/test/crypto.test.ts`, `docs/ARCHITECTURE.md`.
- **Approach:**
  1. A rule table (name, regex with whole-regex flags, explanation) per KTD4, and a scan over the body and every ref field that returns the first match's rule and field.
  2. `SecretFoundError` with `rule`, `field` and the KTD4 message.
  3. `seal` parses the envelope, then scans, then encrypts. `sealMeta` is unchanged.
- **Execution note:** Write the positive and negative fixture tables first; they define the regexes.
- **Patterns to follow:** `CryptoError` and `ShareCodeError` for the error class shape.
- **Test scenarios:**
  - Each rule blocks its positive fixture (assembled at runtime per KTD5) in the body, and reports that rule's name.
  - A fake AWS access key id in `refs[1].path` is blocked with field `refs[1].path`.
  - The error message and every property of the error contain no substring of the matched secret.
  - `seal` with a fake key in the body throws `SecretFoundError` and returns no blob.
  - Negative fixtures pass: Kotlin snippets with `val tokenProvider: TokenProvider = DefaultTokenProvider()`, `private val passwordField: EditText`, `const val KEY_ALIAS = "com.example.sdk.keystore"`, Swift snippets with `let secretKeyAlias = "com.example.sdk.keychain.alias"`, `var apiKeyHeaderName: String`, `func refreshToken(completion: @escaping (Result<Token, Error>) -> Void)`, a 40-hex git SHA in `refs[0].commit`, a 64-hex room id, a ULID, a base64 test vector, and an `ar1_` share code.
  - The generic rule (KTD24) blocks `apiKey = "<20+ mixed chars with digits>"`, `let apiKey: String = "<hex>"` and `API_TOKEN=<mixed>`, each assembled at runtime.
  - The generic rule passes `val token: AuthenticationTokenRepository`, `password = PasswordEncoderFactoryImpl()`, `monkey=BananaRepublicExtraordinaire`, `val keyAlias = "release_signing_key_2024_v1"`, `val cacheKey = "user_profile_cache_v2_12345"` and `key = R.string.preference_notification_key_v2`.
  - The AWS documentation example access key id (assembled from fragments) is blocked, because the `EXAMPLE` allowlist is not ported.
  - A bare `-----BEGIN RSA PRIVATE KEY-----` header line with no body is blocked.
  - `sk_test_` plus 24 alphanumerics passes; `sk_live_` plus 24 is blocked.
  - Every rule compiles under the running Node (the Node 20 CI leg catches RE2-only syntax).
  - A body of 8 000 characters of mixed code scans in well under 50 ms (guards against catastrophic backtracking).
  - Existing crypto round-trip, tamper and wrong-key tests still pass unchanged.
- **Verification:** All rules covered by positives, the negative set produces zero blocks, and `pnpm -r test` is green with the scanner inside `seal`.

### U3. Signed close, close-only hello, tombstones

- **Goal:** The relay accepts `close` only from the creator's key over a fresh nonce, and closed rooms stay dead.
- **Requirements:** R10, R11, R12, R14 (closed ids), R17.
- **Dependencies:** none.
- **Files:** `packages/protocol/src/crypto.ts`, `packages/protocol/src/wire.ts`, `packages/protocol/test/crypto.test.ts`, `packages/protocol/test/wire.test.ts`, `packages/relay-node/src/relay.ts`, `packages/relay-node/test/relay.test.ts`, `docs/ARCHITECTURE.md`.
- **Approach:**
  1. `signClose` and `verifyClose` per KTD6.
  2. `HelloFrame` gains optional `closeOnly: true`; the relay rejects it with `create` or `since` (KTD8).
  3. The relay stores each connection's nonce, handles close-only admission and the 10 s grace timer, verifies `close`, broadcasts `closed`, closes every connection, deletes the room, logs `room_closed`, and tombstones per KTD7. The M1 `bad_proto` rejection of `close` is removed.
  4. `close` on an ordinary member connection is also accepted when the signature verifies, so a creator's long-lived client could close in future; only the nonce and key matter.
- **Patterns to follow:** the existing `fail`, `broadcast` and sweep helpers in `packages/relay-node/src/relay.ts`; the relay test `connect`/`createRoom` helpers (create rooms with a real close keypair where close is exercised; placeholder `closeKey` elsewhere stays).
- **Test scenarios:**
  - `signClose`/`verifyClose` round trip; verification fails for a different room id, a different nonce, a different public key, a truncated signature, and non-base64 input (returns false, does not throw).
  - Valid close from a close-only connection: both member connections and the closer receive `closed`, all sockets close, `snapshot` returns undefined, and a `room_closed` event is logged with only the room id.
  - Close signed by a different keypair (non-creator) gets `bad_signature`, the closer's socket closes, and the room and its members are untouched. Covers AE5 variant.
  - A signature valid for connection A's nonce, sent on connection B, gets `bad_signature`. Covers AE5.
  - Malformed `sig` (empty, not base64) gets `bad_signature`.
  - After a close, `hello` without `create` and `hello` with `create` for the same id both get `room_expired`.
  - A close-only connection is admitted when the room already holds `maxMembers` connections, does not change the presence count, and receives no `msg` frames.
  - A close-only connection that sends `put` gets `bad_proto` and is closed; one that sends nothing is closed after the grace period (injected timer or short option).
  - `closeOnly` with `create`, or with `since`, gets `bad_proto`.
  - The invariant 1 test also runs a close and asserts no event, error message or snapshot field contains the signature, meta or a blob.
- **Verification:** All relay tests green; the ARCHITECTURE wire block shows `closeOnly` and the close message definition.

### U4. Relay max age, rate limit, connection cap

- **Goal:** Every room ends within its max age, a runaway client cannot flood a room, and rooms have a connection ceiling.
- **Requirements:** R13, R14 (expired ids), R15, R16, R17.
- **Dependencies:** U3 (tombstones, close-only exemption from the cap).
- **Files:** `packages/relay-node/src/relay.ts`, `packages/relay-node/src/bin.ts` (env overrides only if trivially needed; otherwise unchanged), `packages/relay-node/test/relay.test.ts`, `docs/ARCHITECTURE.md`.
- **Approach:**
  1. Max age per KTD10: store the capped value at create, compute `expiresAt` as the earlier deadline, and tombstone on expiry.
  2. Rate limit per KTD9 with a per-connection bucket on the connection state; refused puts log a `rate_limited` event without the blob.
  3. Connection cap per KTD11, skipped for close-only hellos.
  4. Remove the "Stored only; enforced in M2" comments and add `rateLimit` to `RelayOptions`.
- **Test scenarios:**
  - A room created with `maxAgeSec` above the default is capped at the default; without `maxAgeSec` it gets the default.
  - With continuous puts keeping the room active, advancing the clock past `createdAt + maxAgeSec` and running the sweep pushes `error{room_expired}` to every connection, closes them, and drops the room.
  - `welcome.expiresAt` equals the max-age deadline when it is earlier than the idle deadline, and the idle deadline otherwise.
  - After expiry, `hello` with and without `create` gets `room_expired`; after the tombstone's max age passes and a sweep runs, `hello` without `create` gets `room_not_found`.
  - With burst 3 and refill 1/s (options), the fourth immediate put gets `rate_limited`, is not stored or broadcast, and the connection stays open; after advancing the clock 1 s one put succeeds.
  - Rate limits are per connection: a second connection in the same room can still put while the first is limited.
  - With `maxMembers: 2`, a third join gets `room_full` and is closed; after one member leaves, a join succeeds.
  - The invariant 1 test covers `rate_limited` and `room_full` paths: no blob in events or errors.
- **Verification:** All relay tests green; defaults documented in ARCHITECTURE.

### U5. MCP relay client: terminal and non-terminal errors, `connectOnce`

- **Goal:** Clients stop on `closed`, surface non-terminal errors, and the CLI has a one-shot session for posting and closing.
- **Requirements:** R21 (client side), R22 (client side), R27 and R24 (transport).
- **Dependencies:** U3, U4.
- **Files:** `packages/mcp/src/relay-client.ts`, `packages/mcp/src/index.ts`, `packages/mcp/test/relay-client.test.ts`.
- **Approach:**
  1. `closed` handling per KTD17 and the `onError` callback per KTD13; `GoneCode` gains `closed`; `room_full` keeps the backoff loop running.
  2. `connectOnce` per KTD19, with a timeout like `oneShot`'s and `closeOnly` passed through in the hello.
- **Patterns to follow:** `oneShot` and its `finish` cleanup; relay-client tests that drive a real `startRelay`.
- **Test scenarios:**
  - On `closed`, the client calls `onGone("closed")` once, its state is `gone`, and it does not reconnect after the socket closes.
  - On `rate_limited`, `onError` is called with the code and the connection stays live.
  - On `room_full` at hello, the client reports the error, enters backoff, and connects once a slot frees.
  - `connectOnce` with `since: 0` resolves after receiving exactly `welcome.seq` buffered messages; with an empty room it resolves at once with none.
  - `connectOnce.put` resolves with the echo seq and ignores a peer's message that arrives first.
  - `connectOnce.put` rejects with `rate_limited` when the relay refuses it.
  - `connectOnce` with `closeOnly` plus a valid `close` resolves on `closed`; with a bad signature it rejects with `bad_signature`.
  - `connectOnce` against an unknown room rejects with `room_not_found`; against an unreachable URL rejects with a reachability message.
- **Verification:** relay-client tests green; no file in `packages/mcp/src` gains the string `"human"`.

### U6. MCP session: chain policy, meta, `room_status`, teardown

- **Goal:** `send` enforces thread rules and the chain limit, reports causes promptly, and the session tears down cleanly on close.
- **Requirements:** R4, R5, R6, R21, R22, R23.
- **Dependencies:** U1, U2, U5.
- **Files:** `packages/mcp/src/session.ts`, `packages/mcp/src/server.ts`, `packages/mcp/test/chain-policy.test.ts`, `packages/mcp/test/terminal.test.ts`, `packages/mcp/test/server.test.ts`, `packages/mcp/test/helpers.ts`, `docs/ARCHITECTURE.md`.
- **Approach:**
  1. Replace `sendPolicy` and the inline thread derivation with the KTD12 pipeline.
  2. Read `maxAgentChain` per KTD14.
  3. Wire `onError` to reject the oldest pending echo with the KTD13 texts, and `onGone("closed")` to the KTD17 teardown and text.
  4. `room_status` gains waiting threads and the room-wide count (R6) in a second labeled block `<agentroom_threads untrusted="true">` before the reminder line, with thread ids escaped like member names; `structuredContent` gains `waitingOnHuman` and `roomAgentRun`.
  5. Key `membersSeen` by `member/agent` (KTD17).
  6. A `SecretFoundError` from `seal` surfaces as the tool's `isError` text unchanged.
- **Patterns to follow:** `renderStatus` in `packages/mcp/src/server.ts`; the M1 session tests' two-member setup in `packages/mcp/test/helpers.ts` (add an injector for human envelopes sealed with the room key, standing in for CLI `say`).
- **Test scenarios:**
  - Covers AE1. Alice and Bob alternate three agent messages in one thread (limit 3); Alice's fourth `send` in that thread returns `isError` with the per-thread text and the relay snapshot gains nothing; after a human `approve` for the thread is injected and arrives, the send succeeds.
  - A human `answer` injected in the thread resets it the same way.
  - Covers AE2. Six new-thread sends succeed and the seventh is refused with the room-wide text; one injected human message anywhere lets the next send through.
  - A room created with `maxAgentChain: 2` in meta refuses the third message in a thread.
  - Restart: after three agent messages, a new session on the same home refuses the fourth without any new traffic (counts rebuilt from history).
  - `replyTo` an unknown id returns the KTD2 text; `thread` plus mismatched `replyTo` returns the mismatch text; neither reaches the relay.
  - Covers AE3 (MCP path). A `send` whose body holds a fake AWS key returns `isError` naming `aws-access-key-id`, the text does not contain the key, and the relay snapshot is unchanged.
  - `room_status` lists a thread at the limit inside `<agentroom_threads untrusted="true">`, shows the room count against `2N`, and a thread id containing `</agentroom_threads>` and a newline is escaped and stays inside the block.
  - A relay with burst 1: the second rapid `send` fails within one second with the rate-limit text, not after 10 s.
  - `closed` from the relay: the room dir is deleted, `current` cleared, the next `inbox` returns unread messages plus `ROOM_CLOSED_TEXT`, the following call returns `ROOM_CLOSED_TEXT`, a `send` pending at close time rejects at once, and no reconnect happens.
  - A human message from member `alice` does not replace `alice/codex` in `membersSeen`.
  - Invariant 2 source guard still counts exactly one `"human"` literal under `packages/mcp/src`.
- **Verification:** mcp tests green, including the M1 suite with thread derivation now rejecting unknown `replyTo` (update any M1 test that relied on the old fallback).

### U7. MCP `handoff`, drafts, `agentroom-rules` prompt

- **Goal:** Structured handoffs, draft-instead-of-post, and the etiquette prompt.
- **Requirements:** R18, R19, R20, R23.
- **Dependencies:** U6.
- **Files:** `packages/mcp/src/handoff.ts`, `packages/mcp/src/pending.ts`, `packages/mcp/src/session.ts`, `packages/mcp/src/server.ts`, `packages/mcp/src/state.ts` (pending path helper only if it fits there), `packages/mcp/test/handoff-draft.test.ts`, `packages/mcp/test/server.test.ts`, `docs/ARCHITECTURE.md`, `docs/UX.md`.
- **Approach:**
  1. `handoff` input schema per R18 and template per KTD15; it runs the same pipeline as `send` with `kind: "handoff"`.
  2. `draft` on both tools per KTD16: `buildFrom` takes the `via` to stamp so drafts carry `via: "hook"` while still typed to the non-human agent enum.
  3. `registerPrompt("agentroom-rules", { title, description }, ...)` with no `argsSchema`, returning one user message whose text is the four ARCHITECTURE lines.
- **Patterns to follow:** `writeAtomic` in `packages/mcp/src/state.ts` for the 0600 atomic write; `SendInput` in `packages/mcp/src/server.ts`.
- **Test scenarios:**
  - `handoff` with one decision, no open questions and two refs posts a `handoff` envelope whose body has the four headings in order, `- None` under Open questions, ref lines in `repo/path:lines @ commit` form, and `env.refs` equal to the input refs.
  - A `handoff` whose composed body exceeds 8 000 characters returns an error naming the limit and the length.
  - `handoff` with `replyTo` follows KTD2 and is chain-checked like `send` (a fourth agent message in a limited thread is refused).
  - `send` with `draft: true` writes `pending.json` (mode 0600, valid JSON), posts nothing (relay snapshot unchanged), and returns the body text and a 12-hex hash equal to the sha256 prefix of the stored `env` JSON.
  - The drafted `env` has the configured agent, never `human`, and `via: "hook"`.
  - A second draft overwrites `pending.json` and returns a different hash.
  - A draft containing a fake AWS key is refused with the scanner text and `pending.json` is not written.
  - A draft in a thread at the chain limit is written (drafts skip the chain check) and the result still says it was not sent.
  - `down`-style teardown (closed) deletes `pending.json` with the room dir.
  - `listPrompts` includes `agentroom-rules`; `getPrompt` returns exactly the four ARCHITECTURE lines.
  - The invariant 2 source guard still passes with the new files.
- **Verification:** mcp tests green; ARCHITECTURE and UX describe `pending.json` and the draft rule.

### U8. CLI human guard, `say`, `approve`

- **Goal:** The only human-tagged senders, refusing agent shells and non-terminals.
- **Requirements:** R24, R25, R26, R31, R8 (CLI path).
- **Dependencies:** U1, U2, U5.
- **Files:** `packages/cli/src/human.ts`, `packages/cli/src/context.ts`, `packages/cli/src/bin.ts`, `packages/cli/src/args.ts`, `packages/cli/src/index.ts`, `packages/cli/src/commands/say.ts`, `packages/cli/src/commands/approve.ts`, `packages/cli/test/human.test.ts`, `packages/cli/test/say-approve.test.ts`, `packages/cli/test/helpers.ts`, `docs/OPEN_QUESTIONS.md`, `docs/UX.md`.
- **Approach:**
  1. Guard and marker list per KTD18; `CliContext.stdoutIsTTY` added and set in `bin.ts`.
  2. Human `from` builder per KTD21.
  3. `say` and `approve` per KTD20 over `connectOnce` (KTD19) and `seal`; both print the thread id used and the seq.
  4. Expiry cleanup per R31, reusing `status`'s pattern.
  5. Usage text gains `say`, `approve`, `down`, `export` and `up --ttl`.
- **Patterns to follow:** `packages/cli/src/commands/status.ts` (room resolution, expiry cleanup), `packages/cli/test/helpers.ts` `makeCtx`.
- **Test scenarios:**
  - Covers AE6. With `isTTY` and `stdoutIsTTY` true and `CLAUDECODE=1`, `say "hi"` exits non-zero, names `CLAUDECODE`, and the relay snapshot is unchanged.
  - Each other marker in the KTD18 list (`CLAUDE_CODE_CHILD_SESSION`, `AI_AGENT`, `CODEX_THREAD_ID`, `CODEX_CI`, `CODEX_SANDBOX`, `GEMINI_CLI`, `CURSOR_AGENT`) refuses the same way and is named in the message; an empty-string marker does not refuse; `CURSOR_TRACE_ID` and `CODEX_MANAGED_BY_NPM` do not refuse.
  - With no markers and stdin not a TTY, `say` refuses with the terminal text; with stdin a TTY and stdout not, it also refuses.
  - With no markers and both TTYs, `say "hello"` in a room with one agent thread replies in that thread: the posted envelope (decrypted from the relay) has `from.agent: "human"`, `via: "cli"`, the room's member, `kind: "answer"`, `replyTo` the latest message, and the output names the thread.
  - `say` with two threads replies to the one with the highest-seq message.
  - `say --new "topic"` starts a thread whose id equals the envelope id, `kind: "question"`.
  - `say --thread <unknown>` fails with the KTD2 text and posts nothing; `--thread` together with `--new` is a usage error; empty text is a usage error.
  - `say` with no history starts a new thread.
  - `say` on a machine with a local queue holding a thread no longer in the relay buffer (relay created with `bufferSize: 2`) resolves `--thread` against the merged history.
  - Covers AE3 (CLI path). `say` with a fake AWS key exits 1 naming the rule, does not print the key, and posts nothing.
  - `approve <thread>` posts `kind: "approve"`, empty body, human from; `approve <unknown>` fails and posts nothing.
  - An MCP session in the same room, at the chain limit for that thread, can send again after `approve` (integration with U6).
  - `say` against a relay that forgot the room deletes the room dir, clears `current`, and prints the run-`up` text.
  - A test reads `packages/cli/src` and asserts that the human builder is referenced only by `say.ts` and `approve.ts`.
- **Verification:** cli tests green; OPEN_QUESTIONS has the dated marker entry with URLs.

### U9. CLI `down` and `up --ttl`

- **Goal:** The creator can close the room from the CLI, and can shorten its max age at creation.
- **Requirements:** R27, R30, R31.
- **Dependencies:** U3, U4, U5.
- **Files:** `packages/cli/src/commands/down.ts`, `packages/cli/src/commands/up.ts`, `packages/cli/src/args.ts`, `packages/cli/src/index.ts`, `packages/cli/test/down.test.ts`, `packages/cli/test/up-join.test.ts`.
- **Approach:**
  1. `down` per KTD22 over `connectOnce` with `closeOnly`.
  2. `up --ttl` parsing and the `maxAgeSec` field per KTD10; the printed expiry line uses the `welcome.expiresAt` the relay returns.
- **Patterns to follow:** `up.ts` flag validation (`--max-chain`), `status.ts` cleanup.
- **Test scenarios:**
  - Creator `down` with a live room: exit 0, a member connection receives `closed`, the room dir is gone, `current` is cleared, and the relay snapshot is undefined.
  - Covers AE4 (non-creator). `down` from a joiner's home exits 1 with the creator-only text and the relay sees no connection (count `conn_open` events before and after).
  - `down` when the relay already forgot the room: exit 0 with a note, local state removed.
  - `down` when the room holds `maxMembers` connections still closes it (close-only admission).
  - `down` with a tampered `closeSecretKey` in `room.json` gets `bad_signature`, exits 1, and keeps local state.
  - `up --ttl 2h` sends `maxAgeSec: 7200` (relay snapshot shows it); `--ttl 30m` sends 1800; `--ttl 0h`, `--ttl 5`, `--ttl 1d` are usage errors.
- **Verification:** cli tests green.

### U10. CLI `export`

- **Goal:** A human can take a durable copy of a thread or the room, including as a GitHub issue body, without message text ever reaching a shell command line.
- **Requirements:** R28, R29.
- **Dependencies:** U8 (guard).
- **Files:** `packages/cli/src/commands/export.ts`, `packages/cli/src/args.ts`, `packages/cli/src/index.ts`, `packages/cli/test/export.test.ts`, `docs/ARCHITECTURE.md`, `docs/UX.md`.
- **Approach:**
  1. Load history with `replayQueue` (KTD23); no relay connection.
  2. Render markdown per KTD23; `md` to stdout.
  3. `gh-issue`: write the temp file and print the single-quoted command per KTD23, plus a line saying the file holds decrypted messages and where it is.
- **Patterns to follow:** `stripControl` from `protocol` for header fields; `install.ts` for writing files with explicit modes.
- **Test scenarios:**
  - `export` with a queue of two threads prints both threads in seq order, omits presence, labels human messages `(human)`, and fences each body.
  - A body containing a run of five backticks is fenced with six or more.
  - `export --thread T` prints only T; an unknown thread exits 1.
  - Covers AE8. A body containing `$(touch pwned)`, a backtick command and `'; rm -rf ~; '`: `--format gh-issue` writes `issue.md` (mode 0600, directory 0700, under the temp root), the printed command contains none of the body text, and running it through `/bin/sh -c` with a fake `gh` script on `PATH` records `--title`, `agentroom export <date>`, `--body-file`, and the path, while no `pwned` file appears in the test's cwd.
  - The printed command quotes a temp path containing a single quote correctly (inject the temp root through the context or an option for this test).
  - With `CLAUDECODE=1`, or with stdin not a TTY, `export` refuses and writes nothing.
  - With no room directory, `export` exits 1 with the no-local-history text.
- **Verification:** cli tests green; no test runs the real `gh`.

### U11. Conformance: close, expiry, chain limit, scanner, marker

- **Goal:** Prove the M2 acceptance criteria with real processes against the relay factory.
- **Requirements:** R32; M2 acceptance in `docs/PLAN.md`; invariants 1, 2, 4.
- **Dependencies:** U6-U10.
- **Files:** `tests/conformance/test/close-expiry.test.ts`, `tests/conformance/test/two-agents.test.ts`.
- **Approach:**
  1. The new file builds its own relay through a factory that accepts options (`now`, short sweep, small `maxAgeSec`), keeping M1 KTD1's pluggable-relay shape, and captures relay log events.
  2. Close scenario: `up` (alice) and `join` (bob) through the built CLI, two MCP children, then `down` from alice's home.
  3. Expiry scenario in a second room with a short max age and the injected relay clock.
  4. In `two-agents.test.ts`, add chain-limit, scanner and marker scenarios to the existing room, sealing human `approve` envelopes in the test (as M1 seals carol's message) because `say` cannot run without a TTY.
- **Test scenarios:**
  - Covers AE4. After alice's `down`, both MCP children answer `inbox` with the closed text, both room dirs are gone, `join <code>` from a third home prints the room-gone message, and a create `hello` for the same id gets `room_expired`.
  - Covers AE7. With continuous activity, advancing the relay clock past max age makes both MCP children report the expiry text and delete their room dirs.
  - Bob's `send` in a thread where alice and bob have posted three agent messages is refused with the per-thread text; after the test injects a human `approve`, it succeeds.
  - A `send` with a fake AWS key over stdio returns `isError` naming the rule, and the relay buffer is unchanged.
  - `agentroom say "hi"` spawned with `CLAUDECODE=1` exits non-zero with the marker text and the relay buffer is unchanged.
  - Every captured relay log event and the final snapshot contain no marker, member name, secret, close signature or blob, across create, put, close and expiry.
  - Every stored envelope from the MCP children has a non-human agent and `via: "mcp"`.
- **Verification:** `pnpm -r build && pnpm -r test` runs both conformance files green in under 60 s and leaves no child processes.

### U12. README threat model and usage

- **Goal:** Users and the client can see exactly what agentroom protects and what it does not.
- **Requirements:** R33.
- **Dependencies:** U11 (documents shipped behavior).
- **Files:** `README.md`.
- **Approach:**
  1. A "Threat model" section with short subsections: what the relay sees (room id, ciphertext sizes and timing, connection counts, the close public key, TTLs; never plaintext, names or the secret); what any member can do (read everything, post under any display name, run until expiry); human tags (the MCP server never emits them; CLI `say`/`approve` and the M3 hook stop accidental impersonation only, because an agent running as the same OS user can read `room.json` and forge any tag); chain limits (per sender, at most one overshoot per concurrent sender); secret scanning (pattern-based, blocks not redacts, can miss secrets); refs-only (an instruction to agents, not an enforced control; a body can carry 8 000 characters of code); share-code leakage (anyone with the code is a member until the room closes or expires; run `down` if it leaks); what the relay can still do (drop, delay, replay, reorder).
  2. Usage gains `say`, `approve`, `down`, `export`, `up --ttl`; Status line names M2.
- **Test expectation:** none -- documentation only.
- **Verification:** Every claim in the section matches a tested behavior or a documented non-goal in this plan.

---

## Verification Contract

| Gate | Command | Applies |
|---|---|---|
| Install | `pnpm install` (lockfile committed only if a dependency changes; none is planned) | all |
| Build | `pnpm -r build` | all |
| Typecheck (after build, M0 KTD2) | `pnpm typecheck` | all |
| Lint and format | `pnpm lint` | all |
| Tests | `pnpm -r test` | all; U11 needs build first |
| Node 20 | the same build and test sequence once under Node 20.19+ before calling M2 done (regex flags, libsodium) | all |
| Isolation | tests never write outside `os.tmpdir()`, never run the real `claude` or `gh`, and fake TTYs through `CliContext` | U5-U11 |

The tree is green after every unit: each unit lands with its tests and the full gate sequence passes before the next starts.

M2 acceptance from `docs/PLAN.md`, mapped to proof:

| Acceptance | Proof |
|---|---|
| Relay logs show only ciphertext | U3, U4 invariant 1 tests; U11 log-capture scenario |
| An agent cannot exceed the chain limit | U1 unit tests; U6 AE1, AE2 and restart tests; U11 two-process scenario |
| A fake AWS key in a message is blocked | U2 rule tests; U6 MCP path; U8 CLI path; U11 stdio path |
| An agent running `agentroom say` from its shell fails | U8 marker and TTY tests; U11 spawned `say` with `CLAUDECODE=1` |
| The MCP server has no code path that emits `agent: "human"` | M1 source guard and runtime guard, extended over U5-U7 files; U7 draft test; U11 stored-envelope check |

## Definition of Done

- Every Verification Contract gate passes with real output reported, including one Node 20 run.
- R1-R33 hold and AE1-AE8 each have a passing test.
- Invariant regression tests exist and pass: 1 (relay state and logs, including close and limits), 2 (source guard, runtime guard, draft `via`, CLI-only human builder), 3 (chain limit, thread rules, room-wide counter), 4 (scanner per sender path), 5 (`room_status` thread block), 7 (room dir and `pending.json` deleted on close and expiry; export only by explicit CLI command).
- `docs/ARCHITECTURE.md`, `docs/UX.md`, `docs/OPEN_QUESTIONS.md` and `README.md` reflect the Documentation Plan. `docs/PLAN.md` and `docs/LOG.md` are unchanged by this work.
- No placeholder tests, no leftover experiment code, no unused exports (the empty `sendPolicy` hook is gone), no new dependencies.
- No secret-shaped string committed (KTD5), no telemetry, no network calls other than to the configured relay.

## Open Questions

Deferred to humans; none block implementation.

- Should a leaked share code have a faster remedy than `down` plus a new room, such as rotating the room key? Out of v0 scope; the README tells users to `down` and `up` again.
- Should the Claude Code check key on `CLAUDE_CODE_CHILD_SESSION` instead of `CLAUDECODE`? Claude Code's docs say IDE extensions set `CLAUDECODE` in integrated terminals, so this plan's guard refuses a human typing `agentroom say` in a VS Code terminal with the extension installed. The plan keeps `CLAUDECODE` because `CLAUDE.md` invariant 2 and the M2 acceptance name it. The alternative refuses on `CLAUDE_CODE_CHILD_SESSION` always and on `CLAUDECODE` only without a TTY, which keeps the Bash tool blocked and lets IDE terminals through. Until decided, users in those terminals can run `say` from a standalone terminal.
- Should `export` also require a stdout TTY like `say`? This plan allows `export > file.md` and relies on the marker check and a stdin TTY (KTD18).
