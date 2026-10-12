import { existsSync } from "node:fs";
import {
  appendQueue,
  createRoomSession,
  type RoomSession,
  readCurrent,
  roomDir,
} from "@agentroom/mcp";
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
import { afterEach, expect, test } from "vitest";
import { main } from "../src/index.js";
import { codeFrom, makeCtx, remove, tempDir } from "./helpers.js";

let relay: RelayHandle;
let home: string;
let roomId: string;
let key: Uint8Array;
const sessions: RoomSession[] = [];

afterEach(async () => {
  for (const s of sessions.splice(0)) s.close();
  await relay.close();
  remove(home);
});

async function setup(opts: Partial<RelayOptions> = {}) {
  relay = await startRelay({ port: 0, log: () => {}, ...opts });
  home = tempDir();
  const t = makeCtx(home);
  expect(
    await main(["up", "--relay", relay.url, "--name", "alice"], t.ctx),
  ).toBe(0);
  ({ roomId, key } = deriveRoom(parseShareCode(codeFrom(t.out()))));
}

const tty = (env: NodeJS.ProcessEnv = {}) =>
  makeCtx(home, { isTTY: true, stdoutIsTTY: true, env });

const head = () => relay.snapshot(roomId)?.seq ?? 0;

/** An agent envelope from bob, sealed and injected like an MCP post. */
async function agentPost(e: Partial<EnvelopeInput> = {}): Promise<Envelope> {
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
  relay.inject(roomId, await seal(env, key, roomId));
  return open(await seal(env, key, roomId), key, roomId);
}

async function lastPosted(): Promise<Envelope> {
  const buf = relay.snapshot(roomId)?.buffer ?? [];
  return open(buf[buf.length - 1]?.blob as string, key, roomId);
}

test("AE6: CLAUDECODE=1 refuses say even with both TTYs, naming the marker", async () => {
  await setup();
  await agentPost();
  const before = head();
  const t = tty({ CLAUDECODE: "1" });
  expect(await main(["say", "hi"], t.ctx)).not.toBe(0);
  expect(t.err()).toContain("CLAUDECODE");
  expect(head()).toBe(before);
});

test("no TTY on stdin or stdout refuses say", async () => {
  await setup();
  const before = head();
  const a = makeCtx(home, { isTTY: false, stdoutIsTTY: true });
  expect(await main(["say", "hi"], a.ctx)).toBe(1);
  expect(a.err()).toContain("interactive terminal");
  const b = makeCtx(home, { isTTY: true, stdoutIsTTY: false });
  expect(await main(["say", "hi"], b.ctx)).toBe(1);
  expect(head()).toBe(before);
});

test("say replies human-tagged in the only thread", async () => {
  await setup();
  const q = await agentPost();
  const t = tty();
  expect(await main(["say", "hello", "there"], t.ctx)).toBe(0);
  const env = await lastPosted();
  expect(env.from).toEqual({ member: "alice", agent: "human", via: "cli" });
  expect(env).toMatchObject({
    kind: "answer",
    thread: q.thread,
    replyTo: q.id,
    body: "hello there",
  });
  expect(t.out()).toContain(`thread ${q.thread}`);
});

test("say picks the thread with the highest-seq message", async () => {
  await setup();
  const first = await agentPost();
  const second = await agentPost();
  await agentPost({ kind: "answer", thread: first.thread, replyTo: first.id });
  expect(await main(["say", "x"], tty().ctx)).toBe(0);
  expect((await lastPosted()).thread).toBe(first.thread);
  expect(second.thread).not.toBe(first.thread);
});

test("a hostile thread id is printed without any ESC byte", async () => {
  await setup();
  await agentPost({ thread: "T\u001b]52;c;cHduZWQ=\u0007X" });
  const t = tty();
  expect(await main(["say", "x"], t.ctx)).toBe(0);
  expect(t.out()).not.toContain("\u001b");
  expect(t.out()).toContain("thread TX");
});

test("say --new starts a question thread; no history also starts one", async () => {
  await setup();
  expect(await main(["say", "first"], tty().ctx)).toBe(0);
  const solo = await lastPosted();
  expect(solo.thread).toBe(solo.id);
  expect(solo.kind).toBe("question");
  await agentPost();
  const t = tty();
  expect(await main(["say", "--new", "topic"], t.ctx)).toBe(0);
  const env = await lastPosted();
  expect(env.thread).toBe(env.id);
  expect(env.kind).toBe("question");
  expect(env.replyTo).toBeUndefined();
  expect(t.out()).toContain("new thread");
});

test("say usage errors and unknown --thread post nothing", async () => {
  await setup();
  await agentPost();
  const before = head();
  const unknown = tty();
  expect(await main(["say", "--thread", "01NOPE", "x"], unknown.ctx)).toBe(1);
  expect(unknown.err()).toContain("thread 01NOPE is not a thread in this room");
  expect(await main(["say", "--thread", "a", "--new", "x"], tty().ctx)).toBe(2);
  expect(await main(["say"], tty().ctx)).toBe(2);
  expect(await main(["say", " "], tty().ctx)).toBe(2);
  expect(head()).toBe(before);
});

test("--thread resolves against the local queue when the relay buffer rolled over", async () => {
  await setup({ bufferSize: 2 });
  const old = await agentPost();
  appendQueue(home, roomId, [{ t: "msg", seq: 1, env: old, own: false }]);
  await agentPost();
  await agentPost();
  expect(relay.snapshot(roomId)?.buffer.map((m) => m.seq)).toEqual([2, 3]);
  expect(await main(["say", "--thread", old.thread, "late"], tty().ctx)).toBe(
    0,
  );
  const env = await lastPosted();
  expect(env.thread).toBe(old.thread);
  expect(env.replyTo).toBe(old.id);
});

test("AE3 (CLI path): a fake AWS key is blocked, not printed, and not posted", async () => {
  await setup();
  const before = head();
  const fake = ["AKIA", "Z7Q2K4M6N3P5R2T4"].join("");
  const t = tty();
  expect(await main(["say", `key ${fake}`], t.ctx)).toBe(1);
  expect(t.err()).toContain("aws-access-key-id");
  expect(t.err() + t.out()).not.toContain(fake);
  expect(head()).toBe(before);
});

test("approve posts a human approve; an unknown thread posts nothing", async () => {
  await setup();
  const q = await agentPost();
  const t = tty();
  expect(await main(["approve", q.thread], t.ctx)).toBe(0);
  const env = await lastPosted();
  expect(env).toMatchObject({ kind: "approve", body: "", thread: q.thread });
  expect(env.from).toEqual({ member: "alice", agent: "human", via: "cli" });
  expect(env.replyTo).toBeUndefined();
  expect(t.out()).toContain(`Approved thread ${q.thread}`);

  const before = head();
  const bad = tty();
  expect(await main(["approve", "01NOPE"], bad.ctx)).toBe(1);
  expect(head()).toBe(before);
  expect(await main(["approve"], tty().ctx)).toBe(2);
});

test("an MCP session at the chain limit can send again after approve", async () => {
  await setup();
  const session = createRoomSession({
    roomId,
    env: { AGENTROOM_HOME: home, AGENTROOM_NOTIFY: "off" },
    backoff: { initialMs: 5, maxMs: 20 },
  });
  sessions.push(session);
  const deadline = Date.now() + 5000;
  const until = async (cond: () => boolean) => {
    while (!cond()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  await until(() => session.status().connection === "live");
  const q = await session.send({ kind: "question", body: "1" });
  await session.send({ kind: "answer", body: "2", replyTo: q.id });
  await session.send({ kind: "answer", body: "3", replyTo: q.id });
  await expect(
    session.send({ kind: "answer", body: "4", replyTo: q.id }),
  ).rejects.toThrow("This thread needs a human");
  expect(await main(["approve", q.id], tty().ctx)).toBe(0);
  await until(() => session.status().roomAgentRun.count === 0);
  await expect(
    session.send({ kind: "answer", body: "4", replyTo: q.id }),
  ).resolves.toBeDefined();
});

test("say against a relay that forgot the room removes local state", async () => {
  await setup();
  await relay.close();
  relay = await startRelay({ port: 0, log: () => {} });
  const t = makeCtx(home, { isTTY: true, stdoutIsTTY: true });
  // Point room.json at the new relay, which never saw this room.
  const { readRoomFile, writeRoomFile } = await import("@agentroom/mcp");
  writeRoomFile(home, { ...readRoomFile(home, roomId), relay: relay.url });
  expect(await main(["say", "hi"], t.ctx)).toBe(1);
  expect(t.err()).toContain("Run `agentroom up`");
  expect(existsSync(roomDir(home, roomId))).toBe(false);
  expect(readCurrent(home)).toBeUndefined();
});
