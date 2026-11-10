/**
 * Every `Bun.serve(` call under `src/` names a `hostname`.
 *
 * With no hostname, Bun listens on the wildcard address. On macOS a second process that
 * listens on `127.0.0.1` with the same port takes every request sent to `127.0.0.1`,
 * because the more specific bind wins. A test that started its server on port 0 and then
 * sends to `http://127.0.0.1:<port>` or `http://localhost:<port>` then talks to that other
 * process and times out. On a machine with many claudish sessions open, each one holding
 * loopback ports, this happens a few times in a thousand runs.
 *
 * Binding `hostname: "127.0.0.1"` makes the port exclusive to the test server on the
 * address the test sends to.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..");

/** The text of each `Bun.serve(...)` call in `source`, from the name to its closing parenthesis. */
function serveCalls(source: string): { line: number; text: string }[] {
  const calls: { line: number; text: string }[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf("Bun.serve(", from);
    if (at < 0) return calls;
    let depth = 0;
    let end = at + "Bun.serve".length;
    for (; end < source.length; end++) {
      const ch = source[end];
      if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) break;
    }
    calls.push({ line: source.slice(0, at).split("\n").length, text: source.slice(at, end + 1) });
    from = end;
  }
}

/**
 * The call's options object names `hostname` as one of ITS keys: `hostname:`, or the
 * shorthand `hostname,` / `hostname }`. A `hostname` in a nested object or in a string
 * does not count. In `Bun.serve({ … })` the `(` is depth 1 and the options' `{` depth 2.
 */
function bindsHostname(call: string): boolean {
  let depth = 0;
  for (let i = 0; i < call.length; i++) {
    const ch = call[i] as string;
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < call.length && call[i] !== ch; i++) if (call[i] === "\\") i++;
      continue;
    }
    if ("({[".includes(ch)) depth++;
    else if (")}]".includes(ch)) depth--;
    else if (
      depth === 2 &&
      /^hostname\s*[:,}]/.test(call.slice(i)) &&
      !/\w/.test(call[i - 1] ?? "")
    )
      return true;
  }
  return false;
}

describe("Bun.serve hostname", () => {
  test("serveCalls reads a call to its closing parenthesis", () => {
    const src =
      'a\nBun.serve({ port: 0, fetch(r) { return f(r); } });\nBun.serve({ hostname: "127.0.0.1" })';
    const calls = serveCalls(src);
    expect(calls.map((c) => c.line)).toEqual([2, 3]);
    expect(calls[0]?.text).toBe("Bun.serve({ port: 0, fetch(r) { return f(r); } })");
    expect(calls[1]?.text.includes("hostname")).toBe(true);
  });

  test("bindsHostname wants the option key, not the word anywhere in the call", () => {
    expect(bindsHostname('Bun.serve({ hostname: "127.0.0.1", port: 0 })')).toBe(true);
    expect(bindsHostname("Bun.serve({ hostname, port: 0 })")).toBe(true);
    expect(bindsHostname("Bun.serve({ port: 0, hostname })")).toBe(true);
    expect(bindsHostname('Bun.serve({ port: 0, fetch: () => new Response("hostname") })')).toBe(
      false
    );
    expect(
      bindsHostname("Bun.serve({ port: 0, fetch: () => Response.json({ hostnames: [] }) })")
    ).toBe(false);
  });

  test("bindsHostname reads only the top level of the options object", () => {
    expect(
      bindsHostname('Bun.serve({ port: 0, fetch: () => Response.json({ hostname: "x" }) })')
    ).toBe(false);
    expect(bindsHostname('Bun.serve({ tls: { hostname: "x" }, port: 0 })')).toBe(false);
    expect(
      bindsHostname('Bun.serve({ port: 0, fetch: () => f("{"), hostname: "127.0.0.1" })')
    ).toBe(true);
    expect(
      bindsHostname('Bun.serve({ fetch(r) { return g({ a: 1 }); }, hostname: "127.0.0.1" })')
    ).toBe(true);
  });

  test("every Bun.serve call under src names a hostname", () => {
    const missing: string[] = [];
    for (const rel of new Bun.Glob("**/*.{ts,tsx,js,mjs,cjs}").scanSync({ cwd: SRC })) {
      if (rel.includes("node_modules/")) continue;
      // this file's own unbound calls are test strings for bindsHostname
      if (rel === "test-helpers/serve-hostname.test.ts") continue;
      const source = readFileSync(join(SRC, rel), "utf-8");
      if (!source.includes("Bun.serve(")) continue;
      for (const call of serveCalls(source)) {
        if (!bindsHostname(call.text)) missing.push(`src/${rel}:${call.line}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
