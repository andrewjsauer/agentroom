import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  type AgentName,
  agentroomHome,
  findOnPath,
  roomExists,
} from "@agentroom/mcp";
import { installStatusLine } from "../claude-settings.js";
import { type CliContext, CliError, resolveRoomId } from "../context.js";

/**
 * The stdio command an agent runs for this room (plan KTD15). From an installed package it is
 * `npx -y agentroom`; from a checkout it is the absolute node binary plus the absolute entry file.
 */
export function mcpServerCommand(
  entryPath: string,
  roomId: string,
  execPath = process.execPath,
): { command: string; args: string[] } {
  const tail = ["mcp", "--room", roomId];
  if (entryPath.split(sep).includes("node_modules")) {
    return { command: "npx", args: ["-y", "agentroom", ...tail] };
  }
  return { command: execPath, args: [entryPath, ...tail] };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Remove the M1 user-scope registration; a missing entry makes this fail, which is fine. */
function removeUserMcp(claude: string, ctx: CliContext): void {
  spawnSync(claude, ["mcp", "remove", "--scope", "user", "agentroom"], {
    env: ctx.env,
    stdio: "ignore",
  });
}

/** M1: register the room's MCP server with `claude mcp add`. */
function registerMcp(claude: string, roomId: string, ctx: CliContext): number {
  const { command, args } = mcpServerCommand(ctx.entryPath, roomId);
  removeUserMcp(claude, ctx);
  const add = spawnSync(
    claude,
    [
      "mcp",
      "add",
      "--scope",
      "user",
      "--transport",
      "stdio",
      "agentroom",
      "--",
      command,
      ...args,
    ],
    { env: ctx.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (add.status !== 0) {
    ctx.stderr.write(
      `agentroom: \`claude mcp add\` failed (exit ${add.status}):\n${add.stderr}`,
    );
    return 1;
  }
  ctx.stdout.write(
    "Registered the agentroom MCP server with Claude Code (user scope). Restart Claude Code to load the tools.\n",
  );
  return 0;
}

/** M1 fallback without `claude` on PATH: a project `.mcp.json` entry. */
function writeProjectMcp(roomId: string, ctx: CliContext): void {
  const { command, args } = mcpServerCommand(ctx.entryPath, roomId);
  const file = join(ctx.cwd, ".mcp.json");
  let config: Record<string, unknown> = {};
  let existing: string | undefined;
  try {
    existing = readFileSync(file, "utf8");
  } catch {
    existing = undefined;
  }
  if (existing !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      parsed = undefined;
    }
    if (!isObject(parsed)) {
      throw new CliError(
        `${file} is not a JSON object; fix or remove it, then rerun \`agentroom install claude\``,
      );
    }
    config = parsed;
  }
  const servers = isObject(config.mcpServers) ? config.mcpServers : {};
  servers.agentroom = { type: "stdio", command, args };
  config.mcpServers = servers;
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  ctx.stdout.write(
    `\`claude\` is not on PATH, so the server was written to ${file} (project scope). Do not commit that file: it names the room id. Restart Claude Code in this directory to load the tools.\n`,
  );
}

/** The checkout root holding the marketplace, when the entry is a checkout's dist/bin.js. */
function checkoutRoot(entryPath: string): string | undefined {
  if (entryPath.split(sep).includes("node_modules")) return undefined;
  const root = resolve(dirname(entryPath), "../../..");
  return existsSync(join(root, ".claude-plugin", "marketplace.json"))
    ? root
    : undefined;
}

function writeStatusLine(ctx: CliContext): void {
  const file = installStatusLine(ctx);
  ctx.stdout.write(
    file === undefined
      ? "Neither CLAUDE_CONFIG_DIR nor HOME is set, so the status line was not installed.\n"
      : `Set the Claude Code status line in ${file} (your previous one, if any, is chained).\n`,
  );
}

/**
 * Set Claude Code up (KTD3): from a checkout with `claude` on PATH, install the plugin from the
 * repo-root marketplace; from an npm copy, register the MCP server (M1); without `claude`,
 * write `.mcp.json` (M1). The status line is written for checkout entries.
 */
function installClaude(roomId: string, ctx: CliContext): number {
  const claude = findOnPath(ctx.env.PATH, "claude");
  const root = checkoutRoot(ctx.entryPath);
  const npm = ctx.entryPath.split(sep).includes("node_modules");
  if (claude && root) {
    removeUserMcp(claude, ctx);
    const r = spawnSync(
      claude,
      [
        "plugin",
        "install",
        "agentroom",
        "--marketplace",
        root,
        "--scope",
        "user",
      ],
      { env: ctx.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (r.status !== 0) {
      ctx.stderr.write(
        `agentroom: \`claude plugin install\` failed (exit ${r.status}):\n${r.stderr}`,
      );
      return 1;
    }
    writeStatusLine(ctx);
    ctx.stdout.write(
      "Installed the agentroom Claude Code plugin (user scope). Restart Claude Code to load the agentroom plugin (or run /reload-plugins), then type /agentroom:sync.\n",
    );
    return 0;
  }
  if (claude) {
    const code = registerMcp(claude, roomId, ctx);
    if (code !== 0) return code;
    if (npm) {
      ctx.stdout.write(
        "The Claude Code plugin (hooks, /agentroom commands, status line) installs from a checkout for now; npm installs get it with the npm release.\n",
      );
    } else {
      writeStatusLine(ctx);
    }
    return 0;
  }
  writeProjectMcp(roomId, ctx);
  if (!npm) {
    writeStatusLine(ctx);
    if (root) {
      ctx.stdout.write(
        `To load the plugin, start Claude Code with: claude --plugin-dir ${join(root, "plugins", "claude-code")}\n`,
      );
    }
  }
  return 0;
}

/** `agentroom install <agent> [--room <id>]`. */
export function install(
  positionals: string[],
  values: Record<string, string | undefined>,
  ctx: CliContext,
): number {
  const target = positionals[0];
  if (target !== "claude") {
    throw new CliError(
      `install supports only "claude" in this version${target ? ` (got "${target}")` : ""}`,
      2,
    );
  }
  const roomId = resolveRoomId(values.room, ctx);
  if (roomId === undefined || !roomExists(agentroomHome(ctx.env), roomId)) {
    throw new CliError(
      "no room to install; run `agentroom up` or `agentroom join <code>` first, or pass --room <id>",
    );
  }
  return installClaude(roomId, ctx);
}

/** After `up` or `join` wrote the room: install for Claude Code, or tell the user the command. */
export function afterRoomReady(
  roomId: string,
  agent: AgentName,
  ctx: CliContext,
): number {
  if (agent === "claude-code") return installClaude(roomId, ctx);
  const { command, args } = mcpServerCommand(ctx.entryPath, roomId);
  ctx.stdout.write(
    `Add this stdio MCP server to your agent as "agentroom":\n  ${command} ${args.join(" ")}\nThen restart your agent session to load the tools.\n`,
  );
  return 0;
}
