/** §10.2/R1.9: the gate grace, resizes, refusals, named binding and other writers. Real pinned magmux, fake child, PRODUCTION timings. */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { locateBox } from "./box-locate.js";
import { parseGateBinding } from "./input-gate.js";
import { inputBox } from "./screen-classifier.js";
import { PROMPT, T, listResult, screen, settled, sha8 } from "./test-helpers/gated-delivery.js";
import {
  type SendTrace,
  clientOf,
  disposeGatePanes,
  gateUntil,
  gatedSends,
  startGatePane,
  submissions,
} from "./test-helpers/gated-pane.js";
import { MAGMUX, NO_MAGMUX_MESSAGE } from "./test-helpers/hermetic-env.js";

describe.skipIf(!MAGMUX)(
  `gated settle and binding at production timings (${MAGMUX ? "real magmux" : NO_MAGMUX_MESSAGE})`,
  () => {
    // One disposal awaits reaped() and then polls up to 8 s for orphans; 5 s is bun's default.
    afterEach(disposeGatePanes, 30_000);

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
