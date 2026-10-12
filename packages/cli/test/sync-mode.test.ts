import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  deleteRoomDir,
  readRoomSettings,
  roomDir,
  setCurrent,
  writeRoomFile,
} from "@agentroom/mcp";
import { afterEach, beforeEach, expect, test } from "vitest";
import { main } from "../src/index.js";
import { makeCtx, remove, tempDir } from "./helpers.js";

const ROOM = "c".repeat(64);
let home: string;
const settingsPath = () => join(roomDir(home, ROOM), "settings.json");

beforeEach(() => {
  home = tempDir();
  writeRoomFile(home, {
    v: 1,
    roomId: ROOM,
    secret: "s",
    relay: "ws://127.0.0.1:1",
    member: "alice",
    agent: "claude-code",
    createdByMe: true,
  });
  setCurrent(home, ROOM);
});
afterEach(() => remove(home));

async function run(...args: string[]) {
  const t = makeCtx(home);
  const code = await main(["sync-mode", ...args], t.ctx);
  return { code, out: t.out(), err: t.err() };
}

test("a room with no settings.json reads as between", async () => {
  expect(readRoomSettings(home, ROOM).delivery).toBe("between");
  expect(await run()).toMatchObject({
    code: 0,
    out: "Delivery mode for room cccccccc: between.\n",
  });
});

test("sync-mode manual writes settings.json 0600 and prints the mode", async () => {
  expect((await run("manual")).out).toBe(
    "Delivery mode for room cccccccc: manual.\n",
  );
  expect(statSync(settingsPath()).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({
    v: 1,
    delivery: "manual",
  });
  expect((await run()).out).toContain(": manual.");
});

test("sync-mode live explains the deferral and changes nothing", async () => {
  await run("manual");
  const before = readFileSync(settingsPath(), "utf8");
  const r = await run("live");
  expect(r.code).toBe(0);
  expect(r.out).toBe(
    "Live delivery is not available yet: Claude Code channels are a research preview that does not load this server. Mode unchanged (manual).\n",
  );
  expect(readFileSync(settingsPath(), "utf8")).toBe(before);
});

test("an unknown mode is a usage error", async () => {
  const r = await run("fast");
  expect(r.code).toBe(2);
  expect(r.err).toContain('unknown delivery mode "fast"');
});

test("a corrupt settings.json reads as between and the next write replaces it", async () => {
  writeFileSync(settingsPath(), "{not json");
  expect(readRoomSettings(home, ROOM).delivery).toBe("between");
  await run("manual");
  expect(readRoomSettings(home, ROOM).delivery).toBe("manual");
});

test("deleting the room directory removes settings.json (invariant 7)", async () => {
  await run("manual");
  deleteRoomDir(home, ROOM);
  expect(() => statSync(settingsPath())).toThrow();
});

test("with no room it says how to get one", async () => {
  remove(home);
  home = tempDir();
  const r = await run();
  expect(r.code).toBe(1);
  expect(r.err).toContain("No current room");
});
