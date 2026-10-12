import { expect, test } from "vitest";
import { parseCli, USAGE } from "../src/args.js";
import { DEFAULT_RELAY, main, resolveRelay } from "../src/index.js";
import { makeCtx, remove, tempDir } from "./helpers.js";

test("parses each command with its flags and positionals", () => {
  expect(
    parseCli([
      "up",
      "--agent",
      "codex",
      "--name",
      "a",
      "--relay",
      "ws://r",
      "--max-chain",
      "2",
    ]),
  ).toEqual({
    command: "up",
    positionals: [],
    values: { agent: "codex", name: "a", relay: "ws://r", "max-chain": "2" },
  });
  expect(parseCli(["join", "ar1_x", "--agent", "gemini"])).toEqual({
    command: "join",
    positionals: ["ar1_x"],
    values: { agent: "gemini" },
  });
  expect(parseCli(["status", "--room", "abc"]).values.room).toBe("abc");
  expect(parseCli(["mcp", "--room", "abc"]).command).toBe("mcp");
  expect(parseCli([]).command).toBe("help");
  expect(parseCli(["--help"]).command).toBe("help");
  expect(parseCli(["--version"]).command).toBe("version");
});

test("unknown commands and unknown flags throw", () => {
  expect(() => parseCli(["dance"])).toThrow(/unknown command/);
  expect(() => parseCli(["up", "--log", "x"])).toThrow();
  expect(() => parseCli(["status", "--agent", "codex"])).toThrow();
});

test("main exits 2 with usage on an unknown command and on --log (no logging flag exists)", async () => {
  const home = tempDir();
  try {
    for (const argv of [
      ["dance"],
      ["up", "--log", "/tmp/x"],
      ["status", "--log"],
    ]) {
      const t = makeCtx(home);
      expect(await main(argv, t.ctx)).toBe(2);
      expect(t.err()).toContain("Usage: agentroom");
      expect(t.out()).toBe("");
    }
  } finally {
    remove(home);
  }
});

test("--help prints usage and --version prints the version", async () => {
  const home = tempDir();
  try {
    const h = makeCtx(home);
    expect(await main(["--help"], h.ctx)).toBe(0);
    expect(h.out()).toBe(USAGE);
    const v = makeCtx(home);
    expect(await main(["--version"], v.ctx)).toBe(0);
    expect(v.out()).toMatch(/^\d+\.\d+\.\d+\n$/);
  } finally {
    remove(home);
  }
});

test("relay URL precedence: flag, then AGENTROOM_RELAY, then the default", () => {
  expect(resolveRelay("ws://flag", { AGENTROOM_RELAY: "ws://env" })).toBe(
    "ws://flag",
  );
  expect(resolveRelay(undefined, { AGENTROOM_RELAY: "ws://env" })).toBe(
    "ws://env",
  );
  expect(resolveRelay(undefined, {})).toBe(DEFAULT_RELAY);
  expect(resolveRelay("", {})).toBe(DEFAULT_RELAY);
});
