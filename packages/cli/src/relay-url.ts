/** Placeholder default; no relay is deployed there yet (plan KTD14). Override with --relay or AGENTROOM_RELAY. */
export const DEFAULT_RELAY = "wss://relay.agentroom.dev";

/** `--relay` flag, then `AGENTROOM_RELAY`, then the default constant. */
export function resolveRelay(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  return flag || env.AGENTROOM_RELAY || DEFAULT_RELAY;
}
