import { hkdfSync } from "node:crypto";
import sodium from "libsodium-wrappers";
import type { z } from "zod";
import { Envelope, type EnvelopeInput } from "./envelope.js";
import { RoomMeta } from "./meta.js";

const NONCE_BYTES = 24;
const TAG_BYTES = 16;

/** Any failure to open a blob: bad encoding, tampering, wrong key or room, or schema mismatch. */
export class CryptoError extends Error {
  override name = "CryptoError";
}

function hkdf(secret: Uint8Array, info: string): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", secret, Buffer.alloc(0), info, 32));
}

/** Derive the relay-visible room id (lowercase hex) and the room key from the secret. */
export function deriveRoom(secret: Uint8Array): {
  roomId: string;
  key: Uint8Array;
} {
  return {
    roomId: Buffer.from(hkdf(secret, "agentroom/v1/room")).toString("hex"),
    key: hkdf(secret, "agentroom/v1/key"),
  };
}

async function sealJson(
  value: unknown,
  key: Uint8Array,
  roomId: string,
): Promise<string> {
  await sodium.ready;
  const nonce = sodium.randombytes_buf(NONCE_BYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    JSON.stringify(value),
    roomId,
    null,
    nonce,
    key,
  );
  return Buffer.concat([nonce, ct]).toString("base64");
}

async function openJson<T>(
  schema: z.ZodType<T>,
  blob: string,
  key: Uint8Array,
  roomId: string,
): Promise<T> {
  await sodium.ready;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(blob)) {
    throw new CryptoError("blob is not base64");
  }
  const bytes = Buffer.from(blob, "base64");
  if (bytes.length < NONCE_BYTES + TAG_BYTES) {
    throw new CryptoError("blob is too short");
  }
  let plain: string;
  try {
    plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      bytes.subarray(NONCE_BYTES),
      roomId,
      bytes.subarray(0, NONCE_BYTES),
      key,
      "text",
    );
  } catch {
    throw new CryptoError("decryption failed");
  }
  let json: unknown;
  try {
    json = JSON.parse(plain);
  } catch {
    throw new CryptoError("plaintext is not JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new CryptoError("plaintext failed schema");
  return parsed.data;
}

/** Validate and encrypt an envelope; blob = base64(nonce || ciphertext), room id as AD. */
export async function seal(
  envelope: EnvelopeInput,
  key: Uint8Array,
  roomId: string,
): Promise<string> {
  return sealJson(Envelope.parse(envelope), key, roomId);
}

export function open(
  blob: string,
  key: Uint8Array,
  roomId: string,
): Promise<Envelope> {
  return openJson(Envelope, blob, key, roomId);
}

export async function sealMeta(
  meta: z.input<typeof RoomMeta>,
  key: Uint8Array,
  roomId: string,
): Promise<string> {
  return sealJson(RoomMeta.parse(meta), key, roomId);
}

export function openMeta(
  blob: string,
  key: Uint8Array,
  roomId: string,
): Promise<RoomMeta> {
  return openJson(RoomMeta, blob, key, roomId);
}

/** Ed25519 keypair for creator-only close (verification lands in M2). Base64 keys. */
export async function generateCloseKeyPair(): Promise<{
  publicKey: string;
  secretKey: string;
}> {
  await sodium.ready;
  const kp = sodium.crypto_sign_keypair();
  return {
    publicKey: Buffer.from(kp.publicKey).toString("base64"),
    secretKey: Buffer.from(kp.privateKey).toString("base64"),
  };
}
