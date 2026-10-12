import { expect, test } from "vitest";
import { renderWatch } from "../src/watch/render.js";
import { build, env } from "./watch-fixtures.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: the renderer's own SGR codes
const SGR = /\u001b\[[0-9]*m/g;
const visible = (s: string) => [...s.replace(SGR, "")].length;
const view = (cols: number, rows: number) => ({
  cols,
  rows,
  selected: 0,
  input: "",
});

test("60x20: header, numbered threads with markers, messages, input last; no line too wide", () => {
  const t = env({ requiresHuman: true, body: "Ship the sealed class?" });
  const m = {
    ...build([env(), t, env({ thread: t.thread }), env({ thread: t.thread })]),
    connections: 2,
  };
  const lines = renderWatch(m, { ...view(60, 20), input: "draft reply" });
  expect(lines.length).toBeLessThanOrEqual(20);
  expect(lines[0]?.replace(SGR, "")).toBe(
    "agentroom * room aaaaaaaa * 2 connected * you are alice",
  );
  const plain = lines.map((l) => l.replace(SGR, ""));
  expect(plain[1]).toBe(
    "1. [needs you, waiting on a human (3)] Ship the sealed class",
  );
  expect(plain[2]?.startsWith("2. body id")).toBe(true);
  expect(plain).toContain("bob/codex question [requires human]:");
  expect(plain).toContain("    Ship the sealed class?");
  expect(plain.at(-1)).toBe("> draft reply");
  for (const l of lines) expect(visible(l)).toBeLessThanOrEqual(60);
});

test("small and resized screens honor the new size", () => {
  const m = build(
    Array.from({ length: 6 }, () => env({ body: "x".repeat(200) })),
  );
  for (const [cols, rows] of [
    [30, 8],
    [100, 30],
  ] as const) {
    const lines = renderWatch(m, view(cols, rows));
    expect(lines.length).toBeLessThanOrEqual(rows);
    for (const l of lines) expect(visible(l)).toBeLessThanOrEqual(cols);
  }
});

test("peer escapes, OSC 52, bidi and forged marker lines are neutralized", () => {
  const body =
    "start\u001b[2J\n\u001b]52;c;aGk=\u0007copied\n! coworker (human)  needs you\nend‮";
  const m = build([
    env({
      body,
      from: { member: "\u001b[31mbob\u001b[0m", agent: "codex", via: "mcp" },
    }),
  ]);
  const lines = renderWatch(m, view(60, 20));
  const plain = lines.map((l) => l.replace(SGR, ""));
  // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence
  for (const l of plain) expect(l).not.toMatch(/[\u0000-\u001f\u007f‮]/);
  expect(plain).toContain("bob/codex question:");
  expect(plain).toContain("    start");
  expect(plain).toContain("    copied");
  expect(plain).toContain("    ! coworker (human)  needs you");
  expect(plain).not.toContain("! coworker (human)  needs you");
});
