#!/usr/bin/env node
// Runs the agentroom CLI from the checkout this plugin lives in, in-process (KTD2).
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const entry = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/cli/dist/bin.js",
);
if (!existsSync(entry)) {
  process.stderr.write(
    `agentroom: CLI build not found at ${entry}; run \`pnpm build\` in the agentroom checkout\n`,
  );
  process.exit(1);
}
await import(pathToFileURL(entry).href);
