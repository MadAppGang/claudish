/**
 * v2e-real-run.ts interrupted at each await point, with a fake item store, an in-memory FIFO
 * refresh gate and fake serves: no keychain, no lock file, no network. One test runs the REAL
 * `startServe` against a synthetic node "launcher" that never becomes ready (no claudish).
 * Review round 8: GPT HIGH 2 = Gemini MEDIUM (shutdown coordination), Gemini LOW (redaction).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanCredentialShapes, writeScanned } from "./cred-shape-scan.ts";
import {
  type DirectReply,
  type Producer,
  type ServeProc,
  killTree,
  pidGone,
  startServe,
} from "./direct.ts";
import type { Gate, ItemStore, RealRecord } from "./v2e-real-lib.ts";
import { type RealRunDeps, createRealRun } from "./v2e-real-run.ts";

const GEN1: RealRecord = {
  accessToken: "access-A",
  refreshToken: "refresh-A",
  generation: 1,
  fingerprint: "fp-1",
  expiresAt: 2_000_000_000_000,
};

/** A credential-shaped key BUILT at run time: no token literal in the source. */
const CRED = `sk-proj-${createHash("sha256").update("r8-4").digest("hex").slice(0, 40)}`;

const roots: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const p of pids.splice(0)) killTree(p, "SIGKILL", { group: true });
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const tempDir = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "v2e-run-")));
  roots.push(d);
  return d;
};

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(2);
  }
}

/** The refresh gate as an in-memory FIFO mutex; `waiting` and `held` are observable. */
function fakeLock() {
  let tail: Promise<void> = Promise.resolve();
  const st = { waiting: 0, held: false };
  const gate =
    (timeoutMs?: number): Gate =>
    async (work) => {
      let release!: () => void;
      const mine = new Promise<void>((r) => {
        release = r;
      });
      const prev = tail;
      tail = prev.then(() => mine);
      st.waiting++;
      if (timeoutMs !== undefined) {
        const got = await Promise.race([
          prev.then(() => true),
          Bun.sleep(timeoutMs).then(() => false),
        ]);
        if (!got) {
          st.waiting--;
          void prev.then(release);
          throw new Error(`timeout after ${timeoutMs} ms`);
        }
      } else await prev;
      st.waiting--;
      st.held = true;
      try {
        return await work(() => true);
      } finally {
        st.held = false;
        release();
      }
    };
  return { gate, st };
}

/** One item in memory; every read records whether the gate was held and the end had begun. */
function fakeStore(lock: ReturnType<typeof fakeLock>, isStopping: () => boolean) {
  const s = {
    value: structuredClone(GEN1) as RealRecord | null,
    writes: [] as RealRecord[],
    reads: [] as Array<{ inGate: boolean; afterStop: boolean }>,
  };
  const store: ItemStore = {
    async read() {
      s.reads.push({ inGate: lock.st.held, afterStop: isStopping() });
      return s.value ? structuredClone(s.value) : null;
    },
    async write(r) {
      s.writes.push(structuredClone(r));
      s.value = structuredClone(r);
    },
  };
  return { s, store };
}

/** A fake serve tree: kill() ends any request in flight with a connection error. */
function fakeServe(i: number, out: { stdout?: string; stderr?: string } = {}) {
  const inflight: Array<(r: DirectReply) => void> = [];
  let killed = false;
  const producer: Producer = {
    name: "serve",
    pid: 900_000 + i,
    kill() {
      if (killed) return;
      killed = true;
      for (const r of inflight.splice(0))
        r({ status: 0, headers: {}, body: null, connectionError: "socket closed" });
    },
    async confirmGone() {
      producer.kill();
      return true;
    },
    confirmGoneSync() {
      producer.kill();
      return true;
    },
  };
  const proc: ServeProc = {
    port: 1,
    url: `http://fake/${i}`,
    pid: producer.pid,
    stdout: () => out.stdout ?? "listening on",
    stderr: () => out.stderr ?? "",
    exited: Promise.resolve(0),
    kill: () => producer.kill(),
  };
  return {
    producer,
    proc,
    killed: () => killed,
    post: () =>
      new Promise<DirectReply>((r) => {
        if (killed) r({ status: 0, headers: {}, body: null, connectionError: "refused" });
        else inflight.push(r);
      }),
    inflight,
  };
}

interface Harness {
  deps: RealRunDeps;
  lock: ReturnType<typeof fakeLock>;
  s: ReturnType<typeof fakeStore>["s"];
  lines: string[];
  calls: string[];
  dir: string;
}

/** Deps with fakes; `over` replaces any of them. The writes go through the REAL writeScanned. */
function harness(over: (h: Harness) => Partial<RealRunDeps> = () => ({})): Harness {
  const lock = fakeLock();
  let stopping = () => false;
  const { s, store } = fakeStore(lock, () => stopping());
  const dir = tempDir();
  const lines: string[] = [];
  const calls: string[] = [];
  const serves = [fakeServe(0), fakeServe(1)];
  let n = 0;
  const h = { lock, s, lines, calls, dir } as Harness;
  h.deps = {
    account: "dc53ea1b2616",
    kcAccount: "openai-codex:dc53ea1b2616",
    store,
    gate: lock.gate(),
    gateWithin: (ms) => lock.gate(ms),
    runConfig: () => ({ subscriptionAccounts: {} }),
    slots: [],
    async startServe(onSpawn) {
      const f = serves[n++] as ReturnType<typeof fakeServe>;
      onSpawn(f.producer);
      return f.proc;
    },
    postMessage: (url) => {
      const f = serves.find((x) => x.proc.url === url) as ReturnType<typeof fakeServe>;
      return f.post();
    },
    readAccountsLog: () => {
      calls.push(`readAccountsLog stopping=${stopping()}`);
      return "";
    },
    readNeedsReauth: () => null,
    writeOut: (name, text) => writeScanned(join(dir, name), text, []),
    scanOut: () => scanCredentialShapes(dir, []),
    print: (l) => lines.push(l),
    printErr: (l) => lines.push(l),
    shutdownBoundMs: 2_000,
    confirmGoneMs: 2_000,
    ...over(h),
  };
  const run = createRealRun(h.deps);
  stopping = run.stopping;
  (h as Harness & { run: typeof run }).run = run;
  return h;
}
const runOf = (h: Harness) => (h as Harness & { run: ReturnType<typeof createRealRun> }).run;

describe("R8-2: the main coroutine and the end never run beside each other", () => {
  test("interrupt while forceExpiry is queued behind a held gate: no expiry write, original expiry kept", async () => {
    const h = harness();
    const run = runOf(h);
    // Another claudish process holds the account's gate.
    let releaseOther!: () => void;
    const other = h.lock.gate()(
      () =>
        new Promise<void>((r) => {
          releaseOther = r;
        })
    );
    const main = run.main();
    await until(() => h.lock.st.waiting === 1); // forceExpiry queued
    const end = run.interrupt("SIGINT");
    await until(() => h.lock.st.waiting === 2); // the end queued behind it (FIFO)
    releaseOther();
    await other;
    await end;
    await main;
    // GPT's repro: remainingExpiry 0, originalExpiry 2000000000000.
    expect(h.s.writes).toEqual([]);
    expect(h.s.value?.expiresAt).toBe(GEN1.expiresAt as number);
    expect(run.report.error).toBe("interrupted by SIGINT");
    expect(String(run.report.stoppedAt)).toContain("the run is ending");
    expect(run.exitCode()).toBe(1);
  });

  test("interrupt during postMessage: no keychain or log read beside the end, the signal stays the error", async () => {
    const h = harness();
    const run = runOf(h);
    const main = run.main();
    await until(() => h.calls.length === 0 && h.s.writes.length === 1); // expiry forced
    await Bun.sleep(5); // both requests in flight
    const readsBefore = h.s.reads.length;
    await run.interrupt("SIGINT");
    await main;
    const after = h.s.reads.slice(readsBefore);
    // Once the end began, the ONLY read is the end's own restore read, under the gate.
    expect(after.filter((r) => r.afterStop)).toEqual([{ inGate: true, afterStop: true }]);
    expect(h.calls).toEqual([]);
    expect(run.report.error).toBe("interrupted by SIGINT");
    expect(String(run.report.stoppedAt)).toContain("after the race");
    expect(run.report.restore).toBe("restored");
    expect(h.s.value).toEqual(GEN1);
  });

  test("interrupt during startServe: the serve still starting is killed and confirmed gone", async () => {
    const dir = tempDir();
    // A "launcher" that never prints the listening line: startServe keeps polling.
    writeFileSync(join(dir, "never-ready.cjs"), "setInterval(() => {}, 1000);\n");
    let spawned: number | null = null;
    const h = harness(() => ({
      startServe: (onSpawn) =>
        startServe({
          env: { PATH: process.env.PATH ?? "" },
          cwd: dir,
          slotsPath: "/dev/null",
          launcher: join(dir, "never-ready.cjs"),
          detached: true,
          readyTimeoutMs: 20_000,
          onSpawn: (p) => {
            spawned = p.pid;
            pids.push(p.pid);
            onSpawn(p);
          },
        }),
    }));
    const run = runOf(h);
    const main = run.main();
    await until(() => spawned !== null, 10_000);
    const pid = spawned as unknown as number;
    expect(pidGone(pid)).toBe(false);
    await run.interrupt("SIGTERM");
    // The end returned: the starting serve is gone, not left to its 20 s readiness timeout.
    expect(pidGone(pid)).toBe(true);
    expect(run.report.servesGone).toBe(true);
    // startServe sees the kill (signalCode) and throws at once, not at its readiness timeout.
    const t0 = Date.now();
    await main;
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(String(run.report.stoppedAt)).toContain("serve did not start");
    expect(run.report.error).toBe("interrupted by SIGTERM");
    expect(run.report.restore).toBe("restored");
  }, 30_000);

  test("a serve spawned after the end began is killed at once", async () => {
    let releaseSpawn!: () => void;
    const late = fakeServe(7);
    const h = harness(() => ({
      async startServe(onSpawn) {
        await new Promise<void>((r) => {
          releaseSpawn = r;
        });
        onSpawn(late.producer);
        return late.proc;
      },
    }));
    const run = runOf(h);
    const main = run.main();
    await until(() => typeof releaseSpawn === "function");
    await run.interrupt("SIGINT");
    expect(late.killed()).toBe(false);
    releaseSpawn();
    await main;
    expect(late.killed()).toBe(true);
  });
});

describe("R8-1/R8-4: v2e-real.ts wires the detached serve and the scanned writer", () => {
  // The script itself runs only against the real account, so its wiring is pinned by source.
  const src = readFileSync(join(import.meta.dir, "v2e-real.ts"), "utf8");
  test("the serves are started detached, registered at spawn", () => {
    expect(src).toMatch(/startServe\(\{[^}]*onSpawn,[^}]*detached: true,[^}]*\}\)/);
  });
  test("no file of --out is written except through writeScanned", () => {
    expect(src).not.toMatch(/writeFileSync|appendFileSync|Bun\.write/);
    expect(src).toContain("writeOut: (name, text) => writeScanned(join(OUT, name), text, [])");
  });
  test("no console line bypasses the run's redacting printers", () => {
    const direct = src.match(/console\.(log|error)\(/g) ?? [];
    // usage line, print, printErr, the second-signal line: none carries product text.
    expect(direct.length).toBe(4);
    expect(src).toContain("print: (line) => console.log(line)");
    expect(src).toContain("printErr: (line) => console.error(line)");
  });
});

describe("R8-4: report.error, console lines and every file of --out are redacted", () => {
  const holdsCred = (s: string) => s.includes(CRED) || s.includes(CRED.slice(8, 30));
  const filesOf = (dir: string) =>
    readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "latin1")] as const);

  test("a startServe error quoting a credential: report.error, the console and v2e-real.json hold none of it", async () => {
    const h = harness(() => ({
      async startServe() {
        throw new Error(`serve did not start: stdout= stderr=upstream said Bearer ${CRED}`);
      },
    }));
    const run = runOf(h);
    await run.main();
    expect(String(run.report.error)).toContain("serve did not start");
    expect(String(run.report.error)).toContain("<redacted");
    expect(holdsCred(String(run.report.error))).toBe(false);
    expect(h.lines.some((l) => l.startsWith("ERROR serve did not start"))).toBe(true);
    expect(h.lines.filter(holdsCred)).toEqual([]);
    for (const [f, text] of filesOf(h.dir)) expect([f, holdsCred(text)]).toEqual([f, false]);
    expect(run.exitCode()).toBe(1);
  });

  test("a credential in a serve's stderr: written redacted, named, and the run fails", async () => {
    const serves = [fakeServe(0, { stderr: `refresh failed for ${CRED}\n` }), fakeServe(1)];
    let n = 0;
    const h = harness(() => ({
      async startServe(onSpawn) {
        const f = serves[n++] as ReturnType<typeof fakeServe>;
        onSpawn(f.producer);
        return f.proc;
      },
      postMessage: async () => ({ status: 200, headers: {}, body: {} }),
    }));
    const run = runOf(h);
    await run.main();
    const files = filesOf(h.dir);
    expect(files.map(([f]) => f)).toContain("serve-1-stderr.txt");
    for (const [f, text] of files) expect([f, holdsCred(text)]).toEqual([f, false]);
    const scan = run.report.credentialShapeScan as { found: boolean; redactedOnWrite: string[] };
    expect(scan.found).toBe(true);
    expect(scan.redactedOnWrite.join("\n")).toContain("serve-1-stderr.txt");
    expect(h.lines.filter(holdsCred)).toEqual([]);
    expect(run.exitCode()).toBe(1);
  });
});
