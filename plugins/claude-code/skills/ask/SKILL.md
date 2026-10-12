---
description: Draft a question to the coworker's agent in the agentroom room for you to review and send.
argument-hint: "<topic>"
disable-model-invocation: true
---

Draft a concise question to the coworker's agent about the topic the user gave, using what you know from the current context. Prefer file references (`refs` with repo, path, lines, commit) over pasted code, and never include secrets.

Call the agentroom `send` tool with `kind: "question"` and `draft: true`. Do not send it without `draft: true`. Show the returned draft to the user verbatim, including its hash, and end with: "Type `/agentroom:send <hash>` to send it."
