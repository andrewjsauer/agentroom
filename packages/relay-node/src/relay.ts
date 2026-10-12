import type { AddressInfo } from "node:net";
import {
  type ErrorCode,
  type HelloFrame,
  type RelayFrame,
  verifyClose,
} from "@agentroom/protocol";
import {
  admitPut,
  applyPut,
  DEFAULT_LIMITS,
  decideHello,
  MAX_FRAME_BYTES,
  newNonce,
  parseClientFrame,
  type RelayEvent,
  type RelayLimits,
  expiresAt as roomExpiresAt,
  tombstoneUntil,
} from "@agentroom/protocol/relay-core";
import { type WebSocket, WebSocketServer } from "ws";

export type { RelayEvent } from "@agentroom/protocol/relay-core";

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

function defaultLog(event: RelayEvent): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

/** Start an in-memory relay. Resolves once it is listening. */
export async function startRelay(opts: RelayOptions): Promise<RelayHandle> {
  const d = DEFAULT_LIMITS;
  const limits: RelayLimits = {
    idleTtlSec: opts.idleTtlSec ?? d.idleTtlSec,
    maxAgeSec: opts.maxAgeSec ?? d.maxAgeSec,
    bufferSize: opts.bufferSize ?? d.bufferSize,
    maxEnvelopeBytes: opts.maxEnvelopeBytes ?? d.maxEnvelopeBytes,
    maxMembers: opts.maxMembers ?? d.maxMembers,
    maxClosers: opts.maxClosers ?? d.maxClosers,
    rateBurst: opts.rateLimit?.burst ?? d.rateBurst,
    ratePerSec: opts.rateLimit?.perSec ?? d.ratePerSec,
    closeGraceMs: opts.closeGraceMs ?? d.closeGraceMs,
  };
  const now = opts.now ?? Date.now;
  const log = opts.log ?? defaultLog;
  const host = opts.host ?? "127.0.0.1";
  const rooms = new Map<string, Room>();
  /** Closed or expired room ids, remembered until createdAt + maxAge (KTD7). */
  const tombstones = new Map<string, number>();
  let accepting = true;

  const wss = new WebSocketServer({
    port: opts.port,
    host,
    maxPayload: MAX_FRAME_BYTES,
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

  const expiresAt = (room: Room) => roomExpiresAt(room.state);

  /** Drop a room, send `frame` to every connection, close them, and tombstone the id. */
  const drop = (id: string, room: Room, frame: RelayFrame) => {
    rooms.delete(id);
    tombstones.set(id, tombstoneUntil(room.state));
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
    const seq = applyPut(room.state, now());
    room.state.buffer.push({ seq, blob });
    if (room.state.buffer.length > limits.bufferSize) room.state.buffer.shift();
    broadcast(room, { t: "msg", seq: room.state.seq, blob });
  };

  const join = (ws: WebSocket, conn: Conn, hello: HelloFrame): void => {
    let room = liveRoom(hello.room);
    const decision = decideHello(hello, {
      room: room?.state,
      tombstoned: tombstones.has(hello.room),
      members: room?.conns.size ?? 0,
      closers: room?.closers.size ?? 0,
      now: now(),
      limits,
    });
    if (!decision.ok) {
      fail(ws, decision.code, decision.message);
      return;
    }
    if (decision.created) {
      room = {
        state: { ...decision.created, buffer: [] },
        conns: new Set(),
        closers: new Set(),
      };
      rooms.set(hello.room, room);
      log({ event: "room_created", room: hello.room });
    }
    if (!room) return;
    if (decision.evictCloser) {
      // Evict the oldest closer rather than refuse: a leaked share code must not be able to block close.
      const [oldest] = room.closers;
      if (oldest) {
        room.closers.delete(oldest);
        fail(oldest, "room_full", "replaced by a newer close-only connection");
      }
    }
    const nonce = newNonce();
    conn.room = room;
    conn.nonce = nonce;
    conn.closeOnly = decision.closeOnly;
    if (conn.closeOnly) {
      room.closers.add(ws);
      conn.graceTimer = setTimeout(() => ws.close(), limits.closeGraceMs);
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
      tokens: limits.rateBurst,
      refilledAt: now(),
    };
    let greeted = false;
    ws.on("error", () => {});
    ws.on("message", (data, isBinary) => {
      const frame = isBinary ? undefined : parseClientFrame(data.toString());
      if (!frame) {
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
      const admit = admitPut(conn, frame.blob, now(), limits);
      if (!admit.ok) {
        fail(ws, admit.code, admit.message, false);
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
