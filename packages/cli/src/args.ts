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
  export [--thread <id>] [--format md|gh-issue] [--room <id>]
      Write this room's local history as markdown (stdout), or as a GitHub issue body file
      plus the gh command to run (needs an interactive terminal).
  down [--room <id>]
      Close the room now (creator only). Run \`agentroom export\` first if you need a record.
  sync-mode [between|manual|live] [--room <id>]
      Show or set how messages reach Claude Code: at your next prompt (between) or only on request (manual).
  watch [--room <id>]
      Follow every thread in this terminal and reply as yourself (needs an interactive terminal).
  install claude [--room <id>]
      Install the Claude Code plugin and status line (or register the MCP server / write .mcp.json).
  uninstall claude
      Remove the Claude Code plugin and restore your previous status line.

Used by the Claude Code plugin:
  mcp [--room <id>]
      Serve the room (default: the current room) over stdio for an agent.
  hook prompt-expansion|prompt-submit
      Handle a Claude Code hook event read from stdin.
  statusline [--chain <command>]
      Print the status line segment, after the output of an existing status line command.

Options:
  --help       Show this help.
  --version    Print the version.
`;

type FlagSpec = Record<string, { type: "string" | "boolean" }>;

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
  export: {
    thread: { type: "string" },
    format: { type: "string" },
    room: { type: "string" },
  },
  install: { room: { type: "string" } },
  mcp: { room: { type: "string" } },
  hook: {},
  watch: { room: { type: "string" } },
  uninstall: {},
  statusline: { chain: { type: "string" } },
  "sync-mode": { room: { type: "string" } },
} satisfies Record<string, FlagSpec>;

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
  const options = (OPTIONS as Record<string, FlagSpec | undefined>)[first];
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
