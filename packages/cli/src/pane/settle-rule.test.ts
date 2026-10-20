import { afterEach, describe, expect, test } from "bun:test";
import {
  CORROBORATION_GRACE_MS,
  type CorroborationFacts,
  SECONDARY_QUIET_MS,
  type SettleInput,
  agentCountMismatch,
  decideSettle,
} from "./settle-rule.js";
import {
  type Rec,
  indexOf,
  replay,
  textOf,
  transcriptRecords,
  witnessIndex,
} from "./test-helpers/transcript-fixtures.js";
import type { TranscriptView, Witness } from "./transcript-follower.js";

/** Turn views come from real transcripts replayed through the follower; only the corroboration facts are set by hand. */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const text = (t: string): Witness => ({ kind: "text", text: t });

function viewOf(
  name: string,
  witnessText: string,
  opts: { upTo?: number; nth?: number; earlier?: string[] } = {}
): TranscriptView {
  const turns = [...(opts.earlier ?? []), witnessText].map((w) => ({
    at: witnessIndex(name, w),
    witness: text(w),
  }));
  const r = replay(name, turns, { upTo: opts.upTo });
  cleanups.push(r.cleanup);
  return r.views[r.views.length - 1]!;
}

const IDLE: CorroborationFacts = {
  gate: { ready: true, dialog: null, reason: null },
  working: false,
  aboveBoxQuietMs: 0,
};

const UNCONFIRMED: Array<{ name: string; facts: CorroborationFacts; why: string }> = [
  {
    name: "typed text",
    facts: { ...IDLE, gate: { ready: false, dialog: null, reason: "box_not_empty" } },
    why: "box_not_empty",
  },
  {
    name: "a dialog",
    facts: {
      ...IDLE,
      gate: { ready: false, dialog: "permission", reason: "dialog:permission" },
    },
    why: "dialog:permission",
  },
  {
    name: "a working row",
    facts: { ...IDLE, working: true },
    why: "working",
  },
  {
    name: "a not-ready gate",
    facts: { ...IDLE, gate: { ready: false, dialog: null, reason: "starting" } },
    why: "starting",
  },
  {
    name: "a not-ready gate without a reason",
    facts: { ...IDLE, gate: { ready: false, dialog: null, reason: null } },
    why: "not_ready",
  },
  {
    name: "an unknown or stale connected gate",
    facts: { ...IDLE, gate: null },
    why: "gate_unknown",
  },
];

function input(v: TranscriptView, over: Partial<SettleInput> = {}): SettleInput {
  return {
    turn: v.current,
    session: v.session,
    transcriptQuietMs: 1000,
    chatQuietMs: 1000,
    facts: IDLE,
    paneExited: false,
    ...over,
  };
}

const PEAR = "Reply with exactly PEAR and nothing else.";

describe("path P — turn_duration", () => {
  test("settles a hookless end_turn once a clean gate corroborates (U7)", () => {
    const v = viewOf("pear-hookless", PEAR);
    expect(decideSettle(input(v))).toEqual({
      settled: true,
      by: "turn_duration",
      stopReason: "end_turn",
      anomalies: [],
    });
  });

  // REGRESSION: one-shot session never settles when background-agent notifications arrive mid-turn as attachment/queued_command — Fixed in /dev:fix session dev-fix-20261016-224933-5e5cb5a4
  test("settles at the first turn_duration after mid-turn attachment notifications complete both agents", () => {
    const n = "corpus-redacted/background-agents-in-turn";
    const recs = transcriptRecords(n);
    const w = textOf(recs[0]!);
    expect(witnessIndex(n, w)).toBe(0);
    const td = indexOf(n, (r) => r.type === "system" && r.subtype === "turn_duration");
    expect(td).toBeGreaterThan(0);
    const v = viewOf(n, w, { upTo: td + 1 });
    expect(decideSettle(input(v))).toEqual({
      settled: true,
      by: "turn_duration",
      stopReason: "end_turn",
      anomalies: [],
    });
  });

  for (const { name, facts, why } of UNCONFIRMED) {
    test(`${name} delays P until the 32 s grace, then settles with ${why} (U7)`, () => {
      const v = viewOf("pear-hookless", PEAR);
      for (const chatQuietMs of [1000, CORROBORATION_GRACE_MS - 1]) {
        expect(decideSettle(input(v, { facts, chatQuietMs, transcriptQuietMs: 1e9 })).settled).toBe(
          false
        );
      }
      for (const chatQuietMs of [CORROBORATION_GRACE_MS, CORROBORATION_GRACE_MS + 1]) {
        expect(decideSettle(input(v, { facts, chatQuietMs }))).toEqual({
          settled: true,
          by: "turn_duration",
          stopReason: "end_turn",
          anomalies: [`settle_gate_unconfirmed:${why}`],
        });
      }
    });
  }

  test("waits for a chat record to be 500 ms old even after the gate grace", () => {
    const v = viewOf("pear-hookless", PEAR);
    expect(decideSettle(input(v, { chatQuietMs: 100 })).settled).toBe(false);
    expect(decideSettle(input(v, { chatQuietMs: 499, corroborationGraceMs: 0 })).settled).toBe(
      false
    );
    expect(decideSettle(input(v, { chatQuietMs: 500 }))).toEqual({
      settled: true,
      by: "turn_duration",
      stopReason: "end_turn",
      anomalies: [],
    });
  });

  test("working: null does not veto a clean gate (U7)", () => {
    const v = viewOf("pear-hookless", PEAR);
    expect(
      decideSettle(input(v, { facts: { ...IDLE, working: null, aboveBoxQuietMs: null } }))
    ).toEqual({
      settled: true,
      by: "turn_duration",
      stopReason: "end_turn",
      anomalies: [],
    });
  });

  test("the default corroboration grace is 32 s (U7)", () => {
    expect(CORROBORATION_GRACE_MS).toBe(32_000);
  });

  test("corroborationGraceMs overrides the default grace (U7)", () => {
    const v = viewOf("pear-hookless", PEAR);
    const over = { facts: { ...IDLE, gate: null }, corroborationGraceMs: 2000 };
    expect(decideSettle(input(v, { ...over, chatQuietMs: 1999 })).settled).toBe(false);
    expect(decideSettle(input(v, { ...over, chatQuietMs: 2000 }))).toEqual({
      settled: true,
      by: "turn_duration",
      stopReason: "end_turn",
      anomalies: ["settle_gate_unconfirmed:gate_unknown"],
    });
  });

  test("while disconnected it settles on the transcript alone with screen_unverified (X-M12)", () => {
    const v = viewOf("pear-hookless", PEAR);
    expect(decideSettle(input(v, { facts: null }))).toEqual({
      settled: true,
      by: "turn_duration",
      stopReason: "end_turn",
      anomalies: ["screen_unverified"],
    });
  });

  test("an API error settles through its turn_duration", () => {
    const v = viewOf("api-error-stop-hook", PEAR);
    expect(decideSettle(input(v))).toMatchObject({
      settled: true,
      by: "turn_duration",
      stopReason: "stop_sequence",
    });
  });

  test("a max_tokens turn settles only at its final API error, not at a continued max_tokens message", () => {
    const n = "max-tokens-hookless";
    const w = "Write a 400-word story about a pear, as plain text, no tools.";
    const meta = indexOf(n, (r) => r.type === "user" && r.isMeta === true, witnessIndex(n, w));
    const mid = viewOf(n, w, { upTo: meta + 1 });
    expect(
      decideSettle(input(mid, { transcriptQuietMs: 1e9, facts: { ...IDLE, aboveBoxQuietMs: 1e9 } }))
    ).toEqual({
      settled: false,
      activity: "thinking",
    });
    const end = viewOf(n, w);
    expect(decideSettle(input(end))).toMatchObject({
      settled: true,
      by: "turn_duration",
      stopReason: "stop_sequence",
    });
  });
});

describe("agentCountMismatch", () => {
  function completedView(): TranscriptView {
    const n = "corpus-redacted/background-agents-in-turn";
    const recs = transcriptRecords(n);
    const td = indexOf(n, (r) => r.type === "system" && r.subtype === "turn_duration");
    return viewOf(n, textOf(recs[0]!), { upTo: td + 1 });
  }

  // REGRESSION: one-shot session never settles when background-agent notifications arrive mid-turn as attachment/queued_command — Fixed in /dev:fix session dev-fix-20261016-224933-5e5cb5a4
  test("the fixed follower agrees with zero reported pending agents at the first turn_duration", () => {
    const v = completedView();
    expect([v.current!.agentsLaunched, v.current!.agentsCompleted]).toEqual([2, 2]);
    expect(v.current!.turnDurationAfterLast).toEqual({ pendingBackgroundAgentCount: null });
    expect(agentCountMismatch(v.current)).toBeNull();
  });

  // REGRESSION: one-shot session never settles when background-agent notifications arrive mid-turn as attachment/queued_command — Fixed in /dev:fix session dev-fix-20261016-224933-5e5cb5a4
  test("missed mid-turn completions report the counter mismatch without settling the turn", () => {
    const v = completedView();
    const turn = { ...v.current!, agentsCompleted: 0 };
    const before = structuredClone(turn);
    expect(agentCountMismatch(turn)).toEqual({ counted: 2, reported: 0 });
    expect(turn).toEqual(before);
    expect(
      decideSettle({
        ...input(v, {
          transcriptQuietMs: 1e9,
          facts: { ...IDLE, aboveBoxQuietMs: 1e9 },
        }),
        turn,
      })
    ).toEqual({ settled: false, activity: "background" });
  });

  // REGRESSION: one-shot session never settles when background-agent notifications arrive mid-turn as attachment/queued_command — Fixed in /dev:fix session dev-fix-20261016-224933-5e5cb5a4
  test("one counted background agent agrees with one reported at the Agent turn's first turn_duration", () => {
    const n = "tools-session";
    const w = transcriptRecords(n)
      .map(textOf)
      .find((s) => s.startsWith("Use the Agent tool with run_in_background"))!;
    const td = indexOf(n, (r) => r.subtype === "turn_duration", witnessIndex(n, w));
    const v = viewOf(n, w, { upTo: td + 1 });
    expect([v.current!.agentsLaunched, v.current!.agentsCompleted]).toEqual([1, 0]);
    expect(v.current!.turnDurationAfterLast).toEqual({ pendingBackgroundAgentCount: 1 });
    expect(agentCountMismatch(v.current)).toBeNull();
  });

  // REGRESSION: one-shot session never settles when background-agent notifications arrive mid-turn as attachment/queued_command — Fixed in /dev:fix session dev-fix-20261016-224933-5e5cb5a4
  test("a waking turn has no agent count mismatch even with stale end-of-turn counts", () => {
    const v = completedView();
    expect(
      agentCountMismatch({ ...v.current!, agentsCompleted: 0, wakingAfterLast: true })
    ).toBeNull();
  });

  // REGRESSION: one-shot session never settles when background-agent notifications arrive mid-turn as attachment/queued_command — Fixed in /dev:fix session dev-fix-20261016-224933-5e5cb5a4
  test("no turn_duration means no reported count to compare", () => {
    const v = completedView();
    expect(
      agentCountMismatch({ ...v.current!, agentsCompleted: 0, turnDurationAfterLast: null })
    ).toBeNull();
  });

  // REGRESSION: one-shot session never settles when background-agent notifications arrive mid-turn as attachment/queued_command — Fixed in /dev:fix session dev-fix-20261016-224933-5e5cb5a4
  test("a missing turn has no agent count mismatch", () => {
    expect(agentCountMismatch(null)).toBeNull();
  });
});

describe("Stop hooks hold the turn open (X-H2)", () => {
  const n = "stop-hook-matrix";
  const at = witnessIndex(n, PEAR);
  const summary = indexOf(n, (r) => r.subtype === "stop_hook_summary", at);

  test("a running Stop hook is 'finishing' and no quiet window, however long, settles it", () => {
    const v = viewOf(n, PEAR, { upTo: summary });
    const long = {
      transcriptQuietMs: 10 * SECONDARY_QUIET_MS,
      facts: { ...IDLE, aboveBoxQuietMs: 10 * SECONDARY_QUIET_MS },
    };
    expect(decideSettle(input(v, long))).toEqual({ settled: false, activity: "finishing" });
  });

  test("the corroboration grace never settles a turn whose Stop hooks are unfinished", () => {
    const v = viewOf(n, PEAR, { upTo: summary });
    expect(v.current!.turnDurationAfterLast).toBeNull();
    expect(v.current!.stopHookSummaryAfterLast).toBe(false);
    for (const facts of [IDLE, ...UNCONFIRMED.map((c) => c.facts), null]) {
      expect(
        decideSettle(
          input(v, {
            transcriptQuietMs: 1e9,
            chatQuietMs: 1e9,
            facts: facts === null ? null : { ...facts, aboveBoxQuietMs: 1e9 },
          })
        )
      ).toEqual({ settled: false, activity: "finishing" });
    }
  });

  test("once the summary is written, path S may settle after the secondary quiet window", () => {
    const v = viewOf(n, PEAR, { upTo: summary + 1 });
    expect(v.current!.turnDurationAfterLast).toBeNull();
    expect(v.current!.stopHookSummaryAfterLast).toBe(true);
    const short = {
      transcriptQuietMs: SECONDARY_QUIET_MS - 1,
      facts: { ...IDLE, aboveBoxQuietMs: SECONDARY_QUIET_MS },
    };
    expect(decideSettle(input(v, short)).settled).toBe(false);
    const ok = {
      transcriptQuietMs: SECONDARY_QUIET_MS,
      facts: { ...IDLE, aboveBoxQuietMs: SECONDARY_QUIET_MS },
    };
    expect(decideSettle(input(v, ok))).toEqual({
      settled: true,
      by: "quiet",
      stopReason: "end_turn",
      anomalies: ["settled_without_turn_duration"],
    });
    // S waits for the reconnect
    expect(decideSettle(input(v, { ...ok, facts: null })).settled).toBe(false);
  });

  test("path S uses transcriptQuietMs alone when aboveBoxQuietMs is null (U8)", () => {
    const v = viewOf(n, PEAR, { upTo: summary + 1 });
    expect(v.current!.turnDurationAfterLast).toBeNull();
    expect(v.current!.stopHookSummaryAfterLast).toBe(true);
    const facts = { ...IDLE, working: null, aboveBoxQuietMs: null };
    expect(
      decideSettle(input(v, { facts, transcriptQuietMs: SECONDARY_QUIET_MS - 1 })).settled
    ).toBe(false);
    expect(decideSettle(input(v, { facts, transcriptQuietMs: SECONDARY_QUIET_MS }))).toEqual({
      settled: true,
      by: "quiet",
      stopReason: "end_turn",
      anomalies: ["settled_without_turn_duration"],
    });
    expect(
      decideSettle(input(v, { facts: null, transcriptQuietMs: SECONDARY_QUIET_MS })).settled
    ).toBe(false);
  });

  test("the measured secondary window is 32 s", () => {
    expect(SECONDARY_QUIET_MS).toBe(32_000);
  });
});

describe("path S in a session proven hook-less", () => {
  test("turn 2 with no turn_duration settles after the quiet window because turn 1 proved there are no Stop hooks", () => {
    const n = "tools-session";
    const recs = transcriptRecords(n).map(textOf);
    const t1 = recs.find((s) => s.startsWith("Run this exact command"))!;
    const t2 = recs.find((s) => s.startsWith("First write, as plain text"))!;
    const td2 = indexOf(n, (r) => r.subtype === "turn_duration", witnessIndex(n, t2));
    const v = viewOf(n, t2, { earlier: [t1], upTo: td2 });
    expect(v.session.provenHookless).toBe(true);
    expect(v.current!.turnDurationAfterLast).toBeNull();
    const quiet = {
      transcriptQuietMs: SECONDARY_QUIET_MS,
      facts: { ...IDLE, aboveBoxQuietMs: SECONDARY_QUIET_MS },
    };
    expect(decideSettle(input(v, quiet))).toMatchObject({
      settled: true,
      by: "quiet",
      stopReason: "end_turn",
    });
  });
});

describe("path I — interrupts", () => {
  const n = "stop-hook-matrix";
  const all = transcriptRecords(n).map(textOf);
  const ws = [
    PEAR,
    "Write a 400-word story about a pear, as plain text, no tools.",
    "Run the command sleep 30 with the Bash tool, then reply DONE.",
    "Write a 700-word story about a plum, as plain text, no tools.",
  ];
  const views = () => {
    const r = replay(
      n,
      ws.map((w) => ({ at: all.findIndex((x) => x.trim() === w), witness: text(w) }))
    );
    cleanups.push(r.cleanup);
    return r.views;
  };

  test("Esc during a running Bash settles 'interrupted' with no turn_duration and no Stop hook", () => {
    const v = views()[2]!;
    expect(decideSettle(input(v))).toEqual({
      settled: true,
      by: "interrupt",
      stopReason: "interrupted",
      anomalies: [],
    });
  });

  test("a plain interrupt while streaming settles 'interrupted'", () => {
    const v = views()[3]!;
    expect(decideSettle(input(v))).toMatchObject({
      settled: true,
      by: "interrupt",
      stopReason: "interrupted",
    });
  });

  test("a declined dialog with interrupt + turn_duration settles once, by the interrupt", () => {
    const p = "permission-write-esc";
    const w =
      "Create a file named hello.txt containing the word hi, using the Write tool. Do nothing else.";
    const v = viewOf(p, w);
    expect(decideSettle(input(v))).toMatchObject({
      settled: true,
      by: "interrupt",
      stopReason: "interrupted",
    });
  });
});

describe("unsettled activity", () => {
  const n = "tools-session";
  const recs = transcriptRecords(n).map(textOf);

  test("a background agent still pending at turn_duration reads 'background'", () => {
    const w = recs.find((s) => s.startsWith("Use the Agent tool with run_in_background"))!;
    const td = indexOf(n, (r) => r.subtype === "turn_duration", witnessIndex(n, w));
    const v = viewOf(n, w, { upTo: td + 1 });
    expect(decideSettle(input(v))).toEqual({ settled: false, activity: "background" });
  });

  test("a background Bash is NOT awaited: the turn settles at turn_duration with the shell open (D23)", () => {
    const w = recs.find((s) => s.startsWith("Use the Bash tool with run_in_background"))!;
    const td = indexOf(n, (r) => r.subtype === "turn_duration", witnessIndex(n, w));
    const v = viewOf(n, w, { upTo: td + 1 });
    expect(v.current!.backgroundShellsOpen).toEqual(["sleep 10; echo BGDONE"]);
    expect(decideSettle(input(v))).toMatchObject({ settled: true, by: "turn_duration" });
  });

  test("a pending AskUserQuestion reads as its tool name", () => {
    const w =
      "Use the AskUserQuestion tool to ask me which fruit I prefer, with exactly two options: Apple and Pear. Do nothing else.";
    const use = indexOf(
      n,
      (r) =>
        r.type === "assistant" && r.message.content.some((b: Rec) => b.name === "AskUserQuestion"),
      witnessIndex(n, w)
    );
    const v = viewOf(n, w, { upTo: use + 1 });
    expect(decideSettle(input(v))).toEqual({ settled: false, activity: "AskUserQuestion" });
  });

  test("a running Bash reads 'Bash' and is never settled by quiet", () => {
    const w = recs.find((s) => s.startsWith("Run this exact command"))!;
    const use = indexOf(
      n,
      (r) => r.type === "assistant" && r.message.content.some((b: Rec) => b.name === "Bash"),
      witnessIndex(n, w)
    );
    const v = viewOf(n, w, { upTo: use + 1 });
    const quiet = { transcriptQuietMs: 1e9, facts: { ...IDLE, aboveBoxQuietMs: 1e9 } };
    expect(decideSettle(input(v, quiet))).toEqual({ settled: false, activity: "Bash" });
  });

  test("a pending tool blocks path P regardless of the gate or elapsed grace (U7)", () => {
    const w = recs.find((s) => s.startsWith("Run this exact command"))!;
    const use = indexOf(
      n,
      (r) => r.type === "assistant" && r.message.content.some((b: Rec) => b.name === "Bash"),
      witnessIndex(n, w)
    );
    const pending = viewOf(n, w, { upTo: use + 1 });
    const v = viewOf(n, w);
    expect(pending.current!.pendingTool?.name).toBe("Bash");
    expect(v.current!.turnDurationAfterLast).not.toBeNull();
    expect(decideSettle(input(v))).toMatchObject({ settled: true, by: "turn_duration" });
    const turn = { ...v.current!, pendingTool: pending.current!.pendingTool };
    for (const facts of [IDLE, ...UNCONFIRMED.map((c) => c.facts), null]) {
      expect(
        decideSettle({
          ...input(v, { facts, transcriptQuietMs: 1e9, chatQuietMs: 1e9 }),
          turn,
        })
      ).toEqual({ settled: false, activity: "Bash" });
    }
  });

  test("before acceptance the activity is 'thinking'", () => {
    const v = viewOf("pear-hookless", "a prompt never typed");
    expect(decideSettle(input(v))).toEqual({ settled: false, activity: "thinking" });
  });
});

describe("path X — pane exit", () => {
  test("an end_turn answer with no turn_duration settles on exit (exit_before_td)", () => {
    const n = "pear-hookless";
    const td = indexOf(n, (r) => r.subtype === "turn_duration");
    const v = viewOf(n, PEAR, { upTo: td });
    expect(v.current!.turnDurationAfterLast).toBeNull();
    expect(decideSettle(input(v, { paneExited: true, facts: null }))).toEqual({
      settled: true,
      by: "exit",
      stopReason: "end_turn",
      anomalies: [],
    });
  });

  test("a tool_use message does not settle on exit", () => {
    const n = "tools-session";
    const w = transcriptRecords(n)
      .map(textOf)
      .find((s) => s.startsWith("Run this exact command"))!;
    const use = indexOf(
      n,
      (r) => r.type === "assistant" && r.message.content.some((b: Rec) => b.name === "Bash"),
      witnessIndex(n, w)
    );
    const v = viewOf(n, w, { upTo: use + 1 });
    expect(decideSettle(input(v, { paneExited: true, facts: null })).settled).toBe(false);
  });
});

describe("refusal (redacted corpus)", () => {
  test("the companion record continues the turn, so the refusal itself never settles it", () => {
    const n = "corpus-redacted/refusal-then-fallback";
    const recs = transcriptRecords(n);
    const r = replay(n, [{ at: 0, witness: text(textOf(recs[0]!)) }], {
      upTo: indexOf(n, (x) => x.type === "user" && x.isMeta === true) + 1,
    });
    cleanups.push(r.cleanup);
    const v = r.views[0]!;
    const quiet = { transcriptQuietMs: 1e9, facts: { ...IDLE, aboveBoxQuietMs: 1e9 } };
    expect(decideSettle(input(v, quiet))).toEqual({ settled: false, activity: "thinking" });
  });

  test("a refusal that does end a turn opens S's Stop-hook gate like an API error", () => {
    const v = viewOf("stop-hook-matrix", PEAR, {
      upTo: indexOf("stop-hook-matrix", (r) => r.subtype === "stop_hook_summary"),
    });
    const turn = {
      ...v.current!,
      lastAssistant: { ...v.current!.lastAssistant!, stopReason: "refusal" },
    };
    const quiet = {
      transcriptQuietMs: SECONDARY_QUIET_MS,
      facts: { ...IDLE, aboveBoxQuietMs: SECONDARY_QUIET_MS },
    };
    expect(decideSettle({ ...input(v, quiet), turn })).toMatchObject({
      settled: true,
      by: "quiet",
      stopReason: "refusal",
    });
  });
});

describe("path L — a local command's stdout", () => {
  function compactView(): TranscriptView {
    const n = "local-commands";
    const recs = transcriptRecords(n);
    const at = recs.findIndex((r) => r.type === "user" && textOf(r) === "/compact");
    const upTo = recs.findIndex((r) => textOf(r).startsWith("Reply with exactly KIWI"));
    const r = replay(n, [{ at, witness: { kind: "command", name: "compact" } }], { upTo });
    cleanups.push(r.cleanup);
    return r.views[0]!;
  }

  test("settles /compact (no assistant record, no turn_duration) once corroborated", () => {
    const v = compactView();
    expect(v.current?.turnDurationAfterLast).toBeNull();
    expect(decideSettle(input(v))).toEqual({
      settled: true,
      by: "local_command",
      stopReason: null,
      anomalies: [],
    });
    expect(decideSettle(input(v, { chatQuietMs: 0 })).settled).toBe(false);
    expect(decideSettle(input(v, { facts: { ...IDLE, working: true } })).settled).toBe(false);
    expect(decideSettle(input(v, { facts: null, paneExited: true }))).toMatchObject({
      settled: true,
      by: "local_command",
    });
  });

  test("a working row delays path L only until the corroboration grace", () => {
    const v = compactView();
    const facts = { ...IDLE, working: true };
    expect(decideSettle(input(v, { facts, chatQuietMs: CORROBORATION_GRACE_MS - 1 })).settled).toBe(
      false
    );
    expect(decideSettle(input(v, { facts, chatQuietMs: CORROBORATION_GRACE_MS }))).toEqual({
      settled: true,
      by: "local_command",
      stopReason: null,
      anomalies: ["settle_gate_unconfirmed:working"],
    });
  });
});
