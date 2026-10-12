import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { main } from "../src/index.js";
import { makeCtx, remove, tempDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) remove(d);
});

/** A temp HOME plus a temp repo (with .git) whose subdir is the cwd. */
function setup() {
  const home = tempDir();
  const repo = tempDir("agentroom-repo-");
  dirs.push(home, repo);
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, "sub"));
  const t = makeCtx(home, { cwd: join(repo, "sub") });
  expect(t.ctx.env.HOME).toBe(home);
  expect(t.ctx.env.CODEX_HOME).toBeUndefined();
  return { home, repo, t };
}

test("AE4: install cursor --project writes .cursor/mcp.json and appends to AGENTS.md; idempotent; uninstall restores", async () => {
  const { repo, t } = setup();
  const agents = join(repo, "AGENTS.md");
  writeFileSync(agents, "# Team rules\n\nBe kind.\n");
  expect(await main(["install", "cursor", "--project"], t.ctx)).toBe(0);
  const mcp = join(repo, ".cursor", "mcp.json");
  const config = JSON.parse(readFileSync(mcp, "utf8"));
  expect(config.mcpServers.agentroom).toEqual({
    type: "stdio",
    command: process.execPath,
    args: ["/opt/agentroom-checkout/packages/cli/dist/bin.js", "mcp"],
  });
  expect(readFileSync(agents, "utf8")).toContain("<!-- agentroom:start -->");
  expect(t.out()).toContain(`Updated ${mcp}`);
  expect(t.out()).toContain(`Updated ${agents}`);

  const again = makeCtx(t.ctx.env.HOME as string, { cwd: t.ctx.cwd });
  const before = [readFileSync(mcp, "utf8"), readFileSync(agents, "utf8")];
  expect(await main(["install", "cursor", "--project"], again.ctx)).toBe(0);
  expect([readFileSync(mcp, "utf8"), readFileSync(agents, "utf8")]).toEqual(
    before,
  );
  expect(again.out()).toContain("already installed");

  const un = makeCtx(t.ctx.env.HOME as string, { cwd: t.ctx.cwd });
  expect(await main(["uninstall", "cursor", "--project"], un.ctx)).toBe(0);
  expect(readFileSync(agents, "utf8")).toBe("# Team rules\n\nBe kind.\n");
  expect(existsSync(mcp)).toBe(false);
});

test("user scope: codex writes ~/.codex/config.toml, gemini ~/.gemini/settings.json and GEMINI.md", async () => {
  const { home, repo, t } = setup();
  expect(await main(["install", "codex"], t.ctx)).toBe(0);
  const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  expect(toml).toContain("[mcp_servers.agentroom]");
  expect(toml).toContain('"mcp"]');
  expect(existsSync(join(repo, "AGENTS.md"))).toBe(true);
  expect(existsSync(join(repo, ".codex"))).toBe(false);

  const g = makeCtx(home, { cwd: t.ctx.cwd });
  expect(await main(["install", "gemini"], g.ctx)).toBe(0);
  const settings = JSON.parse(
    readFileSync(join(home, ".gemini", "settings.json"), "utf8"),
  );
  expect(settings.mcpServers.agentroom.type).toBeUndefined();
  expect(readFileSync(join(repo, "GEMINI.md"), "utf8")).toContain(
    "call the `inbox` tool",
  );
});

test("CODEX_HOME is honored when set", async () => {
  const { home, t } = setup();
  const codexHome = join(home, "custom-codex");
  const c = makeCtx(home, { cwd: t.ctx.cwd, env: { CODEX_HOME: codexHome } });
  expect(await main(["install", "codex"], c.ctx)).toBe(0);
  expect(existsSync(join(codexHome, "config.toml"))).toBe(true);
});

test("an invalid settings file aborts, names the file, and changes nothing", async () => {
  const { home, repo, t } = setup();
  const file = join(home, ".gemini", "settings.json");
  mkdirSync(join(home, ".gemini"));
  writeFileSync(file, "{broken");
  expect(await main(["install", "gemini"], t.ctx)).toBe(1);
  expect(t.err()).toContain(file);
  expect(readFileSync(file, "utf8")).toBe("{broken");
  expect(existsSync(join(repo, "GEMINI.md"))).toBe(false);
});

test("install bogus exits 2 with usage; uninstall with nothing installed exits 0", async () => {
  const { t } = setup();
  expect(await main(["install", "bogus"], t.ctx)).toBe(2);
  expect(t.err()).toContain("Usage: agentroom");
  const u = makeCtx(t.ctx.env.HOME as string, { cwd: t.ctx.cwd });
  expect(await main(["uninstall", "gemini"], u.ctx)).toBe(0);
  expect(u.out()).toContain("Nothing to remove");
});
