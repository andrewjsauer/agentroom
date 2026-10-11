import { describe, expect, test } from "vitest";
import {
  generateShareCode,
  parseShareCode,
  ShareCodeError,
} from "../src/index.js";

describe("share code", () => {
  test("generate then parse returns the same 32 bytes", () => {
    const { code, secret } = generateShareCode();
    expect(code.startsWith("ar1_")).toBe(true);
    expect(code).toHaveLength(47);
    expect(parseShareCode(code)).toEqual(secret);
    expect(secret).toHaveLength(32);
  });

  const valid = generateShareCode().code;
  const payload = valid.slice(4);
  // 'B' has a non-zero low bit; the final base64url char of 32 bytes carries 2 unused bits.
  const nonCanonical = `ar1_${"A".repeat(42)}B`;

  test.each([
    ["ar2_ prefix", `ar2_${payload}`],
    ["missing prefix", payload],
    ["42 payload characters", `ar1_${payload.slice(0, 42)}`],
    ["44 payload characters", `ar1_${payload}A`],
    ["= padding", `ar1_${payload.slice(0, 42)}=`],
    ["+ character", `ar1_+${payload.slice(1)}`],
    ["/ character", `ar1_/${payload.slice(1)}`],
    ["whitespace", `ar1_ ${payload.slice(1)}`],
    ["non-canonical final character", nonCanonical],
  ])("rejects %s", (_name, code) => {
    expect(() => parseShareCode(code)).toThrow(ShareCodeError);
  });
});
