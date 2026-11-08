/**
 * The owner's inbox reader (architecture §2.3 steps 5-6): incremental by byte offset,
 * waits only for requests with a `stop` and no `end`, keeps reading past the recorded
 * length while it waits, carries other requests' lines, bounded and abortable.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxReader, createHookInbox, inboxHasPayload } from "./inbox.js";

const dir = mkdtempSync(join(tmpdir(), "hook-inbox-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
function inbox(lines: object[] = []): string {
  const p = join(dir, `inbox-${++n}.jsonl`);
  writeFileSync(p, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return p;
}
const append = (p: string, ...lines: object[]) =>
  appendFileSync(p, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));

const stop = (req: string) => ({ v: 1, kind: "stop", req });
const end = (req: string, aborted?: boolean) => ({
  v: 1,
  kind: "end",
  req,
  ...(aborted ? { aborted } : {}),
});
const inject = (req: string, text: string) => ({
  v: 1,
  kind: "inject",
  req,
  hookId: "hook:m/i",
  text,
  at: "x",
});
const annotate = (req: string, key: string, value: unknown) => ({
  v: 1,
  kind: "annotate",
  req,
  hookId: "hook:m/a",
  key,
  value,
  at: "x",
});

describe("InboxReader.drain", () => {
  test("a finished request's payload is taken at once, with no wait", async () => {
    const p = inbox([stop("r1"), inject("r1", "P"), annotate("r1", "k", { a: 1 }), end("r1")]);
    const r = new InboxReader(p);
    expect(r.hasUnread()).toBe(true);
    const t0 = Date.now();
    const d = await r.drain(5_000);
    expect(Date.now() - t0).toBeLessThan(100);
    expect(d.injections).toEqual([{ req: "r1", hookId: "hook:m/i", text: "P" }]);
    expect(d.annotations).toEqual([{ req: "r1", hookId: "hook:m/a", key: "k", value: { a: 1 } }]);
    expect(r.hasUnread()).toBe(false);
    // incremental: a second drain reads nothing again
    expect((await r.drain(5_000)).injections).toEqual([]);
  });

  test("H-36: lines past the recorded length are taken for a waited request; others are carried", async () => {
    const p = inbox([stop("r1")]);
    const r = new InboxReader(p);
    setTimeout(() => append(p, inject("r1", "P"), end("r1"), inject("r2", "Q")), 150);
    const t0 = Date.now();
    const d = await r.drain(1_000);
    const took = Date.now() - t0;
    expect(d.injections.map((i) => i.text)).toEqual(["P"]);
    expect(took).toBeGreaterThanOrEqual(140);
    expect(took).toBeLessThan(600); // at ~150 ms plus one poll, never the 1 s bound
    // r2 had no stop: never waited for; its line is the next settle's
    expect(r.hasUnread()).toBe(true);
    expect((await r.drain(1_000)).injections.map((i) => i.text)).toEqual(["Q"]);
  });

  test("a request with no stop (still streaming) is never waited for", async () => {
    const p = inbox([inject("bg", "LATER-MAYBE")]);
    const t0 = Date.now();
    const d = await new InboxReader(p).drain(2_000);
    expect(Date.now() - t0).toBeLessThan(100);
    expect(d.injections.map((i) => i.text)).toEqual(["LATER-MAYBE"]);
  });

  test("a stop without an end is waited for up to the bound, then its later lines go to the next drain", async () => {
    const p = inbox([stop("r1")]);
    const r = new InboxReader(p);
    const t0 = Date.now();
    const d = await r.drain(250);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(240);
    expect(d.timedOut).toEqual(["r1"]);
    append(p, inject("r1", "LATE"), end("r1"));
    const t1 = Date.now();
    const d2 = await r.drain(5_000);
    expect(Date.now() - t1).toBeLessThan(100); // not waited for again
    expect(d2.injections.map((i) => i.text)).toEqual(["LATE"]);
  });

  test("the wait ends at once when the signal aborts", async () => {
    const p = inbox([stop("r1")]);
    const ac = new AbortController();
    setTimeout(() => ac.abort("exit"), 120);
    const t0 = Date.now();
    await new InboxReader(p).drain(30_500, ac.signal);
    const took = Date.now() - t0;
    expect(took).toBeLessThan(400);
  });

  test("an aborted end and a capped line are reported", async () => {
    const p = inbox([stop("r1"), end("r1", true), { v: 1, kind: "capped" }]);
    const d = await new InboxReader(p).drain(1_000);
    expect(d.capped).toBe(true);
    expect(d.injections).toEqual([]);
  });

  test("a partial last line is held until it is complete; garbage lines are skipped", async () => {
    const p = inbox([]);
    appendFileSync(p, 'not json\n{"v":1,"kind":"inject","req":"r","hookId":"h","te');
    const r = new InboxReader(p);
    expect((await r.drain(100)).injections).toEqual([]);
    appendFileSync(p, 'xt":"WHOLE"}\n');
    expect((await r.drain(100)).injections.map((i) => i.text)).toEqual(["WHOLE"]);
  });
});

describe("inbox files", () => {
  test("createHookInbox: 0600, exclusive, replacing a stale file of an earlier run", () => {
    const d = mkdtempSync(join(dir, "s-"));
    const p = createHookInbox(d) as string;
    expect(p).toBe(join(d, "hook-inbox.jsonl"));
    expect(statSync(p).mode & 0o777).toBe(0o600);
    appendFileSync(p, "stale\n");
    expect(createHookInbox(d)).toBe(p);
    expect(statSync(p).size).toBe(0);
    expect(createHookInbox(join(d, "missing-dir"))).toBeNull();
  });

  test("inboxHasPayload: only inject or annotate lines count", () => {
    expect(inboxHasPayload(inbox([stop("r"), end("r")]))).toBe(false);
    expect(inboxHasPayload(inbox([stop("r"), annotate("r", "k", 1), end("r")]))).toBe(true);
    expect(inboxHasPayload(join(dir, "absent.jsonl"))).toBe(false);
  });
});

describe("review fixes", () => {
  test("a capped line written while a request is waited for is reported in THIS drain", async () => {
    const p = inbox([stop("r1")]);
    const r = new InboxReader(p);
    setTimeout(() => append(p, { v: 1, kind: "capped" }, end("r1")), 150);
    const d = await r.drain(2_000);
    expect(d.capped).toBe(true);
    expect(d.timedOut).toEqual([]);
  });

  test("a request that ended before message_stop (end only) is forgotten", async () => {
    const p = inbox([end("a", true), end("b", true), stop("c"), end("c")]);
    const r = new InboxReader(p);
    await r.drain(100);
    const sets = r as unknown as { stopped: Set<string>; ended: Set<string> };
    expect(sets.ended.size).toBe(0);
    expect(sets.stopped.size).toBe(0);
  });

  test("a multi-byte character split across two reads arrives whole", async () => {
    const text = "héllo 🙂 wörld";
    const line = Buffer.from(`${JSON.stringify(inject("r1", text))}\n`, "utf8");
    // cut inside the 4-byte emoji
    const cut = line.indexOf(Buffer.from("🙂", "utf8")) + 2;
    const p = inbox([stop("r1")]);
    appendFileSync(p, line.subarray(0, cut));
    const r = new InboxReader(p);
    setTimeout(() => {
      appendFileSync(p, line.subarray(cut));
      append(p, end("r1"));
    }, 150);
    const d = await r.drain(2_000);
    expect(d.injections.map((i) => i.text)).toEqual([text]);
  });

  test("payload lines are re-validated: a slash command, an oversized text, a bad key are rejected", async () => {
    const p = inbox([
      stop("r1"),
      inject("r1", "/exit"),
      inject("r1", "  /model opus"),
      inject("r1", "x".repeat(100_001)),
      inject("r1", "FINE"),
      annotate("r1", "has space", 1),
      annotate("r1", "ok", 2),
      end("r1"),
    ]);
    const d = await new InboxReader(p).drain(100);
    expect(d.injections.map((i) => i.text)).toEqual(["FINE"]);
    expect(d.annotations.map((a) => a.key)).toEqual(["ok"]);
    expect(d.invalid.map((x) => [x.kind, x.reason])).toEqual([
      ["inject", "slash_command"],
      ["inject", "slash_command"],
      ["inject", "too_long"],
      ["annotate", "invalid_key"],
    ]);
  });
});
