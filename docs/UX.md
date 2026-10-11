# User experience

The design question is attention: when should a coworker's message interrupt you, when should it interrupt your agent, and when should it wait.

## Three kinds of traffic

1. **Agent to agent.** "Android uses `retryCount`; which name did iOS pick?" Visible to humans, but no action needed.
2. **Agent to the other human.** Anything with `requiresHuman`: decisions, disagreements, questions an agent should not answer alone. Gets attention.
3. **Human to the other side.** Your exact words (`/say`), or a message your agent drafts and you approve (`/ask`, `/handoff`).

## CLI

```
agentsync up [--agent claude|codex|gemini|cursor] [--name andrew] [--relay URL] [--ttl 24h] [--max-chain 3]
agentsync join <code> [--agent ...] [--name ...]
agentsync down                     # creator only: close the room now
agentsync status
agentsync watch                    # terminal chat pane (works with any agent)
agentsync say "<text>"             # human message; requires an interactive terminal (TTY)
agentsync approve <thread>         # human approval; resets the chain limit; requires TTY
agentsync export [--thread id] [--format md|gh-issue]
agentsync install <agent>          # write MCP config (and plugin, for Claude Code)
```

`up` and `join` call `install` for the named agent, then print what to restart.

## Claude Code plugin

One install bundles the MCP server, slash commands, hooks, and a status line script.

### Status line

```
agentsync * sdk-parity | 2 unread (1 needs you) | coworker/codex active
```

The script reads local room state (no network call) so it is fast. If a plugin cannot set the status line itself, `agentsync install claude` writes it into settings and preserves any existing status line by chaining it.

### Slash commands

| Command | Author | What happens |
|---|---|---|
| `/sync` | n/a | Claude reads the inbox and summarizes what matters for the current task |
| `/say <text>` | You, verbatim | Sent tagged as human. Never reaches the model |
| `/ask <topic>` | Claude drafts, you approve | Claude writes the question with refs from current context, shows the draft, sends on your approval |
| `/handoff` | Claude drafts, you approve | Structured summary: decisions, open questions, refs |
| `/approve [thread]` | You | Human approval for a thread blocked by the chain limit |
| `/sync-mode live\|between\|manual` | n/a | Sets delivery mode |

### Why human messages go through a hook

The agent has a shell. If human messages were sent by running `agentsync say`, the agent could run it and impersonate you, which would also defeat the chain limit. So:

- A `UserPromptSubmit` hook inspects what you typed. If it starts with `/say` or `/approve`, the hook posts it tagged `via: "hook"`, `agent: "human"`, and blocks the prompt from reaching the model (saves tokens too).
- Draft approvals for `/ask` and `/handoff` work the same way: Claude writes the draft to a pending file; your reply of `/send` (typed by you, caught by the hook) releases it.
- The CLI `say` and `approve` commands (and the `watch` input line) refuse to run without an interactive terminal or when an agent environment marker such as `CLAUDECODE` is set. Weaker: an agent with a shell can deliberately get around this, so it stops accidental impersonation, not a determined agent (see the threat model in `ARCHITECTURE.md`). It covers non-Claude users, and the `watch` pane is the preferred human input path for them.

Verify that `UserPromptSubmit` hooks can block a prompt and that a plugin can register slash commands that the hook intercepts (`OPEN_QUESTIONS.md`).

### Delivery modes

- `live`: inbound messages pushed into the session immediately via channels. Can derail a task mid-flight.
- `between` (default): queued; injected as context the next time you submit a prompt (via the `UserPromptSubmit` hook). Messages that need you, or direct questions to your agent, also trigger a desktop notification and show in the status line right away.
- `manual`: nothing reaches the agent until you run `/sync`.

## `agentsync watch` (universal companion)

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
- Input line posts human messages (`via: "watch"`). Typing here is proof of a human.
- Desktop notifications (via `node-notifier` or OS-native) for messages that need you.

## Non-Claude agents

- `agentsync install codex|gemini|cursor` writes the MCP server entry into that agent's config and appends a short snippet to the repo's `AGENTS.md` or `GEMINI.md`:
  > This project uses agentsync. At the start of each task and after finishing each step, call the `inbox` tool. When you are waiting on the other team, call `wait`.
- These agents receive messages when they check, not on push. Say so plainly in the README.

## Later: editor gutter

Messages already carry file and line refs, so a VS Code extension (also runs in Cursor) could show a gutter icon on referenced lines with the thread on hover. v2 at the earliest.
