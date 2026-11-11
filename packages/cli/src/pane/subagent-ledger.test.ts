import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUBAGENT_DESCRIPTION_MAX, SUBAGENT_ROW_LIMIT, SubagentLedger } from "./subagent-ledger.js";
import { TranscriptFollower } from "./transcript-follower.js";

/**
 * Test data: two real Claude Code 2.1.322 runs (spike S8), redacted. `subagents-foreground` has two
 * parallel foreground calls (`alpha`, `beta`) whose results arrive at the end; `subagents-parallel`
 * has three calls whose results say `isAsync` at once and which end with task notifications.
 */
const DATA = join(import.meta.dir, "test-fixtures", "transcripts");
const ALPHA_FG = "a57cc731c10fb31f0";
const BETA_FG = "a79f0431152cbfbf3";
const ALPHA_CALL_FG = "toolu_01NuNoRdHQqvHN9RuXc4vDv9";

type Rec = Record<string, unknown>;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A session directory the test writes into the way Claude Code would, one step at a time. */
function stage(name: string) {
  const dir = mkdtempSync(join(tmpdir(), "subagent-ledger-"));
  dirs.push(dir);
  const main = join(dir, "t.jsonl");
  const sub = join(dir, "t", "subagents");
  mkdirSync(sub, { recursive: true });
  writeFileSync(main, "");
  const src = join(DATA, name);
  const mainLines = readFileSync(join(src, "main.jsonl"), "utf8").trim().split("\n");
  const agentLines = (id: string) =>
    readFileSync(join(src, "subagents", `agent-${id}.jsonl`), "utf8")
      .trim()
      .split("\n");
  let t = 0;
  const follower = new TranscriptFollower(main, sub, {
    now: () => Date.parse("2026-11-10T08:00:00Z") + t++,
  });
  follower.openTurn({ index: 1, offset: 0, witness: { kind: "human" } });
  return {
    follower,
    main,
    sub,
    mainLine: (i: number, edit?: (r: Rec) => void) => {
      const r = JSON.parse(mainLines[i] as string) as Rec;
      edit?.(r);
      appendFileSync(main, `${JSON.stringify(r)}\n`);
    },
    agentLine: (id: string, i: number, edit?: (r: Rec) => void, as = id) => {
      const r = JSON.parse(agentLines(id)[i] as string) as Rec;
      edit?.(r);
      appendFileSync(join(sub, `agent-${as}.jsonl`), `${JSON.stringify(r)}\n`);
    },
    agentCount: (id: string) => agentLines(id).length,
    /** the meta as written at launch (no `finished`), or as replaced at the end */
    meta: (id: string, opts: { finished?: boolean; mtime?: number } = {}) => {
      const m = JSON.parse(readFileSync(join(src, "subagents", `agent-${id}.meta.json`), "utf8"));
      if (!opts.finished) delete m.finished;
      const p = join(sub, `agent-${id}.meta.json`);
      writeFileSync(p, `${JSON.stringify(m)}\n`);
      // a replaced meta file has a new mtime; make sure the follower can see it in a fast test
      if (opts.mtime !== undefined) utimesSync(p, opts.mtime, opts.mtime);
    },
    rows: () => {
      follower.poll();
      return follower.subagents().rows;
    },
    byId: (id: string) => {
      follower.poll();
      return follower.subagents().rows.find((r) => r.id === id);
    },
  };
}

function setPrompt(text: string) {
  return (r: Rec) => {
    const m = r.message as { content: unknown };
    if (typeof m.content === "string") m.content = text;
    else
      for (const b of m.content as Array<Record<string, Record<string, unknown>>>)
        if (b.type === ("tool_use" as unknown)) (b.input as Record<string, unknown>).prompt = text;
  };
}

describe("subagent ledger: links come from evidence, never from order", () => {
  test("files created in reverse call order: each meta links its own call at launch", () => {
    const s = stage("subagents-foreground");
    s.mainLine(0); // alpha's call
    s.mainLine(1); // beta's call
    s.meta(BETA_FG); // beta's files appear first
    s.agentLine(BETA_FG, 0);
    expect(s.rows()).toEqual([
      {
        id: BETA_FG,
        description: "beta probe",
        subagent_type: "general-purpose",
        mode: "foreground",
        state: "running",
        started_at: "2026-11-10T08:22:52.122Z",
        tool_calls: 0,
        tokens_out: null,
      },
    ]);
    s.meta(ALPHA_FG);
    s.agentLine(ALPHA_FG, 0);
    // rows are ordered by when each subagent started, not by when its file was seen
    const rows = s.rows();
    expect(rows.map((r) => [r.id, r.description, r.state])).toEqual([
      [ALPHA_FG, "alpha probe", "running"],
      [BETA_FG, "beta probe", "running"],
    ]);
    for (const id of [ALPHA_FG, BETA_FG])
      for (let i = 1; i < s.agentCount(id); i++) s.agentLine(id, i);
    s.mainLine(2); // alpha's result: a foreground call answers when its subagent is done
    expect(s.byId(ALPHA_FG)).toMatchObject({ state: "done", tool_calls: 1, tokens_out: 89 });
    expect(s.byId(BETA_FG)).toMatchObject({ state: "running", tool_calls: 1, tokens_out: 87 });
    s.mainLine(3);
    expect(s.byId(BETA_FG)).toMatchObject({ state: "done", description: "beta probe" });
  });

  test("no meta, the same prompt twice, files reversed: unlinked until the results, never swapped", () => {
    const s = stage("subagents-foreground");
    const same = setPrompt("<prompt shared>");
    s.mainLine(0, same);
    s.mainLine(1, same);
    s.agentLine(BETA_FG, 0, same);
    s.agentLine(ALPHA_FG, 0, same);
    expect(s.rows().map((r) => [r.id, r.description])).toEqual([
      [ALPHA_FG, null],
      [BETA_FG, null],
    ]);
    s.mainLine(2); // alpha's result names its agent: the authoritative link
    expect(s.byId(ALPHA_FG)).toMatchObject({ description: "alpha probe", state: "done" });
    // beta is now the only subagent that can hold the other call
    expect(s.byId(BETA_FG)).toMatchObject({ description: "beta probe", state: "running" });
    s.mainLine(3);
    expect(s.byId(BETA_FG)).toMatchObject({ description: "beta probe", state: "done" });
  });

  test("a provisional link by prompt is replaced when the authoritative one appears", () => {
    const s = stage("subagents-foreground");
    const nested = "a0000000000000001";
    s.mainLine(0);
    s.mainLine(1);
    // another subagent whose first record repeats alpha's prompt appears before alpha's own file
    s.agentLine(ALPHA_FG, 0, undefined, nested);
    expect(s.byId(nested)).toMatchObject({ description: "alpha probe" });
    s.agentLine(ALPHA_FG, 0);
    expect(s.byId(ALPHA_FG)).toMatchObject({ description: null });
    s.meta(ALPHA_FG); // names alpha's call
    expect(s.byId(ALPHA_FG)).toMatchObject({
      description: "alpha probe",
      subagent_type: "general-purpose",
    });
    expect(s.byId(nested)).toMatchObject({ description: null, subagent_type: null });
  });

  test("background calls: linked at their isAsync result, done at the task notification", () => {
    const s = stage("subagents-parallel");
    for (let i = 0; i < 6; i++) s.mainLine(i);
    const rows = s.rows();
    expect(rows.map((r) => [r.description, r.mode, r.state])).toEqual([
      ["alpha probe", "background", "running"],
      ["beta probe", "background", "running"],
      ["gamma probe", "background", "running"],
    ]);
    // each row was created by its result, before any file was seen
    expect(rows.map((r) => r.tokens_out)).toEqual([null, null, null]);
    for (let i = 6; i < 11; i++) s.mainLine(i);
    expect(s.rows().map((r) => r.state)).toEqual(["done", "done", "done"]);
  });

  test("a replaced meta with finished: true ends the row", () => {
    const s = stage("subagents-foreground");
    s.mainLine(0);
    s.meta(ALPHA_FG, { mtime: 1_000 });
    expect(s.byId(ALPHA_FG)).toMatchObject({ state: "running" });
    s.meta(ALPHA_FG, { finished: true, mtime: 2_000 });
    expect(s.byId(ALPHA_FG)).toMatchObject({ state: "done" });
  });
});

describe("subagent ledger: idempotent folds", () => {
  test("rewindTo re-folds the main chain and leaves rows and version unchanged", () => {
    const s = stage("subagents-foreground");
    s.mainLine(0);
    s.mainLine(1);
    s.meta(BETA_FG);
    s.meta(ALPHA_FG);
    for (const id of [BETA_FG, ALPHA_FG])
      for (let i = 0; i < s.agentCount(id); i++) s.agentLine(id, i);
    s.mainLine(2);
    s.mainLine(3);
    s.mainLine(4);
    const before = structuredClone(s.rows());
    const version = s.follower.subagents().version;
    s.follower.rewindTo({ index: 1, offset: 0, witness: { kind: "human" } });
    expect(s.follower.subagents().rows).toEqual(before);
    expect(s.follower.subagents().version).toBe(version);
    // from the second line: the first call is not folded again, the rest are
    const second = readFileSync(s.main, "utf8").indexOf("\n") + 1;
    s.follower.rewindTo({ index: 1, offset: second, witness: { kind: "human" } });
    expect(s.rows()).toEqual(before);
    expect(s.follower.subagents().version).toBe(version);
  });

  test("the same records folded twice into the ledger count once", () => {
    const ledger = new SubagentLedger();
    const lines = readFileSync(join(DATA, "subagents-parallel", "main.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    for (const r of lines) ledger.foldMain(r, "2026-11-10T08:00:00Z");
    const rows = structuredClone(ledger.rows());
    const version = ledger.version;
    for (const r of lines) ledger.foldMain(r, "2026-11-10T09:00:00Z");
    expect(ledger.rows()).toEqual(rows);
    expect(ledger.version).toBe(version);
  });

  test("nothing changes the version while nothing is written", () => {
    const s = stage("subagents-foreground");
    s.mainLine(0);
    s.meta(ALPHA_FG);
    s.agentLine(ALPHA_FG, 0);
    s.rows();
    const v = s.follower.subagents().version;
    for (let i = 0; i < 5; i++) s.follower.poll();
    expect(s.follower.subagents().version).toBe(v);
  });
});

describe("subagent ledger: bounds and redaction", () => {
  test(`keeps the ${SUBAGENT_ROW_LIMIT} newest rows and never brings an evicted one back`, () => {
    const s = stage("subagents-foreground");
    const ids = Array.from({ length: 25 }, (_, i) => `a${String(i).padStart(16, "0")}`);
    ids.forEach((id, i) => {
      const at = new Date(Date.parse("2026-11-10T08:00:00Z") + i * 1000).toISOString();
      appendFileSync(
        join(s.sub, `agent-${id}.jsonl`),
        `${JSON.stringify({ type: "user", isSidechain: true, agentId: id, timestamp: at, message: { role: "user", content: `<prompt ${i}>` } })}\n`
      );
      writeFileSync(
        join(s.sub, `agent-${id}.meta.json`),
        JSON.stringify({ agentType: "Explore", description: `probe ${i}`, toolUseId: `toolu_${i}` })
      );
    });
    const rows = s.rows();
    expect(rows).toHaveLength(SUBAGENT_ROW_LIMIT);
    expect(rows.map((r) => r.id)).toEqual(ids.slice(5));
    expect(rows[0]).toMatchObject({ description: "probe 5", subagent_type: "Explore" });
    const v = s.follower.subagents().version;
    appendFileSync(
      join(s.sub, `agent-${ids[0]}.jsonl`),
      `${JSON.stringify({ type: "assistant", isSidechain: true, timestamp: "2026-11-10T09:00:00Z", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }], usage: { output_tokens: 5 } } })}\n`
    );
    expect(s.rows().map((r) => r.id)).toEqual(ids.slice(5));
    expect(s.follower.subagents().version).toBe(v);
  });

  test("a description is masked, put on one line and cut to 100 characters", () => {
    const s = stage("subagents-foreground");
    const key = `${"sk-"}${"ant-"}${"api03-"}${"Q".repeat(40)}`;
    s.mainLine(0, (r) => {
      const b = (r.message as { content: Array<{ input: Record<string, unknown> }> }).content[0];
      if (b) b.input.description = `check\nthe ${key} key ${"x".repeat(200)}`;
    });
    s.mainLine(2); // the result links alpha by its agent id; no meta, so the call's description shows
    const d = s.byId(ALPHA_FG)?.description ?? "";
    expect(d).not.toContain("Q".repeat(20));
    expect(d).not.toContain("\n");
    expect(d.startsWith("check the ")).toBe(true);
    expect(d.length).toBeLessThanOrEqual(SUBAGENT_DESCRIPTION_MAX);
    expect(d.length).toBe(SUBAGENT_DESCRIPTION_MAX);
  });

  test("a task notification for a background shell creates no row", () => {
    const ledger = new SubagentLedger();
    ledger.foldMain(
      {
        type: "user",
        origin: { kind: "task-notification" },
        message: {
          content:
            "<task-notification>\n<task-id>bq1x2y3z</task-id>\n<status>completed</status>\n</task-notification>",
        },
      },
      "2026-11-10T08:00:00Z"
    );
    expect(ledger.rows()).toEqual([]);
    expect(ledger.version).toBe(0);
  });

  test("the call's prompt is never kept, only a digest of it", () => {
    const s = stage("subagents-foreground");
    s.mainLine(0, setPrompt("<prompt that must not be kept>"));
    s.rows();
    const ledger = (s.follower as unknown as { state: { ledger: unknown } }).state.ledger;
    const seen = JSON.stringify(ledger, (_k, v) =>
      v instanceof Map ? Object.fromEntries(v) : v instanceof Set ? [...v] : v
    );
    expect(seen).not.toContain("must not be kept");
    expect(seen).toContain(ALPHA_CALL_FG);
  });
});
