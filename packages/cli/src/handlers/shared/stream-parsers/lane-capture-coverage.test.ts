/**
 * Capture coverage per streaming lane — "no lane streams without a capture".
 *
 * Mandate (user, 2026-10-09): *capture ALL claudish traffic without exception*.
 * A lane that emits to the client but writes no `resp-*.sse` is not merely
 * under-instrumented: it is **indistinguishable from a silent lane**, because
 * every capture analysis (traffic-summary / traffic-history / lane-matrix /
 * pre-lane-matrix ad-hoc joins) infers "no traffic" from the absence of a file.
 * That is exactly how the responses lane read as idle from 28/08 to 12/09 before
 * bb170b97 wired it — the lesson [[sol-lane-no-response-capture]] records, and
 * the reason the two remaining gaps (gemini, ollama) were closed the same day.
 *
 * The static guard below is the part that generalizes: it is not a list of the
 * two lanes that were missing, it is an invariant over every parser module in
 * this directory, so the NEXT unwired `*-sse.ts` / `*-jsonl.ts` fails HERE
 * rather than silently re-opening the blind spot.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGeminiSseStream } from "./gemini-sse.js";
import { createOllamaJsonlStream } from "./ollama-jsonl.js";
import { __resetCaptureDirMemo } from "../response-capture.js";

const PARSER_DIR = join(import.meta.dir);
const CAPTURE_DIR = join(tmpdir(), `claudish-lane-capture-${process.pid}`);

const encoder = new TextEncoder();

function upstreamResponse(raw: string): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(raw));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

/** Minimal Hono-context stand-in: only `req` is read (for the reqN correlation). */
const ctx = { req: {} } as any;

async function captureStdout(fn: () => Promise<void>): Promise<string[]> {
  const written: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: any) => boolean }).write = (chunk: any) => {
    written.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    (process.stdout as unknown as { write: typeof realWrite }).write = realWrite;
  }
  return written.join("").split("\n");
}

async function drain(response: Response): Promise<string> {
  let out = "";
  await response.body!.pipeTo(
    new WritableStream({
      write(chunk: Uint8Array) {
        out += new TextDecoder().decode(chunk, { stream: true });
      },
    })
  );
  return out;
}

/** The stop_reason of the terminal message_delta the client received. */
function clientStopReason(output: string): string | undefined {
  let found: string | undefined;
  for (const line of output.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const d = JSON.parse(line.slice(6));
      if (d.type === "message_delta") found = d.delta?.stop_reason;
    } catch {}
  }
  return found;
}

/** Capture files written for this run (fire-and-forget: allow a tick to land). */
async function captureFiles(): Promise<string[]> {
  await new Promise((r) => setTimeout(r, 40));
  try {
    return readdirSync(CAPTURE_DIR).filter((f) => f.startsWith("resp-"));
  } catch {
    return [];
  }
}

beforeEach(() => {
  rmSync(CAPTURE_DIR, { recursive: true, force: true });
  __resetCaptureDirMemo();
  process.env.CLAUDISH_CAPTURE_DIR = CAPTURE_DIR;
});

afterEach(async () => {
  delete process.env.CLAUDISH_CAPTURE_DIR;
  await new Promise((r) => setTimeout(r, 25));
  rmSync(CAPTURE_DIR, { recursive: true, force: true });
  __resetCaptureDirMemo();
});

describe("gemini lane — capture + [resp] marker", () => {
  const RAW =
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "hello" }] } }] })}\n\n` +
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] })}\n\n`;

  test("a completed turn writes a resp-*.sse and closes the marker stop=end_turn", async () => {
    let output = "";
    const lines = await captureStdout(async () => {
      output = await drain(
        createGeminiSseStream(ctx, upstreamResponse(RAW), { modelName: "gemini-2.0-flash" })
      );
    });

    // The client stream is intact (capture must never alter it).
    expect(output).toContain("event: message_stop");
    expect(clientStopReason(output)).toBe("end_turn");

    const marker = lines.find((l) => l.includes("[resp] gemini"));
    expect(marker).toBeDefined();
    expect(marker).toContain("closed=true stop=end_turn ");
    expect(marker).toContain("model=gemini-2.0-flash");

    // The whole point: the lane is no longer invisible to capture analysis.
    const files = await captureFiles();
    expect(files.length).toBe(1);
    expect(files[0]).toContain("gemini");
    const body = readFileSync(join(CAPTURE_DIR, files[0]), "utf-8");
    expect(body).toContain("hello"); // the translated SSE the client received
    expect(body).toContain("text_delta");
  });

  test("a client cancel closes the capture as closed=false stop=client-cancel", async () => {
    // An upstream that never ends, so the only way out is the client leaving.
    const neverEnding = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "still going" }] } }] })}\n\n`
            )
          );
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } }
    );

    const lines = await captureStdout(async () => {
      const reader = createGeminiSseStream(ctx, neverEnding, { modelName: "gemini-2.0-flash" }).body!.getReader();
      await reader.read();
      await reader.cancel("client went away");
    });

    const marker = lines.find((l) => l.includes("[resp] gemini"));
    expect(marker).toBeDefined();
    expect(marker).toContain("closed=false stop=client-cancel ");
    expect((await captureFiles()).length).toBe(1);
  });
});

describe("ollama lane — capture + [resp] marker", () => {
  const RAW =
    `${JSON.stringify({ message: { content: "hello" }, done: false })}\n` +
    `${JSON.stringify({ message: { content: " world" }, done: false })}\n` +
    `${JSON.stringify({ done: true, prompt_eval_count: 7, eval_count: 2 })}\n`;

  test("a completed turn writes a resp-*.sse and closes the marker stop=end_turn", async () => {
    let output = "";
    const lines = await captureStdout(async () => {
      output = await drain(
        createOllamaJsonlStream(ctx, upstreamResponse(RAW), { modelName: "llama3.2" })
      );
    });

    expect(output).toContain("event: message_stop");
    expect(clientStopReason(output)).toBe("end_turn");

    const marker = lines.find((l) => l.includes("[resp] ollama"));
    expect(marker).toBeDefined();
    expect(marker).toContain("closed=true stop=end_turn ");
    expect(marker).toContain("model=llama3.2");

    const files = await captureFiles();
    expect(files.length).toBe(1);
    expect(files[0]).toContain("ollama");
    const body = readFileSync(join(CAPTURE_DIR, files[0]), "utf-8");
    expect(body).toContain("hello");
    expect(body).toContain("text_delta");
  });
});

describe("no stream parser may be added without a capture", () => {
  // Every module here that owns a client-side stream parser is named
  // `<wire>-sse.ts` or `<wire>-jsonl.ts`. Matching the convention (rather than
  // listing the five known parsers) is what makes this a guard: a sixth parser
  // enters the set by being created, and fails until it wires the capture.
  const streamParsers = readdirSync(PARSER_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .filter((f) => /-sse\.ts$|-jsonl\.ts$/.test(f))
    .sort();

  test("the parser set is non-empty (guards the glob itself)", () => {
    // A filter that silently matches nothing is how a guard turns into a green
    // no-op — the positive control the repo's own grep-based checks learned to
    // carry (see the `controller.close()` control in CLAUDE.md).
    expect(streamParsers.length).toBeGreaterThanOrEqual(5);
  });

  test.each(streamParsers)("%s taps the response capture", (file) => {
    const src = readFileSync(join(PARSER_DIR, file), "utf-8");
    expect(src).toContain("createResponseCapture(");
    expect(src).toContain("cap.done("); // closes out → the [resp] marker exists
    expect(src).toContain("cap.tap("); // actually carries the bytes
  });
});
