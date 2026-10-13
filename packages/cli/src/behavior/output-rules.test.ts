import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as journal from "../hooks/journal.js";
import * as logger from "../logger.js";
import type { BehaviorEngine } from "./engine.js";
import { createBehaviorEngine } from "./index.js";
import type { BehaviorRule, ModelOutputContext, Severity } from "./types.js";

const SESSION_A = "ce7d9e68-f907-444f-9680-69ec3048ce9c";
const SESSION_B = "62e11a50-15c1-4863-b880-0a518425db74";

function makeRule(
  id: string,
  onModelOutput?: NonNullable<BehaviorRule["onModelOutput"]>,
  defaultSeverity: Severity = "fix"
): BehaviorRule {
  return {
    id,
    description: id,
    defaultSeverity,
    appliesTo: () => true,
    onModelOutput,
  };
}

function requestFor(sessionId: string, system = "base system") {
  const userId = JSON.stringify({
    device_id: "abc123",
    account_uuid: "",
    session_id: sessionId,
  });
  return JSON.parse(
    `{"system":${JSON.stringify(system)},"messages":[],"metadata":{"user_id":${JSON.stringify(userId)}}}`
  );
}

function startSession(engine: BehaviorEngine) {
  return engine.startSession({
    modelId: "gpt-5.6-sol",
    providerName: "openai-codex",
    isNativeAnthropic: false,
  });
}

function applyRequest(engine: BehaviorEngine, request: ReturnType<typeof requestFor>) {
  const session = startSession(engine);
  session.applyRequest(request, [], [], []);
  return session;
}

let journalSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  // Output decisions are journalled fire-and-forget. Keep this suite entirely
  // inside the test process instead of touching the user's real journal.
  journalSpy = spyOn(journal, "recordDecision").mockResolvedValue(undefined);
});

afterEach(() => {
  journalSpy.mockRestore();
});

describe("behavior output rules", () => {
  it("passes accumulated text, reasoning, and tool names in stream order", () => {
    let observed: ModelOutputContext | undefined;
    const rule = makeRule("test/output-context", (ctx) => {
      observed = ctx;
      return [];
    });
    const engine = createBehaviorEngine({}, [rule]);
    const session = applyRequest(engine, requestFor(SESSION_A));

    session.observeText("first ");
    session.observeText("thought one; ", "reasoning");
    session.observeToolCall("Write");
    session.observeText("second");
    session.observeText("thought two", "reasoning");
    session.observeToolCall("Edit");
    session.finishTurn();

    expect(observed?.text).toBe("first second");
    expect(observed?.reasoning).toBe("thought one; thought two");
    expect(observed?.toolsCalled).toEqual(["Write", "Edit"]);
  });

  it("logs a warn action without mutating the current or next request", () => {
    const logSpy = spyOn(logger, "log").mockImplementation(() => {});
    try {
      const rule = makeRule("test/output-warn", () => [
        { type: "warn", message: "model took a shortcut" },
      ]);
      const engine = createBehaviorEngine({}, [rule]);
      const current = requestFor(SESSION_A);
      const session = applyRequest(engine, current);

      session.observeText("unverified claim");
      session.finishTurn();
      const next = requestFor(SESSION_A);
      applyRequest(engine, next);

      expect(current.system).toBe("base system");
      expect(next.system).toBe("base system");
      expect(logSpy).toHaveBeenCalledWith(
        "[behavior] test/output-warn (output): model took a shortcut"
      );
      expect(journalSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("injects an output correction on the next request for the same session", () => {
    const correction = "Run the verification before claiming completion.";
    const rule = makeRule("test/cross-turn-correction", () => [
      { type: "injectSystemNote", text: correction },
    ]);
    const engine = createBehaviorEngine({}, [rule]);
    const current = requestFor(SESSION_A, "turn one system");
    const session = applyRequest(engine, current);

    session.observeText("This should work.");
    session.finishTurn();

    expect(current.system).toBe("turn one system");
    const next = requestFor(SESSION_A, "turn two system");
    applyRequest(engine, next);
    expect(next.system).toBe(`turn two system\n\n${correction}`);
  });

  it("does not leak a correction to a different session id", () => {
    const correction = "Session A correction";
    const rule = makeRule("test/session-isolation", () => [
      { type: "injectSystemNote", text: correction },
    ]);
    const engine = createBehaviorEngine({}, [rule]);
    const session = applyRequest(engine, requestFor(SESSION_A));
    session.finishTurn();

    const other = requestFor(SESSION_B);
    applyRequest(engine, other);

    expect(other.system).toBe("base system");
  });

  it("drains a correction after applying it once", () => {
    const correction = "One-shot correction";
    const rule = makeRule("test/drained-correction", () => [
      { type: "injectSystemNote", text: correction },
    ]);
    const engine = createBehaviorEngine({}, [rule]);
    applyRequest(engine, requestFor(SESSION_A)).finishTurn();

    const next = requestFor(SESSION_A);
    applyRequest(engine, next);
    const later = requestFor(SESSION_A);
    applyRequest(engine, later);

    expect(next.system).toBe(`base system\n\n${correction}`);
    expect(later.system).toBe("base system");
  });

  it("does not queue an output correction at warn severity", () => {
    const rule = makeRule("test/warn-correction", () => [
      { type: "injectSystemNote", text: "withheld correction" },
    ]);
    const engine = createBehaviorEngine({ rules: { "test/warn-correction": "warn" } }, [rule]);
    applyRequest(engine, requestFor(SESSION_A)).finishTurn();

    const next = requestFor(SESSION_A);
    applyRequest(engine, next);

    expect(next.system).toBe("base system");
  });

  it("does no output accumulation work when no output rule is active", () => {
    // The built-in plan rule is active for this foreign model, but it has no
    // onModelOutput hook. That distinction is what should disable accumulation.
    const engine = createBehaviorEngine({}, []);
    const session = startSession(engine);

    expect(session.isNoop).toBe(false);
    expect(() => {
      session.observeText("x".repeat(2 * 1024 * 1024));
      session.finishTurn();
    }).not.toThrow();
  });

  it("isolates an output-rule exception and still runs later rules", () => {
    let healthyRuns = 0;
    const broken = makeRule("test/broken-output", () => {
      throw new Error("output rule exploded");
    });
    const healthy = makeRule("test/healthy-output", () => {
      healthyRuns++;
      return [];
    });
    const engine = createBehaviorEngine({}, [broken, healthy]);
    const request = requestFor(SESSION_A);
    const session = applyRequest(engine, request);

    expect(() => session.finishTurn()).not.toThrow();
    expect(healthyRuns).toBe(1);
    expect(request.system).toBe("base system");
  });

  it("bounds accumulated text at 64 KB even when the stream emits far more", () => {
    let observedLength = -1;
    const rule = makeRule("test/output-cap", (ctx) => {
      observedLength = ctx.text.length;
      return [];
    });
    const engine = createBehaviorEngine({}, [rule]);
    const session = applyRequest(engine, requestFor(SESSION_A));
    const chunk = "x".repeat(8 * 1024);

    expect(() => {
      for (let i = 0; i < 256; i++) session.observeText(chunk);
      session.finishTurn();
    }).not.toThrow();
    expect(observedLength).toBe(64 * 1024);
  });
});
