import { describe, expect, test } from "vitest";
import { Envelope, RoomMeta } from "../src/index.js";

const base = {
  v: 1,
  id: "01J00000000000000000000000",
  ts: 1_700_000_000_000,
  from: { member: "alice", agent: "claude-code", via: "mcp" },
  kind: "question",
  thread: "01J00000000000000000000000",
  body: "Which error enum covers timeouts?",
  refs: [
    {
      repo: "client-sdk-ios",
      path: "Sources/SDK/Errors.swift",
      lines: "12-40",
      commit: "a1b2c3d",
    },
  ],
  requiresHuman: false,
};

describe("Envelope", () => {
  test("parses a full envelope with refs", () => {
    expect(Envelope.parse(base)).toEqual(base);
  });

  test.each([
    ["21 refs", { refs: Array(21).fill({ repo: "r", path: "p" }) }],
    ["an 8,001-character body", { body: "x".repeat(8_001) }],
    ["an unknown kind", { kind: "command" }],
    ["an unknown via", { from: { ...base.from, via: "email" } }],
  ])("rejects %s", (_name, patch) => {
    expect(Envelope.safeParse({ ...base, ...patch }).success).toBe(false);
  });

  test("defaults refs to [] and requiresHuman to false", () => {
    const { refs: _r, requiresHuman: _h, ...rest } = base;
    const env = Envelope.parse(rest);
    expect(env.refs).toEqual([]);
    expect(env.requiresHuman).toBe(false);
  });

  test("invariant 6: a file-content field is stripped and never round-trips", () => {
    const env = Envelope.parse({
      ...base,
      file: "contents",
      refs: [{ repo: "r", path: "p", content: "secret code" }],
    });
    expect(Object.keys(env).sort()).toEqual(
      [
        "body",
        "from",
        "id",
        "kind",
        "refs",
        "requiresHuman",
        "thread",
        "ts",
        "v",
      ].sort(),
    );
    expect(JSON.stringify(env)).not.toContain("contents");
    expect(JSON.stringify(env)).not.toContain("secret code");
  });
});

describe("RoomMeta", () => {
  test("defaults maxAgentChain to 3", () => {
    expect(RoomMeta.parse({})).toEqual({ maxAgentChain: 3 });
  });
});
