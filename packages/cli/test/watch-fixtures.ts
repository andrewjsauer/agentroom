import type { Envelope } from "@agentroom/protocol";
import {
  applyEnvelope,
  emptyModel,
  type WatchModel,
} from "../src/watch/model.js";

let n = 0;
export function env(e: Partial<Envelope> = {}): Envelope {
  const id = `id${++n}`;
  return {
    v: 1,
    id,
    ts: 0,
    from: { member: "bob", agent: "codex", via: "mcp" },
    kind: "question",
    thread: id,
    body: `body ${id}`,
    refs: [],
    requiresHuman: false,
    ...e,
  };
}

export function build(envs: Envelope[], limit = 3): WatchModel {
  let m = { ...emptyModel("a".repeat(64), "alice"), maxAgentChain: limit };
  envs.forEach((e, i) => {
    m = applyEnvelope(m, i + 1, e);
  });
  return m;
}
