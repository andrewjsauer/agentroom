import { chmodSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Envelope } from "@agentroom/protocol";
import { deriveRoom, parseShareCode, seal, ulid } from "@agentroom/protocol";
import { type RelayHandle, startRelay } from "@agentroom/relay-node";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  appendQueue,
  createNotifier,
  createRoomSession,
  notificationText,
  type RoomSession,
  roomDir,
  setCurrent,
  writeRoomFile,
} from "../src/index.js";
import {
  createTestRoom,
  makeHome,
  removeHome,
  sleep,
  type TestRoom,
  until,
} from "./helpers.js";

const calls: [string, string[]][] = [];
const spawn = (c: string, a: string[]) => {
  calls.push([c, a]);
};

const homes: string[] = [];
const home = () => {
  const h = makeHome();
  homes.push(h);
  return h;
};

afterEach(() => {
  calls.length = 0;
  for (const h of homes.splice(0)) removeHome(h);
});

const evil = 'x"; do shell script "touch /tmp/p';

test("macOS: title and text are the last two argv entries; the script is three fixed lines", () => {
  createNotifier({ platform: "darwin", env: {}, spawn })(evil, "body");
  expect(calls).toEqual([
    [
      "osascript",
      [
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        evil,
        "body",
      ],
    ],
  ]);
});

test("Linux with notify-send: --app-name, --, then escaped title and text", () => {
  const bin = home();
  const path = join(bin, "notify-send");
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  createNotifier({ platform: "linux", env: { PATH: bin }, spawn })(
    "t & u",
    "<b>bold</b>",
  );
  expect(calls).toEqual([
    [
      path,
      ["--app-name=agentroom", "--", "t &amp; u", "&lt;b&gt;bold&lt;/b&gt;"],
    ],
  ]);
});

test("Linux without notify-send, Windows, and AGENTROOM_NOTIFY=off spawn nothing", () => {
  createNotifier({ platform: "linux", env: { PATH: home() }, spawn })("t", "x");
  createNotifier({ platform: "win32", env: {}, spawn })("t", "x");
  for (const platform of ["darwin", "linux"] as const) {
    createNotifier({ platform, env: { AGENTROOM_NOTIFY: "off" }, spawn })(
      "t",
      "x",
    );
  }
  expect(calls).toEqual([]);
});

const env = (e: Partial<Envelope>): Envelope => ({
  v: 1,
  id: "i",
  ts: 0,
  from: { member: "bob", agent: "codex", via: "mcp" },
  kind: "question",
  thread: "t",
  body: "",
  refs: [],
  requiresHuman: false,
  ...e,
});

test("preview text has no control characters and at most 80 characters", () => {
  const n = notificationText(
    env({
      body: `\u001b[2K\u0007hi\n\nthere ${"y".repeat(300)}`,
      requiresHuman: true,
      from: { member: "b\u001b‮ob", agent: "codex", via: "mcp" },
    }),
  );
  expect(n.title).toBe("agentroom: bob needs you");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence
  expect(n.text).not.toMatch(/[\u0000-\u001f\u007f]/);
  expect(n.text.startsWith("[2Khi there ")).toBe(true);
  expect(n.text.length).toBe(80);
  expect(notificationText(env({ to: "alice" })).title).toBe(
    "agentroom: question for you from bob",
  );
});

describe("session notifications", () => {
  let relay: RelayHandle;
  let room: TestRoom;
  const sessions: RoomSession[] = [];
  const got: string[][] = [];

  beforeEach(async () => {
    relay = await startRelay({ port: 0, log: () => {} });
    room = await createTestRoom(relay);
  });
  afterEach(async () => {
    for (const s of sessions.splice(0)) s.close();
    got.length = 0;
    await relay.close();
  });

  const start = async (h: string, notifyIntervalMs = 300) => {
    writeRoomFile(h, {
      v: 1,
      roomId: room.roomId,
      secret: room.code,
      relay: relay.url,
      member: "alice",
      agent: "claude-code",
      createdByMe: false,
    });
    setCurrent(h, room.roomId);
    const s = createRoomSession({
      roomId: room.roomId,
      env: { AGENTROOM_HOME: h },
      notify: (title, text) => got.push([title, text]),
      notifyIntervalMs,
    });
    sessions.push(s);
    await until(() => s.status().connection === "live");
    return s;
  };

  /** `local` records the id as sent from this machine first, like a CLI post. */
  const inject = async (e: Partial<Envelope>, h?: string) => {
    const id = ulid();
    if (h) appendQueue(h, room.roomId, [{ t: "sent", ids: [id] }]);
    const { key } = deriveRoom(parseShareCode(room.code));
    relay.inject(
      room.roomId,
      await seal(
        env({ id, thread: id, body: "hello", ...e }),
        key,
        room.roomId,
      ),
    );
    return id;
  };

  test("live needs-you messages notify; others and posts from this machine do not", async () => {
    const h = home();
    const s = await start(h);
    await inject({ requiresHuman: true });
    await inject({ kind: "question", to: "alice" });
    await inject({ to: "carol" });
    await inject({ kind: "presence" });
    await inject(
      {
        requiresHuman: true,
        from: { member: "alice", agent: "human", via: "hook" },
      },
      h,
    );
    await inject(
      {
        requiresHuman: true,
        from: { member: "alice", agent: "codex", via: "mcp" },
      },
      h,
    );
    // Another machine's member also named alice is not this machine: it notifies.
    await inject({
      requiresHuman: true,
      from: { member: "alice", agent: "gemini", via: "mcp" },
    });
    await until(() => (relay.snapshot(room.roomId)?.seq ?? 0) >= 8);
    await until(() => s.status().unread === 5);
    await until(() => got.length === 2);
    await sleep(400);
    // The first notifies at once; the other two coalesce into the next slot.
    expect(got).toEqual([
      ["agentroom: bob needs you", "hello"],
      ["agentroom: 2 new messages need you", "hello"],
    ]);
  });

  test("a flood raises at most one notification per interval, coalescing the rest", async () => {
    const h = home();
    const s = await start(h, 1_000);
    for (let i = 0; i < 20; i++) {
      await inject({ requiresHuman: true, body: `m${i}` });
    }
    await until(() => s.status().unread === 20);
    await sleep(100);
    await until(() => got.length === 2, 5000);
    await sleep(1_200);
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual(["agentroom: bob needs you", "m0"]);
    expect(got[1]).toEqual(["agentroom: 19 new messages need you", "m19"]);
  });

  test("the interval holds across sessions on one room", async () => {
    const h = home();
    const a = await start(h, 60_000);
    const b = await start(h, 60_000);
    await inject({ requiresHuman: true, body: "first" });
    await until(() => a.status().unread === 1 && b.status().unread === 1);
    await inject({ requiresHuman: true, body: "second" });
    await until(() => a.status().unread === 2 && b.status().unread === 2);
    await sleep(100);
    expect(got).toEqual([["agentroom: bob needs you", "first"]]);
  });

  test("two sessions on one room notify once and leave a claim file", async () => {
    const h = home();
    const a = await start(h);
    const b = await start(h);
    await inject({ requiresHuman: true });
    await until(() => a.status().unread === 1 && b.status().unread === 1);
    await sleep(50);
    expect(got).toHaveLength(1);
    expect(readdirSync(join(roomDir(h, room.roomId), "notified"))).toHaveLength(
      1,
    );
  });

  test("a restart's since=0 catch-up does not notify", async () => {
    const h = home();
    await inject({ requiresHuman: true });
    const s = await start(h);
    await until(() => s.status().unread === 1);
    await sleep(50);
    expect(got).toEqual([]);
  });
});
