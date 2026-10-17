#!/usr/bin/env node
import { positiveInt } from "@agentroom/protocol/relay-core";
import { startRelay } from "./relay.js";

/** A positive integer from the environment, or undefined for the relay default; exits on junk. */
function num(name: string): number | undefined {
  try {
    return positiveInt(name, process.env[name]);
  } catch (err) {
    process.stderr.write(`agentroom relay: ${(err as Error).message}\n`);
    process.exit(2);
  }
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
  maxRoomConnsPerIp: num("MAX_ROOM_CONNS_PER_IP"),
  rateLimit:
    burst !== undefined || perSec !== undefined
      ? { burst: burst ?? 20, perSec: perSec ?? 2 }
      : undefined,
  closeGraceMs: num("CLOSE_GRACE_MS"),
  helloTimeoutMs: num("HELLO_TIMEOUT_MS"),
  pingIntervalMs: num("PING_INTERVAL_MS"),
  maxRooms: num("MAX_ROOMS"),
  maxConns: num("MAX_CONNS"),
  maxConnsPerIp: num("MAX_CONNS_PER_IP"),
  maxBufferedBytes: num("MAX_BUFFERED_BYTES"),
  maxSendBufferBytes: num("MAX_SEND_BUFFER_BYTES"),
  emptyRoomTtlSec: num("EMPTY_ROOM_TTL_SEC"),
});
process.stderr.write(`agentroom relay listening on port ${relay.port}\n`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void relay.close().then(() => process.exit(0));
  });
}
