/**
 * Response-side SSE capture (temporary diagnostic — gated by CLAUDISH_CAPTURE_DIR).
 *
 * Pairs with the request-body capture in fork/middleware/request-logger.ts so we
 * can inspect the FULL request→response of a hung/blocked stream offline. Every
 * stream parser (anthropic-sse, openai-sse, native passthrough) taps its outgoing
 * bytes here. At stream close we write the accumulated SSE to a `resp-*.sse` file
 * and emit a one-line stdout marker visible in `docker logs`.
 *
 * No-op when CLAUDISH_CAPTURE_DIR is unset, so this is invisible in normal operation.
 *
 * The stdout marker is the key real-time signal: if a `[Request]` line appears in
 * docker logs but its matching `[resp ...]` marker never does, the stream hung
 * server-side (the parser loop never reached close).
 */

import { mkdirSync, appendFileSync } from "fs";
import { writeFile } from "fs/promises";

// The resp-*.sse write is FIRE-AND-FORGET, for the same reason the request-side
// capture is (commit 180f1cb, incident 2026-08-20): Bun is single-threaded, and
// over a Docker bind-mount to a Windows dir one slow writeFileSync freezes EVERY
// handler - including the 4s /health heartbeat the relay failover keys off.
// That fix landed on request-logger.ts only; this file kept writeFileSync while
// holding the LARGER payloads (a finalized glm-5.2 stream runs 700-950 KB against
// a request body's ~535 KB), so the response side stayed the bigger stall of the
// two. Diagnosed 2026-08-24 with po-2023: type-1 hub degradations (/health 4.5ms
// -> 7.8s, load-independent, self-resolving) are each preceded by a SALVE of
// giant response finalizations; an isolated giant produces none.
//
// The stdout marker is emitted BEFORE the write is dispatched, deliberately: it
// is the real-time hang signal (a [Request] line with no matching [resp] means
// the parser loop never reached close), so it must not wait on disk I/O.
let captureDirReady: string | null = null;

function ensureCaptureDir(dir: string): boolean {
  if (captureDirReady === dir) return true;
  try {
    mkdirSync(dir, { recursive: true }); // no-op on an existing dir, never throws EEXIST
    captureDirReady = dir;
    return true;
  } catch (e) {
    process.stdout.write(`  [resp] mkdir error: ${String(e)}\n`);
    return false;
  }
}

/** Test seam: forget the memoized dir so a fresh tmpdir is re-created. */
export function __resetCaptureDirMemo(): void {
  captureDirReady = null;
}

/**
 * The request counter request-logger increments (globalThis.__capN) — same
 * correlation key the [resp] marker uses. Exported for the [ttft] markers so
 * req→first-token→close lines join without re-reading the global ad hoc.
 */
export function currentRequestNumber(): number {
  const g = globalThis as Record<string, unknown>;
  return (g.__capN as number) ?? 0;
}

export interface ResponseCapture {
  /** Tap outgoing bytes (raw Uint8Array or a pre-encoded SSE string). */
  tap(chunk: Uint8Array | string): void;
  /** Record a lifecycle note (e.g. "message_stop", "synthetic-finalize", "error"). */
  note(label: string): void;
  /** Flush to disk + emit stdout marker. Idempotent. */
  done(extra?: Record<string, unknown>): void;
}

const NOOP: ResponseCapture = {
  tap() {},
  note() {},
  done() {},
};

/**
 * Create a response capture for one stream. `label` identifies the parser
 * (e.g. "anthropic", "openai", "native"). Returns a no-op when capture is off.
 */
export function createResponseCapture(
  label: string,
  model: string,
  enabled = true
): ResponseCapture {
  const captureDir = process.env.CLAUDISH_CAPTURE_DIR;
  // `enabled = false` lets the relay nominal forward reuse the passthrough stream
  // without writing an orphan resp-*.sse (no matching req capture on the sidecar;
  // the hub captures centrally).
  if (!captureDir || !enabled) return NOOP;

  const decoder = new TextDecoder();
  let sse = "";
  const notes: string[] = [];
  let events = 0;
  let finished = false;
  const startedAt = Date.now();

  // Correlate with the request counter from request-logger (shared globalThis.__capN).
  const g = globalThis as Record<string, unknown>;
  const reqN = (g.__capN as number) ?? 0;

  return {
    tap(chunk: Uint8Array | string) {
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      sse += text;
      // Count SSE events (data: lines) for a quick at-a-glance summary.
      let idx = 0;
      while ((idx = text.indexOf("\ndata:", idx)) !== -1) {
        events++;
        idx += 6;
      }
    },
    note(noteLabel: string) {
      notes.push(`+${Date.now() - startedAt}ms ${noteLabel}`);
    },
    done(extra?: Record<string, unknown>) {
      if (finished) return;
      finished = true;
      try {
        if (!ensureCaptureDir(captureDir)) return;
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const safeModel = String(model).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40);
        const file = `${captureDir}/resp-${process.pid}-r${String(reqN).padStart(4, "0")}-${ts}-${label}-${safeModel}.sse`;
        const header =
          `# claudish response capture\n` +
          `# parser=${label} model=${model} reqN=${reqN} pid=${process.pid}\n` +
          `# elapsed_ms=${Date.now() - startedAt} events~=${events}\n` +
          `# notes=${notes.join(" | ")}\n` +
          (extra ? `# extra=${JSON.stringify(extra)}\n` : "") +
          `# ${"=".repeat(60)}\n\n`;
        const stopReason = extra?.stop_reason ?? "?";
        const closed = extra?.closed ?? "?";
        process.stdout.write(
          `  [resp] ${label} model=${model} reqN=${reqN} events~=${events} bytes=${sse.length} closed=${closed} stop=${stopReason} ${Date.now() - startedAt}ms -> ${file}\n`
        );
        // Fire-and-forget: see the note at the top of this file.
        writeFile(file, header + sse).catch((e) => {
          process.stdout.write(`  [resp] capture write error: ${String(e)}\n`);
        });
      } catch (e) {
        process.stdout.write(`  [resp] capture error: ${String(e)}\n`);
      }
    },
  };
}

/**
 * Durably append an upstream error body to a survives-recreates log.
 *
 * Non-ok upstream responses (429 quota, 402 payment, 500, …) short-circuit
 * BEFORE the stream parser runs, so `createResponseCapture` never taps them —
 * their bodies lived only in stdout, which a `docker compose up` recreate
 * wipes. That made the exact 429 wording needed to calibrate `isQuotaExhaustion`
 * unreachable after the fact (incident 2026-08-11 morning: the GLM cap-5h 429
 * body was lost to a container recreate done the same evening for the failover
 * deploy). This appends one JSON line per error to
 * `${CLAUDISH_CAPTURE_DIR}/upstream-errors.log`, which is bind-mounted on the
 * hub and so survives recreates — the next saturation leaves a durable trail.
 *
 * No-op when `CLAUDISH_CAPTURE_DIR` is unset. Never throws.
 */
export function appendUpstreamError(entry: {
  model: string;
  provider: string;
  status: number;
  body: string;
}): void {
  const captureDir = process.env.CLAUDISH_CAPTURE_DIR;
  if (!captureDir) return;
  try {
    if (!ensureCaptureDir(captureDir)) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      model: entry.model,
      provider: entry.provider,
      status: entry.status,
      body: String(entry.body).slice(0, 2048),
    });
    // Kept SYNCHRONOUS on purpose: appends must not interleave, the payload is
    // capped at 2 KB, and this path only runs on an upstream error - it is not
    // the per-response hot path the fire-and-forget note above describes.
    appendFileSync(`${captureDir}/upstream-errors.log`, line + "\n");
  } catch {
    // capture must never crash claudish
  }
}
