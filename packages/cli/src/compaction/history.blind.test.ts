import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.COMPACTION_BLIND_FILE !== import.meta.path) {
  test("runs compaction contract cases with an isolated HOME", async () => {
    const home = mkdtempSync(join(tmpdir(), "compaction-blind-home-"));
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(ANTHROPIC|CLAUDE|CLAUDISH|OPENAI|OP_|XDG_)/.test(key)) delete env[key];
    }
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      cwd: home,
      env: {
        ...env,
        HOME: home,
        COMPACTION_BLIND_FILE: import.meta.path,
        CLAUDISH_DISABLE_KEYCHAIN: "1",
        CLAUDISH_DISABLE_OP: "1",
        CLAUDISH_DISABLE_CATALOG_WARM: "1",
        CLAUDISH_NO_PREDEFINED_ENDPOINTS: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const watchdog = setTimeout(() => child.kill(), 50_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, stdout + stderr).toBe(0);
    } finally {
      clearTimeout(watchdog);
      child.kill();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
} else {
  globalThis.fetch = (() => {
    throw new Error("Unexpected network access in blind tests");
  }) as unknown as typeof fetch;

  const { writeFileSync } = await import("node:fs");
  const { CompactionClient } = await import("./haiku-client.js");
  const { CompactionStore } = await import("./store.js");
  const {
    HistoryCompactor,
    effectiveHistoryLimit,
    isHumanTurnStart,
    stripThinking,
    setLaunchAutoCompactWindow,
    getLaunchAutoCompactWindow,
    renderMessages,
    messagesHash,
    summaryRequestText,
    HISTORY_SYSTEM_PROMPT,
    HISTORY_SUMMARY_TIMEOUT_MS,
  } = await import("./history.js");
  const { localTokenEstimate } = await import("../token-estimate.js");
  const session = "history-session";
  const model = "claude-haiku-5-5";
  const summary = "SUMMARY: preserve src/task.ts:42, E_FAIL, 123 and open work.";
  type Message = { role: string; content: string | Array<Record<string, unknown>> };
  type Payload = { model: string; messages: Message[]; system?: string };
  let root: string;
  const active: InstanceType<typeof HistoryCompactor>[] = [];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "compaction-history-"));
  });
  afterEach(async () => {
    await Promise.all(active.splice(0).map((h) => h.whenIdle()));
    setLaunchAutoCompactWindow(undefined);
    rmSync(root, { recursive: true, force: true });
  });

  function response(text = summary, stop = "end_turn") {
    return Response.json({
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      stop_reason: stop,
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  }
  function payload(): Payload {
    return {
      model,
      messages: [
        { role: "user", content: "OLD_PREFIX_SENTINEL " + "old data ".repeat(3100) },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "PREFIX_REASONING_MUST_NOT_BE_SENT", signature: "sig0" },
            { type: "text", text: "Previous work complete" },
          ],
        },
        { role: "user", content: "Start retained work" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "TAIL_REASONING", signature: "sig1" },
            { type: "redacted_thinking", data: "REDACTED_TAIL" },
            { type: "text", text: "Inspect file" },
            { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "src/task.ts" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "read-1", content: "file content" }],
        },
      ],
    };
  }
  function human(p = payload()): Payload {
    p.messages.push({ role: "user", content: "Continue " + "new ".repeat(2600) });
    return p;
  }
  function rig(
    reply: (r: Request) => Response | Promise<Response> = () => response(),
    limit: number | undefined = 10000
  ) {
    const requests: Request[] = [];
    const client = new CompactionClient({
      apiKey: "FAKE_HISTORY_KEY_00000000",
      model,
      warn() {},
      record() {},
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        return reply(request);
      }) as unknown as typeof fetch,
    });
    const store = new CompactionStore(root);
    const settings = { enabled: true, precomputeAt: 0.6, applyAt: 0.8 };
    const h = new HistoryCompactor({
      store,
      client,
      settings,
      contextWindowOf: () => limit,
      autoCompactWindow: () => undefined,
      summaryTimeoutMs: 1000,
    });
    active.push(h);
    return { h, requests, store, client, settings };
  }

  test("REQ-11 REQ-19 REQ-21 REQ-22: background summary returns immediately, swaps only at human start, then replays after restart", async () => {
    let release!: (r: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const r = rig(() => pending);
    const first = payload();
    const original = structuredClone(first);
    try {
      const pass = r.h.compact(first, session);
      expect(pass).not.toBeInstanceOf(Promise);
      expect(pass.precomputeStarted).toBe(true);
      expect(pass.applied).toBe("none");
      expect(first).toEqual(original);
      const whilePending = human();
      const beforePending = structuredClone(whilePending);
      expect(r.h.compact(whilePending, session).applied).toBe("none");
      expect(whilePending).toEqual(beforePending);
    } finally {
      release(response());
      await r.h.whenIdle();
    }
    expect(r.requests).toHaveLength(1);
    const sent = await r.requests[0]!.json();
    expect(sent.max_tokens).toBe(8192);
    expect(sent.output_config).toEqual({ effort: "low" });
    expect(sent).not.toHaveProperty("thinking");
    expect(sent.messages[0].content).toContain("OLD_PREFIX_SENTINEL");
    expect(sent.messages[0].content).not.toContain("Start retained work");
    expect(JSON.stringify(sent)).not.toContain("PREFIX_REASONING_MUST_NOT_BE_SENT");

    const toolRound = payload();
    toolRound.messages.push({
      role: "user",
      content: [
        { type: "text", text: "long alongside result ".repeat(600) },
        { type: "tool_result", tool_use_id: "read-2", content: "tool" },
      ],
    });
    const toolBefore = structuredClone(toolRound);
    expect(r.h.compact(toolRound, session).applied).toBe("none");
    expect(toolRound).toEqual(toolBefore);
    await r.h.whenIdle();

    const swapping = human();
    const source = structuredClone(swapping);
    expect(r.h.compact(swapping, session).applied).toBe("swapped");
    const expected = [
      { role: "user", content: "[claudish: summary of the earlier conversation]\n" + summary },
      source.messages[2],
      {
        role: "assistant",
        content: [
          { type: "text", text: "Inspect file" },
          { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "src/task.ts" } },
        ],
      },
      source.messages[4],
      source.messages[5],
    ];
    expect(swapping.messages).toEqual(expected);
    const swaps = () =>
      r.store.list(session).filter(([, record]) => record.kind === "history-swap");
    expect(swaps()).toHaveLength(1);
    const serialized = JSON.stringify(swapping.messages);

    const reloaded = new HistoryCompactor({
      store: new CompactionStore(root),
      client: r.client,
      settings: r.settings,
      contextWindowOf: () => undefined,
      autoCompactWindow: () => undefined,
    });
    active.push(reloaded);
    for (const h of [r.h, reloaded]) {
      for (let i = 0; i < 3; i++) {
        const later = structuredClone(source);
        const newThinking: Message = {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "NEW_REASONING", signature: "new-sig" },
            { type: "text", text: "new text" },
          ],
        };
        later.messages.push(newThinking);
        expect(h.replay(later, session)).toBe(true);
        expect(JSON.stringify(later.messages.slice(0, -1))).toBe(serialized);
        expect(later.messages[later.messages.length - 1]).toEqual(newThinking);
      }
    }
    expect(swaps()).toHaveLength(1);
    expect(r.requests).toHaveLength(1);

    // A changed message in the summarised prefix [0, b) rejects the swap.
    for (const index of [0, 1]) {
      const different = structuredClone(source);
      different.messages[index] = { role: different.messages[index]!.role, content: "CHANGED" };
      const before = structuredClone(different);
      expect(reloaded.replay(different, session)).toBe(false);
      expect(different).toEqual(before);
    }
    // A changed message in the kept turns [b, end) still replays the same summary bytes.
    const summaryBytes = JSON.stringify(JSON.parse(serialized)[0]);
    for (const index of [2, 3, 5]) {
      const different = structuredClone(source);
      different.messages[index] = { role: different.messages[index]!.role, content: "CHANGED" };
      expect(reloaded.replay(different, session)).toBe(true);
      expect(JSON.stringify(different.messages[0])).toBe(summaryBytes);
    }
  });

  test("REQ-18: catalog window is required and launch window can only lower it", () => {
    expect(HISTORY_SUMMARY_TIMEOUT_MS).toBe(180000);
    for (const [catalog, launch, expected] of [
      [undefined, 100000, undefined],
      [0, 100000, undefined],
      [-1, 100000, undefined],
      [200000, undefined, 200000],
      [200000, 100000, 100000],
      [200000, 1000000, 200000],
      [200000, 0, 200000],
      [200000, -1, 200000],
    ])
      expect(effectiveHistoryLimit(catalog, launch)).toBe(expected);
    for (const [input, expected] of [
      ["50000", 100000],
      [2000000, 1000000],
      ["250000", 250000],
      ["nonsense", undefined],
      [0, undefined],
      [-1, undefined],
      [undefined, undefined],
    ] as const) {
      setLaunchAutoCompactWindow(input);
      expect(getLaunchAutoCompactWindow()).toBe(expected);
    }
    const value = { a: "é", messages: [{ role: "user", content: "test" }] };
    expect(localTokenEstimate(value)).toBe(Math.ceil(JSON.stringify(value).length / 4));
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(localTokenEstimate(cyclic)).toBe(0);
  });

  test("REQ-18: unknown context starts no history work and leaves large requests unchanged", async () => {
    const r = rig();
    const h = new HistoryCompactor({
      store: r.store,
      client: r.client,
      settings: r.settings,
      contextWindowOf: () => undefined,
      autoCompactWindow: () => 100000,
    });
    active.push(h);
    const p = human();
    const before = structuredClone(p);
    expect(h.compact(p, session).precomputeStarted).toBe(false);
    await h.whenIdle();
    expect(p).toEqual(before);
    expect(r.requests).toHaveLength(0);
  });

  test("REQ-19 REQ-21: exact precompute and apply thresholds are inclusive", async () => {
    const r = rig();
    function at(tokens: number): Payload {
      const p: Payload = {
        model,
        system: "",
        messages: [
          { role: "user", content: "earlier" },
          { role: "assistant", content: "answer" },
          { role: "user", content: "new turn" },
        ],
      };
      p.system = "p".repeat(tokens * 4 - JSON.stringify(p).length);
      expect(localTokenEstimate(p)).toBe(tokens);
      return p;
    }
    expect(r.h.compact(at(5999), session).precomputeStarted).toBe(false);
    expect(r.requests).toHaveLength(0);
    expect(r.h.compact(at(6000), session).precomputeStarted).toBe(true);
    await r.h.whenIdle();
    expect(r.h.compact(at(7999), session).applied).toBe("none");
    expect(r.h.compact(at(8000), session).applied).toBe("swapped");
    expect(r.requests).toHaveLength(1);
  });

  test("REQ-11: text beside a tool_result is not a human-turn start", () => {
    const cases: Array<[Message, boolean]> = [
      [{ role: "user", content: "new question" }, true],
      [{ role: "user", content: " \n" }, false],
      [{ role: "assistant", content: "text" }, false],
      [{ role: "user", content: [{ type: "text", text: "new question" }] }, true],
      [{ role: "user", content: [{ type: "text", text: "  " }] }, false],
      [
        {
          role: "user",
          content: [
            { type: "text", text: "text" },
            { type: "tool_result", tool_use_id: "x", content: "result" },
          ],
        },
        false,
      ],
    ];
    for (const [message, expected] of cases) expect(isHumanTurnStart(message)).toBe(expected);
    expect(
      stripThinking({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "redacted_thinking", data: "hidden" },
        ],
      })
    ).toEqual({ role: "assistant", content: [{ type: "text", text: "(reasoning omitted)" }] });
  });

  test("REQ-10 REQ-21: history hashes ignore JSON key order but detect content changes", () => {
    const a = [{ role: "user", content: [{ type: "text", text: "same" }] }];
    const b = [{ content: [{ text: "same", type: "text" }], role: "user" }];
    expect(messagesHash(a, 0, 1)).toBe(messagesHash(b, 0, 1));
    b[0]!.content[0]!.text = "different";
    expect(messagesHash(a, 0, 1)).not.toBe(messagesHash(b, 0, 1));
  });

  test("REQ-20: history rendering removes thinking and caps tool results, tool inputs and text", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "x", content: "R".repeat(2000) + "RESULT_AFTER_CAP" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "SECRET_THINKING" },
          { type: "redacted_thinking", data: "SECRET_REDACTED" },
          {
            type: "tool_use",
            id: "x",
            name: "Bash",
            input: { command: "I".repeat(1200) + "INPUT_AFTER_CAP" },
          },
          { type: "text", text: "T".repeat(20000) + "TEXT_AFTER_CAP" },
        ],
      },
    ];
    const rendered = renderMessages(messages, 0, messages.length);
    expect(rendered).toContain("R".repeat(100));
    expect(rendered).toContain("I".repeat(100));
    expect(rendered).toContain("T".repeat(100));
    expect(rendered).not.toMatch(
      /RESULT_AFTER_CAP|INPUT_AFTER_CAP|TEXT_AFTER_CAP|SECRET_THINKING|SECRET_REDACTED/
    );
    const many: Message[] = [
      { role: "user", content: "FIRST_MESSAGE_STAYS" },
      ...Array.from({ length: 30 }, (_, i) => ({
        role: "user",
        content: "message-" + i + "X".repeat(19900),
      })),
    ];
    const bounded = summaryRequestText(renderMessages(many, 0, many.length));
    expect(bounded.length).toBeLessThanOrEqual(400000);
    expect(bounded).toContain("FIRST_MESSAGE_STAYS");
    expect(bounded).toContain("message-29");
    expect(bounded).not.toContain("message-0");
    for (const term of [/goal/i, /decision/i, /path/i, /task/i, /error/i])
      expect(HISTORY_SYSTEM_PROMPT).toMatch(term);
  });

  for (const failure of ["500", "max_tokens"] as const) {
    test("REQ-22: failed " +
      failure +
      " summary is final across requests and restart", async () => {
      const r = rig(() =>
        failure === "500"
          ? Response.json({ error: { message: "test" } }, { status: 500 })
          : response(summary, "max_tokens")
      );
      const p = payload();
      r.h.compact(p, session);
      await r.h.whenIdle();
      const reload = new HistoryCompactor({
        store: new CompactionStore(root),
        client: r.client,
        settings: r.settings,
        contextWindowOf: () => 10000,
        autoCompactWindow: () => undefined,
      });
      active.push(reload);
      for (const h of [r.h, reload]) {
        const repeated = payload();
        const before = structuredClone(repeated);
        expect(h.compact(repeated, session).precomputeStarted).toBe(false);
        await h.whenIdle();
        expect(repeated).toEqual(before);
      }
      expect(r.requests).toHaveLength(1);
    });
  }

  test("REQ-22: roll-forward summarizes only new turns and largest matching swap wins", async () => {
    let count = 0;
    const r = rig(() => response(++count === 1 ? "FIRST_SUMMARY" : "SECOND_SUMMARY"));
    r.h.compact(payload(), session);
    await r.h.whenIdle();
    const firstSource = human();
    const first = structuredClone(firstSource);
    expect(r.h.compact(first, session).applied).toBe("swapped");
    await r.h.whenIdle();
    const extended = structuredClone(firstSource);
    extended.messages.push({
      role: "assistant",
      content: "NEW_TURNS_SENTINEL " + "work ".repeat(5000),
    });
    extended.messages.push({ role: "user", content: "Next turn" });
    expect(r.h.compact(structuredClone(extended), session).precomputeStarted).toBe(true);
    await r.h.whenIdle();
    expect(r.requests).toHaveLength(2);
    const secondCall = await r.requests[1]!.json();
    expect(secondCall.messages[0].content).toContain("FIRST_SUMMARY");
    expect(secondCall.messages[0].content).toContain("NEW_TURNS_SENTINEL");
    expect(secondCall.messages[0].content).not.toContain("OLD_PREFIX_SENTINEL");
    extended.messages.push({ role: "assistant", content: "more work" });
    extended.messages.push({ role: "user", content: "Continue " + "next ".repeat(2500) });
    const second = structuredClone(extended);
    expect(r.h.compact(second, session).applied).toBe("swapped");
    expect(second.messages[0]!.content).toBe(
      "[claudish: summary of the earlier conversation]\nSECOND_SUMMARY"
    );
    const replay = structuredClone(extended);
    expect(r.h.replay(replay, session)).toBe(true);
    expect(replay.messages).toEqual(second.messages);
    expect(r.store.list(session).filter(([, rec]) => rec.kind === "history-swap")).toHaveLength(2);
  });

  test("REQ-21: a ready summary cannot swap when its record cannot reach disk", async () => {
    const r = rig();
    r.h.compact(payload(), session);
    await r.h.whenIdle();
    rmSync(join(root, session), { recursive: true, force: true });
    writeFileSync(join(root, session), "not a directory");
    const p = human();
    const before = structuredClone(p);
    expect(r.h.compact(p, session).applied).toBe("none");
    expect(p).toEqual(before);
  });
}
