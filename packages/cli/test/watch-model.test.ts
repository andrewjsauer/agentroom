import { expect, test } from "vitest";
import { parseInput, threads } from "../src/watch/model.js";
import { build, env } from "./watch-fixtures.js";

test("threads are ordered by latest seq; presence and replays are ignored; human labeled by agent", () => {
  const a = env();
  const b = env();
  const m = build([
    a,
    b,
    env({ kind: "presence" }),
    env({
      thread: a.thread,
      from: { member: "alice", agent: "human", via: "cli" },
    }),
    a,
  ]);
  const list = threads(m);
  expect(list.map((t) => t.id)).toEqual([a.thread, b.thread]);
  expect(list[0]?.messages.map((e) => e.from.agent)).toEqual([
    "codex",
    "human",
  ]);
  expect(m.messages).toHaveLength(3);
});

test("a thread at the room's limit is flagged; a human message clears it; requiresHuman marks needs you", () => {
  const t = env();
  const three = [t, env({ thread: t.thread }), env({ thread: t.thread })];
  expect(threads(build(three))[0]).toMatchObject({ chain: 3, limited: true });
  expect(threads(build(three, 4))[0]?.limited).toBe(false);
  const urgent = env({ requiresHuman: true });
  expect(threads(build([urgent]))[0]?.needsYou).toBe(true);
  const answered = build([
    urgent,
    env({
      thread: urgent.thread,
      from: { member: "alice", agent: "human", via: "watch" },
    }),
  ]);
  expect(threads(answered)[0]).toMatchObject({ needsYou: false, chain: 0 });
});

test("input parsing", () => {
  expect(parseInput("  hi there ", 2)).toEqual({
    t: "reply",
    text: "hi there",
  });
  expect(parseInput("/thread 2", 2)).toEqual({ t: "select", index: 1 });
  expect(parseInput("/thread 9", 2)).toEqual({
    t: "error",
    message: "no thread 9",
  });
  expect(parseInput("/new drop iOS 15?", 2)).toEqual({
    t: "new",
    text: "drop iOS 15?",
  });
  expect(parseInput("/new", 2).t).toBe("error");
  expect(parseInput("/approve", 2)).toEqual({ t: "approve" });
  expect(parseInput("/quit", 2)).toEqual({ t: "quit" });
  expect(parseInput("   ", 2)).toEqual({ t: "none" });
  expect(parseInput("/bogus", 2).t).toBe("error");
});
