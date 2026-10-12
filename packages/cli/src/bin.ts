#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { main } from "./index.js";

const code = await main(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  isTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
  entryPath: fileURLToPath(import.meta.url),
});
process.exitCode = code;
