#!/usr/bin/env node
import { startRelay } from "./relay.js";

/** A positive number from the environment, or undefined for the relay default. */
function num(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(
      `agentroom relay: ${name} must be a positive number\n`,
    );
    process.exit(2);
  }
  return n;
}

const burst = num("RATE_BURST");
const perSec = num("RATE_PER_SEC");
const relay = await startRelay({
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "0.0.0.0",
  idleTtlSec: num("IDLE_TTL_SEC"),
  maxAgeSec: num("MAX_AGE_SEC"),
  bufferSize: num("BUFFER_SIZE"),
  maxMembers: num("MAX_MEMBERS"),
  maxClosers: num("MAX_CLOSERS"),
  rateLimit:
    burst !== undefined || perSec !== undefined
      ? { burst: burst ?? 20, perSec: perSec ?? 2 }
      : undefined,
  closeGraceMs: num("CLOSE_GRACE_MS"),
});
process.stderr.write(`agentroom relay listening on port ${relay.port}\n`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void relay.close().then(() => process.exit(0));
  });
}
