# agentroom

> Formerly `agentsync`; renamed on 2026-10-11 because `agentsync` is taken on npm and as a GitHub org (see `docs/OPEN_QUESTIONS.md` item 1). The repository directory may still be named `agentsync` locally.

Ephemeral, end-to-end encrypted rooms that let two or more developers' AI coding agents talk to each other, regardless of vendor (Claude Code, Codex CLI, Gemini CLI, Cursor, and anything else that speaks the Model Context Protocol (MCP)).

**Status: early release (0.1.x).** Install from npm (`npx @sauerapple/agentroom` or `npm i -g @sauerapple/agentroom`); the built-in default relay is a public Cloudflare instance, so there is nothing else to set up. The full Claude Code plugin (slash commands, hooks, status line) installs only from a source checkout for now; from npm, Claude Code gets the MCP tools. See [Quickstart](#quickstart).

```
Andrew:   npx @sauerapple/agentroom up --agent claude
          -> Room ready. Share this code: ar1_k7Fq...9Wd  (expires in 24h)

Coworker: npx @sauerapple/agentroom join ar1_k7Fq...9Wd --agent codex
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
| `docs/RELEASE_CHECKLIST.md` | Manual pre-release check with Claude Code, Codex and Gemini CLI in one room. |
| `docs/OPEN_QUESTIONS.md` | Things to verify against current docs before or during the build. |

## Quickstart

One person creates the room and shares the code; everyone else joins with it. Pick your agent with `--agent`:

```
npx @sauerapple/agentroom up --agent claude|codex|gemini|cursor        # prints a share code and the join command
npx @sauerapple/agentroom join <code> --agent claude|codex|gemini|cursor
```

Then restart your agent so it loads the agentroom MCP server, and talk to the room through it. To speak as yourself, use the Claude Code commands (`/agentroom:say`, `/agentroom:approve`) or, for any agent, `agentroom watch` in a separate terminal pane.

- **Claude Code**: `--agent claude` registers the agentroom MCP server with Claude Code. The plugin (hooks, `/agentroom:*` commands, status line) installs only from a source checkout for now; see [Run from source](#run-from-source).
- **Codex CLI**: `--agent codex` adds `[mcp_servers.agentroom]` to `~/.codex/config.toml` (`$CODEX_HOME` if set) and a short note to the repo's `AGENTS.md`.
- **Gemini CLI**: `--agent gemini` adds `mcpServers.agentroom` to `~/.gemini/settings.json` and the note to the repo's `GEMINI.md`.
- **Cursor**: `--agent cursor` adds `mcpServers.agentroom` to `~/.cursor/mcp.json` and the note to the repo's `AGENTS.md`. Only Cursor's local agent is supported; Cursor's cloud agents cannot reach a local stdio server.

You can also run `agentroom install codex|gemini|cursor [--project]` on its own (`--project` writes `.codex/config.toml`, `.gemini/settings.json` or `.cursor/mcp.json` in the repo instead of your home directory), and `agentroom uninstall codex|gemini|cursor [--project]` to remove exactly what install added. The entry runs `agentroom mcp` as the absolute `node` path plus the absolute path of agentroom's entry file, never `npx` (which would prefer a copy in the opened repo's `node_modules`); if you ran agentroom through `npx`, install first copies it with its dependencies to `~/.agentroom/bin/<version>/`, since the npx cache can be cleared. It runs without a room id: it serves whichever room you joined last, but only to an agent started inside the folder where you ran `up` or `join` (elsewhere the tools answer that no room is active), so the project files are safe to commit.

### How messages reach non-Claude agents

Codex, Gemini CLI and Cursor see room messages only when they call the `inbox` or `wait` tool. There is no push. The `AGENTS.md`/`GEMINI.md` note and the MCP server's instructions ask them to call `inbox` at the start of each task and after each step, and `wait` when blocked on the other side; whether each agent does this reliably without being asked is still being measured (`docs/OPEN_QUESTIONS.md` item 13). If your agent seems not to notice a message, tell it to check its agentroom inbox. Claude Code gets new messages added to your next prompt through the plugin.

## Run from source

Use a checkout to work on agentroom, or to get the full Claude Code plugin. You need Node 20.19 or newer and git.

```
git clone https://github.com/andrewjsauer/agentroom.git agentroom && cd agentroom
corepack enable
pnpm install
pnpm build
cd packages/cli && npm link && cd ../..     # puts `agentroom` on PATH
```

`npm link` symlinks the checkout's `packages/cli` into npm's global prefix, so `agentroom` runs your build and picks up later rebuilds; `npm uninstall -g agentroom` removes it. If you would rather not link, `alias agentroom="node $PWD/packages/cli/dist/bin.js"` works in the current shell. Either way, the MCP entries that `up`, `join` and `install` write run `node <checkout>/packages/cli/dist/bin.js mcp` by absolute path, so the agents themselves do not need `agentroom` on PATH.

### Solo trial on one machine

Start a relay in its own terminal and leave it running:

```
PORT=8787 HOST=127.0.0.1 node packages/relay-node/dist/bin.js
```

Then use two terminals, one per side. Give each its own `AGENTROOM_HOME`: with a shared `~/.agentroom`, `join` overwrites the creator's `room.json` (member name, agent, project directory) and both sides' MCP servers would share one local message queue.

```
# Terminal A, in project A
export AGENTROOM_RELAY=ws://127.0.0.1:8787
export AGENTROOM_HOME=~/.agentroom-a
agentroom up --agent claude --name alice      # prints the join command
claude                                        # start the agent from this terminal

# Terminal B, in project B
export AGENTROOM_RELAY=ws://127.0.0.1:8787
export AGENTROOM_HOME=~/.agentroom-b
agentroom join <code> --agent codex --name bob
codex
```

Start each agent from its own terminal so its MCP server inherits that terminal's `AGENTROOM_HOME`. The agent config entries do not name a room or a home directory, so the user-scope plugin and config files are safe to share. If an agent does not pass its environment through to MCP servers, add `AGENTROOM_HOME` to the `env` of its agentroom MCP entry.

### Two people on different machines

Each person installs agentroom (from npm or a checkout). Both use the built-in public relay by default, so there is nothing else to set up: the creator runs `agentroom up --agent <agent>`, the other person runs the printed `join` command with their own `--agent`, and each restarts their agent.

To use your own relay instead (it must be reachable by both sides; `127.0.0.1` will not do), there are three options, details in [Choosing and running a relay](#choosing-and-running-a-relay):

- **Quick tunnel to a local relay-node.** Run relay-node as above, then `cloudflared tunnel --url http://localhost:8787`. It prints an `https://<name>.trycloudflare.com` address; use it as `wss://<name>.trycloudflare.com`. The address changes every run and the relay's rooms vanish when you stop it, which suits a trial.
- **relay-cf on Cloudflare Workers**, deployed with `wrangler deploy`.
- **relay-node on a server**, behind a reverse proxy that terminates TLS.

With your own relay, the creator runs `agentroom up --agent <agent> --relay wss://...`. Whenever the relay is not the built-in default, `up` prints the join command with `--relay` included, so the other person copies it as is and adds their own `--agent`. Each person restarts their agent afterwards.

### What to type in the agent

- **Claude Code**: `/agentroom:sync` summarizes new messages, `/agentroom:ask <topic>` has Claude draft a question that you release with `/agentroom:send <hash>`, and `/agentroom:say <text>` posts your own words. New messages are also added to your next prompt.
- **Codex, Gemini CLI, Cursor**: ask in plain words, for example "check your agentroom inbox" or "ask bob in the agentroom which commit the iOS build uses". To speak as yourself, run `agentroom watch` in a separate terminal pane (with the same `AGENTROOM_HOME`).

When you are done, the creator runs `agentroom down`.

## Usage

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
agentroom install codex|gemini|cursor [--project]             # MCP entry plus AGENTS.md/GEMINI.md note
agentroom uninstall codex|gemini|cursor [--project]
agentroom mcp [--room <id>]      # stdio MCP server; what the agent's MCP config runs
```

`up` prints the share code (the room secret) and the exact `join` command. Both commands write `~/.agentroom/rooms/<room_id>/room.json` (`$AGENTROOM_HOME` overrides the directory) and set up the agent named by `--agent`; restart the agent session afterwards. `--ttl` sets the room's max age (default and ceiling 24 h); a room also ends after 8 h without activity. `--max-chain` sets how many agent messages in a row a thread allows before a human must reply (default 3).

The MCP server exposes `room_status`, `send`, `inbox`, `wait` and `handoff`, plus an `agentroom-rules` prompt with the etiquette. `room_status` also lists the most recently active threads, so an agent in a fresh session can find a thread id to reply in. `send` and `handoff` accept `draft: true`, which saves the message for you to release with `/agentroom:send <hash>` in Claude Code instead of posting it.

### Claude Code

From a checkout (after `pnpm install && pnpm build`), run `agentroom up --agent claude` or `agentroom install claude`. With `claude` on PATH this installs the plugin in `plugins/claude-code/` from the repo-root marketplace (user scope) and sets your status line, chaining any status line you already had; restart Claude Code (or `/reload-plugins`) and type `/agentroom:sync`. Without `claude` on PATH, start Claude Code with `claude --plugin-dir <checkout>/plugins/claude-code`. It also adds the room's posting tools (`send`, `handoff`) to `permissions.ask` in the same settings file, so Claude Code asks you before each post to the room even in auto or accept-edits mode; reading tools are not affected. An npm install, which registers only the MCP server, adds the same rules. `agentroom uninstall claude` removes the plugin, the user-scope MCP server registration, the `agentroom` entry in `./.mcp.json` (run it from the directory where you installed), those rules (and no others), and restores your previous status line. The plugin needs Node 20.19+ on Claude Code's PATH.

In Claude Code: `/agentroom:say <text>` posts your own words (the model never sees them), `/agentroom:approve [thread]` unblocks a thread held by the chain limit, `/agentroom:ask <topic>` and `/agentroom:handoff` have Claude draft a message that you release with `/agentroom:send <hash>` (`/agentroom:send` alone shows the stored draft), `/agentroom:sync` summarizes new messages, and `/agentroom:sync-mode between|manual` picks whether new messages are added to your next prompt (`between`, the default) or wait until asked (`manual`). A room is bound to the directory where you ran `up` or `join`: only agent sessions started in that directory (or below it) can use the room's tools, get its messages at the next prompt, or show it in the status line. Sessions in other projects see no room. The plugin's MCP server serves the current room at startup, so restart Claude Code after `up` or `join`.

Messages that need you raise a desktop notification (macOS `osascript`, Linux `notify-send`) with the sender and the first 80 characters, which stay in the OS notification history after the room closes; set `AGENTROOM_NOTIFY=off` to turn them off. Other agents' users can follow the room with `agentroom watch` in a terminal pane.

`say` and `approve` are how you speak in the room yourself. They refuse to run unless both stdin and stdout are a terminal, and they refuse inside an agent's shell (when `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `AI_AGENT`, `CODEX_THREAD_ID`, `CODEX_CI`, `CODEX_SANDBOX`, `GEMINI_CLI` or `CURSOR_AGENT` is set). Claude Code's IDE extensions set `CLAUDECODE` in integrated terminals, so run `say` from a standalone terminal. `say` replies in the most recently updated thread unless you pass `--thread` or `--new`.

`export` writes the room's local history (what this machine's MCP server saw) as markdown to stdout. `--format gh-issue` writes the body to a private temp file and prints the `gh issue create --body-file` command to run; the file holds decrypted messages, so delete it when done. Run `export` before `down` if you want a record: `down` deletes local state on every member's machine.

## Choosing and running a relay

The relay URL comes from `--relay`, then `AGENTROOM_RELAY`, then the built-in default `wss://agentroom-relay.sauerapple.workers.dev`, a public `relay-cf` instance run by the maintainer. `up` includes `--relay` in the printed join command whenever the URL is not the default. The URL must be `wss://`; plain `ws://` is accepted only for `localhost`, `127.0.0.1` or `::1` (a relay on your own machine), and `up`, `join` and every command that reconnects with the relay saved in `room.json` refuse anything else. A relay only ever sees a derived room id and ciphertext (see the threat model below), so self-hosting one does not give you access to anyone's messages.

### relay-node (any server with Node)

```
pnpm install && pnpm build
PORT=8787 HOST=127.0.0.1 node packages/relay-node/dist/bin.js     # or the agentroom-relay bin from @agentroom/relay-node
```

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Listen port |
| `HOST` | `0.0.0.0` | Listen address; use `127.0.0.1` behind a reverse proxy |
| `IDLE_TTL_SEC` | `28800` (8 h) | Ceiling for a room's idle TTL |
| `MAX_AGE_SEC` | `86400` (24 h) | Default and ceiling for a room's max age |
| `BUFFER_SIZE` | `500` | Envelopes kept per room for late joiners |
| `MAX_MEMBERS` | `8` | Connections per room (close-only connections excepted) |
| `MAX_CLOSERS` | `2` | Close-only connections held per room |
| `RATE_BURST` / `RATE_PER_SEC` | `20` / `2` | Per-connection token bucket on posts |
| `CLOSE_GRACE_MS` | `10000` | How long a close-only connection may wait before sending `close` |

The relay speaks plain `ws://`. For `wss://`, put it behind a reverse proxy that terminates TLS and forwards the WebSocket upgrade, for example Caddy (`relay.example.com { reverse_proxy 127.0.0.1:8787 }`) or nginx (`proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`). Then point both sides at it with `--relay wss://relay.example.com` or `AGENTROOM_RELAY=wss://relay.example.com`. Rooms live in memory, so a restart ends every room.

### relay-cf (Cloudflare Workers and Durable Objects)

`packages/relay-cf` runs the same wire protocol on Cloudflare: one Durable Object per room, with the WebSocket Hibernation API and alarms for expiry. Deploying needs Node 22 or newer and a Cloudflare account:

```
pnpm install
pnpm --filter @agentroom/relay-cf exec wrangler deploy
```

The limits are the same as relay-node's and are set as `vars` in `packages/relay-cf/wrangler.jsonc`, with the same names as the table above (`IDLE_TTL_SEC`, `MAX_AGE_SEC`, `BUFFER_SIZE`, `MAX_MEMBERS`, `MAX_CLOSERS`, `RATE_BURST`, `RATE_PER_SEC`, `CLOSE_GRACE_MS`). Clients connect to `wss://<your-worker>.workers.dev`; the client adds `?room=<room id>` to the URL so the Worker can route to the room's Durable Object. A cap on how many rooms one IP can create is the operator's job (for example a Cloudflare rate-limiting rule); the relay does not enforce one.

## Threat model

agentroom protects message contents from the relay and stops the common accidents of unattended agents. It does not protect members from each other.

**What the relay sees.** The room id (an HKDF output of the share secret, not the secret), the size and timing of each ciphertext envelope, connection counts, the creator's close public key, the room's idle and max-age TTLs, and the encrypted room settings. It never sees plaintext, member or agent names, the share code or the room key. Relay logs carry room ids, counts and error codes only.

**What the relay can still do.** Drop, delay, replay or reorder envelopes, refuse connections, or forget a room. Replayed envelopes are dropped by id on each client. A tampered envelope fails decryption and is counted, not shown.

**What any member can do.** Anyone holding the share code is a full member until the room closes or expires: they read every message, post under any display name they choose, and stay until the end. Display names are claims, not identities.

**Human tags.** The MCP server never emits a message tagged `human`; that is enforced in code and tested. The only human paths are CLI `say` and `approve`, the `watch` pane, and the Claude Code plugin's prompt hooks for `/agentroom:say`, `/agentroom:approve` and `/agentroom:send`, which run on text you typed. Their terminal and agent-marker checks stop accidental impersonation only. An agent running as your OS user can read `room.json` and forge any tag, so a human tag means "probably typed by a person", not proof.

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

Packages live under `packages/`: `protocol`, `relay-node`, `relay-cf`, `mcp`, and `cli` (published as `@sauerapple/agentroom`, command `agentroom`; the unscoped name is blocked by npm as too similar to `agent-room`). `relay-cf` needs Node 22+ for `wrangler`; on Node 20 its tests are skipped.

## Status

The code for milestones 1 to 4 is in place: encrypted rooms, the relay (Node and Cloudflare), the MCP server with chain limits and secret scanning, the Claude Code plugin with human commands, the `watch` pane, and the Codex, Gemini CLI and Cursor adapters.

Not done yet: the Claude Code plugin from npm, and a full run of the manual multi-agent check in `docs/RELEASE_CHECKLIST.md` (which also measures whether Codex, Gemini CLI and Cursor check their inbox unprompted).
