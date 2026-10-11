# Build log

Newest entry last. Each entry: what was completed, real test output, decisions, what's next.

## Waiting on Andrew

- Create the GitHub org/repo `agentroom` and push `main`; confirm the CI workflow goes green on Node 20 and 22.
- Deploy `relay-node` somewhere reachable over TLS for the real two-person test (M1).
- The real two-person test (M1 human acceptance).
- Publish to npm (M4). The name `agentroom` was free on npm on 2026-10-11.
- Client-contract check (`OPEN_QUESTIONS.md` item 14).
- Decide whether to keep Node 20 in the support matrix: it reached end of life in April 2026; keeping it pins vitest to v3 (vitest 5 needs Node 22.12+).

## 2026-10-11: docs review, rename, M0

Completed:
- Initial docs committed. Design review (coherence, feasibility, security-lens reviewers) applied 29 raw findings merged to about 20 fixes; see commit `6985cb3` for the list. The biggest: creation and joining are distinct relay operations with the creator's Ed25519 close key pinned in plaintext at creation; room settings travel in an encrypted `meta` blob; chain limit derives `thread` from `replyTo`, ignores presence and adds a room-wide counter; a local process model where the MCP server owns a per-room session cache; `export` is CLI-only; inbound framing is nonce-tagged and escaped on every delivery path; secret scanning runs for every sender; drafts release by hash and are never tagged human.
- Renamed `agentsync` to `agentroom` (taken on npm and as a GitHub org). Repo directory keeps the old name locally.
- `OPEN_QUESTIONS.md` items 1, 2, 3, 15 answered with dates and URLs. MCP TypeScript SDK is on v2 (`@modelcontextprotocol/server` 2.3.1, zod v4); `CLAUDE.md` stack line updated.
- M0 scaffold: pnpm workspace, four skeleton packages, Biome, vitest 3, tsup, TypeScript 5, Apache-2.0, CI workflow. Simplify pass changed nothing; review pass confirmed no findings.

Test status (orchestrator's own run, Node 26; the builder also ran build and test under Node 20.20.2):
```
packages/{protocol,relay-node,mcp,cli} build: ESM Build success / DTS Build success
packages/relay-node test:  Test Files  1 passed (1)
packages/mcp test:         Test Files  1 passed (1)
packages/protocol test:    Test Files  1 passed (1)
packages/cli test:         Test Files  1 passed (1)
packages/* typecheck: Done
biome check .  ->  Checked 23 files in 3ms. No fixes applied.
```

Decisions:
- Cross-model review passes were skipped: the only configured external route could read the checkout (including `.env`) and the run is unattended.
- M0 packages declare no runtime dependencies; verified pins for M1 are recorded in the M0 plan (KTD6).
- `engines.node >=20.19` because vitest 3 resolves vite 7.

Next: M1 (core loop, encrypted).
