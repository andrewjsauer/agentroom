import { type Envelope, EnvelopeKind } from "./envelope.js";
import { stripControl } from "./frame.js";

/** Kinds that count toward the chain: everything an agent can send. */
const COUNTED = new Set<EnvelopeKind>(
  EnvelopeKind.exclude(["approve", "presence"]).options,
);

/** Strip control characters and cap length before an id appears in an error. */
function safeId(id: string): string {
  return stripControl(id).slice(0, 64);
}

/**
 * Resolve the thread of an outgoing message (KTD2). `history` must be in relay seq order.
 * Unknown ids are rejected, never turned into a new thread.
 */
export function resolveThread(
  candidate: { id: string; thread?: string; replyTo?: string },
  history: Envelope[],
): string {
  if (candidate.replyTo !== undefined) {
    const parent = history.find(
      (e) => e.id === candidate.replyTo && e.kind !== "presence",
    );
    if (!parent) {
      throw new Error(
        `replyTo ${safeId(candidate.replyTo)} is not a message in this room; call inbox to see message ids.`,
      );
    }
    if (candidate.thread !== undefined && candidate.thread !== parent.thread) {
      throw new Error(
        `thread ${safeId(candidate.thread)} does not match the thread of replyTo ${safeId(candidate.replyTo)} (${safeId(parent.thread)}).`,
      );
    }
    return parent.thread;
  }
  if (candidate.thread !== undefined) {
    const known = history.some(
      (e) => e.kind !== "presence" && e.thread === candidate.thread,
    );
    if (!known) {
      throw new Error(
        `thread ${safeId(candidate.thread)} is not a thread in this room; omit thread to start a new one.`,
      );
    }
    return candidate.thread;
  }
  return candidate.id;
}

export interface ChainState {
  /** Consecutive agent messages per thread since the last human message in it. */
  threads: Map<string, number>;
  /** Consecutive agent messages across all threads since the last human message. */
  room: number;
  maxAgentChain: number;
}

/** Count agent chains over `history`, which must be in relay seq order (KTD1). */
export function chainState(
  history: Envelope[],
  maxAgentChain: number,
): ChainState {
  const threads = new Map<string, number>();
  let room = 0;
  for (const env of history) {
    if (env.kind === "presence") continue;
    if (env.from.agent === "human") {
      threads.set(env.thread, 0);
      room = 0;
    } else if (COUNTED.has(env.kind)) {
      threads.set(env.thread, (threads.get(env.thread) ?? 0) + 1);
      room += 1;
    }
  }
  return { threads, room, maxAgentChain };
}

/** Threads at or over the limit, with their counts. */
export function waitingThreads(
  state: ChainState,
): { thread: string; count: number }[] {
  return [...state.threads]
    .filter(([, count]) => count >= state.maxAgentChain)
    .map(([thread, count]) => ({ thread, count }));
}

export interface ChainRefusal {
  scope: "thread" | "room";
  count: number;
  thread: string;
}

/** Check an agent-authored candidate in `thread`; returns a refusal or undefined. */
export function checkChain(
  state: ChainState,
  thread: string,
): ChainRefusal | undefined {
  const count = state.threads.get(thread) ?? 0;
  if (count >= state.maxAgentChain) return { scope: "thread", count, thread };
  if (state.room >= 2 * state.maxAgentChain) {
    return { scope: "room", count: state.room, thread };
  }
  return undefined;
}

/** The KTD3 refusal text. */
export function chainRefusalText(r: ChainRefusal): string {
  const head =
    r.scope === "thread"
      ? `This thread needs a human. ${r.count} agent messages in a row without a human reply.`
      : `This room needs a human. ${r.count} agent messages in a row across threads without a human reply.`;
  const t = safeId(r.thread);
  return `${head} Ask your user to respond with /say or approve with /approve.\nOutside Claude Code: agentroom say --thread ${t} "..." or agentroom approve ${t}.`;
}
