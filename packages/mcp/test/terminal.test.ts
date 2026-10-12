import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { sealMeta } from "@agentroom/protocol";
import { type RelayHandle, startRelay } from "@agentroom/relay-node";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import {
  ROOM_CLOSED_TEXT,
  type RoomSession,
  readCurrent,
  roomDir,
} from "../src/index.js";
import {
  closeTestRoom,
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
const homes: string[] = [];
const sessions: RoomSession[] = [];

beforeEach(async () => {
  relay = await startRelay({ port: 0, log: () => {} });
  room = await createTestRoom(relay);
});

afterEach(async () => {
  for (const s of sessions.splice(0)) s.close();
  await relay.close();
  for (const h of homes.splice(0)) removeHome(h);
});

function member(name: string) {
  const home = makeHome();
  homes.push(home);
  const session = startMember(home, relay, room, name);
  sessions.push(session);
  return { home, session };
}

test("closed: room dir deleted, current cleared, one final read, then the closed text", async () => {
  const a = member("alice");
  const b = member("bob");
  await until(
    () => relay.snapshot(room.roomId)?.seq === 2,
    5000,
    "presence stored",
  );
  await b.session.send({ kind: "question", body: "last-words" });
  await until(() => a.session.status().unread === 1, 5000, "unread");

  await closeTestRoom(relay, room);
  await until(() => a.session.gone && b.session.gone, 5000, "both gone");
  expect(existsSync(roomDir(a.home, room.roomId))).toBe(false);
  expect(readCurrent(a.home)).toBeUndefined();

  const first = a.session.inbox();
  expect(first).toContain("last-words");
  expect(first).toContain(ROOM_CLOSED_TEXT);
  expect(a.session.inbox()).toBe(ROOM_CLOSED_TEXT);
  expect(await a.session.wait(1)).toBe(ROOM_CLOSED_TEXT);
  await expect(a.session.send({ kind: "fyi", body: "x" })).rejects.toThrow(
    ROOM_CLOSED_TEXT,
  );
  await sleep(50);
  expect(a.session.status().connection).toBe("gone");
  expect(existsSync(roomDir(a.home, room.roomId))).toBe(false);
});

test("a send pending when the room closes rejects at once with the closed text", async () => {
  // A relay stand-in that welcomes, swallows every put (no echo), and closes on demand.
  const meta = await sealMeta({}, room.key, room.roomId);
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  const puts: WebSocket[] = [];
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const f = JSON.parse(raw.toString()) as { t: string };
      if (f.t === "hello") {
        ws.send(
          JSON.stringify({
            t: "welcome",
            seq: 0,
            members: 1,
            expiresAt: Date.now() + 60_000,
            nonce: "AAAA",
            meta,
          }),
        );
      } else if (f.t === "put") {
        puts.push(ws);
      }
    });
  });
  const home = makeHome();
  homes.push(home);
  const port = (wss.address() as AddressInfo).port;
  const session = startMember(
    home,
    { url: `ws://127.0.0.1:${port}` } as RelayHandle,
    room,
    "alice",
  );
  sessions.push(session);
  await until(() => puts.length === 1, 5000, "presence put");
  const pending = session.send({ kind: "fyi", body: "racing" });
  await until(() => puts.length === 2, 5000, "send put");
  const started = Date.now();
  puts[0]?.send(JSON.stringify({ t: "closed" }));
  await expect(pending).rejects.toThrow(ROOM_CLOSED_TEXT);
  expect(Date.now() - started).toBeLessThan(1000);
  for (const c of wss.clients) c.terminate();
  await new Promise((r) => wss.close(r));
});
