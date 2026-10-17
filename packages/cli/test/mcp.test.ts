import { join } from "node:path";
import { setCurrent, writeRoomFile } from "@agentroom/mcp";
import { afterEach, expect, test } from "vitest";
import { servedRoomId } from "../src/commands/mcp.js";
import { makeCtx, remove, tempDir } from "./helpers.js";

const ROOM = "e".repeat(64);
const dirs: string[] = [];
const dir = () => {
  const d = tempDir();
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) remove(d);
});

function home(projectDir?: string): string {
  const h = dir();
  writeRoomFile(h, {
    v: 1,
    roomId: ROOM,
    secret: "ar1_x",
    relay: "ws://127.0.0.1:1",
    member: "alice",
    agent: "claude-code",
    createdByMe: true,
    ...(projectDir === undefined ? {} : { projectDir }),
  });
  setCurrent(h, ROOM);
  return h;
}

test("the room is served inside its project directory, including subdirectories", () => {
  const project = dir();
  const h = home(project);
  expect(servedRoomId(undefined, makeCtx(h, { cwd: project }).ctx)).toBe(ROOM);
  expect(
    servedRoomId(undefined, makeCtx(h, { cwd: join(project, "app") }).ctx),
  ).toBe(ROOM);
});

test("an agent started in another directory gets no room, even with --room", () => {
  const h = home(dir());
  const ctx = makeCtx(h, { cwd: dir() }).ctx;
  expect(servedRoomId(undefined, ctx)).toBeUndefined();
  expect(servedRoomId(ROOM, ctx)).toBeUndefined();
});

test("a room without a project directory is served anywhere", () => {
  const h = home();
  expect(servedRoomId(undefined, makeCtx(h, { cwd: dir() }).ctx)).toBe(ROOM);
});
