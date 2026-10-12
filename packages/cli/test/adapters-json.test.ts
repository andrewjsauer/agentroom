import { expect, test } from "vitest";
import { removeJsonEntry, setJsonEntry } from "../src/adapters/json-config.js";
import { removeBlock, SNIPPET, upsertBlock } from "../src/adapters/snippet.js";

const F = "/tmp/settings.json";
const entry = { command: "npx", args: ["-y", "agentroom", "mcp"] };

test("sets mcpServers.agentroom, keeping other servers and keys; idempotent", () => {
  const text = `${JSON.stringify({ theme: "dark", mcpServers: { other: { command: "o" } } }, null, 2)}\n`;
  const out = setJsonEntry(text, F, entry);
  expect(JSON.parse(out)).toEqual({
    theme: "dark",
    mcpServers: { other: { command: "o" }, agentroom: entry },
  });
  expect(setJsonEntry(out, F, entry)).toBe(out);
  expect(removeJsonEntry(out, F)).toBe(text);
});

test("Cursor's stdio type is carried; a missing file starts empty", () => {
  const out = setJsonEntry("", F, { type: "stdio", ...entry });
  expect(JSON.parse(out)).toEqual({
    mcpServers: { agentroom: { type: "stdio", ...entry } },
  });
  expect(removeJsonEntry(out, F)).toBe("");
});

test("removing the last entry drops mcpServers but keeps other keys", () => {
  const out = setJsonEntry('{"a":1}', F, entry);
  expect(removeJsonEntry(out, F)).toBe('{\n  "a": 1\n}\n');
});

test("invalid JSON or a non-object aborts naming the file", () => {
  expect(() => setJsonEntry("{nope", F, entry)).toThrow(F);
  expect(() => setJsonEntry("[1]", F, entry)).toThrow(F);
  expect(() => removeJsonEntry("{nope", F)).toThrow(F);
});

test("remove with nothing installed returns the text unchanged", () => {
  expect(removeJsonEntry('{"a":1}', F)).toBe('{"a":1}');
});

const BLOCK = `<!-- agentroom:start -->\n${SNIPPET}\n<!-- agentroom:end -->\n`;

test("snippet: create, append, replace, idempotent, remove", () => {
  expect(upsertBlock("")).toBe(BLOCK);
  const user = "# Notes\n\nuser text\n";
  const appended = upsertBlock(user);
  expect(appended).toBe(`${user}\n${BLOCK}`);
  expect(upsertBlock(appended)).toBe(appended);
  expect(removeBlock(appended)).toBe(user);
  const stale = `${user}\n<!-- agentroom:start -->\nold\n<!-- agentroom:end -->\n\nmore\n`;
  expect(upsertBlock(stale)).toBe(`${user}\n${BLOCK}\nmore\n`);
  expect(removeBlock(stale)).toBe(`${user}\n\nmore\n`);
  expect(removeBlock(BLOCK)).toBe("");
  expect(removeBlock(user)).toBe(user);
});

test("a non-object mcpServers is refused, not overwritten", () => {
  expect(() => setJsonEntry(`{"mcpServers": ["keep"]}\n`, F, entry)).toThrow(F);
});
