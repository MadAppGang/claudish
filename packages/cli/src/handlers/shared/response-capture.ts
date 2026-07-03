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
        const fs = require("fs");
        fs.mkdirSync(captureDir, { recursive: true });
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
        fs.writeFileSync(file, header + sse);
        const stopReason = extra?.stop_reason ?? "?";
        const closed = extra?.closed ?? "?";
        process.stdout.write(
          `  [resp] ${label} model=${model} reqN=${reqN} events~=${events} bytes=${sse.length} closed=${closed} stop=${stopReason} ${Date.now() - startedAt}ms -> ${file}\n`
        );
      } catch (e) {
        process.stdout.write(`  [resp] capture error: ${String(e)}\n`);
      }
    },
  };
}
