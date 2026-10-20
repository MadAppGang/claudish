/**
 * The interactive launcher's sink (hook-system §2.3, last paragraph): the inbox lines a
 * pane child appends to its file, kept in memory, and drained by the owner's rule —
 * one `InboxReader` for both sources.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { InboxReader } from "./inbox.js";
import {
  HOOK_INBOX_ENV,
  InProcessSink,
  InboxFileSink,
  UnavailableSink,
  resetUnavailableSinkReportForTests,
  setProcessSink,
  sinkFromEnv,
} from "./sinks.js";

afterEach(() => {
  setProcessSink(null);
  resetUnavailableSinkReportForTests();
});

const fixed = () => new Date("2026-10-14T00:00:00.000Z");

describe("InProcessSink drained by InboxReader", () => {
  test("lines before the settle are drained at once; a request with no stop is never waited for", async () => {
    const sink = new InProcessSink(1024 * 1024, fixed, () => {});
    sink.stop("r1");
    expect(sink.inject("r1", "hook:a/x", "P")).toBe("queued");
    expect(sink.annotate("r1", "hook:a/x", "k", 1)).toBe("queued");
    sink.end("r1", false);
    // r2 is still streaming: an inject without a stop is taken, never waited on
    sink.inject("r2", "hook:a/x", "Q");
    const reader = new InboxReader(sink.inbox);
    expect(reader.hasUnread()).toBe(true);
    const started = Date.now();
    const d = await reader.drain(5_000);
    expect(Date.now() - started).toBeLessThan(200);
    expect(d.injections.map((i) => i.text)).toEqual(["P", "Q"]);
    expect(d.annotations).toEqual([{ req: "r1", hookId: "hook:a/x", key: "k", value: 1 }]);
    expect(reader.hasUnread()).toBe(false);
  });

  test("a stop without its end is waited for, and the wait ends when the end arrives", async () => {
    const sink = new InProcessSink(1024 * 1024, fixed, () => {});
    const reader = new InboxReader(sink.inbox);
    sink.stop("r1");
    setTimeout(() => {
      sink.inject("r1", "hook:a/x", "LATE");
      sink.inject("r9", "hook:a/x", "OTHER");
      sink.end("r1", false);
    }, 150);
    const started = Date.now();
    const d = await reader.drain(5_000);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(140);
    expect(took).toBeLessThan(1_000);
    expect(d.injections.map((i) => i.text)).toEqual(["LATE"]);
    // another request's line arriving during the wait is carried to the next settle
    expect(reader.hasUnread()).toBe(true);
    const next = await reader.drain(100);
    expect(next.injections.map((i) => i.text)).toEqual(["OTHER"]);
  });

  test("the wait is bounded and abortable", async () => {
    const sink = new InProcessSink(1024 * 1024, fixed, () => {});
    sink.stop("r1");
    const bounded = Date.now();
    const d = await new InboxReader(sink.inbox).drain(250);
    expect(Date.now() - bounded).toBeGreaterThanOrEqual(240);
    expect(d.timedOut).toEqual(["r1"]);

    const sink2 = new InProcessSink(1024 * 1024, fixed, () => {});
    sink2.stop("r2");
    const ctl = new AbortController();
    setTimeout(() => ctl.abort("exit"), 100);
    const aborted = Date.now();
    await new InboxReader(sink2.inbox).drain(10_000, ctl.signal);
    expect(Date.now() - aborted).toBeLessThan(1_000);
  });

  test("the payload cap counts inject + annotate bytes only and reports once", async () => {
    const sink = new InProcessSink(400, fixed, () => {});
    expect(sink.inject("r1", "hook:a/x", "x".repeat(100))).toBe("queued");
    expect(sink.inject("r1", "hook:a/x", "y".repeat(300))).toBe("inbox_cap");
    expect(sink.inject("r1", "hook:a/x", "z")).toBe("inbox_cap");
    for (let i = 0; i < 50; i++) {
      sink.stop(`s${i}`);
      sink.end(`s${i}`, false);
    }
    const d = await new InboxReader(sink.inbox).drain(100);
    expect(d.capped).toBe(true);
    expect(d.injections.map((i) => i.text.length)).toEqual([100]);
  });

  test("markUnavailable: injections are dropped `unavailable` with one stderr line, bookkeeping stops", () => {
    const lines: string[] = [];
    const sink = new InProcessSink(1024 * 1024, fixed, (l) => lines.push(l));
    expect(sink.available).toBe(true);
    sink.markUnavailable();
    expect(sink.available).toBe(false);
    expect(sink.inject("r1", "hook:a/x", "P")).toBe("unavailable");
    expect(sink.inject("r2", "hook:a/x", "Q")).toBe("unavailable");
    expect(sink.annotate("r1", "hook:a/x", "k", 1)).toBe("unavailable");
    sink.stop("r3");
    sink.end("r3", false);
    expect(sink.inbox.hasNew()).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("hook injection dropped");
  });

  test("noteSessionId reaches every listener until it unsubscribes", () => {
    const sink = new InProcessSink();
    const seen: string[] = [];
    const off = sink.onSessionId((s) => seen.push(s));
    sink.noteSessionId("a");
    off();
    sink.noteSessionId("b");
    expect(seen).toEqual(["a"]);
  });
});

describe("sinkFromEnv with a process sink", () => {
  test("no inbox env: the installed process sink, else unavailable", () => {
    expect(sinkFromEnv({})).toBeInstanceOf(UnavailableSink);
    const sink = new InProcessSink();
    setProcessSink(sink);
    expect(sinkFromEnv({})).toBe(sink);
    setProcessSink(null);
    expect(sinkFromEnv({})).toBeInstanceOf(UnavailableSink);
  });

  test("a pane owner's inbox file still wins over a process sink", () => {
    const inProcess = new InProcessSink();
    setProcessSink(inProcess);
    const env = { [HOOK_INBOX_ENV]: "/tmp/never-written-inbox.jsonl" };
    expect(
      sinkFromEnv({ ...env, CLAUDISH_PANE_CHILD: "1", CLAUDISH_PANE_CWD: "/w" })
    ).toBeInstanceOf(InboxFileSink);
    // outside a pane child the variable is not an owner's: the process sink stays
    expect(sinkFromEnv(env)).toBe(inProcess);
  });
});
