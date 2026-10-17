#!/usr/bin/env bun
/**
 * Extract raw SSE events from claudish debug logs into replay fixture files.
 *
 * Usage:
 *   bun run src/test-fixtures/extract-sse-from-log.ts <debug-log-path> [output-dir] [--allow-corrupt]
 *
 * Parses [SSE:openai] and [SSE:anthropic] log lines, separates them into one
 * stream per UPSTREAM RESPONSE, and writes each stream as a standalone .sse
 * fixture file.
 *
 * Output:
 *   <output-dir>/<model>-<format>-turn<N>.sse
 *
 * Example:
 *   bun run src/test-fixtures/extract-sse-from-log.ts logs/claudish_2026-03-17_09-41-32.log
 *   → sse-responses/kimi-k2.5-openai-turn1.sse
 *   → sse-responses/kimi-k2.5-openai-turn2.sse
 *
 * SEPARATION: a debug log does NOT hold one conversation. `claudish serve`, and any
 * session whose harness fires a background request, has several upstream responses
 * streaming at once, and their log lines interleave. Grouping by the "HANDLER STARTED" /
 * "Calling API" markers — which is what this script did until 2026-09-18 — merged them
 * into one "turn". That is worse than a missing fixture: during v9.5.0 work it produced a
 * turn carrying 12 foreign events including a `finish_reason:"stop"` from ANOTHER
 * response, which made the regression test it fed pass with or without the fix under
 * test. A fixture that cannot fail is indistinguishable from a passing one.
 *
 * Every OpenAI chunk carries the response `id`, and every Anthropic stream opens with a
 * `message_start` carrying `message.id`, so the streams are separable after the fact.
 * See `groupEventsIntoStreams` for what happens to the events that carry no id.
 *
 * INTEGRITY: every `data:` payload is JSON-parsed before anything is written. A stream
 * containing an unparseable payload is NOT written — the log line is reported by number
 * and the run exits non-zero. A fixture that cannot be parsed is worse than no fixture:
 * the stream parsers swallow `JSON.parse` failures, so the damage shows up much later as
 * a missing tool call or a wrong `stop_reason` and reads like a parser bug. Historically
 * the debug logger itself truncated payloads at 300 chars and produced exactly that.
 *
 * `--allow-corrupt` writes the damaged streams anyway, to `*.corrupt.sse` (never the plain
 * name), for inspecting a broken capture. Such a file must never be used as a fixture.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Sentinel appended by the stream parsers when a payload exceeded their (1M char)
 * log ceiling. Kept as a literal so this script stays dependency-free; if it ever
 * drifts from `SSE_LOG_TRUNCATION_MARKER` in openai-sse.ts we lose only the nicer
 * message — the JSON.parse check below still catches the event.
 */
const TRUNCATION_MARKER = "<<<CLAUDISH_SSE_TRUNCATED>>>";

/** One `data:` payload, with the log line it came from so failures can be located. */
export interface SseEvent {
  data: string;
  /** 1-based line number in the source debug log. */
  line: number;
}

export type SseFormat = "openai" | "anthropic";

/** One upstream response: every event here came from a single HTTP stream. */
export interface SseStream {
  format: SseFormat;
  /**
   * The upstream response id every event in this stream carried, or `null` when
   * the capture began mid-stream and no id was ever seen.
   */
  streamId: string | null;
  events: SseEvent[];
}

/** An SSE line as it was read out of the log, before any grouping. */
export interface TaggedLine {
  format: SseFormat;
  data: string;
  line: number;
}

/** `[DONE]` is the SSE terminator, not JSON — the only payload allowed not to parse. */
export function isSentinelPayload(data: string): boolean {
  return data.trim() === "[DONE]";
}

function parseEvent(data: string): any | null {
  if (isSentinelPayload(data)) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/** The model name the log names, for the fixture filename. */
export function detectModel(lines: string[]): string {
  for (const line of lines) {
    const handlerMatch = line.match(/HANDLER STARTED for (.+?) =====/);
    if (handlerMatch) return handlerMatch[1].replace(/\//g, "-");
    const anthropicMatch = line.match(/Stream complete for (.+?):/);
    if (anthropicMatch) return anthropicMatch[1].replace(/\//g, "-");
  }
  return "unknown";
}

/** Pull every `[SSE:*]` payload out, in log order. */
export function readSseLines(content: string): TaggedLine[] {
  const out: TaggedLine[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const openai = lines[i].match(/\[SSE:openai\] (.+)/);
    if (openai) {
      out.push({ format: "openai", data: openai[1], line: i + 1 });
      continue;
    }
    const anthropic = lines[i].match(/\[SSE:anthropic\] (.+)/);
    if (anthropic) {
      out.push({ format: "anthropic", data: anthropic[1], line: i + 1 });
    }
  }
  return out;
}

/**
 * The upstream response id an event announces, or `null` when it announces none.
 *
 * OpenAI chunks all carry `id`. Anthropic only states it on `message_start`
 * (`message.id`); every later event in that stream is anonymous.
 */
function announcedStreamId(format: SseFormat, data: string): string | null {
  const parsed = parseEvent(data);
  if (!parsed || typeof parsed !== "object") return null;
  if (format === "openai") {
    return typeof parsed.id === "string" && parsed.id.length > 0 ? parsed.id : null;
  }
  if (parsed.type === "message_start" && typeof parsed.message?.id === "string") {
    return parsed.message.id;
  }
  return null;
}

/** An event that ENDS its stream, so a later event reusing the id opens a new one. */
function endsStream(format: SseFormat, data: string): boolean {
  if (isSentinelPayload(data)) return true;
  if (format !== "anthropic") return false;
  const parsed = parseEvent(data);
  return parsed?.type === "message_stop";
}

/**
 * Separate interleaved log lines into one stream per upstream response.
 *
 * Keyed by the response id, NOT by the "HANDLER STARTED" markers: the markers say
 * when a request was ISSUED, and two requests issued back to back stream their
 * responses over each other. The id is on the wire and is the only thing that
 * actually distinguishes them.
 *
 * Events that announce no id — an OpenAI `[DONE]`, every Anthropic event after
 * `message_start`, and any payload too corrupt to parse — are appended to the most
 * recent OPEN stream of their own format. For `[DONE]` that is exact: the SSE
 * terminator immediately follows the last chunk of the stream it closes. For the
 * anonymous Anthropic events it is exact only while Anthropic streams do not
 * overlap, which the wire gives us no way to improve on — a delta simply does not
 * say which message it belongs to. A corrupt payload is deliberately KEPT rather
 * than dropped, so the integrity check below still refuses to write its stream.
 */
export function groupEventsIntoStreams(tagged: TaggedLine[]): SseStream[] {
  const streams: SseStream[] = [];
  /** Streams still accepting events, by `format:id`. */
  const open = new Map<string, SseStream>();
  /** Most recently opened stream per format, for the events that carry no id. */
  const latest = new Map<SseFormat, SseStream>();

  for (const { format, data, line } of tagged) {
    const id = announcedStreamId(format, data);
    let stream: SseStream | undefined;

    if (id !== null) {
      stream = open.get(`${format}:${id}`);
      if (!stream) {
        stream = { format, streamId: id, events: [] };
        streams.push(stream);
        open.set(`${format}:${id}`, stream);
      }
      latest.set(format, stream);
    } else {
      stream = latest.get(format);
      if (!stream) {
        // The capture begins mid-stream: no id was ever announced for it.
        stream = { format, streamId: null, events: [] };
        streams.push(stream);
        latest.set(format, stream);
      }
    }

    stream.events.push({ data, line });

    if (endsStream(format, data)) {
      if (stream.streamId !== null) open.delete(`${format}:${stream.streamId}`);
      if (latest.get(format) === stream) latest.delete(format);
    }
  }

  return streams;
}

/** Read a whole debug log into per-response streams. */
export function extractStreamsFromLog(content: string): {
  model: string;
  streams: SseStream[];
} {
  return {
    model: detectModel(content.split("\n")),
    streams: groupEventsIntoStreams(readSseLines(content)),
  };
}

export interface CorruptEvent {
  line: number;
  data: string;
  reason: string;
}

export function findCorruptEvents(events: SseEvent[]): CorruptEvent[] {
  const bad: CorruptEvent[] = [];
  for (const event of events) {
    if (isSentinelPayload(event.data)) continue;
    if (event.data.includes(TRUNCATION_MARKER)) {
      bad.push({
        line: event.line,
        data: event.data,
        reason: `payload exceeded the logger's ceiling and was cut (${TRUNCATION_MARKER})`,
      });
      continue;
    }
    try {
      JSON.parse(event.data);
    } catch (e) {
      bad.push({
        line: event.line,
        data: event.data,
        reason: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return bad;
}

/** The fixture body for one stream: the payloads, verbatim, in log order. */
export function renderFixture(events: SseEvent[]): string {
  return `${events.map((e) => `data: ${e.data}\n`).join("\n")}\n`;
}

function main(argv: string[]): number {
  const allowCorrupt = argv.includes("--allow-corrupt");
  const positional = argv.filter((a) => !a.startsWith("--"));

  const logFile = positional[0];
  if (!logFile) {
    console.error(
      "Usage: bun run extract-sse-from-log.ts <debug-log-path> [output-dir] [--allow-corrupt]"
    );
    return 1;
  }

  const outputDir =
    positional[1] || join(dirname(new URL(import.meta.url).pathname), "sse-responses");
  mkdirSync(outputDir, { recursive: true });

  const content = readFileSync(logFile, "utf-8");
  const { model, streams } = extractStreamsFromLog(content);

  console.log(`Log file: ${logFile}`);
  console.log(`Model: ${model}`);
  console.log(`Output dir: ${outputDir}`);
  console.log(`Upstream responses found: ${streams.length}`);

  let written = 0;
  let corruptStreams = 0;

  for (let i = 0; i < streams.length; i++) {
    const stream = streams[i];
    const base = `${model}-${stream.format}-turn${i + 1}`;
    const corrupt = findCorruptEvents(stream.events);

    if (corrupt.length > 0) {
      corruptStreams++;
      console.error(
        `\n  ✗ ${base}: ${corrupt.length}/${stream.events.length} event(s) are NOT valid JSON — this capture is corrupt.`
      );
      for (const bad of corrupt.slice(0, 10)) {
        console.error(`      ${logFile}:${bad.line}: ${bad.reason}`);
        console.error(`        payload (${bad.data.length} chars): ${bad.data.slice(0, 120)}…`);
      }
      if (corrupt.length > 10) {
        console.error(`      … and ${corrupt.length - 10} more`);
      }

      if (!allowCorrupt) {
        console.error(
          "      NOT WRITTEN. Re-capture the log with a claudish build that logs SSE payloads verbatim,\n" +
            "      then re-run. Do NOT hand-repair the JSON — fixtures must come from real logs.\n" +
            `      To inspect the damaged capture anyway: re-run with --allow-corrupt (writes ${base}.corrupt.sse).`
        );
        continue;
      }

      writeFileSync(join(outputDir, `${base}.corrupt.sse`), renderFixture(stream.events), "utf-8");
      console.error(`      --allow-corrupt: wrote ${base}.corrupt.sse — NOT usable as a fixture.`);
      continue;
    }

    const filename = `${base}.sse`;
    writeFileSync(join(outputDir, filename), renderFixture(stream.events), "utf-8");
    written++;

    const textChunks = stream.events.filter((e) => {
      const parsed = parseEvent(e.data);
      if (!parsed) return false;
      // OpenAI format
      if (parsed.choices?.[0]?.delta?.content) return true;
      // Anthropic format
      if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") return true;
      return false;
    }).length;

    const toolCalls = stream.events.filter((e) => {
      const parsed = parseEvent(e.data);
      if (!parsed) return false;
      if (parsed.choices?.[0]?.delta?.tool_calls) return true;
      if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use")
        return true;
      return false;
    }).length;

    console.log(
      `  ${filename}: id=${stream.streamId ?? "(none)"}, ${stream.events.length} events, ` +
        `${textChunks} text chunks, ${toolCalls} tool calls`
    );
  }

  console.log(`\nWrote ${written} fixture file(s) to ${outputDir}`);

  if (written === 0 && corruptStreams === 0) {
    console.log("\nNo [SSE:openai] or [SSE:anthropic] lines found in log.");
    console.log(
      "Make sure the log was captured with claudish v5.13.2+ (which includes raw SSE logging)."
    );
    console.log("Re-run with: claudish --model <model> --debug-claudish ...");
  }

  if (corruptStreams > 0) {
    console.error(
      `\n${corruptStreams} stream(s) contained unparseable SSE payloads. ` +
        `${allowCorrupt ? "Written as *.corrupt.sse — do not commit them as fixtures." : "Nothing was written for them."}`
    );
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
