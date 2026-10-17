import { describe, expect, test } from "vitest";
import {
  chainRefusalText,
  chainState,
  checkChain,
  type Envelope,
  resolveThread,
  waitingThreads,
} from "../src/index.js";

const NONE: ReadonlySet<string> = new Set();

let n = 0;
function env(
  thread: string,
  opts: { human?: boolean; kind?: Envelope["kind"]; id?: string } = {},
): Envelope {
  n += 1;
  return {
    v: 1,
    id: opts.id ?? `id${n}`,
    ts: n,
    from: {
      member: "alice",
      agent: opts.human ? "human" : "claude-code",
      via: opts.human ? "cli" : "mcp",
    },
    kind: opts.kind ?? "answer",
    thread,
    body: "",
    refs: [],
    requiresHuman: false,
  };
}

describe("chain limit", () => {
  test("a fourth agent message in a thread is refused; other threads are allowed", () => {
    const s = chainState([env("T"), env("T"), env("T")], 3, NONE);
    expect(checkChain(s, "T")).toEqual({
      scope: "thread",
      ceiling: false,
      count: 3,
      limit: 3,
      thread: "T",
    });
    expect(checkChain(s, "U")).toBeUndefined();
  });

  test("a human answer resets the thread and the room count", () => {
    const s = chainState(
      [env("T"), env("T"), env("T"), env("T", { human: true })],
      3,
      NONE,
    );
    expect(s.threads.get("T")).toBe(0);
    expect(s.room).toBe(0);
    expect(checkChain(s, "T")).toBeUndefined();
  });

  test("a human approve with an empty body resets like a human message", () => {
    const s = chainState(
      [
        env("T"),
        env("T"),
        env("T"),
        env("T", { human: true, kind: "approve" }),
      ],
      3,
      NONE,
    );
    expect(checkChain(s, "T")).toBeUndefined();
  });

  test("presence is ignored whoever sends it", () => {
    const s = chainState(
      [
        env("T"),
        env("P", { kind: "presence", human: true }),
        env("T"),
        env("P", { kind: "presence" }),
        env("T"),
      ],
      3,
      NONE,
    );
    expect(s.threads.get("T")).toBe(3);
    expect(s.room).toBe(3);
  });

  test("the room-wide counter stops a new-thread-per-message loop", () => {
    const hist = [1, 2, 3, 4, 5, 6].map((i) => env(`T${i}`));
    const s = chainState(hist, 3, NONE);
    expect(s.room).toBe(6);
    expect(checkChain(s, "T7")).toEqual({
      scope: "room",
      ceiling: false,
      count: 6,
      limit: 6,
      thread: "T7",
    });
    const reset = chainState([...hist, env("T1", { human: true })], 3, NONE);
    expect(checkChain(reset, "T7")).toBeUndefined();
  });

  test("a human in thread A resets the room count but not thread B", () => {
    const s = chainState(
      [env("B"), env("B"), env("A", { human: true })],
      3,
      NONE,
    );
    expect(s.room).toBe(0);
    expect(s.threads.get("B")).toBe(2);
  });

  test("waiting threads lists exactly those at or over the limit", () => {
    const s = chainState(
      [env("A"), env("A"), env("B"), env("B"), env("B")],
      2,
      NONE,
    );
    expect(waitingThreads(s)).toEqual([
      { thread: "A", count: 2 },
      { thread: "B", count: 3 },
    ]);
  });

  test("history must be seq-ordered: arrival order changes the count, sorting by seq restores it", () => {
    const ordered = [env("T"), env("T"), env("T", { human: true }), env("T")];
    const seqs = new Map(ordered.map((e, i) => [e.id, i]));
    const shuffled = [
      ordered[2],
      ordered[3],
      ordered[0],
      ordered[1],
    ] as Envelope[];
    const want = chainState(ordered, 3, NONE);
    expect(want.threads.get("T")).toBe(1);
    expect(chainState(shuffled, 3, NONE)).not.toEqual(want);
    const sorted = [...shuffled].sort(
      (a, b) => (seqs.get(a.id) as number) - (seqs.get(b.id) as number),
    );
    expect(chainState(sorted, 3, NONE)).toEqual(want);
  });

  test("refusal texts carry the ARCHITECTURE sentence and the CLI line", () => {
    const t = chainRefusalText({
      scope: "thread",
      ceiling: false,
      count: 3,
      limit: 3,
      thread: "T1",
    });
    expect(t).toContain(
      "This thread needs a human. 3 agent messages in a row without a human reply. Ask your user to respond with /say or approve with /approve.",
    );
    expect(t).toContain(
      'agentroom say --thread T1 "..." or agentroom approve T1.',
    );
    expect(
      chainRefusalText({
        scope: "room",
        ceiling: false,
        count: 6,
        limit: 6,
        thread: "T",
      }),
    ).toContain(
      "This room needs a human. 6 agent messages in a row across threads without a human reply.",
    );
  });
});

describe("hard ceiling", () => {
  /** A human message posted by another member (its id is not in our local ids). */
  const peerHuman = (thread: string) =>
    env(thread, { human: true, kind: "approve" });

  /** Simulate our agent sending into `threadOf(i)` until refused, with `between` after each send. */
  function run(
    threadOf: (i: number) => string,
    between: (i: number, thread: string) => Envelope[],
    local: Set<string> = new Set(),
    hist: Envelope[] = [],
  ) {
    let sent = 0;
    for (let i = 0; i < 100; i++) {
      const thread = threadOf(i);
      const refusal = checkChain(chainState(hist, 3, local), thread);
      if (refusal) return { sent, refusal, hist };
      hist.push(env(thread));
      sent++;
      hist.push(...between(i, thread));
    }
    return { sent, refusal: undefined, hist };
  }

  test("an honest peer human message resets the soft limit but not the ceiling", () => {
    const s = chainState(
      [env("T"), env("T"), env("T"), peerHuman("T")],
      3,
      NONE,
    );
    expect(s.threads.get("T")).toBe(0);
    expect(s.room).toBe(0);
    expect(s.ceilingThreads.get("T")).toBe(3);
    expect(s.ceilingRoom).toBe(3);
    expect(checkChain(s, "T")).toBeUndefined();
  });

  test("fake peer approves in one thread stop at the thread ceiling (3N)", () => {
    const r = run(
      () => "T",
      (i, t) => (i % 2 === 1 ? [peerHuman(t)] : []),
    );
    expect(r.sent).toBe(9);
    expect(r.refusal).toEqual({
      scope: "thread",
      ceiling: true,
      count: 9,
      limit: 9,
      thread: "T",
    });
    // Another fake approve still does not lift it.
    r.hist.push(peerHuman("T"));
    expect(checkChain(chainState(r.hist, 3, NONE), "T")?.ceiling).toBe(true);
  });

  test("fake peer approves with a new thread per message stop at the room ceiling (6N)", () => {
    const r = run(
      (i) => `T${i}`,
      (i, t) => (i % 5 === 4 ? [peerHuman(t)] : []),
    );
    expect(r.sent).toBe(18);
    expect(r.refusal).toMatchObject({
      scope: "room",
      ceiling: true,
      count: 18,
      limit: 18,
    });
  });

  test("without any human message the soft limit stops first", () => {
    const r = run(
      () => "T",
      () => [],
    );
    expect(r.sent).toBe(3);
    expect(r.refusal?.ceiling).toBe(false);
  });

  test("a local human message lifts both the ceiling and the soft limit", () => {
    const local = new Set<string>();
    const r = run(
      () => "T",
      (_i, t) => [peerHuman(t)],
      local,
    );
    expect(r.refusal?.ceiling).toBe(true);
    const mine = env("T", { human: true, kind: "approve" });
    local.add(mine.id);
    const s = chainState([...r.hist, mine], 3, local);
    expect(s.ceilingThreads.get("T")).toBe(0);
    expect(s.ceilingRoom).toBe(0);
    expect(s.threads.get("T")).toBe(0);
    expect(checkChain(s, "T")).toBeUndefined();
  });

  test("a local human message in another thread lifts the room ceiling, not this thread's", () => {
    const local = new Set<string>();
    const r = run(
      () => "T",
      (_i, t) => [peerHuman(t)],
      local,
    );
    const mine = env("U", { human: true });
    local.add(mine.id);
    const s = chainState([...r.hist, mine], 3, local);
    expect(s.ceilingRoom).toBe(0);
    expect(s.ceilingThreads.get("T")).toBe(9);
    expect(checkChain(s, "T")?.ceiling).toBe(true);
    expect(checkChain(s, "U")).toBeUndefined();
  });

  test("our own agent messages and presence never reset the ceiling", () => {
    const own = env("T");
    const presence = env("T", { kind: "presence", human: true });
    const local = new Set([own.id, presence.id]);
    const s = chainState([env("T"), own, presence, env("T")], 3, local);
    expect(s.ceilingThreads.get("T")).toBe(3);
    expect(s.ceilingRoom).toBe(3);
  });

  test("waiting threads include a thread held only by the ceiling", () => {
    const r = run(
      () => "T",
      (_i, t) => [peerHuman(t)],
    );
    const s = chainState(r.hist, 3, NONE);
    expect(s.threads.get("T")).toBe(0);
    expect(waitingThreads(s)).toEqual([{ thread: "T", count: 0 }]);
  });

  test("ceiling counts follow relay seq order", () => {
    const mine = env("T", { human: true });
    const local = new Set([mine.id]);
    const ordered = [env("T"), env("T"), mine, env("T")];
    const shuffled = [
      ordered[3],
      ordered[2],
      ordered[0],
      ordered[1],
    ] as Envelope[];
    expect(chainState(ordered, 3, local).ceilingThreads.get("T")).toBe(1);
    expect(chainState(shuffled, 3, local).ceilingThreads.get("T")).toBe(2);
  });

  test("a restart rebuilds the same state from replayed history and persisted local ids", () => {
    const local = new Set<string>();
    const r = run(
      (i) => (i % 2 === 0 ? "A" : "B"),
      (i, t) => (i % 3 === 2 ? [peerHuman(t)] : []),
      local,
    );
    const mine = env("A", { human: true });
    local.add(mine.id);
    const hist = [...r.hist, mine, env("B"), env("A")];
    const before = chainState(hist, 3, local);
    const replayed = JSON.parse(JSON.stringify(hist)) as Envelope[];
    const persisted = new Set(
      JSON.parse(JSON.stringify([...local])) as string[],
    );
    expect(chainState(replayed, 3, persisted)).toEqual(before);
  });

  test("the ceiling refusal says a peer's human message cannot lift it", () => {
    const t = chainRefusalText({
      scope: "thread",
      ceiling: true,
      count: 9,
      limit: 9,
      thread: "T1",
    });
    expect(t).toContain(
      "This thread needs your user. 9 agent messages in it since your user last posted in it (hard ceiling 9). A human message posted by another member cannot lift this. Ask your user to run /agentroom:approve T1 or /agentroom:say themselves.",
    );
    expect(t).toContain(
      'agentroom say --thread T1 "..." or agentroom approve T1.',
    );
    expect(
      chainRefusalText({
        scope: "room",
        ceiling: true,
        count: 18,
        limit: 18,
        thread: "T",
      }),
    ).toContain(
      "This room needs your user. 18 agent messages across threads since your user last posted (hard ceiling 18).",
    );
  });
});

describe("resolveThread", () => {
  const parent = env("T", { id: "P1" });
  const presence = env("T", { id: "PR", kind: "presence" });
  const hist = [parent, presence];

  test("replyTo returns the parent's thread; matching thread passes; mismatch is rejected", () => {
    expect(resolveThread({ id: "N", replyTo: "P1" }, hist)).toBe("T");
    expect(resolveThread({ id: "N", replyTo: "P1", thread: "T" }, hist)).toBe(
      "T",
    );
    expect(() =>
      resolveThread({ id: "N", replyTo: "P1", thread: "X" }, hist),
    ).toThrow("thread X does not match the thread of replyTo P1 (T).");
  });

  test("replyTo an unknown id or a presence id is rejected", () => {
    for (const id of ["nope", "PR"]) {
      expect(() => resolveThread({ id: "N", replyTo: id }, hist)).toThrow(
        `replyTo ${id} is not a message in this room; call inbox to see message ids.`,
      );
    }
  });

  test("thread alone must be known; neither starts a new thread", () => {
    expect(resolveThread({ id: "N", thread: "T" }, hist)).toBe("T");
    expect(() => resolveThread({ id: "N", thread: "Z" }, hist)).toThrow(
      "thread Z is not a thread in this room; omit thread to start a new one.",
    );
    expect(resolveThread({ id: "N" }, hist)).toBe("N");
  });

  test("ids in errors are stripped of controls and truncated to 64", () => {
    const bad = `a\nb\u0007${"x".repeat(200)}`;
    try {
      resolveThread({ id: "N", replyTo: bad }, hist);
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain(`replyTo ab${"x".repeat(62)} is not`);
      expect(msg).not.toContain("\n");
    }
  });
});
