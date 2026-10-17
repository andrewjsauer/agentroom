import { hkdfSync } from "node:crypto";
import sodium from "libsodium-wrappers";
import { describe, expect, test } from "vitest";
import {
  CryptoError,
  deriveRoom,
  type EnvelopeInput,
  generateCloseKeyPair,
  open,
  openMeta,
  seal,
  sealMeta,
} from "../src/index.js";

const secret = new Uint8Array(32).map((_, i) => i);
const other = new Uint8Array(32).fill(7);

const env: EnvelopeInput = {
  v: 1,
  id: "01J00000000000000000000000",
  ts: 1_700_000_000_000,
  from: { member: "alice", agent: "claude-code", via: "mcp" },
  kind: "question",
  thread: "01J00000000000000000000000",
  body: "hello",
  refs: [{ repo: "r", path: "p", lines: "1-2" }],
};

function flip(blob: string, index: number): string {
  const bytes = Buffer.from(blob, "base64");
  bytes[index] = (bytes[index] as number) ^ 0x01;
  return bytes.toString("base64");
}

describe("deriveRoom", () => {
  test("matches an independent HKDF computation with the documented info strings", () => {
    const { roomId, key } = deriveRoom(secret);
    const expectId = Buffer.from(
      hkdfSync("sha256", secret, Buffer.alloc(0), "agentroom/v1/room", 32),
    ).toString("hex");
    const expectKey = new Uint8Array(
      hkdfSync("sha256", secret, Buffer.alloc(0), "agentroom/v1/key", 32),
    );
    expect(roomId).toBe(expectId);
    expect(roomId).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toEqual(expectKey);
    expect(Buffer.from(key).toString("hex")).not.toBe(roomId);
  });
});

describe("seal/open", () => {
  const { roomId, key } = deriveRoom(secret);

  test("round trips to a deep-equal envelope", async () => {
    const blob = await seal(env, key, roomId);
    expect(await open(blob, key, roomId)).toEqual({
      ...env,
      requiresHuman: false,
    });
  });

  test("two seals of the same envelope differ (fresh nonce)", async () => {
    expect(await seal(env, key, roomId)).not.toBe(await seal(env, key, roomId));
  });

  test.each([
    ["nonce", 0],
    ["ciphertext body", 30],
    ["tag", -1],
  ])("a flipped byte in the %s makes open throw", async (_name, index) => {
    const blob = await seal(env, key, roomId);
    const len = Buffer.from(blob, "base64").length;
    const at = index < 0 ? len + index : index;
    await expect(open(flip(blob, at), key, roomId)).rejects.toThrow(
      CryptoError,
    );
  });

  test("a key from a different secret fails", async () => {
    const blob = await seal(env, key, roomId);
    await expect(open(blob, deriveRoom(other).key, roomId)).rejects.toThrow(
      CryptoError,
    );
  });

  test("the right key with another roomId fails (associated data)", async () => {
    const blob = await seal(env, key, roomId);
    await expect(open(blob, key, deriveRoom(other).roomId)).rejects.toThrow(
      CryptoError,
    );
  });

  test.each([
    ["a too-short blob", Buffer.alloc(39).toString("base64")],
    ["invalid base64", "!!!not base64!!!"],
  ])("%s throws CryptoError", async (_name, blob) => {
    await expect(open(blob, key, roomId)).rejects.toThrow(CryptoError);
  });

  test("a validly sealed non-envelope value fails at the schema step", async () => {
    await sodium.ready;
    const nonce = sodium.randombytes_buf(24);
    const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      JSON.stringify({ hello: "world" }),
      roomId,
      null,
      nonce,
      key,
    );
    const blob = Buffer.concat([nonce, ct]).toString("base64");
    await expect(open(blob, key, roomId)).rejects.toThrow(CryptoError);
  });

  test.each([
    ["an out-of-range ts", { ts: 1e20 }],
    [
      "a 50,000-character member (an older or hostile peer)",
      { from: { member: "m".repeat(50_000), agent: "codex", via: "mcp" } },
    ],
    ["an absolute ref path", { refs: [{ repo: "r", path: "/etc/passwd" }] }],
  ])(
    "a sealed envelope with %s fails at the schema step on receive",
    async (_name, patch) => {
      await sodium.ready;
      const nonce = sodium.randombytes_buf(24);
      const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        JSON.stringify({ ...env, ...patch }),
        roomId,
        null,
        nonce,
        key,
      );
      const blob = Buffer.concat([nonce, ct]).toString("base64");
      await expect(open(blob, key, roomId)).rejects.toThrow(CryptoError);
    },
  );

  test("invariant 1: the blob bytes do not contain the plaintext body", async () => {
    const marker = `PLAINTEXT-MARKER-${"z".repeat(64)}`;
    const blob = await seal({ ...env, body: marker }, key, roomId);
    expect(Buffer.from(blob, "base64").toString("latin1")).not.toContain(
      marker,
    );
    expect(blob).not.toContain(marker);
  });
});

describe("meta", () => {
  const { roomId, key } = deriveRoom(secret);

  test("round trips", async () => {
    const blob = await sealMeta({ maxAgentChain: 5, name: "x" }, key, roomId);
    expect(await openMeta(blob, key, roomId)).toEqual({
      maxAgentChain: 5,
      name: "x",
    });
  });

  test("wrong roomId fails", async () => {
    const blob = await sealMeta({ maxAgentChain: 3 }, key, roomId);
    await expect(openMeta(blob, key, deriveRoom(other).roomId)).rejects.toThrow(
      CryptoError,
    );
  });

  test("sealMeta refuses a chain limit outside 1..10", async () => {
    await expect(
      sealMeta({ maxAgentChain: 11 }, key, roomId),
    ).rejects.toThrow();
    await expect(sealMeta({ maxAgentChain: 0 }, key, roomId)).rejects.toThrow();
    await expect(
      sealMeta({ maxAgentChain: 10 }, key, roomId),
    ).resolves.toBeTypeOf("string");
  });

  test("an older creator's out-of-range limit is clamped to 10 and reported", async () => {
    await sodium.ready;
    const nonce = sodium.randombytes_buf(24);
    const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      JSON.stringify({ maxAgentChain: 1_000_000 }),
      roomId,
      null,
      nonce,
      key,
    );
    const legacy = Buffer.concat([nonce, ct]).toString("base64");
    const m = await openMeta(legacy, key, roomId);
    expect(m.maxAgentChain).toBe(10);
    expect(m.clampedFrom).toBe(1_000_000);
    const fresh = await openMeta(
      await sealMeta({ maxAgentChain: 4 }, key, roomId),
      key,
      roomId,
    );
    expect(fresh.clampedFrom).toBeUndefined();
  });

  test("a meta blob passed to open fails schema separation", async () => {
    const blob = await sealMeta({ maxAgentChain: 3 }, key, roomId);
    await expect(open(blob, key, roomId)).rejects.toThrow(CryptoError);
  });
});

test("close keypair is Ed25519 and signs verifiably", async () => {
  const { publicKey, secretKey } = await generateCloseKeyPair();
  const pk = Buffer.from(publicKey, "base64");
  const sk = Buffer.from(secretKey, "base64");
  expect(pk).toHaveLength(32);
  expect(sk).toHaveLength(64);
  await sodium.ready;
  const sig = sodium.crypto_sign_detached("room||nonce", sk);
  expect(sodium.crypto_sign_verify_detached(sig, "room||nonce", pk)).toBe(true);
});

describe("close signatures", () => {
  const roomId = "b".repeat(64);
  const nonce = Buffer.alloc(16, 3).toString("base64");

  test("round trip, and false for any mismatch or malformed input", async () => {
    const { signClose, verifyClose } = await import("../src/index.js");
    const kp = await generateCloseKeyPair();
    const other = await generateCloseKeyPair();
    const sig = await signClose(kp.secretKey, roomId, nonce);
    expect(await verifyClose(kp.publicKey, sig, roomId, nonce)).toBe(true);
    expect(await verifyClose(kp.publicKey, sig, "c".repeat(64), nonce)).toBe(
      false,
    );
    const nonce2 = Buffer.alloc(16, 4).toString("base64");
    expect(await verifyClose(kp.publicKey, sig, roomId, nonce2)).toBe(false);
    expect(await verifyClose(other.publicKey, sig, roomId, nonce)).toBe(false);
    expect(
      await verifyClose(kp.publicKey, sig.slice(0, 20), roomId, nonce),
    ).toBe(false);
    expect(await verifyClose(kp.publicKey, "not base64!", roomId, nonce)).toBe(
      false,
    );
    expect(await verifyClose("pk", sig, roomId, nonce)).toBe(false);
  });
});
