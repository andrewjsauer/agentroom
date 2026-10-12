import { sep } from "node:path";
import type { AgentName } from "@agentroom/mcp";
import type { CliContext } from "../context.js";

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

/** After `up` or `join` wrote the room: tell the user how their agent reaches it. */
export function afterRoomReady(
  roomId: string,
  _agent: AgentName,
  ctx: CliContext,
): number {
  const { command, args } = mcpServerCommand(ctx.entryPath, roomId);
  ctx.stdout.write(
    `Add this stdio MCP server to your agent as "agentroom":\n  ${command} ${args.join(" ")}\nThen restart your agent session to load the tools.\n`,
  );
  return 0;
}
