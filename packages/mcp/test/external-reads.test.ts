import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  deriveRoom,
  type EnvelopeInput,
  parseShareCode,
  seal,
  ulid,
} from "@agentroom/protocol";
import { type RelayHandle, startRelay } from "@agentroom/relay-node";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  appendQueue,
  createRoomSession,
  type RoomSession,
  readStatus,
  replayQueue,
  roomDir,
  StatusFile,
  setCurrent,
  writeRoomFile,
} from "../src/index.js";
import {
  createTestRoom,
  makeHome,
  removeHome,
  type TestRoom,
  until,
} from "./helpers.js";

let relay: RelayHandle;
let room: TestRoom;
let home: string;
const sessions: RoomSession[] = [];

beforeEach(async () => {
  relay = await startRelay({ port: 0, log: () => {} });
  home = makeHome();
});

afterEach(async () => {
  for (const s of sessions.splice(0)) s.close();
  await relay.close();
  removeHome(home);
});

async function start(
  settings: { name?: string; maxAgentChain?: number } = {},
  externalReadMs = 60_000,
) {
  room = await createTestRoom(relay, settings);
  writeRoomFile(home, {
    v: 1,
    roomId: room.roomId,
    secret: room.code,
    relay: relay.url,
    member: "alice",
    agent: "claude-code",
    createdByMe: true,
  });
  setCurrent(home, room.roomId);
  const session = createRoomSession({
    roomId: room.roomId,
    env: { AGENTROOM_HOME: home, AGENTROOM_NOTIFY: "off" },
    externalReadMs,
  });
  sessions.push(session);
  await until(() => session.status().connection === "live");
  return session;
}

async function inject(e: Partial<EnvelopeInput> = {}): Promise<string> {
  const id = ulid();
  const { key } = deriveRoom(parseShareCode(room.code));
  relay.inject(
    room.roomId,
    await seal(
      {
        v: 1,
        id,
        ts: Date.now(),
        from: { member: "bob", agent: "codex", via: "mcp" },
        kind: "question",
        thread: id,
        body: `body ${id}`,
        ...e,
      },
      key,
      room.roomId,
    ),
  );
  return id;
}

const queuePath = () => join(roomDir(home, room.roomId), "queue.jsonl");

test("a read record appended by another process hides that message from inbox", async () => {
  const s = await start();
  const a = await inject();
  const b = await inject();
  await until(() => s.status().unread === 2);
  appendQueue(home, room.roomId, [{ t: "read", ids: [a] }]);
  const text = s.inbox();
  expect(text).not.toContain(a);
  expect(text).toContain(b);
});

test("status.json picks up external reads on the timer without a tool call", async () => {
  const s = await start({}, 20);
  const a = await inject();
  await until(() => readStatus(home, room.roomId)?.unread === 1);
  appendQueue(home, room.roomId, [{ t: "read", ids: [a] }]);
  await until(() => readStatus(home, room.roomId)?.unread === 0);
  expect(s.status().unread).toBe(0);
});

test("a torn last line is ignored until it is completed; unknown ids change nothing", async () => {
  const s = await start();
  const a = await inject();
  await until(() => s.status().unread === 1);
  const line = `${JSON.stringify({ t: "read", ids: [a] })}\n`;
  appendFileSync(queuePath(), line.slice(0, 10));
  expect(s.status().unread).toBe(1);
  appendFileSync(queuePath(), line.slice(10));
  expect(s.status().unread).toBe(0);
  appendQueue(home, room.roomId, [{ t: "read", ids: ["nope"] }]);
  expect(s.status().unread).toBe(0);
});

test("status.json carries waitingOnHuman and a stripped, bounded roomName", async () => {
  const s = await start({
    name: `\u001b[31m${"n".repeat(40)}‮`,
    maxAgentChain: 3,
  });
  const t = await inject();
  await inject({ thread: t });
  await inject({ thread: t });
  await until(() => s.status().unread === 3);
  await until(() => readStatus(home, room.roomId)?.waitingOnHuman === 1);
  const st = readStatus(home, room.roomId);
  expect(st?.roomName).toBe(`[31m${"n".repeat(28)}`);
});

test("an older status.json without the new fields still parses", () => {
  expect(
    StatusFile.parse({
      connection: "live",
      connections: 1,
      members: [],
      unread: 0,
      needsYou: 0,
      decryptFailures: 0,
      expiresAt: null,
      lastSeq: 0,
      updatedAt: 0,
    }).waitingOnHuman,
  ).toBeUndefined();
});

test("an id recorded as sent is own; a same-named member elsewhere and this member's human are unread", async () => {
  const s = await start();
  // A CLI post or hook release from this machine writes `sent` before its put.
  const releasedId = ulid();
  appendFileSync(
    queuePath(),
    `${JSON.stringify({ t: "sent", ids: [releasedId] })}\n`,
  );
  await inject({
    id: releasedId,
    thread: releasedId,
    from: { member: "alice", agent: "claude-code", via: "hook" },
  });
  const otherAliceId = await inject({
    from: { member: "alice", agent: "codex", via: "mcp" },
  });
  const humanId = ulid();
  appendFileSync(
    queuePath(),
    `${JSON.stringify({ t: "sent", ids: [humanId] })}\n`,
  );
  await inject({
    id: humanId,
    thread: humanId,
    from: { member: "alice", agent: "human", via: "hook" },
  });
  await until(() => replayQueue(home, room.roomId).seen.has(humanId));
  const q = replayQueue(home, room.roomId);
  expect(q.history.find((m) => m.env.id === releasedId)?.own).toBe(true);
  expect(q.history.find((m) => m.env.id === otherAliceId)?.own).toBe(false);
  expect(q.history.find((m) => m.env.id === humanId)?.own).toBe(false);
  expect([...q.unread].sort()).toEqual([otherAliceId, humanId].sort());
  expect(s.status().unread).toBe(2);
  expect(q.sentIds.has(releasedId)).toBe(true);
});
