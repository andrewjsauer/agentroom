import { existsSync } from "node:fs";
import { readCurrent, readRoomSettings, roomDir } from "@agentroom/mcp";
import { afterEach, expect, test } from "vitest";
import { recognize } from "../src/hook/expansion.js";
import { type HookRoom, hookRoom, reasonOf } from "./hook-env.js";

let r: HookRoom;
afterEach(async () => {
  await r.close();
});

const say = (args: string) => ({
  command_name: "agentroom:say",
  command_args: args,
  prompt: `/agentroom:say ${args}`,
});

test("AE1: /agentroom:say posts the text verbatim as a human answer and blocks with the reason", async () => {
  r = await hookRoom();
  const q = await r.agentPost();
  const res = await r.expand(say("Sealed class.\nShip it"));
  expect(res.exit).toBe(0);
  const last = await r.last();
  expect(last).toMatchObject({
    from: { member: "alice", agent: "human", via: "hook" },
    kind: "answer",
    thread: q.thread,
    replyTo: q.id,
    body: "Sealed class.\nShip it",
  });
  expect(res.out).toBe(
    `${JSON.stringify({
      decision: "block",
      reason: `Sent to room ${r.roomId.slice(0, 8)} as alice (human) in thread ${q.thread.slice(0, 8)}.`,
    })}\n`,
  );
});

test("a bare command_name with a /agentroom: prompt behaves the same; a user's own /approve is left alone", async () => {
  r = await hookRoom();
  await r.agentPost();
  const res = await r.expand({
    command_name: "say",
    command_args: "hi",
    prompt: "/agentroom:say hi",
  });
  expect(reasonOf(res.out)).toMatch(/^Sent to room/);
  const before = r.head();
  const own = await r.expand({
    command_name: "approve",
    command_args: "",
    prompt: "/approve",
  });
  expect(own).toEqual({ exit: 0, out: "", err: "" });
  const other = await r.expand({ command_name: "deploy", prompt: "/deploy" });
  expect(other).toEqual({ exit: 0, out: "", err: "" });
  expect(r.head()).toBe(before);
});

test("recognize: namespaced always, bare only with the namespaced prompt", () => {
  expect(recognize("agentroom:send", "")).toBe("send");
  expect(recognize("sync-mode", " /agentroom:sync-mode manual")).toBe(
    "sync-mode",
  );
  expect(recognize("say", "/agentroom:sayx")).toBeUndefined();
  expect(recognize("agentroom:sync", "/agentroom:sync")).toBeUndefined();
  expect(recognize("essay", "/agentroom:essay")).toBeUndefined();
});

test("--new starts a question thread whose id is the envelope id", async () => {
  r = await hookRoom();
  await r.agentPost();
  const res = await r.expand(say("--new Can we drop iOS 15?"));
  const last = await r.last();
  expect(last.kind).toBe("question");
  expect(last.thread).toBe(last.id);
  expect(last.body).toBe("Can we drop iOS 15?");
  expect(reasonOf(res.out)).toContain(`in new thread ${last.id.slice(0, 8)}.`);
});

test("unknown thread, empty text, both flags and a secret all block with Not sent and post nothing", async () => {
  r = await hookRoom();
  await r.agentPost();
  const before = r.head();
  const key = ["AKIA", "IOSFODNN7", "EXAMPLE"].join("");
  const cases: [string, RegExp][] = [
    ["--thread 01UNKNOWN hi", /^Not sent: thread 01UNKNOWN is not a thread/],
    ["   ", /^Not sent: say needs a message\. Usage:/],
    ["--thread a --new x", /^Not sent: use either --thread or --new/],
    [`my key ${key}`, /^Not sent: .*AWS/i],
  ];
  for (const [args, reason] of cases) {
    const res = await r.expand(say(args));
    expect(res.exit).toBe(0);
    expect(reasonOf(res.out)).toMatch(reason);
    expect(res.out).not.toContain(key);
  }
  expect(r.head()).toBe(before);
});

test("approve with no argument picks the most recently updated waiting thread; none waiting refuses", async () => {
  r = await hookRoom();
  const approve = (args = "") =>
    r.expand({
      command_name: "agentroom:approve",
      command_args: args,
      prompt: `/agentroom:approve ${args}`,
    });
  expect(reasonOf((await approve()).out)).toBe(
    "Not sent: no thread is waiting on a human; pass a thread id.",
  );
  const a = await r.agentPost();
  const b = await r.agentPost();
  for (let i = 0; i < 2; i++) await r.agentPost({ thread: b.thread });
  for (let i = 0; i < 2; i++) await r.agentPost({ thread: a.thread });
  const res = await approve();
  expect(reasonOf(res.out)).toBe(
    `Approved thread ${a.thread.slice(0, 8)} in room ${r.roomId.slice(0, 8)} as alice (human).`,
  );
  expect(await r.last()).toMatchObject({
    kind: "approve",
    thread: a.thread,
    body: "",
    from: { member: "alice", agent: "human", via: "hook" },
  });
  await approve(b.thread);
  expect((await r.last()).thread).toBe(b.thread);
});

test("approve with no argument picks a thread held only by the hard ceiling", async () => {
  r = await hookRoom();
  const approve = () =>
    r.expand({
      command_name: "agentroom:approve",
      command_args: "",
      prompt: "/agentroom:approve ",
    });
  const a = await r.agentPost();
  for (let i = 1; i < 9; i++) {
    if (i % 2 === 0) {
      // A peer's fake human approve: resets the soft count, not the ceiling.
      await r.agentPost({
        from: { member: "bob", agent: "human", via: "cli" },
        kind: "approve",
        thread: a.thread,
        body: "",
      });
    }
    await r.agentPost({ thread: a.thread });
  }
  await r.agentPost({
    from: { member: "bob", agent: "human", via: "cli" },
    kind: "approve",
    thread: a.thread,
    body: "",
  });
  await r.agentPost(); // A newer thread that is not waiting.
  expect(reasonOf((await approve()).out)).toBe(
    `Approved thread ${a.thread.slice(0, 8)} in room ${r.roomId.slice(0, 8)} as alice (human).`,
  );
  // This user's own approve lifted the ceiling, so nothing is waiting now.
  expect(reasonOf((await approve()).out)).toBe(
    "Not sent: no thread is waiting on a human; pass a thread id.",
  );
});

test("sync-mode sets the setting and blocks with the mode; live is refused", async () => {
  r = await hookRoom();
  const mode = (args: string) =>
    r.expand({
      command_name: "agentroom:sync-mode",
      command_args: args,
      prompt: `/agentroom:sync-mode ${args}`,
    });
  expect(reasonOf((await mode("manual")).out)).toBe(
    `Delivery mode for room ${r.roomId.slice(0, 8)}: manual.`,
  );
  expect(readRoomSettings(r.home, r.roomId).delivery).toBe("manual");
  expect(reasonOf((await mode("live")).out)).toMatch(
    /^Live delivery is not available yet.*Mode unchanged \(manual\)\.$/,
  );
});

test("the hook-origin guard: no CLAUDE_PLUGIN_ROOT or the wrong event exits 1 and posts nothing", async () => {
  r = await hookRoom();
  await r.agentPost();
  const before = r.head();
  const noRoot = await r.expand(say("hi"), {});
  expect(noRoot.exit).toBe(1);
  expect(noRoot.out).toBe("");
  expect(noRoot.err).toContain(
    "agentroom hook: not running as a Claude Code plugin hook",
  );
  const wrong = await r.expand({
    ...say("hi"),
    hook_event_name: "UserPromptSubmit",
  });
  expect(wrong.exit).toBe(1);
  expect(wrong.out).toBe("");
  expect(r.head()).toBe(before);
});

test("a thread id with escape sequences is stripped in the reason", async () => {
  r = await hookRoom();
  const evil = "\u001b]52;c;aGk=\u0007T‮EVIL";
  const res = await r.expand(say(`--thread ${evil} hi`));
  const reason = reasonOf(res.out);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence
  expect(reason).not.toMatch(/[\u0000-\u001f\u007f‮]/);
  expect(reason.startsWith("Not sent:")).toBe(true);
});

test("a relay that forgot the room: blocks with the run-up text and clears local state", async () => {
  r = await hookRoom({ idleTtlSec: 1, sweepIntervalMs: 20 });
  await new Promise((res) => setTimeout(res, 1500));
  const res = await r.expand(say("hi"));
  expect(reasonOf(res.out)).toMatch(
    /^Not sent: Room [0-9a-f]{64} has expired or no longer exists.*agentroom up/,
  );
  expect(existsSync(roomDir(r.home, r.roomId))).toBe(false);
  expect(readCurrent(r.home)).toBeUndefined();
});
