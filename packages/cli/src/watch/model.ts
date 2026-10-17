import { chainState, type Envelope } from "@agentroom/protocol";

/** What the watch pane knows: decrypted envelopes in seq order, held in memory only. */
export interface WatchModel {
  roomId: string;
  me: string;
  maxAgentChain: number;
  connections: number;
  messages: { seq: number; env: Envelope }[];
}

export interface WatchThread {
  id: string;
  messages: Envelope[];
  lastSeq: number;
  /** Consecutive agent messages since the last human one. */
  chain: number;
  /** At the chain limit: waiting on a human. */
  limited: boolean;
  /** A requiresHuman message after the thread's last human message. */
  needsYou: boolean;
}

export function emptyModel(roomId: string, me: string): WatchModel {
  return { roomId, me, maxAgentChain: 3, connections: 0, messages: [] };
}

/** Add one envelope; presence and replays (same id) are dropped. Returns a new model. */
export function applyEnvelope(
  model: WatchModel,
  seq: number,
  env: Envelope,
): WatchModel {
  if (env.kind === "presence") return model;
  if (model.messages.some((m) => m.env.id === env.id)) return model;
  const messages = [...model.messages, { seq, env }].sort(
    (a, b) => a.seq - b.seq,
  );
  return { ...model, messages };
}

/** Threads, most recently updated first, with chain and needs-you flags. */
export function threads(model: WatchModel): WatchThread[] {
  const chain = chainState(
    model.messages.map((m) => m.env),
    model.maxAgentChain,
    new Set(), // The pane shows only the soft limit, which ignores who posted.
  );
  const byId = new Map<string, WatchThread>();
  for (const { seq, env } of model.messages) {
    let t = byId.get(env.thread);
    if (!t) {
      const count = chain.threads.get(env.thread) ?? 0;
      t = {
        id: env.thread,
        messages: [],
        lastSeq: seq,
        chain: count,
        limited: count >= model.maxAgentChain,
        needsYou: false,
      };
      byId.set(env.thread, t);
    }
    t.messages.push(env);
    t.lastSeq = seq;
    if (env.from.agent === "human") t.needsYou = false;
    else if (env.requiresHuman) t.needsYou = true;
  }
  return [...byId.values()].sort((a, b) => b.lastSeq - a.lastSeq);
}

export type WatchInput =
  | { t: "reply"; text: string }
  | { t: "new"; text: string }
  | { t: "select"; index: number }
  | { t: "approve" }
  | { t: "quit" }
  | { t: "none" }
  | { t: "error"; message: string };

/** Parse one input line against the number of threads shown. */
export function parseInput(line: string, threadCount: number): WatchInput {
  const text = line.trim();
  if (text === "") return { t: "none" };
  if (!text.startsWith("/")) return { t: "reply", text };
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = text.slice((cmd as string).length).trim();
  switch (cmd) {
    case "/quit":
      return { t: "quit" };
    case "/approve":
      return rest.length === 0
        ? { t: "approve" }
        : { t: "error", message: "/approve takes no argument" };
    case "/new":
      return arg === ""
        ? { t: "error", message: "/new needs a message" }
        : { t: "new", text: arg };
    case "/thread": {
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 1 || n > threadCount) {
        return { t: "error", message: `no thread ${arg || "?"}` };
      }
      return { t: "select", index: n - 1 };
    }
    default:
      return {
        t: "error",
        message: "commands: /thread <n>, /new <text>, /approve, /quit",
      };
  }
}
