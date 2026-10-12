import { startRelay } from "@agentroom/relay-node";
import { defineWireSuite, SUITE_LIMITS } from "./wire-suite.js";

defineWireSuite("wire conformance: relay-node", () =>
  startRelay({
    port: 0,
    log: () => {},
    sweepIntervalMs: 200,
    ...SUITE_LIMITS,
  }),
);
