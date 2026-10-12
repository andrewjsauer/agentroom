import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type RoomFile,
  roomDir,
  type StatusFile,
  setCurrent,
  writeRoomFile,
  writeRoomSettings,
  writeStatus,
} from "@agentroom/mcp";
import { afterEach, beforeEach, expect, test } from "vitest";
import { statusSegment } from "../src/commands/statusline.js";
import { main } from "../src/index.js";
import { makeCtx, remove, tempDir } from "./helpers.js";

const ROOM = "e".repeat(64);
const NOW = 1_800_000_000_000;
const FIXTURE = readFileSync(
  new URL("./fixtures/hooks/statusline.json", import.meta.url),
  "utf8",
);
const room: RoomFile = {
  v: 1,
  roomId: ROOM,
  secret: "s",
  relay: "ws://127.0.0.1:1",
  member: "alice",
  agent: "claude-code",
  createdByMe: true,
};
const status = (s: Partial<StatusFile> = {}): StatusFile => ({
  connection: "live",
  connections: 2,
  members: [
    { member: "alice", agent: "claude-code", lastSeen: NOW },
    { member: "bob", agent: "codex", lastSeen: NOW - 2 * 60_000 },
  ],
  unread: 2,
  needsYou: 1,
  decryptFailures: 0,
  expiresAt: null,
  lastSeq: 9,
  updatedAt: NOW,
  ...s,
});
const seg = (
  s: StatusFile | undefined,
  extra: Partial<Parameters<typeof statusSegment>[0]> = {},
) =>
  statusSegment({
    room,
    status: s,
    delivery: "between",
    cwd: undefined,
    now: NOW,
    ...extra,
  });

test("the basic segment", () => {
  expect(seg(status())).toBe(
    "agentroom * eeeeeeee | 2 unread (1 need you) | bob/codex active",
  );
});

test("roomName, waiting threads, manual mode, and another project", () => {
  expect(
    seg(status({ roomName: "billing", waitingOnHuman: 1 }), {
      delivery: "manual",
    }),
  ).toBe(
    "agentroom * billing | 2 unread (1 need you) | 1 waiting on a human | bob/codex active | manual",
  );
  expect(
    seg(status(), { room: { ...room, projectDir: "/p" }, cwd: "/q" }),
  ).toBe(
    "agentroom * eeeeeeee | other project | 2 unread (1 need you) | bob/codex active",
  );
  expect(
    seg(status(), { room: { ...room, projectDir: "/p" }, cwd: "/p/x" }),
  ).not.toContain("other project");
});

test("stale peers are dropped; three peers show two and +1; names are stripped and cut", () => {
  const members = [
    { member: "old", agent: "codex", lastSeen: NOW - 20 * 60_000 },
    { member: "p1", agent: "a", lastSeen: NOW - 1000 },
    { member: "p2", agent: "b", lastSeen: NOW - 2000 },
    {
      member: `\u001b[31m${"m".repeat(60)}‮`,
      agent: "c",
      lastSeen: NOW - 3000,
    },
  ];
  expect(seg(status({ members }))).toBe(
    "agentroom * eeeeeeee | 2 unread (1 need you) | p1/a, p2/b +1 active",
  );
  const one = seg(
    status({ members: [members[3] as StatusFile["members"][0]] }),
  );
  expect(one).toContain(`| ${"m".repeat(24)}/c active`);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence
  expect(one).not.toMatch(/[\u0000-\u001f‮]/);
});

test("a gone room reads room closed", () => {
  expect(seg(status({ connection: "gone" }))).toBe("agentroom * room closed");
});

let home: string;
beforeEach(() => {
  home = tempDir();
});
afterEach(() => remove(home));

async function run(args: string[], input = FIXTURE) {
  const t = makeCtx(home);
  t.stdin.end(input);
  const code = await main(["statusline", ...args], t.ctx);
  return { code, out: t.out() };
}

function script(body: string): string {
  const path = join(home, `s${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

test("--chain gets the same stdin and its output comes first", async () => {
  writeRoomFile(home, room);
  setCurrent(home, ROOM);
  writeStatus(home, ROOM, status({ updatedAt: Date.now() }));
  const copy = join(home, "stdin-copy");
  const s = script(
    `tee '${copy}' | sed -n 's/.*"display_name": *"\\([^"]*\\)".*/\\1/p'`,
  );
  const r = await run(["--chain", s]);
  expect(r.code).toBe(0);
  const head = "Opus | agentroom * eeeeeeee | 2 unread (1 need you)";
  expect(r.out.slice(0, head.length)).toBe(head);
  expect(readFileSync(copy, "utf8")).toBe(FIXTURE);
  writeRoomSettings(home, ROOM, { v: 1, delivery: "manual" });
  expect((await run([])).out.endsWith(" | manual\n")).toBe(true);
});

test("a failing or slow chained command contributes nothing", async () => {
  writeRoomFile(home, room);
  setCurrent(home, ROOM);
  for (const body of ["echo nope; exit 1", "sleep 3; echo late"]) {
    const r = await run(["--chain", script(body)]);
    expect(r.out.startsWith("agentroom * eeeeeeee")).toBe(true);
  }
}, 10_000);

test("no room: only the chained output; neither: an empty line", async () => {
  expect(await run(["--chain", script("echo mine")])).toEqual({
    code: 0,
    out: "mine\n",
  });
  setCurrent(home, ROOM);
  expect(await run([])).toEqual({ code: 0, out: "\n" });
  expect(roomDir(home, ROOM)).toContain(home);
});
