import { expect, test } from "vitest";
import {
  removeAgentroomTable,
  setAgentroomTable,
} from "../src/adapters/toml.js";

const F = "/tmp/config.toml";
const entry = { command: "npx", args: ["-y", "agentroom", "mcp"] };
const BLOCK =
  '[mcp_servers.agentroom]\ncommand = "npx"\nargs = ["-y","agentroom","mcp"]\n';

const AE3 = `# my codex config
model = "o5"

[profiles.fast]
model = "o5-mini" # fast

[mcp_servers.other]
command = "other-server"
args = ["--x"]

[mcp_servers.other.env]
TOKEN_NAME = "x"
`;

test("AE3: install keeps everything, a second install is identical, uninstall restores the bytes", () => {
  const once = setAgentroomTable(AE3, F, entry);
  expect(once).toBe(`${AE3}\n${BLOCK}`);
  expect(setAgentroomTable(once, F, entry)).toBe(once);
  expect(removeAgentroomTable(once, F)).toBe(AE3);
});

test("an existing table with an env subtable is replaced, keeping later tables", () => {
  const text = `a = 1\n\n[mcp_servers.agentroom]\ncommand = "old"\n\n[mcp_servers.agentroom.env]\nX = "1"\n\n[after]\nb = 2\n`;
  const out = setAgentroomTable(text, F, entry);
  expect(out).not.toContain("old");
  expect(out).not.toContain('X = "1"');
  expect(out).toContain("[after]\nb = 2\n");
  expect(out.endsWith(BLOCK)).toBe(true);
});

test("a quoted-key header is replaced", () => {
  const text = `[mcp_servers."agentroom"]\ncommand = "old"\n`;
  expect(setAgentroomTable(text, F, entry)).toBe(BLOCK);
  expect(removeAgentroomTable(text, F)).toBe("");
});

test("a header inside a multi-line string is left alone", () => {
  const text = `note = """\n[mcp_servers.agentroom]\ncommand = "x"\n"""\n`;
  expect(removeAgentroomTable(text, F)).toBe(text);
  expect(setAgentroomTable(text, F, entry)).toBe(`${text}\n${BLOCK}`);
});

test.each([
  ["inline table", `mcp_servers = { agentroom = { command = "x" } }\n`],
  ["dotted key at root", `mcp_servers.agentroom.command = "x"\n`],
  [
    "dotted key under [mcp_servers]",
    `[mcp_servers]\nagentroom.command = "x"\n`,
  ],
  ["array of tables", `[[mcp_servers.agentroom]]\ncommand = "x"\n`],
])("refuses the %s form, naming the file", (_name, text) => {
  expect(() => setAgentroomTable(text, F, entry)).toThrow(F);
  expect(() => removeAgentroomTable(text, F)).toThrow(F);
});

test("an empty file gets just the block; values are valid TOML strings", () => {
  expect(setAgentroomTable("", F, entry)).toBe(BLOCK);
  const odd = setAgentroomTable("", F, {
    command: 'C:\\node "x"',
    args: ["a\\b"],
  });
  expect(odd).toContain('command = "C:\\\\node \\"x\\""');
});

test("remove without our table returns the text unchanged", () => {
  expect(removeAgentroomTable(AE3, F)).toBe(AE3);
});

test("headers followed by a comment are recognised", () => {
  const ours = `[mcp_servers.agentroom] # ours\ncommand = "x"\n`;
  expect(setAgentroomTable(ours, F, entry)).toBe(BLOCK);
  const text = `[mcp_servers.agentroom]\ncommand = "x"\n\n[mcp_servers.other] # mine\ncommand = "y"\n`;
  expect(removeAgentroomTable(text, F)).toBe(
    `[mcp_servers.other] # mine\ncommand = "y"\n`,
  );
});

test("the comment above the next table survives removing ours", () => {
  const text = `model = "o5"\n\n[mcp_servers.agentroom]\ncommand = "x"\n\n# my other server\n[mcp_servers.other]\ncommand = "y"\n`;
  const without = `model = "o5"\n\n# my other server\n[mcp_servers.other]\ncommand = "y"\n`;
  expect(removeAgentroomTable(text, F)).toBe(without);
  expect(setAgentroomTable(text, F, entry)).toBe(`${without}\n${BLOCK}`);
});
