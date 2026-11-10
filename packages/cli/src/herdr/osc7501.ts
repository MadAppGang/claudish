/**
 * OSC 7501, herdr-core's program status protocol: a program inside an hc terminal reports its own
 * state by writing `ESC ] 7501 ; state=<s>[:kind=<k>][:app=<name>][:title=<b64>][:msg=<b64>] ESC \`
 * to its terminal. hc keeps the last report per terminal (`hc get <t>` shows it as `status`) and
 * Herdr.app treats a terminal that reports as an agent. `state=clear` drops the report.
 *
 * Field order and spelling follow hc's own encoder (`Status::encode`); title and message are
 * base64 so a `:` or a control character inside them cannot break the line.
 */

import type { HcState } from "./state-map.js";

const ESC = "\x1b";
/** a program name: hc copies it verbatim into `AgentInfo.app` */
const APP_RE = /^[A-Za-z0-9._-]{1,32}$/;

export interface Osc7501Report {
  state: HcState;
  /** blocked only: what the program waits for */
  kind?: "permission" | "question" | "auth";
  app?: string;
  title?: string;
  msg?: string;
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

/** One report as the bytes a program writes to its terminal. */
export function encodeOsc7501(r: Osc7501Report): string {
  const fields = [`state=${r.state}`];
  if (r.kind && r.state === "blocked") fields.push(`kind=${r.kind}`);
  if (r.app) {
    if (!APP_RE.test(r.app)) throw new Error(`OSC 7501 app name ${JSON.stringify(r.app)}`);
    fields.push(`app=${r.app}`);
  }
  if (r.title) fields.push(`title=${b64(r.title)}`);
  if (r.msg) fields.push(`msg=${b64(r.msg)}`);
  return `${ESC}]7501;${fields.join(":")}${ESC}\\`;
}

/** Drops this terminal's report, so it is no longer listed as an agent. */
export function clearOsc7501(): string {
  return `${ESC}]7501;state=clear${ESC}\\`;
}

/** The fields of one OSC 7501 line, or null when the bytes are not one. For tests and checks. */
export function decodeOsc7501(line: string): Record<string, string> | null {
  const head = `${ESC}]7501;`;
  if (!line.startsWith(head)) return null;
  const st = line.endsWith(`${ESC}\\`) ? 2 : line.endsWith("\x07") ? 1 : 0;
  if (st === 0) return null;
  const body = line.slice(head.length, line.length - st);
  if (body.includes(ESC) || body.includes("\x07")) return null;
  const out: Record<string, string> = {};
  for (const part of body.split(":")) {
    const eq = part.indexOf("=");
    if (eq <= 0) return null;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    out[key] =
      key === "title" || key === "msg" ? Buffer.from(value, "base64").toString("utf8") : value;
  }
  return out;
}
