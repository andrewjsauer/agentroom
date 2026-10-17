import { CliError } from "./context.js";
import { safeLine } from "./safe-text.js";

/** Placeholder default; no relay is deployed there yet (plan KTD14). Override with --relay or AGENTROOM_RELAY. */
export const DEFAULT_RELAY = "wss://agentroom-relay.sauerapple.workers.dev";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Throw unless `url` is `wss://`, or `ws://` to a loopback host. A relay URL in any other scheme
 * would send the room id and ciphertext in the clear or to something that is not a relay.
 */
export function checkRelayUrl(url: string, source: string): string {
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }
  if (
    parsed?.protocol === "wss:" ||
    (parsed?.protocol === "ws:" && LOOPBACK.has(parsed.hostname))
  ) {
    return url;
  }
  throw new CliError(
    `refusing relay URL ${JSON.stringify(safeLine(url))} from ${source}: use wss://; ws:// is allowed only for localhost, 127.0.0.1 or ::1`,
  );
}

/** `--relay` flag, then `AGENTROOM_RELAY`, then the default constant; checked by checkRelayUrl. */
export function resolveRelay(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  if (flag) return checkRelayUrl(flag, "--relay");
  if (env.AGENTROOM_RELAY) {
    return checkRelayUrl(env.AGENTROOM_RELAY, "AGENTROOM_RELAY");
  }
  return DEFAULT_RELAY;
}
