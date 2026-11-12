import { describe, expect, test } from "bun:test";
import type { ViewItem } from "../../pane/view-contract.js";
import { replayItem, sessionItem } from "../test-helpers/placer-harness.js";
import {
  EARLIER_MIN_TABS,
  failureCard,
  footerLine,
  runStartMs,
  runTabs,
  runsOf,
  sessionTabs,
  transcriptText,
} from "./runs.js";

const NOW = Date.parse("2026-11-12T10:30:00.000Z");
/** a run id as `mintRunId` writes it: `<dir>-<base36 start ms>-<6 hex>` */
function runId(dir: string, startIso: string): string {
  return `${dir}-${Date.parse(startIso).toString(36)}-a1b2c3`;
}

function withFields(item: ViewItem, fields: Record<string, unknown>): ViewItem {
  return { ...item, ...fields } as ViewItem;
}

function slot(run: string, id: string, fields: Record<string, unknown> = {}): ViewItem {
  return withFields(sessionItem(id), {
    kind: "team_slot",
    target: `t:${run}/${id}`,
    run_id: run,
    run_path: `/Users/u/proj/ai-docs/sessions/${run.split("-")[0]}`,
    run_kind: "run",
    slot: id,
    session_id: undefined,
    started_at: undefined,
    completed_at: undefined,
    elapsed_seconds: undefined,
    ...fields,
  });
}

const CLAIMS = runId("viewclaims", "2026-11-12T10:28:00.000Z");
const GATE = runId("gateb2r", "2026-11-12T10:20:00.000Z");

const items: ViewItem[] = [
  slot(CLAIMS, "01", {
    model: "gemini-4-argon",
    provider: "Google",
    state: "COMPLETED",
    tokens_in: 52_000,
    tokens_out: 4_000,
    cost_usd: 0,
    tool_calls: 9,
    turns_completed: 1,
    last_activity_at: "2026-11-12T10:31:00.000Z",
    agent: "dev:architect",
    task_type: "research",
    recent: [
      { at: "x", kind: "tool", tool: "Read", summary: "view-claims.ts" },
      {
        at: "y",
        kind: "text",
        tool: null,
        summary: "1. One holder per target; the latest take wins.",
      },
    ],
  }),
  slot(CLAIMS, "02", {
    model: "gpt-6-luna",
    provider: "Openai-codex",
    state: "RUNNING",
    tokens_in: 41_000,
    tokens_out: 3_000,
    cost_usd: 0,
    tool_calls: 12,
    turns_completed: 0,
    agent: "dev:architect",
    task_type: "research",
    recent: [
      { at: "x", kind: "tool", tool: "Read", summary: "packages/cli/src/view/view-claims.ts" },
    ],
  }),
  slot(GATE, "01", {
    model: "kimi-k3.1-pro",
    provider: "Kimi-coding",
    state: "COMPLETED",
    cost_usd: 1.234,
    agent: "dev:reviewer",
    task_type: "judge",
  }),
  slot(GATE, "02", {
    model: "gpt-6.1-sol",
    provider: "Openai-codex",
    state: "COMPLETED",
    cost_usd: null,
    agent: null,
    task_type: "judge",
  }),
  withFields(sessionItem("ed2e9e42"), {
    model: "gpt-6-luna",
    provider: "Openai-codex",
    state: "FAILED",
    reason: "child_exited",
    reason_detail: "pane child exited with code 1; last line: error: unknown option",
    started_at: "2026-11-12T10:05:00.000Z",
    elapsed_seconds: 0,
    cost_usd: null,
    turns_completed: 0,
    tool_calls: 0,
    tokens_in: null,
    tokens_out: null,
  }),
  replayItem("r1"),
];

describe("runsOf: one run per team run, one per session, latest first", () => {
  test("groups slots by run, a session alone, replays left out, newest start first", () => {
    const runs = runsOf(items, NOW);
    expect(runs.map((r) => [r.key, r.kind, r.name, r.rows.length])).toEqual([
      [CLAIMS, "team", "viewclaims", 2],
      [GATE, "team", "gateb2r", 2],
      ["s:ed2e9e42", "session", "s:ed2e", 1],
    ]);
  });

  test("a run's tone and counts: running and done, all done, all failed", () => {
    const [claims, gate, failed] = runsOf(items, NOW);
    expect([claims?.tone, claims?.counts]).toEqual(["run", "1 running · 1 done"]);
    expect([gate?.tone, gate?.counts]).toEqual(["done", "2 done"]);
    expect([failed?.tone, failed?.counts]).toEqual(["fail", "1 failed"]);
  });

  test("the header names the task type, and the agent when every slot shares it", () => {
    const [claims, gate, failed] = runsOf(items, NOW);
    expect(claims?.meta).toBe("research · agent dev:architect");
    expect(claims?.rows.map((r) => r.agent)).toEqual([null, null]);
    // the slots differ: the header keeps the task type, each row names its own agent
    expect(gate?.meta).toBe("judge");
    expect(gate?.rows.map((r) => r.agent)).toEqual(["dev:reviewer", "—"]);
    expect(failed?.meta).toBeNull();
  });

  test("band rows: running first, the band's codes, chips and the note", () => {
    const [claims, gate, failed] = runsOf(items, NOW);
    expect(claims?.rows.map((r) => [r.slot, r.code, r.tone, r.elapsed])).toEqual([
      ["02", "RUN", "run", "2m"],
      ["01", "END", "done", "3m"],
    ]);
    const live = claims?.rows[0];
    expect(live).toMatchObject({
      model: "gpt-6-luna",
      provider: "Openai-codex",
      tokens: "↑41k ↓3.0k",
      tools: "ƒ 12",
      turns: "↻ 0",
      billing: "SUB",
      note: "Read: packages/cli/src/view/view-claims.ts",
      error: false,
    });
    expect(claims?.rows[1]?.note).toBe("1. One holder per target; the latest take wins.");
    expect(gate?.rows.map((r) => r.billing)).toEqual(["$1.23", "—"]);
    expect(failed?.rows[0]).toMatchObject({
      slot: "··",
      code: "ERR",
      tone: "fail",
      elapsed: "0s",
      note: "pane child exited with code 1; last line: error: unknown option",
      error: true,
      noScreen: true,
    });
  });

  test("the run start comes from the run id; a foreign id has none", () => {
    expect(runStartMs(CLAIMS)).toBe(Date.parse("2026-11-12T10:28:00.000Z"));
    expect(runStartMs("not-a-run")).toBeNull();
  });
});

describe("runTabs: the latest runs as tabs, the rest under +N earlier", () => {
  const many = Array.from({ length: 6 }, (_, i) =>
    slot(runId(`run${i}`, new Date(NOW - (i + 1) * 600_000).toISOString()), "01", {
      state: "COMPLETED",
    })
  );

  test("the newest first, labelled latest, then ages; the rest counted as earlier", () => {
    const runs = runsOf(many, NOW);
    const tabs = runTabs(runs, runs[0]?.key ?? null, 3, NOW);
    expect(tabs.tabs.map((t) => [t.name, t.age, t.selected])).toEqual([
      ["run0", "latest", true],
      ["run1", "20m ago", false],
      ["run2", "30m ago", false],
    ]);
    expect(tabs.earlier.map((t) => t.name)).toEqual(["run3", "run4", "run5"]);
  });

  test("an earlier run that is selected takes the last tab's place", () => {
    const runs = runsOf(many, NOW);
    const tabs = runTabs(runs, runs[4]?.key ?? null, 3, NOW);
    expect(tabs.tabs.map((t) => t.name)).toEqual(["run0", "run1", "run4"]);
    expect(tabs.earlier.map((t) => t.name)).toEqual(["run2", "run3", "run5"]);
  });

  test("never fewer than the minimum tabs", () => {
    const runs = runsOf(many, NOW);
    expect(runTabs(runs, null, 0, NOW).tabs).toHaveLength(EARLIER_MIN_TABS);
  });
});

describe("the session view: tabs, footer, the failure card, the transcript", () => {
  test("one tab per slot: its dot's tone, slot and short model", () => {
    const [claims] = runsOf(items, NOW);
    expect(sessionTabs(claims!, "t:x/01").map((t) => [t.label, t.tone])).toEqual([
      ["02 gpt-6-luna", "run"],
      ["01 gemini-4-argon", "done"],
    ]);
  });

  test("the footer says what the screen area shows, always read only", () => {
    const [claims, , failed] = runsOf(items, NOW);
    expect(footerLine(claims!.rows[0]!, "screen")).toBe(
      "read only · live screen of slot 02; focusing it takes the view"
    );
    expect(footerLine(claims!.rows[1]!, "screen")).toBe(
      "read only · finished: a replay of the real interface"
    );
    expect(footerLine(failed!.rows[0]!, "screen")).toBe(
      "read only · no screen: the reason and records are shown"
    );
    expect(footerLine(claims!.rows[0]!, "text")).toBe("read only · transcript of slot 02");
  });

  test("a session that failed before Claude Code started shows its reason, route and records", () => {
    const [, , failed] = runsOf(items, NOW);
    expect(failureCard(failed!.rows[0]!, "/Users/u")).toEqual([
      "This session ended before Claude Code started, so it has no screen to replay.",
      "",
      "reason   child_exited",
      "detail   pane child exited with code 1; last line: error: unknown option",
      "model    gpt-6-luna → Openai-codex",
      "records  ~/.claudish/sessions/ed2e9e42/",
    ]);
    const [claims] = runsOf(items, NOW);
    expect(failureCard(claims!.rows[0]!, "/Users/u").at(-1)).toBe(
      "records  ~/proj/ai-docs/sessions/viewclaims/"
    );
  });

  test("transcript lines read as speaker and text; a cont chunk joins its line", () => {
    expect(
      transcriptText([
        { kind: "user", text: "Read view-claims.ts" },
        { kind: "tool", text: "Read view-claims.ts (214 lines)" },
        { kind: "assistant", text: "The claim registry " },
        { kind: "assistant", text: "keeps one holder.", cont: true },
        { kind: "error", text: "boom" },
      ])
    ).toEqual([
      "user  Read view-claims.ts",
      "tool  Read view-claims.ts (214 lines)",
      "asst  The claim registry keeps one holder.",
      "err   boom",
    ]);
  });
});
