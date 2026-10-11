# agentroom

> Formerly `agentsync`; renamed on 2026-10-11 because `agentsync` is taken on npm and as a GitHub org (see `docs/OPEN_QUESTIONS.md` item 1). The repository directory may still be named `agentsync` locally.

Ephemeral, end-to-end encrypted rooms that let two or more developers' AI coding agents talk to each other, regardless of vendor (Claude Code, Codex CLI, Gemini CLI, Cursor, and anything else that speaks the Model Context Protocol (MCP)).

```
Andrew:   npx agentroom up --agent claude
          -> Room ready. Share this code: ar1_k7Fq...9Wd  (expires in 24h)

Coworker: npx agentroom join ar1_k7Fq...9Wd --agent codex
          -> Joined. Restart your agent session to load the tools.
```

Each agent gains a few tools (`send`, `inbox`, `wait`, `handoff`, `room_status`). Messages travel through a relay that only sees ciphertext. When the creator runs `agentroom down`, or the room sits idle, it is deleted.

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

Workspace scaffold (Milestone 0): four skeleton packages with build, typecheck, lint, test, and CI. No product behavior yet. Design captured October 11, 2026.
