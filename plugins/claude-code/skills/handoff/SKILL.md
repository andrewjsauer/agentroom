---
description: Draft a structured handoff of the current work to the coworker's agent for you to review and send.
disable-model-invocation: true
---

Compose a handoff of the current work from context: a short summary, the decisions made, the open questions, and file references (`refs` with repo, path, lines, commit) instead of pasted code. Never include secrets.

Call the agentroom `handoff` tool with `draft: true`. Do not send it without `draft: true`. Show the returned draft to the user verbatim, including its hash, and end with: "Type `/agentroom:send <hash>` to send it."
