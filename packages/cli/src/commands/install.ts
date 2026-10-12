import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, sep } from "node:path";
import { type AgentName, agentroomHome, roomExists } from "@agentroom/mcp";
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

/** Locate an executable by scanning PATH directories; no shell is involved. */
export function findOnPath(
  path: string | undefined,
  name: string,
): string | undefined {
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Register the room's MCP server with Claude Code, or fall back to a project `.mcp.json`. */
export function installClaude(roomId: string, ctx: CliContext): number {
  const { command, args } = mcpServerCommand(ctx.entryPath, roomId);
  const claude = findOnPath(ctx.env.PATH, "claude");
  if (claude) {
    // A missing entry makes remove fail; that is fine.
    spawnSync(claude, ["mcp", "remove", "--scope", "user", "agentroom"], {
      env: ctx.env,
      stdio: "ignore",
    });
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
