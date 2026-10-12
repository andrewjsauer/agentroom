import type { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { z } from "zod";
import { readHookInput } from "../src/hook/stdin.js";
import { main } from "../src/index.js";
import { makeCtx, remove, tempDir } from "./helpers.js";

const Schema = z.looseObject({ hook_event_name: z.string() });

function ctxWith(input: string | undefined) {
  const home = tempDir();
  const t = makeCtx(home);
  if (input !== undefined) t.stdin.end(input);
  return { ...t, home };
}

test("valid JSON parses and unknown fields are kept", async () => {
  const t = ctxWith('{"hook_event_name":"UserPromptSubmit","cwd":"/x"}');
  try {
    expect(await readHookInput(t.ctx, Schema)).toEqual({
      hook_event_name: "UserPromptSubmit",
      cwd: "/x",
    });
  } finally {
    remove(t.home);
  }
});

test("invalid JSON, empty input, a wrong shape and oversized input fail clearly", async () => {
  const cases: [string, RegExp][] = [
    ["{nope", /not valid JSON/],
    ["  \n", /empty/],
    ['{"other":1}', /not the expected shape: hook_event_name/],
  ];
  for (const [input, error] of cases) {
    const t = ctxWith(input);
    await expect(readHookInput(t.ctx, Schema)).rejects.toThrow(error);
    remove(t.home);
  }
  const t = ctxWith(`"${"x".repeat(2000)}"`);
  await expect(
    readHookInput(t.ctx, Schema, { maxBytes: 1000, timeoutMs: 5000 }),
  ).rejects.toThrow(/larger than 1000 bytes/);
  remove(t.home);
});

test("stdin that never ends fails after the timeout", async () => {
  const t = ctxWith(undefined);
  (t.stdin as PassThrough).write("{");
  await expect(
    readHookInput(t.ctx, Schema, { maxBytes: 1000, timeoutMs: 50 }),
  ).rejects.toThrow(/did not end within 50 ms/);
  remove(t.home);
});

test("an unknown hook subcommand is a usage error", async () => {
  const home = tempDir();
  try {
    const t = makeCtx(home);
    expect(await main(["hook", "bogus"], t.ctx)).toBe(2);
    expect(t.err()).toContain('unknown hook "bogus"');
    expect(t.err()).toContain("Usage: agentroom");
  } finally {
    remove(home);
  }
});
