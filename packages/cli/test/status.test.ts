import { existsSync } from "node:fs";
import { readCurrent, roomDir, writeStatus } from "@agentroom/mcp";
import { deriveRoom, parseShareCode } from "@agentroom/protocol";
import { type RelayHandle, startRelay } from "@agentroom/relay-node";
import { afterEach, beforeEach, expect, test } from "vitest";
import { main } from "../src/index.js";
import { codeFrom, makeCtx, remove, tempDir } from "./helpers.js";

let relay: RelayHandle;
let clock: number;
let home: string;

beforeEach(async () => {
  clock = Date.now();
  relay = await startRelay({
    port: 0,
    log: () => {},
    now: () => clock,
    idleTtlSec: 10,
    sweepIntervalMs: 10,
  });
  home = tempDir();
});

afterEach(async () => {
  await relay.close();
  remove(home);
});

async function upRoom(): Promise<string> {
  const t = makeCtx(home);
  expect(
    await main(["up", "--relay", relay.url, "--name", "alice"], t.ctx),
  ).toBe(0);
  return deriveRoom(parseShareCode(codeFrom(t.out()))).roomId;
}

test("status prints room, member, relay, connections and expiry, then local counts when present", async () => {
  const roomId = await upRoom();
  const t = makeCtx(home);
  expect(await main(["status"], t.ctx)).toBe(0);
  expect(t.out()).toContain(`Room: ${roomId}`);
  expect(t.out()).toContain("Member: alice (other), creator");
  expect(t.out()).toContain(`Relay: ${relay.url}`);
  expect(t.out()).toContain("Connections: 1");
  expect(t.out()).toMatch(/Expires: \d{4}-/);
  expect(t.out()).toContain("no local status yet");

  const updatedAt = Date.UTC(2026, 9, 11, 12, 0, 0);
  writeStatus(home, roomId, {
    connection: "live",
    connections: 2,
    members: [],
    unread: 3,
    needsYou: 1,
    decryptFailures: 0,
    expiresAt: null,
    lastSeq: 5,
    updatedAt,
  });
  const t2 = makeCtx(home);
  expect(await main(["status", "--room", roomId], t2.ctx)).toBe(0);
  expect(t2.out()).toContain(
    "Unread: 3 (1 need you), connection live, as of 2026-10-11T12:00:00.000Z",
  );
});

test("status after the relay forgot the room prints expired and deletes the room dir", async () => {
  const roomId = await upRoom();
  clock += 11_000;
  await new Promise((r) => setTimeout(r, 50));
  const t = makeCtx(home);
  expect(await main(["status"], t.ctx)).toBe(1);
  expect(t.out()).toMatch(/has expired or no longer exists/);
  expect(existsSync(roomDir(home, roomId))).toBe(false);
  expect(readCurrent(home)).toBeUndefined();
});

test("status with no current room says so", async () => {
  const t = makeCtx(home);
  expect(await main(["status"], t.ctx)).toBe(1);
  expect(t.out()).toContain("No current room");
  const bad = makeCtx(home);
  expect(await main(["status", "--room", "nothex"], bad.ctx)).toBe(2);
});
