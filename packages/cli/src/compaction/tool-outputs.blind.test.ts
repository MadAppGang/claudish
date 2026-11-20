import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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

  const { CompactionClient } = await import("./haiku-client.js");
  const { CompactionStore, toolOutputKey } = await import("./store.js");
  const { ToolOutputCompactor } = await import("./tool-outputs.js");
  const { DEFAULT_COMPACTION_SETTINGS } = await import("./config.js");
  const session = "b2e278be-03e8-43ed-a7cc-4ed551280500";
  const key = "FAKE_COMPACTION_KEY_00000000";
  const model = "claude-haiku-5-5";
  const original = "src/worker.ts:42 E_FAIL command=bun test count=123\n".repeat(400);
  const summary = "src/worker.ts:42 E_FAIL command=bun test count=123";
  let root: string;
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "compaction-tool-"));
    root = join(workspace, "store");
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function answer(text = summary, stop = "end_turn") {
    return Response.json({
      id: "test-message",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      stop_reason: stop,
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  }
  function payload(text = original, id = "tool-1", name = "Bash") {
    return {
      model,
      metadata: {
        user_id: JSON.stringify({ device_id: "d", account_uuid: "a", session_id: session }),
      },
      messages: [
        { role: "user", content: "Inspect the output" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id, name, input: { command: "bun test" } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
      ],
    };
  }
  function resultText(p: ReturnType<typeof payload>) {
    return (p.messages[2]!.content as Array<{ content: unknown }>)[0]!.content;
  }
  function rig(
    reply: (request: Request) => Response | Promise<Response> = () => answer(),
    timeoutMs = 1000
  ) {
    const requests: Request[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return reply(request);
    }) as unknown as typeof fetch;
    // effort as resolved for a model whose catalog wire publishes the low effort.
    const client = new CompactionClient({
      apiKey: key,
      model,
      effort: "low",
      fetchImpl,
      warn() {},
      record() {},
    });
    const settings = { enabled: true, minTokens: 4000, timeoutMs, maxRatio: 0.6 };
    const store = new CompactionStore(root);
    const compactor = new ToolOutputCompactor({ store, client, settings });
    return { requests, client, settings, store, compactor };
  }

  test("REQ-6 REQ-8 REQ-10 REQ-15: compress once and replay identical bytes through three requests and restart", async () => {
    const r = rig();
    const first = payload();
    const untouched = structuredClone(first);
    await r.compactor.compact(first, session);
    const path = join(root, session, toolOutputKey(session, "tool-1", original) + ".txt");
    const expected =
      summary +
      "\n\n[claudish compressed this output from " +
      original.length +
      " to " +
      summary.length +
      " characters. Full output: " +
      path +
      ". Read it if you need anything that is not here.]";
    expect(resultText(first)).toBe(expected);
    expect(first.messages.slice(0, 2)).toEqual(untouched.messages.slice(0, 2));
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, session)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(path.replace(/\.txt$/, ".json")).mode & 0o777).toBe(0o600);

    for (let turn = 0; turn < 3; turn++) {
      const later = JSON.parse(JSON.stringify(payload(), null, turn + 1));
      later.messages.push({ content: "follow-up " + turn, role: "user" });
      await r.compactor.compact(later, session);
      expect(resultText(later)).toBe(expected);
    }
    const reloaded = new ToolOutputCompactor({
      store: new CompactionStore(root),
      client: r.client,
      settings: r.settings,
    });
    const resumed = payload();
    await reloaded.compact(resumed, session);
    expect(resultText(resumed)).toBe(expected);
    expect(r.requests).toHaveLength(1);
  });

  test("REQ-7: first sighting outside the last message stays original even if later moved to the last message", async () => {
    const r = rig();
    const earlier = payload();
    earlier.messages.push({ role: "user", content: "Already seen" });
    await r.compactor.compact(earlier, session);
    expect(resultText(earlier)).toBe(original);
    for (const compactor of [
      r.compactor,
      new ToolOutputCompactor({
        store: new CompactionStore(root),
        client: r.client,
        settings: r.settings,
      }),
    ]) {
      for (let i = 0; i < 3; i++) {
        const p = payload();
        await compactor.compact(p, session);
        expect(resultText(p)).toBe(original);
      }
    }
    expect(r.requests).toHaveLength(0);
  });

  for (const failure of [
    "timeout",
    "429",
    "400",
    "401",
    "403",
    "500",
    "503",
    "ratio",
    "max_tokens",
    "empty",
    "transport",
  ] as const) {
    test("REQ-9: " + failure + " keeps original permanently with no second call", async () => {
      const r = rig((request) => {
        if (failure === "timeout")
          return new Promise<Response>((_resolve, reject) => {
            const abort = () => reject(new DOMException("aborted", "AbortError"));
            if (request.signal.aborted) abort();
            else request.signal.addEventListener("abort", abort, { once: true });
          });
        if (failure === "transport") throw new TypeError("test transport failure");
        if (/^\d+$/.test(failure))
          return Response.json(
            {
              type: "error",
              error: { type: "api_error", message: failure === "429" ? "Error" : "test failure" },
            },
            { status: Number(failure) }
          );
        if (failure === "ratio")
          return answer(original.slice(0, Math.ceil(original.length * 0.61)));
        if (failure === "max_tokens") return answer(summary, "max_tokens");
        return answer("");
      }, 30);
      const p = payload();
      await r.compactor.compact(p, session);
      expect(resultText(p)).toBe(original);
      for (const compactor of [
        r.compactor,
        new ToolOutputCompactor({
          store: new CompactionStore(root),
          client: r.client,
          settings: r.settings,
        }),
      ]) {
        for (let i = 0; i < 3; i++) {
          const later = payload();
          await compactor.compact(later, session);
          expect(resultText(later)).toBe(original);
        }
      }
      expect(r.requests).toHaveLength(1);
    });
  }

  test("REQ-15: a compressed body below the ratio is rejected when its footer makes the full replacement too large", async () => {
    const r = rig(() => answer(original.slice(0, Math.floor(original.length * 0.6) - 1)));
    const p = payload();
    await r.compactor.compact(p, session);
    expect(resultText(p)).toBe(original);
    await r.compactor.compact(payload(), session);
    expect(r.requests).toHaveLength(1);
  });

  for (const excluded of ["small", "error", "image", "mixed", "advisor", "assistant"] as const) {
    test("REQ-12: leaves " + excluded + " output untouched without a model request", async () => {
      const r = rig();
      const p = payload(
        excluded === "small" ? "x".repeat(15996) : original,
        "tool-1",
        excluded === "advisor" ? "advisor" : "Bash"
      );
      const blocks = p.messages[2]!.content as Array<Record<string, unknown>>;
      if (excluded === "error") blocks[0]!.is_error = true;
      if (excluded === "image" || excluded === "mixed") {
        blocks[0]!.content = [
          ...(excluded === "mixed" ? [{ type: "text", text: original }] : []),
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
        ];
      }
      if (excluded === "assistant") p.messages[2]!.role = "assistant";
      const before = structuredClone(p);
      await r.compactor.compact(p, session);
      expect(p).toEqual(before);
      expect(r.requests).toHaveLength(0);
    });
  }

  test("REQ-12: accepts exactly minTokens by ceil(chars/4)", async () => {
    const r = rig();
    const p = payload("x".repeat(15997));
    await r.compactor.compact(p, session);
    expect(resultText(p)).not.toBe("x".repeat(15997));
    expect(r.requests).toHaveLength(1);
  });

  test("REQ-12: text arrays recover joined text and preserve the final cache_control", async () => {
    const r = rig();
    const p = payload();
    const blocks = p.messages[2]!.content as Array<Record<string, unknown>>;
    const cacheControl = { type: "ephemeral", ttl: "1h" };
    blocks[0]!.content = [
      { type: "text", text: original, cache_control: { type: "ephemeral" } },
      { type: "text", text: "last line", cache_control: cacheControl },
    ];
    await r.compactor.compact(p, session);
    const contents = blocks[0]!.content as Array<{
      type: string;
      text: string;
      cache_control: unknown;
    }>;
    expect(contents).toHaveLength(1);
    expect(contents[0]).toMatchObject({ type: "text", cache_control: cacheControl });
    expect(contents[0]!.text).toStartWith(summary + "\n\n");
    const joined = original + "\nlast line";
    expect(
      readFileSync(join(root, session, toolOutputKey(session, "tool-1", joined) + ".txt"), "utf8")
    ).toBe(joined);
  });

  test("REQ-6: concurrent identical first sightings share one decision", async () => {
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const r = rig(() => response);
    const a = payload();
    const c = payload();
    const pending = Promise.all([r.compactor.compact(a, session), r.compactor.compact(c, session)]);
    release(answer());
    await pending;
    expect(resultText(a)).toBe(resultText(c));
    expect(resultText(a)).not.toBe(original);
    expect(r.requests).toHaveLength(1);
  });

  test("REQ-6: session, tool id and original text each distinguish decisions", async () => {
    const r = rig();
    for (const [sid, id, text] of [
      [session, "tool-1", original],
      [session + "-other", "tool-1", original],
      [session, "tool-2", original],
      [session, "tool-1", original + "changed"],
    ]) {
      const p = payload(text, id);
      await r.compactor.compact(p, sid!);
      expect(resultText(p)).not.toBe(text);
    }
    expect(r.requests).toHaveLength(4);
  });

  test("REQ-13: both candidates start before either reply completes", async () => {
    const releases: Array<(response: Response) => void> = [];
    let bothStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    const r = rig(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
          if (releases.length === 2) bothStarted();
        })
    );
    const p = payload();
    const blocks = p.messages[2]!.content as Array<Record<string, unknown>>;
    blocks.push({ type: "tool_result", tool_use_id: "tool-2", content: original });
    const pending = r.compactor.compact(p, session);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        started,
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(
            () => reject(new Error("second candidate did not start in parallel")),
            500
          );
        }),
      ]);
      expect(r.requests).toHaveLength(2);
    } finally {
      clearTimeout(watchdog);
      for (const release of releases) release(answer());
      await pending;
    }
    expect(blocks.every((block) => block.content !== original)).toBe(true);
    expect(DEFAULT_COMPACTION_SETTINGS.toolOutputs.timeoutMs).toBe(20000);
  });

  test("REQ-14 REQ-25: sends only the fixed API-key request with capped input and no harness identity", async () => {
    const r = rig();
    const p = payload();
    const input = { command: "BEGIN_" + "x".repeat(2500) + "_END_SENTINEL" };
    (p.messages[1]!.content as Array<Record<string, unknown>>)[0]!.input = input;
    const hostile = Object.assign(p, {
      system: "You are Claude Code. INBOUND_IDENTITY",
      headers: {
        authorization: "Bearer INBOUND_LOGIN",
        "x-api-key": "INBOUND_KEY",
        "x-inbound": "INBOUND_HEADER",
      },
    });
    await r.compactor.compact(hostile, session);
    expect(r.requests).toHaveLength(1);
    const req = r.requests[0]!;
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req.method).toBe("POST");
    const headers: Record<string, string> = {};
    req.headers.forEach((value, name) => {
      headers[name] = value;
    });
    expect(headers).toEqual({
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    });
    const sent = await req.json();
    expect(sent).toEqual({
      model,
      system: expect.any(String),
      messages: [{ role: "user", content: expect.any(String) }],
      max_tokens: 4096,
      output_config: { effort: "low" },
    });
    expect(sent.messages[0].content).toContain("Bash");
    expect(sent.messages[0].content).toContain(original);
    expect(sent.messages[0].content).toContain("BEGIN_");
    expect(sent.messages[0].content).not.toContain("x".repeat(2001));
    expect(sent.messages[0].content).not.toContain("_END_SENTINEL");
    expect(sent.system).not.toContain("Claude Code");
    expect(JSON.stringify(sent)).not.toMatch(/INBOUND_(IDENTITY|LOGIN|KEY|HEADER)/);
    for (const directive of [
      /error/i,
      /path/i,
      /line/i,
      /identifier/i,
      /command/i,
      /number/i,
      /verbatim/i,
    ]) {
      expect(sent.system).toMatch(directive);
    }
  });
}
