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

/** What is still open at a line boundary: a multi-line string, and how deep in `[`/`{` values. */
interface ScanState {
  str: '"""' | "'''" | undefined;
  depth: number;
}

const CLOSED: ScanState = { str: undefined, depth: 0 };

const isOpen = (s: ScanState) => s.str !== undefined || s.depth !== 0;

/**
 * The state at the end of a value line, given the state at its start. Tracks multi-line strings
 * (with `\` escapes in `"""` strings and up to two extra quotes before the closing delimiter)
 * and array or inline-table nesting, so a header-like line inside either is not a header.
 */
function scanLine(line: string, start: ScanState): ScanState {
  let { str, depth } = start;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (str) {
      if (str === '"""' && ch === "\\") {
        i += 2;
      } else if (line.startsWith(str, i)) {
        let run = 3;
        while (run < 5 && line[i + run] === str[0]) run++;
        i += run;
        str = undefined;
      } else {
        i++;
      }
      continue;
    }
    if (ch === "#") break;
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      str = line.slice(i, i + 3) as ScanState["str"];
      i += 3;
    } else if (ch === '"') {
      // A one-line basic string: skip to its closing quote, past escapes.
      i++;
      while (i < line.length && line[i] !== '"') i += line[i] === "\\" ? 2 : 1;
      i++;
    } else if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      i = end < 0 ? line.length : end + 1;
    } else {
      if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") depth--;
      i++;
    }
  }
  return { str, depth };
}

/**
 * Remove `[mcp_servers.agentroom]` and its subtables (KTD5). Throws, naming `file`, when
 * `agentroom` is defined in a form this line-based writer does not rewrite.
 */
export function removeAgentroomTable(
  text: string,
  file: string,
  installing = false,
): string {
  const unbalanced = (): never => {
    throw new CliError(
      `${file} has an unterminated string, array or inline table, or an unmatched bracket, so agentroom cannot rewrite it safely; fix it, then rerun`,
    );
  };
  const refuse = (): never => {
    throw new CliError(
      `${file} defines MCP servers in a form agentroom cannot rewrite safely (inline table, dotted key or array of tables); edit it by hand, then rerun`,
    );
  };
  const lines = text.split(/(?<=\n)/);
  const kept: string[] = [];
  let state = CLOSED;
  let broken = false;
  let table: string[] = [];
  let dropping = false;
  let removed = false;
  // Comment and blank lines at the end of a dropped table belong to the next table.
  let trailing: string[] = [];
  const blank = (l: string) => /^\s*$/.test(l);
  for (const line of lines) {
    const startsOpen = isOpen(state);
    const header = startsOpen ? null : HEADER.exec(line.replace(/\r?\n$/, ""));
    if (!header) state = scanLine(line, state);
    if (state.depth < 0) {
      broken = true;
      state = { ...state, depth: 0 };
    }
    if (header) {
      table = keyParts(header[2] ?? "");
      const ours = table[0] === "mcp_servers" && table[1] === "agentroom";
      if (
        header[1] === "[[" &&
        table[0] === "mcp_servers" &&
        table[1] === "agentroom"
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
      if (
        installing &&
        table.length === 0 &&
        /^\s*["']?mcp_servers["']?\s*=/.test(line)
      ) {
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
  // An unterminated string or array would swallow an appended table, and drop lines on removal.
  if ((broken || isOpen(state)) && (removed || installing)) unbalanced();
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
  const base = removeAgentroomTable(text, file, true).replace(/\n+$/, "");
  const block = `[mcp_servers.agentroom]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n`;
  return base === "" ? block : `${base}\n\n${block}`;
}
