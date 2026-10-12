import { stripControl } from "@agentroom/protocol";

/** CSI, OSC (BEL or ST terminated) and two-character ESC sequences. */
const ESCAPES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the purpose
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;

/** Escapes and controls removed, newlines included; no length bound. */
export function stripTerminal(s: string): string {
  return stripControl(s.replace(ESCAPES, ""));
}

/** A peer-supplied string for one terminal line: escapes and controls removed, bounded. */
export function safeLine(s: string): string {
  return stripTerminal(s).slice(0, 64);
}

/** A peer-supplied body: escapes and controls removed, newlines and tabs kept. */
export function safeBody(s: string): string {
  return s
    .replace(ESCAPES, "")
    .split("\n")
    .map((line) => line.split("\t").map(stripControl).join("\t"))
    .join("\n");
}

/** A peer-chosen or long id shown in one line: stripped and cut to 8 characters. */
export const id8 = (s: string): string => safeLine(s).slice(0, 8);
