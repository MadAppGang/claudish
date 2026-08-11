import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { appendUpstreamError } from "./response-capture.js";
import { rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
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
