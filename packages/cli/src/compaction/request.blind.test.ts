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
  const localFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol === "http:" || url.protocol === "https:") {
      throw new Error("Unexpected network access in blind tests");
    }
    return localFetch(input, init);
  }) as typeof fetch;

  const { readdirSync, readFileSync, writeFileSync, mkdirSync, utimesSync, existsSync } =
    await import("node:fs");
  const { CompactionClient } = await import("./haiku-client.js");
  const { CompactionStore } = await import("./store.js");
  const { ToolOutputCompactor } = await import("./tool-outputs.js");
  const { HistoryCompactor } = await import("./history.js");
  const { DEFAULT_COMPACTION_SETTINGS } = await import("./config.js");
  const { prepareCompaction } = await import("./runtime.js");
  const { compactionSessionOf, compactRequest, applyStoredForms } = await import("./decorator.js");
  const { redactSecrets, redactSigningValues } = await import("../redact.js");
  const model = "claude-haiku-5-5";
  const key = "FAKE_STARTUP_KEY_00000000000";
  const session = "f154cfba-8f60-4698-bb66-9465eb8fd809";
  const original = "output ".repeat(3000);
  let root: string;
  const active: InstanceType<typeof HistoryCompactor>[] = [];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "compaction-request-"));
  });
  afterEach(async () => {
    await Promise.all(active.splice(0).map((h) => h.whenIdle()));
    rmSync(root, { recursive: true, force: true });
  });
  function settings(enabled = true) {
    return {
      ...DEFAULT_COMPACTION_SETTINGS,
      enabled,
      model,
      toolOutputs: { ...DEFAULT_COMPACTION_SETTINGS.toolOutputs, timeoutMs: 1000 },
      history: { ...DEFAULT_COMPACTION_SETTINGS.history },
    };
  }
  function response(status = 200, errorType = "api_error") {
    return status === 200
      ? Response.json({
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text: "compressed" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 10 },
        })
      : Response.json({ type: "error", error: { type: errorType, message: "Error" } }, { status });
  }
  function upstream(status = 200, errorType = "api_error") {
    const requests: Request[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return response(status, errorType);
    }) as unknown as typeof fetch;
    return { requests, fetchImpl };
  }
  function payload() {
    return {
      model,
      metadata: {
        user_id: JSON.stringify({
          device_id: "DEVICE_MUST_NOT_PERSIST",
          account_uuid: "a",
          session_id: session,
        }),
      },
      messages: [
        { role: "user", content: "run the command" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "x", name: "Bash", input: { command: "ls" } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: original }] },
      ],
    };
  }
  function runtime() {
    const upstreamData = upstream();
    const client = new CompactionClient({
      apiKey: key,
      model,
      fetchImpl: upstreamData.fetchImpl,
      warn() {},
      record() {},
    });
    const store = new CompactionStore(root);
    const s = settings();
    const toolOutputs = new ToolOutputCompactor({ store, client, settings: s.toolOutputs });
    const history = new HistoryCompactor({
      store,
      client,
      settings: s.history,
      contextWindowOf: () => 10000,
      autoCompactWindow: () => undefined,
    });
    active.push(history);
    return {
      runtime: { settings: s, model, client, store, toolOutputs, history },
      ...upstreamData,
    };
  }

  test("REQ-4: count_tokens stored-only pass never makes a first-sighting decision", async () => {
    const r = runtime();
    const fresh = payload();
    const before = structuredClone(fresh);
    await applyStoredForms(r.runtime, fresh);
    expect(fresh).toEqual(before);
    expect(r.requests).toHaveLength(0);
    expect(r.runtime.store.list(session)).toHaveLength(0);

    const sent = payload();
    await compactRequest(r.runtime, sent);
    expect(sent.messages).not.toEqual(before.messages);
    expect(r.requests).toHaveLength(1);
    const count = payload();
    await applyStoredForms(r.runtime, count);
    expect(count).toEqual(sent);
    expect(r.requests).toHaveLength(1);
    const disk = readdirSync(join(root, session))
      .map((name) => readFileSync(join(root, session, name), "utf8"))
      .join("\n");
    expect(disk).not.toContain("DEVICE_MUST_NOT_PERSIST");
  });

  test("REQ-4 REQ-11: stored-only history pass replays without a new summary or record", async () => {
    const r = runtime();
    const first = {
      model,
      metadata: payload().metadata,
      messages: [
        { role: "user", content: "old ".repeat(7000) },
        { role: "assistant", content: "answer" },
        { role: "user", content: "new turn" },
      ],
    };
    await compactRequest(r.runtime, structuredClone(first));
    await r.runtime.history.whenIdle();
    const source = structuredClone(first);
    source.messages.push({ role: "assistant", content: "more" });
    source.messages.push({ role: "user", content: "continue ".repeat(1400) });
    const applied = structuredClone(source);
    await compactRequest(r.runtime, applied);
    await r.runtime.history.whenIdle();
    expect(applied.messages[0]!.content).toBe(
      "[claudish: summary of the earlier conversation]\ncompressed"
    );
    const beforeRecords = r.runtime.store.list(session);
    const beforeCalls = r.requests.length;
    const count = structuredClone(source);
    await applyStoredForms(r.runtime, count);
    expect(count).toEqual(applied);
    expect(r.requests).toHaveLength(beforeCalls);
    expect(r.runtime.store.list(session)).toEqual(beforeRecords);
  });

  for (const userId of [
    undefined,
    "",
    "{broken",
    "{}",
    JSON.stringify({ device_id: session }),
    JSON.stringify({ session_id: "../escape" }),
    JSON.stringify({ session_id: "x".repeat(129) }),
  ]) {
    test("REQ-5: missing or invalid session leaves request untouched: " + userId, async () => {
      const r = runtime();
      const p = payload();
      if (userId === undefined) Reflect.deleteProperty(p.metadata, "user_id");
      else p.metadata.user_id = userId;
      const before = structuredClone(p);
      expect(compactionSessionOf(p) == null).toBe(true);
      await compactRequest(r.runtime, p);
      await applyStoredForms(r.runtime, p);
      expect(p).toEqual(before);
      expect(r.requests).toHaveLength(0);
      expect(readdirSync(root)).toEqual([]);
    });
  }
  test("REQ-5: extracts only the session id from parsed metadata", () => {
    expect(compactionSessionOf(payload())).toBe(session);
  });

  test("REQ-4: disabled capabilities leave even recorded forms untouched", async () => {
    const r = runtime();
    await compactRequest(r.runtime, payload());
    r.runtime.settings.toolOutputs.enabled = false;
    r.runtime.settings.history.enabled = false;
    const p = payload();
    const before = structuredClone(p);
    await compactRequest(r.runtime, p);
    await applyStoredForms(r.runtime, p);
    expect(p).toEqual(before);
    expect(r.requests).toHaveLength(1);
  });

  for (const source of ["config", "keychain"] as const) {
    test("REQ-23 REQ-24: " +
      source +
      " key is resolved once, redacted by value, and never hydrated into env", async () => {
      const key = "FAKE_STARTUP_" + source.toUpperCase() + "_00000000000";
      expect(redactSigningValues(key)).toBe(key);
      const u = upstream();
      const warnings: string[] = [];
      const resolutions: string[] = [];
      const beforeEnv = { ...process.env };
      const credentials = {
        async resolveForUse(provider: string) {
          resolutions.push(provider);
          return { state: "present" as const, key, source };
        },
      };
      const rt = await prepareCompaction({
        settings: settings(),
        storeRoot: root,
        credentials,
        fetchImpl: u.fetchImpl,
        warn: (message: string) => warnings.push(message),
        record() {},
      });
      expect(rt).not.toBeNull();
      if (!rt) throw new Error("Exact model and present test key must enable compaction");
      active.push(rt.history);
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect({ ...process.env }).toEqual(beforeEnv);
      const signingRedacted = redactSigningValues("before " + key + " after");
      expect(signingRedacted).not.toContain(key);
      expect(signingRedacted).toStartWith("before ");
      expect(signingRedacted).toEndWith(" after");
      expect(redactSecrets("before " + key + " after")).not.toContain(key);
      expect(redactSecrets("ordinary harmless text")).toBe("ordinary harmless text");
      for (let i = 0; i < 3; i++) await compactRequest(rt, payload());
      expect(resolutions).toEqual(["anthropic"]);
      expect(u.requests).toHaveLength(1);
      expect(u.requests[0]!.headers.get("x-api-key")).toBe(key);
      expect(warnings).toEqual([]);
      expect({ ...process.env }).toEqual(beforeEnv);
      const files = readdirSync(join(root, session));
      for (const name of files)
        expect(readFileSync(join(root, session, name), "utf8")).not.toContain(key);
    });
  }

  for (const state of ["disabled", "absent", "failed", "bad-model"] as const) {
    test("REQ-2 REQ-23: " +
      state +
      " returns no runtime and the specified warning count", async () => {
      const u = upstream();
      const warnings: string[] = [];
      const opts = settings(state !== "disabled");
      if (state === "bad-model") opts.model = "not-a-claude-model";
      const rt = await prepareCompaction({
        settings: opts,
        storeRoot: root,
        fetchImpl: u.fetchImpl,
        credentials: {
          async resolveForUse() {
            if (state === "failed")
              return { state: "failed" as const, reason: "test credential failure" };
            return { state: "absent" as const, searched: [] };
          },
        },
        warn: (message: string) => warnings.push(message),
        record() {},
      });
      expect(rt).toBeNull();
      expect(warnings).toHaveLength(state === "disabled" ? 0 : 1);
      expect(u.requests).toHaveLength(0);
    });
  }

  test("REQ-17: startup purges expired folders but preserves the known resumed session", async () => {
    for (const id of ["old", "resumed"]) {
      mkdirSync(join(root, id));
      const file = join(root, id, "old.txt");
      writeFileSync(file, "old");
      const old = new Date(Date.now() - 8 * 86400000);
      utimesSync(file, old, old);
      utimesSync(join(root, id), old, old);
    }
    const u = upstream();
    const rt = await prepareCompaction({
      settings: settings(),
      storeRoot: root,
      keepSessionIds: ["resumed"],
      fetchImpl: u.fetchImpl,
      credentials: {
        async resolveForUse() {
          return { state: "present" as const, key, source: "config" as const };
        },
      },
      warn() {},
      record() {},
    });
    expect(rt).not.toBeNull();
    if (rt) active.push(rt.history);
    expect(existsSync(join(root, "old"))).toBe(false);
    expect(existsSync(join(root, "resumed", "old.txt"))).toBe(true);
  });

  test("REQ-26 REQ-27: three 401s disable compaction with one warning and three events", async () => {
    const u = upstream(401);
    const warnings: string[] = [];
    const events: unknown[] = [];
    const client = new CompactionClient({
      apiKey: key,
      model,
      fetchImpl: u.fetchImpl,
      warn: (message: string) => warnings.push(message),
      record: (event: unknown) => events.push(event),
    });
    for (let i = 0; i < 3; i++) {
      expect(client.disabled).toBe(false);
      const result = await client.complete({
        system: "compress",
        user: "output",
        maxTokens: 4096,
        timeoutMs: 1000,
        purpose: "tool-output",
      });
      expect(result).toMatchObject({ ok: false, status: 401 });
      expect(client.disabled).toBe(i === 2);
    }
    for (let i = 0; i < 2; i++)
      expect(
        await client.complete({
          system: "compress",
          user: "later",
          maxTokens: 4096,
          timeoutMs: 1000,
          purpose: "tool-output",
        })
      ).toMatchObject({ ok: false });
    expect(u.requests).toHaveLength(3);
    expect(warnings).toHaveLength(1);
    expect(events).toHaveLength(3);
    for (const event of events)
      expect(event).toMatchObject({
        provider_name: "anthropic",
        request_role: "compaction",
        stream_format: "anthropic-messages",
      });
  });

  test("REQ-26: 429 Error without quota headers is reported as a shape refusal", async () => {
    const u = upstream(429, "rate_limit_error");
    const client = new CompactionClient({
      apiKey: key,
      model,
      fetchImpl: u.fetchImpl,
      warn() {},
      record() {},
    });
    const result = await client.complete({
      system: "compress",
      user: "output",
      maxTokens: 4096,
      timeoutMs: 1000,
      purpose: "tool-output",
    });
    expect(result).toMatchObject({ ok: false, status: 429, shapeRefusal: true });
    expect(u.requests).toHaveLength(1);
  });

  test("REQ-27: each successful HTTP call records a compaction event", async () => {
    const u = upstream();
    const events: unknown[] = [];
    const client = new CompactionClient({
      apiKey: key,
      model,
      fetchImpl: u.fetchImpl,
      warn() {},
      record: (event: unknown) => events.push(event),
    });
    for (let i = 0; i < 2; i++)
      expect(
        await client.complete({
          system: "compress",
          user: "output",
          maxTokens: 4096,
          timeoutMs: 1000,
          purpose: "tool-output",
        })
      ).toMatchObject({ ok: true, text: "compressed" });
    expect(events).toHaveLength(2);
    expect(u.requests).toHaveLength(2);
    for (const event of events)
      expect(event).toMatchObject({
        provider_name: "anthropic",
        request_role: "compaction",
        stream_format: "anthropic-messages",
        estimated_cost: expect.any(Number),
      });
  });
}
