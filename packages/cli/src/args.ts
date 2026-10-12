import { parseArgs } from "node:util";

export const USAGE = `Usage: agentroom <command> [options]

Commands:
  up [--agent claude|codex|gemini|cursor] [--name <member>] [--relay <url>] [--max-chain <n>]
      Create a room, print its share code, and register the MCP server.
  join [code] [--agent ...] [--name <member>] [--relay <url>]
      Join a room with a share code (prompts for it when omitted on a terminal).
  status [--room <id>]
      Show the current room, live connections, expiry, and unread counts.
  install claude [--room <id>]
      Register the room's MCP server with Claude Code (or write .mcp.json).
  mcp --room <id>
      Serve the room over stdio for an agent (used by the MCP config).

Options:
  --help       Show this help.
  --version    Print the version.
`;

type StringFlags = Record<string, { type: "string" }>;

const OPTIONS = {
  up: {
    agent: { type: "string" },
    name: { type: "string" },
    relay: { type: "string" },
    "max-chain": { type: "string" },
  },
  join: {
    agent: { type: "string" },
    name: { type: "string" },
    relay: { type: "string" },
  },
  status: { room: { type: "string" } },
  install: { room: { type: "string" } },
  mcp: { room: { type: "string" } },
} satisfies Record<string, StringFlags>;

export type CommandName = keyof typeof OPTIONS;

export interface ParsedArgs {
  command: CommandName | "help" | "version";
  positionals: string[];
  values: Record<string, string | undefined>;
}

/** Parse argv into a command, its positionals and string flags. Throws with a usage message. */
export function parseCli(argv: string[]): ParsedArgs {
  const first = argv[0];
  if (first === undefined || first === "--help" || first === "-h") {
    return { command: "help", positionals: [], values: {} };
  }
  if (first === "--version" || first === "-v") {
    return { command: "version", positionals: [], values: {} };
  }
  const options = (OPTIONS as Record<string, StringFlags | undefined>)[first];
  if (!options) throw new Error(`unknown command "${first}"`);
  const parsed = parseArgs({
    args: argv.slice(1),
    options,
    allowPositionals: true,
    strict: true,
  });
  return {
    command: first as CommandName,
    positionals: parsed.positionals,
    values: parsed.values as Record<string, string | undefined>,
  };
}
