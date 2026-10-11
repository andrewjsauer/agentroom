import { randomBytes } from "node:crypto";

const PREFIX = "ar1_";

export class ShareCodeError extends Error {
  override name = "ShareCodeError";
}

/** Generate a fresh room secret and its share code (`ar1_` + unpadded base64url). */
export function generateShareCode(): { code: string; secret: Uint8Array } {
  const secret = new Uint8Array(randomBytes(32));
  return { code: PREFIX + Buffer.from(secret).toString("base64url"), secret };
}

/** Parse a share code strictly and canonically; returns the 32-byte secret. */
export function parseShareCode(code: string): Uint8Array {
  if (!code.startsWith(PREFIX)) {
    throw new ShareCodeError("share code must start with ar1_");
  }
  const payload = code.slice(PREFIX.length);
  if (payload.length !== 43) {
    throw new ShareCodeError("share code has the wrong length");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(payload)) {
    throw new ShareCodeError("share code contains invalid characters");
  }
  const bytes = Buffer.from(payload, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== payload) {
    throw new ShareCodeError("share code is not canonically encoded");
  }
  return new Uint8Array(bytes);
}
