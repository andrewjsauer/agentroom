import { parseArgs } from "node:util";

export const USAGE = `Usage: agentroom <command> [options]

Commands:
  up [--agent claude|codex|gemini|cursor] [--name <member>] [--relay <url>] [--max-chain <n>] [--ttl <n>h|<n>m]
      Create a room, print its share code, and register the MCP server.
      --ttl sets the room's max age (default and ceiling 24h).
  join [code] [--agent ...] [--name <member>] [--relay <url>]
      Join a room with a share code (prompts for it when omitted on a terminal).
  status [--room <id>]
      Show the current room, live connections, expiry, and unread counts.
  say [--thread <id> | --new] [--room <id>] <text>
      Post your own words, tagged as you (needs an interactive terminal).
      Replies to the most recently updated thread unless --thread or --new is given.
  approve <thread> [--room <id>]
      Approve a thread blocked by the chain limit (needs an interactive terminal).
  down [--room <id>]
      Close the room now (creator only). Run \`agentroom export\` first if you need a record.
  install claude [--room <id>]
      Register the room's MCP server with Claude Code (or write .mcp.json).
  mcp --room <id>
      Serve the room over stdio for an agent (used by the MCP config).

Options:
  --help       Show this help.
  --version    Print the version.
`;

type StringFlags = Record<string, { type: "string" | "boolean" }>;

const OPTIONS = {
  up: {
    agent: { type: "string" },
    name: { type: "string" },
    relay: { type: "string" },
    "max-chain": { type: "string" },
    ttl: { type: "string" },
  },
  join: {
    agent: { type: "string" },
    name: { type: "string" },
    relay: { type: "string" },
  },
  status: { room: { type: "string" } },
  say: {
    thread: { type: "string" },
    new: { type: "boolean" },
    room: { type: "string" },
  },
  approve: { room: { type: "string" } },
  down: { room: { type: "string" } },
  install: { room: { type: "string" } },
  mcp: { room: { type: "string" } },
} satisfies Record<string, StringFlags>;

export type CommandName = keyof typeof OPTIONS;

export interface ParsedArgs {
  command: CommandName | "help" | "version";
  positionals: string[];
  values: Record<string, string | undefined>;
}

/**
 * Parse argv into a command, its positionals and flags. Throws with a usage message.
 * A boolean flag that is present reads as the string "true".
 */
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
    values: Object.fromEntries(
      Object.entries(parsed.values).map(([k, v]) => [
        k,
        v === true ? "true" : (v as string | undefined),
      ]),
    ),
  };
}
