import { startRelay } from "@agentroom/relay-node";
import { defineWireSuite, SUITE_LIMITS } from "./wire-suite.js";

defineWireSuite("wire conformance: relay-node", () =>
  startRelay({
    port: 0,
    log: () => {},
    sweepIntervalMs: 200,
    // The suite holds every connection open until it ends, all from 127.0.0.1.
    maxConnsPerIp: 1000,
    ...SUITE_LIMITS,
  }),
);
