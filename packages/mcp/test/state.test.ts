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
  compactQueue,
  currentPath,
  deleteRoomDir,
  HISTORY_KEEP,
  HISTORY_MAX,
  type RoomFile,
  readCurrent,
  readQueueTail,
  readRoomFile,
  readStatus,
  replayQueue,
  roomDir,
  setCurrent,
  trimHistory,
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

describe("trimHistory", () => {
  const msgs = (n: number, from = 1) =>
    Array.from({ length: n }, (_, i) => ({
      seq: from + i,
      env: env(`M${from + i}`),
      own: false,
    }));
  const human = (seq: number) => ({
    seq,
    env: env(`H${seq}`, {
      from: { member: "alice", agent: "human", via: "cli" },
    }),
    own: false,
  });

  test("keeps everything under HISTORY_KEEP, sorted by seq", () => {
    const h = msgs(10).reverse();
    const t = trimHistory(h, new Set());
    expect(t.kept.map((m) => m.seq)).toEqual(msgs(10).map((m) => m.seq));
    expect(t.cut).toBe(false);
  });

  test("keeps the last HISTORY_KEEP when the last local human message is within them", () => {
    const h = [...msgs(3_000), human(3_001), ...msgs(10, 3_002)];
    const t = trimHistory(h, new Set(["H3001"]));
    expect(t.kept).toHaveLength(HISTORY_KEEP);
    expect(t.kept.at(-1)?.seq).toBe(3_011);
    expect(t.cut).toBe(false);
  });

  test("keeps everything since the last local human message, up to HISTORY_MAX", () => {
    const h = [...msgs(100), human(101), ...msgs(3_000, 102)];
    const t = trimHistory(h, new Set(["H101"]));
    expect(t.kept[0]?.env.id).toBe("H101");
    expect(t.kept).toHaveLength(3_001);
    expect(t.cut).toBe(false);
  });

  test("a peer's human message does not extend the window", () => {
    const h = [...msgs(100), human(101), ...msgs(3_000, 102)];
    expect(trimHistory(h, new Set()).kept).toHaveLength(3_101);
  });

  test("caps at HISTORY_MAX and reports the cut when it drops messages since the local human", () => {
    const h = [human(1), ...msgs(6_000, 2)];
    const t = trimHistory(h, new Set(["H1"]));
    expect(t.kept).toHaveLength(HISTORY_MAX);
    expect(t.cut).toBe(true);
    expect(trimHistory(msgs(6_000), new Set()).cut).toBe(true);
  });
});

describe("compactQueue", () => {
  beforeEach(() => writeRoomFile(home, room));
  const queue = () => join(roomDir(home, ROOM), "queue.jsonl");

  test("a synthetic flood compacts to the kept window and replays the same state", () => {
    const records = Array.from({ length: 6_000 }, (_, i) => ({
      t: "msg" as const,
      seq: i + 1,
      env: env(`M${i + 1}`, { body: "x".repeat(2_000) }),
      own: false,
    }));
    appendQueue(home, ROOM, [{ t: "sent", ids: ["PENDING", "M5999"] }]);
    appendQueue(home, ROOM, records);
    appendQueue(home, ROOM, [
      { t: "read", ids: records.slice(0, 5_990).map((r) => r.env.id) },
    ]);
    const before = replayQueue(home, ROOM);
    expect(statSync(queue()).size).toBeGreaterThan(13_000_000);
    const { kept, cut } = trimHistory(before.history, before.sentIds);
    expect(kept).toHaveLength(HISTORY_MAX);
    const r = compactQueue(
      home,
      ROOM,
      {
        history: kept,
        seen: before.seen,
        unread: before.unread,
        sentIds: before.sentIds,
        cut,
      },
      before.bytes,
    );
    expect(r).toBeDefined();
    expect(statSync(queue()).size).toBe(r?.bytes);
    expect(statSync(queue()).size).toBeLessThan(12_000_000);
    expect(mode(queue())).toBe(0o600);
    expect(existsSync(join(roomDir(home, ROOM), "deliver.lock"))).toBe(false);

    const after = replayQueue(home, ROOM);
    expect(after.history).toHaveLength(HISTORY_MAX);
    expect(after.history[0]?.seq).toBe(1_001);
    expect([...after.unread].sort()).toEqual([...before.unread].sort());
    expect(after.unread.size).toBe(10);
    expect(after.seen.size).toBe(6_000);
    expect(after.seen.has("M1")).toBe(true);
    expect([...after.sentIds].sort()).toEqual(["M5999", "PENDING"]);
    expect(after.cut).toBe(true);
    expect(after.lastSeq).toBe(6_000);
  });

  test("records appended to the old file after `consumed` are carried over", () => {
    appendQueue(home, ROOM, [{ t: "msg", seq: 1, env: env("A"), own: false }]);
    const before = replayQueue(home, ROOM);
    appendQueue(home, ROOM, [{ t: "read", ids: ["A"] }]);
    const r = compactQueue(
      home,
      ROOM,
      {
        history: before.history,
        seen: before.seen,
        unread: before.unread,
        sentIds: before.sentIds,
        cut: false,
      },
      before.bytes,
    );
    expect(r?.ino).toBe(statSync(queue()).ino);
    const tail = readQueueTail(home, ROOM, r?.bytes ?? 0, r?.ino);
    expect(tail.readIds).toEqual(["A"]);
    expect(replayQueue(home, ROOM).unread.size).toBe(0);
  });

  test("a reader holding an old offset rereads from 0 after the inode changes", () => {
    appendQueue(home, ROOM, [{ t: "sent", ids: ["S1"] }]);
    appendQueue(home, ROOM, [{ t: "msg", seq: 1, env: env("S1"), own: true }]);
    const before = replayQueue(home, ROOM);
    compactQueue(
      home,
      ROOM,
      {
        history: before.history,
        seen: before.seen,
        unread: before.unread,
        sentIds: before.sentIds,
        cut: false,
      },
      before.bytes,
    );
    const tail = readQueueTail(home, ROOM, before.bytes, before.ino);
    expect(tail.sentIds).toEqual(["S1"]);
  });

  test("a busy deliver.lock skips compaction and leaves the file alone", () => {
    appendQueue(home, ROOM, [{ t: "msg", seq: 1, env: env("A"), own: false }]);
    writeFileSync(join(roomDir(home, ROOM), "deliver.lock"), "");
    const before = replayQueue(home, ROOM);
    const size = statSync(queue()).size;
    expect(
      compactQueue(
        home,
        ROOM,
        {
          history: [],
          seen: before.seen,
          unread: before.unread,
          sentIds: before.sentIds,
          cut: false,
        },
        before.bytes,
      ),
    ).toBeUndefined();
    expect(statSync(queue()).size).toBe(size);
  });

  test("an older reader skips the seen record; a local human message after it clears cut", () => {
    appendQueue(home, ROOM, [
      { t: "seen", ids: ["OLD"], cut: true },
      { t: "sent", ids: ["H1"] },
      {
        t: "msg",
        seq: 2,
        env: env("H1", {
          from: { member: "alice", agent: "human", via: "cli" },
        }),
        own: false,
      },
    ]);
    const r = replayQueue(home, ROOM);
    expect(r.seen.has("OLD")).toBe(true);
    expect(r.cut).toBe(false);
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
