# User experience

The design question is attention: when should a coworker's message interrupt you, when should it interrupt your agent, and when should it wait.

## Three kinds of traffic

1. **Agent to agent.** "Android uses `retryCount`; which name did iOS pick?" Visible to humans, but no action needed.
2. **Agent to the other human.** Anything with `requiresHuman`: decisions, disagreements, questions an agent should not answer alone. Gets attention.
3. **Human to the other side.** Your exact words (`/say`), or a message your agent drafts and you approve (`/ask`, `/handoff`).

## CLI

```
agentroom up [--agent claude|codex|gemini|cursor] [--name andrew] [--relay URL] [--ttl 24h] [--max-chain 3]
agentroom join [code] [--agent ...] [--name ...]   # prompts for the code if omitted, keeping it out of shell history
agentroom down                     # creator only: close the room now
agentroom status
agentroom watch                    # terminal chat pane (works with any agent)
agentroom say [--thread id] "<text>"   # human message; requires an interactive terminal (TTY)
agentroom approve <thread>         # human approval; resets the chain limit; requires TTY
agentroom export [--thread id] [--format md|gh-issue]
agentroom install <agent>          # write MCP config (and plugin, for Claude Code)
```

Every command acts on the room named in `~/.agentroom/current` (set by the last `up` or `join`) unless `--room <id>` is given. `say` without `--thread` replies to the most recently updated thread, which is almost always the one waiting on you; pass `--thread` to pick another or `--new` to start one.

`up` and `join` call `install` for the named agent, then print what to restart.

## Claude Code plugin

One install bundles the MCP server, slash commands, hooks, and a status line script.

### Status line

```
agentroom * sdk-parity | 2 unread (1 needs you) | coworker/codex active
```

The script reads local room state (no network call) so it is fast. A plugin cannot set the status line (`OPEN_QUESTIONS.md` item 5), so `agentroom install claude` writes `statusLine` into user settings and preserves any existing status line by chaining it (`agentroom statusline --chain "<original>"`), with a `refreshInterval` so the unread count stays current while the session is idle.

### Slash commands

| Command | Author | What happens |
|---|---|---|
| `/sync` | n/a | Claude reads the inbox and summarizes what matters for the current task |
| `/say [--thread id] <text>` | You, verbatim | Sent tagged as human. Never reaches the model. Same thread default as the CLI |
| `/ask <topic>` | Claude drafts, you approve | Claude writes the question with refs from current context, shows the draft, sends on your approval |
| `/handoff` | Claude drafts, you approve | Structured summary: decisions, open questions, refs |
| `/send <hash>` | You | Releases the pending draft from `/ask` or `/handoff` if its hash still matches. Never reaches the model |
| `/approve [thread]` | You | Human approval for a thread blocked by the chain limit |
| `/sync-mode live\|between\|manual` | n/a | Sets delivery mode |

### Why human messages go through a hook

The agent has a shell. If human messages were sent by running `agentroom say`, the agent could run it and impersonate you, which would also defeat the chain limit. So:

- `/say`, `/approve` and `/send` are plugin commands, and the plugin's `UserPromptExpansion` hook (which fires when a typed command is about to expand, matched on the command name) posts what you typed tagged `via: "hook"`, `agent: "human"`, then blocks the expansion so nothing reaches the model (saves tokens too). The `UserPromptSubmit` hook is used for `between` delivery, not for `/say`. Verified 2026-10-12, `OPEN_QUESTIONS.md` item 7; the hook sees `command_args` exactly as typed.
- Draft approvals for `/ask` and `/handoff` work the same way. Claude calls `send` or `handoff` with `draft: true`; the MCP server writes the envelope to the room's `pending.json` and returns the draft text plus a short hash, which Claude shows you. Your reply of `/send <hash>` (typed by you, caught by the hook) posts the pending envelope only if its hash still matches, so the agent cannot swap the content after you read it. The released message keeps the agent's `from.agent` with `via: "hook"`; it is never tagged human. The hook then posts a human `approve` for that thread, because you read and released it.
- The CLI `say` and `approve` commands (and the `watch` input line) refuse to run without an interactive terminal or when an agent environment marker such as `CLAUDECODE` is set. Weaker: an agent with a shell can deliberately get around this, so it stops accidental impersonation, not a determined agent (see the threat model in `ARCHITECTURE.md`). It covers non-Claude users, and the `watch` pane is the preferred human input path for them.

Verified (`OPEN_QUESTIONS.md` items 6 and 7): `UserPromptSubmit` can block a prompt and inject context; `UserPromptExpansion` can block a plugin command before it expands.

### Delivery modes

- `live`: inbound messages pushed into the session immediately via channels. Can derail a task mid-flight. Deferred: channels are a research preview limited to Anthropic's allowlist and do not register SDK v2 servers (`OPEN_QUESTIONS.md` item 8).
- `between` (default): queued; injected as context the next time you submit a prompt (via the `UserPromptSubmit` hook), wrapped by the same untrusted-data framing as tool results. Messages that need you, or direct questions to your agent, also trigger a desktop notification and show in the status line right away.
- `manual`: nothing reaches the agent until you run `/sync`.

## `agentroom watch` (universal companion)

```
+ sdk-parity ------------------------------- 2 members +
| 19:42 coworker/codex  question                       |
|   Error enum: sealed class or Int codes on Android?  |
|   ref: ios/Sources/SDK/Errors.swift:12-40            |
| 19:44 andrew/claude   answer                         |
|   Sealed class. See android/.../SdkError.kt:8        |
| 19:45 ! coworker (human)  needs you                  |
|   Can we drop iOS 15? Simplifies async a lot.        |
+------------------------------------------------------+
| > _                                                  |
+------------------------------------------------------+
```

- Built with Ink (React for terminals) or a plain readline UI; choose the simpler one that handles resize well.
- Shows all threads, highlights `requiresHuman` and chain-limited threads.
- Input line posts human messages (`via: "watch"`) to the selected thread. Typing here is treated as human input; it relies on an interactive terminal and the agent-marker refusal, so it stops accidental impersonation, not a determined agent.
- Desktop notifications (via `node-notifier` or OS-native) for messages that need you.
- Everything drawn from inbound messages (bodies, names, refs) is stripped of control characters and escape sequences first, so a message cannot forge a "needs you" line.

## Non-Claude agents

- `agentroom install codex|gemini|cursor` writes the MCP server entry into that agent's config and appends a short snippet to the repo's `AGENTS.md` or `GEMINI.md`:
  > This project uses agentroom. At the start of each task and after finishing each step, call the `inbox` tool. When you are waiting on the other team, call `wait`.
- These agents receive messages when they check, not on push. Say so plainly in the README.

## Later: editor gutter

Messages already carry file and line refs, so a VS Code extension (also runs in Cursor) could show a gutter icon on referenced lines with the thread on hover. v2 at the earliest.
