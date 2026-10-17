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
});
