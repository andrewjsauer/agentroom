import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendQueue,
  setCurrent,
  writeRoomFile,
  writeStatus,
} from "@agentroom/mcp";
import { type Envelope, Envelope as EnvelopeSchema } from "@agentroom/protocol";
import { afterEach, beforeEach, expect, test } from "vitest";
import { main } from "../src/index.js";
import { makeCtx, remove, tempDir } from "./helpers.js";

const ROOM = "c".repeat(64);
let home: string;
const dirs: string[] = [];
let seq = 0;

beforeEach(() => {
  home = tempDir();
  seq = 0;
  writeRoomFile(home, {
    v: 1,
    roomId: ROOM,
    secret: "ar1_x",
    relay: "ws://127.0.0.1:1",
    member: "alice",
    agent: "codex",
    createdByMe: true,
  });
  setCurrent(home, ROOM);
});

afterEach(() => {
  remove(home);
  for (const d of dirs.splice(0)) remove(d);
});

function add(e: Partial<Envelope> & { thread: string; body: string }) {
  seq++;
  const env = EnvelopeSchema.parse({
    v: 1,
    id: `id${seq}`,
    ts: Date.UTC(2026, 9, 12, 12, 0, seq),
    from: { member: "bob", agent: "codex", via: "mcp" },
    kind: "question",
    ...e,
  });
  appendQueue(home, ROOM, [{ t: "msg", seq, env, own: false }]);
  return env;
}

const tty = (env: NodeJS.ProcessEnv = {}) =>
  makeCtx(home, { isTTY: true, env });

test("md export groups threads in seq order, omits presence, labels humans, fences bodies", async () => {
  add({ thread: "T1", body: "first", kind: "presence" });
  add({ thread: "T1", body: "q-one" });
  add({ thread: "T2", body: "q-two" });
  add({
    thread: "T1",
    body: "human-answer",
    kind: "answer",
    from: { member: "alice", agent: "human", via: "cli" },
  });
  const t = tty();
  expect(await main(["export"], t.ctx)).toBe(0);
  const out = t.out();
  expect(out).not.toContain("first");
  expect(out.indexOf("## Thread `T1`")).toBeLessThan(
    out.indexOf("## Thread `T2`"),
  );
  expect(out.indexOf("q-one")).toBeLessThan(out.indexOf("human-answer"));
  expect(out.indexOf("human-answer")).toBeLessThan(
    out.indexOf("## Thread `T2`"),
  );
  expect(out).toContain("`alice/human` (human), answer");
  expect(out).toContain("```\nq-one\n```");
  expect(out).toContain("# agentroom export: room `cccccccccccc`");
});

test("a body with five backticks is fenced with six or more", async () => {
  add({ thread: "T", body: "a ````` b" });
  const t = tty();
  await main(["export"], t.ctx);
  expect(t.out()).toContain("``````\na ````` b\n``````");
});

test("escape sequences never reach stdout or the export file", async () => {
  const osc = "\u001b]52;c;cHduZWQ=\u0007";
  add({ thread: `T${osc}`, body: `body${osc}\u001b[2Kend` });
  const md = tty();
  await main(["export"], md.ctx);
  expect(md.out()).not.toContain("\u001b");
  expect(md.out()).toContain("bodyend");
  const tmp = tempDir();
  dirs.push(tmp);
  const gh = tty({ TMPDIR: tmp });
  expect(await main(["export", "--format", "gh-issue"], gh.ctx)).toBe(0);
  const path = /--body-file '([^']+)'/.exec(gh.out())?.[1] as string;
  expect(readFileSync(path, "utf8")).not.toContain("\u001b");
});

test("hostile member names and thread ids appear only inside code spans", async () => {
  add({
    thread: "x\n# Forged",
    body: "b",
    from: {
      member: "@octocat ![x](https://e.invalid/p.png)",
      agent: "codex",
      via: "mcp",
    },
  });
  const t = tty();
  await main(["export"], t.ctx);
  expect(t.out()).toContain("## Thread `x# Forged`");
  expect(t.out()).toContain("`@octocat ![x](https://e.invalid/p.png)/codex`");
  expect(t.out()).not.toMatch(/^# Forged/m);
});

test("--thread exports one thread; an unknown thread exits 1", async () => {
  add({ thread: "T1", body: "one" });
  add({ thread: "T2", body: "two" });
  const t = tty();
  expect(await main(["export", "--thread", "T2"], t.ctx)).toBe(0);
  expect(t.out()).toContain("two");
  expect(t.out()).not.toContain("one");
  const bad = tty();
  expect(await main(["export", "--thread", "T9"], bad.ctx)).toBe(1);
  expect(bad.out()).toBe("");
});

test("AE8: gh-issue keeps message text out of the command; sh with a fake gh creates no pwned file", async () => {
  const body = "run $(touch pwned) and `touch pwned` then '; rm -rf ~; '";
  add({ thread: "T", body });
  const tmp = tempDir();
  dirs.push(tmp);
  const t = tty({ TMPDIR: tmp });
  expect(await main(["export", "--format", "gh-issue"], t.ctx)).toBe(0);
  const command = t
    .out()
    .split("\n")
    .find((l) => l.startsWith("gh issue create")) as string;
  expect(command).not.toContain("touch");
  expect(command).not.toContain("rm -rf");

  const path = /--body-file '([^']+)'/.exec(command)?.[1] as string;
  expect(dirname(dirname(path))).toBe(tmp);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  expect(readFileSync(path, "utf8")).toContain(body);

  const bin = tempDir();
  const cwd = tempDir();
  dirs.push(bin, cwd);
  const log = join(cwd, "gh-args");
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${log}"\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  execFileSync("/bin/sh", ["-c", command], {
    cwd,
    env: { PATH: `${bin}:/usr/bin:/bin` },
  });
  const date = new Date().toISOString().slice(0, 10);
  expect(readFileSync(log, "utf8").split("\n")).toEqual([
    "issue",
    "create",
    "--title",
    `agentroom export ${date}`,
    "--body-file",
    path,
    "",
  ]);
  expect(existsSync(join(cwd, "pwned"))).toBe(false);
});

test("a temp path containing a single quote is quoted correctly", async () => {
  add({ thread: "T", body: "b" });
  const tmp = mkdtempSync(join(tmpdir(), "agent'room-"));
  dirs.push(tmp);
  const t = tty({ TMPDIR: tmp });
  expect(await main(["export", "--format", "gh-issue"], t.ctx)).toBe(0);
  const command = t
    .out()
    .split("\n")
    .find((l) => l.startsWith("gh issue create")) as string;
  const echoed = execFileSync(
    "/bin/sh",
    ["-c", command.replace(/^gh issue create/, "printf '%s\\n'")],
    { env: { PATH: "/usr/bin:/bin" } },
  ).toString();
  const lines = echoed.split("\n");
  expect(lines[3]?.startsWith(tmp)).toBe(true);
  expect(existsSync(lines[3] as string)).toBe(true);
});

test("an agent marker or a non-TTY stdin refuses and writes nothing", async () => {
  add({ thread: "T", body: "b" });
  const tmp = tempDir();
  dirs.push(tmp);
  const agent = tty({ CLAUDECODE: "1", TMPDIR: tmp });
  expect(await main(["export", "--format", "gh-issue"], agent.ctx)).toBe(1);
  expect(agent.err()).toContain("CLAUDECODE");
  const pipe = makeCtx(home, { isTTY: false, env: { TMPDIR: tmp } });
  expect(await main(["export"], pipe.ctx)).toBe(1);
  expect(pipe.out()).toBe("");
  expect(readdirSync(tmp)).toEqual([]);
});

test("a queue line with an out-of-range ts from an older version does not break export", async () => {
  const env = add({ thread: "T", body: "fine" });
  appendFileSync(
    join(home, "rooms", ROOM, "queue.jsonl"),
    `${JSON.stringify({ t: "msg", seq: 99, env: { ...env, id: "bad", ts: 1e20, body: "far-future" }, own: false })}\n`,
  );
  const t = tty();
  expect(await main(["export"], t.ctx)).toBe(0);
  expect(t.out()).toContain("fine");
  expect(t.out()).not.toContain("far-future");
});

test("export works within the grace hour after expiry; later any command sweeps the room dir", async () => {
  add({ thread: "T", body: "kept-for-export" });
  const status = {
    connection: "live" as const,
    connections: 1,
    members: [],
    unread: 0,
    needsYou: 0,
    decryptFailures: 0,
    lastSeq: 1,
    updatedAt: 0,
  };
  writeStatus(home, ROOM, { ...status, expiresAt: Date.now() - 60_000 });
  const t = tty();
  expect(await main(["export"], t.ctx)).toBe(0);
  expect(t.out()).toContain("kept-for-export");

  writeStatus(home, ROOM, {
    ...status,
    expiresAt: Date.now() - 2 * 3_600_000,
  });
  // The sweep also waits for the relay's 24 h max age counted from room.json.
  const old = (Date.now() - 25 * 3_600_000 - 1_000) / 1000;
  utimesSync(join(home, "rooms", ROOM, "room.json"), old, old);
  const after = tty();
  await main(["sync-mode"], after.ctx); // Any command but help and version sweeps first.
  expect(existsSync(join(home, "rooms", ROOM))).toBe(false);
  expect(existsSync(join(home, "current"))).toBe(false);
  const again = tty();
  expect(await main(["export"], again.ctx)).toBe(1);
  expect(again.err()).toContain("No local history for this room");
});

test("without a room directory export prints the no-local-history text", async () => {
  remove(join(home, "rooms"));
  const t = tty();
  expect(await main(["export"], t.ctx)).toBe(1);
  expect(t.err()).toContain("No local history for this room");
});
