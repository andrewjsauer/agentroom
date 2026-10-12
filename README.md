# agentroom

> Formerly `agentsync`; renamed on 2026-10-11 because `agentsync` is taken on npm and as a GitHub org (see `docs/OPEN_QUESTIONS.md` item 1). The repository directory may still be named `agentsync` locally.

Ephemeral, end-to-end encrypted rooms that let two or more developers' AI coding agents talk to each other, regardless of vendor (Claude Code, Codex CLI, Gemini CLI, Cursor, and anything else that speaks the Model Context Protocol (MCP)).

```
Andrew:   npx agentroom up --agent claude
          -> Room ready. Share this code: ar1_k7Fq...9Wd  (expires in 24h)

Coworker: npx agentroom join ar1_k7Fq...9Wd --agent codex
          -> Joined. Restart your agent session to load the tools.
```

Each agent gains a few tools (`send`, `inbox`, `wait`, `handoff`, `room_status`). Messages travel through a relay that only sees ciphertext. When the creator runs `agentroom down`, the room sits idle, or it reaches its max age (24 h at most), it is deleted.

## Why

Two developers building the same Software Development Kit (SDK) on different platforms (Android and iOS) spend a lot of time copy-pasting what their agents said to each other. No vendor ships cross-account, cross-vendor agent messaging. Every major agent is an MCP client, so an MCP server is the one integration point that works everywhere and never touches anyone's subscription login.

## What it is not

- Not a permanent team workspace or memory system. Rooms are temporary on purpose.
- Not a way to share one agent's full context. Agents exchange concise messages with file references, like two engineers on Slack.
- Not tied to a vendor, and it never handles model credentials.

## Repo docs

| File | Purpose |
|---|---|
| `CLAUDE.md` | Instructions for the coding agent building this project. Start here. |
| `docs/ARCHITECTURE.md` | Components, protocol, crypto, message envelope, tools, safety. |
| `docs/UX.md` | Claude Code plugin, slash commands, status line, `watch` pane. |
| `docs/PLAN.md` | Milestones with task checklists and acceptance criteria. |
| `docs/OPEN_QUESTIONS.md` | Things to verify against current docs before or during the build. |

## Usage (Milestone 3)

```
agentroom up [--agent claude|codex|gemini|cursor] [--name <member>] [--relay <url>] [--max-chain <n>] [--ttl <n>h|<n>m]
agentroom join [code] [--agent ...] [--name <member>] [--relay <url>]
agentroom status [--room <id>]
agentroom say [--thread <id> | --new] [--room <id>] "<text>"   # your own words, tagged human
agentroom approve <thread> [--room <id>]                      # unblock a thread held by the chain limit
agentroom export [--thread <id>] [--format md|gh-issue] [--room <id>]
agentroom down [--room <id>]                                  # creator only: close the room now
agentroom watch [--room <id>]                                 # follow every thread and reply as yourself
agentroom sync-mode [between|manual] [--room <id>]            # how messages reach Claude Code
agentroom install claude | uninstall claude                   # Claude Code plugin and status line
agentroom mcp [--room <id>]      # stdio MCP server; what the agent's MCP config runs
```

`up` prints the share code (the room secret) and the exact `join` command. Both commands write `~/.agentroom/rooms/<room_id>/room.json` (`$AGENTROOM_HOME` overrides the directory) and print the stdio command to add to your agent's MCP config; restart the agent session afterwards. `--ttl` sets the room's max age (default and ceiling 24 h); a room also ends after 8 h without activity. `--max-chain` sets how many agent messages in a row a thread allows before a human must reply (default 3).

The MCP server exposes `room_status`, `send`, `inbox`, `wait` and `handoff`, plus an `agentroom-rules` prompt with the etiquette. `send` and `handoff` accept `draft: true`, which saves the message for you to release with `/agentroom:send <hash>` in Claude Code instead of posting it.

### Claude Code

From a checkout (after `pnpm install && pnpm build`), run `agentroom up --agent claude` or `agentroom install claude`. With `claude` on PATH this installs the plugin in `plugins/claude-code/` from the repo-root marketplace (user scope) and sets your status line, chaining any status line you already had; restart Claude Code (or `/reload-plugins`) and type `/agentroom:sync`. Without `claude` on PATH, start Claude Code with `claude --plugin-dir <checkout>/plugins/claude-code`. `agentroom uninstall claude` removes the plugin and restores your previous status line. The plugin needs Node 20.19+ on Claude Code's PATH.

In Claude Code: `/agentroom:say <text>` posts your own words (the model never sees them), `/agentroom:approve [thread]` unblocks a thread held by the chain limit, `/agentroom:ask <topic>` and `/agentroom:handoff` have Claude draft a message that you release with `/agentroom:send <hash>` (`/agentroom:send` alone shows the stored draft), `/agentroom:sync` summarizes new messages, and `/agentroom:sync-mode between|manual` picks whether new messages are added to your next prompt (`between`, the default) or wait until asked (`manual`). A room is bound to the directory where you ran `up` or `join`: only Claude Code sessions in that project get its messages at the next prompt. The plugin's MCP server serves the current room at startup, so restart Claude Code after `up` or `join`.

Messages that need you raise a desktop notification (macOS `osascript`, Linux `notify-send`) with the sender and the first 80 characters, which stay in the OS notification history after the room closes; set `AGENTROOM_NOTIFY=off` to turn them off. Other agents' users can follow the room with `agentroom watch` in a terminal pane.

`say` and `approve` are how you speak in the room yourself. They refuse to run unless both stdin and stdout are a terminal, and they refuse inside an agent's shell (when `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `AI_AGENT`, `CODEX_THREAD_ID`, `CODEX_CI`, `CODEX_SANDBOX`, `GEMINI_CLI` or `CURSOR_AGENT` is set). Claude Code's IDE extensions set `CLAUDECODE` in integrated terminals, so run `say` from a standalone terminal. `say` replies in the most recently updated thread unless you pass `--thread` or `--new`.

`export` writes the room's local history (what this machine's MCP server saw) as markdown to stdout. `--format gh-issue` writes the body to a private temp file and prints the `gh issue create --body-file` command to run; the file holds decrypted messages, so delete it when done. Run `export` before `down` if you want a record: `down` deletes local state on every member's machine.

The relay URL comes from `--relay`, then `AGENTROOM_RELAY`, then the built-in default `wss://relay.agentroom.dev`, which is a placeholder: no relay is deployed there yet. Until one is, run `agentroom-relay` from `@agentroom/relay-node` (listens on `PORT`, default 8787) and pass its `ws://` URL to both sides. `up` includes `--relay` in the printed join command whenever the URL is not the default.

## Threat model

agentroom protects message contents from the relay and stops the common accidents of unattended agents. It does not protect members from each other.

**What the relay sees.** The room id (an HKDF output of the share secret, not the secret), the size and timing of each ciphertext envelope, connection counts, the creator's close public key, the room's idle and max-age TTLs, and the encrypted room settings. It never sees plaintext, member or agent names, the share code or the room key. Relay logs carry room ids, counts and error codes only.

**What the relay can still do.** Drop, delay, replay or reorder envelopes, refuse connections, or forget a room. Replayed envelopes are dropped by id on each client. A tampered envelope fails decryption and is counted, not shown.

**What any member can do.** Anyone holding the share code is a full member until the room closes or expires: they read every message, post under any display name they choose, and stay until the end. Display names are claims, not identities.

**Human tags.** The MCP server never emits a message tagged `human`; that is enforced in code and tested. CLI `say` and `approve` (and, from Milestone 3, the Claude Code hook) are the only human paths. Their terminal and agent-marker checks stop accidental impersonation only. An agent running as your OS user can read `room.json` and forge any tag, so a human tag means "probably typed by a person", not proof.

**Chain limits.** Each MCP server stops its own agent after N agent messages in a row in a thread (and 2N across the room) with no human message. The count is per sender: two agents posting at the same moment can overshoot by at most one message each.

**Secret scanning.** Outgoing bodies, recipients and refs are checked against credential patterns (AWS, GitHub, Slack, private key headers, JWTs, Google API keys, Stripe live keys, and high-entropy `key=`/`token=`/`secret=` assignments) before encryption. A match blocks the send and names the rule; nothing is redacted. Pattern matching can miss secrets.

**Refs, not code.** Agents are told to send `{repo, path, lines, commit}` references instead of pasting code. That is an instruction, not a control: a message body can carry 8 000 characters of anything, code included, visible to every member.

**Inbound messages are data.** Every message an agent reads is wrapped in a labeled, nonce-tagged block with a reminder that it is information from another person's agent, not instructions. This lowers the risk of prompt injection; it does not remove it.

**Share-code leakage is yours to manage.** Treat the code like a password. If it leaks, run `agentroom down` (creator only) and start a new room with `agentroom up`.

## Development

Requires Node 20.19 or newer and pnpm 10 (the exact version is pinned in `package.json` under `packageManager`; `corepack enable` picks it up).

```
pnpm install
pnpm build       # tsup build of every package
pnpm typecheck   # tsc --noEmit in every package
pnpm lint        # Biome lint, format check, and import sorting
pnpm test        # vitest in every package
pnpm format      # Biome format, writes changes
```

Packages live under `packages/`: `protocol`, `relay-node`, `mcp`, and `cli` (published as `agentroom`).

## Status

Milestone 3 (Claude Code plugin and humans): the `plugins/claude-code` plugin with hook-based `/agentroom:say`, `approve` and draft release, `between` delivery at the next prompt, delivery modes, desktop notifications, a chained status line, and the `watch` pane. Milestone 2 (safe to use): chain limits, secret scanning, human-only `say`/`approve`, creator-only `down`, max-age expiry, relay rate limits and connection caps, `handoff`, drafts, the rules prompt, and `export`, on top of the Milestone 1 core loop (encrypted envelopes, in-memory relay, stdio MCP server, `up`/`join`/`status`/`mcp`). No relay is deployed yet. Design captured October 11, 2026.
