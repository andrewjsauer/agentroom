import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 48-bit millisecond time plus 80 random bits, Crockford base32 (26 characters). */
export function ulid(now: number = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[(bytes[i] as number) % 32];
  return time + rand;
}

export function isUlid(s: string): boolean {
  return /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(s);
}
