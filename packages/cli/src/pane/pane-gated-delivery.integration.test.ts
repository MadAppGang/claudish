/** §10.2/R1.9 and D-A/D-B: real pinned magmux, fake child, PRODUCTION timings. */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { locateBox } from "./box-locate.js";
import { gateBasisOf, parseGateBinding } from "./input-gate.js";
import type { MagmuxReply } from "./magmux-client.js";
import { inputBox } from "./screen-classifier.js";
import type { ScreenState } from "./screen-model.js";
import {
  type GateRun,
  type SendTrace,
  clientOf,
  disposeGatePanes,
  gateUntil,
  gatedSends,
  startGatePane,
  submissions,
} from "./test-helpers/gated-pane.js";
import { MAGMUX, NO_MAGMUX_MESSAGE } from "./test-helpers/hermetic-env.js";

const T = 90_000;
const PROMPT = "Reply with exactly PEAR.";
const sha8 = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 8);
const cases = [
  { name: "plain", prompt: PROMPT, mode: "typed" },
  { name: "command", prompt: "/model haiku", mode: "command" },
  { name: "file", prompt: "First line.\nSecond line with `markdown` and **words**.", mode: "file" },
] as const;

function screen(r: GateRun): ScreenState {
  const capture = r.s.capture(undefined, { spans: true });
  if (!("lines" in capture)) throw new Error("full capture required");
  return { ...capture, spans: capture.spans ?? [], alt: true, changedAt: 0, aboveBoxChangedAt: 0 };
}

function listResult(reply: MagmuxReply): Record<string, unknown> {
  if (!reply.ok) throw new Error(`list failed: ${reply.code}: ${reply.error}`);
  return reply.result;
}

async function settled(r: GateRun, count = 1): Promise<void> {
  await gateUntil(r, (snapshot) => snapshot.turnsCompleted >= count, 45_000);
}

function assertOneCopy(r: GateRun, prompt: string): void {
  const typed = gatedSends(r).filter(({ message }) => typeof message.text === "string");
  expect(typed).toHaveLength(1);
  expect(typeof typed[0]?.message.text).toBe("string");
  expect(submissions(r).map(({ text }) => text)).toEqual([typed[0]?.message.text as string]);
  expect(typed[0]?.message).toMatchObject({ typed: true });
  if (prompt === "/model haiku") {
    expect(submissions(r)[0]?.text).toBe(prompt);
    expect(r.turns[0]?.answer).toBe("Set model to `haiku`");
  } else {
    expect(r.turns[0]?.answer).toBe(`ANSWER fake-${r.scenario} ${sha8(prompt)}`);
    if (prompt.includes("\n")) {
      expect(submissions(r)[0]?.text).toMatch(/^Your task is in the file `.+`\. Read all of it/);
      expect(r.turns[0]?.delivery).toMatchObject({ mode: "file", complete: true });
    } else expect(submissions(r)[0]?.text).toBe(prompt);
  }
}

/** Real CPU load in separate threads; every thread is joined, including on assertion failure. */
async function underLoad(work: () => Promise<void>): Promise<void> {
  const workers: Worker[] = [];
  try {
    const ready: Promise<unknown>[] = [];
    for (let i = 0; i < cpus().length; i++) {
      const worker = new Worker(
        `const { parentPort } = require('node:worker_threads'); parentPort.postMessage('ready'); let n = 0; while (true) { n = (n + Math.sqrt(n + 1)) % 1000000; }`,
        { eval: true }
      );
      workers.push(worker);
      ready.push(
        new Promise((resolve, reject) => {
          worker.once("message", resolve);
          worker.once("error", reject);
        })
      );
    }
    await Promise.all(ready);
    await work();
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

async function allRuns(runs: Promise<void>[]): Promise<void> {
  // Do not leave sibling assertions polling after an early Promise.all rejection.
  const results = await Promise.allSettled(runs);
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

async function assertLoudLoss(r: GateRun, reason: string): Promise<void> {
  const snapshot = await gateUntil(r, (s) => s.state === "FAILED", 40_000);
  expect(snapshot.reason).toBe("prompt_not_accepted");
  expect(snapshot.detail).toContain(`magmux not_accepted ${reason}`);
  expect(snapshot.anomalies).not.toContain("degraded_mode");
  expect(r.turns).toHaveLength(0);
  expect(r.transitions.some(({ to }) => to === "EMPTY" || to === "COMPLETED")).toBe(false);
  expect(submissions(r)).toEqual([]);
  // A recording gap must fail here as a missed send, not below as a timing bound.
  const typed = gatedSends(r).filter(({ message }) => typeof message.text === "string");
  expect(typed.length).toBe(r.s.diagnostics().lastSend?.attempts ?? -1);
  const failedAt = r.transitions.find(({ to }) => to === "FAILED")?.at ?? 0;
  expect(failedAt - (gatedSends(r)[0]?.at ?? Number.POSITIVE_INFINITY)).toBeGreaterThanOrEqual(
    29_000
  );
  expect(failedAt - (gatedSends(r)[0]?.at ?? 0)).toBeLessThanOrEqual(31_000);
}

describe.skipIf(!MAGMUX)(
  `gated delivery at production timings (${MAGMUX ? "real magmux" : NO_MAGMUX_MESSAGE})`,
  () => {
    // One disposal awaits reaped() and then polls up to 8 s for orphans; 5 s is bun's default.
    afterEach(disposeGatePanes, 30_000);

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

    test(
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
                await settled(r);
                assertOneCopy(r, c.prompt);
                if (scenario === "late_reset_swallow")
                  expect(r.s.snapshot().anomalies).toContain("gate_retyped:terminal_reset");
              })
            )
          );
        });
      },
      T * 2
    );

    test(
      "DA-1: transcript off and Enter ignored fails loudly at 30 s, never as an empty answer",
      async () => {
        const r = await startGatePane("never_submit_transcript_off", {
          shape: "one-shot",
          initialPrompt: PROMPT,
        });
        await assertLoudLoss(r, "still_in_box");
        expect(
          gatedSends(r).filter(({ message }) => message.text === PROMPT).length
        ).toBeLessThanOrEqual(2);
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

    test(
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
          expect(submissions(r).map(({ text }) => text)).toEqual([prompt]);
          expect(r.turns[0]?.answer).toBe(
            command ? "Set model to `haiku`" : `ANSWER fake-answer ${sha8(prompt)}`
          );
          expect(r.s.snapshot().anomalies).toContain("send_reply_lost");
          const typed = gatedSends(r).filter(({ message }) => typeof message.text === "string");
          expect(typed).toHaveLength(command ? 2 : 1);
          const clears = r.sends.filter(({ message }) =>
            (message.keys as string[] | undefined)?.includes("ctrl-u")
          );
          expect(clears).toHaveLength(command ? 1 : 0);
          if (command)
            expect(clears[0]?.at).toBeGreaterThanOrEqual(
              typed[0]?.repliedAt ?? Number.POSITIVE_INFINITY
            );
        },
        T
      );
    }

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

    test(
      "I14: a transcript-closed turn with box text settles after the 32 s gate grace, naming box_not_empty",
      async () => {
        const r = await startGatePane("settle_box_text", {
          shape: "one-shot",
          initialPrompt: PROMPT,
        });
        await gateUntil(
          r,
          () =>
            existsSync(r.transcript) &&
            readFileSync(r.transcript, "utf8").includes('"subtype":"turn_duration"')
        );
        const endedAt = Date.now();
        await Bun.sleep(1000);
        expect(r.s.snapshot().turnsCompleted).toBe(0);
        await settled(r);
        expect(Date.now() - endedAt).toBeGreaterThanOrEqual(30_000);
        expect(r.s.snapshot().anomalies).toContain("settle_gate_unconfirmed:box_not_empty");
        expect(r.turns[0]?.answer).toBe(`ANSWER fake-settle_box_text ${sha8(PROMPT)}`);
      },
      T
    );

    test(
      "I15: resize to 400 columns and mid-turn to 600 and back retains the box and settles",
      async () => {
        const r = await startGatePane("tool_slow", { env: { FAKE_GAP_MS_TOOL: "5000" } });
        await r.s.ready;
        expect(await r.s.resize(400, 100)).toMatchObject({ cols: 400, rows: 100 });
        await gateUntil(r, () => screen(r).cols === 400 && locateBox(screen(r)) !== null);
        r.s.send(PROMPT);
        await gateUntil(r, (s) => s.activity === "Bash");
        expect(await r.s.resize(600, 120)).toMatchObject({ cols: 600, rows: 120 });
        await gateUntil(r, () => screen(r).cols === 600 && locateBox(screen(r)) !== null);
        await r.s.resize(400, 100);
        await settled(r);
        expect(screen(r).cols).toBe(400);
        expect(locateBox(screen(r))).not.toBeNull();
        expect(r.turns[0]?.answer).toBe(`ANSWER fake-tool_slow ${sha8(PROMPT)}`);
        expect(submissions(r).map(({ text }) => text)).toEqual([PROMPT]);
      },
      T
    );

    test(
      "I16: a starting refusal cannot leave a client request beyond the 30 s admission deadline",
      async () => {
        const r = await startGatePane("answer", { shape: "one-shot", initialPrompt: PROMPT });
        // Client-response seam: hold each request for its real readyTimeoutMs. Never scale time.
        const client = clientOf(r);
        const real = client.request.bind(client);
        let inFlight = 0;
        client.request = async (message, timeout) => {
          if (message.type !== "send" || message.noGate === true) return real(message, timeout);
          const trace: SendTrace = { message: { ...message }, at: Date.now(), timeout };
          r.sends.push(trace);
          inFlight++;
          try {
            await Bun.sleep(message.readyTimeoutMs as number);
            trace.reply = {
              ok: false,
              code: "busy",
              reason: "starting",
              error: "fake child is still starting",
            };
            trace.repliedAt = Date.now();
            return trace.reply;
          } finally {
            inFlight--;
          }
        };
        const snapshot = await gateUntil(r, (s) => s.state === "FAILED", 40_000);
        expect(snapshot.reason).toBe("prompt_not_accepted");
        expect(snapshot.detail).toContain("busy starting");
        expect(inFlight).toBe(0);
        const began = gatedSends(r)[0]?.at ?? 0;
        const failedAt = r.transitions.find(({ to }) => to === "FAILED")?.at ?? 0;
        expect(failedAt - began).toBeGreaterThanOrEqual(29_000);
        expect(failedAt - began).toBeLessThanOrEqual(31_000);
        expect(gatedSends(r).length).toBeGreaterThan(0);
        for (const send of gatedSends(r)) {
          expect(send.message.readyTimeoutMs as number).toBeGreaterThanOrEqual(1000);
          expect(send.message.readyTimeoutMs as number).toBeLessThanOrEqual(10_000);
          expect(send.at + (send.timeout ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(
            began + 30_000
          );
          expect(send.repliedAt).toBeDefined();
        }
        expect(submissions(r)).toEqual([]);
      },
      T
    );

    test(
      "I19: a sibling in the same cwd cannot change the named binding, even before any transcript exists",
      async () => {
        const first = await startGatePane("answer", {
          prepare(t, uuid) {
            const config = join(t.tmp, "custom-config");
            mkdirSync(config, { recursive: true });
            t.env.CLAUDE_CONFIG_DIR = config;
            return { transcriptPath: t.transcriptPathFor(uuid).replace(t.configDir, config) };
          },
        });
        await first.s.ready;
        const before = await clientOf(first).request({ type: "list" });
        expect(parseGateBinding(listResult(before))).toMatchObject({
          bound: "named",
          sessionId: first.uuid,
          transcriptPath: first.transcript,
        });
        expect(existsSync(first.transcript)).toBe(false);
        const second = await startGatePane("answer", {
          prepare(t, uuid) {
            // Distinct socket roots and submit logs, one config directory and cwd.
            t.env.HOME = first.t.home;
            t.env.CLAUDE_CONFIG_DIR = first.t.env.CLAUDE_CONFIG_DIR as string;
            return {
              cwd: first.t.cwd,
              transcriptPath: join(dirname(first.transcript), `${uuid}.jsonl`),
            };
          },
        });
        await second.s.ready;
        const sibling = await clientOf(second).request({ type: "list" });
        expect(parseGateBinding(listResult(sibling))).toMatchObject({
          bound: "named",
          sessionId: second.uuid,
          transcriptPath: second.transcript,
        });
        expect(second.transcript.startsWith(`${first.t.env.CLAUDE_CONFIG_DIR}/projects/`)).toBe(
          true
        );
        expect(second.transcript.startsWith(`${first.t.home}/.claude/`)).toBe(false);
        second.s.send("sibling writes first");
        await settled(second);
        expect(existsSync(first.transcript)).toBe(false);
        expect(
          parseGateBinding(listResult(await clientOf(first).request({ type: "list" })))
        ).toEqual(parseGateBinding(listResult(before)));
        first.s.send(PROMPT);
        await settled(first);
        expect(first.turns[0]?.answer).toBe(`ANSWER fake-answer ${sha8(PROMPT)}`);
        expect(
          first.s.snapshot().anomalies.some((a) => a.startsWith("gate_dialog_at_admission:"))
        ).toBe(false);
      },
      T
    );

    test(
      "I20: a magmux with no named-binding flags fails input_gate_unbound before any send",
      async () => {
        const r = await startGatePane("answer", {
          shape: "one-shot",
          initialPrompt: PROMPT,
          prepare(t) {
            // Exercise the old unbound contract with the pinned binary; 0.16 itself is below the version floor.
            const wrapper = join(t.tmp, "unbound-magmux");
            writeFileSync(
              wrapper,
              `#!/bin/bash\nargs=()\nwhile (( $# )); do\ncase "$1" in\n--session-id|--transcript) shift 2;;\n*) args+=("$1"); shift;;\nesac\ndone\nexec ${JSON.stringify(MAGMUX)} "\${args[@]}"\n`,
              { mode: 0o755 }
            );
            return { magmuxBinary: wrapper };
          },
        });
        const snapshot = await gateUntil(r, (s) => s.state === "FAILED");
        expect(snapshot.reason).toBe("pane_lost");
        expect(snapshot.detail).toContain("input_gate_unbound");
        expect(r.sends).toEqual([]);
        expect(submissions(r)).toEqual([]);
      },
      T
    );

    for (const command of [false, true]) {
      test(
        `F14a: another writer's Enter on ${command ? "TYPE" : "SUBMIT"} is accepted without claudish's Enter`,
        async () => {
          const prompt = command ? "/model haiku" : PROMPT;
          const r = await startGatePane("self_submit", {
            shape: "one-shot",
            initialPrompt: prompt,
            env: { FAKE_GAP_MS_WITNESS: "5000" },
          });
          await settled(r);
          expect(submissions(r).map(({ text }) => text)).toEqual([prompt]);
          expect(gatedSends(r)).toHaveLength(1);
          expect(gatedSends(r)[0]?.reply).toMatchObject({
            ok: true,
            result: { accept: "submitted_by_other", evidence: "history", enter: false },
          });
          expect(r.s.snapshot().anomalies).toContain("gate_submitted_by_other");
        },
        T
      );
    }

    test(
      "F14b: a leftBox text_mismatch is maybeSubmitted, no retry, and the delayed witness accepts",
      async () => {
        const r = await startGatePane("self_submit_history_withheld", {
          shape: "one-shot",
          initialPrompt: PROMPT,
        });
        await settled(r);
        expect(submissions(r).map(({ text }) => text)).toEqual([PROMPT]);
        expect(gatedSends(r)).toHaveLength(1);
        expect(gatedSends(r)[0]?.reply).toMatchObject({
          ok: false,
          code: "not_accepted",
          reason: "text_mismatch",
          maybeSubmitted: true,
        });
        expect(r.s.snapshot().anomalies).toContain("gate_maybe_submitted_by_other");
        expect(r.sends.filter(({ message }) => message.keys !== undefined)).toEqual([]);
        expect(r.turns[0]?.answer).toBe(`ANSWER fake-self_submit_history_withheld ${sha8(PROMPT)}`);
      },
      T
    );

    test(
      "F15: a command leaving the box after in_box yields empty_box, never a retyped command",
      async () => {
        const r = await startGatePane("command_left_box", {
          shape: "one-shot",
          initialPrompt: "/model haiku",
          prepare(t) {
            t.env.FAKE_COMMAND_LEFT_BOX_FILE = join(t.tmp, "command-may-leave");
            return {};
          },
        });
        const client = clientOf(r);
        const real = client.request.bind(client);
        client.request = async (message, timeout) => {
          if (
            message.type === "send" &&
            (message.keys as string[] | undefined)?.includes("enter")
          ) {
            writeFileSync(r.t.env.FAKE_COMMAND_LEFT_BOX_FILE as string, "go");
            await gateUntil(r, () => inputBox(screen(r))?.text === "");
          }
          return real(message, timeout);
        };
        await settled(r);
        expect(submissions(r).map(({ text }) => text)).toEqual(["/model haiku"]);
        expect(gatedSends(r)).toHaveLength(2);
        expect(gatedSends(r)[0]?.reply).toMatchObject({ ok: true, result: { accept: "in_box" } });
        expect(gatedSends(r)[1]?.reply).toMatchObject({
          ok: false,
          code: "not_accepted",
          reason: "empty_box",
        });
        expect(r.s.snapshot().anomalies).toContain("gate_command_left_box");
        expect(r.turns[0]?.answer).toBe("Set model to `haiku`");
      },
      T
    );
  }
);
