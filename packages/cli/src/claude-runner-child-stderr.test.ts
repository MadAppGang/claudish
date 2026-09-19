import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { isSuppressibleChildStderrLine, relayChildStderr } from "./claude-runner.js";

const SDK_NOISE =
  '[claude-code:unrecognized_model] {"model":"qtoken@qwen3.8-max","query_source":"sdk"}';
const TITLE_NOISE =
  '[claude-code:unrecognized_model] {"model":"qtoken@qwen3.8-max","query_source":"generate_session_title"}';

describe("isSuppressibleChildStderrLine", () => {
  test("suppresses the unrecognized-model line from both observed query sources", () => {
    expect(isSuppressibleChildStderrLine(SDK_NOISE)).toBe(true);
    expect(isSuppressibleChildStderrLine(TITLE_NOISE)).toBe(true);
  });

  test("does not suppress other diagnostics", () => {
    const diagnostics = [
      "[claudish] Error [OpenRouter]: HTTP 400 upstream rejected the request",
      "    at runClaudeWithProxy (/tmp/claude-runner.ts:1939:5)",
      "",
      "\"or@x\" isn't described by this version's model catalog; update Claude Code, …",
      `prefix ${SDK_NOISE}`,
    ];

    for (const line of diagnostics) {
      expect(isSuppressibleChildStderrLine(line)).toBe(false);
    }
  });
});

describe("relayChildStderr", () => {
  const originalStderrWrite = process.stderr.write;
  let stderrWrites: string[];

  beforeEach(() => {
    stderrWrites = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
  });

  test("suppresses a complete noise line", async () => {
    const stream = new PassThrough();
    relayChildStderr(stream);
    const ended = once(stream, "end");

    stream.end(`${SDK_NOISE}\n`);
    await ended;

    expect(stderrWrites).toEqual([]);
  });

  test("relays a complete normal line with its newline", async () => {
    const stream = new PassThrough();
    relayChildStderr(stream);
    const ended = once(stream, "end");

    stream.end("real diagnostic\n");
    await ended;

    expect(stderrWrites).toEqual(["real diagnostic\n"]);
  });

  test("suppresses a noise line split across chunks", async () => {
    const stream = new PassThrough();
    relayChildStderr(stream);
    const ended = once(stream, "end");

    stream.write("[claude-code:unrecog");
    stream.end('nized_model] {"model":"qtoken@qwen3.8-max","query_source":"sdk"}\n');
    await ended;

    expect(stderrWrites).toEqual([]);
  });

  test("relays normal lines around noise in order", async () => {
    const stream = new PassThrough();
    relayChildStderr(stream);
    const ended = once(stream, "end");

    stream.end(`first diagnostic\n${TITLE_NOISE}\nsecond diagnostic\n`);
    await ended;

    expect(stderrWrites).toEqual(["first diagnostic\n", "second diagnostic\n"]);
  });

  test("flushes an unterminated normal tail without inventing a newline", async () => {
    const stream = new PassThrough();
    relayChildStderr(stream);
    const ended = once(stream, "end");

    stream.end("fatal crash without newline");
    await ended;

    expect(stderrWrites).toEqual(["fatal crash without newline"]);
  });

  test("suppresses an unterminated noise tail on flush", async () => {
    const stream = new PassThrough();
    relayChildStderr(stream);
    const ended = once(stream, "end");

    stream.end(SDK_NOISE);
    await ended;

    expect(stderrWrites).toEqual([]);
  });

  test("flushes an unterminated tail only once when end and close both fire", async () => {
    const stream = new PassThrough();
    relayChildStderr(stream);
    const ended = once(stream, "end");
    const closed = once(stream, "close");

    stream.end("single tail");
    await Promise.all([ended, closed]);

    expect(stderrWrites).toEqual(["single tail"]);
  });
});
