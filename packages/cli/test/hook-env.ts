import { readFileSync } from "node:fs";
import {
  deriveRoom,
  type Envelope,
  type EnvelopeInput,
  open,
  parseShareCode,
  seal,
  ulid,
} from "@agentroom/protocol";
import {
  type RelayHandle,
  type RelayOptions,
  startRelay,
} from "@agentroom/relay-node";
import { main } from "../src/index.js";
import { codeFrom, makeCtx, remove, tempDir } from "./helpers.js";

export const EXPANSION_FIXTURE = JSON.parse(
  readFileSync(
    new URL("./fixtures/hooks/user-prompt-expansion.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

/** A relay, alice's room made with `up`, and helpers to inject and read envelopes. */
export async function hookRoom(opts: Partial<RelayOptions> = {}) {
  const relay: RelayHandle = await startRelay({
    port: 0,
    log: () => {},
    ...opts,
  });
  const home = tempDir();
  const t = makeCtx(home);
  if (
    (await main(["up", "--relay", relay.url, "--name", "alice"], t.ctx)) !== 0
  ) {
    throw new Error(t.err());
  }
  const code = codeFrom(t.out());
  const { roomId, key } = deriveRoom(parseShareCode(code));

  const all = async (): Promise<Envelope[]> =>
    Promise.all(
      (relay.snapshot(roomId)?.buffer ?? []).map((m) =>
        open(m.blob, key, roomId),
      ),
    );

  return {
    relay,
    home,
    code,
    roomId,
    key,
    head: () => relay.snapshot(roomId)?.seq ?? 0,
    all,
    last: async () => (await all()).at(-1) as Envelope,
    /** An agent envelope from bob, injected like an MCP post. */
    async agentPost(e: Partial<EnvelopeInput> = {}): Promise<Envelope> {
      const id = ulid();
      const env: EnvelopeInput = {
        v: 1,
        id,
        ts: Date.now(),
        from: { member: "bob", agent: "codex", via: "mcp" },
        kind: "question",
        thread: id,
        body: "agent says",
        ...e,
      };
      const blob = await seal(env, key, roomId);
      relay.inject(roomId, blob);
      return open(blob, key, roomId);
    },
    /** Run `hook prompt-expansion` as a plugin hook would. */
    async expand(
      fields: Record<string, unknown>,
      env: NodeJS.ProcessEnv = { CLAUDE_PLUGIN_ROOT: "/plugin" },
    ) {
      const c = makeCtx(home, { env });
      c.stdin.end(JSON.stringify({ ...EXPANSION_FIXTURE, ...fields }));
      const exit = await main(["hook", "prompt-expansion"], c.ctx);
      return { exit, out: c.out(), err: c.err() };
    },
    async close() {
      await relay.close();
      remove(home);
    },
  };
}

export type HookRoom = Awaited<ReturnType<typeof hookRoom>>;

export const reasonOf = (out: string): string => {
  const parsed = JSON.parse(out);
  if (parsed.decision !== "block") throw new Error(`not a block: ${out}`);
  return parsed.reason;
};
