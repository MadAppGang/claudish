/** §10.2/R1.9 and D-A/D-B: boot, render lag, loud loss and lost replies. Real pinned magmux, fake child, PRODUCTION timings. */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { gateBasisOf, parseGateBinding } from "./input-gate.js";
import {
  LOSS_RECORD_WAIT_MS,
  PROMPT,
  SKIP_LOADED,
  T,
  allRuns,
  assertLoudLoss,
  assertOneCopy,
  cases,
  listResult,
  settled,
  sha8,
  underLoad,
} from "./test-helpers/gated-delivery.js";
import {
  DISPOSE_GATE_PANES_HOOK_MS,
  clientOf,
  disposeGatePanes,
  gateUntil,
  gatedSends,
  pointerOf,
  startGatePane,
  submissions,
} from "./test-helpers/gated-pane.js";
import { MAGMUX, NO_MAGMUX_MESSAGE } from "./test-helpers/hermetic-env.js";

describe.skipIf(!MAGMUX)(
  `gated delivery at production timings (${MAGMUX ? "real magmux" : NO_MAGMUX_MESSAGE})`,
  () => {
    // One disposal awaits reaped() and then polls up to 8 s for orphans; 5 s is bun's default.
    afterEach(disposeGatePanes, DISPOSE_GATE_PANES_HOOK_MS);

    test(
      "I1: promptless boot uses the declared gate, without a transcript or a send",
      async () => {
        const r = await startGatePane("answer");
        await r.s.ready;
        expect(r.s.snapshot().state).toBe("AWAITING_INPUT");
        expect(r.s.diagnostics().gate?.ready).toBe(true);
        expect(existsSync(r.transcript)).toBe(false);
        expect(r.sends).toEqual([]);
        const list = await clientOf(r).request({ type: "list" });
        expect(gateBasisOf(listResult(list))).toBe("declared");
        expect(parseGateBinding(listResult(list))).toMatchObject({
          bound: "named",
          sessionId: r.uuid,
        });
      },
      T
    );

    for (const c of cases) {
      test(
        `DB-1 / I2-I4: 800 ms render lag submits the ${c.name} prompt exactly once`,
        async () => {
          const r = await startGatePane("answer", {
            shape: "one-shot",
            initialPrompt: c.prompt,
            env: { FAKE_RENDER_LAG_MS: "800", FAKE_GAP_MS_WITNESS: "3000" },
          });
          await settled(r);
          assertOneCopy(r, c.prompt);
          expect(r.s.snapshot().state).toBe("COMPLETED");
          if (c.name === "plain")
            expect(r.s.diagnostics().lastSend).toMatchObject({
              kind: "accepted",
              accept: "confirmed",
              evidence: "history",
            });
          if (c.name === "command") {
            expect(gatedSends(r).map(({ message }) => message)).toMatchObject([
              { text: c.prompt, enter: false, typed: true },
              { keys: ["enter"], enter: false },
            ]);
            expect(gatedSends(r)[0]?.reply).toMatchObject({
              ok: true,
              result: { accept: "in_box" },
            });
          }
        },
        T
      );
    }

    test.skipIf(SKIP_LOADED)(
      "DB-1/DB-3 loaded: six panes, 800 ms render lag and late resets never duplicate a prompt",
      async () => {
        await underLoad(async () => {
          await allRuns(
            ["answer", "late_reset_swallow"].flatMap((scenario) =>
              cases.map(async (c) => {
                const r = await startGatePane(scenario, {
                  shape: "one-shot",
                  initialPrompt: c.prompt,
                  env: { FAKE_RENDER_LAG_MS: "800", FAKE_GAP_MS_WITNESS: "5000" },
                });
                if (scenario === "answer") {
                  await settled(r);
                  assertOneCopy(r, c.prompt);
                  return;
                }
                // magmux >= 0.20.2 never retypes a copy the reset swallowed, and claudish
                // types none onto a box that shows nothing: the loss is loud, one copy sent
                const snapshot = await gateUntil(r, (s) => s.state === "FAILED", 45_000);
                expect(snapshot.reason).toBe("prompt_not_accepted");
                expect(snapshot.detail).toContain("the input box stayed empty");
                expect(
                  gatedSends(r).filter(({ message }) => typeof message.text === "string")
                ).toHaveLength(1);
                expect(submissions(r)).toEqual([]);
              })
            )
          );
        });
      },
      T * 2
    );

    test(
      "DA-1: transcript off and Enter ignored fails loudly at the record wait's end, never as an empty answer",
      async () => {
        const r = await startGatePane("never_submit_transcript_off", {
          unprovenRecordWaitMs: LOSS_RECORD_WAIT_MS,
          shape: "one-shot",
          initialPrompt: PROMPT,
        });
        await assertLoudLoss(r, "still_in_box");
        expect(gatedSends(r).filter(({ message }) => message.text === pointerOf(r))).toHaveLength(
          1
        );
        expect(
          r.sends.filter(({ message }) =>
            (message.keys as string[] | undefined)?.includes("ctrl-u")
          )
        ).toHaveLength(0);
      },
      T
    );

    test(
      "DA-2: a 12 s transcript gap and ignored first Enter still submit exactly one non-empty answer",
      async () => {
        const r = await startGatePane("enter_ignored_1", {
          shape: "one-shot",
          initialPrompt: PROMPT,
          env: { FAKE_GAP_MS_WITNESS: "12000" },
        });
        await r.s.ready;
        expect(r.s.snapshot().state).toBe("RUNNING");
        // Initial delivery remains STARTING until confirmation or its OWN witness.
        const runningAt = r.transitions.find(({ to }) => to === "RUNNING")?.at ?? 0;
        const confirmation = gatedSends(r).find(
          ({ reply }) => reply?.ok && reply.result.evidence === "history"
        );
        expect(confirmation?.repliedAt).toBeDefined();
        expect(runningAt).toBeGreaterThanOrEqual(
          confirmation?.repliedAt ?? Number.POSITIVE_INFINITY
        );
        expect(existsSync(r.transcript)).toBe(false);
        await settled(r);
        assertOneCopy(r, PROMPT);
        expect(r.s.snapshot().anomalies).toContain("gate_resent_enter");
      },
      T
    );

    test.skipIf(SKIP_LOADED)(
      "DA loaded: six panes under CPU load either land once or fail prompt_not_accepted, never quietly lose a prompt",
      async () => {
        await underLoad(async () => {
          await allRuns(
            Array.from({ length: 6 }, async (_, i) => {
              const loses = i % 2 === 0;
              const scenario = loses ? "never_submit_transcript_off" : "enter_ignored_1";
              const r = await startGatePane(scenario, {
                shape: "one-shot",
                initialPrompt: PROMPT,
                env: { FAKE_GAP_MS_WITNESS: "12000" },
                ...(loses ? { unprovenRecordWaitMs: LOSS_RECORD_WAIT_MS } : {}),
              });
              if (loses) await assertLoudLoss(r, "still_in_box");
              else {
                await settled(r);
                assertOneCopy(r, PROMPT);
              }
            })
          );
        });
      },
      T * 2
    );

    for (const command of [false, true]) {
      test(
        `DB-2 / I17: lost ${command ? "TYPE" : "SUBMIT"} reply never submits a second copy`,
        async () => {
          const prompt = command ? "/model haiku" : PROMPT;
          const r = await startGatePane("answer", {
            shape: "one-shot",
            initialPrompt: prompt,
            env: { FAKE_GAP_MS_WITNESS: "6000", FAKE_RENDER_LAG_MS: "800" },
          });
          const client = clientOf(r);
          const real = client.request.bind(client);
          let lost = false;
          client.request = async (message, timeout) => {
            const reply = await real(message, timeout);
            if (message.type === "send" && typeof message.text === "string" && !lost) {
              lost = true;
              return {
                ok: false,
                code: "client_lost",
                error: "connection closed after delivery, before reply",
              };
            }
            return reply;
          };
          await settled(r);
          expect(lost).toBe(true);
          expect(submissions(r).map(({ text }) => text)).toEqual([command ? prompt : pointerOf(r)]);
          expect(r.turns[0]?.answer).toBe(
            command ? "Set model to `haiku`" : `ANSWER fake-answer ${sha8(prompt)}`
          );
          expect(r.s.snapshot().anomalies).toContain("send_reply_lost");
          // a lost TYPE reply waits for the box to settle; settled on the whole command line,
          // it gets Enter alone: one typed copy and no ctrl-u either way
          const typed = gatedSends(r).filter(({ message }) => typeof message.text === "string");
          expect(typed).toHaveLength(1);
          const clears = r.sends.filter(({ message }) =>
            (message.keys as string[] | undefined)?.includes("ctrl-u")
          );
          expect(clears).toHaveLength(0);
          if (command) expect(r.s.snapshot().anomalies).toContain("box_drawn_after_mismatch");
        },
        T
      );
    }
  }
);
