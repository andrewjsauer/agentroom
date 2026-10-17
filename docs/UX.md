# User experience

The design question is attention: when should a coworker's message interrupt you, when should it interrupt your agent, and when should it wait.

## Three kinds of traffic

1. **Agent to agent.** "Android uses `retryCount`; which name did iOS pick?" Visible to humans, but no action needed.
2. **Agent to the other human.** Anything with `requiresHuman`: decisions, disagreements, questions an agent should not answer alone. Gets attention.
3. **Human to the other side.** Your exact words (`/agentroom:say`), or a message your agent drafts and you approve (`/agentroom:ask`, `/agentroom:handoff`).

## CLI

```
agentroom up [--agent claude|codex|gemini|cursor] [--name andrew] [--relay URL] [--ttl 24h] [--max-chain 3]   # --max-chain: 1 to 10
agentroom join [code] [--agent ...] [--name ...]   # prompts for the code if omitted, keeping it out of shell history; prints the room's agent chain limit
agentroom down                     # creator only: close the room now
agentroom status
agentroom watch                    # terminal chat pane (works with any agent)
agentroom say [--thread id | --new] "<text>"   # human message; requires an interactive terminal (TTY)
agentroom approve <thread>         # human approval; resets the chain limit; requires TTY
agentroom export [--thread id] [--format md|gh-issue]
agentroom sync-mode [between|manual|live]   # delivery mode for Claude Code (no TTY needed)
agentroom install <agent>          # write MCP config (and plugin plus status line, for Claude Code)
agentroom uninstall claude         # remove the plugin and restore your previous status line
```

Used by the Claude Code plugin, not typed by hand: `agentroom mcp` (serves the current room, or a "no room" stub that says how to start one), `agentroom hook prompt-expansion|prompt-submit`, and `agentroom statusline [--chain <cmd>]`.

Every command acts on the room named in `~/.agentroom/current` (set by the last `up` or `join`) unless `--room <id>` is given. `say` without `--thread` replies to the most recently updated thread, which is almost always the one waiting on you; pass `--thread` to pick another or `--new` to start one. A reply is posted as kind `answer` with `replyTo` set to the latest message in that thread; `--new` (or a room with no messages yet) posts kind `question` and starts a thread whose id is the message id. `--thread` must name a known thread. History comes from the relay's replay merged with the local queue, so `say` works with no MCP server running. `say` and `approve` print the thread id they used (stripped of control characters and escape sequences, since thread ids are peer-chosen). They are the only CLI commands that post `from.agent = "human"` from a shell, always with `via: "cli"` (the plugin hook posts with `via: "hook"` and the `watch` pane with `via: "watch"`), and both refuse when an agent marker is set or stdin or stdout is not a terminal.

`up` and `join` call `install` for the named agent, then print what to restart. `up` and `join` also record the directory they ran in as the room's `projectDir`; Agent sessions started outside it get no room: `agentroom mcp` serves the no-room stub there (even with `--room`, so a user-scope MCP entry does not open the room to every project), there is no `between` delivery, and the status line shows no agentroom segment. The other CLI commands work on `current` from anywhere.

## Claude Code plugin

The plugin lives in `plugins/claude-code/` and bundles the MCP server (`.mcp.json`), seven skills, two hooks (`hooks/hooks.json`) and a launcher (`scripts/agentroom.mjs`) that runs the checkout's built CLI in-process. Every file is a thin wrapper over a CLI subcommand. The repo root has a marketplace file (`.claude-plugin/marketplace.json`), so a checkout installs without publishing:

- `agentroom install claude` (also run by `up`/`join --agent claude`) removes the M1 user-scope MCP registration, runs `claude plugin install agentroom --marketplace <checkout> --scope user`, and writes the status line. Restart Claude Code (or run `/reload-plugins`), then type `/agentroom:sync`.
- Without `claude` on PATH it writes the M1 `.mcp.json`, writes the status line, and prints `claude --plugin-dir <checkout>/plugins/claude-code`.
- From an npm copy of the CLI it keeps the M1 `claude mcp add` registration; the plugin arrives with the npm release (M4).
- `agentroom uninstall claude` restores your previous status line (if it is still ours) and runs `claude plugin uninstall agentroom@agentroom`.

The plugin needs `node` 20.19+ on Claude Code's PATH. Its MCP server serves the room named in `current` when it starts, so after `up` or `join` restart Claude Code (or reconnect the server in `/mcp`); with no room it answers every tool with how to start one.

### Status line

```
Opus | agentroom * sdk-parity | 2 unread (1 need you) | 1 waiting on a human | coworker/codex active
```

`agentroom statusline` reads only local files (`current`, `room.json`, `status.json`, `settings.json`; no network call). The segment is `agentroom * <room name or id prefix> | <u> unread (<n> need you)`, then `<w> waiting on a human` when non-zero, then up to two peers seen in the last 15 minutes (`+k` for more), then `manual` in manual mode; a session outside the room's `projectDir` gets no segment at all, and a closed room shows `agentroom * room closed`. Peer names are stripped of control characters and cut to 24 characters. A plugin cannot set the status line (`OPEN_QUESTIONS.md` item 5), so `agentroom install claude` writes `statusLine` into `<CLAUDE_CONFIG_DIR or ~/.claude>/settings.json`, keeping every other key. An existing status line command is chained: `statusline --chain '<original>'` runs it with the same stdin (2 s timeout) and prints its output first, then ` | ` and the segment. The original object is saved to `~/.agentroom/claude-install.json`; reinstalling recomputes from it (so it is idempotent and repairs a moved checkout), and `uninstall claude` puts it back. `refreshInterval` is the original's or 10 s.

`install claude` (plugin, npm `mcp add`, or `.mcp.json` path alike) also appends `mcp__plugin_agentroom_agentroom__{send,handoff}` and `mcp__agentroom__{send,handoff}` to `permissions.ask` in the same settings file, keeping existing rules and skipping ones already there. Ask rules take precedence over the permission mode, so Claude Code prompts before every post to the room even in `auto` mode (checked on 2026-10-17: without the rule an auto-mode session posted; with it the call was held for permission). `uninstall claude` removes exactly those four entries.

### Slash commands

Plugin skills are namespaced, so the commands are typed as `/agentroom:<name>`. All seven are user-invoked only (`disable-model-invocation: true`).

| Command | Author | What happens |
|---|---|---|
| `/agentroom:sync` | n/a | Claude reads the inbox and summarizes what matters for the current task, flagging `requiresHuman` |
| `/agentroom:say [--thread id \| --new] <text>` | You, verbatim | Sent tagged as human (`via: "hook"`). Never reaches the model. Same thread default as the CLI; internal newlines are kept |
| `/agentroom:ask <topic>` | Claude drafts, you approve | Claude writes the question with refs, calls `send` with `draft: true`, shows the draft and hash |
| `/agentroom:handoff` | Claude drafts, you approve | Structured summary (decisions, open questions, refs) as a draft |
| `/agentroom:send [hash]` | You | No hash: shows the pending draft read from disk. With the hash: releases it if it still matches. Never reaches the model |
| `/agentroom:approve [thread]` | You | Human approval for a thread blocked by the chain limit; no argument picks the most recently updated waiting thread |
| `/agentroom:sync-mode [between\|manual]` | You | Shows or sets the delivery mode; `live` is refused with an explanation |

### Why human messages go through a hook

The agent has a shell. If human messages were sent by running `agentroom say`, the agent could run it and impersonate you, which would also defeat the chain limit. So:

- `/agentroom:say`, `approve`, `send` and `sync-mode` are handled by the plugin's `UserPromptExpansion` hook (`agentroom hook prompt-expansion`), which fires when a typed command is about to expand. It handles `command_name` `agentroom:<name>`, or the bare name only when the typed prompt starts with `/agentroom:<name>`, so a project's own `/approve` still expands. For those commands it always prints one `{"decision":"block","reason":"..."}` and exits 0, on success and on every failure (`Not sent: <cause>`), so the typed text never reaches the model; `hooks.json` sets `onFailure: "block"`, so a crash or timeout blocks too, and each skill body tells Claude that nothing was sent and not to send it itself. Reasons show peer-chosen ids stripped of control characters and cut to 8 characters.
- Hook-origin guard: the hooks run with `CLAUDECODE` set and no TTY, so the CLI guard cannot apply. The expansion hook requires `CLAUDE_PLUGIN_ROOT` (set for plugin hooks, not for Bash tool commands), a non-TTY stdin, `hook_event_name: "UserPromptExpansion"` and `expansion_type: "slash_command"`, and otherwise exits 1 and posts nothing. Like the CLI guard it stops accidental impersonation, not an agent that sets the variable on purpose.
- Draft approvals for `/agentroom:ask` and `/agentroom:handoff` work the same way. Claude calls `send` or `handoff` with `draft: true`; the MCP server writes the envelope to the room's `pending.json` and returns the draft text plus a short hash, which Claude shows you. `/agentroom:send` with no argument shows the stored draft from disk, so you need not trust the model's rendering. `/agentroom:send <hash>` posts the stored envelope unchanged only when the typed hash equals the stored hash, the stored hash equals a fresh hash of the stored envelope, and the envelope is this member's agent draft (`via: "hook"`, not human, not `approve` or `presence`, not already in the room). The released message keeps the agent's `from.agent`; it is never tagged human. The hook then posts a human `approve` for that thread, because you read and released it, and clears `pending.json` (only if it was not replaced meanwhile). Drafts skip the chain limit for that reason: nothing is posted without you. `pending.json` holds one draft; a new draft replaces it, and its hash is the first 12 hex characters of sha256 over the stored envelope.
- The `UserPromptSubmit` hook (`agentroom hook prompt-submit`) never posts: it only reads the queue, frames, and marks read.
- The CLI `say` and `approve` commands (and the `watch` input line) refuse to run without an interactive terminal or when an agent environment marker (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `AI_AGENT`, `CODEX_THREAD_ID`, `CODEX_CI`, `CODEX_SANDBOX`, `GEMINI_CLI` or `CURSOR_AGENT`; see `OPEN_QUESTIONS.md` item 17) is set. Weaker: an agent with a shell can deliberately get around this, so it stops accidental impersonation, not a determined agent (see the threat model in `ARCHITECTURE.md`). It covers non-Claude users, and the `watch` pane is the preferred human input path for them.

Verified (`OPEN_QUESTIONS.md` items 6 and 7): `UserPromptSubmit` can block a prompt and inject context; `UserPromptExpansion` can block a plugin command before it expands.

### Delivery modes

- `live`: inbound messages pushed into the session immediately via channels. Can derail a task mid-flight. Deferred: channels are a research preview limited to Anthropic's allowlist and do not register SDK v2 servers (`OPEN_QUESTIONS.md` item 8).
- `between` (default): queued; injected as `additionalContext` the next time you submit a plain prompt (via the `UserPromptSubmit` hook), oldest first, wrapped by one `frameInbound` call, under 9,000 characters (Claude Code caps hook context at 10,000); the rest stay unread with a count and a pointer to `inbox`. Exactly the delivered messages are marked read. Prompts starting with `/` get nothing, and only sessions whose cwd is inside the room's `projectDir` receive messages. Messages that need you, or direct questions to your agent, also trigger a desktop notification and show in the status line right away.
- `manual`: nothing is pushed; the agent reads only through `inbox`, `wait` or `/agentroom:sync`. `manual` controls push only: an agent that calls `inbox` on its own still reads. Notifications and the status line work in both modes.

The mode is per room, in `<room>/settings.json`, set by `/agentroom:sync-mode` or `agentroom sync-mode`.

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

- A plain readline UI (no dependency): a numbered thread list marked `needs you` and `waiting on a human (n)`, the selected thread's latest messages, and an input line; the whole screen redraws on each message and on resize. It opens its own relay connection, keeps everything in memory, never marks anything read and sends no presence.
- Input: plain text replies in the selected thread; `/thread <n>` selects a thread; `/new <text>` starts one; `/approve` approves the selected thread; `/quit` (or Ctrl-C) exits. Posts are human messages with `via: "watch"`. The pane refuses to start when an agent marker is set or stdin or stdout is not a terminal, so it stops accidental impersonation, not a determined agent.
- Desktop notifications come from the MCP server (one per message across sessions on the same room), for live messages from another member with `requiresHuman` or addressed to you: `osascript` on macOS and `notify-send` on Linux, with the title and an 80-character preview passed as arguments, never inside a script. `AGENTROOM_NOTIFY=off` turns them off. Previews stay in the OS notification history after the room closes.
- Everything drawn from inbound messages (bodies, names, refs) is stripped of control characters and escape sequences first, so a message cannot forge a "needs you" line.

## Non-Claude agents

- `agentroom install codex|gemini|cursor` writes the MCP server entry into that agent's config and appends a short snippet to the repo's `AGENTS.md` or `GEMINI.md`:
  > This project uses agentroom. At the start of each task and after finishing each step, call the `inbox` tool. When you are waiting on the other team, call `wait`.
- Files touched. User scope (the default): Codex `~/.codex/config.toml` (`$CODEX_HOME/config.toml` when set) `[mcp_servers.agentroom]`; Gemini CLI `~/.gemini/settings.json` `mcpServers.agentroom`; Cursor `~/.cursor/mcp.json` `mcpServers.agentroom` (with `type: "stdio"`). `--project` writes `.codex/config.toml`, `.gemini/settings.json` or `.cursor/mcp.json` in the repo root (the nearest ancestor with `.git`) instead. The snippet always goes to the repo root's `AGENTS.md` (Codex, Cursor) or `GEMINI.md` (Gemini), between `<!-- agentroom:start -->` and `<!-- agentroom:end -->`.
- The entry runs `agentroom mcp` with no `--room`, so it serves the current room and never names a room id; project files are safe to commit. Everything else in the files is kept, and running install twice changes nothing. A config agentroom cannot rewrite safely (invalid JSON, or an `agentroom` server defined as an inline table, dotted key or array of tables in TOML) aborts with the file named and nothing changed.
- `up --agent X` and `join --agent X` run the user-scope install after the room is ready and print the files they changed; restart the agent to load the tools.
- `agentroom uninstall codex|gemini|cursor [--project]` removes only the entry and the marker block, deletes a file left empty, and says "Nothing to remove" when nothing was installed.
- The MCP server's `instructions` carry the room rules and the inbox/wait guidance, so these agents see them without a skill.
- These agents receive messages when they check, not on push. Say so plainly in the README.

## Later: editor gutter

Messages already carry file and line refs, so a VS Code extension (also runs in Cursor) could show a gutter icon on referenced lines with the thread on hover. v2 at the earliest.
