import { spawnSync } from "node:child_process";
import {
  agentroomHome,
  type DeliveryMode,
  type RoomFile,
  readCurrent,
  readRoomFile,
  readRoomSettings,
  readStatus,
  type StatusFile,
} from "@agentroom/mcp";
import type { CliContext } from "../context.js";
import { readAll } from "../hook/stdin.js";
import { isInside } from "../hook/submit.js";
import { stripTerminal } from "../safe-text.js";

const ACTIVE_MS = 15 * 60_000;
const NAME_CHARS = 24;
const MAX_PEERS = 2;

const name = (s: string) => stripTerminal(s).slice(0, NAME_CHARS);

/** The agentroom status line segment from local files only (KTD17); pure. */
export function statusSegment(opts: {
  room: RoomFile;
  status: StatusFile | undefined;
  delivery: DeliveryMode;
  /** The session's directory from the status line input, when given. */
  cwd: string | undefined;
  now: number;
}): string {
  const { room, status } = opts;
  // Sessions in other projects cannot reach the room (see `servedRoomId`), so show nothing there.
  if (
    room.projectDir !== undefined &&
    opts.cwd !== undefined &&
    !isInside(room.projectDir, opts.cwd)
  ) {
    return "";
  }
  if (status?.connection === "gone") return "agentroom * room closed";
  const label =
    status?.roomName !== undefined && status.roomName !== ""
      ? name(status.roomName)
      : room.roomId.slice(0, 8);
  const parts = [`agentroom * ${label}`];
  if (status) {
    parts.push(`${status.unread} unread (${status.needsYou} need you)`);
    if (status.waitingOnHuman) {
      parts.push(`${status.waitingOnHuman} waiting on a human`);
    }
    const peers = status.members
      .filter(
        (m) => m.member !== room.member && opts.now - m.lastSeen <= ACTIVE_MS,
      )
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map((m) => `${name(m.member)}/${name(m.agent)}`);
    if (peers.length > 0) {
      const shown = peers.slice(0, MAX_PEERS).join(", ");
      const more =
        peers.length > MAX_PEERS ? ` +${peers.length - MAX_PEERS}` : "";
      parts.push(`${shown}${more} active`);
    }
  }
  if (opts.delivery === "manual") parts.push("manual");
  return parts.join(" | ");
}

/** Run the user's original status line command with the same stdin; nothing on failure. */
function runChained(command: string, input: string): string {
  const r = spawnSync("/bin/sh", ["-c", command], {
    input,
    encoding: "utf8",
    timeout: 2_000,
    stdio: ["pipe", "pipe", "ignore"],
  });
  if (r.status !== 0 || typeof r.stdout !== "string") return "";
  return r.stdout.replace(/\n+$/, "");
}

/** `agentroom statusline [--chain <cmd>]`: `<chained> | <segment>`, or either alone. Exit 0. */
export async function statusline(
  values: Record<string, string | undefined>,
  ctx: CliContext,
): Promise<number> {
  const input = await readAll(ctx.stdin, {
    maxBytes: 256 * 1024,
    timeoutMs: 1_000,
  }).catch(() => "");
  const chained =
    values.chain === undefined ? "" : runChained(values.chain, input);
  let segment = "";
  try {
    const home = agentroomHome(ctx.env);
    const roomId = readCurrent(home);
    if (roomId !== undefined) {
      let cwd: string | undefined;
      try {
        const parsed = JSON.parse(input);
        cwd = parsed?.workspace?.current_dir ?? parsed?.cwd;
        if (typeof cwd !== "string") cwd = undefined;
      } catch {
        cwd = undefined;
      }
      segment = statusSegment({
        room: readRoomFile(home, roomId),
        status: readStatus(home, roomId),
        delivery: readRoomSettings(home, roomId).delivery,
        cwd,
        now: Date.now(),
      });
    }
  } catch {
    segment = ""; // No room directory: only the chained output.
  }
  ctx.stdout.write(
    `${[chained, segment].filter((s) => s !== "").join(" | ")}\n`,
  );
  return 0;
}
