/**
 * #651 — the learned context cap must survive a recreate.
 *
 * Measured 2026-10-24: the hub learned 229 645 for the vllm lane after the real
 * wall at 07:20:58Z; the recreate forgot it, and the band between the engine's
 * limit (262 144) and the reported floor (280 000) stayed open until the next
 * refusal — which never came in the right shape (zero `learned` lines in 18 821
 * log lines after Gate 5b, while a `400 "Input too large"` fired 52 min in).
 *
 * These pins hold the store's contract: opt-in by path (the container's config
 * bind is READ-ONLY, so the path must never default into it), atomic replace,
 * and — the part that matters at startup — a missing, corrupt or foreign file
 * restores nothing rather than guessing. A wrong cap refuses requests that
 * would have been served, so tolerance here is a correctness property.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  overflowCapsPath,
  readOverflowCapsFile,
  writeOverflowCapsFile,
  type OverflowCapRecord,
} from "./overflow-caps-store.js";
import {
  getOverflowCap,
  initOverflowCapsPersistence,
  rememberOverflowCap,
  resetOverflowCapsForTests,
  disarmOverflowCapsPersistence,
  forgetOverflowCapsForProvider,
  overflowCapsMaxAgeMs,
} from "./context-overflow.js";

let dir: string;
const capsFile = () => join(dir, "overflow-caps.json");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-caps-"));
  resetOverflowCapsForTests();
});
afterEach(() => {
  resetOverflowCapsForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("overflowCapsPath — opt-in only", () => {
  test('unset, empty and whitespace all mean OFF (compose injects "")', () => {
    expect(overflowCapsPath({} as any)).toBeUndefined();
    expect(overflowCapsPath({ CLAUDISH_OVERFLOW_CAPS_PATH: "" } as any)).toBeUndefined();
    expect(overflowCapsPath({ CLAUDISH_OVERFLOW_CAPS_PATH: "   " } as any)).toBeUndefined();
  });

  test("an explicit path wins, trimmed", () => {
    expect(overflowCapsPath({ CLAUDISH_OVERFLOW_CAPS_PATH: " /var/cache/claudish/overflow-caps.json " } as any)).toBe(
      "/var/cache/claudish/overflow-caps.json"
    );
  });
});

describe("file store", () => {
  test("round-trips cap, timestamp and evidence", () => {
    const records = new Map<string, OverflowCapRecord>([
      ["Vllm-myia::swift-1.5-27b", { cap: 229645, at: "2026-10-24T07:21:04.000Z", evidence: "HTTP 400 input_tokens=262145" }],
    ]);
    expect(writeOverflowCapsFile(capsFile(), records)).toBe(true);

    const onDisk = JSON.parse(readFileSync(capsFile(), "utf-8"));
    expect(onDisk.version).toBe(1);
    expect(onDisk.caps["Vllm-myia::swift-1.5-27b"].cap).toBe(229645);

    const read = readOverflowCapsFile(capsFile());
    expect(read.size).toBe(1);
    expect(read.get("Vllm-myia::swift-1.5-27b")).toEqual({
      cap: 229645,
      at: "2026-10-24T07:21:04.000Z",
      evidence: "HTTP 400 input_tokens=262145",
    });
  });

  test("a missing file is an empty map, not a throw", () => {
    expect(readOverflowCapsFile(join(dir, "nope.json")).size).toBe(0);
  });

  test("corrupt JSON and a foreign version restore NOTHING", () => {
    writeFileSync(capsFile(), "{ this is not json");
    expect(readOverflowCapsFile(capsFile()).size).toBe(0);
    writeFileSync(capsFile(), JSON.stringify({ version: 2, caps: { "p::m": { cap: 5, at: "x" } } }));
    expect(readOverflowCapsFile(capsFile()).size).toBe(0);
  });

  test("entries that are not a plausible cap are dropped, the rest kept", () => {
    writeFileSync(
      capsFile(),
      JSON.stringify({
        version: 1,
        caps: {
          "p::good": { cap: 1234, at: "2026-10-24T00:00:00Z" },
          "p::zero": { cap: 0, at: "x" },
          "p::neg": { cap: -5, at: "x" },
          "p::nan": { cap: "1234", at: "x" },
          "p::junk": "not an object",
          badkey: { cap: 99, at: "x" }, // no `provider::model` separator
        },
      })
    );
    const read = readOverflowCapsFile(capsFile());
    expect([...read.keys()]).toEqual(["p::good"]);
    expect(read.get("p::good")!.cap).toBe(1234);
  });

  test("a write that cannot succeed returns false and never throws", () => {
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "file");
    expect(writeOverflowCapsFile(join(blocker, "caps.json"), new Map())).toBe(false);
  });

  test("the file is replaced atomically (no .tmp left behind)", () => {
    writeOverflowCapsFile(capsFile(), new Map([["p::m", { cap: 10, at: "a" }]]));
    expect(existsSync(capsFile() + ".tmp")).toBe(false);
    mkdirSync(dir, { recursive: true });
    expect(existsSync(capsFile())).toBe(true);
  });
});

describe("context-overflow integration (restore + write-through)", () => {
  test("with no path armed, nothing is written — today's behaviour exactly", () => {
    initOverflowCapsPersistence(undefined);
    rememberOverflowCap("GLM Coding", "gc@glm-5.3", 210_000);
    expect(getOverflowCap("GLM Coding", "gc@glm-5.3")).toBe(210_000);
    expect(existsSync(capsFile())).toBe(false);
  });

  test("init restores what a previous process learned, keyed as the in-memory map is", () => {
    writeFileSync(
      capsFile(),
      JSON.stringify({ version: 1, caps: { "Vllm-myia::swift-1.5-27b": { cap: 229645, at: new Date().toISOString() } } })
    );
    const armed = initOverflowCapsPersistence(capsFile());
    expect(armed.loaded).toBe(1);
    expect(getOverflowCap("Vllm-myia", "swift-1.5-27b")).toBe(229645);
  });

  test("a new observation writes through with its evidence, preserving older entries", () => {
    writeFileSync(
      capsFile(),
      JSON.stringify({ version: 1, caps: { "old::model": { cap: 111, at: new Date().toISOString(), evidence: "keep me" } } })
    );
    initOverflowCapsPersistence(capsFile());
    rememberOverflowCap("Vllm-myia", "swift-1.5-27b", 229_645.7, "HTTP 400 input_tokens=262145");

    const onDisk = readOverflowCapsFile(capsFile());
    expect(onDisk.get("old::model")).toMatchObject({ cap: 111, evidence: "keep me" });
    const fresh = onDisk.get("Vllm-myia::swift-1.5-27b")!;
    expect(fresh.cap).toBe(229_645); // floored, never fractional
    expect(fresh.evidence).toBe("HTTP 400 input_tokens=262145");
    expect(fresh.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("disarm stops write-through; reset forgets memory, records and the armed path", () => {
    initOverflowCapsPersistence(capsFile());
    disarmOverflowCapsPersistence();
    rememberOverflowCap("p", "m", 5);
    expect(existsSync(capsFile())).toBe(false);

    resetOverflowCapsForTests();
    expect(getOverflowCap("p", "m")).toBeUndefined();
  });

  test("a cap restored from disk short-circuits like a freshly learned one (the #651 purpose)", () => {
    // The state after a recreate, before this change: memory empty, cap lost.
    writeFileSync(
      capsFile(),
      JSON.stringify({ version: 1, caps: { "Vllm-myia::model": { cap: 229645, at: new Date().toISOString() } } })
    );
    expect(getOverflowCap("Vllm-myia", "model")).toBeUndefined();
    initOverflowCapsPersistence(capsFile());
    expect(getOverflowCap("Vllm-myia", "model")).toBe(229645);
  });
});

describe("expiry (#660 r1) — a restored cap is bounded by its own stamp", () => {
  const HOUR = 3_600_000;
  // Ages with wide margins on both sides of the 24 h default: no clock
  // injection needed, and a slow test runner cannot flip either pin.
  const iso = (ageMs: number) => new Date(Date.now() - ageMs).toISOString();

  test("older than the TTL is NOT restored; younger IS — and both are counted", () => {
    writeFileSync(
      capsFile(),
      JSON.stringify({
        version: 1,
        caps: {
          "p::stale": { cap: 120_000, at: iso(30 * 24 * HOUR) },
          "p::fresh": { cap: 90_000, at: iso(HOUR) },
        },
      })
    );
    const armed = initOverflowCapsPersistence(capsFile());
    expect(armed.loaded).toBe(1);
    expect(armed.expired).toBe(1);
    expect(getOverflowCap("p", "stale")).toBeUndefined();
    expect(getOverflowCap("p", "fresh")).toBe(90_000);
  });

  test("a stamp that cannot be parsed is not restored — its age cannot be bounded", () => {
    writeFileSync(capsFile(), JSON.stringify({ version: 1, caps: { "p::m": { cap: 120_000, at: "t" } } }));
    const armed = initOverflowCapsPersistence(capsFile());
    expect(armed.loaded).toBe(0);
    expect(armed.expired).toBe(1);
    expect(getOverflowCap("p", "m")).toBeUndefined();
  });

  test("CLAUDISH_OVERFLOW_CAPS_MAX_AGE_MS=0 means no expiry — the 30-day record comes back", () => {
    writeFileSync(
      capsFile(),
      JSON.stringify({ version: 1, caps: { "p::stale": { cap: 120_000, at: iso(30 * 24 * HOUR) } } })
    );
    const armed = initOverflowCapsPersistence(capsFile(), {
      env: { CLAUDISH_OVERFLOW_CAPS_MAX_AGE_MS: "0" } as any,
    });
    expect(armed.loaded).toBe(1);
    expect(armed.expired).toBe(0);
    expect(getOverflowCap("p", "stale")).toBe(120_000);
  });

  test("unparsable or negative values fall back to the default, never to 'off'", () => {
    expect(overflowCapsMaxAgeMs({} as any)).toBe(24 * HOUR);
    expect(overflowCapsMaxAgeMs({ CLAUDISH_OVERFLOW_CAPS_MAX_AGE_MS: "garbage" } as any)).toBe(24 * HOUR);
    expect(overflowCapsMaxAgeMs({ CLAUDISH_OVERFLOW_CAPS_MAX_AGE_MS: "-5" } as any)).toBe(24 * HOUR);
    expect(overflowCapsMaxAgeMs({ CLAUDISH_OVERFLOW_CAPS_MAX_AGE_MS: "3600000" } as any)).toBe(HOUR);
    expect(overflowCapsMaxAgeMs({ CLAUDISH_OVERFLOW_CAPS_MAX_AGE_MS: "0" } as any)).toBe(0);
  });
});

describe("derivation outranks a restored cap (#660 r1)", () => {
  const HOUR = 3_600_000;
  const iso = (ageMs: number) => new Date(Date.now() - ageMs).toISOString();

  test("forgetOverflowCapsForProvider drops only that provider and rewrites the file", () => {
    writeFileSync(
      capsFile(),
      JSON.stringify({
        version: 1,
        caps: {
          "Vllm-myia::swift-1.5-27b": { cap: 229_645, at: iso(HOUR) },
          "Vllm-myia::other-model": { cap: 111_111, at: iso(HOUR) },
          "GLM Coding::glm-5.3": { cap: 210_000, at: iso(HOUR) },
        },
      })
    );
    initOverflowCapsPersistence(capsFile());

    expect(forgetOverflowCapsForProvider("Vllm-myia")).toBe(2);
    expect(getOverflowCap("Vllm-myia", "swift-1.5-27b")).toBeUndefined();
    expect(getOverflowCap("Vllm-myia", "other-model")).toBeUndefined();
    expect(getOverflowCap("GLM Coding", "glm-5.3")).toBe(210_000);

    const onDisk = readOverflowCapsFile(capsFile());
    expect([...onDisk.keys()]).toEqual(["GLM Coding::glm-5.3"]);
  });

  test("with no store armed the purge is memory-only and never throws", () => {
    initOverflowCapsPersistence(undefined);
    rememberOverflowCap("p", "m", 5);
    expect(forgetOverflowCapsForProvider("p")).toBe(1);
    expect(getOverflowCap("p", "m")).toBeUndefined();
  });

  test("purging a provider nothing was learned for is a no-op, not an error", () => {
    expect(forgetOverflowCapsForProvider("nobody")).toBe(0);
  });
});
