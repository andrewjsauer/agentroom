import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  ClientFrame,
  type ErrorCode,
  type HelloFrame,
  type RelayFrame,
  verifyClose,
} from "@agentroom/protocol";
import { type WebSocket, WebSocketServer } from "ws";

/** Structured relay event. Never carries a blob or meta (invariant 1). */
export type RelayEvent =
  | { event: "room_created"; room: string }
  | { event: "room_expired"; room: string }
  | { event: "room_closed"; room: string }
  | { event: "conn_open"; room: string; members: number }
  | { event: "closer_open"; room: string }
  | { event: "conn_close"; room: string; members: number }
  | { event: "error"; code: ErrorCode };

export interface RelayOptions {
  port: number;
  host?: string;
  idleTtlSec?: number;
  bufferSize?: number;
  maxEnvelopeBytes?: number;
  sweepIntervalMs?: number;
  /** Default and ceiling for a room's max age (default 24 h). */
  maxAgeSec?: number;
  /** Connections per room, close-only connections excepted (default 8). */
  maxMembers?: number;
  /** Close-only connections held per room; a new one evicts the oldest (default 2). */
  maxClosers?: number;
  /** Token bucket on `put`, per connection (default burst 20, refill 2/s). */
  rateLimit?: { burst: number; perSec: number };
  /** How long a close-only connection may wait before sending `close` (default 10 s). */
  closeGraceMs?: number;
  now?: () => number;
  log?: (event: RelayEvent) => void;
}

export interface RoomSnapshot {
  roomId: string;
  seq: number;
  buffer: { seq: number; blob: string }[];
  meta: string;
  closeKey: string;
  idleTtlSec: number;
  maxAgeSec: number;
  createdAt: number;
  lastActivity: number;
}

export interface RelayHandle {
  url: string;
  port: number;
  close(): Promise<void>;
  snapshot(roomId: string): RoomSnapshot | undefined;
  disconnectAll(): void;
  setAccepting(accepting: boolean): void;
  inject(roomId: string, blob: string): void;
}

interface Room {
  state: RoomSnapshot;
  conns: Set<WebSocket>;
  closers: Set<WebSocket>;
}

interface Conn {
  room?: Room;
  nonce?: string;
  closeOnly: boolean;
  graceTimer?: NodeJS.Timeout;
  tokens: number;
  refilledAt: number;
}

const MAX_PAYLOAD = 96 * 1024;

function defaultLog(event: RelayEvent): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

/** Start an in-memory relay. Resolves once it is listening. */
export async function startRelay(opts: RelayOptions): Promise<RelayHandle> {
  const idleTtlSec = opts.idleTtlSec ?? 28_800;
  const bufferSize = opts.bufferSize ?? 500;
  const maxEnvelopeBytes = opts.maxEnvelopeBytes ?? 65_536;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? defaultLog;
  const host = opts.host ?? "127.0.0.1";
  const maxAgeSec = opts.maxAgeSec ?? 86_400;
  const maxMembers = opts.maxMembers ?? 8;
  const maxClosers = opts.maxClosers ?? 2;
  const rateLimit = opts.rateLimit ?? { burst: 20, perSec: 2 };
  const rooms = new Map<string, Room>();
  /** Closed or expired room ids, remembered until createdAt + maxAge (KTD7). */
  const tombstones = new Map<string, number>();
  let accepting = true;

  const wss = new WebSocketServer({
    port: opts.port,
    host,
    maxPayload: MAX_PAYLOAD,
    verifyClient: () => accepting,
  });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });

  const send = (ws: WebSocket, frame: RelayFrame) =>
    ws.send(JSON.stringify(frame));

  const fail = (
    ws: WebSocket,
    code: ErrorCode,
    message: string,
    end = true,
  ) => {
    log({ event: "error", code });
    send(ws, { t: "error", code, message });
    if (end) ws.close();
  };

  const expiresAt = (room: Room) =>
    Math.min(
      room.state.lastActivity + room.state.idleTtlSec * 1000,
      room.state.createdAt + room.state.maxAgeSec * 1000,
    );

  /** Drop a room, send `frame` to every connection, close them, and tombstone the id. */
  const drop = (id: string, room: Room, frame: RelayFrame) => {
    rooms.delete(id);
    tombstones.set(id, room.state.createdAt + room.state.maxAgeSec * 1000);
    for (const c of [...room.conns, ...room.closers]) {
      send(c, frame);
      c.close();
    }
    room.conns.clear();
    room.closers.clear();
  };

  const expire = (id: string, room: Room) => {
    drop(id, room, {
      t: "error",
      code: "room_expired",
      message: "room expired",
    });
    log({ event: "room_expired", room: id });
  };

  /** The room if it exists and is within its idle TTL; an expired one is dropped now, not at the next sweep. */
  const liveRoom = (id: string): Room | undefined => {
    const room = rooms.get(id);
    if (room && now() >= expiresAt(room)) {
      expire(id, room);
      return undefined;
    }
    return room;
  };

  const broadcast = (room: Room, frame: RelayFrame, except?: WebSocket) => {
    for (const c of room.conns) if (c !== except) send(c, frame);
  };

  const put = (room: Room, blob: string) => {
    room.state.seq += 1;
    room.state.buffer.push({ seq: room.state.seq, blob });
    if (room.state.buffer.length > bufferSize) room.state.buffer.shift();
    room.state.lastActivity = now();
    broadcast(room, { t: "msg", seq: room.state.seq, blob });
  };

  const join = (ws: WebSocket, conn: Conn, hello: HelloFrame): void => {
    if (hello.closeOnly && (hello.create || hello.since !== undefined)) {
      fail(
        ws,
        "bad_proto",
        "closeOnly cannot be combined with create or since",
      );
      return;
    }
    let room = liveRoom(hello.room);
    if (!room && tombstones.has(hello.room)) {
      fail(ws, "room_expired", "room was closed or expired");
      return;
    }
    if (hello.create) {
      if (room) {
        fail(ws, "room_exists", "a live room already has this id");
        return;
      }
      const t = now();
      room = {
        state: {
          roomId: hello.room,
          seq: 0,
          buffer: [],
          meta: hello.create.meta,
          closeKey: hello.create.closeKey,
          idleTtlSec: Math.min(
            hello.create.idleTtlSec ?? idleTtlSec,
            idleTtlSec,
          ),
          maxAgeSec: Math.min(hello.create.maxAgeSec ?? maxAgeSec, maxAgeSec),
          createdAt: t,
          lastActivity: t,
        },
        conns: new Set(),
        closers: new Set(),
      };
      rooms.set(hello.room, room);
      log({ event: "room_created", room: hello.room });
    } else if (!room) {
      fail(
        ws,
        "room_not_found",
        "room not found: it expired, was closed, or the relay restarted",
      );
      return;
    }
    if (!hello.closeOnly && room.conns.size >= maxMembers) {
      fail(ws, "room_full", "room is at its connection cap");
      return;
    }
    if (hello.closeOnly && room.closers.size >= maxClosers) {
      // Evict the oldest closer rather than refuse: a leaked share code must not be able to block close.
      const [oldest] = room.closers;
      if (oldest) {
        room.closers.delete(oldest);
        fail(oldest, "room_full", "replaced by a newer close-only connection");
      }
    }
    const nonce = randomBytes(16).toString("base64");
    conn.room = room;
    conn.nonce = nonce;
    conn.closeOnly = hello.closeOnly === true;
    if (conn.closeOnly) {
      room.closers.add(ws);
      conn.graceTimer = setTimeout(
        () => ws.close(),
        opts.closeGraceMs ?? 10_000,
      );
      conn.graceTimer.unref();
    } else {
      room.state.lastActivity = now();
      room.conns.add(ws);
    }
    send(ws, {
      t: "welcome",
      seq: room.state.seq,
      members: room.conns.size,
      expiresAt: expiresAt(room),
      nonce,
      meta: room.state.meta,
    });
    if (conn.closeOnly) {
      log({ event: "closer_open", room: hello.room });
      return;
    }
    if (hello.since !== undefined) {
      for (const e of room.state.buffer) {
        if (e.seq > hello.since) send(ws, { t: "msg", ...e });
      }
    }
    broadcast(room, { t: "presence", members: room.conns.size }, ws);
    log({ event: "conn_open", room: hello.room, members: room.conns.size });
  };

  const close = async (ws: WebSocket, conn: Conn, sig: string) => {
    const room = conn.room;
    if (!room || liveRoom(room.state.roomId) !== room) return;
    const ok = await verifyClose(
      room.state.closeKey,
      sig,
      room.state.roomId,
      conn.nonce as string,
    );
    if (!ok) {
      fail(ws, "bad_signature", "close signature did not verify");
      return;
    }
    if (rooms.get(room.state.roomId) !== room) return;
    drop(room.state.roomId, room, { t: "closed" });
    log({ event: "room_closed", room: room.state.roomId });
  };

  wss.on("connection", (ws) => {
    const conn: Conn = {
      closeOnly: false,
      tokens: rateLimit.burst,
      refilledAt: now(),
    };
    let greeted = false;
    ws.on("error", () => {});
    ws.on("message", (data, isBinary) => {
      let frame: ClientFrame;
      try {
        if (isBinary) throw new Error("binary frame");
        frame = ClientFrame.parse(JSON.parse(data.toString()));
      } catch {
        fail(ws, "bad_proto", "malformed frame");
        return;
      }
      if (!greeted) {
        if (frame.t !== "hello") {
          fail(ws, "bad_proto", "first frame must be hello");
          return;
        }
        greeted = true;
        join(ws, conn, frame);
        return;
      }
      if (frame.t === "hello") {
        fail(ws, "bad_proto", "hello already received");
        return;
      }
      if (frame.t === "close") {
        void close(ws, conn, frame.sig);
        return;
      }
      if (conn.closeOnly) {
        fail(ws, "bad_proto", "a close-only connection may send only close");
        return;
      }
      const room = conn.room;
      if (!room || liveRoom(room.state.roomId) !== room) return;
      const t = now();
      conn.tokens = Math.min(
        rateLimit.burst,
        conn.tokens + ((t - conn.refilledAt) / 1000) * rateLimit.perSec,
      );
      conn.refilledAt = t;
      if (conn.tokens < 1) {
        fail(ws, "rate_limited", "too many messages; slow down", false);
        return;
      }
      conn.tokens -= 1;
      if (Buffer.byteLength(frame.blob, "base64") > maxEnvelopeBytes) {
        fail(ws, "too_large", "envelope exceeds 64 KiB", false);
        return;
      }
      put(room, frame.blob);
    });
    ws.on("close", () => {
      clearTimeout(conn.graceTimer);
      const room = conn.room;
      room?.closers.delete(ws);
      if (!room?.conns.delete(ws)) return;
      broadcast(room, { t: "presence", members: room.conns.size });
      log({
        event: "conn_close",
        room: room.state.roomId,
        members: room.conns.size,
      });
    });
  });

  const sweep = setInterval(() => {
    const t = now();
    for (const [id, room] of rooms) {
      if (t >= expiresAt(room)) expire(id, room);
    }
    for (const [id, until] of tombstones) {
      if (t >= until) tombstones.delete(id);
    }
  }, opts.sweepIntervalMs ?? 60_000);
  sweep.unref();

  const port = (wss.address() as AddressInfo).port;
  const urlHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return {
    url: `ws://${urlHost}:${port}`,
    port,
    async close() {
      clearInterval(sweep);
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
    snapshot(roomId) {
      const room = rooms.get(roomId);
      return room ? structuredClone(room.state) : undefined;
    },
    disconnectAll() {
      for (const c of wss.clients) c.terminate();
    },
    setAccepting(value) {
      accepting = value;
    },
    inject(roomId, blob) {
      const room = rooms.get(roomId);
      if (!room) throw new Error(`no room ${roomId}`);
      put(room, blob);
    },
  };
}
