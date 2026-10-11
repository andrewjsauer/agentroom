import { expect, test } from "vitest";
import { PROTOCOL_VERSION } from "../src/index.js";

test("PROTOCOL_VERSION matches the proto value in the hello frame", () => {
  expect(PROTOCOL_VERSION).toBe(1);
});
