import { PING_FRAME } from "@agentroom/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { CF_SKIP, CF_TITLE, type CfRelay, startCfRelay } from "./cf-helpers.js";
import { Conn, newRoomId } from "./wire.js";

/** relay-cf limits that need their own Worker settings, on local workerd. */
describe.skipIf(CF_SKIP)(CF_TITLE, () => {
  let cf: CfRelay | undefined;
  const conns: Conn[] = [];
  afterEach(async () => {
    for (const c of conns.splice(0)) c.close();
    await cf?.close();
    cf = undefined;
  });

  test("the Worker answers HTTP 429 once an address exceeds its upgrade rate", async () => {
    const limit = 3;
    cf = await startCfRelay({}, { limit, period: 60 });
    // The local limiter counts per wall-clock minute, so a run that crosses a minute boundary
    // gets a fresh window once: allow for that instead of assuming a 429 on attempt limit + 1.
    let opened = 0;
    let refused: unknown;
    for (let i = 0; i < 2 * limit + 1 && !refused; i++) {
      try {
        conns.push(await Conn.open(cf.url, newRoomId()));
        opened++;
      } catch (e) {
        refused = e;
      }
    }
    expect(String(refused)).toContain("HTTP 429");
    expect(opened).toBeGreaterThanOrEqual(limit);
  }, 60_000);

  test("since replay reads storage in pages and still delivers every envelope in order", async () => {
    cf = await startCfRelay({ RATE_BURST: "500" });
    const room = newRoomId();
    const a = await Conn.open(cf.url, room);
    conns.push(a);
    a.send({
      t: "hello",
      room,
      proto: 1,
      create: { closeKey: "k", meta: "m" },
    });
    await a.take("welcome");
    for (let i = 0; i < 120; i++) a.send({ t: "put", blob: "AAAA" });
    await a.take("msg", (f) => f.seq === 120, 20_000);
    const late = await Conn.open(cf.url, room);
    conns.push(late);
    late.send({ t: "hello", room, proto: 1, since: 3 });
    await late.take("welcome");
    await late.take("msg", (f) => f.seq === 120, 20_000);
    const seqs = late.frames.filter((f) => f.t === "msg").map((f) => f.seq);
    expect([...seqs, 120]).toEqual(
      Array.from({ length: 117 }, (_, i) => i + 4),
    );
  }, 60_000);

  test("a silent member is closed after MEMBER_IDLE_MS; one that pings stays", async () => {
    cf = await startCfRelay({ MEMBER_IDLE_MS: "1500" });
    const room = newRoomId();
    const silent = await Conn.open(cf.url, room);
    const pinging = await Conn.open(cf.url, room);
    conns.push(silent, pinging);
    silent.send({
      t: "hello",
      room,
      proto: 1,
      create: { closeKey: "k", meta: "m" },
    });
    await silent.take("welcome");
    pinging.send({ t: "hello", room, proto: 1 });
    const welcome = await pinging.take("welcome");
    expect(welcome.ping).toBe(375);
    const timer = setInterval(() => pinging.send(PING_FRAME), 300);
    try {
      await pinging.take("pong");
      expect(await silent.waitClosed(6000)).toBe(1001);
      expect(
        (await pinging.take("presence", (f) => f.members === 1)).members,
      ).toBe(1);
      await new Promise((r) => setTimeout(r, 2000));
      expect(pinging.closed).toBe(false);
    } finally {
      clearInterval(timer);
    }
  }, 60_000);
});
