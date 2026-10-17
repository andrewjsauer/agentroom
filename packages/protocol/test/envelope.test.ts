import { describe, expect, test } from "vitest";
import {
  Envelope,
  isoTime,
  isRepoRelative,
  MAX_TIME_MS,
  RoomMeta,
  ulid,
} from "../src/index.js";

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

describe("string limits", () => {
  const ref = base.refs[0] as Record<string, string>;
  test.each([
    ["a 65-character id", { id: "x".repeat(65) }],
    ["a 65-character thread", { thread: "x".repeat(65) }],
    ["a 65-character replyTo", { replyTo: "x".repeat(65) }],
    ["a 65-character to", { to: "x".repeat(65) }],
    [
      "a 65-character member",
      { from: { ...base.from, member: "m".repeat(65) } },
    ],
    [
      "a 50,000-character member",
      { from: { ...base.from, member: "m".repeat(50_000) } },
    ],
    ["a 65-character agent", { from: { ...base.from, agent: "a".repeat(65) } }],
    ["a 129-character ref repo", { refs: [{ ...ref, repo: "r".repeat(129) }] }],
    ["a 513-character ref path", { refs: [{ ...ref, path: "p".repeat(513) }] }],
    [
      "42 KB of code in a ref path",
      { refs: [{ ...ref, path: "x;\n".repeat(14_000) }] },
    ],
    ["a 65-character ref lines", { refs: [{ ...ref, lines: "1".repeat(65) }] }],
    [
      "a 65-character ref commit",
      { refs: [{ ...ref, commit: "c".repeat(65) }] },
    ],
  ])("rejects %s", (_name, patch) => {
    expect(Envelope.safeParse({ ...base, ...patch }).success).toBe(false);
  });

  test("accepts every field at its maximum", () => {
    const env = Envelope.parse({
      ...base,
      id: "i".repeat(64),
      thread: "t".repeat(64),
      replyTo: "r".repeat(64),
      to: "o".repeat(64),
      from: { ...base.from, member: "m".repeat(64), agent: "a".repeat(64) },
      refs: [
        {
          repo: "r".repeat(128),
          path: "p".repeat(512),
          lines: "1".repeat(64),
          commit: "c".repeat(64),
        },
      ],
    });
    expect(env.refs[0]?.path).toHaveLength(512);
  });

  test("a ULID id fits", () => {
    expect(
      Envelope.parse({ ...base, id: ulid(), thread: ulid() }),
    ).toBeTruthy();
  });

  test.each([
    "/etc/passwd",
    "\\\\server\\share\\x",
    "C:\\Users\\me\\x.ts",
    "c:/x.ts",
    "../outside.ts",
    "src/../../outside.ts",
    "src\\..\\..\\x",
    "..",
  ])("rejects the non-repo-relative ref path %s", (path) => {
    expect(isRepoRelative(path)).toBe(false);
    expect(
      Envelope.safeParse({ ...base, refs: [{ repo: "r", path }] }).success,
    ).toBe(false);
  });

  test.each(["src/a.ts", "a..b/c.ts", ".github/workflows/ci.yml", "x"])(
    "accepts the repo-relative ref path %s",
    (path) => {
      expect(
        Envelope.safeParse({ ...base, refs: [{ repo: "r", path }] }).success,
      ).toBe(true);
    },
  );
});

describe("ts", () => {
  test.each([
    ["1e20", 1e20],
    ["a negative time", -1],
    ["a fraction", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects %s", (_name, ts) => {
    expect(Envelope.safeParse({ ...base, ts }).success).toBe(false);
  });

  test("accepts 0 and the largest Date time", () => {
    expect(Envelope.parse({ ...base, ts: 0 }).ts).toBe(0);
    expect(Envelope.parse({ ...base, ts: MAX_TIME_MS }).ts).toBe(MAX_TIME_MS);
  });
});

describe("isoTime", () => {
  test("formats an in-range time", () => {
    expect(isoTime(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(isoTime(MAX_TIME_MS)).toBe("+275760-09-13T00:00:00.000Z");
  });

  test.each([null, undefined, 1e20, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "returns unknown for %s and never throws",
    (ms) => {
      expect(isoTime(ms)).toBe("unknown");
    },
  );
});

describe("RoomMeta", () => {
  test("defaults maxAgentChain to 3", () => {
    expect(RoomMeta.parse({})).toEqual({ maxAgentChain: 3 });
  });

  test("maxAgentChain must be an integer from 1 to 10", () => {
    for (const bad of [0, 11, 1_000_000, 2.5]) {
      expect(RoomMeta.safeParse({ maxAgentChain: bad }).success).toBe(false);
    }
    for (const ok of [1, 10]) {
      expect(RoomMeta.parse({ maxAgentChain: ok }).maxAgentChain).toBe(ok);
    }
  });
});
