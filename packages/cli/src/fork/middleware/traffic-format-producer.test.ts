/**
 * Producer-side pinning of the `[ttft]` / `[resp]` stdout marker format —
 * claudish #72 grain 1 (the `[Request]` half is pinned in request-logger.test.ts
 * since #3391; this file completes the marker contract for the response side).
 *
 * The parsers that consume these lines live in ANOTHER repo (roo-state-manager
 * `claudish_traffic`, roo-extensions #3391) or in traffic-*.ps1 — so a format
 * drift here breaks consumers weeks later, silently. The pinning is therefore
 * at the PRODUCER: the exact template lives once in traffic-markers.ts, and
 * these tests hold builders and __fixtures__/traffic-format/ files to the same
 * shape. Editing either side goes red in THIS repo's test run.
 *
 * Fixtures mix WILD lines (relay .46 docker logs, timestamp-stripped — the
 * shapes actually observed in production) and PRODUCER-BUILT lines for shapes
 * that corpus held no sample of (`responses` label, headers=-1, `?` fallbacks,
 * client-cancel) — provenance is annotated in each fixture header.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { respMarkerLine, ttftMarkerLine, wallMarkerLine } from "../../handlers/shared/traffic-markers.js";
import { logRequest, requestNumberFor } from "./request-logger.js";
import {
  __resetCaptureDirMemo,
  createResponseCapture,
} from "../../handlers/shared/response-capture.js";

// ── The contract, as a consumer would write it ──────────────────────────────
// Two leading spaces are PART of the format (both templates start with "  ").
// `headers` and `total` may be -1 ("not measured" — never a bogus sum with -1).
// `closed`/`stop` may be `?`. Field order is load-bearing for latency
// histograms and (pid, reqN) joins; units are suffixed on every numeric field.
const TTFT_RE =
  /^  \[ttft\] (\S+) model=(\S+) reqN=(\d+) headers=(-?\d+)ms firstEvent=(\d+)ms total=(-?\d+)ms$/;
const RESP_RE =
  /^  \[resp\] (\S+) model=(\S+) reqN=(\d+) events~=(\d+) bytes=(\d+) closed=(\S+) stop=(\S+) (\d+)ms -> (\S+)$/;

const FIXTURE_DIR = join(import.meta.dir, "../../../__fixtures__/traffic-format");

/** Fixture lines verbatim (leading spaces kept — they are contract), CRLF-safe. */
function fixtureLines(name: string): string[] {
  const raw = readFileSync(join(FIXTURE_DIR, name), "utf8");
  return raw
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l && !l.startsWith("#"));
}

describe("ttftMarkerLine — the [ttft] producer", () => {
  test("exact shape, label is the parser, total = headers + firstEvent", () => {
    expect(ttftMarkerLine("anthropic", "glm-5.2", 0, 2881, 3)).toBe(
      "  [ttft] anthropic model=glm-5.2 reqN=0 headers=2881ms firstEvent=3ms total=2884ms\n"
    );
  });

  test("unmeasured header latency is -1 and forces total=-1 (never a bogus sum)", () => {
    expect(ttftMarkerLine("anthropic", "glm-5.2", 7, undefined, 903)).toBe(
      "  [ttft] anthropic model=glm-5.2 reqN=7 headers=-1ms firstEvent=903ms total=-1ms\n"
    );
    expect(ttftMarkerLine("openai", "m", 1, null, 5)).toContain("headers=-1ms");
    expect(ttftMarkerLine("openai", "m", 1, null, 5)).toContain("total=-1ms");
  });

  test("every fixture line matches the contract AND is builder-reproducible", () => {
    // Inputs per fixture line, in order (see provenance in the fixture header).
    const inputs: Array<[string, string, number, number | undefined, number]> = [
      ["anthropic", "glm-5.2", 0, 2881, 3],
      ["openai", "glm-5.2", 1, 4335, 3],
      ["responses", "gpt-5.6-sol", 42, 1204, 87],
      ["anthropic", "glm-5.2", 7, undefined, 903],
    ];
    const lines = fixtureLines("ttft-lines.txt");
    expect(lines.length).toBe(inputs.length);
    lines.forEach((line, i) => {
      expect(TTFT_RE.test(line), `fixture line must match contract: "${line}"`).toBe(true);
      const [label, model, reqN, hdr, fe] = inputs[i];
      expect(ttftMarkerLine(label, model, reqN, hdr, fe)).toBe(line + "\n");
    });
  });
});

describe("respMarkerLine — the [resp] producer", () => {
  test("exact shape with real fields", () => {
    expect(
      respMarkerLine("openai", "glm-5.2", 1, 7, 1019, true, "tool_use", 11, "/captures/resp-1-r0001-x.sse")
    ).toBe(
      "  [resp] openai model=glm-5.2 reqN=1 events~=7 bytes=1019 closed=true stop=tool_use 11ms -> /captures/resp-1-r0001-x.sse\n"
    );
  });

  test("the `?` fallbacks are the caller's meaning, interpolated verbatim", () => {
    const line = respMarkerLine("openai", "glm-5.3", 0, 0, 0, "?", "?", 5, "/captures/x.sse");
    expect(line).toContain("closed=? stop=? ");
    expect(RESP_RE.test(line.trimEnd())).toBe(true);
  });

  test("every fixture line matches the contract; built shapes are builder-reproducible", () => {
    const lines = fixtureLines("resp-lines.txt");
    expect(lines.length).toBe(4);
    for (const line of lines) {
      expect(RESP_RE.test(line), `fixture line must match contract: "${line}"`).toBe(true);
    }
    // Producer-built fixture lines (3rd and 4th) round-trip exactly.
    expect(
      respMarkerLine("openai", "glm-5.3", 0, 0, 0, "?", "?", 5,
        "/captures/resp-1-r0000-2026-10-07T00-00-00-000Z-openai-glm-5.3.sse")
    ).toBe(lines[2] + "\n");
    expect(
      respMarkerLine("anthropic", "kimi-k2.5", 9, 12, 4096, false, "client-cancel", 501,
        "/captures/resp-1-r0009-2026-10-07T00-00-00-000Z-anthropic-kimi-k2.5.sse")
    ).toBe(lines[3] + "\n");
  });
});

describe("createResponseCapture.done() emits through the pinned builder", () => {
  test("end-to-end: tap → done → marker matches RESP_RE with counted events/bytes", () => {
    // createResponseCapture is a NOOP without CLAUDISH_CAPTURE_DIR — point it at
    // a tmp dir so the real (fire-and-forget) capture path runs.
    const prevDir = process.env.CLAUDISH_CAPTURE_DIR;
    const tmp = join(tmpdir(), `claudish-ttft-contract-${process.pid}-${Date.now()}`);
    process.env.CLAUDISH_CAPTURE_DIR = tmp;
    const written: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (chunk: string) => {
      written.push(String(chunk));
      return true;
    };
    try {
      const cap = createResponseCapture("openai", "glm-5.2", true, 3);
      // events~ counts "\ndata:" occurrences — a data: line at the very start of
      // a tap (no preceding \n in the same chunk) is not counted, hence the
      // leading newline here. Pinned as-is: events~ is explicitly approximate.
      cap.tap("\ndata: {}\n\ndata: {}\n\n");
      cap.done({ stop_reason: "end_turn", closed: true });
    } finally {
      (process.stdout as unknown as { write: typeof realWrite }).write = realWrite;
      if (prevDir === undefined) delete process.env.CLAUDISH_CAPTURE_DIR;
      else process.env.CLAUDISH_CAPTURE_DIR = prevDir;
      __resetCaptureDirMemo();
      setTimeout(() => {
        try {
          rmSync(tmp, { recursive: true, force: true });
        } catch {}
      }, 50).unref?.();
    }
    const marker = written.find((l) => l.includes("[resp] openai"));
    expect(marker).toBeDefined();
    const m = RESP_RE.exec(marker!.trimEnd());
    expect(m).not.toBeNull();
    expect(m![1]).toBe("openai");
    expect(m![3]).toBe("3"); // reqN passed explicitly, not the global
    expect(m![4]).toBe("2"); // events~ counted from \ndata: occurrences
    expect(m![5]).toBe("21"); // bytes = tapped length
    expect(m![6]).toBe("true");
    expect(m![7]).toBe("end_turn");
    // file = <captureDir>/resp-<pid>-r<reqN zero-padded 4>-<ts, :/. → ->-<label>-<model>.sse
    expect(m![9]).toMatch(/resp-\d+-r0003-.*-openai-glm-5\.2\.sse$/);
  });
});

describe("emission sites use the shared builders (anti-re-inlining guard)", () => {
  // The [ttft] template used to exist as three independent inline copies — one
  // per stream parser, each free to drift alone. The builders single-source it;
  // this guard fails if a site re-inlines a template instead of calling the
  // builder, which is the one drift the exact-string pins above cannot see.
  test("the three stream parsers call ttftMarkerLine; response-capture calls respMarkerLine", () => {
    const src = (rel: string) =>
      readFileSync(join(import.meta.dir, rel), "utf8");
    for (const rel of [
      "../../handlers/shared/stream-parsers/openai-sse.ts",
      "../../handlers/shared/stream-parsers/anthropic-sse.ts",
      "../../handlers/shared/stream-parsers/openai-responses-sse.ts",
    ]) {
      expect(src(rel), `${rel} must call ttftMarkerLine`).toContain("ttftMarkerLine(");
    }
    expect(
      src("../../handlers/shared/response-capture.ts"),
      "response-capture.ts must call respMarkerLine"
    ).toContain("respMarkerLine(");
  });
});

describe("wall line — the two-pass client-error instrument's exact join key (#601)", () => {
  // docs/reference/traffic-analysis.md §"Client-visible final errors": pass 1
  // collects wall candidates, pass 2 asks whether a [resp] closed THAT request.
  // Without reqN the question is answered by temporal adjacency, which is only
  // opposable where interleaving is visible — an under-count risk on a busy
  // hub. Dropping reqN from the builder (or re-inlining the old template)
  // turns this block red.
  const WALL_RE = /^Error \[([^\]]+)\]: HTTP (\d{3}) reqN=(\d+)\. (.*)$/;

  test("carries the request's own reqN — exact join with `[resp] … reqN=K`", () => {
    const line = wallMarkerLine("GLM Coding", 429, 42, "Rate limited…");
    expect(line).toBe("Error [GLM Coding]: HTTP 429 reqN=42. Rate limited…");
    const m = WALL_RE.exec(line);
    expect(m).not.toBeNull();
    expect([m![1], m![2], m![3], m![4]]).toEqual([
      "GLM Coding",
      "429",
      "42",
      "Rate limited…",
    ]);
  });

  test("no `[claudish] ` prefix and no trailing newline — logStderr adds both", () => {
    expect(wallMarkerLine("X", 500, 1, "h")).toBe("Error [X]: HTTP 500 reqN=1. h");
  });

  test("a recovery hint with dots and spaces stays in the last field", () => {
    const m = WALL_RE.exec(
      wallMarkerLine("Kimi Coding", 429, 7, "Quota wall: plan exhausted. Reset 24/10 08:39Z.")
    );
    expect(m).not.toBeNull();
    expect(m![3]).toBe("7");
    expect(m![4]).toBe("Quota wall: plan exhausted. Reset 24/10 08:39Z.");
  });

  test("composed-handler emits it through the builder, with the request's own number", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../handlers/composed-handler.ts"),
      "utf8"
    );
    expect(src).toContain("wallMarkerLine(");
    // the number comes from the raw Request, never the global counter
    expect(src).toContain("requestNumberFor(c.req)");
    // the Context itself is unkeyed (no `.raw`) — a call on the bare Context
    // silently falls back to the global counter and mislabels the wall line
    // under concurrency (review #632); the guard regex matches only a CALL
    // (`c)` followed by an argument-list or statement terminator), so prose
    // in comments cannot trip it
    expect(src).not.toMatch(/requestNumberFor\(c\)(?=[,);])/);
    // the pre-#601 inline template must be gone (re-inlining = red)
    expect(src).not.toContain("]: HTTP ${response.status}. ${hint}");
  });

  test("a whole Hono Context is NOT keyed — c.req is the carrier (review #632)", () => {
    // logRequest keys the raw Request at ingestion; the wall line must resolve
    // through c.req (HonoRequest.raw). Passing the Context whole falls through
    // to the global counter — which equals the LATEST request's number, not
    // this one's. Two ingestions make the two values distinct.
    const map = new WeakMap<Request, string>();
    const req1 = new Request("http://x/v1/messages", { method: "POST", body: "{}" });
    const req2 = new Request("http://x/v1/messages", { method: "POST", body: "{}" });
    logRequest({}, "wall-pin", req1, map);
    logRequest({}, "wall-pin", req2, map);
    const n1 = requestNumberFor(req1);
    expect(n1).toBeGreaterThan(0);
    const ctx1 = { req: { raw: req1 } }; // Hono Context shape (no `.raw` of its own)
    expect(requestNumberFor(ctx1)).toBe(requestNumberFor(req2)); // global, not req1's
    expect(requestNumberFor(ctx1.req)).toBe(n1); // c.req resolves to THIS request
  });
});
