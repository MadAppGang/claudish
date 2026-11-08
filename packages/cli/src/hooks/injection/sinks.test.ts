import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOOK_INBOX_ENV,
  InboxFileSink,
  UnavailableSink,
  resetUnavailableSinkReportForTests,
  sinkFromEnv,
} from "./sinks.js";

const dirs: string[] = [];
function inbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "claudish-inbox-"));
  dirs.push(dir);
  return join(dir, "hook-inbox.jsonl");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const lines = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const at = () => new Date("2026-10-14T00:00:00.000Z");

describe("InboxFileSink", () => {
  it("appends one JSON object per line in the documented shapes", () => {
    const path = inbox();
    const sink = new InboxFileSink(path, undefined, at);
    sink.stop("r1");
    expect(sink.inject("r1", "hook:a/b", "HOOK-PING")).toBe("queued");
    expect(sink.annotate("r1", "hook:a/b", "k", [1, "x"])).toBe("queued");
    sink.end("r1", false);
    sink.end("r2", true);
    expect(lines(path)).toEqual([
      { v: 1, kind: "stop", req: "r1" },
      {
        v: 1,
        kind: "inject",
        req: "r1",
        hookId: "hook:a/b",
        text: "HOOK-PING",
        at: at().toISOString(),
      },
      {
        v: 1,
        kind: "annotate",
        req: "r1",
        hookId: "hook:a/b",
        key: "k",
        value: [1, "x"],
        at: at().toISOString(),
      },
      { v: 1, kind: "end", req: "r1" },
      { v: 1, kind: "end", req: "r2", aborted: true },
    ]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("caps payload lines only: past the cap it writes one capped line and keeps writing stop/end", () => {
    const path = inbox();
    const sink = new InboxFileSink(path, 150, at);
    expect(sink.inject("r", "h", "x".repeat(20))).toBe("queued");
    expect(sink.inject("r", "h", "y".repeat(80))).toBe("inbox_cap");
    expect(sink.inject("r", "h", "z")).toBe("inbox_cap");
    for (let i = 0; i < 20; i++) {
      sink.stop(`s${i}`);
      sink.end(`s${i}`, false);
    }
    const kinds = lines(path).map((l) => l.kind);
    expect(kinds.slice(0, 2)).toEqual(["inject", "capped"]);
    expect(kinds.filter((k) => k === "capped")).toHaveLength(1);
    expect(kinds.filter((k) => k === "stop")).toHaveLength(20);
  });

  it("fails open when the file cannot be written", () => {
    const sink = new InboxFileSink(join(inbox(), "missing-dir", "x.jsonl"));
    expect(() => sink.stop("r")).not.toThrow();
    expect(sink.inject("r", "h", "t")).toBe("write_failed");
  });
});

describe("UnavailableSink and sinkFromEnv", () => {
  it("drops injections with one stderr line per process, annotations silently", () => {
    resetUnavailableSinkReportForTests();
    const warned: string[] = [];
    const sink = new UnavailableSink((l) => warned.push(l));
    expect(sink.inject()).toBe("unavailable");
    expect(sink.inject()).toBe("unavailable");
    expect(sink.annotate()).toBe("unavailable");
    expect(warned).toHaveLength(1);
    expect(sink.available).toBe(false);
  });

  it("uses the inbox the owner named, else none", () => {
    const path = inbox();
    const child = { CLAUDISH_PANE_CHILD: "1", CLAUDISH_PANE_CWD: "/w", [HOOK_INBOX_ENV]: path };
    const sink = sinkFromEnv(child);
    expect(sink).toBeInstanceOf(InboxFileSink);
    expect((sink as InboxFileSink).path).toBe(path);
    // One sink per file: the payload cap spans every request of the process.
    expect(sinkFromEnv(child)).toBe(sink);
    expect(sinkFromEnv({})).toBeInstanceOf(UnavailableSink);
  });

  it("outside a pane child the inbox variable is ignored (a .env cannot name a file to append to)", () => {
    const path = inbox();
    expect(sinkFromEnv({ [HOOK_INBOX_ENV]: path })).toBeInstanceOf(UnavailableSink);
  });
});
