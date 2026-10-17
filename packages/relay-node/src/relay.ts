import type { AddressInfo } from "node:net";
import {
  type ErrorCode,
  type HelloFrame,
  PONG_FRAME,
  type RelayFrame,
  verifyClose,
} from "@agentroom/protocol";
import {
  admitPut,
  applyPut,
  DEFAULT_LIMITS,
  decideHello,
  MAX_FRAME_BYTES,
  MAX_REFUSALS,
  newNonce,
  parseClientFrame,
  type RateState,
  type RelayEvent,
  type RelayLimits,
  rateFor,
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
  /** Connections one address may hold in one room, close-only included (default 10). */
  maxRoomConnsPerIp?: number;
  /** Token bucket on `put`, per address per room, kept across reconnects (default burst 20, refill 2/s). */
  rateLimit?: { burst: number; perSec: number };
  /** How long a close-only connection may wait before sending `close` (default 10 s). */
  closeGraceMs?: number;
  /** How long a new connection may wait before sending `hello` (default 10 s). */
  helloTimeoutMs?: number;
  /** Ping every connection this often; one that missed the last pong is dropped (default 30 s). */
  pingIntervalMs?: number;
  /** Live rooms on this relay; a create past it gets `room_full` (default 1000). */
  maxRooms?: number;
  /** Open connections on this relay; an upgrade past it gets HTTP 503 (default 2000). */
  maxConns?: number;
  /** Open connections from one address; an upgrade past it gets HTTP 429 (default 32). */
  maxConnsPerIp?: number;
  /**
   * Bytes of buffered envelopes, meta and close keys across all rooms (string length). Past it,
   * creates get `room_full` and puts `rate_limited` (default 256 MiB).
   */
  maxBufferedBytes?: number;
  /** A connection whose unsent output exceeds this is terminated (default 2 MiB). */
  maxSendBufferBytes?: number;
  /** A room with no member connection for this long is dropped as expired (default 15 min). */
  emptyRoomTtlSec?: number;
  now?: () => number;
  log?: (event: RelayEvent) => void;
}

/** relay-node's own caps, on top of the shared room limits. */
export const NODE_DEFAULTS = {
  maxRooms: 1000,
  maxConns: 2000,
  maxConnsPerIp: 32,
  maxBufferedBytes: 256 * 1024 * 1024,
  maxSendBufferBytes: 2 * 1024 * 1024,
  emptyRoomTtlSec: 900,
};

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
  /** `put` token buckets by client address. */
  rates: Map<string, RateState>;
  /** Counted against maxBufferedBytes: buffered blobs, meta and close key. */
  bytes: number;
  /** Since when no member has been connected; undefined while one is. */
  emptySince?: number;
}

interface Conn {
  /** The TCP peer address; behind a reverse proxy, the proxy's. */
  ip: string;
  room?: Room;
  nonce?: string;
  closeOnly: boolean;
  graceTimer?: NodeJS.Timeout;
  helloTimer?: NodeJS.Timeout;
  /** Answered the last keepalive ping. */
  alive: boolean;
  /** Consecutive refused puts. */
  refusals: number;
  /** Replaying `since`: live `msg`s reach it through the replay cursor, not broadcast. */
  replaying: boolean;
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
    maxRoomConnsPerIp: opts.maxRoomConnsPerIp ?? d.maxRoomConnsPerIp,
    rateBurst: opts.rateLimit?.burst ?? d.rateBurst,
    ratePerSec: opts.rateLimit?.perSec ?? d.ratePerSec,
    closeGraceMs: opts.closeGraceMs ?? d.closeGraceMs,
    helloTimeoutMs: opts.helloTimeoutMs ?? d.helloTimeoutMs,
    pingIntervalMs: opts.pingIntervalMs ?? d.pingIntervalMs,
  };
  const caps = {
    maxRooms: opts.maxRooms ?? NODE_DEFAULTS.maxRooms,
    maxConns: opts.maxConns ?? NODE_DEFAULTS.maxConns,
    maxConnsPerIp: opts.maxConnsPerIp ?? NODE_DEFAULTS.maxConnsPerIp,
    maxBufferedBytes: opts.maxBufferedBytes ?? NODE_DEFAULTS.maxBufferedBytes,
    maxSendBufferBytes:
      opts.maxSendBufferBytes ?? NODE_DEFAULTS.maxSendBufferBytes,
    emptyRoomTtlMs:
      (opts.emptyRoomTtlSec ?? NODE_DEFAULTS.emptyRoomTtlSec) * 1000,
  };
  const now = opts.now ?? Date.now;
  const log = opts.log ?? defaultLog;
  const host = opts.host ?? "127.0.0.1";
  const rooms = new Map<string, Room>();
  /** Closed or expired room ids, remembered until createdAt + maxAge (KTD7). */
  const tombstones = new Map<string, number>();
  const conns = new Map<WebSocket, Conn>();
  /** Open connections per address, counted from upgrade to close. */
  const perIp = new Map<string, number>();
  /** Sum of every room's `bytes`. */
  let bufferedBytes = 0;
  let accepting = true;

  const wss = new WebSocketServer({
    port: opts.port,
    host,
    maxPayload: MAX_FRAME_BYTES,
    verifyClient: (info, done) => {
      if (!accepting) return done(false);
      // Real clients are Node processes and send no Origin; a browser page always does.
      if (info.origin) return done(false, 403, "browser origins are refused");
      if (conns.size >= caps.maxConns) {
        return done(false, 503, "relay is at its connection cap");
      }
      const ip = info.req.socket.remoteAddress ?? "";
      if ((perIp.get(ip) ?? 0) >= caps.maxConnsPerIp) {
        return done(false, 429, "too many connections from your address");
      }
      done(true);
    },
  });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });

  /** Send, or terminate a peer that is not reading: its unsent output would grow without bound. */
  const send = (ws: WebSocket, frame: RelayFrame) => {
    if (ws.bufferedAmount > caps.maxSendBufferBytes) {
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify(frame));
  };

  /**
   * Replay buffered envelopes after `since` without flooding the socket: past half the send
   * cap, wait for the kernel to take the last frame. Puts that land meanwhile are appended to
   * the buffer and picked up by the cursor, so order holds.
   */
  const replay = (ws: WebSocket, conn: Conn, room: Room, since: number) => {
    conn.replaying = true;
    let cursor = since;
    const pump = () => {
      while (ws.readyState === ws.OPEN && conn.room === room) {
        const next = room.state.buffer.find((e) => e.seq > cursor);
        if (!next) break;
        cursor = next.seq;
        const data = JSON.stringify({ t: "msg", ...next });
        if (ws.bufferedAmount + data.length > caps.maxSendBufferBytes / 2) {
          ws.send(data, () => pump());
          return;
        }
        ws.send(data);
      }
      conn.replaying = false;
    };
    pump();
  };

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
    bufferedBytes -= room.bytes;
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
    for (const c of room.conns) {
      if (c === except) continue;
      if (frame.t === "msg" && conns.get(c)?.replaying) continue;
      send(c, frame);
    }
  };

  const addBytes = (room: Room, n: number) => {
    room.bytes += n;
    bufferedBytes += n;
  };

  const put = (room: Room, blob: string) => {
    const seq = applyPut(room.state, now());
    room.state.buffer.push({ seq, blob });
    addBytes(room, blob.length);
    if (room.state.buffer.length > limits.bufferSize) {
      addBytes(room, -(room.state.buffer.shift()?.blob.length ?? 0));
    }
    broadcast(room, { t: "msg", seq: room.state.seq, blob });
  };

  const join = (ws: WebSocket, conn: Conn, hello: HelloFrame): void => {
    let room = liveRoom(hello.room);
    const ipConns = room
      ? [...room.conns, ...room.closers].filter(
          (w) => conns.get(w)?.ip === conn.ip,
        ).length
      : 0;
    const decision = decideHello(hello, {
      room: room?.state,
      tombstoned: tombstones.has(hello.room),
      members: room?.conns.size ?? 0,
      ipConns,
      now: now(),
      limits,
    });
    if (!decision.ok) {
      fail(ws, decision.code, decision.message);
      return;
    }
    if (decision.created) {
      if (rooms.size >= caps.maxRooms) {
        fail(ws, "room_full", "relay is at its room cap; try again later");
        return;
      }
      if (bufferedBytes >= caps.maxBufferedBytes) {
        fail(ws, "room_full", "relay is out of buffer space; try again later");
        return;
      }
      room = {
        state: { ...decision.created, buffer: [] },
        conns: new Set(),
        closers: new Set(),
        rates: new Map(),
        bytes: 0,
      };
      addBytes(room, room.state.meta.length + room.state.closeKey.length);
      rooms.set(hello.room, room);
      log({ event: "room_created", room: hello.room });
    }
    if (!room) return;
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
      room.emptySince = undefined;
    }
    send(ws, {
      t: "welcome",
      seq: room.state.seq,
      members: room.conns.size,
      expiresAt: expiresAt(room),
      nonce,
      meta: room.state.meta,
      ping: limits.pingIntervalMs,
    });
    if (conn.closeOnly) {
      log({ event: "closer_open", room: hello.room });
      return;
    }
    if (hello.since !== undefined) replay(ws, conn, room, hello.since);
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

  wss.on("connection", (ws, req) => {
    const conn: Conn = {
      ip: req.socket.remoteAddress ?? "",
      closeOnly: false,
      alive: true,
      refusals: 0,
      replaying: false,
      helloTimer: setTimeout(
        () => fail(ws, "bad_proto", "no hello in time"),
        limits.helloTimeoutMs,
      ),
    };
    conn.helloTimer?.unref();
    conns.set(ws, conn);
    perIp.set(conn.ip, (perIp.get(conn.ip) ?? 0) + 1);
    let greeted = false;
    ws.on("error", () => {});
    ws.on("pong", () => {
      conn.alive = true;
    });
    ws.on("message", (data, isBinary) => {
      const frame = isBinary ? undefined : parseClientFrame(data.toString());
      if (!frame) {
        fail(ws, "bad_proto", "malformed frame");
        return;
      }
      if (frame.t === "ping") {
        ws.send(PONG_FRAME);
        return;
      }
      if (!greeted) {
        if (frame.t !== "hello") {
          fail(ws, "bad_proto", "first frame must be hello");
          return;
        }
        greeted = true;
        clearTimeout(conn.helloTimer);
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
      const rate = rateFor(room.rates, conn.ip, t, limits);
      let admit = admitPut(rate, frame.blob, t, limits);
      if (
        admit.ok &&
        bufferedBytes + frame.blob.length > caps.maxBufferedBytes
      ) {
        admit = {
          ok: false,
          code: "rate_limited",
          message: "relay is out of buffer space; try again later",
        };
      }
      if (!admit.ok) {
        conn.refusals += 1;
        fail(ws, admit.code, admit.message, conn.refusals >= MAX_REFUSALS);
        return;
      }
      conn.refusals = 0;
      put(room, frame.blob);
    });
    ws.on("close", () => {
      conns.delete(ws);
      const left = (perIp.get(conn.ip) ?? 1) - 1;
      if (left > 0) perIp.set(conn.ip, left);
      else perIp.delete(conn.ip);
      clearTimeout(conn.graceTimer);
      clearTimeout(conn.helloTimer);
      const room = conn.room;
      room?.closers.delete(ws);
      if (!room?.conns.delete(ws)) return;
      if (room.conns.size === 0) room.emptySince = now();
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
      const abandoned =
        room.emptySince !== undefined &&
        t - room.emptySince >= caps.emptyRoomTtlMs;
      if (t >= expiresAt(room) || abandoned) expire(id, room);
    }
    for (const [id, until] of tombstones) {
      if (t >= until) tombstones.delete(id);
    }
  }, opts.sweepIntervalMs ?? 60_000);
  sweep.unref();

  // Keepalive: a peer that vanished without a FIN would otherwise hold its slot forever.
  const keepalive = setInterval(() => {
    for (const [ws, conn] of conns) {
      if (!conn.alive) {
        ws.terminate();
        continue;
      }
      conn.alive = false;
      ws.ping();
    }
  }, limits.pingIntervalMs);
  keepalive.unref();

  const port = (wss.address() as AddressInfo).port;
  const urlHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return {
    url: `ws://${urlHost}:${port}`,
    port,
    async close() {
      clearInterval(sweep);
      clearInterval(keepalive);
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
