import { describe, expect, spyOn, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ALLOWANCE_CONFIG, initialState, observeAll } from "../allowance/index.js";
import { createLedgerTail, readLedger } from "./ledger-reader.js";
import {
  type LedgerRow,
  buildNoEligibleRow,
  buildResponseRow,
  parseRow,
  toEvent,
  utcDay,
} from "./ledger-row.js";
import {
  _resetLedgerWriterForTests,
  appendUsageRow,
  compactUsageLedger,
  compactUsageLedgerAsync,
  flushUsageLedger,
  ledgerEnabled,
  rollupDay,
  setLedgerIdleProbe,
} from "./ledger-writer.js";

const DAY = 86400000;
const now = Date.UTC(2026, 9, 23, 12);
const api = { appendUsageRow, compactUsageLedger, createLedgerTail, readLedger, rollupDay };

function row(at = now, attempt = 0, patch: Record<string, unknown> = {}): LedgerRow {
  return parseRow(
    JSON.stringify({
      ...buildResponseRow({
        provider: "openai-codex",
        requestId: "request-123",
        attempt,
        at,
        accountId: "a1b2c3d4e5f6",
        label: "work",
        planClass: "pro",
        session: "s-123",
        model: "gpt-6-astra",
        reason: undefined,
        outcome: "ok",
        tokens: { input: 100, cacheRead: 60, cacheWrite: 10, output: 20 },
        finalInput: 100,
      })!,
      id: "request-123:" + attempt + ":" + (patch.accountId ?? "a1b2c3d4e5f6"),
      ...patch,
    })
  )!;
}

async function isolated<T>(fn: (dir: string, env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "allowance-ledger-test-"));
  const env = {
    ...process.env,
    NODE_ENV: "test",
    CLAUDISH_ACCOUNTS_DIR: dir,
    CLAUDISH_ALLOWANCE_LEDGER: "on",
    CLAUDISH_DISABLE_KEYCHAIN: "1",
    CLAUDISH_DISABLE_OP: "1",
    CLAUDISH_DISABLE_CATALOG_WARM: "1",
  };
  _resetLedgerWriterForTests();
  try {
    return await fn(dir, env);
  } finally {
    await flushUsageLedger();
    _resetLedgerWriterForTests();
    setLedgerIdleProbe(null);
    rmSync(dir, { recursive: true, force: true });
  }
}

function rawPath(dir: string, at = now): string {
  return join(dir, "usage", "raw", utcDay(at) + ".jsonl");
}

function putRaw(dir: string, at: number, rows: LedgerRow[]): string {
  const path = rawPath(dir, at);
  mkdirSync(join(dir, "usage", "raw"), { recursive: true, mode: 0o700 });
  writeFileSync(path, rows.map((r) => JSON.stringify(r) + "\n").join(""), { mode: 0o600 });
  return path;
}

function diskRows(path: string): LedgerRow[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => parseRow(line)!);
}

describe("allowance ledger I/O contract (§2.1; L9–L14)", () => {
  test("writer appends distinct attempts in order with private permissions", async () => {
    await isolated(async (dir, env) => {
      api.appendUsageRow(row(now, 0, { outcome: "quota", inTok: 0, outTok: 0 }), env);
      api.appendUsageRow(row(now, 1, { accountId: "bbbbbbbbbbbb" }), env);
      await flushUsageLedger();
      const rows = diskRows(rawPath(dir));
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.kind === "response" && r.outcome)).toEqual(["quota", "ok"]);
      expect(rows.map((r) => r.kind === "response" && r.id)).toEqual([
        "request-123:0:a1b2c3d4e5f6",
        "request-123:1:bbbbbbbbbbbb",
      ]);
      expect(statSync(rawPath(dir)).mode & 0o777).toBe(0o600);
      for (const path of [join(dir, "usage"), join(dir, "usage", "raw")]) {
        expect(statSync(path).mode & 0o777).toBe(0o700);
      }
    });
  });

  test("off writes no response or no-eligible rows", async () => {
    await isolated(async (dir, env) => {
      env.CLAUDISH_ALLOWANCE_LEDGER = "off";
      expect(ledgerEnabled(env)).toBe(false);
      api.appendUsageRow(row(), env);
      api.appendUsageRow(buildNoEligibleRow("openai-codex", now), env);
      await flushUsageLedger();
      expect(existsSync(rawPath(dir))).toBe(false);
    });
  });

  test("queue drops the oldest 76 of 1100 synchronous enqueues", async () => {
    await isolated(async (dir, env) => {
      for (let n = 0; n < 1100; n++) api.appendUsageRow(row(now, n), env);
      await flushUsageLedger();
      const rows = diskRows(rawPath(dir));
      expect(rows).toHaveLength(1024);
      expect(rows.map((r) => (r.kind === "response" ? r.id : ""))).toEqual(
        Array.from({ length: 1024 }, (_, n) => "request-123:" + (n + 76) + ":a1b2c3d4e5f6")
      );
    });
  });

  test("a 64 MiB raw segment stops accepting rows", async () => {
    await isolated(async (dir, env) => {
      putRaw(dir, now, []);
      truncateSync(rawPath(dir), 64 * 1024 * 1024);
      api.appendUsageRow(row(), env);
      await flushUsageLedger();
      expect(statSync(rawPath(dir)).size).toBe(64 * 1024 * 1024);
    });
  });

  test("writer refuses symlink segments without touching the target", async () => {
    await isolated(async (dir, env) => {
      mkdirSync(join(dir, "usage", "raw"), { recursive: true });
      const target = join(dir, "sentinel");
      writeFileSync(target, "untouched");
      symlinkSync(target, rawPath(dir));
      expect(() => api.appendUsageRow(row(), env)).not.toThrow();
      await flushUsageLedger();
      expect(readFileSync(target, "utf8")).toBe("untouched");
    });
  });

  test("tail retains a torn trailing line and counts only complete invalid lines", async () => {
    await isolated(async (dir, env) => {
      const path = putRaw(dir, now, []);
      const tail = api.createLedgerTail({ fromDay: utcDay(now), now, env });
      const a = JSON.stringify(row(now, 0)) + "\n";
      const b = JSON.stringify(row(now, 1)) + "\n";
      const c = JSON.stringify(row(now, 2));
      const half = Math.floor(c.length / 2);
      appendFileSync(path, a + b + c.slice(0, half));
      const first = await tail.tail();
      expect(first.rows).toEqual([row(now, 0), row(now, 1)]);
      expect(first.skipped).toBe(0);
      expect(tail.offsets().get(utcDay(now))).toBe(Buffer.byteLength(a + b));
      appendFileSync(path, c.slice(half) + "\nnot-json\n");
      const second = await tail.tail();
      expect(second.rows).toEqual([row(now, 2)]);
      expect(second.skipped).toBe(1);
      expect((await tail.tail()).rows).toEqual([]);
    });
  });

  test("tail startAtEnd excludes history but includes later appends", async () => {
    await isolated(async (dir, env) => {
      const path = putRaw(dir, now, [row()]);
      const tail = api.createLedgerTail({ fromDay: utcDay(now), now, env, startAtEnd: true });
      expect((await tail.tail()).rows).toEqual([]);
      appendFileSync(path, JSON.stringify(row(now, 1)) + "\n");
      expect((await tail.tail()).rows).toEqual([row(now, 1)]);
    });
  });

  test("a concurrent appender loses and duplicates no complete rows across tails", async () => {
    await isolated(async (dir, env) => {
      const path = putRaw(dir, now, []);
      const tail = api.createLedgerTail({ fromDay: utcDay(now), now, env });
      const observed: LedgerRow[] = [];
      for (let n = 0; n < 40; n++) {
        const [read] = await Promise.all([
          tail.tail(),
          appendFile(path, JSON.stringify(row(now, n)) + "\n"),
        ]);
        observed.push(...read.rows);
      }
      observed.push(...(await tail.tail()).rows);
      expect(observed).toEqual(Array.from({ length: 40 }, (_, n) => row(now, n)));
    });
  });

  test("reader skips a torn final line without counting it as complete corruption", async () => {
    await isolated(async (dir, env) => {
      const path = putRaw(dir, now, [row()]);
      appendFileSync(path, 'garbage\n{"v":1');
      const read = await api.readLedger({ sinceMs: now - 1, env });
      expect(read.rows).toEqual([row()]);
      expect(read.skipped).toBe(1);
    });
  });

  test("rollup sums tokens and retains first/last readings in each hour", () => {
    const window = (u: number) => [
      {
        key: "len:10080",
        slot: "primary",
        lengthMinutes: 10080,
        usedFraction: u,
        resetAt: now + DAY,
        rejected: false,
        quantum: 0.01,
      },
    ];
    const rows = [
      row(now + 1000, 0, { windows: window(0.2) }),
      row(now + 2000, 1, { windows: window(0.3) }),
    ];
    const result = api
      .rollupDay(utcDay(now), rows)
      .trim()
      .split("\n")
      .map((line) => parseRow(line)!);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      v: 1,
      kind: "rollup",
      hour: now,
      n: 2,
      accountId: "a1b2c3d4e5f6",
      session: "s-123",
      model: "gpt-6-astra",
      tokens: { input: 200, cacheRead: 120, cacheWrite: 20, output: 40 },
      first: window(0.2),
      last: window(0.3),
      censoredMinutes: 0,
    });
    expect(api.rollupDay(utcDay(now), rows)).toBe(api.rollupDay(utcDay(now), [...rows]));
  });

  test("rollup keeps account, session, model and provider groups distinct", () => {
    const rows = [
      row(now, 0),
      row(now + 1, 1, { accountId: "bbbbbbbbbbbb" }),
      row(now + 2, 2, { session: "s-other" }),
      row(now + 3, 3, { model: "other-model" }),
      row(now + 4, 4, { provider: "native-anthropic" }),
    ];
    const result = api
      .rollupDay(utcDay(now), rows)
      .trim()
      .split("\n")
      .map((line) => parseRow(line)!);
    expect(result).toHaveLength(5);
    const ids = result.map((r) => (r.kind === "rollup" ? r.id : ""));
    expect(new Set(ids).size).toBe(5);
  });

  test("only pool-wide no-eligible intervals censor the hour", () => {
    const atHour = (hour: number, minute = 0) => Date.UTC(2026, 9, 23, hour, minute);
    const rows = [
      row(atHour(10), 0, { outcome: "quota" }),
      buildNoEligibleRow("openai-codex", atHour(10, 50)),
      row(atHour(11), 1, { outcome: "quota" }),
      row(atHour(12), 2, { outcome: "quota" }),
      row(atHour(13, 10), 3),
      row(atHour(23), 4, { outcome: "quota" }),
      buildNoEligibleRow("openai-codex", atHour(23, 30)),
    ];
    const result = api
      .rollupDay(utcDay(now), rows)
      .trim()
      .split("\n")
      .map((line) => parseRow(line)!);
    expect(
      result.filter((r) => r.kind === "rollup").map((r) => r.kind === "rollup" && r.censoredMinutes)
    ).toEqual([10, 60, 60, 10, 30]);
    // F7: hourly rows seal both endpoints; raw rows are no longer copied verbatim.
    expect(result.filter((r) => r.kind === "no-eligible")).toEqual([
      { ...buildNoEligibleRow("openai-codex", atHour(10, 50)), until: atHour(13, 10) },
      {
        ...buildNoEligibleRow("openai-codex", atHour(23, 30)),
        until: atHour(0) + DAY,
        continues: true,
      },
    ]);
    const rotated = api
      .rollupDay(utcDay(now), [
        row(now, 0, { outcome: "quota" }),
        row(now + 1000, 1, { accountId: "bbbbbbbbbbbb" }),
      ])
      .trim()
      .split("\n")
      .map((line) => parseRow(line)!);
    expect(rotated.every((r) => r.kind === "rollup" && r.censoredMinutes === 0)).toBe(true);
  });

  test("compaction keeps 30-day raw data and publishes old hourly data before unlink", async () => {
    await isolated(async (dir, env) => {
      const expired = now - 31 * DAY;
      const retained = now - 30 * DAY;
      const twoDays = now - 2 * DAY;
      for (const at of [expired, retained, twoDays, now - DAY, now]) putRaw(dir, at, [row(at)]);
      const result = api.compactUsageLedger({ now, env });
      expect(result.status).toBe("done");
      const hourly = (at: number) => join(dir, "usage", "hourly", utcDay(at) + ".jsonl");
      expect(existsSync(rawPath(dir, expired))).toBe(false);
      for (const at of [retained, twoDays, now - DAY, now])
        expect(existsSync(rawPath(dir, at))).toBe(true);
      for (const at of [expired, retained, twoDays]) {
        expect(existsSync(hourly(at))).toBe(true);
        expect(statSync(hourly(at)).mode & 0o777).toBe(0o600);
        expect(diskRows(hourly(at))[0].kind).toBe("rollup");
      }
      expect(existsSync(hourly(now - DAY))).toBe(false);
      expect(existsSync(hourly(now))).toBe(false);
      expect(readdirSync(join(dir, "usage", "hourly")).some((name) => name.endsWith(".tmp"))).toBe(
        false
      );
    });
  });

  test("published hourly data takes precedence across a rename-before-unlink crash", async () => {
    await isolated(async (dir, env) => {
      const old = now - 31 * DAY;
      const rows = [row(old, 0), row(old + 1000, 1)];
      putRaw(dir, old, rows);
      mkdirSync(join(dir, "usage", "hourly"), { recursive: true, mode: 0o700 });
      writeFileSync(
        join(dir, "usage", "hourly", utcDay(old) + ".jsonl"),
        api.rollupDay(utcDay(old), rows)
      );
      const model = await api.readLedger({ sinceMs: old - 1, env });
      expect(model.rows).toHaveLength(1);
      expect(model.rows[0]).toMatchObject({ kind: "rollup", n: 2 });
      expect((await api.readLedger({ sinceMs: old - 1, source: "raw", env })).rows).toEqual(rows);
      api.compactUsageLedger({ now, env });
      expect(existsSync(rawPath(dir, old))).toBe(false);
      expect((await api.readLedger({ sinceMs: old - 1, env })).rows).toEqual(model.rows);
    });
  });

  test("a second compactor skips a lock actually held by another process", async () => {
    await isolated(async (dir, env) => {
      const old = now - 31 * DAY;
      putRaw(
        dir,
        old,
        Array.from({ length: 20000 }, (_, n) => row(old + n, n))
      );
      const writer = new URL("./ledger-writer.ts", import.meta.url).href;
      const program = `
        const { compactUsageLedger } = await import(${JSON.stringify(writer)});
        compactUsageLedger({ now: ${now}, env: process.env });
      `;
      const child = Bun.spawn([process.execPath, "-e", program], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        const deadline = Date.now() + 3000;
        while (!existsSync(join(dir, "usage", "compact.lock")) && Date.now() < deadline) {
          if (child.exitCode !== null)
            throw new Error("compactor exited before its lock was observed");
          await Bun.sleep(1);
        }
        expect(existsSync(join(dir, "usage", "compact.lock"))).toBe(true);
        child.kill("SIGSTOP");
        expect(api.compactUsageLedger({ now, env }).status).toBe("locked");
        expect(existsSync(rawPath(dir, old))).toBe(true);
      } finally {
        child.kill("SIGKILL");
        await child.exited;
      }
    });
  }, 10000);

  test("a failed hourly publish leaves the old raw data intact", async () => {
    await isolated(async (dir, env) => {
      const old = now - 31 * DAY;
      putRaw(dir, old, [row(old)]);
      writeFileSync(join(dir, "usage", "hourly"), "not a directory");
      try {
        api.compactUsageLedger({ now, env });
      } catch {
        // The contract requires preservation, not a particular compaction error.
      }
      expect(existsSync(rawPath(dir, old))).toBe(true);
      expect(diskRows(rawPath(dir, old))).toEqual([row(old)]);
    });
  });

  test("F2 drain only arms deferred compaction and busy requests postpone it", async () => {
    await isolated(async (dir, env) => {
      const old = now - 3 * DAY;
      putRaw(dir, old, [row(old)]);
      const hourly = join(dir, "usage", "hourly", utcDay(old) + ".jsonl");
      const originalTimeout = globalThis.setTimeout;
      const callbacks: Array<() => void> = [];
      const delays: number[] = [];
      const timers: ReturnType<typeof setTimeout>[] = [];
      const clock = spyOn(Date, "now").mockReturnValue(now);
      const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((
        fn: () => void,
        delay?: number
      ) => {
        const timer = originalTimeout(fn, delay);
        if (delay === 60_000) {
          callbacks.push(fn);
          delays.push(delay);
          timers.push(timer);
        }
        return timer;
      }) as typeof setTimeout);
      let idle = false;
      setLedgerIdleProbe(() => idle);
      try {
        appendUsageRow(row(), env);
        await flushUsageLedger();
        expect(existsSync(hourly)).toBe(false);
        expect(delays).toEqual([60_000]);
        expect(timers[0]!.hasRef()).toBe(false);
        clock.mockReturnValue(now + 60_000);
        clearTimeout(timers[0]);
        callbacks[0]!();
        await Bun.sleep(20);
        expect(existsSync(hourly)).toBe(false);
        expect(callbacks.length).toBeGreaterThanOrEqual(2);
        idle = true;
        clock.mockReturnValue(now + 120_000);
        clearTimeout(timers.at(-1));
        callbacks.at(-1)!();
        for (let n = 0; n < 200 && !existsSync(hourly); n++) await Bun.sleep(5);
        expect(existsSync(hourly)).toBe(true);
        expect(diskRows(hourly)[0]).toMatchObject({ kind: "rollup", n: 1 });
      } finally {
        for (const timer of timers) clearTimeout(timer);
        timeout.mockRestore();
        clock.mockRestore();
      }
    });
  });

  test("F2 async compaction while busy publishes and deletes nothing", async () => {
    await isolated(async (dir, env) => {
      const old = now - 31 * DAY;
      const raw = putRaw(dir, old, [row(old)]);
      setLedgerIdleProbe(() => false);
      const result = await compactUsageLedgerAsync({ now, env });
      expect(result.status).toBe("busy");
      expect(result.rolledUp).toEqual([]);
      expect(result.rawUnlinked).toEqual([]);
      expect(result.hourlyUnlinked).toEqual([]);
      expect(existsSync(raw)).toBe(true);
      expect(existsSync(join(dir, "usage", "hourly", utcDay(old) + ".jsonl"))).toBe(false);
    });
  });

  for (const asyncMode of [false, true]) {
    test("F6 unreadable raw day never publishes an empty rollup or applies retention " +
      (asyncMode ? "async" : "sync"), async () => {
      await isolated(async (dir, env) => {
        const old = now - 31 * DAY;
        mkdirSync(rawPath(dir, old), { recursive: true }); // Deterministic EISDIR, even as root.
        let result: ReturnType<typeof compactUsageLedger> | undefined;
        let failure: unknown;
        try {
          result = asyncMode
            ? await compactUsageLedgerAsync({ now, env })
            : compactUsageLedger({ now, env });
        } catch (error) {
          failure = error;
        }
        expect(existsSync(join(dir, "usage", "hourly", utcDay(old) + ".jsonl"))).toBe(false);
        expect(failure).toBeUndefined();
        expect(result?.unreadable).toEqual([utcDay(old)]);
        expect(result?.rolledUp).toEqual([]);
        expect(result?.rawUnlinked).toEqual([]);
        expect(statSync(rawPath(dir, old)).isDirectory()).toBe(true);
      });
    });
  }

  test("F7 raw and compacted closed intervals have identical censoring and no open tail", async () => {
    await isolated(async (dir, env) => {
      const day = Date.UTC(2026, 8, 22);
      const rows = [
        buildNoEligibleRow("openai-codex", day + 10 * 3_600_000),
        row(day + 10 * 3_600_000 + 10 * 60_000),
      ];
      putRaw(dir, day, rows);
      const fold = (data: LedgerRow[]) =>
        observeAll(initialState(), data.map(toEvent), DEFAULT_ALLOWANCE_CONFIG);
      const raw = fold(rows);
      compactUsageLedger({ now, env });
      const replay = fold((await readLedger({ sinceMs: day, untilMs: day + DAY, env })).rows);
      const censored = (s: typeof raw) => s.demand.map((h) => [h.hour, h.censoredMinutes]);
      expect(raw.censorOpenAt).toBeNull();
      expect(replay.censorOpenAt).toBeNull();
      expect(censored(replay)).toEqual(censored(raw));
      expect(replay.demand.find((h) => h.hour === day + 10 * 3_600_000)?.censoredMinutes).toBe(10);
    });
  });

  test("F7 an interval open at midnight survives compacting either one or both days", async () => {
    await isolated(async (dir, env) => {
      const day = Date.UTC(2026, 8, 23);
      const rows = [
        buildNoEligibleRow("openai-codex", day + 23 * 3_600_000 + 50 * 60_000),
        row(day + DAY + 20 * 60_000),
      ];
      putRaw(dir, day, [rows[0]!]);
      putRaw(dir, day + DAY, [rows[1]!]);
      const fold = async () =>
        observeAll(
          initialState(),
          (await readLedger({ sinceMs: day, untilMs: day + 2 * DAY, env })).rows.map(toEvent),
          DEFAULT_ALLOWANCE_CONFIG
        );
      const raw = await fold();
      // D is closed; D+1 is yesterday and stays raw.
      compactUsageLedger({ now: day + 2 * DAY, env });
      const mixed = await fold();
      compactUsageLedger({ now: day + 3 * DAY, env });
      const compacted = await fold();
      for (const s of [raw, mixed, compacted]) {
        expect(s.censorOpenAt).toBeNull();
        expect(s.demand.find((h) => h.hour === day + 23 * 3_600_000)?.censoredMinutes).toBe(10);
        expect(s.demand.find((h) => h.hour === day + DAY)?.censoredMinutes).toBe(20);
      }
    });
  });

  test("hourly data older than 180 days is removed", async () => {
    await isolated(async (dir, env) => {
      const old = now - 181 * DAY;
      const keep = now - 179 * DAY;
      mkdirSync(join(dir, "usage", "hourly"), { recursive: true, mode: 0o700 });
      for (const at of [old, keep]) {
        writeFileSync(
          join(dir, "usage", "hourly", utcDay(at) + ".jsonl"),
          api.rollupDay(utcDay(at), [row(at)])
        );
      }
      api.compactUsageLedger({ now, env });
      expect(existsSync(join(dir, "usage", "hourly", utcDay(old) + ".jsonl"))).toBe(false);
      expect(existsSync(join(dir, "usage", "hourly", utcDay(keep) + ".jsonl"))).toBe(true);
    });
  });
});
