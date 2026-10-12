import { describe, expect, test } from "vitest";
import {
  chainRefusalText,
  chainState,
  checkChain,
  type Envelope,
  resolveThread,
  waitingThreads,
} from "../src/index.js";

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
    const s = chainState([env("T"), env("T"), env("T")], 3);
    expect(checkChain(s, "T")).toEqual({
      scope: "thread",
      count: 3,
      thread: "T",
    });
    expect(checkChain(s, "U")).toBeUndefined();
  });

  test("a human answer resets the thread and the room count", () => {
    const s = chainState(
      [env("T"), env("T"), env("T"), env("T", { human: true })],
      3,
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
    );
    expect(s.threads.get("T")).toBe(3);
    expect(s.room).toBe(3);
  });

  test("the room-wide counter stops a new-thread-per-message loop", () => {
    const hist = [1, 2, 3, 4, 5, 6].map((i) => env(`T${i}`));
    const s = chainState(hist, 3);
    expect(s.room).toBe(6);
    expect(checkChain(s, "T7")).toEqual({
      scope: "room",
      count: 6,
      thread: "T7",
    });
    const reset = chainState([...hist, env("T1", { human: true })], 3);
    expect(checkChain(reset, "T7")).toBeUndefined();
  });

  test("a human in thread A resets the room count but not thread B", () => {
    const s = chainState([env("B"), env("B"), env("A", { human: true })], 3);
    expect(s.room).toBe(0);
    expect(s.threads.get("B")).toBe(2);
  });

  test("waiting threads lists exactly those at or over the limit", () => {
    const s = chainState([env("A"), env("A"), env("B"), env("B"), env("B")], 2);
    expect(waitingThreads(s)).toEqual([
      { thread: "A", count: 2 },
      { thread: "B", count: 3 },
    ]);
  });

  test("history must be seq-ordered; sorting an out-of-order input gives the same result", () => {
    const ordered = [env("T"), env("T"), env("T", { human: true }), env("T")];
    const seqs = new Map(ordered.map((e, i) => [e.id, i]));
    const shuffled = [
      ordered[3],
      ordered[0],
      ordered[2],
      ordered[1],
    ] as Envelope[];
    const sorted = [...shuffled].sort(
      (a, b) => (seqs.get(a.id) as number) - (seqs.get(b.id) as number),
    );
    expect(chainState(sorted, 3)).toEqual(chainState(ordered, 3));
  });

  test("refusal texts carry the ARCHITECTURE sentence and the CLI line", () => {
    const t = chainRefusalText({ scope: "thread", count: 3, thread: "T1" });
    expect(t).toContain(
      "This thread needs a human. 3 agent messages in a row without a human reply. Ask your user to respond with /say or approve with /approve.",
    );
    expect(t).toContain(
      'agentroom say --thread T1 "..." or agentroom approve T1.',
    );
    expect(
      chainRefusalText({ scope: "room", count: 6, thread: "T" }),
    ).toContain(
      "This room needs a human. 6 agent messages in a row across threads without a human reply.",
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
