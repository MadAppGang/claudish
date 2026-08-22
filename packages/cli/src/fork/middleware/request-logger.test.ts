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
});
