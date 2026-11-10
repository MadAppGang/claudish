/** Real MCP stdio -> real headless magmux -> hermetic fake child. No real Claude Code. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { useBlackboxEnv } from "../test-helpers/blackbox-env.js";
import {
  MAGMUX_AVAILABLE,
  McpServer,
  NO_MAGMUX_MESSAGE,
  type ToolResult,
  paneOrphans,
  serverEnv,
} from "../test-helpers/contract-mcp.js";
import { type TempLayout, makeTempLayout, waitFor } from "../test-helpers/contract-records.js";
import type { CaptureResult, ContractError } from "./contract.js";
import {
  type GateRun,
  clientOf,
  disposeGatePanes,
  gateUntil,
  startGatePane,
} from "./test-helpers/gated-pane.js";

useBlackboxEnv();
const UP = "\x1b[<64;1;1M";
const DOWN = "\x1b[<65;1;1M";
const END = "\x1b[1;5F";
const T = 90_000;
type Json = Record<string, unknown>;
type InputChunk = { session_id: string; model: string; text: string };
if (!MAGMUX_AVAILABLE) console.warn(`pane scroll integration SKIPPED — ${NO_MAGMUX_MESSAGE}`);

function ok(result: ToolResult): Json {
  expect(result.isError).toBe(false);
  expect(result.json).toBeDefined();
  return JSON.parse(result.text) as Json;
}
function error(result: ToolResult, code: ContractError["error"]["code"]): void {
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.text)).toEqual({ error: { code, message: expect.any(String) } });
}

describe.skipIf(!MAGMUX_AVAILABLE)("pane scroll through MCP", () => {
  let layout: TempLayout;
  let server: McpServer | undefined;
  let byteLog: string;
  let keyLog: string;
  beforeEach(async () => {
    layout = makeTempLayout("panescroll");
    byteLog = join(layout.cwd, "input-bytes.jsonl");
    keyLog = join(layout.cwd, "submitted-lines.log");
    server = await McpServer.start({
      env: serverEnv(layout, {
        CONTRACT_FAKE_MAX_MS: "120000",
        FAKE_INPUT_BYTES_LOG: byteLog,
        FAKE_KEYLOG: keyLog,
        FAKE_GAP_MS_TOOL: "6000",
        FAKE_GAP_MS_SCREEN: "20000",
        FAKE_GAP_MS_PROMPT_HOOK: "12000",
        FAKE_GAP_MS_BOOT: "20000",
      }),
      cwd: layout.cwd,
    });
  });
  afterEach(async () => {
    try {
      await server?.close();
    } finally {
      const report = await paneOrphans(layout);
      try {
        expect(report).toEqual({ processes: [], files: [] });
      } finally {
        layout.cleanup();
        server = undefined;
      }
    }
  }, 30_000);

  async function call(name: string, args: Json): Promise<Json> {
    if (!server) throw new Error("server not started");
    return ok(await server.callTool(name, args));
  }
  function input(model?: string): string {
    if (!existsSync(byteLog)) return "";
    return readFileSync(byteLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as InputChunk)
      .filter((entry) => model === undefined || entry.model === model)
      .map((entry) => entry.text)
      .join("");
  }
  function keys(): string {
    return existsSync(keyLog) ? readFileSync(keyLog, "utf8") : "";
  }
  async function row(id: string): Promise<Json | undefined> {
    const list = await call("list_sessions", { include_completed: true });
    return (list.sessions as Json[]).find((s) => s.session_id === id);
  }
  async function create(model = "contract-fake-model"): Promise<string> {
    const result = await call("create_session", { model });
    const id = result.session_id as string;
    await waitFor(async () => (await row(id))?.state === "AWAITING_INPUT", {
      what: "promptless fake session ready",
      timeoutMs: 20_000,
      intervalMs: 50,
    });
    return id;
  }
  async function capture(id: string): Promise<CaptureResult> {
    return (await call("capture_session", { session_id: id })) as unknown as CaptureResult;
  }
  async function settled(id: string, turns: number): Promise<void> {
    await waitFor(
      async () => {
        const s = await row(id);
        return s?.state === "AWAITING_INPUT" && (s.turns_completed as number) >= turns;
      },
      { what: `fake turn ${turns} settled`, timeoutMs: 35_000, intervalMs: 50 }
    );
  }
  async function assertScrollBytes(id: string, req: Json, expected: string): Promise<Json> {
    const offset = input().length;
    const result = await call("scroll_session", { session_id: id, ...req });
    expect(result).toEqual({ session_id: id, seq: expect.any(Number) });
    expect(Number.isInteger(result.seq)).toBe(true);
    await waitFor(() => input().length >= offset + expected.length, {
      what: "scroll bytes read by fake child",
      timeoutMs: 5000,
      intervalMs: 20,
    });
    expect(input().slice(offset)).toBe(expected);
    expect((await capture(id)).seq).toBeGreaterThanOrEqual(result.seq as number);
    return result;
  }
  async function run(
    path: string,
    models: string[],
    inputText: string,
    extra: Json = {}
  ): Promise<Json> {
    return call("team", { mode: "run", path, models, input: inputText, ...extra });
  }
  async function teamState(path: string, runId?: string): Promise<Json> {
    return call("team", { mode: "status", path, ...(runId ? { run_id: runId } : {}) });
  }
  async function terminalRun(path: string, state: string): Promise<Json> {
    return waitFor(
      async () => {
        const status = await teamState(path);
        const slot = ((status.run as Json).slots as Json[])[0]!;
        return slot.state === state ? status : undefined;
      },
      { what: `team slot ${state}`, timeoutMs: 40_000, intervalMs: 100 }
    );
  }

  // REQ: 1, 4, 5.2, 5.4, 7 (transport safety only)
  test(
    "real PTY receives exact bursts for continuation, reversal, cap and live bottom",
    async () => {
      const id = await create();
      const before = await capture(id);
      const beforeKeys = keys();
      await assertScrollBytes(id, { by: -3 }, UP.repeat(4));
      await assertScrollBytes(id, { by: -3 }, UP.repeat(3));
      await assertScrollBytes(id, { by: 2 }, DOWN.repeat(3));
      await assertScrollBytes(id, { by: 99999 }, DOWN.repeat(200));
      await assertScrollBytes(id, { to: "end" }, END);
      await assertScrollBytes(id, { by: 200 }, DOWN.repeat(201));
      await assertScrollBytes(id, { to: "end" }, END);
      await assertScrollBytes(id, { to: "end" }, END);
      const after = await capture(id);
      // The fake observes/discards complete CSI sequences; this does not test Claude Code scrolling.
      expect(after.lines).toEqual(before.lines);
      expect(after.cols).toBe(before.cols);
      expect(after.rows).toBe(before.rows);
      expect(keys()).toBe(beforeKeys);
      expect((await row(id))?.state).toBe("AWAITING_INPUT");
      expect((await row(id))?.turns_completed).toBe(0);
    },
    T
  );

  // REQ: 3, 5.5, 5.6
  test(
    "prompt delivery sends ctrl-End first, then the next accepted turn starts at live bottom",
    async () => {
      const id = await create();
      await assertScrollBytes(id, { by: -2 }, UP.repeat(3));
      const offset = input().length;
      const prompt = "answer after returning to live bottom";
      await call("send_input", { session_id: id, text: prompt });
      await settled(id, 1);
      expect(input().slice(offset).startsWith(END)).toBe(true);
      const sha = createHash("sha1").update(prompt).digest("hex").slice(0, 8);
      expect(
        (await capture(id)).lines.some((line) => line.includes(`ANSWER contract-fake-model ${sha}`))
      ).toBe(true);
      // No compensation state from the previous scroll survives the accepted prompt.
      await assertScrollBytes(id, { by: -2 }, UP.repeat(3));
      await assertScrollBytes(id, { to: "end" }, END);
      const nextOffset = input().length;
      await call("send_input", { session_id: id, text: "already at live bottom" });
      await settled(id, 2);
      expect(input().slice(nextOffset)).not.toContain(END);

      // Contract v1 adds view ownership without changing capture or resize semantics.
      const c = await capture(id);
      expect(Object.keys(c).sort()).toEqual([
        "cols",
        "cursor",
        "final",
        "lines",
        "rows",
        "seq",
        "view",
      ]);
      expect(c.lines).toHaveLength(c.rows);
      expect(c.view).toBeNull();
      const resized = await call("resize_session", { session_id: id, cols: c.cols, rows: c.rows });
      expect(resized).toEqual({
        session_id: id,
        cols: c.cols,
        rows: c.rows,
        changed: false,
        seq: c.seq,
        view: {
          holder: "claude_code",
          label: "Claude Code",
          since: expect.any(String),
          claim_id: expect.any(String),
        },
      });
      expect(await call("capture_session", { session_id: id, since_seq: c.seq })).toEqual({
        unchanged: true,
        seq: c.seq,
        final: false,
        view: resized.view,
      });
    },
    T
  );

  // REQ: 5 (state gate: running)
  test(
    "a running tool turn accepts scroll without interrupting its answer",
    async () => {
      const id = await create("fake-tool_slow");
      const prompt = "answer after the slow tool";
      await call("send_input", { session_id: id, text: prompt });
      await waitFor(
        async () => {
          const s = await row(id);
          return s?.state === "RUNNING" && s.activity === "Bash";
        },
        { what: "Bash tool running", timeoutMs: 20_000, intervalMs: 50 }
      );
      await assertScrollBytes(id, { by: -2 }, UP.repeat(3));
      await settled(id, 1);
      const sha = createHash("sha1").update(prompt).digest("hex").slice(0, 8);
      expect(
        (await capture(id)).lines.some((line) => line.includes(`ANSWER fake-tool_slow ${sha}`))
      ).toBe(true);
      expect(keys()).not.toContain("<ESC>");
    },
    T
  );

  for (const dialog of [
    { model: "fake-ask_user", state: "AWAITING_INPUT", activity: "AskUserQuestion" },
    { model: "fake-permission", state: "AWAITING_PERMISSION", activity: "Write" },
  ]) {
    // REQ: 5 (state gate: dialogs), 7 (transport safety only)
    test(
      `scroll is allowed in ${dialog.state}/${dialog.activity} and does not answer or dismiss it`,
      async () => {
        const id = await create(dialog.model);
        await call("send_input", { session_id: id, text: "open the scripted dialog" });
        await waitFor(
          async () => {
            const s = await row(id);
            return s?.state === dialog.state && s.activity === dialog.activity;
          },
          { what: dialog.activity, timeoutMs: 20_000, intervalMs: 50 }
        );
        const beforeKeys = keys();
        const before = await capture(id);
        await assertScrollBytes(id, { by: -1 }, UP.repeat(2));
        await assertScrollBytes(id, { to: "end" }, END);
        expect(keys()).toBe(beforeKeys);
        expect((await capture(id)).lines).toEqual(before.lines);
        expect(await row(id)).toMatchObject({
          state: dialog.state,
          activity: dialog.activity,
          turns_completed: 0,
        });
      },
      T
    );
  }

  // REQ: 5 (state gate: degraded screen turn)
  test(
    "screen-only turn refuses scroll without injecting any bytes",
    async () => {
      const id = await create("fake-no_transcript");
      const prompt = "screen-only answer";
      await call("send_input", { session_id: id, text: prompt });
      // RUNNING can precede PTY consumption. Witness the child's accepted prompt and
      // screen-only working frame before taking the no-new-input baseline.
      await waitFor(
        async () =>
          keys().split("\n").includes(prompt) &&
          (await row(id))?.state === "RUNNING" &&
          (await capture(id)).lines.some((line) => line.includes("Simmering")),
        {
          what: "screen-only prompt consumed and working frame drawn",
          timeoutMs: 20_000,
          intervalMs: 50,
        }
      );
      const before = input();
      error(
        await server!.callTool("scroll_session", { session_id: id, by: -1 }),
        "scroll_unavailable"
      );
      error(
        await server!.callTool("scroll_session", { session_id: id, to: "end" }),
        "scroll_unavailable"
      );
      expect(input()).toBe(before);
    },
    T
  );

  // REQ: 5a.B
  // REQ: 5a.C
  test("an unscrolled screen-only turn settles without ctrl-End and permits idle scroll again", async () => {
    const id = await create("fake-no_transcript");
    const prompt = "screen-only answer before returning to idle";
    const offset = input().length;
    await call("send_input", { session_id: id, text: prompt });
    await waitFor(
      async () =>
        keys().split("\n").includes(prompt) &&
        (await row(id))?.state === "RUNNING" &&
        (await capture(id)).lines.some((line) => line.includes("Simmering")),
      { what: "active screen-read turn", timeoutMs: 20_000, intervalMs: 50 }
    );
    const beforeRefusal = input();
    error(
      await server!.callTool("scroll_session", { session_id: id, by: -1 }),
      "scroll_unavailable"
    );
    expect(input()).toBe(beforeRefusal);
    await waitFor(
      async () => {
        const s = await row(id);
        return s?.state === "AWAITING_INPUT" && s.turns_completed === 1;
      },
      { what: "screen-read turn returned to idle", timeoutMs: 70_000, intervalMs: 50 }
    );
    expect(input().slice(offset)).not.toContain(END);
    const sha = createHash("sha1").update(prompt).digest("hex").slice(0, 8);
    expect(
      (await capture(id)).lines.some((line) => line.includes(`ANSWER fake-no_transcript ${sha}`))
    ).toBe(true);
    await assertScrollBytes(id, { by: -2 }, UP.repeat(3));
    await assertScrollBytes(id, { to: "end" }, END);
    expect(await row(id)).toMatchObject({ state: "AWAITING_INPUT", turns_completed: 1 });
  }, 110_000);

  // REQ: 2, 5 (state gate: unknown slot)
  test(
    "team scroll addresses exactly one live slot by path and optional run_id",
    async () => {
      const path = join(layout.cwd, "scroll-team");
      const started = await run(
        path,
        ["contract-scroll-a", "contract-scroll-b"],
        "stay running @@HANG@@"
      );
      const runId = started.run_id as string;
      const slots = started.slots as Record<string, string>;
      const slot = slots["contract-scroll-a"]!;
      const other = slots["contract-scroll-b"]!;
      const otherBefore = input("contract-scroll-b");
      const offset = input("contract-scroll-a").length;
      const result = await call("team", { mode: "scroll", path, slot, by: -3 });
      expect(result).toEqual({ run_id: runId, path, slot, seq: expect.any(Number) });
      expect(Number.isInteger(result.seq)).toBe(true);
      await waitFor(() => input("contract-scroll-a").length >= offset + UP.length * 4, {
        what: "one team slot's wheel bytes",
        timeoutMs: 5000,
        intervalMs: 20,
      });
      expect(input("contract-scroll-a").slice(offset)).toBe(UP.repeat(4));
      expect(input("contract-scroll-b")).toBe(otherBefore);

      const endOffset = input("contract-scroll-a").length;
      const end = await call("team", { mode: "scroll", path, slot, run_id: runId, to: "end" });
      expect(end).toEqual({ run_id: runId, path, slot, seq: expect.any(Number) });
      await waitFor(() => input("contract-scroll-a").slice(endOffset) === END, {
        what: "team ctrl-End",
        timeoutMs: 5000,
        intervalMs: 20,
      });
      expect(
        (await call("team", { mode: "capture", path, slot })).seq as number
      ).toBeGreaterThanOrEqual(end.seq as number);
      error(
        await server!.callTool("team", { mode: "scroll", path, slot: "99", by: -1 }),
        "unknown_slot"
      );
      error(
        await server!.callTool("team", {
          mode: "scroll",
          path,
          slot,
          run_id: `${started.team_session_id as string}-zzzzzzzz-abcdef`,
          by: -1,
        }),
        "unknown_run"
      );
      const status = await teamState(path);
      expect(((status.run as Json).slots as Json[]).find((s) => s.slot === other)?.state).toBe(
        "RUNNING"
      );
    },
    T
  );

  for (const terminal of [
    { state: "COMPLETED", model: "fake-answer", extra: {} },
    { state: "EMPTY", model: "fake-answer", extra: { min_output_bytes: 100_000 } },
    { state: "FAILED", model: "fake-scripted", extra: {} },
  ]) {
    // REQ: 5 (state gate: terminal completed/empty/failed)
    test(
      `${terminal.state} team slot refuses scroll and preserves its final capture`,
      async () => {
        // fake-scripted's default answer is successful; force FAILED via the existing rejected-agent path.
        const path = join(layout.cwd, `terminal-${terminal.state.toLowerCase()}`);
        const started = await run(path, [terminal.model], "answer then finish", {
          ...terminal.extra,
          ...(terminal.state === "FAILED" ? { agent: "zzz-scroll-rejected" } : {}),
        });
        await terminalRun(path, terminal.state);
        const slot = (started.slots as Record<string, string>)[terminal.model]!;
        const final = await call("team", { mode: "capture", path, slot });
        const before = input();
        for (const request of [{ by: -1 }, { to: "end" }]) {
          error(
            await server!.callTool("team", {
              mode: "scroll",
              path,
              slot,
              run_id: started.run_id,
              ...request,
            }),
            "scroll_unavailable"
          );
        }
        expect(await call("team", { mode: "capture", path, slot })).toEqual(final);
        expect(input()).toBe(before);
      },
      T
    );
  }

  // REQ: 5 (state gate: booting)
  test(
    "a booting child refuses scroll without injecting bytes",
    async () => {
      const result = await call("create_session", { model: "fake-slow_boot" });
      const id = result.session_id as string;
      await waitFor(async () => (await row(id))?.state === "STARTING", {
        what: "child starting",
        timeoutMs: 5000,
        intervalMs: 20,
      });
      const before = input();
      error(
        await server!.callTool("scroll_session", { session_id: id, by: -1 }),
        "scroll_unavailable"
      );
      error(
        await server!.callTool("scroll_session", { session_id: id, to: "end" }),
        "scroll_unavailable"
      );
      expect(input()).toBe(before);
    },
    T
  );

  // REQ: 5 (state gate: terminal timeout)
  test(
    "a timed-out MCP session refuses scroll and retains its final screen",
    async () => {
      const result = await call("create_session", {
        model: "contract-fake-model",
        timeout_seconds: 1,
      });
      const id = result.session_id as string;
      await waitFor(async () => (await row(id))?.state === "TIMEOUT", {
        what: "session timeout",
        timeoutMs: 20_000,
        intervalMs: 50,
      });
      const final = await waitFor(
        async () => {
          const c = await capture(id);
          return c.final ? c : undefined;
        },
        { what: "timeout final capture", timeoutMs: 15_000, intervalMs: 50 }
      );
      const before = input();
      error(
        await server!.callTool("scroll_session", { session_id: id, by: -1 }),
        "scroll_unavailable"
      );
      error(
        await server!.callTool("scroll_session", { session_id: id, to: "end" }),
        "scroll_unavailable"
      );
      expect(await capture(id)).toEqual(final);
      expect(input()).toBe(before);
    },
    T
  );

  // REQ: 5 (state gate: terminal cancelled)
  test(
    "cancelled MCP session refuses scroll without changing its final screen",
    async () => {
      const id = await create();
      await call("cancel_session", { session_id: id });
      const final = await waitFor(
        async () => {
          const c = await capture(id);
          return c.final ? c : undefined;
        },
        { what: "cancelled final capture", timeoutMs: 15_000, intervalMs: 50 }
      );
      const before = input();
      error(
        await server!.callTool("scroll_session", { session_id: id, by: -1 }),
        "scroll_unavailable"
      );
      error(
        await server!.callTool("scroll_session", { session_id: id, to: "end" }),
        "scroll_unavailable"
      );
      expect(await capture(id)).toEqual(final);
      expect(input()).toBe(before);
    },
    T
  );

  // REQ: 2, 5 (run_id addressing and terminal state)
  test(
    "an old run_id never scrolls the newer live run at a reused path",
    async () => {
      const path = join(layout.cwd, "reuse");
      const first = await run(path, ["fake-answer"], "finish old run");
      await terminalRun(path, "COMPLETED");
      rmSync(path, { recursive: true, force: true });
      const second = await run(path, ["contract-fake-model"], "stay running @@HANG@@");
      const slot = (second.slots as Record<string, string>)["contract-fake-model"]!;
      const oldSlot = (first.slots as Record<string, string>)["fake-answer"]!;
      const before = input();
      error(
        await server!.callTool("team", {
          mode: "scroll",
          path,
          slot: oldSlot,
          run_id: first.run_id,
          by: -1,
        }),
        "scroll_unavailable"
      );
      expect(input()).toBe(before);
      const latest = await call("team", { mode: "scroll", path, slot, by: -1 });
      expect(latest).toEqual({ run_id: second.run_id, path, slot, seq: expect.any(Number) });
    },
    T
  );
});

describe.skipIf(!MAGMUX_AVAILABLE)("pane scroll lifecycle observations", () => {
  afterEach(disposeGatePanes, 30_000);

  // REQ: 5 (state gate: settling)
  test(
    "scroll is allowed during the transcript turn verdict before returning to idle",
    async () => {
      let duringVerdict: Promise<{ seq: number }> | undefined;
      const r: GateRun = await startGatePane("answer", {
        decide: () => {
          // The supplied decide seam runs while the completed transcript turn is being settled.
          // Attach a rejection observer immediately; await the original promise below.
          duringVerdict = r.s.scroll({ by: -1 });
          void duringVerdict.catch(() => undefined);
          return "continue";
        },
      });
      await r.s.ready;
      await gateUntil(r, (s) => s.state === "AWAITING_INPUT");
      await r.s.send("settle this transcript turn");
      await gateUntil(r, (s) => s.turnsCompleted >= 1);
      expect(duringVerdict).toBeDefined();
      const result = await duringVerdict!;
      expect(Number.isInteger(result.seq)).toBe(true);
      expect(r.s.capture().seq).toBeGreaterThanOrEqual(result.seq);
      const wheels = r.sends.filter((s) => s.message.text === UP.repeat(2));
      expect(wheels).toHaveLength(1);
      expect(wheels[0]!.message).toEqual({
        type: "send",
        pane: 0,
        text: UP.repeat(2),
        enter: false,
        noGate: true,
      });
    },
    T
  );

  // REQ: 5, 7 (transport safety with a typed-but-not-submitted prompt)
  test(
    "wheel and ctrl-End do not change or submit the fake child's nonempty prompt",
    async () => {
      const r = await startGatePane("answer");
      await r.s.ready;
      await gateUntil(r, (s) => s.state === "AWAITING_INPUT");
      const draft = "a typed prompt that has not been submitted";
      const reply = await clientOf(r).request({
        type: "send",
        pane: 0,
        text: draft,
        enter: false,
        noGate: true,
      });
      expect(reply.ok).toBe(true);
      const before = await waitFor(
        () => {
          const c = r.s.capture();
          return "lines" in c && c.lines.some((line) => line.includes(draft)) ? c : undefined;
        },
        { what: "draft visible in input box", timeoutMs: 5000, intervalMs: 20 }
      );
      await r.s.scroll({ by: -1 });
      await r.s.scroll({ to: "end" });
      const after = r.s.capture();
      expect("lines" in after).toBe(true);
      if (!("lines" in after)) throw new Error("expected full capture");
      expect(after.lines).toEqual(before.lines);
      expect(r.s.snapshot()).toMatchObject({ state: "AWAITING_INPUT", turnsCompleted: 0 });
      expect(r.turns).toHaveLength(0);
    },
    T
  );
});
