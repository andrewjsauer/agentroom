import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  AGENT_MARKERS,
  HUMAN_MESSAGE_REASON,
  humanFrom,
  requireHumanTerminal,
} from "../src/human.js";
import { CliError } from "../src/index.js";
import { safeBody, safeLine } from "../src/safe-text.js";
import { makeCtx, remove, tempDir } from "./helpers.js";

const guard = (
  env: NodeJS.ProcessEnv,
  isTTY = true,
  stdoutIsTTY = true,
  stdout = true,
) => {
  const home = tempDir();
  try {
    const { ctx } = makeCtx(home, { env, isTTY, stdoutIsTTY });
    requireHumanTerminal(ctx, { stdout, reason: HUMAN_MESSAGE_REASON });
  } finally {
    remove(home);
  }
};

test("every agent marker refuses and is named, even with both TTYs", () => {
  expect(AGENT_MARKERS).toEqual([
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "AI_AGENT",
    "CODEX_THREAD_ID",
    "CODEX_CI",
    "CODEX_SANDBOX",
    "GEMINI_CLI",
    "CURSOR_AGENT",
  ]);
  for (const name of AGENT_MARKERS) {
    expect(() => guard({ [name]: "1" })).toThrow(
      `Refusing: ${name} is set, so this looks like an AI agent's shell.`,
    );
  }
});

test("markers are checked before terminals", () => {
  expect(() => guard({ CODEX_THREAD_ID: "t" }, false, false)).toThrow(
    "CODEX_THREAD_ID is set",
  );
});

test("empty markers and editor-only variables do not refuse", () => {
  expect(() =>
    guard({
      CLAUDECODE: "",
      CURSOR_TRACE_ID: "x",
      CODEX_MANAGED_BY_NPM: "1",
    }),
  ).not.toThrow();
});

test("stdin or stdout not a TTY refuses; export-style guards need stdin only", () => {
  expect(() => guard({}, false, true)).toThrow(CliError);
  expect(() => guard({}, true, false)).toThrow(
    /stdin and stdout must be a TTY/,
  );
  expect(() => guard({}, true, false, false)).not.toThrow();
  expect(() => guard({}, false, true, false)).toThrow(/stdin must be a TTY/);
});

test("safeLine and safeBody remove escape sequences and controls", () => {
  const osc = "\u001b]52;c;cHduZWQ=\u0007";
  expect(safeLine(`T${osc}\u001b[2KX`)).toBe("TX");
  expect(safeLine("x".repeat(200))).toHaveLength(64);
  expect(safeBody(`a\n\tb${osc}\u0000c\u001b[31m`)).toBe("a\n\tbc");
});

test("humanFrom stamps the requested input path", () => {
  const room = { member: "alice" } as Parameters<typeof humanFrom>[0];
  for (const via of ["cli", "hook", "watch"] as const) {
    expect(humanFrom(room, via)).toEqual({
      member: "alice",
      agent: "human",
      via,
    });
  }
});

test("the human builder is used only by the human input paths", () => {
  const dir = new URL("../src/", import.meta.url);
  const users: string[] = [];
  const literals: string[] = [];
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const text = readFileSync(join(e.parentPath, e.name), "utf8");
    const rel = relative(fileURLToPath(dir), join(e.parentPath, e.name));
    if (e.name !== "human.ts" && text.includes("humanFrom(")) users.push(rel);
    // Writing the tag: an `agent: "human"` property anywhere but the builder.
    if (e.name !== "human.ts" && /agent:\s*["'`]human["'`]/.test(text)) {
      literals.push(e.name);
    }
  }
  expect(users.sort()).toEqual(["commands/approve.ts", "commands/say.ts"]);
  expect(literals).toEqual([]);
});
