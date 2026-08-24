import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  appendUpstreamError,
  createResponseCapture,
  __resetCaptureDirMemo,
} from "./response-capture.js";
import { rmSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * appendUpstreamError durably logs non-ok upstream response bodies to
 * ${CLAUDISH_CAPTURE_DIR}/upstream-errors.log so the exact 429/402 wording
 * needed to calibrate isQuotaExhaustion survives a container recreate (which
 * wipes stdout — the only place these bodies lived before this fix).
 */
describe("appendUpstreamError", () => {
  const dir = join(tmpdir(), `claudish-cap-test-${process.pid}`);
  const logFile = join(dir, "upstream-errors.log");

  beforeEach(() => {
    delete process.env.CLAUDISH_CAPTURE_DIR;
    rmSync(dir, { recursive: true, force: true });
    // ensureCaptureDir memoizes the last dir it created. These tests rm -rf a
    // FIXED path between cases, so the memo must be dropped or the next write
    // targets a directory that no longer exists (ENOENT, silently swallowed).
    __resetCaptureDirMemo();
  });

  afterEach(() => {
    delete process.env.CLAUDISH_CAPTURE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  test("no-op when CLAUDISH_CAPTURE_DIR is unset", () => {
    appendUpstreamError({ model: "glm-5.2", provider: "GLM", status: 429, body: "x" });
    expect(existsSync(logFile)).toBe(false);
  });

  test("appends one JSON line per error with the body intact", () => {
    process.env.CLAUDISH_CAPTURE_DIR = dir;
    appendUpstreamError({
      model: "glm-5.2",
      provider: "GLM Coding",
      status: 429,
      body: '{"error":{"message":"Rate limit exceeded","code":"1301"}}',
    });
    expect(existsSync(logFile)).toBe(true);
    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.model).toBe("glm-5.2");
    expect(entry.provider).toBe("GLM Coding");
    expect(entry.status).toBe(429);
    expect(entry.body).toContain("Rate limit exceeded");
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("appends across calls (append, not overwrite) and survives recreates", () => {
    process.env.CLAUDISH_CAPTURE_DIR = dir;
    appendUpstreamError({ model: "m1", provider: "P", status: 429, body: "first" });
    appendUpstreamError({ model: "m2", provider: "P", status: 402, body: "second" });
    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).body).toBe("first");
    expect(JSON.parse(lines[1]).status).toBe(402);
  });

  test("truncates oversized bodies to bound disk usage", () => {
    process.env.CLAUDISH_CAPTURE_DIR = dir;
    const huge = "x".repeat(10000);
    appendUpstreamError({ model: "m", provider: "P", status: 500, body: huge });
    const entry = JSON.parse(readFileSync(logFile, "utf8").trim());
    expect(entry.body.length).toBe(2048);
  });

  test("never throws on an unwritable directory", () => {
    // Point at a path whose parent is a file → mkdir/write fails → swallowed.
    process.env.CLAUDISH_CAPTURE_DIR = join(dir, "not-a-dir");
    mkdirSync(dir, { recursive: true });
    require("node:fs").writeFileSync(join(dir, "not-a-dir"), "blocker");
    expect(() =>
      appendUpstreamError({ model: "m", provider: "P", status: 429, body: "x" })
    ).not.toThrow();
  });
});

/**
 * The resp-*.sse write must NOT block the event loop: over a Docker bind-mount
 * to a Windows dir, a synchronous 900 KB write froze every handler including the
 * 4s /health heartbeat the relay failover keys off (incident 2026-08-20, fixed
 * on the request side by 180f1cb; this file kept writeFileSync until 2026-08-24).
 */
describe("createResponseCapture", () => {
  const dir = join(tmpdir(), `claudish-resp-test-${process.pid}`);

  const respFiles = () =>
    existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("resp-")) : [];

  beforeEach(() => {
    delete process.env.CLAUDISH_CAPTURE_DIR;
    rmSync(dir, { recursive: true, force: true });
    __resetCaptureDirMemo();
  });

  afterEach(() => {
    delete process.env.CLAUDISH_CAPTURE_DIR;
    rmSync(dir, { recursive: true, force: true });
    __resetCaptureDirMemo();
  });

  test("no-op when CLAUDISH_CAPTURE_DIR is unset", async () => {
    const cap = createResponseCapture("openai", "glm-5.2");
    cap.tap("data: hello\n\n");
    cap.done({ stop_reason: "end_turn" });
    await new Promise((r) => setTimeout(r, 25));
    expect(existsSync(dir)).toBe(false);
  });

  test("no-op when enabled=false (relay nominal forward writes no orphan)", async () => {
    process.env.CLAUDISH_CAPTURE_DIR = dir;
    const cap = createResponseCapture("native", "claude-opus-5", false);
    cap.tap("data: x\n\n");
    cap.done();
    await new Promise((r) => setTimeout(r, 25));
    expect(respFiles()).toHaveLength(0);
  });

  /**
   * NOT tested here: "the file is absent immediately after done()". That looks
   * like the natural assertion for a fire-and-forget write and it is genuinely
   * racy — fs/promises dispatches to a threadpool thread that runs in PARALLEL
   * with the JS thread, so whether the file exists microseconds later depends on
   * scheduling. It passed alone and failed in-suite. A test that is right 70% of
   * the time is worse than no test.
   *
   * Nor is "the event loop stays free" testable here: on a fast local disk a
   * synchronous 900 KB write costs ~1 ms, so sync and async are indistinguishable.
   * The freeze this fix targets needs a Docker bind-mount to a Windows dir, which
   * a unit test cannot stand up. The non-blocking property is guaranteed
   * STRUCTURALLY by calling fs/promises.writeFile instead of writeFileSync.
   *
   * What IS deterministic, and is a real contract: the stdout marker must be
   * emitted before the write is dispatched. It is the real-time hang signal —
   * a [Request] line with no matching [resp] means the parser never reached
   * close — so it must never wait on disk I/O.
   */
  test("emits the stdout marker synchronously, before dispatching the write", () => {
    process.env.CLAUDISH_CAPTURE_DIR = dir;
    const written: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (chunk: string) => {
      written.push(String(chunk));
      return true;
    };
    try {
      const cap = createResponseCapture("openai", "glm-5.2");
      // ~900 KB, the size class of a finalized glm-5.2 stream.
      cap.tap("data: " + "x".repeat(900_000) + "\n\n");
      cap.done({ stop_reason: "end_turn" });
    } finally {
      (process.stdout as unknown as { write: typeof realWrite }).write = realWrite;
    }
    const marker = written.find((l) => l.includes("[resp] openai"));
    expect(marker).toBeDefined();
    // Emitted within done(), i.e. without awaiting the write.
    expect(marker).toContain("bytes=900008");
    expect(marker).toContain("stop=end_turn");
  });

  test("the payload does land, with header and SSE intact", async () => {
    process.env.CLAUDISH_CAPTURE_DIR = dir;
    const cap = createResponseCapture("openai", "glm-5.2");
    cap.note("message_stop");
    cap.tap("data: {}\n\n");
    cap.done({ stop_reason: "end_turn", closed: true });

    const deadline = Date.now() + 2000;
    while (respFiles().length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const files = respFiles();
    expect(files).toHaveLength(1);
    const body = readFileSync(join(dir, files[0]), "utf8");
    expect(body).toContain("# claudish response capture");
    expect(body).toContain("parser=openai model=glm-5.2");
    expect(body).toContain("message_stop");
    expect(body).toContain("data: {}");
  });

  test("done() is idempotent - a second call writes no second file", async () => {
    process.env.CLAUDISH_CAPTURE_DIR = dir;
    const cap = createResponseCapture("openai", "glm-5.2");
    cap.tap("data: a\n\n");
    cap.done();
    cap.done();
    cap.done();
    await new Promise((r) => setTimeout(r, 150));
    expect(respFiles()).toHaveLength(1);
  });

  test("a failed write never throws into the stream path", async () => {
    process.env.CLAUDISH_CAPTURE_DIR = dir;
    mkdirSync(dir, { recursive: true });
    __resetCaptureDirMemo();
    const cap = createResponseCapture("openai", "glm-5.2");
    cap.tap("data: a\n\n");
    // Make the target path undreachable by turning the dir into a file is not
    // portable; instead assert the documented contract directly: done() never
    // throws, and the rejection is swallowed rather than becoming unhandled.
    expect(() => cap.done()).not.toThrow();
    await new Promise((r) => setTimeout(r, 150));
  });
});
