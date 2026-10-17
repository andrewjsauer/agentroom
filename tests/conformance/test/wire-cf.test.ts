import {
  deriveRoom,
  generateCloseKeyPair,
  generateShareCode,
  parseShareCode,
  seal,
  signClose,
  ulid,
} from "@agentroom/protocol";
import { describe, expect, test } from "vitest";
import { CF_SKIP, CF_TITLE, type CfRelay, startCfRelay } from "./cf-helpers.js";
import { Conn, newRoomId } from "./wire.js";
import { defineWireSuite, SUITE_LIMITS } from "./wire-suite.js";

let cf: CfRelay;

describe.skipIf(CF_SKIP)(CF_TITLE, () => {
  defineWireSuite(
    "wire conformance: relay-cf",
    async () => {
      cf = await startCfRelay({
        BUFFER_SIZE: String(SUITE_LIMITS.bufferSize),
        CLOSE_GRACE_MS: String(SUITE_LIMITS.closeGraceMs),
        HELLO_TIMEOUT_MS: String(SUITE_LIMITS.helloTimeoutMs),
      });
      return cf;
    },
    () => {
      test("an upgrade without a valid room is HTTP 400; a hello for another room is bad_proto", async () => {
        await expect(Conn.open(cf.url)).rejects.toThrow("HTTP 400");
        await expect(Conn.open(cf.url, "NOT-HEX")).rejects.toThrow("HTTP 400");
        const c = await Conn.open(cf.url, newRoomId());
        c.send({
          t: "hello",
          room: newRoomId(),
          proto: 1,
          create: { closeKey: "k", meta: "m" },
        });
        expect((await c.take("error")).code).toBe("bad_proto");
        c.close();
      });

      test("invariant 1 and 7: storage holds only the room record and ciphertext, then only the tombstone", async () => {
        const { code } = generateShareCode();
        const { roomId, key } = deriveRoom(parseShareCode(code));
        const keys = await generateCloseKeyPair();
        const plain = `plaintext-marker-${ulid()}`;
        const a = await Conn.open(cf.url, roomId);
        a.send({
          t: "hello",
          room: roomId,
          proto: 1,
          create: { closeKey: keys.publicKey, meta: "bWV0YQ==" },
        });
        const welcome = await a.take("welcome");
        const id = ulid();
        const blob = await seal(
          {
            v: 1,
            id,
            ts: Date.now(),
            from: { member: "a", agent: "codex", via: "mcp" },
            kind: "fyi",
            thread: id,
            body: plain,
          },
          key,
          roomId,
        );
        a.send({ t: "put", blob });
        await a.take("msg");
        const inspect = async () =>
          (
            await fetch(`${cf.http}/__inspect?room=${roomId}`)
          ).json() as Promise<Record<string, unknown>>;
        const live = await inspect();
        expect(Object.keys(live).sort()).toEqual(["b:0000000001", "room"]);
        expect(live["b:0000000001"]).toBe(blob);
        expect(Object.keys(live.room as object).sort()).toEqual([
          "closeKey",
          "createdAt",
          "idleTtlSec",
          "lastActivity",
          "maxAgeSec",
          "meta",
          "roomId",
          "seq",
        ]);
        const dump = JSON.stringify(live);
        expect(dump).not.toContain(plain);
        expect(dump).not.toContain(code);
        const sig = await signClose(keys.secretKey, roomId, welcome.nonce);
        a.send({ t: "close", sig });
        await a.take("closed");
        const after = await inspect();
        expect(Object.keys(after)).toEqual(["tomb"]);
        expect(typeof after.tomb).toBe("number");
        const logs = cf.logs();
        expect(logs).toContain('"event":"room_closed"');
        expect(logs).not.toContain(blob.slice(0, 40));
        expect(logs).not.toContain(sig);
        expect(logs).not.toContain(plain);
        a.close();
      });
    },
  );
});
