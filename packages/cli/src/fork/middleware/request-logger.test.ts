/**
 * request-logger capture — regression test.
 *
 * Pins the capture file contract that the fork's outage-reconciliation scripts
 * (compress-captures.ps1 / reconcile-outage-captures.ps1) depend on:
 *   filename: req-<pid>-<NNNN>-<ISO ts>-<src>.json
 *   payload:  { ts, src, machine, model, pid, body }
 * and the 2026-08-20 fix: the write is fire-and-forget async, so the request
 * path never blocks on the event loop.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { logRequest } from "./request-logger";

function mkRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/v1/messages", {
    method: "POST",
    headers,
  });
}

async function waitForCapture(dir: string, timeoutMs = 2000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = readdirSync(dir).filter((f) => f.startsWith("req-") && f.endsWith(".json"));
    if (files.length > 0) return join(dir, files[0]);
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

describe("request-logger capture (fork)", () => {
  let capDir: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    capDir = join(tmpdir(), `claudish-capture-test-${process.pid}-${Date.now()}`);
    prevEnv = process.env.CLAUDISH_CAPTURE_DIR;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.CLAUDISH_CAPTURE_DIR;
    else process.env.CLAUDISH_CAPTURE_DIR = prevEnv;
    try {
      rmSync(capDir, { recursive: true, force: true });
    } catch {}
  });

  it("writes a capture with the reconcile-script contract when CLAUDISH_CAPTURE_DIR is set", async () => {
    mkdirSync(capDir, { recursive: true });
    process.env.CLAUDISH_CAPTURE_DIR = capDir;

    logRequest(
      { model: "claude-haiku-4-5-20251001", messages: [{ role: "user", content: "x" }] },
      "test-handler",
      mkRequest({ "x-claudish-machine": "myia-test" }),
      new WeakMap()
    );

    const file = await waitForCapture(capDir);
    expect(file).not.toBeNull(); // async write must land
    const json = JSON.parse(readFileSync(file!, "utf8"));
    expect(json.machine).toBe("myia-test");
    expect(json.model).toBe("claude-haiku-4-5-20251001");
    expect(json.pid).toBe(process.pid);
    expect(typeof json.ts).toBe("string");
    expect(typeof json.src).toBe("string");
    expect(json.body.model).toBe("claude-haiku-4-5-20251001");
    // filename contract: req-<pid>-<NNNN>-<ts>-<src>.json (split handles win + unix separators)
    expect(file!.split(/[/\\]/).pop()).toMatch(/^req-\d+-\d{4}-[\dT-]+-[A-Za-z0-9._-]+\.json$/);
  });

  it("writes nothing when CLAUDISH_CAPTURE_DIR is unset", async () => {
    delete process.env.CLAUDISH_CAPTURE_DIR;
    mkdirSync(capDir, { recursive: true });

    logRequest({ model: "m", messages: [] }, "h", mkRequest(), new WeakMap());

    await new Promise((r) => setTimeout(r, 150));
    const files = readdirSync(capDir).filter((f) => f.startsWith("req-"));
    expect(files.length).toBe(0);
  });

  it("does not throw when the capture dir cannot be created", () => {
    // Point at a path under a FILE (mkdir must fail) — logRequest must not throw.
    const fakeParent = join(capDir, "blocker");
    mkdirSync(capDir, { recursive: true });
    writeFileSync(fakeParent, "i am a file, not a dir");
    process.env.CLAUDISH_CAPTURE_DIR = join(fakeParent, "captures");

    expect(() =>
      logRequest({ model: "m", messages: [] }, "h", mkRequest(), new WeakMap())
    ).not.toThrow();
  });

  // #98: attribution fields the proxy already sees at capture time, persisted
  // top-level in the envelope next to machine/model. Absent → simply omitted.
  it("persists device_id8 / entrypoint / workload from the live CC shapes (#98)", async () => {
    mkdirSync(capDir, { recursive: true });
    process.env.CLAUDISH_CAPTURE_DIR = capDir;

    logRequest(
      {
        model: "claude-sonnet-5",
        stream: true,
        messages: [{ role: "user", content: "x" }],
        metadata: {
          user_id:
            '{"customer_id":"cus_abc","device_id":"a1b2c3d4e5f60708","session_id":"11111111-2222-3333-4444-555555555555"}',
        },
        system: [
          {
            type: "text",
            text: "You are Claude Code.\nx-anthropic-billing-header: cc_version=2.1.258; cc_entrypoint=cli; cc_workload=cron;\nrest of the system prompt",
          },
        ],
      },
      "ComposedHandler",
      mkRequest({ "x-claudish-machine": "myia-po-2023" }),
      new WeakMap()
    );

    const file = await waitForCapture(capDir);
    expect(file).not.toBeNull();
    const json = JSON.parse(readFileSync(file!, "utf8"));
    expect(json.device_id8).toBe("a1b2c3d4");
    expect(json.entrypoint).toBe("cli");
    expect(json.workload).toBe("cron");
    // Top level, next to machine/model — not nested.
    expect(Object.keys(json)).toContain("device_id8");
  });

  it("omits absent attribution fields instead of writing empties (#98)", async () => {
    mkdirSync(capDir, { recursive: true });
    process.env.CLAUDISH_CAPTURE_DIR = capDir;

    logRequest(
      {
        model: "glm-5.3",
        messages: [{ role: "user", content: "x" }],
        system: "plain system prompt, no billing line",
      },
      "ComposedHandler",
      mkRequest(),
      new WeakMap()
    );

    const file = await waitForCapture(capDir);
    expect(file).not.toBeNull();
    const json = JSON.parse(readFileSync(file!, "utf8"));
    expect(json.device_id8).toBeUndefined();
    expect(json.entrypoint).toBeUndefined();
    expect(json.workload).toBeUndefined();
  });

  it("reads the billing line from a string-form system too, and never throws on garbage metadata (#98)", async () => {
    mkdirSync(capDir, { recursive: true });
    process.env.CLAUDISH_CAPTURE_DIR = capDir;

    logRequest(
      {
        model: "glm-5.3",
        messages: [],
        metadata: { user_id: "not json at all" },
        system: "x-anthropic-billing-header: cc_version=2.1.258; cc_entrypoint=agentSdk; cch=xyz;\nbody",
      },
      "ComposedHandler",
      mkRequest(),
      new WeakMap()
    );

    const file = await waitForCapture(capDir);
    expect(file).not.toBeNull();
    const json = JSON.parse(readFileSync(file!, "utf8"));
    expect(json.entrypoint).toBe("agentSdk");
    expect(json.workload).toBeUndefined();
    expect(json.device_id8).toBeUndefined();
  });
});

// Pinning of the stdout `[Request]` line — the contract the RSM consumer
// `claudish_traffic` (#3391) parses. If request-logger.ts changes the shape
// (renames a field, changes a separator, drops `machine=`), these tests fail,
// which is the point: the producer cannot drift silently from its consumer.
describe("request-logger stdout format (pinning — RSM consumer contract)", () => {
  // Mirrors claudish-traffic.ts REQUEST_RE: model, handler, src, stream|sync,
  // msgs, max_tokens, optional machine=, then ua to end of line.
  const consumerRe =
    /^\[claudish\] \[Request\] model=(\S+) handler=(\S+) src=(\S+) (stream|sync) msgs=(\d+) max_tokens=(\S+)(?: machine=(\S+))? ua=(.*)$/;

  function captureRequestLine(
    body: Record<string, unknown>,
    handler: string,
    headers: Record<string, string>
  ): string {
    const out: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: unknown) => {
      out.push(String(s));
      return true;
    }) as typeof process.stdout.write;
    try {
      logRequest(body, handler, mkRequest(headers), new WeakMap());
    } finally {
      process.stdout.write = orig;
    }
    const req = out.find((l) => l.startsWith("[claudish] [Request]"));
    expect(req, "must emit a [Request] line").toBeDefined();
    return req!.trim();
  }

  it("emits a line matching the consumer contract (stream + machine)", () => {
    const line = captureRequestLine(
      { model: "claude-sonnet-5", stream: true, messages: [{ role: "user", content: "x" }], max_tokens: 1024 },
      "NativeHandler",
      { "x-claudish-machine": "myia-po-2023" }
    );
    const m = consumerRe.exec(line);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("claude-sonnet-5");
    expect(m![2]).toBe("NativeHandler");
    expect(m![4]).toBe("stream");
    expect(m![5]).toBe("1");
    expect(m![6]).toBe("1024");
    expect(m![7]).toBe("myia-po-2023");
  });

  it("emits a line matching the contract (sync, no machine, max_tokens default)", () => {
    const line = captureRequestLine(
      { model: "glm-5.3", messages: [], max_tokens: 256 },
      "ComposedHandler",
      {}
    );
    const m = consumerRe.exec(line);
    expect(m).not.toBeNull();
    expect(m![4]).toBe("sync");
    expect(m![6]).toBe("256");
    expect(m![7]).toBeUndefined();
  });

  it("documented fixtures in __fixtures__/traffic-format still match the contract", () => {
    const fixture = readFileSync(
      join(import.meta.dir, "../../../__fixtures__/traffic-format/request-lines.txt"),
      "utf8"
    );
    const lines = fixture
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(consumerRe.exec(l), `fixture line must match contract: ${l}`).not.toBeNull();
    }
  });
});
