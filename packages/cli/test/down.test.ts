import { existsSync } from "node:fs";
import {
  connectOnce,
  RelayClient,
  readCurrent,
  readRoomFile,
  roomDir,
  writeRoomFile,
} from "@agentroom/mcp";
import {
  deriveRoom,
  generateCloseKeyPair,
  parseShareCode,
} from "@agentroom/protocol";
import {
  type RelayEvent,
  type RelayHandle,
  type RelayOptions,
  startRelay,
} from "@agentroom/relay-node";
import { afterEach, expect, test } from "vitest";
import { CREATOR_ONLY_TEXT } from "../src/commands/down.js";
import { main } from "../src/index.js";
import { codeFrom, makeCtx, remove, tempDir } from "./helpers.js";

let relay: RelayHandle;
let events: RelayEvent[];
const homes: string[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  await relay.close();
  for (const h of homes.splice(0)) remove(h);
});

async function setup(opts: Partial<RelayOptions> = {}) {
  events = [];
  relay = await startRelay({
    port: 0,
    log: (e) => events.push(e),
    ...opts,
  });
  const home = tempDir();
  homes.push(home);
  const t = makeCtx(home);
  expect(
    await main(["up", "--relay", relay.url, "--name", "alice"], t.ctx),
  ).toBe(0);
  const code = codeFrom(t.out());
  return { home, code, roomId: deriveRoom(parseShareCode(code)).roomId };
}

/** A live member connection; resolves once welcomed and records how it ended. */
const clients: RelayClient[] = [];
function member(roomId: string): Promise<{ gone?: string }> {
  return new Promise((resolve) => {
    const seen: { gone?: string } = {};
    const c = new RelayClient({
      url: relay.url,
      roomId,
      initialSince: 0,
      onWelcome: () => resolve(seen),
      onMsg: () => {},
      onPresence: () => {},
      onGone: (code) => {
        seen.gone = code;
      },
    });
    clients.push(c);
    c.start();
  });
}

const until = async (cond: () => boolean) => {
  const end = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

test("creator down closes the room for members and removes local state", async () => {
  const { home, roomId } = await setup();
  const m = await member(roomId);
  const t = makeCtx(home);
  expect(await main(["down"], t.ctx)).toBe(0);
  await until(() => m.gone === "closed");
  expect(existsSync(roomDir(home, roomId))).toBe(false);
  expect(readCurrent(home)).toBeUndefined();
  expect(relay.snapshot(roomId)).toBeUndefined();
  expect(events).toContainEqual({ event: "closer_open", room: roomId });
  expect(t.out()).toContain("closed; local state removed");
});

test("AE4 (non-creator): down from a joiner's home refuses and opens no connection", async () => {
  const { code } = await setup();
  const bobHome = tempDir();
  homes.push(bobHome);
  expect(
    await main(
      ["join", code, "--relay", relay.url, "--name", "bob"],
      makeCtx(bobHome).ctx,
    ),
  ).toBe(0);
  const opens = () =>
    events.filter((e) => e.event === "conn_open" || e.event === "closer_open")
      .length;
  const opened = opens();
  const t = makeCtx(bobHome);
  expect(await main(["down"], t.ctx)).toBe(1);
  expect(t.err()).toContain(CREATOR_ONLY_TEXT);
  expect(opens()).toBe(opened);
});

test("down when the relay forgot the room exits 0 and removes local state", async () => {
  const { home, roomId } = await setup();
  await relay.close();
  relay = await startRelay({ port: 0, log: () => {} });
  writeRoomFile(home, { ...readRoomFile(home, roomId), relay: relay.url });
  const t = makeCtx(home);
  expect(await main(["down"], t.ctx)).toBe(0);
  expect(t.out()).toContain("local state removed");
  expect(existsSync(roomDir(home, roomId))).toBe(false);
});

test("down still closes a room at its connection cap", async () => {
  const { home, roomId } = await setup({ maxMembers: 2 });
  await member(roomId);
  await member(roomId);
  const full = connectOnce({
    url: relay.url,
    hello: { t: "hello", room: roomId, proto: 1 },
  });
  await expect(full).rejects.toMatchObject({ code: "room_full" });
  expect(await main(["down"], makeCtx(home).ctx)).toBe(0);
  expect(relay.snapshot(roomId)).toBeUndefined();
});

test("a tampered close key gets bad_signature, exits 1, and keeps local state", async () => {
  const { home, roomId } = await setup();
  const other = await generateCloseKeyPair();
  writeRoomFile(home, {
    ...readRoomFile(home, roomId),
    closeSecretKey: other.secretKey,
  });
  const t = makeCtx(home);
  expect(await main(["down"], t.ctx)).toBe(1);
  expect(t.err()).toContain("bad_signature");
  expect(existsSync(roomDir(home, roomId))).toBe(true);
  expect(relay.snapshot(roomId)).toBeDefined();
});
