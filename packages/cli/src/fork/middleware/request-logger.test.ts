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
import { markInboundKey } from "../../handlers/shared/inbound-keys.js";
import { getInstanceId } from "../../instance-id.js";

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

  // #662: the per-process instanceId (#156) lands as a payload FIELD so a
  // capture read in isolation assigns to its container life (pid is 1 in every
  // life). The filename stays UNCHANGED — readers parse the name.
  it("persists instanceId as a payload field, filename unchanged (#662)", async () => {
    mkdirSync(capDir, { recursive: true });
    process.env.CLAUDISH_CAPTURE_DIR = capDir;

    logRequest({ model: "m", messages: [] }, "h", mkRequest(), new WeakMap());

    const file = await waitForCapture(capDir);
    expect(file).not.toBeNull();
    const json = JSON.parse(readFileSync(file!, "utf8"));
    expect(json.instanceId).toBe(getInstanceId());
    // UUID-shaped, not the pid: it must discriminate two lives of one pid.
    expect(json.instanceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    // filename contract unchanged by #662 — no instance segment in the name.
    expect(file!.split(/[/\\]/).pop()).toMatch(/^req-\d+-\d{4}-[\dT-]+-[A-Za-z0-9._-]+\.json$/);
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

  it("persists inbound_key when the request was authed by a scoped key, omits it otherwise (#400)", async () => {
    mkdirSync(capDir, { recursive: true });
    process.env.CLAUDISH_CAPTURE_DIR = capDir;

    // Marked off the same raw Request the auth middleware sees — the WeakMap
    // handoff is the whole attribution mechanism (dynamic external IPs are
    // useless; the key name is stable and revocation-scoped).
    const marked = mkRequest({ "x-claudish-machine": "external-dynamic-ip" });
    markInboundKey(marked, "external-jamin");
    logRequest(
      { model: "swift-1.5-27b", messages: [{ role: "user", content: "x" }] },
      "ComposedHandler",
      marked,
      new WeakMap()
    );

    let file = await waitForCapture(capDir);
    expect(file).not.toBeNull();
    let json = JSON.parse(readFileSync(file!, "utf8"));
    expect(json.inbound_key).toBe("external-jamin");
    expect(json.model).toBe("swift-1.5-27b");

    // Unmarked (fleet-internal) request: field simply omitted — the envelope
    // of every existing consumer stays byte-compatible.
    const plain = mkRequest({ "x-claudish-machine": "myia-po-2023" });
    logRequest(
      { model: "glm-5.3", messages: [{ role: "user", content: "x" }] },
      "ComposedHandler",
      plain,
      new WeakMap()
    );
    const deadline = Date.now() + 2000;
    let files: string[] = [];
    while (Date.now() < deadline) {
      files = readdirSync(capDir).filter((f) => f.startsWith("req-"));
      if (files.length >= 2) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(files.length).toBeGreaterThanOrEqual(2);
    const plainFile = join(capDir, files.sort()[1]);
    json = JSON.parse(readFileSync(plainFile, "utf8"));
    expect(json.inbound_key).toBeUndefined();
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

  it("records the relay hop chain so relayed vs direct is measurable after the fact (#566)", async () => {
    mkdirSync(capDir, { recursive: true });
    process.env.CLAUDISH_CAPTURE_DIR = capDir;

    logRequest(
      { model: "claude-haiku-4-5-20251001", messages: [] },
      "test-handler",
      mkRequest({ "x-claudish-machine": "myia-test", "x-claudish-hops": "node-a,node-b" }),
      new WeakMap()
    );

    const file = await waitForCapture(capDir);
    expect(file).not.toBeNull();
    const json = JSON.parse(readFileSync(file!, "utf8"));
    // ids only, in order, split off the header the relay appends (#156/#279)
    expect(json.hops).toEqual(["node-a", "node-b"]);
  });

  it("writes `hops: []` when the request carried no relay hop (#566)", async () => {
    mkdirSync(capDir, { recursive: true });
    process.env.CLAUDISH_CAPTURE_DIR = capDir;

    logRequest(
      { model: "claude-haiku-4-5-20251001", messages: [] },
      "test-handler",
      mkRequest({ "x-claudish-machine": "myia-test" }),
      new WeakMap()
    );

    const file = await waitForCapture(capDir);
    expect(file).not.toBeNull();
    const json = JSON.parse(readFileSync(file!, "utf8"));
    // `[]` = direct. It must be PRESENT: omitting the key would make a direct
    // request indistinguishable from a capture written before #566, which is
    // exactly the blind spot the issue opened with.
    expect(json.hops).toEqual([]);
  });

  it("keeps model inside the head window even with a maximal client hop chain (#566 B2)", async () => {
    mkdirSync(capDir, { recursive: true });
    process.env.CLAUDISH_CAPTURE_DIR = capDir;

    logRequest(
      { model: "claude-opus-5-5", messages: [] },
      "test-handler",
      mkRequest({
        "x-claudish-machine": "myia-test",
        // the worst case the sanitizer admits: 8 ids of 64 chars
        "x-claudish-hops": Array.from({ length: 8 }, (_, i) => String(i).repeat(64)).join(","),
      }),
      new WeakMap()
    );

    const file = await waitForCapture(capDir);
    expect(file).not.toBeNull();
    const raw = readFileSync(file!, "utf8");
    const json = JSON.parse(raw);
    // The leak-policy attribution method reads machine+model from the first
    // 300-400 bytes. A client-supplied value must not be able to push `model`
    // out of that window (measured 618 before the reorder).
    expect(raw.indexOf('"model":"')).toBeLessThan(400);
    expect(json.hops.length).toBe(8);
  });

  it("sanitizes client-supplied hop values instead of echoing the header verbatim (#566)", async () => {
    mkdirSync(capDir, { recursive: true });
    process.env.CLAUDISH_CAPTURE_DIR = capDir;

    logRequest(
      { model: "claude-haiku-4-5-20251001", messages: [] },
      "test-handler",
      mkRequest({
        // A client can set any header: quotes/commas/newlines must not reach
        // the capture file, and an over-long id is bounded.
        "x-claudish-hops": '  evil"id  , ,<script>,' + "z".repeat(200),
      }),
      new WeakMap()
    );

    const file = await waitForCapture(capDir);
    expect(file).not.toBeNull();
    const json = JSON.parse(readFileSync(file!, "utf8"));
    expect(json.hops).toEqual(["evilid", "script", "z".repeat(64)]);
    // the raw header text never lands in the file
    expect(readFileSync(file!, "utf8")).not.toContain("<script>");
  });

  it("writes no header material other than the documented attribution fields (#566)", async () => {
    mkdirSync(capDir, { recursive: true });
    process.env.CLAUDISH_CAPTURE_DIR = capDir;

    logRequest(
      { model: "claude-haiku-4-5-20251001", messages: [] },
      "test-handler",
      mkRequest({
        authorization: "Bearer sk-secret-must-not-be-captured",
        "x-proxy-key": "cluster-key-must-not-be-captured",
        "x-claudish-hops": "node-a",
      }),
      new WeakMap()
    );

    const file = await waitForCapture(capDir);
    expect(file).not.toBeNull();
    const raw = readFileSync(file!, "utf8");
    // Echoing request headers wholesale would ship credentials to disk.
    expect(raw).not.toContain("sk-secret-must-not-be-captured");
    expect(raw).not.toContain("cluster-key-must-not-be-captured");
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
