import { generateCloseKeyPair, signClose } from "@agentroom/protocol";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Conn, type Frame, newRoomId } from "./wire.js";

/** Limits every runner starts its relay with; the rest are the relay defaults. */
export const SUITE_LIMITS = { bufferSize: 5, closeGraceMs: 500 };

export interface WireRelay {
  url: string;
  close(): Promise<void>;
}

/**
 * The wire conformance suite (M4 KTD12): raw WebSockets, real short TTLs, no injected clock.
 * `extra` adds relay-specific tests that share the started relay.
 */
export function defineWireSuite(
  name: string,
  start: () => Promise<WireRelay>,
  extra?: (relay: () => WireRelay) => void,
) {
  describe(name, () => {
    let relay: WireRelay;
    const conns: Conn[] = [];
    beforeAll(async () => {
      relay = await start();
    }, 60_000);
    afterAll(async () => {
      for (const c of conns) c.close();
      await relay?.close();
    });

    const open = async (room: string) => {
      const c = await Conn.open(relay.url, room);
      conns.push(c);
      return c;
    };
    const hello = async (room: string, extra: Record<string, unknown> = {}) => {
      const c = await open(room);
      c.send({ t: "hello", room, proto: 1, ...extra });
      return c;
    };
    const create = async (
      opts: { idleTtlSec?: number; maxAgeSec?: number } = {},
    ) => {
      const room = newRoomId();
      const keys = await generateCloseKeyPair();
      const c = await hello(room, {
        create: { closeKey: keys.publicKey, meta: "bWV0YQ==", ...opts },
      });
      const welcome = await c.take("welcome");
      return { room, keys, c, welcome };
    };
    const join = async (room: string, extra: Record<string, unknown> = {}) => {
      const c = await hello(room, extra);
      return { c, welcome: await c.take("welcome") };
    };
    const blob = (n: number) => Buffer.alloc(n, 7).toString("base64");
    /** A connection over a cap: refused at the upgrade (HTTP 429) or with `room_full` after hello. */
    const expectRefused = async (
      room: string,
      extra: Record<string, unknown> = {},
    ) => {
      const c = await Conn.open(relay.url, room).catch((e: Error) => e);
      if (c instanceof Error) {
        expect(c.message).toBe("HTTP 429");
        return;
      }
      conns.push(c);
      c.send({ t: "hello", room, proto: 1, ...extra });
      expect((await c.take("error")).code).toBe("room_full");
    };

    test("create, join, presence, sender echo, and since replay", async () => {
      const { room, c: a, welcome } = await create();
      expect(welcome).toMatchObject({ seq: 0, members: 1, meta: "bWV0YQ==" });
      const { c: b, welcome: wb } = await join(room);
      expect(wb.members).toBe(2);
      expect((await a.take("presence")).members).toBe(2);
      a.send({ t: "put", blob: "AAAA" });
      expect(await a.take("msg")).toEqual({ t: "msg", seq: 1, blob: "AAAA" });
      expect(await b.take("msg")).toEqual({ t: "msg", seq: 1, blob: "AAAA" });
      a.send({ t: "put", blob: "BBBB" });
      await a.take("msg", (f) => f.seq === 2);
      const { c: late, welcome: wl } = await join(room, { since: 1 });
      expect(wl.seq).toBe(2);
      expect(await late.take("msg")).toEqual({
        t: "msg",
        seq: 2,
        blob: "BBBB",
      });
      const { c: none } = await join(room);
      a.send({ t: "put", blob: "CCCC" });
      expect((await none.take("msg")).seq).toBe(3);
      expect(none.frames.filter((f: Frame) => f.t === "msg")).toHaveLength(0);
      b.close();
      expect((await a.take("presence", (f) => f.members === 3)).members).toBe(
        3,
      );
    });

    test("the buffer keeps the last bufferSize envelopes", async () => {
      const { room, c } = await create();
      for (let i = 1; i <= 7; i++) c.send({ t: "put", blob: blob(i) });
      await c.take("msg", (f) => f.seq === 7);
      const { c: late } = await join(room, { since: 0 });
      const seqs: number[] = [];
      for (let i = 0; i < SUITE_LIMITS.bufferSize; i++) {
        seqs.push((await late.take("msg")).seq);
      }
      expect(seqs).toEqual([3, 4, 5, 6, 7]);
    });

    test("join without create is room_not_found; a second create is room_exists", async () => {
      const lone = await hello(newRoomId());
      expect((await lone.take("error")).code).toBe("room_not_found");
      const { room, keys } = await create();
      const again = await hello(room, {
        create: { closeKey: keys.publicKey, meta: "x" },
      });
      expect((await again.take("error")).code).toBe("room_exists");
    });

    test("exactly 64 KiB is accepted, one byte more is too_large, a frame over 96 KiB is refused", async () => {
      const { c } = await create();
      c.send({ t: "put", blob: blob(65_536) });
      expect((await c.take("msg")).seq).toBe(1);
      c.send({ t: "put", blob: blob(65_537) });
      expect((await c.take("error")).code).toBe("too_large");
      c.send({ t: "put", blob: "x".repeat(97 * 1024) });
      await c.waitClosed();
    });

    test("bad_proto: first frame not hello, malformed, binary, second hello, closeOnly with since", async () => {
      const room = newRoomId();
      const a = await open(room);
      a.send({ t: "put", blob: "AAAA" });
      expect((await a.take("error")).code).toBe("bad_proto");
      const b = await open(room);
      b.send("{not json");
      expect((await b.take("error")).code).toBe("bad_proto");
      const c = await open(room);
      c.ws.send(Buffer.from([1, 2, 3]));
      expect((await c.take("error")).code).toBe("bad_proto");
      const made = await create();
      made.c.send({ t: "hello", room: made.room, proto: 1 });
      expect((await made.c.take("error")).code).toBe("bad_proto");
      const d = await hello(made.room, { closeOnly: true, since: 0 });
      expect((await d.take("error")).code).toBe("bad_proto");
    });

    test("rate limit: the put past the burst is refused and the connection stays open", async () => {
      const { c } = await create();
      for (let i = 0; i < 21; i++) c.send({ t: "put", blob: "AAAA" });
      expect((await c.take("error")).code).toBe("rate_limited");
      expect(c.closed).toBe(false);
    });

    test("room cap: the ninth member is room_full; closers are admitted until the per-address cap", async () => {
      const { room } = await create();
      for (let i = 0; i < 7; i++) await join(room);
      const ninth = await hello(room);
      expect((await ninth.take("error")).code).toBe("room_full");
      await ninth.waitClosed();
      const c1 = await join(room, { closeOnly: true });
      await join(room, { closeOnly: true });
      expect(c1.welcome.nonce).toBeTypeOf("string");
      // The eleventh socket from one address: relay-cf refuses the upgrade, relay-node the hello.
      await expectRefused(room, { closeOnly: true });
      expect(c1.c.frames).toEqual([]);
      expect(c1.c.closed).toBe(false);
    });

    test("a room-id holder looping close-only hellos cannot stop the creator's close", async () => {
      const { room, keys, c: creator } = await create();
      let stop = false;
      const attack = (async () => {
        const held: Conn[] = [];
        while (!stop) {
          const c = await Conn.open(relay.url, room).catch(() => undefined);
          if (!c) continue;
          held.push(c);
          c.send({ t: "hello", room, proto: 1, closeOnly: true });
          await c.take("welcome", () => true, 2000).catch(() => {});
          if (held.length > 3) held.shift()?.close();
        }
        for (const c of held) c.close();
      })();
      try {
        await new Promise((r) => setTimeout(r, 300));
        const { c, welcome } = await join(room, { closeOnly: true });
        await new Promise((r) => setTimeout(r, 300));
        c.send({
          t: "close",
          sig: await signClose(keys.secretKey, room, welcome.nonce),
        });
        await c.take("closed");
        await creator.take("closed");
      } finally {
        stop = true;
        await attack;
      }
    });

    test("a closer that never sends close is dropped after the grace period", async () => {
      const { room } = await create();
      const { c } = await join(room, { closeOnly: true });
      c.send({ t: "put", blob: "AAAA" });
      expect((await c.take("error")).code).toBe("bad_proto");
      const { c: idle } = await join(room, { closeOnly: true });
      await idle.waitClosed(SUITE_LIMITS.closeGraceMs + 4000);
    });

    test("AE6: a wrong key or replayed nonce is bad_signature; a valid close ends the room for all", async () => {
      const { room, keys, c: a, welcome } = await create();
      const { c: b } = await join(room);
      const other = await generateCloseKeyPair();
      const { c: wrong, welcome: ww } = await join(room, { closeOnly: true });
      wrong.send({
        t: "close",
        sig: await signClose(other.secretKey, room, ww.nonce),
      });
      expect((await wrong.take("error")).code).toBe("bad_signature");
      const { c: replay } = await join(room, { closeOnly: true });
      replay.send({
        t: "close",
        sig: await signClose(keys.secretKey, room, welcome.nonce),
      });
      expect((await replay.take("error")).code).toBe("bad_signature");
      a.send({ t: "put", blob: "AAAA" });
      expect((await b.take("msg")).seq).toBe(1);
      a.send({
        t: "close",
        sig: await signClose(keys.secretKey, room, welcome.nonce),
      });
      await a.take("closed");
      await b.take("closed");
      await b.waitClosed();
      const again = await hello(room);
      expect((await again.take("error")).code).toBe("room_expired");
      const recreate = await hello(room, {
        create: { closeKey: keys.publicKey, meta: "x" },
      });
      expect((await recreate.take("error")).code).toBe("room_expired");
    });

    test("AE5: idle expiry pushes room_expired and the id stays dead", async () => {
      const { room, c } = await create({ idleTtlSec: 2 });
      const { c: b } = await join(room);
      expect((await c.take("error", () => true, 8000)).code).toBe(
        "room_expired",
      );
      expect((await b.take("error", () => true, 8000)).code).toBe(
        "room_expired",
      );
      await c.waitClosed();
      const again = await hello(room, { create: { closeKey: "k", meta: "x" } });
      expect((await again.take("error")).code).toBe("room_expired");
    }, 15_000);

    test("max age expires a room even with activity", async () => {
      const { c } = await create({ maxAgeSec: 2 });
      const timer = setInterval(() => c.send({ t: "put", blob: "AAAA" }), 400);
      try {
        expect(
          (await c.take("error", (f) => f.code === "room_expired", 8000)).code,
        ).toBe("room_expired");
      } finally {
        clearInterval(timer);
      }
    }, 15_000);

    extra?.(() => relay);
  });
}
