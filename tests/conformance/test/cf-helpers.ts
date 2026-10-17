import { fileURLToPath } from "node:url";

/** wrangler and miniflare declare engines.node >=22, so relay-cf tests run on Node 22+ only (M4 KTD9). */
export const nodeMajor = Number(process.versions.node.split(".")[0]);
export const CF_SKIP = nodeMajor < 22;
/** The describe title: names the skip reason when skipped, so it shows in the output. */
export const CF_TITLE = CF_SKIP
  ? `relay-cf SKIPPED on Node ${process.versions.node}: wrangler requires Node >=22`
  : "relay-cf on local workerd";

const CONFIG = fileURLToPath(
  new URL("../../../packages/relay-cf/wrangler.jsonc", import.meta.url),
);

export interface CfRelay {
  url: string;
  /** HTTP base URL, for the test-only storage inspection route. */
  http: string;
  /** Everything the worker and wrangler wrote to stdout since start. */
  logs(): string;
  close(): Promise<void>;
}

/**
 * Start relay-cf on local workerd through wrangler's `unstable_startWorker`, offline, on an
 * ephemeral port. `vars` override the wrangler.jsonc limits; TEST_INSPECT is always on here.
 */
export async function startCfRelay(
  vars: Record<string, string> = {},
  /** WebSocket upgrades per address per period; tests open far more than the deployed 60/min. */
  upgradeLimit: { limit: number; period: 10 | 60 } = {
    limit: 100_000,
    period: 60,
  },
): Promise<CfRelay> {
  process.env.WRANGLER_SEND_METRICS = "false";
  const { unstable_startWorker } = await import("wrangler");
  // Worker console output reaches wrangler's logger, which writes through console.
  let out = "";
  const methods = ["log", "info", "warn", "error"] as const;
  const saved = methods.map((m) => console[m]);
  for (const [i, m] of methods.entries()) {
    console[m] = (...args: unknown[]) => {
      out += `${args.map(String).join(" ")}\n`;
      saved[i]?.(...args);
    };
  }
  const bindings = {
    ...Object.fromEntries(
      Object.entries({ ...vars, TEST_INSPECT: "1" }).map(([k, value]) => [
        k,
        { type: "plain_text" as const, value },
      ]),
    ),
    // A fresh namespace per relay, so counts never carry over between test files.
    UPGRADE_LIMITER: {
      type: "ratelimit" as const,
      namespace_id: String(1000 + Math.floor(Math.random() * 1e6)),
      simple: upgradeLimit,
    },
  };
  const worker = await unstable_startWorker({
    config: CONFIG,
    bindings,
    dev: {
      server: { port: 0 },
      inspector: false,
      persist: false,
      watch: false,
    },
  });
  await worker.ready;
  const http = (await worker.url).href.replace(/\/$/, "");
  return {
    url: http.replace(/^http/, "ws"),
    http,
    logs: () => out,
    async close() {
      for (const [i, m] of methods.entries()) {
        console[m] = saved[i] as (typeof console)[typeof m];
      }
      await worker.dispose();
    },
  };
}
