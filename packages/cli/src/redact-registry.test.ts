import { afterEach, describe, expect, it, jest, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const childKey = "T1_REDACT_REGISTRY_CHILD";

if (process.env[childKey] !== "1") {
  it("runs registry and lease checks with an isolated HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "claudish-t1-registry-"));
    try {
      const env: Record<string, string | undefined> = {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: home,
        [childKey]: "1",
      };
      for (const key of Object.keys(env)) {
        if (/KEY|TOKEN|SECRET|PASSWORD|COOKIE/.test(key) && key !== childKey) delete env[key];
      }
      const result = Bun.spawnSync([process.execPath, "test", import.meta.path], {
        env,
        timeout: 18_000,
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = result.stdout.toString() + result.stderr.toString();
      console.log(output);
      expect(result.exitCode, output).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
} else {
  const { acquireSigningLease, redactForClient, redactSecrets, redactSigningValues } = await import(
    "./redact.js"
  );
  const { log, logStderr, setDiagOutput } = await import("./logger.js");
  const { releaseWhenBodyEnds } = await import("./handlers/shared/call-context.js");
  const leases: ReturnType<typeof acquireSigningLease>[] = [];
  const bytes = readFileSync(
    new URL("./test-fixtures/redaction/native-content.sse", import.meta.url)
  );
  const token = "OPAQUE_TEST_TOKEN_T1";
  const lookalike = "OPAQUE_TEST_TOKEN_T2";
  function leaseFor(...values: string[]) {
    const lease = acquireSigningLease();
    leases.push(lease);
    lease.add(values);
    return lease;
  }
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  afterEach(() => {
    for (const lease of leases.splice(0)) lease.release();
    setDiagOutput(null);
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe("G1 signing-value registry sinks", () => {
    it("redacts opaque registered values in log and logStderr, not look-alikes", () => {
      leaseFor(token);
      const diagnostic: string[] = [];
      const printed: string[] = [];
      setDiagOutput({ write: (text) => diagnostic.push(text), cleanup() {} });
      spyOn(console, "log").mockImplementation((...args) => {
        printed.push(args.join(" "));
      });
      const input = `[T1] ${token} ${lookalike}`;
      log(input, true);
      const logOutput = [...printed, ...diagnostic].join("\n");
      expect(logOutput).toContain("[redacted]");
      expect(logOutput).toContain(lookalike);
      expect(logOutput).not.toContain(token);
      diagnostic.length = 0;
      logStderr(input);
      expect(diagnostic.join("\n")).toContain("[redacted]");
      expect(diagnostic.join("\n")).toContain(lookalike);
      expect(diagnostic.join("\n")).not.toContain(token);
    }, 10_000);

    it("redactSecrets and redactForClient replace only registered opaque values", () => {
      const lease = leaseFor(token);
      const input = `${token} / ${lookalike} / ${token}`;
      for (const redact of [redactSecrets, redactForClient, redactSigningValues]) {
        expect(redact(input)).toBe(`[redacted] / ${lookalike} / [redacted]`);
      }
      lease.release();
      expect(redactSigningValues(input)).toBe(input);
    }, 10_000);

    it("redacts JSON-escaped values repeatedly without regex state (A8)", () => {
      const escapedToken = 'OPAQUE_TEST_"quoted"\\line\nTOKEN';
      leaseFor(escapedToken);
      const input = JSON.stringify({ message: escapedToken, unrelated: lookalike });
      const expected = JSON.stringify({ message: "[redacted]", unrelated: lookalike });
      for (let repetition = 0; repetition < 6; repetition++) {
        expect(redactSigningValues(input)).toBe(expected);
        expect(redactSecrets(input)).toBe(expected);
        expect(redactForClient(input)).toBe(expected);
        expect(JSON.parse(redactForClient(input))).toEqual({
          message: "[redacted]",
          unrelated: lookalike,
        });
      }
    }, 10_000);

    it("replaces overlapping values longest first and ignores values shorter than eight", () => {
      leaseFor(token, `${token}_longer`, "tiny");
      expect(redactSigningValues(`${token}_longer ${token} tiny`)).toBe(
        "[redacted] [redacted] tiny"
      );
    }, 10_000);
  });

  describe("G2 signing lease lifetime (A2)", () => {
    it("holds a producing body's value across a year of injected clock time, then releases at EOF", async () => {
      jest.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
      const lease = leaseFor(token);
      let source!: ReadableStreamDefaultController<Uint8Array>;
      const response = releaseWhenBodyEnds(
        new Response(
          new ReadableStream<Uint8Array>(
            {
              start(controller) {
                source = controller;
              },
            },
            { highWaterMark: 0 }
          )
        ),
        () => lease.release()
      );
      const reader = response.body!.getReader();
      const split = Math.floor(bytes.length / 2);
      source.enqueue(bytes.subarray(0, split));
      expect((await reader.read()).value).toEqual(bytes.subarray(0, split));
      expect(redactForClient(token)).toBe("[redacted]");
      for (let day = 0; day < 366; day++) jest.advanceTimersByTime(24 * 60 * 60 * 1000);
      source.enqueue(bytes.subarray(split));
      expect((await reader.read()).value).toEqual(bytes.subarray(split));
      expect(redactForClient(token)).toBe("[redacted]");
      source.close();
      expect((await reader.read()).done).toBe(true);
      expect(redactSigningValues(token)).toBe(token);
    }, 10_000);

    it("cancel with an outstanding read retains the value until upstream teardown settles", async () => {
      const lease = leaseFor(token);
      const teardown = deferred();
      const enteredCancel = deferred();
      const observations: string[] = [];
      let releases = 0;
      const response = releaseWhenBodyEnds(
        new Response(
          new ReadableStream<Uint8Array>(
            {
              async cancel() {
                enteredCancel.resolve();
                await teardown.promise;
                observations.push(redactForClient(token));
              },
            },
            { highWaterMark: 0 }
          )
        ),
        () => {
          releases++;
          lease.release();
        }
      );
      const reader = response.body!.getReader();
      const pendingRead = reader.read();
      const cancel = reader.cancel();
      await enteredCancel.promise;
      expect((await pendingRead).done).toBe(true);
      expect(releases).toBe(0);
      expect(redactForClient(token)).toBe("[redacted]");
      teardown.resolve();
      await cancel;
      expect(observations).toEqual(["[redacted]"]);
      expect(releases).toBe(1);
      expect(redactSigningValues(token)).toBe(token);
    }, 10_000);

    it("overlapping leases retain a shared value until the last idempotent release", () => {
      const first = leaseFor(token);
      const second = leaseFor(token);
      first.add([token]);
      first.release();
      first.release();
      expect(redactForClient(token)).toBe("[redacted]");
      second.release();
      second.release();
      expect(redactSigningValues(token)).toBe(token);
    }, 10_000);

    it("releases on body error and immediately for a null body", async () => {
      const lease = leaseFor(token);
      const failed = releaseWhenBodyEnds(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("T1 source failed"));
            },
          })
        ),
        () => lease.release()
      );
      await expect(failed.text()).rejects.toThrow("T1 source failed");
      expect(redactSigningValues(token)).toBe(token);
      const emptyLease = leaseFor(token);
      releaseWhenBodyEnds(new Response(null, { status: 204 }), () => emptyLease.release());
      expect(redactSigningValues(token)).toBe(token);
    }, 10_000);
  });
}
