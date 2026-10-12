import type { PassThrough } from "node:stream";
import { afterEach, expect, test } from "vitest";
import { main } from "../src/index.js";
import { makeCtx } from "./helpers.js";
import { type HookRoom, hookRoom } from "./hook-env.js";

let r: HookRoom;
afterEach(async () => {
  await r.close();
});

const tty = (env: NodeJS.ProcessEnv = {}, stdoutIsTTY = true) =>
  makeCtx(r.home, { isTTY: true, stdoutIsTTY, env });

test("AE7: CLAUDECODE=1 refuses before any relay connection, naming the marker", async () => {
  const events: string[] = [];
  r = await hookRoom({ log: (e) => events.push(e.event) });
  events.length = 0;
  const t = tty({ CLAUDECODE: "1" });
  expect(await main(["watch"], t.ctx)).toBe(1);
  expect(t.err()).toContain("CLAUDECODE is set");
  expect(events).toEqual([]);
});

test("stdout that is not a terminal is refused", async () => {
  r = await hookRoom();
  const t = tty({}, false);
  expect(await main(["watch"], t.ctx)).toBe(1);
  expect(t.err()).toContain("stdin and stdout must be a TTY");
});

const until = async (cond: () => boolean | Promise<boolean>) => {
  const end = Date.now() + 5000;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((res) => setTimeout(res, 10));
  }
};

test("driver: shows an agent message, posts a reply as human via watch, exits 1 when the room closes", async () => {
  r = await hookRoom();
  const q = await r.agentPost({ body: "Which enum shape?" });
  const t = tty();
  const stdin = t.stdin as PassThrough;
  const done = main(["watch"], t.ctx);
  await until(() => t.out().includes("Which enum shape?"));
  stdin.write("Sealed class.\n");
  await until(async () => (await r.last()).body === "Sealed class.");
  expect(await r.last()).toMatchObject({
    from: { member: "alice", agent: "human", via: "watch" },
    kind: "answer",
    thread: q.thread,
    replyTo: q.id,
  });
  stdin.write("/thread 7\n");
  await until(() => t.out().includes("no thread 7"));
  const t2 = makeCtx(r.home);
  expect(await main(["down"], t2.ctx)).toBe(0);
  expect(await done).toBe(1);
  expect(t.out()).toContain("The room was closed by its creator.");
});

test("driver: a picked thread stays selected when another thread moves to the top", async () => {
  r = await hookRoom();
  const a = await r.agentPost({ body: "Thread A" });
  const b = await r.agentPost({ body: "Thread B" });
  await r.agentPost({ body: "Thread C" });
  const t = tty();
  const stdin = t.stdin as PassThrough;
  const done = main(["watch"], t.ctx);
  const frame = () => t.out().split("\u001b[H\u001b[2J").at(-1) ?? "";
  await until(() => frame().includes("1. Thread C"));
  stdin.write("/thread 2\n");
  await until(() => frame().includes("\u001b[7m2. Thread B"));
  await r.agentPost({ body: "Follow-up", thread: a.thread, replyTo: a.id });
  await until(() => frame().includes("\u001b[7m3. Thread B"));
  stdin.write("Reply to B.\n");
  await until(async () => (await r.last()).body === "Reply to B.");
  expect(await r.last()).toMatchObject({
    from: { agent: "human", via: "watch" },
    thread: b.thread,
    replyTo: b.id,
  });
  stdin.write("/quit\n");
  expect(await done).toBe(0);
});
