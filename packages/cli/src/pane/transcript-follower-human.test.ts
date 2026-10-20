/**
 * The human witness (hook-system architecture §3.2, §7.5, §19 H2): a prompt a human
 * typed into the interactive launcher's session, matched by PROVENANCE. Every record is
 * a real capture (phase-2 transcripts, Claude Code 2.1.290 / 2.1.291).
 *
 * The negative cases are the ones that bit: the captured background notifications are
 * non-meta, main-chain user records with plain-text content, so a shape-only witness
 * matched them and a re-wake read as a new human turn.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Rec, transcriptRecords } from "./test-helpers/transcript-fixtures.js";
import {
  TranscriptFollower,
  type Witness,
  applyRecord,
  initialFollowerState,
  isHumanPrompt,
  lastHumanPromptOffset,
  openTurnState,
  turnView,
} from "./transcript-follower.js";

const TOOLS = transcriptRecords("tools-session");
const LOCAL = transcriptRecords("local-commands");
/** 1-based fixture line numbers, as the architecture cites them. */
const line = (n: number): Rec => TOOLS[n - 1] as Rec;

const HUMAN: Witness = { kind: "human" };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpTranscript(records: Rec[]): string {
  const dir = mkdtempSync(join(tmpdir(), "human-witness-"));
  dirs.push(dir);
  const path = join(dir, "s.jsonl");
  writeFileSync(path, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
  return path;
}

/** One human-witness turn at offset 0, fed `records` in order. */
function feed(records: Rec[]) {
  const state = initialFollowerState((p) => p);
  openTurnState(state, { index: 1, offset: 0, witness: HUMAN });
  let offset = 1;
  for (const r of records) {
    applyRecord(state, r, offset);
    offset += 100;
  }
  return turnView(state.turns[0] as never);
}

describe("isHumanPrompt — provenance, not shape", () => {
  test("a typed prompt (origin.kind human) matches", () => {
    const r = line(5);
    expect(r.origin?.kind).toBe("human");
    expect(isHumanPrompt(r)).toBe(true);
  });

  test("the captured task notifications at tools-session.jsonl:54 and :74 never match", () => {
    for (const n of [54, 74]) {
      const r = line(n);
      // the shape a text-only rule would accept: main chain, not meta, plain content
      expect(r.type).toBe("user");
      expect(r.isSidechain).toBe(false);
      expect(r.isMeta).toBeUndefined();
      expect(typeof r.message.content).toBe("string");
      expect(isHumanPrompt(r)).toBe(false);
    }
  });

  test("a notification WITHOUT its origin field is still refused by its <task-notification> text", () => {
    const r = structuredClone(line(54));
    delete r.origin;
    expect(isHumanPrompt(r)).toBe(false);
  });

  test("an interrupt marker never matches, even dressed as human", () => {
    const interrupts = TOOLS.filter(
      (r) =>
        r.type === "user" &&
        typeof r.message?.content !== "string" &&
        JSON.stringify(r.message?.content).includes("[Request interrupted by user")
    );
    expect(interrupts.length).toBeGreaterThan(0);
    for (const r of interrupts) {
      expect(isHumanPrompt(r)).toBe(false);
      expect(isHumanPrompt({ ...r, origin: { kind: "human" } })).toBe(false);
    }
  });

  test("a compact summary, an isMeta record and a tool_result never match", () => {
    const summary = TOOLS.find((r) => r.isCompactSummary);
    const meta = LOCAL.find((r) => r.type === "user" && r.isMeta);
    const toolResult = TOOLS.find(
      (r) =>
        r.type === "user" &&
        Array.isArray(r.message?.content) &&
        r.message.content.some((b: Rec) => b.type === "tool_result")
    );
    for (const r of [summary, meta, toolResult]) {
      expect(r).toBeDefined();
      expect(isHumanPrompt(r as Rec)).toBe(false);
    }
  });

  test("a local command's records (/model, /compact typed line aside) never match", () => {
    const commands = LOCAL.filter(
      (r) =>
        r.type === "user" &&
        /^\s*<(local-command-caveat|command-name|local-command-stdout)>/.test(
          typeof r.message?.content === "string" ? r.message.content : ""
        )
    );
    expect(commands.length).toBeGreaterThan(0);
    for (const r of commands) expect(isHumanPrompt(r)).toBe(false);
  });

  test("a sidechain (subagent) user record never matches", () => {
    expect(isHumanPrompt({ ...line(5), isSidechain: true })).toBe(false);
  });

  test("a prompt with an origin naming anything but human is refused", () => {
    expect(isHumanPrompt({ ...line(5), origin: { kind: "hook" } })).toBe(false);
  });
});

describe("a human-witness turn", () => {
  test("is accepted by the typed prompt and folds its answer", () => {
    const answer = line(29);
    const v = feed([line(5), answer, line(30)]);
    expect(v.acceptedAt).toBe(line(5).timestamp);
    expect(v.lastAssistant).not.toBeNull();
    expect(v.unwitnessedChatOffset).toBeNull();
  });

  test("a notification and the model's reply to it do NOT open it: they are recorded as unwitnessed chat", () => {
    const notification = line(54);
    const reply = line(29);
    const v = feed([notification, reply]);
    expect(v.acceptedAt).toBeNull();
    expect(v.lastAssistant).toBeNull();
    // the offset of the notification: the first record of the re-wake
    expect(v.unwitnessedChatOffset).toBe(1);
  });

  test("an assistant record alone (a continuation with no prompt) is unwitnessed chat", () => {
    const v = feed([line(29)]);
    expect(v.acceptedAt).toBeNull();
    expect(v.unwitnessedChatOffset).toBe(1);
  });

  test("state records before the prompt are not chat", () => {
    const v = feed([line(1), line(2), line(5)]);
    expect(v.acceptedAt).not.toBeNull();
    expect(v.unwitnessedChatOffset).toBeNull();
  });
});

describe("TranscriptFollower.rewindTo and lastHumanPromptOffset", () => {
  test("rewindTo re-reads a turn from its own offset", () => {
    const path = tmpTranscript([line(5), line(29), line(30)]);
    const f = new TranscriptFollower(path, join(path, "..", "subagents"));
    f.openTurn({ index: 1, offset: 0, witness: HUMAN });
    f.poll();
    expect(f.view().current?.acceptedAt).not.toBeNull();
    // the next turn opens at the end, and a notification + reply arrive
    f.openTurn({ index: 2, offset: f.size(), witness: HUMAN });
    appendFileSync(path, `${JSON.stringify(line(54))}\n${JSON.stringify(line(29))}\n`);
    f.poll();
    expect(f.view().current?.acceptedAt).toBeNull();
    expect(f.view().current?.unwitnessedChatOffset).not.toBeNull();
    // re-open turn 1: its prompt, its first answer AND the continuation are its records
    f.rewindTo({ index: 1, offset: 0, witness: HUMAN });
    const v = f.view().current;
    expect(v?.index).toBe(1);
    expect(v?.acceptedAt).toBe(line(5).timestamp);
    expect(v?.wakingAfterLast).toBe(false);
    expect(v?.assistantText.length).toBe(2);
  });

  test("lastHumanPromptOffset finds the line of the last typed prompt, skipping notifications", () => {
    const records = [line(1), line(5), line(29), line(54), line(29)];
    const path = tmpTranscript(records);
    const lengths = records.map((r) => Buffer.byteLength(`${JSON.stringify(r)}\n`));
    expect(lastHumanPromptOffset(path)).toBe((lengths[0] as number) + 0);
    const second: Rec = { ...line(5), message: { ...line(5).message, content: "second prompt" } };
    appendFileSync(path, `${JSON.stringify(second)}\n`);
    const total = lengths.reduce((a, b) => a + b, 0);
    expect(lastHumanPromptOffset(path)).toBe(total);
    // a turn opened there is accepted by that prompt alone
    const f = new TranscriptFollower(path, join(path, "..", "subagents"));
    f.rewindTo({ index: 1, offset: total, witness: HUMAN });
    expect(f.view().current?.acceptedAt).toBe(second.timestamp);
  });

  test("lastHumanPromptOffset is null for a transcript with no human prompt, and for none at all", () => {
    expect(lastHumanPromptOffset(tmpTranscript([line(1), line(54)]))).toBeNull();
    expect(lastHumanPromptOffset(join(tmpdir(), "no-such-transcript.jsonl"))).toBeNull();
  });
});
