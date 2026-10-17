import { DurableObject } from "cloudflare:workers";
import type { ErrorCode, HelloFrame, RelayFrame } from "@agentroom/protocol";
import {
  admitPut,
  applyPut,
  DEFAULT_LIMITS,
  decideHello,
  expiresAt,
  MAX_FRAME_BYTES,
  newNonce,
  parseClientFrame,
  type RelayEvent,
  type RelayLimits,
  type RoomState,
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
  tokens: number;
  refilledAt: number;
  closeBy?: number;
}

const bufferKey = (seq: number) => `b:${String(seq).padStart(10, "0")}`;
const att = (ws: WebSocket) => ws.deserializeAttachment() as Attachment;
const log = (event: RelayEvent) => console.log(JSON.stringify(event));

function limitsFrom(env: Env): RelayLimits {
  const n = (v: string | undefined, d: number) => {
    const x = Number(v);
    return v && Number.isFinite(x) && x > 0 ? x : d;
  };
  const d = DEFAULT_LIMITS;
  return {
    idleTtlSec: n(env.IDLE_TTL_SEC, d.idleTtlSec),
    maxAgeSec: n(env.MAX_AGE_SEC, d.maxAgeSec),
    bufferSize: n(env.BUFFER_SIZE, d.bufferSize),
    maxEnvelopeBytes: d.maxEnvelopeBytes,
    maxMembers: n(env.MAX_MEMBERS, d.maxMembers),
    maxRoomConnsPerIp: n(env.MAX_ROOM_CONNS_PER_IP, d.maxRoomConnsPerIp),
    rateBurst: n(env.RATE_BURST, d.rateBurst),
    ratePerSec: n(env.RATE_PER_SEC, d.ratePerSec),
    closeGraceMs: n(env.CLOSE_GRACE_MS, d.closeGraceMs),
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.limits = limitsFrom(env);
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
    server.serializeAttachment({
      room,
      ip,
      role: "pending",
      tokens: this.limits.rateBurst,
      refilledAt: Date.now(),
    } satisfies Attachment);
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

  /** One alarm at the earliest of expiry, a closer's grace deadline, and the tombstone time. */
  private async schedule(): Promise<void> {
    const times = this.sockets("closer").map((w) => att(w).closeBy ?? 0);
    if (this.state) times.push(expiresAt(this.state));
    else if (this.tomb !== undefined) times.push(this.tomb);
    if (times.length > 0) await this.ctx.storage.setAlarm(Math.min(...times));
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
      return;
    }
    for (const w of this.sockets("closer")) {
      if ((att(w).closeBy ?? 0) > now) continue;
      // `done` first: a peer that never answers the close must not keep rescheduling the alarm.
      this.drop(w, 1000);
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
    if (new TextEncoder().encode(message).length > MAX_FRAME_BYTES) {
      ws.close(1009, "frame too large");
      return;
    }
    const frame = parseClientFrame(message);
    if (!frame) {
      this.fail(ws, "bad_proto", "malformed frame");
      return;
    }
    const a = att(ws);
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
    const admit = admitPut(a, frame.blob, now, this.limits);
    ws.serializeAttachment(a);
    if (!admit.ok) {
      this.fail(ws, admit.code, admit.message, false);
      return;
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
    });
    if (d.closeOnly) {
      log({ event: "closer_open", room: hello.room });
    } else {
      if (hello.since !== undefined) {
        const buffered = await this.ctx.storage.list<string>({
          prefix: "b:",
          start: bufferKey(hello.since + 1),
        });
        for (const [key, blob] of buffered) {
          this.send(ws, { t: "msg", seq: Number(key.slice(2)), blob });
        }
      }
      this.broadcast({ t: "presence", members }, ws);
      log({ event: "conn_open", room: hello.room, members });
    }
    await this.schedule();
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
