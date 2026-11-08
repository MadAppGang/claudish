/**
 * The provider-neutral pieces of the `claudish subscription probe … --raw
 * --json` secret guard and request-file contract, shared by every provider's
 * probe (`subscription-probe-command.ts` for Antigravity,
 * `subscription-devin-probe.ts` for Devin).
 *
 * Contract: ai-docs/architecture/providers/antigravity.md, "Wire probe for
 * models-index" (section "Redaction, then the guard").
 */

import { readFile, stat } from "node:fs/promises";
import type { Secrets } from "./subscription-antigravity-session.js";

/** The largest response body printed. A larger one is `body_too_large`, with no body. */
export const PROBE_BODY_CAP_BYTES = 512 * 1024;
/** The largest request file read. A larger one is `request_file_invalid`. */
export const PROBE_REQUEST_FILE_CAP_BYTES = 8 * 1024 * 1024;
/** What replaces a credential value inside the vendor's body. */
export const REDACTED = "[REDACTED]";

/**
 * Replace every secret value in `text`, longest first, also in its `\/`
 * spelling (JSON may escape `/`, and a Google refresh token holds `1//`).
 */
export function redactSecretValues(
  text: string,
  secrets: Secrets
): { text: string; redacted: boolean } {
  let out = text;
  const values = [...secrets.values].sort((a, b) => b.length - a.length);
  for (const value of values) {
    for (const form of new Set([value, value.replaceAll("/", "\\/")])) {
      if (out.includes(form)) out = out.replaceAll(form, REDACTED);
    }
  }
  return { text: out, redacted: out !== text };
}

/** One JSON escape sequence: a backslash-u code unit, or a backslash and one escape letter. */
const JSON_ESCAPE = /\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g;
const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};
/**
 * The decode budget. A real body needs 1 to 3 rounds. It is a budget, not a
 * depth limit: a body that has not reached a fixed point within it is
 * withheld (`body_unverifiable`), never printed half-checked. Round 4 of the
 * review broke a 16-round CAP with a body nested 17 deep; a cap silently
 * passes what it did not decode, a budget fails closed. 64 rounds over the
 * 512 KiB cap bound the work at about 32 MiB of scanning.
 */
export const MAX_UNESCAPE_ROUNDS = 64;

/**
 * Every form of `text` a chain of JSON parsers could produce: each round
 * decodes every JSON escape sequence ANYWHERE in the text, left to right, and
 * the rounds repeat until nothing changes. The guard checks each form.
 *
 * It ignores string boundaries on purpose. A guard that first finds string
 * literals can be misled: a stray quote in a non-JSON error body pairs the
 * wrong quotes, one `JSON.parse` keeps only the last of two duplicate
 * members, and JSON nested inside a JSON string needs a second decode. Here
 * one round is one level of escaping: a doubly escaped letter (two
 * backslashes, then `u0043`) needs two rounds to become `C`. Over-decoding
 * text that was never inside a string is harmless: these forms are only
 * checked, never printed.
 *
 * Scope: a credential in literal form or under any depth of JSON string
 * escaping. Other transforms (base64, reversal) are outside any text guard.
 *
 * `complete` is true only when a fixed point was reached within
 * `MAX_UNESCAPE_ROUNDS`: then every form a decode chain can produce was
 * returned. When false, the caller must not print the text.
 */
export function jsonUnescapedForms(text: string | undefined): {
  forms: string[];
  complete: boolean;
} {
  const forms: string[] = [];
  if (text === undefined) return { forms, complete: true };
  let current = text;
  for (let round = 0; round < MAX_UNESCAPE_ROUNDS; round++) {
    const next = current.replace(JSON_ESCAPE, (_match, hex: string | undefined, letter: string) =>
      hex !== undefined ? String.fromCharCode(Number.parseInt(hex, 16)) : SIMPLE_ESCAPES[letter]
    );
    if (next === current) return { forms, complete: true };
    forms.push(next);
    current = next;
  }
  return { forms, complete: false };
}

/** Read at most `cap + 1` bytes. `null` means the body is over the cap. */
export async function readCapped(res: Response, cap: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The default request-file reader: a regular file, at most
 * {@link PROBE_REQUEST_FILE_CAP_BYTES}. Rejects when it is unreadable; `null`
 * when it is over the cap.
 */
export async function defaultReadRequestFile(path: string): Promise<string | null> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("not a file");
  if (info.size > PROBE_REQUEST_FILE_CAP_BYTES) return null;
  return readFile(path, "utf8");
}

/** The request file, checked: one JSON object. `text` is the file as read, untrimmed. */
export type RequestFileStep =
  | { ok: true; text: string; value: Record<string, unknown> }
  | { ok: false; code: "request_file_unreadable" | "request_file_invalid" };

/** Read the request file through `read` and check that it holds one JSON object. */
export async function readRequestFileChecked(
  read: (path: string) => Promise<string | null>,
  path: string
): Promise<RequestFileStep> {
  let text: string | null;
  try {
    text = await read(path);
  } catch {
    return { ok: false, code: "request_file_unreadable" };
  }
  if (text === null) return { ok: false, code: "request_file_invalid" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: "request_file_invalid" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, code: "request_file_invalid" };
  }
  return { ok: true, text, value: value as Record<string, unknown> };
}
