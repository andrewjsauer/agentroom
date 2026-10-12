import { isObject } from "../claude-settings.js";
import { CliError } from "../context.js";
import type { ServerEntry } from "./toml.js";

function parse(text: string, file: string): Record<string, unknown> {
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!isObject(parsed)) {
    throw new CliError(
      `${file} is not a JSON object; fix or remove it, then rerun`,
    );
  }
  return parsed;
}

const stringify = (config: Record<string, unknown>) =>
  `${JSON.stringify(config, null, 2)}\n`;

/** Set `mcpServers.agentroom`, keeping every other key. */
export function setJsonEntry(
  text: string,
  file: string,
  entry: ServerEntry & { type?: "stdio" },
): string {
  const config = parse(text, file);
  if (config.mcpServers !== undefined && !isObject(config.mcpServers)) {
    throw new CliError(
      `${file} has an mcpServers value that is not an object; fix it, then rerun`,
    );
  }
  const servers = config.mcpServers ?? {};
  servers.agentroom = entry;
  config.mcpServers = servers;
  return stringify(config);
}

/** Delete `mcpServers.agentroom`; drop an emptied `mcpServers`, and return "" for an emptied file. */
export function removeJsonEntry(text: string, file: string): string {
  const config = parse(text, file);
  const servers = config.mcpServers;
  if (!isObject(servers) || !("agentroom" in servers)) return text;
  delete servers.agentroom;
  if (Object.keys(servers).length === 0) delete config.mcpServers;
  return Object.keys(config).length === 0 ? "" : stringify(config);
}
