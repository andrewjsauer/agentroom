import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

test("mcpServerCommand is always node plus an absolute entry, never npx", () => {
  for (const entry of [
    "/x/node_modules/@sauerapple/agentroom/dist/bin.js",
    "/src/agentroom/packages/cli/dist/bin.js",
  ]) {
    expect(mcpServerCommand(entry, ROOM, "/usr/bin/node")).toEqual({
      command: "/usr/bin/node",
      args: [entry, "mcp", "--room", ROOM],
    });
  }
  expect(mcpServerCommand("/a/bin.js", undefined, "/n").args).toEqual([
    "/a/bin.js",
    "mcp",
  ]);
});

/** A fake npx cache: `<root>/_npx/abc/node_modules/{@sauerapple/agentroom,ws}` plus a .bin link. */
function fakeNpx(version = "9.8.7"): { entry: string; modules: string } {
  const modules = join(dir(), "_npx", "abc", "node_modules");
  const pkg = join(modules, "@sauerapple", "agentroom");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(pkg, "dist", "bin.js"), "// bin\n");
  mkdirSync(join(modules, "ws"));
  writeFileSync(join(modules, "ws", "index.js"), "// ws\n");
  mkdirSync(join(modules, ".bin"));
  symlinkSync(
    "../@sauerapple/agentroom/dist/bin.js",
    join(modules, ".bin", "agentroom"),
  );
  return { entry: join(pkg, "dist", "bin.js"), modules };
}

test("an npx cache entry is copied with its dependencies to AGENTROOM_HOME/bin/<version> and registered by absolute path", async () => {
  const home = homeWithRoom();
  const fake = fakeClaude();
  const npx = fakeNpx();
  const t = makeCtx(home, {
    env: { PATH: fake.path, CLAUDE_FAKE_LOG: fake.log },
    entryPath: npx.entry,
  });
  expect(await main(["install", "claude"], t.ctx)).toBe(0);
  const dest = join(home, "bin", "9.8.7");
  const copied = join(
    dest,
    "node_modules",
    "@sauerapple",
    "agentroom",
    "dist",
    "bin.js",
  );
  expect(calls(fake.log)[1]?.slice(7)).toEqual([
    "--",
    process.execPath,
    copied,
    "mcp",
    "--room",
    ROOM,
  ]);
  expect(calls(fake.log).flat()).not.toContain("npx");
  expect(
    readFileSync(join(dest, "node_modules", "ws", "index.js"), "utf8"),
  ).toBe("// ws\n");
  expect(readlinkSync(join(dest, "node_modules", ".bin", "agentroom"))).toBe(
    "../@sauerapple/agentroom/dist/bin.js",
  );
  expect(statSync(join(home, "bin")).mode & 0o777).toBe(0o700);
  expect(t.out()).toContain(`runs a copy in ${dest}`);

  // Idempotent: a second install reuses the copy instead of copying again.
  writeFileSync(npx.entry, "// changed\n");
  const again = makeCtx(home, {
    env: { PATH: fake.path, CLAUDE_FAKE_LOG: fake.log },
    entryPath: npx.entry,
  });
  expect(await main(["install", "claude"], again.ctx)).toBe(0);
  expect(readFileSync(copied, "utf8")).toBe("// bin\n");
  expect(calls(fake.log)[3]?.slice(8, 9)).toEqual([process.execPath]);
});

test("an npx entry for codex writes the copied path into config.toml, never npx", async () => {
  const home = dir();
  const npx = fakeNpx("1.2.3");
  const t = makeCtx(home, { entryPath: npx.entry });
  expect(await main(["install", "codex"], t.ctx)).toBe(0);
  const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  expect(toml).not.toContain("npx");
  expect(toml).toContain(
    JSON.stringify(
      join(
        home,
        "bin",
        "1.2.3",
        "node_modules",
        "@sauerapple",
        "agentroom",
        "dist",
        "bin.js",
      ),
    ),
  );
});

test("a global or local install (node_modules outside the npx cache) is registered in place", async () => {
  const home = homeWithRoom();
  const fake = fakeClaude();
  const entry = "/usr/local/lib/node_modules/@sauerapple/agentroom/dist/bin.js";
  const t = makeCtx(home, {
    env: { PATH: fake.path, CLAUDE_FAKE_LOG: fake.log },
    entryPath: entry,
  });
  expect(await main(["install", "claude"], t.ctx)).toBe(0);
  expect(calls(fake.log)[1]?.slice(7)).toEqual([
    "--",
    process.execPath,
    entry,
    "mcp",
    "--room",
    ROOM,
  ]);
  expect(existsSync(join(home, "bin"))).toBe(false);
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
  expect(await main(["install", "bogus"], t.ctx)).toBe(2);
  expect(t.err()).toContain('(got "bogus")');
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
