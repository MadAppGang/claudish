/**
 * The run of `v2e-real.ts` (V2e on a REAL account) with every live piece injected, so
 * `v2e-real-run.test.ts` can interrupt it at each await point with fakes: no keychain, no
 * lock file, no network. `v2e-real.ts` only wires the product's gate, the product's keychain
 * read and write, the built `serve` and the --out folder.
 *
 * Review round 8 (GPT HIGH 2 = Gemini MEDIUM, Gemini LOW):
 *   - the end decides what to restore only once it HOLDS the gate (`before` is read inside the
 *     restore callback), and `forceExpiry` refuses to write once the end began;
 *   - the main coroutine stops at every await point once the end began (`halt`), so no
 *     keychain read, log read or request runs beside the shutdown, and it never overwrites the
 *     error the shutdown recorded;
 *   - every serve tree is registered the moment it is spawned (`onSpawn`), so a serve still
 *     starting is killed and confirmed gone; one spawned after the end began is killed at once;
 *   - every console line and `report.error` goes through `redactCredentialShapes`, and every
 *     file of --out is written through the injected scanned writer (redacted on disk) before
 *     the folder scan; a value redacted on write fails the run like a scan finding.
 */
import type { ShapeFinding } from "./cred-shape-scan.ts";
import { formatShapeFinding, redactCredentialShapes } from "./cred-shape-scan.ts";
import type { DirectReply, Producer, ServeProc } from "./direct.ts";
import {
  type Gate,
  type ItemStore,
  type RealRecord,
  type RealStoreKind,
  type RealVerdict,
  SHUTDOWN_GATE_BOUND_MS,
  classifyVerdict,
  forceExpiry,
  restoreUnderGate,
  shutdownUnderGate,
} from "./v2e-real-lib.ts";

/** Both replies inside this window: the strict V2e form. */
export const MEMO_WINDOW_MS = 3000;
/** How long the end waits for one killed serve tree to be confirmed gone. */
export const CONFIRM_GONE_MS = 10_000;

export interface RealRunDeps {
  /** The claudish account id (`dc53ea1b2616`). */
  account: string;
  /** The stored item's name (keychain account or file path), for the operator's warnings. */
  kcAccount: string;
  /** Where the token lives. `keychain` (default) is V2e; a file store is the same race, not V2e. */
  storeKind?: RealStoreKind;
  store: ItemStore;
  /** The account's refresh gate, with the product's own acquire timeout. */
  gate: Gate;
  /** The same gate, retried until `boundMs` has passed. */
  gateWithin(boundMs: number): Gate;
  /** Step 1: throws unless the account is a keychain account; returns the run-only config. */
  runConfig(): Record<string, unknown>;
  /** The slots file `serve` reads. */
  slots: unknown;
  /** Starts one serve; `onSpawn` is called synchronously the moment its process exists. */
  startServe(onSpawn: (p: Producer) => void): Promise<ServeProc>;
  postMessage(url: string): Promise<DirectReply>;
  readAccountsLog(): string;
  /** This account's `needsReauth` mark, or a string naming why it could not be read. */
  readNeedsReauth(): unknown;
  /** Writes `text` to `name` in --out REDACTED; returns the findings it redacted (one line each). */
  writeOut(name: string, text: string): string[];
  /** The credential-shape scan of every file in --out. */
  scanOut(): { files: number; findings: ShapeFinding[] };
  print(line: string): void;
  printErr(line: string): void;
  now?(): number;
  shutdownBoundMs?: number;
  confirmGoneMs?: number;
}

export interface RealRun {
  /** Steps 1-4, then the end. Never rejects. */
  main(): Promise<void>;
  /** A SIGINT / SIGTERM: records it, then the same idempotent end. */
  interrupt(signal: string): Promise<void>;
  /** The idempotent end: stop issuing, gate, kill, restore, write, scan. */
  finish(): Promise<void>;
  /** For the process 'exit' handler: kill every registered tree, synchronously. */
  killAllSync(): void;
  exitCode(): 0 | 1;
  /** True once the end began. */
  stopping(): boolean;
  report: Record<string, unknown>;
}

/** Thrown by `halt` at an await point once the end began; never the run's error. */
class RunEnding extends Error {}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A record as printed: never a token. */
export const showRecord = (r: RealRecord) => ({
  generation: r.generation,
  expiresAt: typeof r.expiresAt === "number" ? new Date(r.expiresAt).toISOString() : r.expiresAt,
  fingerprint: typeof r.fingerprint === "string" ? `${r.fingerprint.slice(0, 8)}…` : r.fingerprint,
  journal: r.journal ? "open" : "none",
  fields: Object.keys(r).sort().join(","),
});

export function createRealRun(deps: RealRunDeps): RealRun {
  const now = deps.now ?? Date.now;
  const confirmMs = deps.confirmGoneMs ?? CONFIRM_GONE_MS;
  const report: Record<string, unknown> = {
    account: deps.account,
    storeKind: deps.storeKind ?? "keychain",
    startedAt: new Date(now()).toISOString(),
  };
  /** Every serve tree, registered at spawn (a serve still starting included). */
  const producers: Producer[] = [];
  /** The serves that finished starting: their output is written at the end. */
  const serves: ServeProc[] = [];
  /** Kills of trees spawned after the end began. */
  const lateKills: Array<Promise<boolean>> = [];
  /** Set BEFORE the expiry write (forceExpiry's onSnapshot); read by the end under the gate. */
  let before: RealRecord | null = null;
  let failed = false;
  /** Set when the end began: no request, read or write of the main coroutine follows. */
  let stopping = false;
  let finishing: Promise<void> | null = null;
  const redactedOnWrite: string[] = [];

  const safe = (line: string) => redactCredentialShapes(line, []).text;
  const say = (line: string) => deps.print(safe(line));
  const sayErr = (line: string) => deps.printErr(safe(line));
  const write = (name: string, text: string) => {
    const found = deps.writeOut(name, text);
    if (found.length) {
      failed = true;
      redactedOnWrite.push(...found);
    }
  };
  const save = () => write("v2e-real.json", JSON.stringify(report, null, 2));
  const halt = (where: string) => {
    if (stopping) throw new RunEnding(`the run is ending: stopped ${where}`);
  };

  const onSpawn = (p: Producer) => {
    producers.push(p);
    // Spawned after the end began: it has done nothing yet (no request can reach it), so the
    // kill cannot cut a rotation. Killed at once, and confirmed gone before the end writes.
    if (stopping) lateKills.push(p.confirmGone(confirmMs));
  };

  const killServes = async () => {
    const gone = await Promise.all(producers.map((p) => p.confirmGone(confirmMs)));
    report.servesGone = gone.every(Boolean);
    if (!report.servesGone) {
      failed = true;
      sayErr(`WARNING: a serve tree was not confirmed gone within ${confirmMs / 1000} s`);
    }
  };

  async function doFinish(): Promise<void> {
    // Stop issuing, wait for the refresh gate (a serve mid-rotation persists first), kill the
    // serves with the gate held, restore, release. Never a kill in the middle of a rotation.
    const end = await shutdownUnderGate(
      {
        stopIssuing: () => {
          stopping = true;
        },
        gateWithin: deps.gateWithin,
        gate: deps.gate,
        killServes,
        // Decided with the gate HELD: an expiry written while the end waited is seen here.
        restore: async (holdsLock) => {
          const snapshot = before;
          return snapshot ? restoreUnderGate(deps.store, holdsLock, snapshot) : null;
        },
        warn: sayErr,
      },
      deps.kcAccount,
      deps.shutdownBoundMs ?? SHUTDOWN_GATE_BOUND_MS
    );
    if (lateKills.length && !(await Promise.all(lateKills)).every(Boolean)) {
      report.servesGone = false;
      failed = true;
      sayErr(`WARNING: a serve tree was not confirmed gone within ${confirmMs / 1000} s`);
    }
    report.killedUnderGate = end.killedUnderGate;
    if (!end.killedUnderGate) failed = true;
    if (end.restore !== null) {
      report.restore = end.restore;
      if (String(end.restore).startsWith("FAILED")) {
        failed = true;
        sayErr(`RESTORE FAILED: the item may still say expired (expiresAt 0). ${end.restore}`);
      }
      say(`restore   ${String(report.restore)}`);
    }
    // The serves' full output is product log text: written to --out REDACTED, never printed.
    serves.forEach((s, i) => {
      write(`serve-${i + 1}-stdout.txt`, s.stdout());
      write(`serve-${i + 1}-stderr.txt`, s.stderr());
    });
    save();
    // Last: a REAL credential (this run signs with one) must not be in any file of --out,
    // the product's own files (accounts.jsonl) included. A finding names file, offset, length
    // and a sha256 prefix, never the value.
    const shapes = deps.scanOut();
    report.credentialShapeScan = {
      files: shapes.files,
      found: shapes.findings.length > 0 || redactedOnWrite.length > 0,
      findings: shapes.findings.map(formatShapeFinding),
      redactedOnWrite: [...redactedOnWrite],
    };
    if (shapes.findings.length) failed = true;
    say(
      `credential shape scan of --out: ${shapes.findings.length ? `FOUND ${shapes.findings.length}` : "not found"} (${shapes.files} files); redacted on write: ${redactedOnWrite.length}`
    );
    for (const f of shapes.findings) say(`  ${formatShapeFinding(f)}`);
    for (const f of redactedOnWrite) say(`  redacted on write: ${f}`);
    const printed = redactedOnWrite.length;
    save();
    for (const f of redactedOnWrite.slice(printed)) say(`  redacted on write: ${f}`);
  }

  function finish(): Promise<void> {
    if (!finishing) finishing = doFinish();
    return finishing;
  }

  async function main(): Promise<void> {
    try {
      // 1. the account must still be in the real config, on the store this run planned for
      const cfg = deps.runConfig();

      // 2. force expiry under the product's refresh gate (refused once the end began)
      halt("before forcing expiry");
      const forcedRun = await forceExpiry(
        deps.store,
        deps.gate,
        (snap) => {
          before = snap;
        },
        () => stopping
      );
      report.before = showRecord(forcedRun.before);
      report.forced = showRecord(forcedRun.forced);
      say(`before    ${JSON.stringify(report.before)}`);
      say(`forced    ${JSON.stringify(report.forced)}`);
      halt("after forcing expiry");

      // 3. run-only config (this account only), slots
      write("config.json", JSON.stringify(cfg, null, 2));
      write("slots.json", JSON.stringify(deps.slots));
      for (let i = 0; i < 2; i++) {
        halt(`before starting serve ${i + 1}`);
        serves.push(await deps.startServe(onSpawn));
        halt(`after starting serve ${i + 1}: no request issued`);
      }

      // 4. the race (not issued once the run is ending)
      halt("before the race: no request issued");
      const t0 = now();
      const ms: number[] = [];
      const replies = await Promise.all(
        serves.map((s, i) =>
          deps.postMessage(s.url).then((r) => {
            ms[i] = now() - t0;
            return r;
          })
        )
      );
      // A reply cut by the end's kill is not evidence; nothing else is read beside the end.
      halt("after the race");
      const elapsed = now() - t0;
      // The message is product text: it may quote a credential, so only its length and status.
      report.replies = replies.map((r, i) => ({
        status: r.status,
        ms: ms[i],
        errorMessageLength:
          (r.body as { error?: { message?: string } } | null)?.error?.message?.length ?? 0,
        connectionError: r.connectionError ? "yes (see serve-*-stderr.txt)" : undefined,
        redirect: r.redirect,
      }));
      report.elapsedMs = elapsed;
      say(`replies   ${JSON.stringify(report.replies)} elapsed ${elapsed} ms`);

      const after = await deps.store.read();
      halt("after reading the item");
      if (!after) throw new Error("the keychain item is absent after the race");
      report.after = showRecord(after);
      say(`after     ${JSON.stringify(report.after)}`);

      const recs = deps
        .readAccountsLog()
        .split("\n")
        .filter(Boolean)
        .map(
          (l) => JSON.parse(l) as { outcome?: unknown; accountId?: unknown; requestId?: unknown }
        );
      report.accountsRecords = recs.map((r) => ({
        outcome: r.outcome,
        accountId: r.accountId,
        requestId: r.requestId,
      }));
      say(`accounts  ${JSON.stringify(report.accountsRecords)}`);

      const reauth = deps.readNeedsReauth();
      report.needsReauth = reauth;

      const gen0 = forcedRun.before.generation ?? 0;
      const verdict: RealVerdict = {
        bothOk: replies.every((r) => r.status === 200),
        generationAdvancedByOne: after.generation === gen0 + 1,
        fingerprintChanged: after.fingerprint !== forcedRun.before.fingerprint,
        expiryInFuture: typeof after.expiresAt === "number" && after.expiresAt > now(),
        allOnThisAccount: recs.length > 0 && recs.every((r) => r.accountId === deps.account),
        noReauth: reauth === null,
        memoWindowMet: elapsed < MEMO_WINDOW_MS,
      };
      const c = classifyVerdict(verdict, deps.storeKind ?? "keychain");
      report.verdict = verdict;
      report.observational = c.observational;
      report.strict = c.strict;
      report.verdictLines = c.lines;
      say(`verdict   ${JSON.stringify(verdict)}`);
      for (const line of c.lines) say(line);
      if (c.exitCode !== 0) failed = true;
    } catch (err) {
      failed = true;
      const message = safe(messageOf(err));
      // Once the end began, the error it recorded (the signal) stays the run's error; where the
      // main coroutine stopped is kept beside it.
      if (stopping || err instanceof RunEnding) report.stoppedAt = message;
      else {
        report.error = message;
        sayErr(`ERROR ${message}`);
      }
    } finally {
      await finish();
    }
  }

  return {
    main,
    interrupt(signal) {
      report.error = `interrupted by ${signal}`;
      failed = true;
      return finish();
    },
    finish,
    killAllSync() {
      for (const p of producers) p.confirmGoneSync(2_000);
    },
    exitCode: () => (failed ? 1 : 0),
    stopping: () => stopping,
    report,
  };
}
