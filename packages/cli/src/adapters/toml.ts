import { CliError } from "../context.js";

export interface ServerEntry {
  command: string;
  args: string[];
}

const HEADER = /^\s*(\[\[?)\s*(.+?)\s*\]\]?\s*(?:#.*)?$/;

/** Split a dotted TOML key into its parts, unquoting `"a"` and `'a'` parts. */
function keyParts(key: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (const ch of key) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ".") {
      parts.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur.trim());
  return parts;
}

/** The multi-line string delimiter still open at the end of `line`, given the one open at its start. */
function multilineState(
  line: string,
  open: string | undefined,
): string | undefined {
  let state = open;
  let i = 0;
  while (i < line.length) {
    if (state) {
      const end = line.indexOf(state, i);
      if (end < 0) return state;
      i = end + 3;
      state = undefined;
      continue;
    }
    const hash = line.indexOf("#", i);
    const dq = line.indexOf('"""', i);
    const sq = line.indexOf("'''", i);
    const next = [dq, sq].filter((n) => n >= 0).sort((a, b) => a - b)[0];
    if (next === undefined || (hash >= 0 && hash < next)) return undefined;
    state = line.slice(next, next + 3);
    i = next + 3;
  }
  return state;
}

/**
 * Remove `[mcp_servers.agentroom]` and its subtables (KTD5). Throws, naming `file`, when
 * `agentroom` is defined in a form this line-based writer does not rewrite.
 */
export function removeAgentroomTable(text: string, file: string): string {
  const refuse = (): never => {
    throw new CliError(
      `${file} defines the agentroom MCP server in a form agentroom cannot rewrite safely (inline table, dotted key or array of tables); edit it by hand, then rerun`,
    );
  };
  const lines = text.split(/(?<=\n)/);
  const kept: string[] = [];
  let open: string | undefined;
  let table: string[] = [];
  let dropping = false;
  let removed = false;
  // Comment and blank lines at the end of a dropped table belong to the next table.
  let trailing: string[] = [];
  const blank = (l: string) => /^\s*$/.test(l);
  for (const line of lines) {
    const startsOpen = open;
    open = multilineState(line, open);
    const header = startsOpen ? null : HEADER.exec(line.replace(/\r?\n$/, ""));
    if (header) {
      table = keyParts(header[2] ?? "");
      const ours = table[0] === "mcp_servers" && table[1] === "agentroom";
      if (
        header[1] === "[[" &&
        table[0] === "mcp_servers" &&
        line.includes("agentroom")
      ) {
        refuse();
      }
      if (dropping && !ours) {
        const last = kept[kept.length - 1];
        while (
          trailing[0] !== undefined &&
          blank(trailing[0]) &&
          (last === undefined || blank(last))
        ) {
          trailing.shift();
        }
        kept.push(...trailing);
      }
      trailing = [];
      dropping = ours;
      if (ours) removed = true;
    } else if (!startsOpen && !dropping) {
      const atRoot =
        table.length === 0 && /^\s*["']?mcp_servers["']?\s*[.=]/.test(line);
      // An inline `mcp_servers = { ... }` cannot take an added [mcp_servers.agentroom] table.
      if (table.length === 0 && /^\s*["']?mcp_servers["']?\s*=/.test(line)) {
        refuse();
      }
      const inServers =
        table.length === 1 &&
        table[0] === "mcp_servers" &&
        /^\s*["']?agentroom["']?\s*[.=]/.test(line);
      if ((atRoot && line.includes("agentroom")) || inServers) refuse();
    }
    if (!dropping) kept.push(line);
    else if (!header) {
      trailing =
        !startsOpen && /^\s*(#.*)?$/.test(line.replace(/\r?\n$/, ""))
          ? [...trailing, line]
          : [];
    }
  }
  if (!removed) return text;
  const rest = kept.join("").replace(/\n+$/, "\n");
  return rest.trim() === "" ? "" : rest;
}

/** Replace or append the `[mcp_servers.agentroom]` table, keeping everything else (KTD5). */
export function setAgentroomTable(
  text: string,
  file: string,
  entry: ServerEntry,
): string {
  const base = removeAgentroomTable(text, file).replace(/\n+$/, "");
  const block = `[mcp_servers.agentroom]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n`;
  return base === "" ? block : `${base}\n\n${block}`;
}
