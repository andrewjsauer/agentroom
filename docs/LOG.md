# Build log

Newest entry last. Each entry: what was completed, real test output, decisions, what's next.

## Waiting on Andrew

- Create the GitHub org/repo `agentroom` and push `main`; confirm the CI workflow goes green on Node 20 and 22.
- Deploy `relay-node` somewhere reachable over TLS for the real two-person test (M1).
- The real two-person test (M1 human acceptance).
- Publish to npm (M4). The name `agentroom` was free on npm on 2026-10-11.
- Client-contract check (`OPEN_QUESTIONS.md` item 14).
- Decide whether to keep Node 20 in the support matrix: it reached end of life in April 2026; keeping it pins vitest to v3 (vitest 5 needs Node 22.12+).

## 2026-10-11: docs review, rename, M0

Completed:
- Initial docs committed. Design review (coherence, feasibility, security-lens reviewers) applied 29 raw findings merged to about 20 fixes; see commit `6985cb3` for the list. The biggest: creation and joining are distinct relay operations with the creator's Ed25519 close key pinned in plaintext at creation; room settings travel in an encrypted `meta` blob; chain limit derives `thread` from `replyTo`, ignores presence and adds a room-wide counter; a local process model where the MCP server owns a per-room session cache; `export` is CLI-only; inbound framing is nonce-tagged and escaped on every delivery path; secret scanning runs for every sender; drafts release by hash and are never tagged human.
- Renamed `agentsync` to `agentroom` (taken on npm and as a GitHub org). Repo directory keeps the old name locally.
- `OPEN_QUESTIONS.md` items 1, 2, 3, 15 answered with dates and URLs. MCP TypeScript SDK is on v2 (`@modelcontextprotocol/server` 2.3.1, zod v4); `CLAUDE.md` stack line updated.
- M0 scaffold: pnpm workspace, four skeleton packages, Biome, vitest 3, tsup, TypeScript 5, Apache-2.0, CI workflow. Simplify pass changed nothing; review pass confirmed no findings.

Test status (orchestrator's own run, Node 26; the builder also ran build and test under Node 20.20.2):
```
packages/{protocol,relay-node,mcp,cli} build: ESM Build success / DTS Build success
packages/relay-node test:  Test Files  1 passed (1)
packages/mcp test:         Test Files  1 passed (1)
packages/protocol test:    Test Files  1 passed (1)
packages/cli test:         Test Files  1 passed (1)
packages/* typecheck: Done
biome check .  ->  Checked 23 files in 3ms. No fixes applied.
```

Decisions:
- Cross-model review passes were skipped: the only configured external route could read the checkout (including `.env`) and the run is unattended.
- M0 packages declare no runtime dependencies; verified pins for M1 are recorded in the M0 plan (KTD6).
- `engines.node >=20.19` because vitest 3 resolves vite 7.

Next: M1 (core loop, encrypted).

## 2026-10-11: M1 core loop, encrypted

Completed (commits `1852c5a`..`9d2dceb`):
- `protocol`: Envelope, wire and meta schemas; ULID (own 21-line implementation); `ar1_` share codes with strict parse; HKDF via `node:crypto`; XChaCha20-Poly1305 seal/open with room_id as associated data; Ed25519 close keypair; `frameInbound` with per-call random tag suffix and escaping.
- `relay-node`: `startRelay`, create-vs-join `hello`, 500-envelope buffer, seq, `since` resume, presence counts, 64 KiB limit, idle expiry, `close` rejected until M2, no-plaintext test.
- `mcp`: state store under `AGENTROOM_HOME` (`room.json` 0600, append-only `queue.jsonl`, `status.json`, `current`), reconnecting relay client with resume and one-shot mode, session with `room_status`, `send`, `inbox`, `wait` (abort-aware), structural invariant-2 guard plus a source-scan test, expiry teardown, stdio runner that exits when stdin closes.
- `cli`: `up`, `join` (TTY prompt when the code is omitted), `status`, `mcp`, `install claude` (`claude mcp add --scope user` or a project `.mcp.json` fallback), `agentroom` bin; CLI parsing with `node:util.parseArgs` (commander 15 needs Node 22.12+).
- `tests/conformance`: two real `agentroom mcp` processes over stdio against an in-process relay: presence, question and answer, resume after a forced disconnect, no plaintext in the relay, `room_status` framing.

Test status (orchestrator's own run):
```
packages/protocol test:    Test Files  7 passed (7)   Tests  67 passed
packages/relay-node test:  Test Files  1 passed (1)   Tests  18 passed
packages/mcp test:         Test Files  4 passed (4)   Tests  36 passed
packages/cli test:         Test Files  6 passed (6)   Tests  28 passed
tests/conformance test:    Test Files  1 passed (1)   Tests   6 passed
packages/* and tests/conformance typecheck: Done
biome check .  ->  Checked 66 files in 10ms. No fixes applied.
```

Decisions:
- The M1 build was interrupted twice by an Opus usage cap; U7-U10 were finished on a resumed run. From here on every subagent runs on Opus 5.5 (orchestrator prompt rule).
- `install claude` writes `node <abs path to dist/bin.js>` when running from a checkout and `npx -y agentroom` only from an installed package, because the npm name is not published yet (plan KTD15).
- Default relay URL is a placeholder constant until a relay is deployed; `AGENTROOM_RELAY` and `--relay` override it.
- relay-node keeps everything in memory, so a redeploy ends every room; avoid redeploying mid-session during the human test.

Next: M2 (safe to use).

## 2026-10-12: M1 review, M2 safe to use

Completed:
- M1 code review: five fixes (idle rooms expire on access, wider invariant-2 source scan, `join` prompt ends on EOF, usage text, test name).
- M2 (commits `a66c033`..`bfbd2b3`): chain limit and secret scanner in `protocol`; signed creator-only `close` with close-only `hello`, tombstones, max age, rate limit and connection cap in `relay-node`; chain policy, room meta, `handoff`, drafts to `pending.json`, `agentroom-rules` prompt and closed/expired teardown in `mcp`; human-terminal guard, `say`, `approve`, `down`, `up --ttl`, `export` (md and gh-issue via `--body-file`) in `cli`; conformance tests for close, expiry, chain limit, scanner and the agent marker; README threat model. Review pass applied 23 findings (efficiency, reuse, dead exports, and test strength) and found no new defects.
- Open questions 4-12 and 16 answered with dates and URLs (Claude Code plugin manifest, status line, `UserPromptSubmit` and `UserPromptExpansion` hooks, channels, Codex, Gemini, Cursor, Durable Object hibernation and alarms). UX.md updated: `/say` is intercepted by `UserPromptExpansion`, the status line is set through settings, `live` delivery is deferred.
- M3 plan written and reviewed (`docs/plans/2026-10-12-0719-feat-m3-claude-code-plugin-plan.md`).

Test status (orchestrator's own run):
```
packages/protocol test:    Tests  125 passed (125)
packages/relay-node test:  Tests   30 passed (30)
packages/mcp test:         Tests   67 passed (67)
packages/cli test:         Tests   62 passed (62)
tests/conformance test:    Tests   11 passed (11)
packages/* and tests/conformance typecheck: Done
biome check .  ->  Checked 88 files. No fixes applied.
```

Decisions:
- Close-only connections are bounded at two per room, oldest evicted, rather than refused: a refusing cap would let a leaked share code lock the creator out of `down`.
- `/say`, `/approve`, `/send` are plugin skills invoked as `/agentroom:<name>`; the plugin's `UserPromptExpansion` hook posts and blocks the expansion. `live` delivery via channels is deferred (research preview, allowlist-only, does not register SDK v2 servers).
- Rooms are bound to the project directory they were opened in (`projectDir` in `room.json`); the `between` hook delivers only to sessions inside it.
- `stripControl` also strips bidi overrides and isolates.
- Agent markers that refuse `say`/`approve`/`export`: `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `AI_AGENT`, `CODEX_THREAD_ID`, `CODEX_CI`, `CODEX_SANDBOX`, `GEMINI_CLI`, `CURSOR_AGENT` (`OPEN_QUESTIONS.md` item 17). Open: `CLAUDECODE` also blocks a human typing in a Claude Code IDE terminal.

Next: M3 (Claude Code plugin and humans).
