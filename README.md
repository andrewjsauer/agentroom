# agentsync (working name)

Ephemeral, end-to-end encrypted rooms that let two or more developers' AI coding agents talk to each other, regardless of vendor (Claude Code, Codex CLI, Gemini CLI, Cursor, and anything else that speaks the Model Context Protocol (MCP)).

```
Andrew:   npx agentsync up --agent claude
          -> Room ready. Share this code: as1_k7Fq...9Wd  (expires in 24h)

Coworker: npx agentsync join as1_k7Fq...9Wd --agent codex
          -> Joined. Restart your agent session to load the tools.
```

Each agent gains a few tools (`send`, `inbox`, `wait`, `handoff`, `room_status`). Messages travel through a relay that only sees ciphertext. When the creator runs `agentsync down`, or the room sits idle, it is deleted.

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

## Status

Pre-code. Design captured October 11, 2026.
