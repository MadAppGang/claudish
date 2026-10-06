import { afterEach, describe, expect, test } from "bun:test";
import {
  SECONDARY_QUIET_MS,
  type ScreenFacts,
  type SettleInput,
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

/** Turn views come from real transcripts replayed through the follower; only the screen facts are set by hand. */

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

const IDLE_SCREEN: ScreenFacts = {
  boxEmpty: true,
  choiceDialog: false,
  working: false,
  aboveBoxQuietMs: 0,
};

function input(v: TranscriptView, over: Partial<SettleInput> = {}): SettleInput {
  return {
    turn: v.current,
    session: v.session,
    transcriptQuietMs: 1000,
    chatQuietMs: 1000,
    screen: IDLE_SCREEN,
    paneExited: false,
    ...over,
  };
}

const PEAR = "Reply with exactly PEAR and nothing else.";

describe("path P — turn_duration", () => {
  test("settles a hookless end_turn once the screen corroborates", () => {
    const v = viewOf("pear-hookless", PEAR);
    expect(decideSettle(input(v))).toEqual({
      settled: true,
      by: "turn_duration",
      stopReason: "end_turn",
      anomalies: [],
    });
  });

  test("waits for the screen: typed text, a dialog, a working row, or a chat record < 500 ms old", () => {
    const v = viewOf("pear-hookless", PEAR);
    expect(decideSettle(input(v, { screen: { ...IDLE_SCREEN, boxEmpty: false } })).settled).toBe(
      false
    );
    expect(decideSettle(input(v, { screen: { ...IDLE_SCREEN, choiceDialog: true } })).settled).toBe(
      false
    );
    expect(decideSettle(input(v, { screen: { ...IDLE_SCREEN, working: true } })).settled).toBe(
      false
    );
    expect(decideSettle(input(v, { chatQuietMs: 100 })).settled).toBe(false);
  });

  test("while disconnected it settles on the transcript alone with screen_unverified (X-M12)", () => {
    const v = viewOf("pear-hookless", PEAR);
    expect(decideSettle(input(v, { screen: null }))).toEqual({
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
      decideSettle(
        input(mid, { transcriptQuietMs: 1e9, screen: { ...IDLE_SCREEN, aboveBoxQuietMs: 1e9 } })
      )
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

describe("Stop hooks hold the turn open (X-H2)", () => {
  const n = "stop-hook-matrix";
  const at = witnessIndex(n, PEAR);
  const summary = indexOf(n, (r) => r.subtype === "stop_hook_summary", at);

  test("a running Stop hook is 'finishing' and no quiet window, however long, settles it", () => {
    const v = viewOf(n, PEAR, { upTo: summary });
    const long = {
      transcriptQuietMs: 10 * SECONDARY_QUIET_MS,
      screen: { ...IDLE_SCREEN, aboveBoxQuietMs: 10 * SECONDARY_QUIET_MS },
    };
    expect(decideSettle(input(v, long))).toEqual({ settled: false, activity: "finishing" });
  });

  test("once the summary is written, path S may settle after the secondary quiet window", () => {
    const v = viewOf(n, PEAR, { upTo: summary + 1 });
    expect(v.current!.turnDurationAfterLast).toBeNull();
    expect(v.current!.stopHookSummaryAfterLast).toBe(true);
    const short = {
      transcriptQuietMs: SECONDARY_QUIET_MS - 1,
      screen: { ...IDLE_SCREEN, aboveBoxQuietMs: SECONDARY_QUIET_MS },
    };
    expect(decideSettle(input(v, short)).settled).toBe(false);
    const ok = {
      transcriptQuietMs: SECONDARY_QUIET_MS,
      screen: { ...IDLE_SCREEN, aboveBoxQuietMs: SECONDARY_QUIET_MS },
    };
    expect(decideSettle(input(v, ok))).toEqual({
      settled: true,
      by: "quiet",
      stopReason: "end_turn",
      anomalies: ["settled_without_turn_duration"],
    });
    // S waits for the reconnect
    expect(decideSettle(input(v, { ...ok, screen: null })).settled).toBe(false);
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
      screen: { ...IDLE_SCREEN, aboveBoxQuietMs: SECONDARY_QUIET_MS },
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
    const quiet = { transcriptQuietMs: 1e9, screen: { ...IDLE_SCREEN, aboveBoxQuietMs: 1e9 } };
    expect(decideSettle(input(v, quiet))).toEqual({ settled: false, activity: "Bash" });
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
    expect(decideSettle(input(v, { paneExited: true, screen: null }))).toEqual({
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
    expect(decideSettle(input(v, { paneExited: true, screen: null })).settled).toBe(false);
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
    const quiet = { transcriptQuietMs: 1e9, screen: { ...IDLE_SCREEN, aboveBoxQuietMs: 1e9 } };
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
      screen: { ...IDLE_SCREEN, aboveBoxQuietMs: SECONDARY_QUIET_MS },
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
    expect(decideSettle(input(v, { screen: { ...IDLE_SCREEN, working: true } })).settled).toBe(
      false
    );
    expect(decideSettle(input(v, { screen: null, paneExited: true }))).toMatchObject({
      settled: true,
      by: "local_command",
    });
  });
});
