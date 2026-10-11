#!/usr/bin/env node
import { startRelay } from "./relay.js";

const relay = await startRelay({
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "0.0.0.0",
});
process.stderr.write(`agentroom relay listening on port ${relay.port}\n`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void relay.close().then(() => process.exit(0));
  });
}
