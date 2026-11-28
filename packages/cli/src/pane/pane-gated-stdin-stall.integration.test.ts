/**
 * A prompt sent while Claude Code has drawn its box but is not reading stdin. Real pinned
 * magmux, fake child, PRODUCTION timings.
 *
 * Under concurrent boot Claude Code 2.1.330 drew the box and then read nothing for about
 * 20 s. Every byte sent meanwhile queued unread, and was then read in one long read, inside
 * which Claude Code ignores ctrl-u (measured for a read of about 64 bytes or more). A clear
 * and a new copy sent during the stall therefore landed as copies joined end to end, and
 * the slot failed prompt_not_accepted with the line in the box five times. The fake child's
 * `FAKE_STDIN_STALL_MS` mode reproduces both facts. While the box shows nothing, claudish
 * must add no typed copy and no ctrl-u to the one it already sent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writtenPrefix } from "./input-gate.js";
import { PROMPT, T } from "./test-helpers/gated-delivery.js";
import {
  DISPOSE_GATE_PANES_HOOK_MS,
  disposeGatePanes,
  gateUntil,
  pointerOf,
  startGatePane,
  submissions,
} from "./test-helpers/gated-pane.js";
import {
  MAGMUX,
  MAGMUX_TYPES_ON_EVIDENCE,
  NO_MAGMUX_MESSAGE,
} from "./test-helpers/hermetic-env.js";

const STALL_MS = 12_000;

function copiesOf(text: string, line: string): number {
  return text.split(line).length - 1;
}

describe.skipIf(!MAGMUX)(
  `a box drawn while stdin is not read (${MAGMUX ? "real magmux" : NO_MAGMUX_MESSAGE})`,
  () => {
    afterEach(disposeGatePanes, DISPOSE_GATE_PANES_HOOK_MS);

    test(
      "a prompt sent during a 12 s stdin stall is typed by claudish once, never cleared unseen, and submitted as one copy",
      async () => {
        let stallLog = "";
        const r = await startGatePane("answer", {
          shape: "one-shot",
          initialPrompt: PROMPT,
          env: { FAKE_STDIN_STALL_MS: String(STALL_MS), FAKE_GAP_MS_WITNESS: "1000" },
          prepare(t) {
            stallLog = join(t.tmp, "stall.jsonl");
            t.env.FAKE_STDIN_STALL_LOG = stallLog;
            return {};
          },
        });
        const snapshot = await gateUntil(
          r,
          (s) => s.state === "COMPLETED" || s.state === "FAILED",
          60_000
        );
        expect(existsSync(stallLog)).toBe(true);
        const stall = JSON.parse(readFileSync(stallLog, "utf8").split("\n")[0] as string) as {
          endedAt: number;
          text: string;
        };
        const sentUnseen = r.sends.filter(({ at }) => at < stall.endedAt);
        const typedUnseen = sentUnseen.filter(
          ({ message }) => typeof message.text === "string" && message.noGate !== true
        );
        const clearsUnseen = sentUnseen.filter(
          ({ message }) =>
            message.noGate === true &&
            ((message.keys as string[] | undefined) ?? []).includes("ctrl-u")
        );
        // claudish sent one gated send while the box was unread, and magmux (>= 0.20.2) types a
        // send once and never retypes it
        expect(typedUnseen).toHaveLength(1);
        expect(clearsUnseen).toHaveLength(0);
        if (MAGMUX_TYPES_ON_EVIDENCE) {
          // magmux wrote the first chunk and nothing more while the box did not show it, then
          // stopped; once the stall ends the written part is drawn, cleared, and typed again
          const first = r.sends[0]?.reply as Record<string, unknown> | undefined;
          expect(first).toMatchObject({ ok: false, typingStopped: "deadline" });
          expect(stall.text).toBe(writtenPrefix(pointerOf(r), first?.writes as number, true));
          expect(stall.text.length).toBeLessThan(pointerOf(r).length);
          expect(snapshot.anomalies).toContain("box_drawn_written_part");
          const typed = r.sends.filter(
            ({ message }) => typeof message.text === "string" && message.noGate !== true
          );
          expect(typed).toHaveLength(2);
          expect(typed[1]?.at ?? 0).toBeGreaterThanOrEqual(stall.endedAt);
        } else {
          // magmux wrote the whole line at its fixed pace: the backlog is one copy
          expect(copiesOf(stall.text, pointerOf(r))).toBe(1);
        }
        expect(snapshot.state).toBe("COMPLETED");
        expect(submissions(r).map(({ text }) => text)).toEqual([pointerOf(r)]);
      },
      T
    );

    test(
      "a stall that outlasts the 30 s admission ends prompt_not_accepted with one typed send and a detail that says the box stayed empty",
      async () => {
        const r = await startGatePane("answer", {
          shape: "one-shot",
          initialPrompt: PROMPT,
          env: { FAKE_STDIN_STALL_MS: "45000" },
        });
        const snapshot = await gateUntil(
          r,
          (s) => s.state === "COMPLETED" || s.state === "FAILED",
          60_000
        );
        expect(snapshot.state).toBe("FAILED");
        expect(snapshot.reason).toBe("prompt_not_accepted");
        expect(snapshot.detail).toContain("not_accepted text_mismatch");
        expect(snapshot.detail).toContain("the input box stayed empty");
        const typed = r.sends.filter(
          ({ message }) => typeof message.text === "string" && message.noGate !== true
        );
        const clears = r.sends.filter(
          ({ message }) =>
            message.noGate === true &&
            ((message.keys as string[] | undefined) ?? []).includes("ctrl-u")
        );
        expect(typed).toHaveLength(1);
        expect(clears).toHaveLength(0);
        expect(submissions(r)).toEqual([]);
      },
      T
    );

    // magmux before 0.20.4 types a long line in 32-rune writes 8 ms apart. Claude Code can read
    // and draw the first writes and then stop reading: magmux then sees part of the line and
    // answers text_mismatch with boxEmpty false. A ctrl-u and a second copy sent then would
    // queue behind the unread tail and be read with it in one long read, where the ctrl-u is
    // lost. magmux 0.20.4+ writes the next chunk only once the box shows the ones before it, so
    // it waits out the stall inside the send and finishes the line itself.
    test(
      "a stall after the first typed write: no ctrl-u and no second copy while the tail is unread, then Enter alone",
      async () => {
        let prompt = "Reply with exactly PEAR";
        for (let i = 0; prompt.length < 300; i++) prompt += ` and word${i}`;
        prompt += ".";
        let stallLog = "";
        const r = await startGatePane("answer", {
          shape: "one-shot",
          initialPrompt: prompt,
          initialSize: { cols: 80, rows: 40 },
          env: {
            FAKE_STDIN_STALL_MS: "8000",
            FAKE_STDIN_STALL_AFTER_BYTES: "1",
            FAKE_GAP_MS_WITNESS: "1000",
          },
          prepare(t) {
            stallLog = join(t.tmp, "stall.jsonl");
            t.env.FAKE_STDIN_STALL_LOG = stallLog;
            return {};
          },
        });
        const snapshot = await gateUntil(
          r,
          (s) => s.state === "COMPLETED" || s.state === "FAILED",
          60_000
        );
        expect(existsSync(stallLog)).toBe(true);
        const stall = JSON.parse(readFileSync(stallLog, "utf8").split("\n")[0] as string) as {
          endedAt: number;
          text: string;
        };
        // the case proves something only if part of the line was held unread: the held bytes
        // start inside the line, after its start
        const head = stall.text.slice(0, 16);
        expect(head.length).toBeGreaterThan(0);
        expect(pointerOf(r).indexOf(head)).toBeGreaterThan(0);
        const typed = r.sends.filter(
          ({ message }) => typeof message.text === "string" && message.noGate !== true
        );
        const clears = r.sends.filter(
          ({ message }) =>
            message.noGate === true &&
            ((message.keys as string[] | undefined) ?? []).includes("ctrl-u")
        );
        expect(typed).toHaveLength(1);
        expect(clears).toHaveLength(0);
        if (MAGMUX_TYPES_ON_EVIDENCE) {
          // the one send wrote every chunk and was answered only after the stall ended
          const reply = typed[0]?.reply as { ok?: boolean; result?: Record<string, unknown> };
          expect(reply?.ok).toBe(true);
          expect(reply?.result?.writes).toBe(reply?.result?.writesTotal);
          expect(typed[0]?.repliedAt ?? 0).toBeGreaterThanOrEqual(stall.endedAt);
        } else {
          expect(snapshot.anomalies).toContain("box_drawn_after_mismatch");
          const enters = r.sends.filter(
            ({ message, at }) =>
              at >= stall.endedAt &&
              message.noGate !== true &&
              typeof message.text !== "string" &&
              ((message.keys as string[] | undefined) ?? [])[0] === "enter"
          );
          expect(enters.length).toBeGreaterThanOrEqual(1);
        }
        expect(snapshot.state).toBe("COMPLETED");
        expect(submissions(r).map(({ text }) => text)).toEqual([pointerOf(r)]);
      },
      T
    );
  }
);

// A frame with no input box between two typed writes: magmux before 0.20.3 stopped the send
// there and answered as if it had typed the whole line, and claudish then waited for the rest
// of a line that was never written. A send that keeps typing, or one that says it stopped,
// ends with the pointer line submitted once.
describe.skipIf(!MAGMUX)(
  `a frame with no box while a pointer line is typed (${MAGMUX ? "real magmux" : NO_MAGMUX_MESSAGE})`,
  () => {
    afterEach(disposeGatePanes, DISPOSE_GATE_PANES_HOOK_MS);

    test(
      "a file-delivered turn whose box vanishes for 300 ms after 40 bytes completes with one submit, the pointer line",
      async () => {
        const prompt = "Reply with exactly PEAR.\nThe second line makes this a file turn.";
        const r = await startGatePane("answer", {
          shape: "one-shot",
          initialPrompt: prompt,
          initialSize: { cols: 120, rows: 40 },
          env: { FAKE_BLANK_FRAME_AFTER_BYTES: "40", FAKE_BLANK_FRAME_MS: "300" },
        });
        const snapshot = await gateUntil(
          r,
          (s) => s.state === "COMPLETED" || s.state === "FAILED",
          60_000
        );
        expect(snapshot.state).toBe("COMPLETED");
        const typed = r.sends.filter(
          ({ message }) => typeof message.text === "string" && message.noGate !== true
        );
        const pointer = typed.at(-1)?.message.text as string;
        expect(pointer).toMatch(/^Your task is in the file `.+`\. Read all of it/);
        expect(submissions(r).map(({ text }) => text)).toEqual([pointer]);
        expect(r.turns[0]?.delivery).toMatchObject({ mode: "file", complete: true });
      },
      T
    );
  }
);
