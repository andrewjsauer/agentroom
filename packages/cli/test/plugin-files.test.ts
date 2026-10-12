import { execFile } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { VERSION } from "../src/index.js";
import { remove, tempDir } from "./helpers.js";

const run = promisify(execFile);
const REPO = resolve(new URL(".", import.meta.url).pathname, "../../..");
const PLUGIN = join(REPO, "plugins/claude-code");
const LAUNCHER = join(PLUGIN, "scripts/agentroom.mjs");
// Claude Code expands this placeholder; the files carry it literally.
const ROOT = ["$", "{CLAUDE_PLUGIN_ROOT}"].join("");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

const HOOK_SKILLS = ["say", "approve", "send", "sync-mode"];
const SKILLS = [...HOOK_SKILLS, "sync", "ask", "handoff"];

test("plugin.json names the plugin agentroom; .mcp.json runs the launcher's mcp in exec form", () => {
  expect(json(join(PLUGIN, ".claude-plugin/plugin.json")).name).toBe(
    "agentroom",
  );
  expect(json(join(PLUGIN, ".mcp.json"))).toEqual({
    mcpServers: {
      agentroom: {
        command: "node",
        args: [`${ROOT}/scripts/agentroom.mjs`, "mcp"],
      },
    },
  });
});

test("hooks.json: two events, exec form through the launcher, the KTD8 matcher, onFailure only on expansion", () => {
  const { hooks } = json(join(PLUGIN, "hooks/hooks.json"));
  expect(Object.keys(hooks).sort()).toEqual([
    "UserPromptExpansion",
    "UserPromptSubmit",
  ]);
  const [exp] = hooks.UserPromptExpansion;
  const [sub] = hooks.UserPromptSubmit;
  expect(exp.hooks).toEqual([
    {
      type: "command",
      command: "node",
      args: [`${ROOT}/scripts/agentroom.mjs`, "hook", "prompt-expansion"],
      timeout: 30,
      onFailure: "block",
    },
  ]);
  expect(sub.matcher).toBeUndefined();
  expect(sub.hooks).toEqual([
    {
      type: "command",
      command: "node",
      args: [`${ROOT}/scripts/agentroom.mjs`, "hook", "prompt-submit"],
      timeout: 30,
    },
  ]);
  const matcher = new RegExp(exp.matcher);
  for (const yes of ["say", "agentroom:say", "sync-mode", "agentroom:send"]) {
    expect(matcher.test(yes)).toBe(true);
  }
  for (const no of ["essay", "deploy", "agentroom:sync"]) {
    expect(matcher.test(no)).toBe(false);
  }
});

function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error("no frontmatter");
  return Object.fromEntries(
    (m[1] as string).split("\n").map((l) => {
      const i = l.indexOf(":");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
}

test("seven user-only skills; hook-handled bodies say nothing was sent; ask and handoff draft", () => {
  expect(readdirSync(join(PLUGIN, "skills")).sort()).toEqual(
    [...SKILLS].sort(),
  );
  for (const name of SKILLS) {
    const text = readFileSync(join(PLUGIN, "skills", name, "SKILL.md"), "utf8");
    const fm = frontmatter(text);
    expect(fm.description, name).toBeTruthy();
    expect(fm["disable-model-invocation"], name).toBe("true");
    expect(text, name).not.toContain("$ARGUMENTS");
    if (HOOK_SKILLS.includes(name)) {
      expect(text, name).toContain("Nothing was sent.");
      expect(text, name).toContain("Do not send, post, or repeat this text");
    }
  }
  for (const name of ["ask", "handoff"]) {
    const text = readFileSync(join(PLUGIN, "skills", name, "SKILL.md"), "utf8");
    expect(text).toContain("draft: true");
    expect(text).toContain("/agentroom:send <hash>");
  }
});

test("the marketplace lists the plugin by a relative source with no ..", () => {
  const market = json(join(REPO, ".claude-plugin/marketplace.json"));
  const [entry] = market.plugins;
  expect(market.plugins).toHaveLength(1);
  expect(entry.source).toBe("./plugins/claude-code");
  expect(entry.source).not.toContain("..");
  expect(entry.name).toBe(
    json(join(PLUGIN, ".claude-plugin/plugin.json")).name,
  );
});

test("the launcher runs the built CLI, and explains a missing build", async () => {
  const { stdout } = await run(process.execPath, [LAUNCHER, "--version"]);
  expect(stdout).toBe(`${VERSION}\n`);
  const dir = realpathSync(tempDir());
  try {
    mkdirSync(join(dir, "a/b/scripts"), { recursive: true });
    const copy = join(dir, "a/b/scripts/agentroom.mjs");
    copyFileSync(LAUNCHER, copy);
    const err = await run(process.execPath, [copy, "--version"]).catch(
      (e: { code: number; stderr: string }) => e,
    );
    expect(err).toMatchObject({ code: 1 });
    expect((err as { stderr: string }).stderr).toContain(
      `agentroom: CLI build not found at ${join(dir, "packages/cli/dist/bin.js")}; run \`pnpm build\` in the agentroom checkout`,
    );
  } finally {
    remove(dir);
  }
});
