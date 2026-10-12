import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Envelope, RoomId } from "@agentroom/protocol";
import { z } from "zod";
import { currentPath, roomDir } from "./paths.js";

/** Agents this MCP server can speak as. There is deliberately no human value (invariant 2). */
export const AgentName = z.enum([
  "claude-code",
  "codex",
  "gemini",
  "cursor",
  "other",
]);
export type AgentName = z.infer<typeof AgentName>;

export const RoomFile = z.object({
  v: z.literal(1),
  roomId: RoomId,
  secret: z.string(),
  relay: z.string(),
  member: z.string().min(1),
  agent: AgentName,
  createdByMe: z.boolean(),
  closeSecretKey: z.string().optional(),
});
export type RoomFile = z.infer<typeof RoomFile>;

export const QueueRecord = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("msg"),
    seq: z.number().int(),
    env: Envelope,
    own: z.boolean(),
  }),
  z.object({ t: z.literal("read"), ids: z.array(z.string()) }),
]);
export type QueueRecord = z.infer<typeof QueueRecord>;

export interface StoredMessage {
  seq: number;
  env: Envelope;
  own: boolean;
}

export const StatusFile = z.object({
  connection: z.enum(["connecting", "live", "backoff", "gone"]),
  connections: z.number(),
  members: z.array(
    z.object({ member: z.string(), agent: z.string(), lastSeen: z.number() }),
  ),
  unread: z.number(),
  needsYou: z.number(),
  decryptFailures: z.number(),
  expiresAt: z.number().nullable(),
  lastSeq: z.number(),
  updatedAt: z.number(),
});
export type StatusFile = z.infer<typeof StatusFile>;

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export function writeAtomic(path: string, data: string): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export function writeRoomFile(home: string, room: RoomFile): void {
  ensureDir(home);
  ensureDir(join(home, "rooms"));
  writeAtomic(
    join(roomDir(home, room.roomId), "room.json"),
    `${JSON.stringify(RoomFile.parse(room), null, 2)}\n`,
  );
}

/** Read and validate room.json; throws on a missing file or schema failure. */
export function readRoomFile(home: string, roomId: string): RoomFile {
  const path = join(roomDir(home, roomId), "room.json");
  return RoomFile.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function roomExists(home: string, roomId: string): boolean {
  return existsSync(join(roomDir(home, roomId), "room.json"));
}

export function setCurrent(home: string, roomId: string): void {
  ensureDir(home);
  writeAtomic(currentPath(home), `${roomId}\n`);
}

export function readCurrent(home: string): string | undefined {
  try {
    const id = readFileSync(currentPath(home), "utf8").trim();
    return RoomId.safeParse(id).success ? id : undefined;
  } catch {
    return undefined;
  }
}

export function clearCurrentIf(home: string, roomId: string): void {
  if (readCurrent(home) === roomId) rmSync(currentPath(home), { force: true });
}

/** Append records with one O_APPEND write. */
export function appendQueue(
  home: string,
  roomId: string,
  records: QueueRecord[],
): void {
  if (records.length === 0) return;
  const lines = records.map((r) => `${JSON.stringify(r)}\n`).join("");
  appendFileSync(join(roomDir(home, roomId), "queue.jsonl"), lines, {
    mode: 0o600,
  });
}

export interface Replay {
  seen: Set<string>;
  history: StoredMessage[];
  unread: Set<string>;
  lastSeq: number;
}

/** Rebuild seen ids, history and unread from queue.jsonl. Unparseable lines (a torn tail) are skipped. */
export function replayQueue(home: string, roomId: string): Replay {
  const replay: Replay = {
    seen: new Set(),
    history: [],
    unread: new Set(),
    lastSeq: 0,
  };
  let text = "";
  try {
    text = readFileSync(join(roomDir(home, roomId), "queue.jsonl"), "utf8");
  } catch {
    return replay;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    let rec: QueueRecord;
    try {
      rec = QueueRecord.parse(JSON.parse(line));
    } catch {
      continue;
    }
    if (rec.t === "read") {
      for (const id of rec.ids) replay.unread.delete(id);
      continue;
    }
    replay.lastSeq = Math.max(replay.lastSeq, rec.seq);
    if (replay.seen.has(rec.env.id)) continue;
    replay.seen.add(rec.env.id);
    replay.history.push({ seq: rec.seq, env: rec.env, own: rec.own });
    if (!rec.own && rec.env.kind !== "presence") replay.unread.add(rec.env.id);
  }
  return replay;
}

export function writeStatus(
  home: string,
  roomId: string,
  status: StatusFile,
): void {
  writeAtomic(
    join(roomDir(home, roomId), "status.json"),
    `${JSON.stringify(status)}\n`,
  );
}

export function readStatus(
  home: string,
  roomId: string,
): StatusFile | undefined {
  try {
    return StatusFile.parse(
      JSON.parse(
        readFileSync(join(roomDir(home, roomId), "status.json"), "utf8"),
      ),
    );
  } catch {
    return undefined;
  }
}

export function deleteRoomDir(home: string, roomId: string): void {
  rmSync(roomDir(home, roomId), { recursive: true, force: true });
}
