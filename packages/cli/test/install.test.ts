import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setCurrent, writeRoomFile } from "@agentroom/mcp";
import { type RelayHandle, startRelay } from "@agentroom/relay-node";
import { afterEach, beforeEach, expect, test } from "vitest";
import { mcpServerCommand } from "../src/commands/install.js";
import { main } from "../src/index.js";
import { codeFrom, makeCtx, remove, tempDir } from "./helpers.js";

const ROOM = "d".repeat(64);
const SEP = "<<END>>";
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) remove(d);
});

function dir(): string {
  const d = tempDir();
  dirs.push(d);
  return d;
}

/** A PATH holding only a fake `claude` that records argv and fails on demand. */
function fakeClaude(): { path: string; log: string } {
  const bin = dir();
  const log = join(bin, "argv.log");
  const script = `#!/bin/sh
printf '%s\\n' "$@" >> "$CLAUDE_FAKE_LOG"
printf '%s\\n' "${SEP}" >> "$CLAUDE_FAKE_LOG"
if [ "$2" = "remove" ] && [ -n "$FAKE_REMOVE_FAIL" ]; then exit 1; fi
if [ "$2" = "add" ] && [ -n "$FAKE_ADD_FAIL" ]; then echo "add exploded" >&2; exit 1; fi
exit 0
`;
  writeFileSync(join(bin, "claude"), script);
  chmodSync(join(bin, "claude"), 0o755);
  return { path: bin, log };
}

function calls(log: string): string[][] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split(`${SEP}\n`)
    .filter((c) => c.length > 0)
    .map((c) => c.replace(/\n$/, "").split("\n"));
}

function homeWithRoom(): string {
  const home = dir();
  writeRoomFile(home, {
    v: 1,
    roomId: ROOM,
    secret: "ar1_x",
    relay: "ws://127.0.0.1:1",
    member: "alice",
    agent: "claude-code",
    createdByMe: true,
  });
  setCurrent(home, ROOM);
  return home;
}

test("mcpServerCommand uses npx when installed and the absolute checkout path otherwise", () => {
  expect(
    mcpServerCommand("/x/node_modules/agentroom/dist/bin.js", ROOM, "/n"),
  ).toEqual({
    command: "npx",
    args: ["-y", "agentroom", "mcp", "--room", ROOM],
  });
  expect(
    mcpServerCommand(
      "/src/agentroom/packages/cli/dist/bin.js",
      ROOM,
      "/usr/bin/node",
    ),
  ).toEqual({
    command: "/usr/bin/node",
    args: ["/src/agentroom/packages/cli/dist/bin.js", "mcp", "--room", ROOM],
  });
});

test("install claude runs remove then add with an exact argument array (checkout entry)", async () => {
  const home = homeWithRoom();
  const fake = fakeClaude();
  const entry = "/opt/checkout/packages/cli/dist/bin.js";
  const t = makeCtx(home, {
    env: { PATH: fake.path, CLAUDE_FAKE_LOG: fake.log },
    entryPath: entry,
  });
  expect(await main(["install", "claude", "--room", ROOM], t.ctx)).toBe(0);
  expect(calls(fake.log)).toEqual([
    ["mcp", "remove", "--scope", "user", "agentroom"],
    [
      "mcp",
      "add",
      "--scope",
      "user",
      "--transport",
      "stdio",
      "agentroom",
      "--",
      process.execPath,
      entry,
      "mcp",
      "--room",
      ROOM,
    ],
  ]);
  expect(t.out()).toContain("Restart Claude Code");
});

test("an entry inside node_modules registers npx -y agentroom", async () => {
  const home = homeWithRoom();
  const fake = fakeClaude();
  const t = makeCtx(home, {
    env: { PATH: fake.path, CLAUDE_FAKE_LOG: fake.log },
    entryPath: "/Users/x/.npm/_npx/abc/node_modules/agentroom/dist/bin.js",
  });
  expect(await main(["install", "claude"], t.ctx)).toBe(0);
  expect(calls(fake.log)[1]?.slice(7)).toEqual([
    "--",
    "npx",
    "-y",
    "agentroom",
    "mcp",
    "--room",
    ROOM,
  ]);
});

test("a failing remove still proceeds to add; a failing add exits non-zero with its stderr", async () => {
  const home = homeWithRoom();
  const fake = fakeClaude();
  const ok = makeCtx(home, {
    env: { PATH: fake.path, CLAUDE_FAKE_LOG: fake.log, FAKE_REMOVE_FAIL: "1" },
  });
  expect(await main(["install", "claude"], ok.ctx)).toBe(0);
  expect(calls(fake.log)).toHaveLength(2);

  const fake2 = fakeClaude();
  const bad = makeCtx(home, {
    env: { PATH: fake2.path, CLAUDE_FAKE_LOG: fake2.log, FAKE_ADD_FAIL: "1" },
  });
  expect(await main(["install", "claude"], bad.ctx)).toBe(1);
  expect(bad.err()).toContain("add exploded");
  expect(calls(fake2.log)).toHaveLength(2);
});

test("without claude on PATH, install merges into an existing .mcp.json and warns not to commit it", async () => {
  const home = homeWithRoom();
  const cwd = dir();
  const file = join(cwd, ".mcp.json");
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: { other: { type: "stdio", command: "other-server" } },
    }),
  );
  const t = makeCtx(home, { cwd, entryPath: "/opt/checkout/dist/bin.js" });
  expect(await main(["install", "claude"], t.ctx)).toBe(0);
  const written = JSON.parse(readFileSync(file, "utf8")) as {
    mcpServers: Record<string, unknown>;
  };
  expect(written.mcpServers.other).toEqual({
    type: "stdio",
    command: "other-server",
  });
  expect(written.mcpServers.agentroom).toEqual({
    type: "stdio",
    command: process.execPath,
    args: ["/opt/checkout/dist/bin.js", "mcp", "--room", ROOM],
  });
  expect(t.out()).toContain(file);
  expect(t.out()).toContain("Do not commit");
});

test("an invalid .mcp.json is left byte-for-byte unchanged and install fails", async () => {
  const home = homeWithRoom();
  const cwd = dir();
  const file = join(cwd, ".mcp.json");
  const garbage = '{"mcpServers": ';
  writeFileSync(file, garbage);
  const t = makeCtx(home, { cwd });
  expect(await main(["install", "claude"], t.ctx)).toBe(1);
  expect(readFileSync(file, "utf8")).toBe(garbage);
  expect(t.err()).toContain("not a JSON object");
});

test("install rejects other agents and a missing room", async () => {
  const home = dir();
  const t = makeCtx(home);
  expect(await main(["install", "codex"], t.ctx)).toBe(2);
  expect(t.err()).toContain('only "claude"');
  const none = makeCtx(home);
  expect(await main(["install", "claude"], none.ctx)).toBe(1);
  expect(none.err()).toContain("no room to install");
});

let relay: RelayHandle;
beforeEach(async () => {
  relay = await startRelay({ port: 0, log: () => {} });
});
afterEach(async () => {
  await relay.close();
});

test("up --agent claude runs the install for the new room id", async () => {
  const home = dir();
  const fake = fakeClaude();
  const t = makeCtx(home, {
    env: { PATH: fake.path, CLAUDE_FAKE_LOG: fake.log },
  });
  expect(
    await main(["up", "--relay", relay.url, "--agent", "claude"], t.ctx),
  ).toBe(0);
  const code = codeFrom(t.out());
  expect(code.startsWith("ar1_")).toBe(true);
  const add = calls(fake.log)[1];
  expect(add?.slice(0, 2)).toEqual(["mcp", "add"]);
  const roomId = add?.at(-1);
  expect(roomId).toMatch(/^[0-9a-f]{64}$/);
  expect(existsSync(join(home, "rooms", roomId as string, "room.json"))).toBe(
    true,
  );
  expect(t.out()).toContain("Registered the agentroom MCP server");
});
