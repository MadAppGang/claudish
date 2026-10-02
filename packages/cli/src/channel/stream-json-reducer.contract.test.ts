// packages/cli/src/channel/stream-json-reducer.contract.test.ts
/**
 * Black-box contract tests for the claudish state model (design §3.2; §8.1 tests 1, 3, 5).
 * Written from the specification only.
 *
 * Documented surface: `TurnEnd = "stdin-open" | "stdin-closed"`, the required
 * `onResult: (summary) => TurnEnd`, `awaitInput()`, `beginTurn()`. Everything else about
 * driving the reducer (constructor option for state changes, the line-ingest method, the state
 * getter, `settle`, where refused transitions are recorded) is INFERRED and lives in
 * test-helpers/contract-adapters.ts.
 *
 * Frames are the public Claude Code stream-json shapes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { disposeReducerProbes, makeReducerProbe } from "../test-helpers/contract-adapters.js";
import type { TurnEnd } from "./stream-json-reducer.js";

afterEach(() => disposeReducerProbes());

const CHILD = "7d1c0b6a-2222-4333-8444-555566667777";

const init = {
  type: "system",
  subtype: "init",
  session_id: CHILD,
  model: "contract-fake",
  tools: [],
};
const assistantText = (n: number) => ({
  type: "assistant",
  message: {
    id: `msg_${n}`,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: `reply ${n}` }],
    stop_reason: "end_turn",
  },
  session_id: CHILD,
});
const assistantToolUse = (n: number) => ({
  type: "assistant",
  message: {
    id: `msg_tool_${n}`,
    type: "message",
    role: "assistant",
    content: [{ type: "tool_use", id: `toolu_${n}`, name: "Read", input: {} }],
    stop_reason: "tool_use",
  },
  session_id: CHILD,
});
const userToolResult = (n: number) => ({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: `toolu_${n}`, content: "ok" }],
  },
  session_id: CHILD,
});
const result = (turns: number) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: turns,
  result: "done",
  session_id: CHILD,
  total_cost_usd: 0,
  duration_ms: 1,
  usage: { input_tokens: 1, output_tokens: 1 },
});

describe("REQ-10 TurnEnd is exactly the two documented values", () => {
  test("both literals are assignable to TurnEnd", () => {
    const values: TurnEnd[] = ["stdin-open", "stdin-closed"];

    expect(values).toEqual(["stdin-open", "stdin-closed"]);
  });
});

describe("REQ-9/REQ-10 the owner's TurnEnd decides the state after a result frame", () => {
  test("stdin-closed: a one-shot turn goes running → finishing and never names waiting_for_input", () => {
    const probe = makeReducerProbe("stdin-closed");

    probe.feed(init);
    probe.feed(assistantText(1));
    probe.feed(result(1));

    expect(probe.snapshots).toEqual(["starting", "running", "running", "finishing"]);
    expect(probe.mentioned.has("waiting_for_input")).toBe(false);
  });

  test("stdin-open: an interactive turn goes running → waiting_for_input, not finishing", () => {
    const probe = makeReducerProbe("stdin-open");

    probe.feed(init);
    probe.feed(assistantText(1));
    probe.feed(result(1));

    expect(probe.state()).toBe("waiting_for_input");
    expect(probe.mentioned.has("finishing")).toBe(false);
  });

  test("onResult runs before the transition: during the call the state is still running", () => {
    const probe = makeReducerProbe("stdin-closed");

    probe.feed(init);
    probe.feed(assistantText(1));
    probe.feed(result(1));

    expect(probe.stateAtOnResult).toEqual(["running"]);
  });

  test("starting → finishing is legal: a result before any init frame", () => {
    const probe = makeReducerProbe("stdin-closed");

    probe.feed(result(1));

    expect(probe.state()).toBe("finishing");
  });

  test("tool_executing → finishing is legal: a result while a tool is executing", () => {
    const probe = makeReducerProbe("stdin-closed");
    probe.feed(init);
    probe.feed(assistantToolUse(1));
    expect(probe.state()).toBe("tool_executing");

    probe.feed(result(1));

    expect(probe.state()).toBe("finishing");
  });
});

describe("REQ-12/REQ-13 finishing accepts only terminal successors", () => {
  function finishingProbe() {
    const probe = makeReducerProbe("stdin-closed");
    probe.feed(init);
    probe.feed(assistantText(1));
    probe.feed(result(1));
    expect(probe.state()).toBe("finishing");
    return probe;
  }

  test.each([
    ["an assistant text frame", assistantText(2)],
    ["a user tool_result frame", userToolResult(2)],
    ["an assistant tool_use frame", assistantToolUse(2)],
  ])(
    "%s after the final result is refused: the state stays finishing and an anomaly is recorded",
    (_label, frame) => {
      const probe = finishingProbe();
      const anomaliesBefore = probe.anomalyCount();

      probe.feed(frame);

      expect(probe.state()).toBe("finishing");
      expect(probe.anomalyCount()).toBeGreaterThan(anomaliesBefore);
    }
  );

  test("a system:init frame in finishing does not move the state", () => {
    const probe = finishingProbe();

    probe.feed(init);

    expect(probe.state()).toBe("finishing");
  });

  test.each(["completed", "failed", "timeout", "cancelled"])(
    "finishing → %s is legal",
    (terminal) => {
      const probe = finishingProbe();

      probe.settle(terminal);

      expect(probe.state()).toBe(terminal);
    }
  );
});

describe("REQ-11 a promptless session waits from creation (awaitInput, init, beginTurn)", () => {
  test("awaitInput moves starting → waiting_for_input", () => {
    const probe = makeReducerProbe("stdin-open");

    probe.awaitInput();

    expect(probe.state()).toBe("waiting_for_input");
  });

  test("a system:init frame while waiting_for_input records the child but does not transition", () => {
    const probe = makeReducerProbe("stdin-open");
    probe.awaitInput();
    const callsBefore = probe.stateChangeCalls();

    probe.feed(init);

    expect(probe.state()).toBe("waiting_for_input");
    expect(probe.stateChangeCalls()).toBe(callsBefore);
  });

  test("beginTurn moves waiting_for_input → running", () => {
    const probe = makeReducerProbe("stdin-open");
    probe.awaitInput();
    probe.feed(init);

    probe.beginTurn();

    expect(probe.state()).toBe("running");
  });

  test("a full interactive cycle: wait, turn, wait again, turn again", () => {
    const probe = makeReducerProbe("stdin-open");

    probe.awaitInput();
    probe.feed(init);
    probe.beginTurn();
    probe.feed(assistantText(1));
    probe.feed(result(1));
    probe.beginTurn();

    expect(probe.snapshots).toEqual([
      "starting",
      "waiting_for_input",
      "waiting_for_input",
      "running",
      "running",
      "waiting_for_input",
      "running",
    ]);
  });

  test("init from starting still moves to running (behaviour unchanged for everyone else)", () => {
    const probe = makeReducerProbe("stdin-closed");

    probe.feed(init);

    expect(probe.state()).toBe("running");
  });

  test("beginTurn while running transitions nothing", () => {
    const probe = makeReducerProbe("stdin-closed");
    probe.feed(init);
    const callsBefore = probe.stateChangeCalls();

    probe.beginTurn();

    expect(probe.state()).toBe("running");
    expect(probe.stateChangeCalls()).toBe(callsBefore);
  });
});
