import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FIXTURES } from "./test-helpers/fixtures.js";
import {
  type Rec,
  indexOf,
  replay,
  textOf,
  transcriptRecords,
  witnessIndex,
} from "./test-helpers/transcript-fixtures.js";
import type { TranscriptView, Witness } from "./transcript-follower.js";

/** Every fixture is a real Claude Code 2.1.290 capture (phase2-captures.md) or a redacted corpus slice. */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function run(
  name: string,
  turns: Array<{ at: number; witness: Witness; delivery?: { file: string; text: string } }>,
  opts: { upTo?: number; subagents?: string } = {}
) {
  const r = replay(name, turns, opts);
  cleanups.push(r.cleanup);
  return r;
}

const text = (t: string): Witness => ({ kind: "text", text: t });
const cur = (v: TranscriptView | undefined) => v!.current!;

/** Generators of the files the captures read (phase2/s03-tools.ts, s11-readlimits.ts). */
const BIG = `${Array.from({ length: 1800 }, (_, i) => `${i + 1} ${"lorem ipsum dolor sit amet ".repeat(4)}`).join("\n")}\n`;
function longLine(n: number): string {
  let s = "START";
  let i = 0;
  while (s.length < n) s += ` w${i++}`;
  return `${s} END`;
}

describe("witness and turn scoping", () => {
  const PEAR = "Reply with exactly PEAR and nothing else.";

  test("a typed line is accepted by the user record carrying exactly that text", () => {
    const at = witnessIndex("pear-hookless", PEAR);
    const { views } = run("pear-hookless", [{ at, witness: text(PEAR) }]);
    const t = cur(views[0]);
    expect(t.acceptedAt).toBe(transcriptRecords("pear-hookless")[at]!.timestamp);
    expect(t.assistantText).toEqual(["PEAR"]);
    expect(t.lastAssistant?.stopReason).toBe("end_turn");
  });

  test("a different text is never accepted", () => {
    const at = witnessIndex("pear-hookless", PEAR);
    const { views } = run("pear-hookless", [{ at, witness: text("Reply with exactly PLUM") }]);
    expect(cur(views[0]).acceptedAt).toBeNull();
    expect(cur(views[0]).lastAssistant).toBeNull();
  });

  test("earlier evidence never satisfies a later turn (C3)", () => {
    const n = "tools-session";
    const t1 = witnessIndex(
      n,
      "Run this exact command with the Bash tool: sleep 12; echo LONGDONE — then reply with its output only."
    );
    const t2Text = transcriptRecords(n)
      .map(textOf)
      .find((s) => s.startsWith("First write, as plain text"))!;
    const t2 = witnessIndex(n, t2Text);
    // Turn 2 opened, but nothing after its offset has been written yet.
    const { views } = run(
      n,
      [
        { at: t1, witness: text(transcriptRecords(n).map(textOf)[t1]!) },
        { at: t2, witness: text(t2Text) },
      ],
      { upTo: t2 }
    );
    expect(cur(views[0]).turnDurationAfterLast).not.toBeNull();
    const t = cur(views[1]);
    expect(t.index).toBe(2);
    expect(t.acceptedAt).toBeNull();
    expect(t.lastAssistant).toBeNull();
    expect(t.turnDurationAfterLast).toBeNull();
  });

  test("a slash command is accepted by its <command-name> record", () => {
    const n = "slash-and-reads";
    const at = indexOf(
      n,
      (r) => r.type === "user" && textOf(r).includes("<command-name>/pear</command-name>")
    );
    const { views } = run(n, [{ at, witness: { kind: "command", name: "pear" } }], {
      upTo: indexOf(n, (r) => r.subtype === "turn_duration", at) + 1,
    });
    const t = cur(views[0]);
    expect(t.acceptedAt).not.toBeNull();
    expect(t.assistantText).toEqual(["PEAR"]);
    expect(t.turnDurationAfterLast).not.toBeNull();
  });

  test("a command witness for another name never matches", () => {
    const n = "slash-and-reads";
    const at = indexOf(
      n,
      (r) => r.type === "user" && textOf(r).includes("<command-name>/pear</command-name>")
    );
    const { views } = run(n, [{ at, witness: { kind: "command", name: "plum" } }], {
      upTo: at + 12,
    });
    expect(cur(views[0]).acceptedAt).toBeNull();
  });
});

describe("usage and tool calls", () => {
  test("usage is taken once per message.id, not once per line", () => {
    const n = "pear-hookless";
    const recs = transcriptRecords(n);
    const assistantLines = recs.filter((r) => r.type === "assistant");
    expect(assistantLines.length).toBe(2); // thinking + text, one message
    const u = assistantLines[0]!.message.usage;
    const { views } = run(n, [
      {
        at: witnessIndex(n, "Reply with exactly PEAR and nothing else."),
        witness: text("Reply with exactly PEAR and nothing else."),
      },
    ]);
    expect(views[0]!.usage).toEqual({
      tokensIn: u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens,
      tokensOut: u.output_tokens,
    });
  });

  test("subagent files add their own messages and tool calls, deduplicated the same way", () => {
    const n = "tools-session";
    const main = run(n, []);
    const without = main.follower.view();
    const withSub = run(n, [], {
      subagents: join(FIXTURES, "transcripts", "tools-session", "subagents"),
    });
    const v = withSub.follower.view();
    expect(v.usage.tokensIn).toBeGreaterThan(without.usage.tokensIn);
    expect(v.toolCalls).toBeGreaterThanOrEqual(without.toolCalls);
    // unique tool_use ids of the main chain
    const ids = new Set<string>();
    for (const r of transcriptRecords(n))
      if (r.type === "assistant" && !r.isSidechain)
        for (const b of r.message.content) if (b.type === "tool_use") ids.add(b.id);
    expect(without.toolCalls).toBe(ids.size);
  });

  test("assistantMessageIds lists each main-chain message id once, in order, never a subagent's", () => {
    const n = "tools-session";
    const r = run(n, [], {
      subagents: join(FIXTURES, "transcripts", "tools-session", "subagents"),
    });
    const expected: string[] = [];
    for (const rec of transcriptRecords(n))
      if (rec.type === "assistant" && !rec.isSidechain && !expected.includes(rec.message.id))
        expected.push(rec.message.id);
    const lines = transcriptRecords(n).filter((rec) => rec.type === "assistant").length;
    expect(expected.length).toBeGreaterThan(1);
    expect(expected.length).toBeLessThan(lines); // one message spans several records
    expect([...r.follower.assistantMessageIds()]).toEqual(expected);
  });
});

describe("Stop hooks, provenHookless and turn_duration", () => {
  test("hookless: end_turn → prompt_snapshot → turn_duration proves the session has no Stop hooks", () => {
    const n = "pear-hookless";
    const { views } = run(n, [
      {
        at: witnessIndex(n, "Reply with exactly PEAR and nothing else."),
        witness: text("Reply with exactly PEAR and nothing else."),
      },
    ]);
    expect(views[0]!.session).toEqual({ stopHooksSeen: false, provenHookless: true });
    expect(cur(views[0]).stopHookSummaryAfterLast).toBe(false);
    expect(cur(views[0]).turnDurationAfterLast).toEqual({ pendingBackgroundAgentCount: null });
  });

  test("with a Stop hook: stop_hook_summary then turn_duration; never provenHookless", () => {
    const n = "stop-hook-matrix";
    const at = witnessIndex(n, "Reply with exactly PEAR and nothing else.");
    const summary = indexOf(n, (r) => r.subtype === "stop_hook_summary", at);
    const before = run(n, [{ at, witness: text("Reply with exactly PEAR and nothing else.") }], {
      upTo: summary,
    });
    expect(cur(before.views[0]).assistantText).toEqual(["PEAR"]);
    expect(cur(before.views[0]).stopHookSummaryAfterLast).toBe(false);
    expect(cur(before.views[0]).turnDurationAfterLast).toBeNull();
    const after = run(n, [{ at, witness: text("Reply with exactly PEAR and nothing else.") }], {
      upTo: summary + 2,
    });
    expect(cur(after.views[0]).stopHookSummaryAfterLast).toBe(true);
    expect(cur(after.views[0]).turnDurationAfterLast).not.toBeNull();
    expect(after.views[0]!.session).toEqual({ stopHooksSeen: true, provenHookless: false });
  });

  test("an API error is followed by turn_duration and no stop_hook_summary even with a Stop hook", () => {
    const n = "api-error-stop-hook";
    const { views } = run(n, [
      {
        at: witnessIndex(n, "Reply with exactly PEAR and nothing else."),
        witness: text("Reply with exactly PEAR and nothing else."),
      },
    ]);
    const t = cur(views[0]);
    expect(t.lastAssistant).toMatchObject({ isApiError: true, stopReason: "stop_sequence" });
    expect(t.apiError).toEqual({
      status: 401,
      category: "authentication_failed",
      text: "Please run /login · API Error: 401 OAuth access token is invalid.",
    });
    expect(t.assistantText).toEqual([]);
    expect(t.stopHookSummaryAfterLast).toBe(false);
    expect(t.turnDurationAfterLast).not.toBeNull();
    expect(views[0]!.session.provenHookless).toBe(false);
  });
});

describe("interrupts (path I's evidence)", () => {
  const n = "stop-hook-matrix";
  const all = transcriptRecords(n).map(textOf);
  const turns = [
    "Reply with exactly PEAR and nothing else.",
    "Write a 400-word story about a pear, as plain text, no tools.",
    "Run the command sleep 30 with the Bash tool, then reply DONE.",
    "Write a 700-word story about a plum, as plain text, no tools.",
  ].map((t) => ({ at: all.findIndex((x) => x.trim() === t), witness: text(t) }));

  test("Esc during a running Bash: tool form, pending tool resolved, no turn_duration", () => {
    const { views } = run(n, turns);
    const t = cur(views[2]);
    expect(t.interruptAfterLast).toEqual({ forToolUse: true });
    expect(t.pendingTool).toBeNull();
    expect(t.turnDurationAfterLast).toBeNull();
    expect(t.stopHookSummaryAfterLast).toBe(false);
  });

  test("Esc while streaming: plain form after an assistant record with stop_reason null", () => {
    const { views } = run(n, turns);
    const t = cur(views[3]);
    expect(t.lastAssistant?.stopReason).toBeNull();
    expect(t.interruptAfterLast).toEqual({ forToolUse: false });
    expect(t.turnDurationAfterLast).toBeNull();
    expect(t.assistantText.join("")).toStartWith("# The Plum Thief");
  });

  test("a declined dialog (permission) writes the interrupt AND turn_duration", () => {
    const p = "permission-write-esc";
    const w =
      "Create a file named hello.txt containing the word hi, using the Write tool. Do nothing else.";
    const { views } = run(p, [{ at: witnessIndex(p, w), witness: text(w) }]);
    const t = cur(views[0]);
    expect(t.interruptAfterLast).toEqual({ forToolUse: true });
    expect(t.turnDurationAfterLast).not.toBeNull();
  });
});

describe("blocked tools", () => {
  test("a pending AskUserQuestion is visible until its rejection result lands", () => {
    const n = "tools-session";
    const w =
      "Use the AskUserQuestion tool to ask me which fruit I prefer, with exactly two options: Apple and Pear. Do nothing else.";
    const at = witnessIndex(n, w);
    const use = indexOf(
      n,
      (r) =>
        r.type === "assistant" && r.message.content.some((b: Rec) => b.name === "AskUserQuestion"),
      at
    );
    const pending = run(n, [{ at, witness: text(w) }], { upTo: use + 1 });
    expect(cur(pending.views[0]).pendingTool?.name).toBe("AskUserQuestion");
    const done = run(n, [{ at, witness: text(w) }], { upTo: use + 6 });
    const t = cur(done.views[0]);
    expect(t.pendingTool).toBeNull();
    expect(t.interruptAfterLast).toEqual({ forToolUse: true });
    expect(t.turnDurationAfterLast).not.toBeNull();
  });

  test("a pending ExitPlanMode is visible until the plan is declined", () => {
    const n = "plan-approval-esc";
    const w =
      "Make a one-step plan to create a file hello.txt containing hi, then call ExitPlanMode to present it. Keep it short.";
    const at = witnessIndex(n, w);
    const use = indexOf(
      n,
      (r) =>
        r.type === "assistant" && r.message.content.some((b: Rec) => b.name === "ExitPlanMode"),
      at
    );
    const { views } = run(n, [{ at, witness: text(w) }], { upTo: use + 1 });
    expect(cur(views[0]).pendingTool?.name).toBe("ExitPlanMode");
  });
});

describe("background work (D23)", () => {
  const n = "tools-session";
  const recs = transcriptRecords(n);
  const find = (p: string) => recs.map(textOf).find((s) => s.startsWith(p))!;

  test("a background Bash is listed open at the first turn_duration, then closed by its notification", () => {
    const w = find("Use the Bash tool with run_in_background");
    const at = witnessIndex(n, w);
    const td = indexOf(n, (r) => r.subtype === "turn_duration", at);
    const first = run(n, [{ at, witness: text(w) }], { upTo: td + 1 });
    const t1 = cur(first.views[0]);
    expect(t1.backgroundShellsOpen).toEqual(["sleep 10; echo BGDONE"]);
    expect(t1.agentsLaunched).toBe(0);
    expect(t1.turnDurationAfterLast).toEqual({ pendingBackgroundAgentCount: null });
    const notif = indexOf(
      n,
      (r) => r.type === "user" && r.origin?.kind === "task-notification",
      td
    );
    const woke = run(n, [{ at, witness: text(w) }], { upTo: notif + 1 });
    expect(cur(woke.views[0]).wakingAfterLast).toBe(true);
    expect(cur(woke.views[0]).backgroundShellsOpen).toEqual([]);
    const td2 = indexOf(n, (r) => r.subtype === "turn_duration", notif);
    const end = run(n, [{ at, witness: text(w) }], { upTo: td2 + 1 });
    const t3 = cur(end.views[0]);
    expect(t3.wakingAfterLast).toBe(false);
    expect(t3.turnDurationAfterLast).not.toBeNull();
    expect(t3.assistantText[0]).toBe("STARTED");
    expect(t3.assistantText.length).toBe(2); // the re-wake stays in the same turn
  });

  test("a background agent is counted from toolUseResult.isAsync (its input had no run_in_background)", () => {
    const w = find("Use the Agent tool with run_in_background");
    const at = witnessIndex(n, w);
    const use = recs.findIndex(
      (r, i) =>
        i > at && r.type === "assistant" && r.message.content.some((b: Rec) => b.name === "Agent")
    );
    expect(
      recs[use]!.message.content.find((b: Rec) => b.name === "Agent").input.run_in_background
    ).toBeUndefined();
    const td = indexOf(n, (r) => r.subtype === "turn_duration", at);
    const first = run(n, [{ at, witness: text(w) }], { upTo: td + 1 });
    const t1 = cur(first.views[0]);
    expect(t1.agentsLaunched).toBe(1);
    expect(t1.agentsCompleted).toBe(0);
    expect(t1.turnDurationAfterLast).toEqual({ pendingBackgroundAgentCount: 1 });
    const td2 = indexOf(n, (r) => r.subtype === "turn_duration", td + 1);
    const end = run(n, [{ at, witness: text(w) }], { upTo: td2 + 1 });
    const t2 = cur(end.views[0]);
    expect([t2.agentsLaunched, t2.agentsCompleted]).toEqual([1, 1]);
    expect(t2.turnDurationAfterLast).toEqual({ pendingBackgroundAgentCount: null });
  });
});

describe("Claude Code's own continuations wake the model", () => {
  test("max_tokens: each isMeta 'Output token limit hit' record wakes; the turn ends in a max_output_tokens API error", () => {
    const n = "max-tokens-hookless";
    const w = "Write a 400-word story about a pear, as plain text, no tools.";
    const at = witnessIndex(n, w);
    const meta = indexOf(n, (r) => r.type === "user" && r.isMeta === true, at);
    expect(textOf(transcriptRecords(n)[meta]!)).toStartWith("Output token limit hit.");
    const mid = run(n, [{ at, witness: text(w) }], { upTo: meta + 1 });
    expect(cur(mid.views[0]).lastAssistant?.stopReason).toBe("max_tokens");
    expect(cur(mid.views[0]).wakingAfterLast).toBe(true);
    const end = run(n, [{ at, witness: text(w) }]);
    const t = cur(end.views[0]);
    expect(t.wakingAfterLast).toBe(false);
    expect(t.apiError?.category).toBe("max_output_tokens");
    expect(t.turnDurationAfterLast).not.toBeNull();
  });

  test("refusal (redacted corpus): the companion isMeta record wakes; the model continues", () => {
    const n = "corpus-redacted/refusal-then-fallback";
    const recs = transcriptRecords(n);
    const w = textOf(recs[0]!);
    const refusal = recs.findIndex(
      (r) => r.type === "assistant" && r.message.stop_reason === "refusal"
    );
    const companion = indexOf(n, (r) => r.type === "user" && r.isMeta === true, refusal);
    const mid = run(n, [{ at: 0, witness: text(w) }], { upTo: companion + 1 });
    expect(cur(mid.views[0]).lastAssistant?.stopReason).toBe("refusal");
    expect(cur(mid.views[0]).wakingAfterLast).toBe(true);
    const end = run(n, [{ at: 0, witness: text(w) }]);
    expect(cur(end.views[0]).lastAssistant?.stopReason).not.toBe("refusal");
  });
});

describe("compaction inside a turn (H12)", () => {
  test("redacted corpus turn: text before and after the boundary stays in one answer", () => {
    const n = "corpus-redacted/auto-compaction-in-turn";
    const recs = transcriptRecords(n);
    const w = textOf(recs[0]!);
    const boundary = recs.findIndex((r) => r.subtype === "compact_boundary");
    const { views } = run(n, [{ at: 0, witness: text(w) }]);
    const t = cur(views[0]);
    expect(t.compactions).toBe(1);
    expect(t.turnDurationAfterLast).not.toBeNull();
    const textsBefore = recs
      .slice(0, boundary)
      .flatMap((r) =>
        r.type === "assistant" && !r.isSidechain
          ? r.message.content.filter((b: Rec) => b.type === "text" && b.text)
          : []
      );
    const textsAfter = recs
      .slice(boundary)
      .flatMap((r) =>
        r.type === "assistant" && !r.isSidechain
          ? r.message.content.filter((b: Rec) => b.type === "text" && b.text)
          : []
      );
    expect(textsBefore.length).toBeGreaterThan(0);
    expect(textsAfter.length).toBeGreaterThan(0);
    expect(t.assistantText.length).toBe(textsBefore.length + textsAfter.length);
  });

  test("/compact is a command turn: accepted by <command-name>, no assistant message", () => {
    const n = "tools-session";
    const recs = transcriptRecords(n);
    const witness = recs.findIndex(
      (r) => r.type === "user" && textOf(r).includes("<command-name>/compact</command-name>")
    );
    // The offset is marked before delivery, so the boundary and summary written before the witness line belong to this turn.
    const mark = recs.findIndex((r) => r.subtype === "compact_boundary") - 1;
    const { views } = run(n, [{ at: mark, witness: { kind: "command", name: "compact" } }], {
      upTo: witness + 2,
    });
    const t = cur(views[0]);
    expect(t.acceptedAt).not.toBeNull();
    expect(t.lastAssistant).toBeNull();
  });
});

describe("read coverage of a file-delivered turn (X-H5, R3-M3)", () => {
  test("the template turn: every line returned, CRs stripped, answer after the Read", () => {
    const n = "tools-session";
    const recs = transcriptRecords(n);
    const w = recs.map(textOf).find((s) => s.startsWith("Your task is in the file"))!;
    const file = w.match(/`([^`]+)`/)![1]!;
    const body = `Reply with the word KIWI, then on a new line the number of lines in this file.\nSecond line.\r\nThird line with a tab:\there.\n${"x".repeat(50)}\n`;
    const { views } = run(
      n,
      [{ at: witnessIndex(n, w), witness: text(w), delivery: { file, text: body } }],
      {
        upTo: indexOf(n, (r) => r.subtype === "turn_duration", witnessIndex(n, w)) + 1,
      }
    );
    const t = cur(views[0]);
    expect(t.delivery).toEqual({ file, lines: 5 });
    expect(t.readCoverage).toMatchObject({ complete: true, reads: 1, linesReturned: 5 });
    expect(t.readCoverage.completedAtOffset).not.toBeNull();
    expect(t.assistantText).toEqual(["KIWI\n5"]);
    expect(t.preambleBytes).toBe(0);
  });

  test("a token-capped read (lines 1-750 of 1801) is incomplete", () => {
    const n = "slash-and-reads";
    const w =
      "Use the Read tool once on the file big.txt with no offset or limit, then reply with the single word READ.";
    const file = "/private/tmp/cc2/s03b-tools/cwd/big.txt";
    const { views } = run(n, [
      { at: witnessIndex(n, w), witness: text(w), delivery: { file, text: BIG } },
    ]);
    const t = cur(views[0]);
    expect(t.readCoverage).toMatchObject({
      complete: false,
      reads: 1,
      linesReturned: 750,
      completedAtOffset: null,
    });
    // never complete: the answer is the text after the last Read result
    expect(t.assistantText).toEqual(["READ"]);
  });

  test("paging with offset:0 (numbered from 0) and an is_error first read still covers every line", () => {
    const n = "read-limits";
    const w =
      "Read the whole file big.txt with the Read tool, paging with offset and limit until you have every line, then reply with the number of the last line.";
    const file = "/private/tmp/cc2/s11-readlimits/cwd/big.txt";
    const recs = transcriptRecords(n);
    const at = witnessIndex(n, w);
    const errors = recs
      .slice(at)
      .filter((r) => r.type === "user" && r.message?.content?.[0]?.is_error).length;
    expect(errors).toBe(1);
    const { views } = run(n, [{ at, witness: text(w), delivery: { file, text: BIG } }]);
    const t = cur(views[0]);
    expect(t.readCoverage).toMatchObject({ complete: true, reads: 5, linesReturned: 1801 });
    // text written before coverage completed is preamble, not answer
    const completedIdx = recs.findIndex(
      (r, i) => i > at && r.type === "user" && r.toolUseResult?.file?.startLine === 1800
    );
    const preamble = recs
      .slice(at, completedIdx)
      .flatMap((r) =>
        r.type === "assistant"
          ? r.message.content
              .filter((b: Rec) => b.type === "text" && b.text)
              .map((b: Rec) => b.text)
          : []
      );
    expect(t.preambleBytes).toBe(
      preamble.reduce((s: number, x: string) => s + Buffer.byteLength(x), 0)
    );
    expect(t.assistantText.join("")).toContain("1801");
  });

  test("a returned line whose text differs from the file is not covered", () => {
    const n = "read-limits";
    const w =
      "Read the whole file big.txt with the Read tool, paging with offset and limit until you have every line, then reply with the number of the last line.";
    const file = "/private/tmp/cc2/s11-readlimits/cwd/big.txt";
    const altered = BIG.replace("\n900 lorem", "\n900 LOREM");
    const { views } = run(n, [
      { at: witnessIndex(n, w), witness: text(w), delivery: { file, text: altered } },
    ]);
    const t = cur(views[0]);
    expect(t.readCoverage.complete).toBe(false);
    expect(t.readCoverage.linesReturned).toBe(1800);
  });

  test("lines of 40,000 and 90,005 characters come back whole and are covered", () => {
    const n = "read-limits";
    for (const [f, len] of [
      ["line40k.txt", 40000],
      ["line90k.txt", 90000],
    ] as const) {
      const w = `Use the Read tool once on the file ${f} with no offset or limit, then reply with the single word READ.`;
      const file = `/private/tmp/cc2/s11-readlimits/cwd/${f}`;
      const { views } = run(
        n,
        [
          {
            at: witnessIndex(n, w),
            witness: text(w),
            delivery: { file, text: `a\n${longLine(len)}\nz\n` },
          },
        ],
        {
          upTo: indexOf(n, (r) => r.subtype === "turn_duration", witnessIndex(n, w)) + 1,
        }
      );
      expect(cur(views[0]).readCoverage).toMatchObject({ complete: true, reads: 1 });
    }
  });

  test("a CRLF file is covered (Read strips the CRs)", () => {
    const n = "slash-and-reads";
    const w =
      "Use the Read tool once on the file crlf.txt with no offset or limit, then reply with the single word READ.";
    const { views } = run(
      n,
      [
        {
          at: witnessIndex(n, w),
          witness: text(w),
          delivery: {
            file: "/private/tmp/cc2/s03b-tools/cwd/crlf.txt",
            text: "alpha\r\nbeta\r\ngamma\r\n",
          },
        },
      ],
      {
        upTo: indexOf(n, (r) => r.subtype === "turn_duration", witnessIndex(n, w)) + 1,
      }
    );
    expect(cur(views[0]).readCoverage).toMatchObject({ complete: true, linesReturned: 4 });
  });

  test("a turn with no delivery reports complete coverage and no preamble", () => {
    const n = "pear-hookless";
    const w = "Reply with exactly PEAR and nothing else.";
    const { views } = run(n, [{ at: witnessIndex(n, w), witness: text(w) }]);
    expect(cur(views[0]).delivery).toBeNull();
    expect(cur(views[0]).readCoverage.complete).toBe(true);
  });
});

describe("tailing", () => {
  test("availability: absent, empty (nothing after the offset), ok, off", async () => {
    const { appendFileSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { TranscriptFollower } = await import("./transcript-follower.js");
    const dir = mkdtempSync(join(tmpdir(), "pane-avail-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "t.jsonl");
    const f = new TranscriptFollower(path, join(dir, "subagents"));
    expect(f.view().availability).toBe("absent");
    writeFileSync(path, "");
    f.poll();
    f.openTurn({
      index: 1,
      offset: f.size(),
      witness: text("Reply with exactly PEAR and nothing else."),
    });
    expect(f.view().availability).toBe("empty");
    const lines = (await import("./test-helpers/transcript-fixtures.js")).transcriptLines(
      "pear-hookless"
    );
    appendFileSync(path, `${lines.join("\n")}\n`);
    f.poll();
    expect(f.view().availability).toBe("ok");
    f.markSavingOff();
    expect(f.view().availability).toBe("off");
  });

  test("a record split across two appends is applied once, when complete", async () => {
    const { appendFileSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { TranscriptFollower } = await import("./transcript-follower.js");
    const dir = mkdtempSync(join(tmpdir(), "pane-tail-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "t.jsonl");
    writeFileSync(path, "");
    const f = new TranscriptFollower(path, join(dir, "subagents"));
    expect(f.view().availability).toBe("empty");
    const w = "Reply with exactly PEAR and nothing else.";
    f.openTurn({ index: 1, offset: f.size(), witness: text(w) });
    const lines = (await import("./test-helpers/transcript-fixtures.js")).transcriptLines(
      "pear-hookless"
    );
    const all = `${lines.join("\n")}\n`;
    const cut = all.indexOf("\n", all.indexOf('"type":"assistant"')) - 20;
    appendFileSync(path, all.slice(0, cut));
    f.poll();
    const partial = f.view().current!;
    appendFileSync(path, all.slice(cut));
    f.poll();
    const whole = f.view().current!;
    expect(partial.turnDurationAfterLast).toBeNull();
    expect(whole.assistantText).toEqual(["PEAR"]);
    expect(whole.turnDurationAfterLast).not.toBeNull();
  });
});

describe("local commands", () => {
  test("a local command turn carries its stdout (2.1.291 /model, /compact), ANSI removed", () => {
    const n = "local-commands";
    const recs = transcriptRecords(n);
    const model = recs.findIndex((r) => textOf(r).includes("<command-name>/model</command-name>"));
    const compactTyped = recs.findIndex((r) => r.type === "user" && textOf(r) === "/compact");
    const { views } = run(n, [
      { at: model - 2, witness: { kind: "command", name: "model" } },
      { at: compactTyped, witness: { kind: "command", name: "compact" } },
    ]);
    const m = cur(views[0]);
    expect(m.acceptedAt).not.toBeNull();
    expect(m.lastAssistant).toBeNull();
    expect(m.localCommandOutput?.startsWith("Set model to `Haiku 4.5`")).toBe(true);
    expect(m.localCommandOutput).not.toContain("\u001b");
    // the second turn ran on to the KIWI turn, so view the compact turn before it
    const { views: v2 } = run(
      n,
      [{ at: compactTyped, witness: { kind: "command", name: "compact" } }],
      { upTo: recs.findIndex((r) => textOf(r).startsWith("Reply with exactly KIWI")) }
    );
    expect(cur(v2[0]).localCommandOutput).toBe("Compacted (ctrl+o to see full summary)");
  });

  test("/color (2.1.291): the witness and the stdout are system/local_command records", () => {
    const n = "local-commands";
    const recs = transcriptRecords(n);
    const at = recs.findIndex((r) => r.subtype === "local_command");
    expect(recs[at]?.type).toBe("system");
    const { views } = run(n, [{ at, witness: { kind: "command", name: "color" } }], {
      upTo: at + 2,
    });
    expect(cur(views[0]).acceptedAt).toBe(recs[at]!.timestamp);
    expect(cur(views[0]).localCommandOutput).toBe("Session color set to: yellow");
  });

  test("a prompt command (/pear) carries no local output: it settles on its assistant turn", () => {
    const n = "slash-and-reads";
    const at = transcriptRecords(n).findIndex((r) => textOf(r).includes("<command-name>/pear"));
    const td = indexOf(n, (r) => r.subtype === "turn_duration", at);
    const { views } = run(n, [{ at, witness: { kind: "command", name: "pear" } }], {
      upTo: td + 1,
    });
    expect(cur(views[0]).localCommandOutput).toBeNull();
    expect(cur(views[0]).assistantText).toEqual(["PEAR"]);
  });

  test("/exit's own records after a settled turn (real 2.1.285) never wake it", async () => {
    const { appendFileSync } = await import("node:fs");
    const PEAR = "Reply with exactly PEAR and nothing else.";
    const at = witnessIndex("pear-hookless", PEAR);
    const r = run("pear-hookless", [{ at, witness: text(PEAR) }]);
    const settled = cur(r.views[0]);
    expect(settled.turnDurationAfterLast).not.toBeNull();
    const exitLines = (await import("./test-helpers/transcript-fixtures.js")).transcriptLines(
      "corpus-redacted/exit-command"
    );
    appendFileSync(join(r.dir, "t.jsonl"), `${exitLines.join("\n")}\n`);
    r.follower.poll();
    const after = cur(r.follower.view());
    expect(after.wakingAfterLast).toBe(false);
    expect(after.lastChatOffset).toBe(settled.lastChatOffset);
    expect(after.turnDurationAfterLast).not.toBeNull();
  });
});

describe("bounded state", () => {
  test("opening a turn drops the previous turn's state, task file included", async () => {
    const { initialFollowerState, openTurnState } = await import("./transcript-follower.js");
    const state = initialFollowerState((p) => p);
    for (let i = 1; i <= 50; i++)
      openTurnState(state, {
        index: i,
        offset: i * 100,
        witness: text(`turn ${i}`),
        delivery: { file: `/t/turn-${i}.md`, text: "x".repeat(100_000) },
      });
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.index).toBe(50);
  });
});

describe("byte-safe tail", () => {
  test("a poll that splits a multi-byte character decodes the record exactly once, offsets in bytes", async () => {
    const { appendFileSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { Tail, TranscriptFollower } = await import("./transcript-follower.js");
    const dir = mkdtempSync(join(tmpdir(), "pane-tail-utf8-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "t.jsonl");
    writeFileSync(path, "");
    const w = "Reply with exactly PEAR and nothing else.";
    const answer = "PEAR — 東京 ✓ 🍐";
    // the real capture, with the answer text templated to carry multi-byte characters
    const lines = transcriptRecords("pear-hookless").map((r) => {
      if (r.type !== "assistant") return JSON.stringify(r);
      const c = structuredClone(r) as Rec;
      for (const b of c.message.content) if (b.type === "text") b.text = answer;
      return JSON.stringify(c);
    });
    const bytes = Buffer.from(`${lines.join("\n")}\n`, "utf8");
    const at = bytes.indexOf(Buffer.from("東", "utf8"));
    expect(at).toBeGreaterThan(0);
    const f = new TranscriptFollower(path, join(dir, "subagents"));
    const tail = new Tail(path);
    f.openTurn({ index: 1, offset: f.size(), witness: text(w) });
    appendFileSync(path, bytes.subarray(0, at + 1)); // inside the 3-byte 東
    f.poll();
    const first = tail.read();
    appendFileSync(path, bytes.subarray(at + 1));
    f.poll();
    const second = tail.read();
    expect(cur(f.view()).assistantText).toEqual([answer]);
    expect(cur(f.view()).turnDurationAfterLast).not.toBeNull();
    // every line comes back intact, at the byte offset it starts at
    const got = [...first, ...second];
    expect(got.map((l) => l.line)).toEqual(lines);
    let pos = 0;
    for (const [i, l] of got.entries()) {
      expect(l.offset).toBe(pos);
      pos += Buffer.byteLength(lines[i] as string) + 1;
    }
  });
});
