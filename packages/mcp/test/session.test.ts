import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type RelayHandle, startRelay } from "@agentroom/relay-node";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  createRoomSession,
  ROOM_EXPIRED_TEXT,
  type RoomSession,
  readCurrent,
  readStatus,
  roomDir,
  runStdio,
  WAIT_CANCELLED_TEXT,
} from "../src/index.js";
import {
  createTestRoom,
  makeHome,
  removeHome,
  sleep,
  startMember,
  type TestRoom,
  until,
} from "./helpers.js";

let relay: RelayHandle;
let room: TestRoom;
let clock: number;
const homes: string[] = [];
const sessions: RoomSession[] = [];

beforeEach(async () => {
  clock = Date.now();
  relay = await startRelay({
    port: 0,
    log: () => {},
    now: () => clock,
    idleTtlSec: 10,
    sweepIntervalMs: 10,
  });
  room = await createTestRoom(relay);
});

afterEach(async () => {
  for (const s of sessions.splice(0)) s.close();
  await relay.close();
  for (const h of homes.splice(0)) removeHome(h);
});

function member(name: string, agent: "codex" | "gemini" = "codex") {
  const home = makeHome();
  homes.push(home);
  const session = startMember(home, relay, room, name, agent);
  sessions.push(session);
  return { home, session };
}

async function pair() {
  const a = member("alice");
  const b = member("bob");
  await until(
    () =>
      a.session.status().connections === 2 &&
      b.session.status().connections === 2 &&
      relay.snapshot(room.roomId)?.seq === 2,
    5000,
    "both live with presence stored",
  );
  return { ...a, b };
}

/** Lines for messages from others; a restart adds one own presence line by design. */
const inboundLines = (home: string) =>
  readFileSync(join(roomDir(home, room.roomId), "queue.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.includes('"t":"msg"') && l.includes('"own":false')).length;

test("invariant 2 guard: a forced human agent makes send throw before anything reaches the relay", async () => {
  const { session } = await pair();
  const before = relay.snapshot(room.roomId)?.seq;
  (session.room as { agent: string }).agent = "human";
  await expect(session.send({ kind: "fyi", body: "x" })).rejects.toThrow(
    /never sends as a human/,
  );
  expect(relay.snapshot(room.roomId)?.seq).toBe(before);
});

test("invariant 2 source guard: only the seal-path comparison mentions the human tag", () => {
  const dir = new URL("../src/", import.meta.url);
  let hits = 0;
  let files = 0;
  for (const entry of readdirSync(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    files++;
    const text = readFileSync(join(entry.parentPath, entry.name), "utf8");
    hits += text.match(/["'`]human["'`]/g)?.length ?? 0;
  }
  expect(files).toBeGreaterThan(5);
  expect(hits).toBe(1);
});

test("own messages are never unread and do not wake wait", async () => {
  const { session } = await pair();
  const pending = session.wait(1);
  await session.send({ kind: "fyi", body: "mine" });
  expect(session.status().unread).toBe(0);
  expect(await pending).toBe("No new messages in 1s.");
});

test("two members both named dev on separate machines see each other (AE1)", async () => {
  const a = member("dev");
  const b = member("dev", "gemini");
  await until(
    () =>
      a.session.status().connections === 2 &&
      b.session.status().connections === 2,
    5000,
    "both live",
  );
  await a.session.send({ kind: "question", body: "from-a" });
  await until(() => b.session.status().unread === 1, 5000, "b unread");
  const inbox = b.session.inbox();
  expect(inbox).toContain("from-a");
  expect(inbox).toMatch(/untrusted|information/i);
  await b.session.send({ kind: "answer", body: "from-b" });
  await until(() => a.session.status().unread === 1, 5000, "a unread");
  const aInbox = a.session.inbox();
  expect(aInbox).toContain("from-b");
  expect(aInbox).not.toContain("from-a");
});

test("a second session on the same home treats the first session's post as own (KTD2)", async () => {
  const a = member("alice");
  const second = startMember(a.home, relay, room, "alice", "codex");
  sessions.push(second);
  await until(() => second.status().connection === "live", 5000, "second live");
  await a.session.send({ kind: "fyi", body: "first-session" });
  // The agent post counts toward the chain, own or not: proof the echo reached `second`.
  await until(
    () => second.status().roomAgentRun.count === 1,
    5000,
    "second got the echo",
  );
  expect(second.status().unread).toBe(0);
});

test("abort during wait keeps the message unread for the next inbox", async () => {
  const { session, b } = await pair();
  const ac = new AbortController();
  const pending = session.wait(10, ac.signal);
  await sleep(20);
  ac.abort();
  expect(await pending).toBe(WAIT_CANCELLED_TEXT);
  await b.session.send({ kind: "fyi", body: "after-abort" });
  await until(() => session.status().unread === 1, 5000, "unread");
  expect(session.inbox()).toContain("after-abort");
});

test("restart rebuilds from since=0 without duplicates and keeps only unread (AE3)", async () => {
  const { home, session, b } = await pair();
  for (const body of ["m1", "m2", "m3"]) {
    await b.session.send({ kind: "fyi", body });
  }
  await until(() => session.status().unread === 3, 5000, "three unread");
  expect(session.inbox({ limit: 1 })).toContain("m1");
  const linesBefore = inboundLines(home);
  session.close();

  const again = createRoomSession({
    roomId: room.roomId,
    env: { AGENTROOM_HOME: home, AGENTROOM_NOTIFY: "off" },
    backoff: { initialMs: 5, maxMs: 20 },
  });
  sessions.push(again);
  await until(() => again.status().connection === "live", 5000, "live");
  await sleep(50);
  expect(inboundLines(home)).toBe(linesBefore);
  expect(again.status().unread).toBe(2);
  const text = again.inbox();
  expect(text).not.toContain("m1");
  expect(text).toContain("m2");
  expect(text).toContain("m3");
});

test("expiry deletes the room dir, allows one final read, then answers room_expired (AE5)", async () => {
  const { home, session, b } = await pair();
  await b.session.send({ kind: "question", body: "last-words" });
  await until(() => session.status().unread === 1, 5000, "unread");
  expect(readCurrent(home)).toBe(room.roomId);

  clock += 11_000;
  await until(() => session.gone, 5000, "gone");
  expect(existsSync(roomDir(home, room.roomId))).toBe(false);
  expect(readCurrent(home)).toBeUndefined();

  const first = session.inbox();
  expect(first).toContain("last-words");
  expect(first).toContain(ROOM_EXPIRED_TEXT);
  expect(session.inbox()).toBe(ROOM_EXPIRED_TEXT);
  expect(await session.wait(1)).toBe(ROOM_EXPIRED_TEXT);
  await expect(session.send({ kind: "fyi", body: "x" })).rejects.toThrow(
    ROOM_EXPIRED_TEXT,
  );
  await sleep(50);
  expect(session.status().connection).toBe("gone");
  expect(existsSync(roomDir(home, room.roomId))).toBe(false);
});

test("wait resolves with the expiry result when the room expires mid-wait", async () => {
  const { session } = await pair();
  const pending = session.wait(10);
  clock += 11_000;
  expect(await pending).toBe(ROOM_EXPIRED_TEXT);
});

test("status.json mirrors status() after an exchange", async () => {
  const { home, session, b } = await pair();
  await b.session.send({ kind: "fyi", body: "x" });
  await until(() => session.status().unread === 1, 5000, "unread");
  const s = session.status();
  const file = readStatus(home, room.roomId);
  expect(file).toMatchObject({
    connection: s.connection,
    connections: s.connections,
    unread: s.unread,
    needsYou: s.needsYou,
    decryptFailures: s.decryptFailures,
    expiresAt: s.expiresAt,
  });
  expect(file?.members).toEqual(s.membersSeen);
});

test("runStdio with an invalid room.json throws and writes nothing to stdout", async () => {
  const home = makeHome();
  homes.push(home);
  const bad = "a".repeat(64);
  mkdirSync(roomDir(home, bad), { recursive: true });
  writeFileSync(join(roomDir(home, bad), "room.json"), "{}");
  const writes: unknown[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    writes.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    expect(() =>
      runStdio({ roomId: "a".repeat(64), env: { AGENTROOM_HOME: home } }),
    ).toThrow();
  } finally {
    process.stdout.write = original;
  }
  expect(writes).toEqual([]);
});
