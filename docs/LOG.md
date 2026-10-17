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

## 2026-10-12: M3 Claude Code plugin and humans

Completed (commits `5f40e0b`..`581ea11`):
- `plugins/claude-code`: manifest, `.mcp.json`, `hooks/hooks.json`, seven `/agentroom:*` skills (`sync`, `say`, `ask`, `handoff`, `send`, `approve`, `sync-mode`), launcher, repo-root marketplace. `claude plugin validate` passes.
- CLI: `hook prompt-expansion` (posts `/agentroom:say` and `/agentroom:approve` as human, blocks the expansion), `hook prompt-submit` (`between` delivery framed with `frameInbound`, bound to `projectDir`, under a file lock), `/agentroom:send` draft release with three checks, `sync-mode`, `statusline --chain`, `install claude` (plugin install, chained status line saved to `claude-install.json`) and `uninstall claude`, `watch` pane (pure model and renderer, readline driver, human guard).
- MCP: no-room stub, current-room default, hook read-record pickup, `waitingOnHuman` and `roomName` in `status.json`, desktop notifications (osascript or notify-send, arguments only, claimed once per room, `AGENTROOM_NOTIFY=off`).
- Review: three bugs fixed (watch selection pinned by thread id; install no longer loses the original status line; two flaky or weak tests), dead exports removed.

Test status (orchestrator's own run):
```
packages/protocol test:    Tests  127 passed (127)
packages/relay-node test:  Tests   30 passed (30)
packages/mcp test:         Tests   82 passed (82)
packages/cli test:         Tests  136 passed (136)
tests/conformance test:    Tests   17 passed (17)
typecheck: Done (5 packages); biome: Checked 127 files. No fixes applied.
claude plugin validate plugins/claude-code: Validation passed
```

Decisions and open items:
- "Own" messages are currently any non-human message from the same member name. Two members with the same OS username (devcontainers: `dev`, `vscode`) would hide each other's agent messages. Decision: track own-post ids (session posts plus local hook and CLI posts recorded in `queue.jsonl`) instead of matching on member name; scheduled as the first M4 unit.
- Unverified against a live Claude Code session: whether `command_name` arrives as `say` or `agentroom:say` (the hook accepts both), hook ordering between `UserPromptExpansion` and `UserPromptSubmit`, and the exit code of a repeated `claude plugin install`. First real use should check these.
- Rooms created before M3 have no `projectDir` and get no `between` delivery.

Next: M4 agent-doable parts (adapters, relay-cf, README).

## 2026-10-12: M4 agent-doable parts, review, and first E2E with real agents

Completed (commits `6fd9ba2`..`7a6ea52`):
- Codex, Gemini CLI and Cursor adapters (`install`/`uninstall`, user or `--project` scope, AGENTS.md/GEMINI.md note); room rules sent as MCP instructions; own posts tracked by envelope id.
- `relay-cf`: Durable Object relay on the shared `relay-core`, passing the same wire conformance suite as relay-node (run locally on workerd).
- README: "Try it now (from source)" path (local relay, separate `AGENTROOM_HOME` per side, two-machine relay options), npx quickstart labeled as post-publish, threat model and status refreshed.
- M4 code review: 12 fixes (TOML/JSON config editing that could drop or duplicate a user's server tables, symlinked and 0600 config files, marker pairing, a relay-cf closer and alarm race, an `ENOTEMPTY` race in `down`, `readQueueTail` reading the whole queue per message).
- E2E finding fixed: `room_status` now lists the 10 most recent threads, so an agent can reply in a thread after `inbox` marked it read.

Test status (after `7a6ea52`): protocol 138, relay-node 30, mcp 91, cli 164, conformance 42, all passed; typecheck clean; biome "Checked 147 files. No fixes applied."

E2E with two real headless Claude Code agents (Sonnet), local relay-node, separate `AGENTROOM_HOME` and project dir per side, MCP via `--mcp-config` (no plugin install):
- Question from A, answer from B in the same thread, answer received by A and treated as information: pass.
- Fresh A session found the thread via `room_status` and replied in it: pass (after `7a6ea52`).
- Chain limit: fourth consecutive agent message refused with the "needs a human" error naming `say`/`approve`: pass.
- Secret scanner blocks a well-formed AWS key id (`AKIA` + 16 base32 chars): pass. A malformed id containing `9` is not matched, which is correct for real AWS ids.
- `agentroom say` with `CLAUDECODE=1` refuses (exit 1): pass.
- Relay log holds room ids and counts only; no plaintext: pass.

Follow-ups:
- The E2E agent said `room_status` showed no preview text, though previews are in the framed text block. Check whether Claude Code shows `structuredContent` instead of the text content; if so, the text block (and its previews) is invisible to Claude Code.
- Not yet exercised with real agents: the Claude Code plugin path (`install claude`, hooks, `/agentroom:*`), Codex, Gemini CLI, Cursor, and relay-cf deployed on Cloudflare.

Waiting on Andrew:
- ~~Deploy a relay and set the default relay URL.~~ Done 2026-10-17: relay-cf deployed to `wss://agentroom-relay.sauerapple.workers.dev` (smoke-tested with `up`/`join`/`status`/`down`) and set as the CLI default.
- Real two-person test with the coworker (M1 and M3 acceptance) and the manual pre-release checklist with Codex and Gemini (`docs/RELEASE_CHECKLIST.md`).
- Create the GitHub repo (fill in the README clone URL), record the demo GIF, publish `agentroom` to npm, tag v0.1.0.
