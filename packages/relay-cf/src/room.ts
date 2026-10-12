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
  role: "pending" | "member" | "closer";
  nonce?: string;
  tokens: number;
  refilledAt: number;
  joinedAt: number;
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
    maxClosers: n(env.MAX_CLOSERS, d.maxClosers),
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
    const [client, server] = Object.values(new WebSocketPair()) as [
      WebSocket,
      WebSocket,
    ];
    this.ctx.acceptWebSocket(server);
    const now = Date.now();
    server.serializeAttachment({
      room,
      role: "pending",
      tokens: this.limits.rateBurst,
      refilledAt: now,
      joinedAt: now,
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
    if (end) ws.close(1000);
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
      if (att(w).role === "pending") continue;
      this.send(w, frame);
      w.close(1000);
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
      if ((att(w).closeBy ?? 0) <= now) w.close(1000);
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
      closers: this.sockets("closer").length,
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
    if (d.evictCloser) {
      const [oldest] = this.sockets("closer").sort(
        (x, y) => att(x).joinedAt - att(y).joinedAt,
      );
      if (oldest) {
        // Evict rather than refuse: a leaked share code must not be able to block close.
        oldest.serializeAttachment({ ...att(oldest), role: "pending" });
        this.fail(
          oldest,
          "room_full",
          "replaced by a newer close-only connection",
        );
      }
    }
    a.nonce = newNonce();
    a.joinedAt = now;
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
    if (this.state !== state) return;
    await this.end("closed");
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const a = att(ws);
    ws.serializeAttachment({ ...a, role: "pending" });
    if (a.role !== "member" || !this.state) return;
    const members = this.sockets("member", ws).length;
    this.broadcast({ t: "presence", members }, ws);
    log({ event: "conn_close", room: a.room, members });
  }
}
