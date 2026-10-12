import { describe, expect, test } from "vitest";
import { ClientFrame, RelayFrame } from "../src/index.js";

const room = "a".repeat(64);

describe("ClientFrame", () => {
  test.each([
    { t: "hello", room, proto: 1 },
    { t: "hello", room, proto: 1, since: 0 },
    {
      t: "hello",
      room,
      proto: 1,
      create: { closeKey: "k", idleTtlSec: 60, maxAgeSec: 120, meta: "m" },
    },
    { t: "put", blob: "AAAA" },
    { t: "close", sig: "c2ln" },
  ])("parses %j", (frame) => {
    expect(ClientFrame.parse(frame)).toEqual(frame);
  });

  test.each([
    ["proto 2", { t: "hello", room, proto: 2 }],
    ["uppercase room", { t: "hello", room: "A".repeat(64), proto: 1 }],
    ["63-character room", { t: "hello", room: "a".repeat(63), proto: 1 }],
    ["negative since", { t: "hello", room, proto: 1, since: -1 }],
    ["unknown t", { t: "nope" }],
    [
      "create without closeKey",
      { t: "hello", room, proto: 1, create: { meta: "m" } },
    ],
    [
      "create without meta",
      { t: "hello", room, proto: 1, create: { closeKey: "k" } },
    ],
  ])("rejects %s", (_name, frame) => {
    expect(ClientFrame.safeParse(frame).success).toBe(false);
  });
});

describe("RelayFrame", () => {
  test.each([
    {
      t: "welcome",
      seq: 0,
      members: 1,
      expiresAt: 1,
      nonce: "n",
      meta: "m",
    },
    { t: "msg", seq: 1, blob: "AAAA" },
    { t: "presence", members: 2 },
    { t: "closed" },
    { t: "error", code: "room_not_found", message: "gone" },
  ])("parses %j", (frame) => {
    expect(RelayFrame.parse(frame)).toEqual(frame);
  });

  test("accepts all eight error codes and rejects others", () => {
    for (const code of [
      "room_not_found",
      "room_expired",
      "room_exists",
      "bad_signature",
      "too_large",
      "rate_limited",
      "room_full",
      "bad_proto",
    ]) {
      expect(
        RelayFrame.safeParse({ t: "error", code, message: "" }).success,
      ).toBe(true);
    }
    expect(
      RelayFrame.safeParse({ t: "error", code: "nope", message: "" }).success,
    ).toBe(false);
  });
});

test("hello accepts closeOnly: true and rejects other values", async () => {
  const { HelloFrame } = await import("../src/index.js");
  const base = { t: "hello", room: "a".repeat(64), proto: 1 };
  expect(HelloFrame.parse({ ...base, closeOnly: true }).closeOnly).toBe(true);
  expect(HelloFrame.safeParse({ ...base, closeOnly: false }).success).toBe(
    false,
  );
});
