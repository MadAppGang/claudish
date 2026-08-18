import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_CAPTURED_BODY_BYTES,
  UPSTREAM_ERROR_LOG_ENV,
  captureUpstreamError,
} from "./upstream-error-capture.js";

interface CapturedRecord {
  at: string;
  provider: string;
  model: string;
  status: number;
  body: string;
  truncated?: boolean;
  original_bytes?: number;
}

let tempFile: string | undefined;

function uniqueTempFile(): string {
  tempFile = join(tmpdir(), `claudish-upstream-error-${randomUUID()}.jsonl`);
  return tempFile;
}

function readRecord(path: string): CapturedRecord {
  return JSON.parse(readFileSync(path, "utf8").trimEnd()) as CapturedRecord;
}

afterEach(() => {
  delete process.env[UPSTREAM_ERROR_LOG_ENV];

  if (tempFile) {
    rmSync(tempFile, { force: true });
    tempFile = undefined;
  }
});

describe("captureUpstreamError", () => {
  test("is off by default", () => {
    const path = uniqueTempFile();
    delete process.env[UPSTREAM_ERROR_LOG_ENV];

    const written = captureUpstreamError({
      provider: "Example",
      model: "example-model",
      status: 500,
      body: "upstream failed",
    });

    expect(written).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  test("appends records instead of overwriting the file", () => {
    const path = uniqueTempFile();
    process.env[UPSTREAM_ERROR_LOG_ENV] = path;

    expect(
      captureUpstreamError({
        provider: "Example",
        model: "example-model",
        status: 429,
        body: "rate limited",
      })
    ).toBe(true);
    expect(
      captureUpstreamError({
        provider: "Example",
        model: "example-model",
        status: 503,
        body: "temporarily unavailable",
      })
    ).toBe(true);

    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);

    const records = lines.map((line) => JSON.parse(line) as CapturedRecord);
    expect(records[0]?.status).toBe(429);
    expect(records[1]?.status).toBe(503);
  });

  test("records the fields that matter and honours an explicit timestamp", () => {
    const path = uniqueTempFile();
    const at = "2026-08-18T01:02:03.456Z";
    process.env[UPSTREAM_ERROR_LOG_ENV] = path;

    expect(
      captureUpstreamError({
        provider: "GLM Coding",
        model: "glm-5.2",
        status: 429,
        body: '{"error":"quota"}',
        at,
      })
    ).toBe(true);

    const record = readRecord(path);
    expect(record.provider).toBe("GLM Coding");
    expect(record.model).toBe("glm-5.2");
    expect(record.status).toBe(429);
    expect(record.body).toBe('{"error":"quota"}');
    expect(Number.isNaN(Date.parse(record.at))).toBe(false);
    expect(new Date(record.at).toISOString()).toBe(at);
    expect(record.at).toBe(at);
  });

  test("marks a truncated body with its original size", () => {
    const path = uniqueTempFile();
    const body = "x".repeat(5000);
    process.env[UPSTREAM_ERROR_LOG_ENV] = path;

    expect(
      captureUpstreamError({
        provider: "Example",
        model: "example-model",
        status: 500,
        body,
      })
    ).toBe(true);

    const record = readRecord(path);
    expect(record.body).toHaveLength(MAX_CAPTURED_BODY_BYTES);
    expect(record.body).toBe(body.slice(0, MAX_CAPTURED_BODY_BYTES));
    expect(record.truncated).toBe(true);
    expect(record.original_bytes).toBe(5000);
  });

  test("does not mark a short body as truncated", () => {
    const path = uniqueTempFile();
    const body = "complete upstream error";
    process.env[UPSTREAM_ERROR_LOG_ENV] = path;

    expect(
      captureUpstreamError({
        provider: "Example",
        model: "example-model",
        status: 400,
        body,
      })
    ).toBe(true);

    const record = readRecord(path);
    expect(record.body).toBe(body);
    expect(record).not.toHaveProperty("truncated");
  });

  test("never throws when the capture path is unwritable", () => {
    const path = uniqueTempFile();
    writeFileSync(path, "regular file");
    process.env[UPSTREAM_ERROR_LOG_ENV] = join(path, "nope.log");
    let written = true;

    expect(() => {
      written = captureUpstreamError({
        provider: "Example",
        model: "example-model",
        status: 500,
        body: "upstream failed",
      });
    }).not.toThrow();
    expect(written).toBe(false);
  });
});
