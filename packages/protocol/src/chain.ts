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
  /** Consecutive agent messages per thread since the last human message in it (soft limit). */
  threads: Map<string, number>;
  /** Consecutive agent messages across all threads since the last human message (soft limit). */
  room: number;
  /** Agent messages per thread since the last local human message in it (hard ceiling). */
  ceilingThreads: Map<string, number>;
  /** Agent messages across all threads since the last local human message (hard ceiling). */
  ceilingRoom: number;
  maxAgentChain: number;
}

/** The hard ceiling per thread (3N); the room-wide ceiling is twice this (6N). */
export function threadCeiling(maxAgentChain: number): number {
  return 3 * maxAgentChain;
}

/**
 * Count agent chains over `history`, which must be in relay seq order (KTD1).
 *
 * Two layers. The soft counters (`threads`, `room`) reset on a human-tagged message from any
 * member, which keeps an honest room moving. Tags are self-reported, so a peer can post a fake
 * human message; the ceiling counters reset only on a human message whose id is in `localIds`
 * (posted from this machine by the user's own say/approve/hook paths), which a peer cannot forge.
 */
export function chainState(
  history: Envelope[],
  maxAgentChain: number,
  localIds: ReadonlySet<string>,
): ChainState {
  const threads = new Map<string, number>();
  const ceilingThreads = new Map<string, number>();
  let room = 0;
  let ceilingRoom = 0;
  for (const env of history) {
    if (env.kind === "presence") continue;
    if (env.from.agent === "human") {
      threads.set(env.thread, 0);
      room = 0;
      if (localIds.has(env.id)) {
        ceilingThreads.set(env.thread, 0);
        ceilingRoom = 0;
      }
    } else if (COUNTED.has(env.kind)) {
      threads.set(env.thread, (threads.get(env.thread) ?? 0) + 1);
      room += 1;
      ceilingThreads.set(env.thread, (ceilingThreads.get(env.thread) ?? 0) + 1);
      ceilingRoom += 1;
    }
  }
  return { threads, room, ceilingThreads, ceilingRoom, maxAgentChain };
}

/** Threads at or over the soft limit or the hard ceiling, with their soft counts. */
export function waitingThreads(
  state: ChainState,
): { thread: string; count: number }[] {
  const ceiling = threadCeiling(state.maxAgentChain);
  return [...state.threads]
    .filter(
      ([thread, count]) =>
        count >= state.maxAgentChain ||
        (state.ceilingThreads.get(thread) ?? 0) >= ceiling,
    )
    .map(([thread, count]) => ({ thread, count }));
}

export interface ChainRefusal {
  scope: "thread" | "room";
  /** True when the hard ceiling refused: only the local user's own human message lifts it. */
  ceiling: boolean;
  count: number;
  limit: number;
  thread: string;
}

/** Check an agent-authored candidate in `thread`; returns a refusal or undefined. */
export function checkChain(
  state: ChainState,
  thread: string,
): ChainRefusal | undefined {
  const n = state.maxAgentChain;
  const ceiling = threadCeiling(n);
  // The ceiling first: when both hold, a peer's human message would not help.
  const ceil = state.ceilingThreads.get(thread) ?? 0;
  if (ceil >= ceiling) {
    return {
      scope: "thread",
      ceiling: true,
      count: ceil,
      limit: ceiling,
      thread,
    };
  }
  if (state.ceilingRoom >= 2 * ceiling) {
    return {
      scope: "room",
      ceiling: true,
      count: state.ceilingRoom,
      limit: 2 * ceiling,
      thread,
    };
  }
  const count = state.threads.get(thread) ?? 0;
  if (count >= n) {
    return { scope: "thread", ceiling: false, count, limit: n, thread };
  }
  if (state.room >= 2 * n) {
    return {
      scope: "room",
      ceiling: false,
      count: state.room,
      limit: 2 * n,
      thread,
    };
  }
  return undefined;
}

/** The KTD3 refusal text. */
export function chainRefusalText(r: ChainRefusal): string {
  const t = safeId(r.thread);
  const cli = `Outside Claude Code: agentroom say --thread ${t} "..." or agentroom approve ${t}.`;
  if (r.ceiling) {
    const head =
      r.scope === "thread"
        ? `This thread needs your user. ${r.count} agent messages in it since your user last posted in it (hard ceiling ${r.limit}).`
        : `This room needs your user. ${r.count} agent messages across threads since your user last posted (hard ceiling ${r.limit}).`;
    return `${head} A human message posted by another member cannot lift this. Ask your user to run /agentroom:approve ${t} or /agentroom:say themselves.\n${cli}`;
  }
  const head =
    r.scope === "thread"
      ? `This thread needs a human. ${r.count} agent messages in a row without a human reply.`
      : `This room needs a human. ${r.count} agent messages in a row across threads without a human reply.`;
  return `${head} Ask your user to respond with /say or approve with /approve.\n${cli}`;
}
