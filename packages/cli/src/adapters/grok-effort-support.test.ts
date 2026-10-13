/**
 * xAI reasoning_effort support facts measured live against api.x.ai on
 * 2026-08-15, plus the optimistic-send recovery path that learns future model
 * capabilities without a stale allowlist.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptsReasoningEffort,
  acceptsReasoningEffortValue,
  fallbackReasoningEffortValue,
  isReasoningEffortRejection,
  learnedReasoningEffortRejects,
  rejectedReasoningEffortValue,
  rememberReasoningEffortRejected,
  resetReasoningEffortMemo,
} from "./grok-effort-support.js";
import { GrokModelDialect } from "./grok-model-dialect.js";

const PARAM_REJECTION = "Model grok-9-experimental does not support parameter reasoningEffort.";
const MULTI_AGENT_REJECTION = "Multi Agent requests are not allowed on chat completions";
const NONE_VALUE_REJECTION = "This model does not support reasoning_effort value none.";

function grokEffort(modelId: string, effort: string): string | undefined {
  const dialect = new GrokModelDialect(modelId);
  return dialect.prepareRequest({}, { output_config: { effort } }).reasoning_effort;
}

beforeEach(() => {
  resetReasoningEffortMemo();
});

afterEach(() => {
  resetReasoningEffortMemo();
});

describe("live xAI reasoning_effort support", () => {
  test.each(["grok-4.5", "grok-4.6"])("%s receives low, medium, and high effort", (modelId) => {
    for (const effort of ["low", "medium", "high"] as const) {
      expect(grokEffort(modelId, effort)).toBe(effort);
    }
  });

  test("normalises the x-ai/ vendor prefix", () => {
    expect(grokEffort("x-ai/grok-4.6", "high")).toBe("high");
    rememberReasoningEffortRejected("grok-build-0.1");
    expect(grokEffort("x-ai/grok-build-0.1", "high")).toBeUndefined();
  });

  test.each(["grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning", "grok-build-0.1"])(
    "%s strips reasoning_effort after its live parameter rejection",
    (modelId) => {
      // The cloud models catalog may already reject effort for these ids.
      // Only the post-rejection verdict is independent of the local cache.
      rememberReasoningEffortRejected(modelId);
      expect(learnedReasoningEffortRejects()).toContain(modelId);
      expect(grokEffort(modelId, "high")).toBeUndefined();
    }
  );

  test("grok-4.3 accepts the none value", () => {
    expect(grokEffort("grok-4.3", "none")).toBe("none");
    expect(acceptsReasoningEffortValue("grok-4.3", "none")).toBe(true);
  });
});

describe("learned support memo", () => {
  test("changes an optimistic model from accepted to rejected", () => {
    expect(acceptsReasoningEffort("grok-9-experimental")).toBe(true);

    rememberReasoningEffortRejected("grok-9-experimental");

    expect(acceptsReasoningEffort("grok-9-experimental")).toBe(false);
    expect(learnedReasoningEffortRejects()).toEqual(["grok-9-experimental"]);
  });

  test("normalises vendor-prefixed learned rejections", () => {
    rememberReasoningEffortRejected("x-ai/grok-9-experimental");

    expect(acceptsReasoningEffort("grok-9-experimental")).toBe(false);
    expect(learnedReasoningEffortRejects()).toEqual(["grok-9-experimental"]);
  });
});

describe("xAI rejection parsing", () => {
  test("matches the real parameter rejection but not the multi-agent endpoint rejection", () => {
    expect(isReasoningEffortRejection(PARAM_REJECTION)).toBe(true);
    expect(isReasoningEffortRejection(MULTI_AGENT_REJECTION)).toBe(false);
  });

  test("extracts none from the real value rejection", () => {
    expect(rejectedReasoningEffortValue(NONE_VALUE_REJECTION)).toBe("none");
    expect(rejectedReasoningEffortValue(MULTI_AGENT_REJECTION)).toBeNull();
  });

  test("fallbacks move down the supported ladder and terminate", () => {
    const rank: Record<string, number> = { low: 0, medium: 1, high: 2 };

    for (const start of ["low", "medium", "high"] as const) {
      let current: string | null = start;
      let steps = 0;

      while (current !== null) {
        const next = fallbackReasoningEffortValue(current);
        if (next !== null) {
          expect(rank[next]).toBeLessThan(rank[current]);
        }
        current = next;
        steps += 1;
        expect(steps).toBeLessThanOrEqual(3);
      }
    }

    // `none` is an unsupported sentinel on 4.5/4.6, so use the least
    // reasoning-capable value and stop if that is also rejected.
    expect(fallbackReasoningEffortValue("none")).toBe("low");
    expect(fallbackReasoningEffortValue("low")).toBeNull();
  });
});

describe("GrokModelDialect.recoverFromRejection", () => {
  test("returns null when the payload has no reasoning_effort", () => {
    const dialect = new GrokModelDialect("grok-9-experimental");

    expect(dialect.recoverFromRejection({ messages: [] }, PARAM_REJECTION)).toBeNull();
    expect(acceptsReasoningEffort("grok-9-experimental")).toBe(true);
  });

  test("drops reasoning_effort after a parameter rejection", () => {
    const dialect = new GrokModelDialect("grok-9-experimental");
    const payload = { messages: [], reasoning_effort: "high" };

    const recovery = dialect.recoverFromRejection(payload, PARAM_REJECTION);

    expect(recovery).toEqual({
      payload: { messages: [] },
      note: "dropped reasoning_effort for grok-9-experimental",
    });
    expect(recovery?.payload).not.toBe(payload);
    expect(payload.reasoning_effort).toBe("high");
    expect(acceptsReasoningEffort("grok-9-experimental")).toBe(false);
  });

  test.each(["grok-4.5", "grok-4.6"])(
    "%s steps a rejected none value to low and remembers the value rejection",
    (modelId) => {
      const dialect = new GrokModelDialect(modelId);
      const payload = { messages: [], reasoning_effort: "none" };

      const recovery = dialect.recoverFromRejection(payload, NONE_VALUE_REJECTION);

      expect(recovery).toEqual({
        payload: { messages: [], reasoning_effort: "low" },
        note: `reasoning_effort "none" -> "low" for ${modelId}`,
      });
      expect(payload.reasoning_effort).toBe("none");
      expect(acceptsReasoningEffortValue(modelId, "none")).toBe(false);
      expect(grokEffort(modelId, "none")).toBe("low");
    }
  );
});

test("cold grok-2-unknown accepts effort until a learned 400", () => {
  // The exported support API has no cache-path seam. A fresh child import and
  // empty home prove this is cold, independently of the caller's catalog.
  const dir = mkdtempSync(join(tmpdir(), "grok-cold-"));
  try {
    const script = `
      const { acceptsReasoningEffort } = await import(${JSON.stringify(new URL("./grok-effort-support.ts", import.meta.url).pathname)});
      const { GrokModelDialect } = await import(${JSON.stringify(new URL("./grok-model-dialect.ts", import.meta.url).pathname)});
      const id = "grok-2-unknown";
      const before = acceptsReasoningEffort(id);
      const recovery = new GrokModelDialect(id).recoverFromRejection(
        {reasoning_effort: "high"},
        "Model grok-2-unknown does not support parameter reasoningEffort."
      );
      console.log(JSON.stringify({before, after: acceptsReasoningEffort(id), payload: recovery?.payload}));
    `;
    const child = Bun.spawnSync([process.execPath, "--eval", script], {
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        CLAUDISH_DISABLE_KEYCHAIN: "1",
        CLAUDISH_DISABLE_OP: "1",
        CLAUDISH_DISABLE_CATALOG_WARM: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual({
      before: true,
      after: false,
      payload: {},
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
