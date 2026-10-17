import { DurableObject } from "cloudflare:workers";
import type { ErrorCode, HelloFrame, RelayFrame } from "@agentroom/protocol";
import {
  admitPut,
  applyPut,
  DEFAULT_LIMITS,
  decideHello,
  expiresAt,
  MAX_FRAME_BYTES,
  MAX_REFUSALS,
  newNonce,
  PING_FRAME,
  PONG_FRAME,
  parseClientFrame,
  positiveInt,
  type RateState,
  type RelayEvent,
  type RelayLimits,
  type RoomState,
  rateFor,
  tombstoneUntil,
  verifyCloseWebCrypto,
} from "@agentroom/protocol/relay-core";
import type { Env } from "./index.js";

/** Per-connection state; kept in the socket attachment so it survives hibernation. */
interface Attachment {
  room: string;
  /** CF-Connecting-IP; also the socket's hibernation tag, so sockets are counted per address. */
  ip: string;
  /** `done`: closed by either side, kept until the runtime drops the socket. */
  role: "pending" | "member" | "closer" | "done";
  nonce?: string;
  /** A pending socket that has not sent `hello` by then is closed. */
  helloBy?: number;
  closeBy?: number;
  /** Last frame that reached the object; auto-answered pings are tracked by the runtime. */
  seenAt: number;
  /** Consecutive refused puts. */
  refusals?: number;
}

/** Buffered envelopes read per storage call when replaying `since`. */
const REPLAY_PAGE = 50;

/** A member silent this long (no frame, no ping) is closed; clients ping every 30 s. */
const MEMBER_IDLE_MS = 120_000;

const bufferKey = (seq: number) => `b:${String(seq).padStart(10, "0")}`;
const att = (ws: WebSocket) => ws.deserializeAttachment() as Attachment;
const log = (event: RelayEvent) => console.log(JSON.stringify(event));

/** Limits from wrangler `vars`; an invalid value throws, so every request fails loudly. */
export function limitsFrom(env: Env): RelayLimits & { memberIdleMs: number } {
  const n = (name: keyof Env & string, d: number) =>
    positiveInt(name, env[name] as string | undefined) ?? d;
  const d = DEFAULT_LIMITS;
  return {
    idleTtlSec: n("IDLE_TTL_SEC", d.idleTtlSec),
    maxAgeSec: n("MAX_AGE_SEC", d.maxAgeSec),
    bufferSize: n("BUFFER_SIZE", d.bufferSize),
    maxEnvelopeBytes: d.maxEnvelopeBytes,
    maxMembers: n("MAX_MEMBERS", d.maxMembers),
    maxRoomConnsPerIp: n("MAX_ROOM_CONNS_PER_IP", d.maxRoomConnsPerIp),
    rateBurst: n("RATE_BURST", d.rateBurst),
    ratePerSec: n("RATE_PER_SEC", d.ratePerSec),
    closeGraceMs: n("CLOSE_GRACE_MS", d.closeGraceMs),
    helloTimeoutMs: n("HELLO_TIMEOUT_MS", d.helloTimeoutMs),
    pingIntervalMs: n("PING_INTERVAL_MS", d.pingIntervalMs),
    memberIdleMs: n("MEMBER_IDLE_MS", MEMBER_IDLE_MS),
  };
}

/**
 * One room (M4 KTD10). Storage holds only `room` (RoomState: seq, meta, closeKey, TTLs, times),
 * `b:<seq>` ciphertext blobs, and `tomb` (an expiry time). Never plaintext (invariant 1).
 */
export class Room extends DurableObject<Env> {
  private state: RoomState | undefined;
  private tomb: number | undefined;
  private readonly limits: RelayLimits;
  private readonly memberIdleMs: number;
  /**
   * `put` buckets by client address, shared by that address's sockets. In memory only: the
   * object hibernates only after about 10 s without events, by which time a bucket has
   * refilled (burst 20 at 2/s), so losing it on hibernation grants nothing extra.
   */
  private readonly rates = new Map<string, RateState>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const limits = limitsFrom(env);
    this.limits = limits;
    this.memberIdleMs = limits.memberIdleMs;
    // Answered by the runtime without waking the object; the alarm reads the time of the last one.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(PING_FRAME, PONG_FRAME),
    );
    void ctx.blockConcurrencyWhile(async () => {
      this.state = await ctx.storage.get<RoomState>("room");
      this.tomb = await ctx.storage.get<number>("tomb");
    });
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const room = url.searchParams.get("room") as string;
    if (this.env.TEST_INSPECT === "1" && url.pathname === "/__inspect") {
      return Response.json(Object.fromEntries(await this.ctx.storage.list()));
    }
    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    if (this.open(ip).length >= this.limits.maxRoomConnsPerIp) {
      return new Response("too many connections from your address\n", {
        status: 429,
      });
    }
    const [client, server] = Object.values(new WebSocketPair()) as [
      WebSocket,
      WebSocket,
    ];
    this.ctx.acceptWebSocket(server, [ip]);
    const now = Date.now();
    server.serializeAttachment({
      room,
      ip,
      role: "pending",
      helloBy: now + this.limits.helloTimeoutMs,
      seenAt: now,
    } satisfies Attachment);
    await this.schedule();
    return new Response(null, { status: 101, webSocket: client });
  }

  private send(ws: WebSocket, frame: RelayFrame): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // The socket is already closing.
    }
  }

  private fail(ws: WebSocket, code: ErrorCode, message: string, end = true) {
    log({ event: "error", code });
    this.send(ws, { t: "error", code, message });
    if (end) this.drop(ws, 1000);
  }

  /** Close a socket and mark it done, so no count, broadcast or alarm considers it again. */
  private drop(ws: WebSocket, code: number, reason?: string): void {
    ws.serializeAttachment({ ...att(ws), role: "done" });
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  /** This address's sockets that are not done, optionally excluding one. */
  private open(ip: string, except?: WebSocket): WebSocket[] {
    return this.ctx
      .getWebSockets(ip)
      .filter((w) => w !== except && att(w).role !== "done");
  }

  private sockets(role: Attachment["role"], except?: WebSocket): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((w) => w !== except && att(w).role === role);
  }

  private broadcast(frame: RelayFrame, except?: WebSocket): void {
    for (const w of this.sockets("member", except)) this.send(w, frame);
  }

  /** The room if it is live; an expired one is ended now. */
  private async live(): Promise<RoomState | undefined> {
    if (this.state && Date.now() >= expiresAt(this.state)) {
      await this.end("room_expired");
    }
    return this.state;
  }

  /** Close or expiry: tell every connection, then delete everything but the tombstone (invariant 7). */
  private async end(kind: "closed" | "room_expired"): Promise<void> {
    const state = this.state;
    if (!state) return;
    const frame: RelayFrame =
      kind === "closed"
        ? { t: "closed" }
        : { t: "error", code: "room_expired", message: "room expired" };
    for (const w of this.ctx.getWebSockets()) {
      const role = att(w).role;
      if (role === "done") continue;
      if (role !== "pending") this.send(w, frame);
      this.drop(w, 1000);
    }
    const until = tombstoneUntil(state);
    this.state = undefined;
    this.rates.clear();
    this.tomb = until;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.put("tomb", until);
    await this.ctx.storage.setAlarm(until);
    log({
      event: kind === "closed" ? "room_closed" : "room_expired",
      room: state.roomId,
    });
  }

  /** When a socket's next deadline falls: hello, close grace, or member silence. */
  private deadline(ws: WebSocket): number | undefined {
    const a = att(ws);
    if (a.role === "pending") return a.helloBy;
    if (a.role === "closer") return a.closeBy;
    if (a.role !== "member") return undefined;
    const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime();
    return Math.max(a.seenAt, pinged ?? 0) + this.memberIdleMs;
  }

  /**
   * One alarm at the earliest of expiry (or the tombstone time) and every socket's deadline.
   * Rewritten only when it moves, so a new connection usually costs no storage write.
   */
  private async schedule(): Promise<void> {
    const times = this.ctx
      .getWebSockets()
      .map((w) => this.deadline(w))
      .filter((t) => t !== undefined);
    if (this.state) times.push(expiresAt(this.state));
    else if (this.tomb !== undefined) times.push(this.tomb);
    if (times.length === 0) return;
    const at = Math.min(...times);
    if ((await this.ctx.storage.getAlarm()) !== at) {
      await this.ctx.storage.setAlarm(at);
    }
  }

  override async alarm(): Promise<void> {
    // Memory may be stale after hibernation: read storage.
    this.state = await this.ctx.storage.get<RoomState>("room");
    this.tomb = await this.ctx.storage.get<number>("tomb");
    const now = Date.now();
    if (this.state && now >= expiresAt(this.state)) {
      await this.end("room_expired");
      return;
    }
    if (!this.state && this.tomb !== undefined && now >= this.tomb) {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      this.tomb = undefined;
    }
    let idled = false;
    for (const w of this.ctx.getWebSockets()) {
      const due = this.deadline(w);
      if (due === undefined || due > now) continue;
      // Each path marks the socket `done` first, so a peer that never answers the close does
      // not keep rescheduling the alarm.
      const role = att(w).role;
      if (role === "pending") {
        this.fail(w, "bad_proto", "no hello in time");
      } else if (role === "closer") {
        this.drop(w, 1000);
      } else {
        this.drop(w, 1001, "idle: no frame or ping in time");
        idled = true;
      }
    }
    if (idled && this.state) {
      const members = this.sockets("member").length;
      this.broadcast({ t: "presence", members });
      log({ event: "conn_close", room: this.state.roomId, members });
    }
    await this.schedule();
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") {
      this.fail(ws, "bad_proto", "malformed frame");
      return;
    }
    // UTF-8 never has fewer bytes than UTF-16 code units, so the length check is safe and
    // saves encoding an oversized frame; the encode check catches multi-byte text.
    if (
      message.length > MAX_FRAME_BYTES ||
      new TextEncoder().encode(message).length > MAX_FRAME_BYTES
    ) {
      this.drop(ws, 1009, "frame too large");
      return;
    }
    const frame = parseClientFrame(message);
    if (!frame) {
      this.fail(ws, "bad_proto", "malformed frame");
      return;
    }
    const a = att(ws);
    if (a.role === "done") return;
    a.seenAt = Date.now();
    ws.serializeAttachment(a);
    if (frame.t === "ping") {
      // A ping that is not byte-identical to PING_FRAME misses the auto-response.
      ws.send(PONG_FRAME);
      return;
    }
    if (a.role === "pending") {
      if (frame.t !== "hello") {
        this.fail(ws, "bad_proto", "first frame must be hello");
        return;
      }
      await this.hello(ws, a, frame);
      return;
    }
    if (frame.t === "hello") {
      this.fail(ws, "bad_proto", "hello already received");
      return;
    }
    if (frame.t === "close") {
      await this.close(ws, a, frame.sig);
      return;
    }
    if (a.role === "closer") {
      this.fail(ws, "bad_proto", "a close-only connection may send only close");
      return;
    }
    const state = await this.live();
    if (!state) return;
    const now = Date.now();
    const rate = rateFor(this.rates, a.ip, now, this.limits);
    const admit = admitPut(rate, frame.blob, now, this.limits);
    if (!admit.ok) {
      a.refusals = (a.refusals ?? 0) + 1;
      ws.serializeAttachment(a);
      this.fail(ws, admit.code, admit.message, a.refusals >= MAX_REFUSALS);
      return;
    }
    if (a.refusals) {
      a.refusals = 0;
      ws.serializeAttachment(a);
    }
    const seq = applyPut(state, now);
    // The output gate holds the broadcast until these writes commit.
    void this.ctx.storage.put<unknown>({
      room: state,
      [bufferKey(seq)]: frame.blob,
    });
    if (seq > this.limits.bufferSize) {
      void this.ctx.storage.delete(bufferKey(seq - this.limits.bufferSize));
    }
    for (const w of this.sockets("member")) {
      this.send(w, { t: "msg", seq, blob: frame.blob });
    }
  }

  private async hello(ws: WebSocket, a: Attachment, hello: HelloFrame) {
    if (hello.room !== a.room) {
      this.fail(ws, "bad_proto", "hello room does not match the URL");
      return;
    }
    const state0 = await this.live();
    // The alarm may have timed this socket out while `live()` awaited.
    if (att(ws).role === "done") return;
    const now = Date.now();
    const d = decideHello(hello, {
      room: state0,
      tombstoned: this.tomb !== undefined && now < this.tomb,
      members: this.sockets("member").length,
      ipConns: this.open(a.ip, ws).filter((w) => att(w).role !== "pending")
        .length,
      now,
      limits: this.limits,
    });
    if (!d.ok) {
      this.fail(ws, d.code, d.message);
      return;
    }
    if (d.created) {
      this.state = d.created;
      this.tomb = undefined;
      await this.ctx.storage.delete("tomb");
      log({ event: "room_created", room: hello.room });
    }
    const state = this.state;
    if (!state) return;
    a.nonce = newNonce();
    if (d.closeOnly) {
      a.role = "closer";
      a.closeBy = now + this.limits.closeGraceMs;
    } else {
      a.role = "member";
      state.lastActivity = now;
    }
    ws.serializeAttachment(a);
    await this.ctx.storage.put("room", state);
    const members = this.sockets("member").length;
    this.send(ws, {
      t: "welcome",
      seq: state.seq,
      members,
      expiresAt: expiresAt(state),
      nonce: a.nonce,
      meta: state.meta,
      // Several pings per idle window, so one lost ping does not cost the connection.
      ping: Math.min(
        this.limits.pingIntervalMs,
        Math.floor(this.memberIdleMs / 4),
      ),
    });
    if (d.closeOnly) {
      log({ event: "closer_open", room: hello.room });
    } else {
      if (hello.since !== undefined) await this.replay(ws, hello.since);
      this.broadcast({ t: "presence", members }, ws);
      log({ event: "conn_open", room: hello.room, members });
    }
    await this.schedule();
  }

  /**
   * Send buffered envelopes after `since`, a page at a time, stopping if the socket goes away.
   * Input gates hold other events during each read, so no live `msg` interleaves.
   */
  private async replay(ws: WebSocket, since: number): Promise<void> {
    let start = bufferKey(since + 1);
    for (;;) {
      const page = await this.ctx.storage.list<string>({
        prefix: "b:",
        start,
        limit: REPLAY_PAGE,
      });
      if (att(ws).role !== "member") return;
      let last = since;
      for (const [key, blob] of page) {
        last = Number(key.slice(2));
        this.send(ws, { t: "msg", seq: last, blob });
      }
      if (page.size < REPLAY_PAGE) return;
      start = bufferKey(last + 1);
    }
  }

  private async close(ws: WebSocket, a: Attachment, sig: string) {
    const state = await this.live();
    if (!state || !a.nonce) return;
    const ok = await verifyCloseWebCrypto(
      state.closeKey,
      sig,
      state.roomId,
      a.nonce,
    );
    if (!ok) {
      this.fail(ws, "bad_signature", "close signature did not verify");
      return;
    }
    // The verify awaited: the room may have ended meanwhile. An alarm reloads `this.state` from
    // storage, so compare the id, not the object.
    if (this.state?.roomId !== state.roomId) return;
    await this.end("closed");
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const a = att(ws);
    ws.serializeAttachment({ ...a, role: "done" });
    if (a.role !== "member" || !this.state) return;
    const members = this.sockets("member", ws).length;
    this.broadcast({ t: "presence", members }, ws);
    log({ event: "conn_close", room: a.room, members });
  }
}
