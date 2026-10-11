import { expect, test } from "vitest";
import { isUlid, ulid } from "../src/index.js";

test("ulid is 26 Crockford base32 characters", () => {
  const id = ulid();
  expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(isUlid(id)).toBe(true);
  expect(isUlid("not-a-ulid")).toBe(false);
});

test("ids from different milliseconds sort lexically in time order", () => {
  const a = ulid(1_700_000_000_000);
  const b = ulid(1_700_000_000_001);
  const c = ulid(1_800_000_000_000);
  expect([c, a, b].sort()).toEqual([a, b, c]);
});

test("1,000 ids are unique", () => {
  const ids = new Set(Array.from({ length: 1000 }, () => ulid()));
  expect(ids.size).toBe(1000);
});
