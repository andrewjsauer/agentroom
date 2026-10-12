import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setCurrent, writeRoomFile } from "@agentroom/mcp";
import { afterEach, expect, test } from "vitest";
import { shellQuote } from "../src/claude-settings.js";
import { main } from "../src/index.js";
import { makeCtx, remove, tempDir } from "./helpers.js";

const ROOM = "f".repeat(64);
const SEP = "<<END>>";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) remove(d);
});
const dir = () => {
  const d = tempDir();
  dirs.push(d);
  return d;
};

/** A checkout with a marketplace file and an entry that prints its argv as JSON. */
function checkout(): { root: string; entry: string } {
  const root = dir();
  mkdirSync(join(root, ".claude-plugin"));
  writeFileSync(join(root, ".claude-plugin", "marketplace.json"), "{}");
  const entry = join(root, "packages", "cli", "dist", "bin.js");
  mkdirSync(join(root, "packages", "cli", "dist"), { recursive: true });
  writeFileSync(entry, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  return { root, entry };
}

function fakeClaude(): { path: string; log: string } {
  const bin = dir();
  const log = join(bin, "argv.log");
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh
printf '%s\\n' "$@" >> "$CLAUDE_FAKE_LOG"
printf '%s\\n' "${SEP}" >> "$CLAUDE_FAKE_LOG"
if [ "$1" = "plugin" ] && [ -n "$FAKE_PLUGIN_FAIL" ]; then echo "plugin exploded" >&2; exit 1; fi
exit 0
`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  return { path: bin, log };
}

const calls = (log: string): string[][] =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .split(`${SEP}\n`)
        .filter((c) => c.length > 0)
        .map((c) => c.replace(/\n$/, "").split("\n"))
    : [];

function setup(env: NodeJS.ProcessEnv = {}, entryPath?: string) {
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
  const co = checkout();
  const config = dir();
  const fake = fakeClaude();
  const ctx = (extra: NodeJS.ProcessEnv = {}) =>
    makeCtx(home, {
      env: {
        PATH: fake.path,
        CLAUDE_FAKE_LOG: fake.log,
        CLAUDE_CONFIG_DIR: config,
        ...env,
        ...extra,
      },
      entryPath: entryPath ?? co.entry,
    });
  const settingsFile = join(config, "settings.json");
  return {
    home,
    ...co,
    fake,
    ctx,
    settingsFile,
    settings: () => JSON.parse(readFileSync(settingsFile, "utf8")),
    state: () => join(home, "claude-install.json"),
  };
}

const prefix = (entry: string) =>
  `${shellQuote(process.execPath)} ${shellQuote(entry)}`;

test("with claude and a checkout: mcp remove, then plugin install from the repo-root marketplace", async () => {
  const s = setup();
  const t = s.ctx();
  expect(await main(["install", "claude"], t.ctx)).toBe(0);
  expect(calls(s.fake.log)).toEqual([
    ["mcp", "remove", "--scope", "user", "agentroom"],
    [
      "plugin",
      "install",
      "agentroom",
      "--marketplace",
      s.root,
      "--scope",
      "user",
    ],
  ]);
  expect(t.out()).toContain(
    "Restart Claude Code to load the agentroom plugin (or run /reload-plugins), then type /agentroom:sync.",
  );
});

test("AE6: install twice chains the original; uninstall restores it exactly", async () => {
  const s = setup();
  const original = {
    type: "command",
    command: "~/bin/my-line",
    refreshInterval: 5,
  };
  writeFileSync(
    s.settingsFile,
    JSON.stringify({
      theme: "dark",
      permissions: { allow: ["Bash(ls)"] },
      statusLine: original,
    }),
  );
  expect(await main(["install", "claude"], s.ctx().ctx)).toBe(0);
  const first = readFileSync(s.settingsFile, "utf8");
  const settings = s.settings();
  expect(settings.theme).toBe("dark");
  expect(settings.permissions).toEqual({ allow: ["Bash(ls)"] });
  expect(settings.statusLine).toEqual({
    type: "command",
    command: `${prefix(s.entry)} statusline --chain '~/bin/my-line'`,
    padding: 0,
    refreshInterval: 5,
  });
  expect(await main(["install", "claude"], s.ctx().ctx)).toBe(0);
  expect(readFileSync(s.settingsFile, "utf8")).toBe(first);
  expect(JSON.parse(readFileSync(s.state(), "utf8")).original).toEqual(
    original,
  );
  expect(await main(["uninstall", "claude"], s.ctx().ctx)).toBe(0);
  expect(s.settings().statusLine).toEqual(original);
  expect(existsSync(s.state())).toBe(false);
  expect(calls(s.fake.log).at(-1)).toEqual([
    "plugin",
    "uninstall",
    "agentroom@agentroom",
    "--scope",
    "user",
  ]);
});

test("no existing statusLine: no --chain, refresh 10; uninstall deletes the key", async () => {
  const s = setup();
  await main(["install", "claude"], s.ctx().ctx);
  expect(s.settings().statusLine).toEqual({
    type: "command",
    command: `${prefix(s.entry)} statusline`,
    padding: 0,
    refreshInterval: 10,
  });
  await main(["uninstall", "claude"], s.ctx().ctx);
  expect(s.settings()).toEqual({});
});

test("an original command with a single quote reaches the entry as one argument", async () => {
  const s = setup();
  const original = `echo 'it''s' "x"`;
  writeFileSync(
    s.settingsFile,
    JSON.stringify({ statusLine: { type: "command", command: original } }),
  );
  await main(["install", "claude"], s.ctx().ctx);
  const out = execFileSync("/bin/sh", ["-c", s.settings().statusLine.command], {
    encoding: "utf8",
  });
  expect(JSON.parse(out)).toEqual(["statusline", "--chain", original]);
});

test("invalid settings JSON aborts, naming the file, and changes nothing", async () => {
  const s = setup();
  writeFileSync(s.settingsFile, "{oops");
  const t = s.ctx();
  expect(await main(["install", "claude"], t.ctx)).toBe(1);
  expect(t.err()).toContain(s.settingsFile);
  expect(readFileSync(s.settingsFile, "utf8")).toBe("{oops");
});

test("a statusLine changed after install is left alone; the plugin is still removed", async () => {
  const s = setup();
  await main(["install", "claude"], s.ctx().ctx);
  const mine = { type: "command", command: "my-new-line" };
  writeFileSync(s.settingsFile, JSON.stringify({ statusLine: mine }));
  const t = s.ctx();
  expect(await main(["uninstall", "claude"], t.ctx)).toBe(0);
  expect(t.out()).toContain("changed since install; left it as is");
  expect(s.settings().statusLine).toEqual(mine);
  expect(calls(s.fake.log).at(-1)?.slice(0, 2)).toEqual([
    "plugin",
    "uninstall",
  ]);
});

test("a failing plugin install exits 1 with its stderr and writes no status line", async () => {
  const s = setup({ FAKE_PLUGIN_FAIL: "1" });
  const t = s.ctx();
  expect(await main(["install", "claude"], t.ctx)).toBe(1);
  expect(t.err()).toContain("plugin exploded");
  expect(existsSync(s.settingsFile)).toBe(false);
});

test("an npm entry keeps the M1 mcp add path and says the plugin comes with the npm release", async () => {
  const s = setup(
    {},
    "/Users/x/.npm/_npx/abc/node_modules/agentroom/dist/bin.js",
  );
  const t = s.ctx();
  expect(await main(["install", "claude"], t.ctx)).toBe(0);
  expect(calls(s.fake.log)[1]?.slice(0, 2)).toEqual(["mcp", "add"]);
  expect(t.out()).toContain("npm release");
  expect(existsSync(s.settingsFile)).toBe(false);
});

test("without claude: .mcp.json, the status line, and the --plugin-dir line", async () => {
  const s = setup();
  const t = s.ctx({ PATH: dir() });
  expect(await main(["install", "claude"], t.ctx)).toBe(0);
  expect(existsSync(join(t.ctx.cwd, ".mcp.json"))).toBe(true);
  expect(s.settings().statusLine.command).toContain(" statusline");
  expect(t.out()).toContain(
    `claude --plugin-dir ${join(s.root, "plugins", "claude-code")}`,
  );
});
