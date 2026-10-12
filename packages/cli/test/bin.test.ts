import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

/** Runs against the built output; the verification contract builds before testing. */
test("dist/bin.js starts with a node shebang and is executable", () => {
  const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
  expect(readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(
    true,
  );
  expect(statSync(bin).mode & 0o111).not.toBe(0);
});
