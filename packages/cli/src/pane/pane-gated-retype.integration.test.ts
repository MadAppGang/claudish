/** §10.2/R1.9: redials, retypes, ignored Enters, vim mode and boot dialogs. Real pinned magmux, fake child, PRODUCTION timings. */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROMPT,
  T,
  assertLoudLoss,
  assertOneCopy,
  screen,
  settled,
} from "./test-helpers/gated-delivery.js";
import {
  clientOf,
  disposeGatePanes,
  gateUntil,
  gatedSends,
  startGatePane,
  submissions,
} from "./test-helpers/gated-pane.js";
import { MAGMUX, NO_MAGMUX_MESSAGE } from "./test-helpers/hermetic-env.js";

describe.skipIf(!MAGMUX)(
  `gated retypes at production timings (${MAGMUX ? "real magmux" : NO_MAGMUX_MESSAGE})`,
  () => {
    // One disposal awaits reaped() and then polls up to 8 s for orphans; 5 s is bun's default.
    afterEach(disposeGatePanes, 30_000);

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

    for (const [scenario, cause] of [
      ["late_reset_swallow", "terminal_reset"],
      ["drop_first_prompt", "never_drawn"],
    ] as const) {
      test(
        `DB-3 / F13: ${scenario} permits only magmux's one ${cause} retype`,
        async () => {
          const r = await startGatePane(scenario, {
            shape: "one-shot",
            initialPrompt: PROMPT,
            env: { FAKE_RENDER_LAG_MS: "800", FAKE_GAP_MS_WITNESS: "5000" },
          });
          await settled(r);
          assertOneCopy(r, PROMPT);
          const retyped = gatedSends(r).filter(
            ({ reply }) => reply?.ok && reply.result.retyped === true
          );
          expect(retyped).toHaveLength(1);
          expect(retyped[0]?.reply).toMatchObject({ ok: true, result: { retypeCause: cause } });
          expect(
            r.s.snapshot().anomalies.filter((anomaly) => anomaly === `gate_retyped:${cause}`)
          ).toHaveLength(1);
        },
        T
      );
    }

    test(
      "I8: ignored Enters yield still_in_box twice, one ctrl-u, no third typed copy",
      async () => {
        const r = await startGatePane("enter_ignored_forever", {
          shape: "one-shot",
          initialPrompt: PROMPT,
        });
        await assertLoudLoss(r, "still_in_box");
        expect(gatedSends(r)).toHaveLength(2);
        expect(
          gatedSends(r).every(({ reply }) => !reply?.ok && reply?.reason === "still_in_box")
        ).toBe(true);
        expect(
          r.sends.filter(({ message }) =>
            (message.keys as string[] | undefined)?.includes("ctrl-u")
          )
        ).toHaveLength(1);
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
  }
);
