import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
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
  /** Absolute cwd of `up`/`join`; `between` delivery only reaches sessions inside it. */
  projectDir: z.string().optional(),
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
  /** Ids posted from this machine, written before the put so the echo is recognized as own. */
  z.object({ t: z.literal("sent"), ids: z.array(z.string()) }),
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
  /** Threads at the chain limit (KTD15); optional so older files still parse. */
  waitingOnHuman: z.number().optional(),
  /** Room name from meta, control characters stripped, at most 32 characters. */
  roomName: z.string().optional(),
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
  /** Envelope ids posted from this machine (`sent` records). */
  sentIds: Set<string>;
  lastSeq: number;
  /** Bytes of queue.jsonl up to the last complete line; reading resumes here. */
  bytes: number;
}

/** Rebuild seen ids, history and unread from queue.jsonl. Unparseable lines (a torn tail) are skipped. */
export function replayQueue(home: string, roomId: string): Replay {
  const replay: Replay = {
    seen: new Set(),
    history: [],
    unread: new Set(),
    sentIds: new Set(),
    lastSeq: 0,
    bytes: 0,
  };
  let buf: Buffer;
  try {
    buf = readFileSync(join(roomDir(home, roomId), "queue.jsonl"));
  } catch {
    return replay;
  }
  replay.bytes = buf.lastIndexOf(10) + 1;
  for (const line of buf.toString("utf8").split("\n")) {
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
    if (rec.t === "sent") {
      for (const id of rec.ids) replay.sentIds.add(id);
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

/**
 * Read records appended to queue.jsonl at or after byte `from` by other processes (KTD14).
 * Returns the ids marked read, the ids sent, and the offset after the last complete line; a torn tail is left
 * for the next call. `msg` lines are ignored: the session already has them.
 */
export function readQueueTail(
  home: string,
  roomId: string,
  from: number,
): { readIds: string[]; sentIds: string[]; bytes: number } {
  // Read only the bytes after `from`: this runs per inbound message, and the queue holds every blob.
  let buf: Buffer;
  try {
    const fd = openSync(join(roomDir(home, roomId), "queue.jsonl"), "r");
    try {
      const size = fstatSync(fd).size;
      buf = Buffer.alloc(Math.max(0, size - from));
      buf = buf.subarray(0, readSync(fd, buf, 0, buf.length, from));
    } finally {
      closeSync(fd);
    }
  } catch {
    return { readIds: [], sentIds: [], bytes: from };
  }
  const end = buf.lastIndexOf(10) + 1;
  if (end === 0) return { readIds: [], sentIds: [], bytes: from };
  const readIds: string[] = [];
  const sentIds: string[] = [];
  for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
    if (!line.includes('"t":"read"') && !line.includes('"t":"sent"')) continue;
    try {
      const rec = QueueRecord.parse(JSON.parse(line));
      if (rec.t === "read") readIds.push(...rec.ids);
      if (rec.t === "sent") sentIds.push(...rec.ids);
    } catch {
      // Unparseable line: skipped, as in replayQueue.
    }
  }
  return { readIds, sentIds, bytes: from + end };
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

export const DeliveryMode = z.enum(["between", "manual"]);
export type DeliveryMode = z.infer<typeof DeliveryMode>;

/** `<room>/settings.json`, written only by the CLI (KTD11). */
export const RoomSettings = z.object({
  v: z.literal(1),
  delivery: DeliveryMode,
});
export type RoomSettings = z.infer<typeof RoomSettings>;

/** The room's settings; a missing or corrupt file reads as the default (`between`). */
export function readRoomSettings(home: string, roomId: string): RoomSettings {
  try {
    return RoomSettings.parse(
      JSON.parse(
        readFileSync(join(roomDir(home, roomId), "settings.json"), "utf8"),
      ),
    );
  } catch {
    return { v: 1, delivery: "between" };
  }
}

export function writeRoomSettings(
  home: string,
  roomId: string,
  settings: RoomSettings,
): void {
  writeAtomic(
    join(roomDir(home, roomId), "settings.json"),
    `${JSON.stringify(RoomSettings.parse(settings))}\n`,
  );
}

export function deleteRoomDir(home: string, roomId: string): void {
  rmSync(roomDir(home, roomId), { recursive: true, force: true });
}
