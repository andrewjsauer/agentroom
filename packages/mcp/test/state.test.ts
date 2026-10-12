import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Envelope } from "@agentroom/protocol";
import { beforeEach, describe, expect, test } from "vitest";
import {
  agentroomHome,
  appendQueue,
  clearCurrentIf,
  currentPath,
  deleteRoomDir,
  type RoomFile,
  readCurrent,
  readQueueTail,
  readRoomFile,
  readStatus,
  replayQueue,
  roomDir,
  setCurrent,
  writeRoomFile,
  writeStatus,
} from "../src/index.js";

const ROOM = "c".repeat(64);
let home: string;

const room: RoomFile = {
  v: 1,
  roomId: ROOM,
  secret: "ar1_x",
  relay: "ws://127.0.0.1:1",
  member: "alice",
  agent: "codex",
  createdByMe: true,
  closeSecretKey: "sk",
};

function env(id: string, patch: Partial<Envelope> = {}): Envelope {
  return {
    v: 1,
    id,
    ts: 1,
    from: { member: "bob", agent: "codex", via: "mcp" },
    kind: "question",
    thread: id,
    body: "b",
    refs: [],
    requiresHuman: false,
    ...patch,
  };
}

const mode = (p: string) => statSync(p).mode & 0o777;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentroom-state-"));
});

test("agentroomHome honors AGENTROOM_HOME and defaults under the home dir", () => {
  expect(agentroomHome({ AGENTROOM_HOME: home })).toBe(home);
  expect(
    roomDir(agentroomHome({ AGENTROOM_HOME: home }), ROOM).startsWith(home),
  ).toBe(true);
  expect(agentroomHome({})).toBe(join(homedir(), ".agentroom"));
});

test("room dir is 0700 and every file is 0600", () => {
  writeRoomFile(home, room);
  appendQueue(home, ROOM, [{ t: "read", ids: [] }]);
  writeStatus(home, ROOM, {
    connection: "live",
    connections: 1,
    members: [],
    unread: 0,
    needsYou: 0,
    decryptFailures: 0,
    expiresAt: null,
    lastSeq: 0,
    updatedAt: 1,
  });
  const dir = roomDir(home, ROOM);
  expect(mode(dir)).toBe(0o700);
  expect(mode(join(dir, "room.json"))).toBe(0o600);
  expect(mode(join(dir, "queue.jsonl"))).toBe(0o600);
  expect(mode(join(dir, "status.json"))).toBe(0o600);
  expect(readRoomFile(home, ROOM)).toEqual(room);
  expect(readStatus(home, ROOM)?.connection).toBe("live");
});

describe("readRoomFile rejects invalid files (AE6 at the store level)", () => {
  test.each([
    ["agent human", { ...room, agent: "human" }],
    ["missing secret", { ...room, secret: undefined }],
  ])("%s", (_name, bad) => {
    writeRoomFile(home, room);
    writeFileSync(join(roomDir(home, ROOM), "room.json"), JSON.stringify(bad));
    expect(() => readRoomFile(home, ROOM)).toThrow();
  });
});

describe("replayQueue", () => {
  beforeEach(() => writeRoomFile(home, room));

  test("rebuilds seen, unread and lastSeq; dedupes; own and presence never unread", () => {
    appendQueue(home, ROOM, [
      { t: "msg", seq: 1, env: env("A"), own: false },
      { t: "msg", seq: 2, env: env("B"), own: false },
      { t: "msg", seq: 3, env: env("C"), own: false },
      { t: "read", ids: ["A"] },
      { t: "msg", seq: 9, env: env("B"), own: false },
      { t: "msg", seq: 4, env: env("D"), own: true },
      { t: "msg", seq: 5, env: env("E", { kind: "presence" }), own: false },
    ]);
    const r = replayQueue(home, ROOM);
    expect([...r.seen]).toEqual(["A", "B", "C", "D", "E"]);
    expect([...r.unread]).toEqual(["B", "C"]);
    expect(r.history).toHaveLength(5);
    expect(r.lastSeq).toBe(9);
  });

  test("a truncated last line is ignored", () => {
    appendQueue(home, ROOM, [{ t: "msg", seq: 1, env: env("A"), own: false }]);
    appendFileSync(
      join(roomDir(home, ROOM), "queue.jsonl"),
      '{"t":"msg","seq":2,"en',
    );
    const r = replayQueue(home, ROOM);
    expect([...r.unread]).toEqual(["A"]);
    expect(r.lastSeq).toBe(1);
  });
});

describe("sent records", () => {
  beforeEach(() => writeRoomFile(home, room));

  test("replayQueue collects sentIds without touching seq, history or unread", () => {
    appendQueue(home, ROOM, [
      { t: "sent", ids: ["S1"] },
      { t: "msg", seq: 1, env: env("A"), own: false },
      { t: "sent", ids: ["S2"] },
    ]);
    const r = replayQueue(home, ROOM);
    expect([...r.sentIds]).toEqual(["S1", "S2"]);
    expect(r.history).toHaveLength(1);
    expect([...r.unread]).toEqual(["A"]);
    expect(r.lastSeq).toBe(1);
  });

  test("an old queue without sent records gives an empty set", () => {
    appendQueue(home, ROOM, [{ t: "msg", seq: 1, env: env("A"), own: false }]);
    expect(replayQueue(home, ROOM).sentIds.size).toBe(0);
  });

  test("readQueueTail returns read and sent ids after the offset and leaves a torn tail", () => {
    appendQueue(home, ROOM, [{ t: "sent", ids: ["OLD"] }]);
    const from = replayQueue(home, ROOM).bytes;
    appendQueue(home, ROOM, [
      { t: "msg", seq: 1, env: env("A"), own: false },
      { t: "sent", ids: ["S1"] },
      { t: "read", ids: ["A"] },
    ]);
    appendFileSync(join(roomDir(home, ROOM), "queue.jsonl"), '{"t":"sent","id');
    const tail = readQueueTail(home, ROOM, from);
    expect(tail.sentIds).toEqual(["S1"]);
    expect(tail.readIds).toEqual(["A"]);
    expect(readQueueTail(home, ROOM, tail.bytes).sentIds).toEqual([]);
  });
});

test("clearCurrentIf only clears a matching current", () => {
  setCurrent(home, ROOM);
  expect(readCurrent(home)).toBe(ROOM);
  clearCurrentIf(home, "d".repeat(64));
  expect(readCurrent(home)).toBe(ROOM);
  clearCurrentIf(home, ROOM);
  expect(existsSync(currentPath(home))).toBe(false);
});

test("deleteRoomDir removes the dir and is a no-op when gone", () => {
  writeRoomFile(home, room);
  deleteRoomDir(home, ROOM);
  expect(existsSync(roomDir(home, ROOM))).toBe(false);
  expect(() => deleteRoomDir(home, ROOM)).not.toThrow();
});
