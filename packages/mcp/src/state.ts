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
  statSync,
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

/** The one comparison against the human tag in this package; the seal path refuses it (invariant 2). */
export const isHuman = (env: Envelope) =>
  (env.from.agent as string) === "human";

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
  /**
   * Written by compaction: ids of dropped messages, kept so a replayed envelope is still
   * recognized, and `cut` when messages since the last local human message were dropped.
   */
  z.object({
    t: z.literal("seen"),
    ids: z.array(z.string()),
    cut: z.boolean().optional(),
  }),
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

const queuePath = (home: string, roomId: string) =>
  join(roomDir(home, roomId), "queue.jsonl");

/** Append records with one O_APPEND write; returns the bytes written. */
export function appendQueue(
  home: string,
  roomId: string,
  records: QueueRecord[],
): number {
  if (records.length === 0) return 0;
  const lines = records.map((r) => `${JSON.stringify(r)}\n`).join("");
  appendFileSync(queuePath(home, roomId), lines, { mode: 0o600 });
  return Buffer.byteLength(lines);
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
  /** Complete lines read. */
  records: number;
  /** Inode of the file read; compaction replaces the file, so a new inode means read from 0. */
  ino: number;
  /** Compaction dropped messages since the last local human message (see trimHistory). */
  cut: boolean;
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
    records: 0,
    ino: 0,
    cut: false,
  };
  let buf: Buffer;
  try {
    const fd = openSync(queuePath(home, roomId), "r");
    try {
      replay.ino = fstatSync(fd).ino;
      buf = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    return replay;
  }
  replay.bytes = buf.lastIndexOf(10) + 1;
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line) continue;
    replay.records++;
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
    if (rec.t === "seen") {
      for (const id of rec.ids) replay.seen.add(id);
      replay.cut = rec.cut === true;
      continue;
    }
    if (isHuman(rec.env) && replay.sentIds.has(rec.env.id)) {
      replay.cut = false;
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
  ino?: number,
): { readIds: string[]; sentIds: string[]; bytes: number; ino: number } {
  // Read only the bytes after `from`: this runs per inbound message, and the queue holds every blob.
  // When another process compacted the queue (new inode), `from` is meaningless: read from 0.
  let buf: Buffer;
  let fileIno: number;
  try {
    const fd = openSync(queuePath(home, roomId), "r");
    try {
      const st = fstatSync(fd);
      fileIno = st.ino;
      if (ino !== undefined && ino !== fileIno) from = 0;
      buf = Buffer.alloc(Math.max(0, st.size - from));
      buf = buf.subarray(0, readSync(fd, buf, 0, buf.length, from));
    } finally {
      closeSync(fd);
    }
  } catch {
    return { readIds: [], sentIds: [], bytes: from, ino: ino ?? 0 };
  }
  const end = buf.lastIndexOf(10) + 1;
  if (end === 0) return { readIds: [], sentIds: [], bytes: from, ino: fileIno };
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
  return { readIds, sentIds, bytes: from + end, ino: fileIno };
}

/** In-memory history keeps at least this many envelopes... */
export const HISTORY_KEEP = 2_000;
/** ...and at most this many, even when the last local human message is older. */
export const HISTORY_MAX = 5_000;
/** Compact queue.jsonl after this many records or bytes appended since the last compaction. */
export const QUEUE_COMPACT_RECORDS = 5_000;
export const QUEUE_COMPACT_BYTES = 20 * 1024 * 1024;

/**
 * The envelopes to keep, in seq order: the last HISTORY_KEEP, or everything since the last human
 * message posted from this machine when that is more (the hard chain ceiling counts from there),
 * never more than HISTORY_MAX. `cut` is true when that cap dropped messages posted after the last
 * local human message (or there is none), so the ceiling counts over `kept` may be short; the
 * session then treats the room-wide ceiling as reached.
 */
export function trimHistory(
  history: StoredMessage[],
  localIds: ReadonlySet<string>,
): { kept: StoredMessage[]; cut: boolean } {
  const sorted = [...history].sort((a, b) => a.seq - b.seq);
  let since = sorted.length;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const env = (sorted[i] as StoredMessage).env;
    if (isHuman(env) && localIds.has(env.id)) {
      since = sorted.length - i;
      break;
    }
  }
  const keep = Math.min(HISTORY_MAX, Math.max(HISTORY_KEEP, since));
  if (keep >= sorted.length) return { kept: sorted, cut: false };
  return { kept: sorted.slice(sorted.length - keep), cut: since > keep };
}

/**
 * Rewrite queue.jsonl atomically with only what still matters: `msg` records for `history`, one
 * `read` record for its read messages, `sent` ids that are in `history` or not yet echoed, and a
 * `seen` record for every other seen id. Holds `deliver.lock` so the prompt hook cannot append
 * meanwhile; records another process appends to the old file after byte `consumed` are copied
 * over. Returns the new file's inode and the offset to resume tail reads from (before the copied
 * records, so the caller still applies them), or undefined when the lock is busy.
 */
export function compactQueue(
  home: string,
  roomId: string,
  state: {
    history: StoredMessage[];
    seen: ReadonlySet<string>;
    unread: ReadonlySet<string>;
    sentIds: ReadonlySet<string>;
    cut: boolean;
  },
  consumed: number,
): { bytes: number; ino: number } | undefined {
  const dir = roomDir(home, roomId);
  const lock = join(dir, "deliver.lock");
  try {
    closeSync(openSync(lock, "wx", 0o600));
  } catch {
    return undefined;
  }
  try {
    const path = queuePath(home, roomId);
    const old = openSync(path, "r");
    try {
      const kept = new Set(state.history.map((m) => m.env.id));
      const records: QueueRecord[] = state.history.map((m) => ({
        t: "msg",
        seq: m.seq,
        env: m.env,
        own: m.own,
      }));
      records.push({
        t: "read",
        ids: state.history
          .filter((m) => !state.unread.has(m.env.id))
          .map((m) => m.env.id),
      });
      records.push({
        t: "sent",
        ids: [...state.sentIds].filter(
          (id) => kept.has(id) || !state.seen.has(id),
        ),
      });
      records.push({
        t: "seen",
        ids: [...state.seen].filter((id) => !kept.has(id)),
        ...(state.cut ? { cut: true } : {}),
      });
      const content = records.map((r) => `${JSON.stringify(r)}\n`).join("");
      writeAtomic(path, content);
      const size = fstatSync(old).size;
      let tail = Buffer.alloc(Math.max(0, size - consumed));
      tail = tail.subarray(0, readSync(old, tail, 0, tail.length, consumed));
      tail = tail.subarray(0, tail.lastIndexOf(10) + 1);
      if (tail.length > 0) appendFileSync(path, tail, { mode: 0o600 });
      return {
        bytes: Buffer.byteLength(content),
        ino: statSync(path).ino,
      };
    } finally {
      closeSync(old);
    }
  } finally {
    rmSync(lock, { force: true });
  }
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
