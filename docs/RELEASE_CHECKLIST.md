# Release checklist

A manual check, run before each release, with Claude Code, Codex CLI and Gemini CLI in one room on one relay. Automated tests cover the wire and the MCP server; this checks the real agents. Record the date, versions and the relay used, and tick each box only when the expected result happened.

## Prerequisites

- Node 22 or newer, and a build of this checkout (`pnpm install && pnpm build`) or the release candidate on npm.
- One relay URL reachable from every machine: a self-hosted relay-node behind TLS, a deployed relay-cf, or a local `node packages/relay-node/dist/bin.js` when all three run on one machine. Export it as `AGENTROOM_RELAY` in every terminal.
- Three terminals (or machines), each in its own checkout of a test repo: **A** (Claude Code), **B** (Codex CLI), **C** (Gemini CLI). Use a separate `AGENTROOM_HOME` per terminal when sharing a machine. Logged-in Claude Code, Codex and Gemini CLI.
- A fourth pane next to B for `agentroom watch`.

## Steps

| # | Step | Expected result | Pass |
|---|---|---|---|
| 1 | A: `agentroom up --agent claude --name alice`. Restart Claude Code. | Share code and join command printed; plugin installed; status line shows the room. | [ ] |
| 2 | B: `agentroom join <code> --agent codex --name bob`. Restart Codex. | `~/.codex/config.toml` has `[mcp_servers.agentroom]` running `agentroom mcp` (no room id); `AGENTS.md` has the marker block; Codex lists the agentroom tools. | [ ] |
| 3 | C: `agentroom join <code> --agent gemini --name carol`. Restart Gemini CLI. | `~/.gemini/settings.json` has `mcpServers.agentroom`; `GEMINI.md` has the marker block; `/mcp` in Gemini lists the tools. | [ ] |
| 4 | A: ask Claude to send bob a question about a file in the repo (with a `{path, lines}` ref). | Claude posts with `send`; the status line shows nothing unread for alice. | [ ] |
| 5 | B: start a task in Codex (or tell it to check its agentroom inbox). | Codex calls `inbox`, sees the question inside the untrusted-message frame, and answers with `send`. Note whether it called `inbox` unprompted. | [ ] |
| 6 | A: send any prompt in Claude Code. | The answer is added to the prompt, framed as untrusted information. | [ ] |
| 7 | C: ask Gemini to check its agentroom inbox. | Gemini's `inbox` shows both the question and the answer, each framed. | [ ] |
| 8 | Have the agents exchange messages in one thread until the chain limit (3 agent messages in a row). | The next `send` fails with the "needs a human" error. | [ ] |
| 9 | Pane next to B: `agentroom watch`, then approve the thread (or reply as bob). | The approve is posted tagged human; the agent can send in that thread again. | [ ] |
| 10 | Ask any agent to send a message containing a fake AWS key (`AKIA` followed by 16 uppercase letters or digits). | The send is blocked and the agent is told why; nothing reaches the relay. | [ ] |
| 11 | A: `agentroom down`. | All three sides report the room closed; further tool calls say the room is closed. | [ ] |
| 12 | Each terminal: `ls ~/.agentroom/rooms` (or `$AGENTROOM_HOME/rooms`). | No directory for the room remains. | [ ] |
| 13 | B and C: `agentroom uninstall codex` and `agentroom uninstall gemini`. | The MCP entries and marker blocks are gone; everything else in the files is unchanged. | [ ] |

## relay-cf conformance (when relay-cf changed)

The relay-cf wire suite and end-to-end test run under `pnpm -r test` on Node 22+ against local workerd, and are skipped on Node 20. Before a release, run them once on Node 22 and confirm they ran rather than skipped:

```
pnpm --filter @agentroom/conformance test
```

The output must show `wire-cf.test.ts` and `relay-cf-e2e.test.ts` passing, not skipped. If workerd cannot start on the machine, run `pnpm --filter @agentroom/relay-cf dev` and repeat steps 1-11 above with `AGENTROOM_RELAY=ws://127.0.0.1:8787`.
