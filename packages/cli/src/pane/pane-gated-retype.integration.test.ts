/** §10.2/R1.9: redials, retypes, ignored Enters, vim mode and boot dialogs. Real pinned magmux, fake child, PRODUCTION timings. */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifySendReply, mismatchBoxStayedEmpty } from "./input-gate.js";
import {
  LOSS_RECORD_WAIT_MS,
  PROMPT,
  T,
  assertLoudLoss,
  assertOneCopy,
  screen,
  settled,
} from "./test-helpers/gated-delivery.js";
import {
  DISPOSE_GATE_PANES_HOOK_MS,
  clientOf,
  disposeGatePanes,
  gateUntil,
  gatedSends,
  startGatePane,
  submissions,
} from "./test-helpers/gated-pane.js";
import { MAGMUX, NO_MAGMUX_MESSAGE } from "./test-helpers/hermetic-env.js";
import { wrapPrompt } from "./test-helpers/repl-wrap.js";

/** A prompt of about 300 characters, which wraps onto several rows at 80 columns. */
function longPrompt(): string {
  let prompt = "Reply with exactly PEAR";
  for (let i = 0; prompt.length < 300; i++) prompt += ` and word${i}`;
  return `${prompt}.`;
}

const isTypedSend = (m: Record<string, unknown>) => typeof m.text === "string" && m.noGate !== true;

const isClearSend = (m: Record<string, unknown>) =>
  m.noGate === true &&
  Array.isArray(m.keys) &&
  (m.keys as string[]).length > 0 &&
  (m.keys as string[]).every((k) => k === "ctrl-u");

describe.skipIf(!MAGMUX)(
  `gated retypes at production timings (${MAGMUX ? "real magmux" : NO_MAGMUX_MESSAGE})`,
  () => {
    // One disposal awaits reaped() and then polls up to 8 s for orphans; 5 s is bun's default.
    afterEach(disposeGatePanes, DISPOSE_GATE_PANES_HOOK_MS);

    test(
      "I17: a real socket drop during SUBMIT leaves magmux delivering, and the own witness accepts once",
      async () => {
        const r = await startGatePane("answer", {
          shape: "one-shot",
          initialPrompt: PROMPT,
          env: { FAKE_GAP_MS_WITNESS: "6000", FAKE_RENDER_LAG_MS: "800" },
        });
        const client = clientOf(r);
        const real = client.request.bind(client);
        let dropped = false;
        client.request = async (message, timeout) => {
          const delivery = real(message, timeout);
          if (message.type === "send" && typeof message.text === "string" && !dropped) {
            dropped = true;
            // Verification alone takes >= 1.2 s; close while that real request is out.
            await Bun.sleep(100);
            client.close();
          }
          return delivery;
        };
        await settled(r);
        expect(dropped).toBe(true);
        assertOneCopy(r, PROMPT);
        expect(gatedSends(r)[0]?.reply).toMatchObject({ ok: false, code: "client_lost" });
        expect(r.s.snapshot().anomalies).toContain("send_reply_lost");
        expect(r.s.snapshot().anomalies).toContain("socket_reconnected");
      },
      T
    );

    test(
      "I6: a created /cost prompt dismisses its panel once, then fails prompt_not_accepted with the panel detail",
      async () => {
        const r = await startGatePane("answer", { shape: "one-shot", initialPrompt: "/cost" });
        const snapshot = await gateUntil(r, (s) => s.state === "FAILED");
        expect(snapshot.reason).toBe("prompt_not_accepted");
        expect(snapshot.detail).toContain("/cost opened a panel");
        expect(snapshot.anomalies).toContain("panel_dismissed");
        expect(snapshot.anomalies).toContain("panel_command");
        expect(
          r.sends.filter(({ message }) =>
            (message.keys as string[] | undefined)?.includes("escape")
          )
        ).toHaveLength(1);
        expect(submissions(r).map(({ text }) => text)).toEqual(["/cost"]);
        expect(r.turns).toHaveLength(0);
      },
      T
    );

    // magmux >= 0.20.2 never retypes, and claudish types no second copy onto a box that
    // shows nothing: a copy that is truly lost (here swallowed by the child, by a late stdin
    // reset or a dropped first burst) ends in a loud prompt_not_accepted with one copy sent,
    // which the caller can resend, never in a copy stacked behind one that may be unread.
    for (const scenario of ["late_reset_swallow", "drop_first_prompt"] as const) {
      test(
        `DB-3 / F13: ${scenario} fails prompt_not_accepted with one typed copy and no retype`,
        async () => {
          const r = await startGatePane(scenario, {
            shape: "one-shot",
            initialPrompt: PROMPT,
            env: { FAKE_RENDER_LAG_MS: "800", FAKE_GAP_MS_WITNESS: "5000" },
          });
          const snapshot = await gateUntil(r, (s) => s.state === "FAILED", 45_000);
          expect(snapshot.reason).toBe("prompt_not_accepted");
          expect(snapshot.detail).toContain("the input box stayed empty");
          expect(gatedSends(r).filter(({ message }) => isTypedSend(message))).toHaveLength(1);
          expect(r.sends.filter(({ message }) => isClearSend(message))).toHaveLength(0);
          expect(
            gatedSends(r).every(({ reply }) => !reply?.ok || reply.result.retyped !== true)
          ).toBe(true);
          expect(submissions(r)).toEqual([]);
        },
        T
      );
    }

    test(
      "I8: an ignored Enter yields still_in_box once: no ctrl-u, no second typed copy, a loud loss",
      async () => {
        const r = await startGatePane("enter_ignored_forever", {
          unprovenRecordWaitMs: LOSS_RECORD_WAIT_MS,
          shape: "one-shot",
          initialPrompt: PROMPT,
        });
        await assertLoudLoss(r, "still_in_box");
        expect(r.s.snapshot().detail).toContain(
          "Enter pressed, line then still in the box; last screen: line still in the box; no transcript record of it in"
        );
        expect(gatedSends(r)).toHaveLength(1);
        expect(
          gatedSends(r).every(({ reply }) => !reply?.ok && reply?.reason === "still_in_box")
        ).toBe(true);
        expect(
          r.sends.filter(({ message }) =>
            (message.keys as string[] | undefined)?.includes("ctrl-u")
          )
        ).toHaveLength(0);
        const count = r.sends.length;
        await Bun.sleep(1000);
        expect(r.sends).toHaveLength(count);
      },
      T
    );

    test(
      "I9: history withheld gives unconfirmed; only the delayed own transcript witness accepts",
      async () => {
        const r = await startGatePane("history_withheld", {
          shape: "one-shot",
          initialPrompt: PROMPT,
          env: { FAKE_GAP_MS_WITNESS: "9000" },
        });
        await settled(r);
        assertOneCopy(r, PROMPT);
        expect(gatedSends(r)[0]?.reply).toMatchObject({
          ok: false,
          code: "not_accepted",
          reason: "unconfirmed",
        });
        expect(r.s.snapshot().anomalies).toContain("gate_unconfirmed");
        expect(readFileSync(r.transcript, "utf8")).toContain(PROMPT);
      },
      T
    );

    test(
      "I10: vim insert after boot fails the created admission with vim_mode, not a 30 s timeout",
      async () => {
        const r = await startGatePane("vim_insert", {
          shape: "one-shot",
          initialPrompt: PROMPT,
          prepare(t) {
            t.env.FAKE_VIM_FILE = join(t.tmp, "enable-vim");
            return {};
          },
        });
        const client = clientOf(r);
        const real = client.request.bind(client);
        client.request = async (message, timeout) => {
          if (message.type === "send" && typeof message.text === "string") {
            writeFileSync(r.t.env.FAKE_VIM_FILE as string, "on");
            await gateUntil(r, () => r.s.diagnostics().gate?.reason === "vim_mode");
          }
          return real(message, timeout);
        };
        const snapshot = await gateUntil(r, (s) => s.state === "FAILED");
        expect(snapshot.reason).toBe("prompt_not_accepted");
        expect(snapshot.detail).toContain("vim");
        expect(snapshot.detail).toContain("-- INSERT --");
        expect(snapshot.anomalies).toContain("gate_vim_mode");
        expect(submissions(r)).toEqual([]);
        expect(
          (r.transitions.find(({ to }) => to === "FAILED")?.at ?? Number.POSITIVE_INFINITY) -
            (gatedSends(r)[0]?.at ?? 0)
        ).toBeLessThan(12_000);
      },
      T
    );

    test(
      "I10b: vim insert before the send fails prompt_not_accepted within 5 s without a gated send",
      async () => {
        const r = await startGatePane("vim_insert", {
          shape: "one-shot",
          initialPrompt: PROMPT,
          prepare(t) {
            t.env.FAKE_VIM_FILE = join(t.tmp, "enable-vim");
            return {};
          },
        });
        // Pause before the admission pre-check, not inside an already-started send (I10).
        const driver = r.s as unknown as { runAdmission(admission: unknown): Promise<void> };
        const real = driver.runAdmission.bind(driver);
        let paused = false;
        let resume = () => {};
        const beforePrecheck = new Promise<void>((resolve) => {
          resume = resolve;
        });
        driver.runAdmission = async (admission) => {
          paused = true;
          await beforePrecheck;
          return real(admission);
        };
        try {
          await gateUntil(r, () => paused);
          writeFileSync(r.t.env.FAKE_VIM_FILE as string, "on");
          await gateUntil(
            r,
            () =>
              r.s.diagnostics().gate?.reason === "vim_mode" &&
              screen(r).lines.some((line) => line.includes("-- INSERT --"))
          );
          const startedAt = Date.now();
          resume();
          const snapshot = await gateUntil(r, (s) => s.state === "FAILED", 5000);
          expect(snapshot.reason).toBe("prompt_not_accepted");
          expect(snapshot.detail).toContain("vim");
          expect(snapshot.detail).toContain("-- INSERT --");
          expect(snapshot.anomalies).toContain("gate_vim_mode");
          expect(
            (r.transitions.find(({ to }) => to === "FAILED")?.at ?? Number.POSITIVE_INFINITY) -
              startedAt
          ).toBeLessThan(5000);
          expect(gatedSends(r)).toEqual([]);
          expect(submissions(r)).toEqual([]);
          expect(r.turns).toHaveLength(0);
        } finally {
          resume();
        }
      },
      T
    );

    test(
      "I11: a trust dialog fails with its words and no key is ever sent during boot",
      async () => {
        const r = await startGatePane("dialog_trust", { shape: "one-shot", initialPrompt: PROMPT });
        const snapshot = await gateUntil(r, (s) => s.state === "FAILED");
        expect(snapshot.reason).toBe("first_run_dialog");
        expect(snapshot.detail).toContain("Is this a project you created or one you trust");
        expect(r.sends).toEqual([]);
        expect(submissions(r)).toEqual([]);
      },
      T
    );

    // Under load Claude Code draws typed text seconds after reading it, so magmux can answer
    // text_mismatch with the box still drawn empty while the one copy sits in the buffer.
    // claudish neither clears nor types again onto a box that shows nothing: once the line
    // is drawn and has stopped changing, only its Enter is sent, and the prompt lands as one
    // copy. The 8 s lag outlasts magmux's 3 s verify window, so the reply is the empty-box
    // mismatch (a lag inside the window lets magmux see the draw itself).
    test(
      "a line drawn 8 s late after an empty-box mismatch is submitted with Enter, never cleared or typed again",
      async () => {
        const cols = 80;
        const prompt = longPrompt();
        const r = await startGatePane("answer", {
          shape: "one-shot",
          initialPrompt: prompt,
          initialSize: { cols, rows: 40 },
          env: { FAKE_RENDER_LAG_MS: "8000", FAKE_CTRL_U: "row", FAKE_GAP_MS_WITNESS: "3000" },
        });
        const snapshot = await gateUntil(
          r,
          (s) => s.state === "COMPLETED" || s.state === "FAILED",
          60_000
        );
        expect(snapshot.state).toBe("COMPLETED");
        expect(submissions(r).map(({ text }) => text)).toEqual([prompt]);
        expect(r.sends.filter(({ message }) => isTypedSend(message))).toHaveLength(1);
        expect(r.sends.filter(({ message }) => isClearSend(message))).toHaveLength(0);
        // the path ran: magmux read the box empty, and claudish's next send was Enter alone
        const mismatchAt = r.sends.findIndex(
          ({ reply }) => reply !== undefined && mismatchBoxStayedEmpty(classifySendReply(reply))
        );
        expect(mismatchAt).toBeGreaterThanOrEqual(0);
        expect(r.sends[mismatchAt + 1]?.message).toMatchObject({ keys: ["enter"] });
        expect(isTypedSend(r.sends[mismatchAt + 1]?.message ?? {})).toBe(false);
      },
      T
    );

    // Claude Code's ctrl-u deletes one wrapped row. When the box, once a stdin stall ends,
    // shows text other than the line (here text another writer left, read ahead of claudish's
    // one copy), claudish clears it before typing the line again, with one ctrl-u per row
    // that leftover can occupy. The prompt then lands as one whole copy and the slot completes
    // instead of failing prompt_not_accepted on a box that never empties.
    test(
      "a wrapped foreign leftover drawn after a stdin stall is cleared row by row before the line is typed again",
      async () => {
        const cols = 80;
        const prompt = longPrompt();
        let leftover = "draft left by another writer";
        for (let i = 0; leftover.length < 120; i++) leftover += ` note${i}`;
        const r = await startGatePane("answer", {
          shape: "one-shot",
          initialPrompt: prompt,
          initialSize: { cols, rows: 40 },
          env: {
            FAKE_STDIN_STALL_MS: "12000",
            FAKE_STDIN_STALL_LEFTOVER: leftover,
            FAKE_CTRL_U: "row",
            FAKE_GAP_MS_WITNESS: "3000",
          },
        });
        const snapshot = await gateUntil(
          r,
          (s) => s.state === "COMPLETED" || s.state === "FAILED",
          60_000
        );
        expect(snapshot.reason).not.toBe("prompt_not_accepted");
        expect(snapshot.state).toBe("COMPLETED");
        expect(snapshot.anomalies).toContain("box_drawn_other_after_mismatch");
        expect(submissions(r).map(({ text }) => text)).toEqual([prompt]);
        const rows = wrapPrompt(leftover + prompt, cols).length;
        const typed = r.sends
          .map(({ message }, i) => ({ message, i }))
          .filter(({ message }) => isTypedSend(message));
        // one copy before the stall ended, one after the clear: never a copy onto an empty box
        expect(typed).toHaveLength(2);
        const firstAt = typed[0]?.i ?? 0;
        const secondAt = typed[1]?.i ?? 0;
        const clears = r.sends
          .slice(firstAt + 1, secondAt)
          .filter(({ message }) => isClearSend(message));
        expect(clears.length).toBeGreaterThanOrEqual(1);
        const before = r.sends[secondAt - 1]?.message;
        expect(before).toMatchObject({ enter: false, noGate: true });
        const keys = (before?.keys as string[] | undefined) ?? [];
        expect(keys.filter((k) => k === "ctrl-u").length).toBeGreaterThanOrEqual(rows);
      },
      T
    );
  }
);
