/**
 * The run engine every row shares: one fresh temp tree per run, the fake upstream,
 * the metered canary, the egress sink, the standing assertions, and the per-run
 * evidence files. A row (rows.ts) supplies its setup and a `run` body; this file
 * supplies everything the contract calls "standing" (rows-contract.md section 1):
 *
 *   1. a pre-flight proves the seam is armed (separate HOME, fake and log);
 *   2. the canary is proved alive (one hit, then reset) before the row;
 *   3. no non-loopback contact except the one known catalog read;
 *   4. HOME is not the real home (`makeRowRoot` asserts it) and the child env is
 *      a whitelist (`buildEnv`);
 *   5. no credential-shaped string reaches a client-visible file.
 *
 * Nothing here touches the real `~/.claudish`, the Keychain or 1Password.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type AccountRecord, type Check, ok } from "./agree.ts";
import { type Canary, startCanary } from "./canary.ts";
import {
  type DirectReply,
  SLOT,
  type ServeProc,
  killTree,
  postMessage,
  startServe,
} from "./direct.ts";
import { startEgressSink } from "./egress-sink.ts";
import {
  type Fake,
  type FakeOptions,
  type LoggedRequest,
  type Reply,
  type ReplyContext,
  type Script,
  startFake,
} from "./fake-upstream.ts";
import { type Mutant, emitMutantTree } from "./mutants.ts";
import {
  KNOWN_EGRESS,
  LAUNCHER,
  OFFLINE_PROFILE,
  type RowRoot,
  buildEnv,
  makeRowRoot,
  run,
} from "./row-env.ts";
import {
  DEFAULT_ACCOUNTS,
  type SeedAccount,
  type StateOp,
  accessTokenOf,
  refreshTokenOf,
  seedHome,
  seedState,
  tokenPathOf,
} from "./seed.ts";

export const ANSWER = "FAKE_ANSWER_OK";
const DEFAULT_PROMPT = "Reply with the single word OK.";
export const CANARY_KEY = "sk-canary-must-never-be-used";

/** What a mutant's red predicate reads. */
export interface Obs {
  canary: number;
  mainCount: number;
  exchanges: { ok: number; invalidGrant: number };
  /** Names of the checks that failed in this run. */
  failedChecks: string[];
  /** Whatever the row noted (statuses, wall clocks, file facts). */
  notes: Record<string, unknown>;
}

export interface MutantRef {
  id: string;
  /** `red`: the row must turn red. `dead`: a negative control the contract measured dead. */
  expected: "red" | "dead";
  /** Returns a description when the run is red, else null. */
  red(o: Obs): string | null;
}

export interface RowSetup {
  accounts: SeedAccount[];
  legacy?: boolean;
  legacyExpiresAt?: number;
  /** Written through the production state store in a child process (needs the account list). */
  stateOps?: StateOp[];
  /** Runs after seeding, before the fake starts; for hand edits the seeders cannot express. */
  after?(c: SeedHookCtx): void | Promise<void>;
  script?: Script;
  fake?: Partial<Pick<FakeOptions, "tokenDelayMs" | "tokenMode" | "classify">>;
  /** Refresh tokens the token endpoint accepts. Default: the seeded accounts'. */
  validRefreshTokens?: string[];
  /** Credentials the row writes MID-RUN (not seeded): searched by value in client-visible files. */
  extraSecrets?: string[];
}

export interface SeedHookCtx {
  tree: RowRoot;
  env: Record<string, string>;
}

export interface SessionResult {
  exit: number | null;
  stdout: string;
  stderr: string;
  transcriptText: string;
  transcripts: string[];
}

export interface RunCtx {
  rowId: string;
  variant: string;
  dir: string;
  tree: RowRoot;
  fake: Fake;
  canary: Canary;
  launcher: string;
  offline: boolean;
  /** The child environment for one process. */
  env(extra?: Record<string, string>): Record<string, string>;
  serve(extraEnv?: Record<string, string>): Promise<ServeProc>;
  post(
    proc: ServeProc,
    prompt?: string,
    sessionId?: string,
    timeoutMs?: number
  ): Promise<DirectReply>;
  session(prompt?: string, extraEnv?: Record<string, string>): Promise<SessionResult>;
  accounts(): AccountRecord[];
  stateJson(): Record<string, unknown> | null;
  tokenJson(label: string): Record<string, unknown> | null;
  main(): LoggedRequest[];
  check(name: string, pass: boolean, detail: string): void;
  checks(list: Check[]): void;
  note(key: string, value: unknown): void;
  onCleanup(fn: () => void | Promise<void>): void;
  /** Write a named evidence file into the run directory. */
  save(name: string, content: string): void;
}

export interface RunRecord {
  rowId: string;
  variant: string;
  dir: string;
  checks: Check[];
  obs: Obs;
  error?: string;
  pass: boolean;
  preflight: { ok: boolean; detail: string };
  egress: string[];
}

export interface RunOptions {
  /** The run directory; the real run of a row uses the row directory itself. */
  dir: string;
  offline: boolean;
  mutant?: Mutant;
  mutantTreesDir: string;
  /** The row's stated canary count, asserted on the real bundle only. */
  canaryExpected: number;
  expectsFakeRequests: boolean;
  rowId: string;
  /** The version pin, recorded before any row ran; written FIRST in every result file. */
  pin?: Record<string, string>;
}

const claudePath = (() => {
  try {
    return realpathSync(run(["which", "claude"], { env: { PATH: process.env.PATH ?? "" } }));
  } catch {
    return "";
  }
})();

export const defaultScript: Script = () => ({ type: "text", text: ANSWER });

/** The quota 429 for `label`'s bearer, the answer for everyone else. */
export function quotaFor(
  labels: Record<string, number>,
  otherwise: Reply = { type: "text", text: ANSWER }
): Script {
  return (ctx: ReplyContext): Reply => {
    for (const [label, resetsAt] of Object.entries(labels)) {
      if (ctx.bearer === `Bearer ${accessTokenOf(label)}`) return { type: "quota", resetsAt };
    }
    return otherwise;
  };
}

export const nowSec = () => Math.floor(Date.now() / 1000);

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Claude Code's project slug: the realpath of the cwd, every non-alphanumeric to `-`. */
export function transcriptSlug(cwd: string): string {
  return realpathSync(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

export function findTranscripts(claudeConfigDir: string, cwd: string): string[] {
  const dir = join(claudeConfigDir, "projects", transcriptSlug(cwd));
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(dir, f));
}

/** Assistant text of every assistant message in a transcript (plus API error lines). */
export function transcriptAnswer(path: string): string {
  const out: string[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as {
        type?: string;
        message?: { content?: Array<{ type: string; text?: string }> | string };
      };
      if (rec.type !== "assistant") continue;
      const content = rec.message?.content;
      if (typeof content === "string") out.push(content);
      else
        for (const part of content ?? [])
          if (part.type === "text" && part.text) out.push(part.text);
    } catch {
      /* ignore a torn line */
    }
  }
  return out.join("\n");
}

/**
 * The ONLY files in a run directory allowed to hold a fake credential: the fake's and the
 * canary's request logs, the sink log, the product's account log and state copy, and the
 * harness's own result files. EVERY other file is product output (responses, serve and session
 * stdout and stderr, transcripts, management command output, seed output) and is scanned.
 * The rule is deliberately inverted: a new file written through `ctx.save` is scanned by
 * default, so no filename prefix can be forgotten.
 */
export const EVIDENCE_FILES: ReadonlySet<string> = new Set([
  "fake.jsonl",
  "canary.jsonl",
  "egress.jsonl",
  "accounts.jsonl",
  "state.json",
  "result.json",
  "outcome.json",
]);

/** True when a file of this base name is product output a user or Claude Code could see. */
export const isProductOutput = (base: string): boolean => !EVIDENCE_FILES.has(base);

/**
 * Run `body` with a release registry opened BEFORE its first acquisition. Releases run in
 * reverse order when `body` returns or throws; one failing release never stops the others.
 */
export async function withReleases<T>(
  body: (release: (fn: () => void) => void) => Promise<T>
): Promise<T> {
  const releases: Array<() => void> = [];
  try {
    return await body((fn) => {
      releases.push(fn);
    });
  } finally {
    for (const fn of releases.reverse()) {
      try {
        fn();
      } catch {
        /* already stopped */
      }
    }
  }
}
/** Shape net: a label letter with an optional number (`access-A`, `refresh-A2`, `access-A3`). */
const FAKE_TOKEN =
  /\b(access-(?:[A-Z]\d*|legacy)|refresh-(?:[A-Z]\d*|legacy)|at-rotated-\d+|rt-rotated-\d+)\b/;
const REAL_LOOKING_KEY =
  /\b(sk-(?!canary-must-never-be-used)[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]{10,}\.)/;

/**
 * Scan a run directory for credential-shaped strings before the evidence is kept.
 * `exact` are the credentials this run seeded or registered with the fake: each is
 * searched by value in the client-visible files, so the shape net is the second net.
 */
export function scanLeaks(dir: string, exact: string[] = []): string[] {
  const findings: string[] = [];
  const visit = (path: string, rel: string) => {
    const st = statSync(path);
    if (st.isDirectory()) {
      for (const f of readdirSync(path)) {
        if (f === "mutant-tree" || f === "bodies" || f.startsWith("mutant-")) continue;
        visit(join(path, f), rel ? `${rel}/${f}` : f);
      }
      return;
    }
    if (st.size > 5_000_000) return;
    const text = readFileSync(path, "utf8");
    const base = rel.split("/").pop() ?? rel;
    const real = REAL_LOOKING_KEY.exec(text);
    if (real) findings.push(`${rel}: key-shaped string ${real[0].slice(0, 12)}...`);
    if (isProductOutput(base)) {
      const tok = FAKE_TOKEN.exec(text);
      if (tok) findings.push(`${rel}: fake credential echoed to a product-output file: ${tok[0]}`);
      for (const secret of exact)
        if (secret && text.includes(secret))
          findings.push(`${rel}: seeded credential echoed to a product-output file: ${secret}`);
      if (text.includes(CANARY_KEY))
        findings.push(`${rel}: the canary api key is echoed to a product-output file`);
    }
  };
  visit(dir, "");
  return findings;
}

async function sinkAndFriends(dir: string) {
  mkdirSync(dir, { recursive: true });
  const sink = await startEgressSink(join(dir, "egress.jsonl"));
  try {
    const canary = startCanary(join(dir, "canary.jsonl"));
    return { sink, canary };
  } catch (err) {
    sink.stop();
    throw err;
  }
}

/**
 * The pre-flight: one V11-shaped request through the same built bundle on a SEPARATE
 * scratch HOME, with its own fake and its own log. It proves the seam is armed
 * (the request reaches the fake) for this run, and it is never in the row's counts.
 */
export async function preflight(
  launcher: string,
  offline: boolean,
  dir: string,
  strict: boolean
): Promise<{ ok: boolean; detail: string }> {
  const pdir = join(dir, "preflight");
  // Cleanup protection opens before the first acquisition; each handle registers at once.
  return withReleases(async (release) => {
    const tree = makeRowRoot();
    const { sink, canary } = await sinkAndFriends(pdir);
    release(() => sink.stop());
    release(() => canary.stop());
    let serve: ServeProc | undefined;
    let finished = false;
    const fake = startFake({
      logPath: join(pdir, "fake.jsonl"),
      script: quotaFor({ A: nowSec() + 3600 }),
      classify: () => "main",
      validRefreshTokens: DEFAULT_ACCOUNTS.map((a) => refreshTokenOf(a.label)),
    });
    release(() => fake.stop());
    try {
      await seedHome({
        home: tree.home,
        accountsDir: tree.accountsDir,
        accounts: DEFAULT_ACCOUNTS,
      });
      const env = buildEnv({
        tree,
        accountsLog: join(pdir, "accounts.jsonl"),
        fakeOrigin: fake.origin,
        canaryOrigin: canary.origin,
        sinkPort: sink.port,
        claudePath,
      });
      const slotsPath = join(tree.root, "slots.json");
      writeFileSync(
        slotsPath,
        JSON.stringify([{ slot: SLOT, model: "gpt-6.1-sol", provider: "openai-codex" }])
      );
      serve = await startServe({ env, cwd: tree.cwd, slotsPath, offline, launcher });
      const reply = await postMessage(serve.url, "Reply with the single word OK.");
      await Bun.sleep(300);
      const main = fake.requests.filter((r) => r.kind === "main");
      const reached = main.length >= 1;
      const full = main.length === 2 && reply.status === 200;
      const pass = strict ? full : reached;
      finished = true;
      return {
        ok: pass,
        detail: `HTTP ${reply.status}, ${main.length} main request(s) reached the pre-flight fake, bearers ${main
          .map((m) => m.bearer)
          .join(" -> ")}`,
      };
    } catch (err) {
      return { ok: false, detail: `pre-flight threw: ${err}` };
    } finally {
      serve?.kill("SIGKILL");
      // Removed when the pre-flight finished; kept when it threw (the evidence is the tree).
      if (finished) rmSync(tree.root, { recursive: true, force: true });
    }
  });
}

export async function executeRun(
  rowId: string,
  setup: RowSetup,
  body: (c: RunCtx) => Promise<void>,
  opts: RunOptions
): Promise<RunRecord> {
  const { dir } = opts;
  mkdirSync(dir, { recursive: true });
  const variant = opts.mutant ? `mutant-${opts.mutant.id}` : "real";
  const launcher = opts.mutant
    ? emitMutantTree(opts.mutant, join(opts.mutantTreesDir, opts.mutant.id))
    : LAUNCHER;

  const pre = await preflight(launcher, opts.offline, dir, !opts.mutant);
  const checks: Check[] = [];
  const notes: Record<string, unknown> = {};
  const cleanups: Array<() => void | Promise<void>> = [];
  const procs: ServeProc[] = [];
  let error: string | undefined;

  // Cleanup protection starts before the first acquisition: each handle registers its
  // release the moment it exists, and one finally (at the end of the function) runs them.
  // The temp tree is deliberately NOT released here: a failed run keeps it as evidence.
  const releases: Array<() => void> = [];
  try {
    const tree = makeRowRoot();
    const { sink, canary } = await sinkAndFriends(dir);
    releases.push(
      () => sink.stop(),
      () => canary.stop()
    );
    const accountsLog = join(dir, "accounts.jsonl");
    const refreshTokens =
      setup.validRefreshTokens ?? setup.accounts.map((a) => refreshTokenOf(a.label));
    if (setup.legacy) refreshTokens.push("refresh-legacy");
    const fake = startFake({
      logPath: join(dir, "fake.jsonl"),
      bodyDir: join(dir, "bodies"),
      script: setup.script ?? defaultScript,
      classify: setup.fake?.classify ?? (() => "main"),
      tokenDelayMs: setup.fake?.tokenDelayMs,
      tokenMode: setup.fake?.tokenMode,
      validRefreshTokens: refreshTokens,
    });
    releases.push(() => fake.stop());

    const env = (extra?: Record<string, string>) =>
      buildEnv({
        tree,
        accountsLog,
        fakeOrigin: fake.origin,
        canaryOrigin: canary.origin,
        sinkPort: sink.port,
        claudePath,
        extra,
      });
    const slotsPath = join(tree.root, "slots.json");
    writeFileSync(
      slotsPath,
      JSON.stringify([{ slot: SLOT, model: "gpt-6.1-sol", provider: "openai-codex" }])
    );

    const ctx: RunCtx = {
      rowId,
      variant,
      dir,
      tree,
      fake,
      canary,
      launcher,
      offline: opts.offline,
      env,
      async serve(extraEnv) {
        const proc = await startServe({
          env: env(extraEnv),
          cwd: tree.cwd,
          slotsPath,
          offline: opts.offline,
          launcher,
        });
        procs.push(proc);
        return proc;
      },
      post: (proc, prompt, sessionId, timeoutMs) =>
        postMessage(proc.url, prompt ?? DEFAULT_PROMPT, sessionId, timeoutMs),
      async session(prompt, extraEnv) {
        const inner = [
          "node",
          launcher,
          "-y",
          "-q",
          "-p",
          prompt ?? DEFAULT_PROMPT,
          "--model",
          "cx@gpt-6.1-sol",
        ];
        const argv = opts.offline ? ["sandbox-exec", "-p", OFFLINE_PROFILE, ...inner] : inner;
        const child = Bun.spawn(argv, {
          cwd: tree.cwd,
          env: env(extraEnv),
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
        });
        // A real row ends in seconds. A mutant that reaches the canary gets a 500 that Claude
        // Code retries with backoff for minutes, so a mutant run is cut at 45 s: the canary
        // has long since recorded its hit (the row's red condition is "at least one").
        const timer = setTimeout(
          () => killTree(child.pid, "SIGKILL"),
          opts.mutant ? 45_000 : 150_000
        );
        const [stdout, stderr] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        const exit = await child.exited;
        clearTimeout(timer);
        await Bun.sleep(500);
        const transcripts = findTranscripts(tree.claudeDir, tree.cwd);
        const transcriptText = transcripts.map(transcriptAnswer).join("\n");
        for (const t of transcripts)
          writeFileSync(join(dir, `transcript-${t.split("/").pop()}`), readFileSync(t));
        writeFileSync(join(dir, "stdout.txt"), stdout);
        writeFileSync(join(dir, "stderr.txt"), stderr);
        return { exit, stdout, stderr, transcriptText, transcripts };
      },
      accounts: () => readJsonl<AccountRecord>(accountsLog),
      stateJson: () => readJson(join(tree.accountsDir, "state.json")),
      tokenJson(label) {
        const id = setup.accounts.find((a) => a.label === label)?.id;
        return id ? readJson(tokenPathOf(tree.accountsDir, id)) : null;
      },
      main: () => fake.requests.filter((r) => r.kind === "main"),
      check: (name, pass, detail) => checks.push(ok(name, pass, detail)),
      checks: (list) => checks.push(...list),
      note: (key, value) => {
        notes[key] = value;
      },
      onCleanup: (fn) => cleanups.push(fn),
      save: (name, content) => writeFileSync(join(dir, name), content),
    };

    try {
      // 2. The canary is proved alive: one request, exactly one hit, then reset.
      await fetch(`${canary.origin}/v1/responses`, {
        method: "POST",
        headers: { authorization: "Bearer canary-self-test" },
        body: "{}",
      });
      const selfTest = canary.hits.length;
      canary.reset();
      checks.push(
        ok(
          "[standing] canary self-test: exactly one hit, then reset",
          selfTest === 1,
          `${selfTest}`
        )
      );
      checks.push(ok("[standing] pre-flight request reached the fake", pre.ok, pre.detail));

      await seedHome({
        home: tree.home,
        accountsDir: tree.accountsDir,
        accounts: setup.accounts,
        legacy: setup.legacy,
        legacyExpiresAt: setup.legacyExpiresAt,
      });
      if (setup.stateOps?.length) {
        ctx.save("state-seed.txt", seedState(env(), setup.stateOps, tree.root));
      }
      await setup.after?.({ tree, env: env() });

      await body(ctx);
      await Bun.sleep(300); // late log appends
    } catch (err) {
      error = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
      checks.push(ok("[row] ran to completion", false, error.split("\n")[0] ?? error));
    } finally {
      for (const fn of cleanups.reverse()) {
        try {
          await fn();
        } catch {
          /* a cleanup failure must not hide the row's result */
        }
      }
      for (const p of procs) p.kill("SIGKILL");
      await Bun.sleep(100);
    }

    const mainCount = fake.requests.filter((r) => r.kind === "main").length;
    const traffic = fake.requests.filter((r) => r.kind === "main" || r.kind === "token").length;
    if (opts.expectsFakeRequests) {
      checks.push(
        ok("[standing] the row's own fake log has a request", traffic >= 1, `${traffic}`)
      );
    }
    if (!opts.mutant) {
      checks.push(
        ok(
          `[standing] canary === ${opts.canaryExpected}`,
          canary.hits.length === opts.canaryExpected,
          `${canary.hits.length}${canary.hits.length ? ` (${canary.hits.map((h) => `${h.method} ${h.path}`).join("; ")})` : ""}`
        )
      );
    }
    const egress = sink.attempts.map((a) => `${a.method} ${a.target}`);
    checks.push(
      ok(
        "[standing] no non-loopback contact beyond the known catalog read",
        egress.every((e) => KNOWN_EGRESS.test(e)),
        egress.join("; ") || "none"
      )
    );
    for (const [i, p] of procs.entries()) {
      ctx.save(`serve-${i + 1}-stdout.txt`, p.stdout());
      ctx.save(`serve-${i + 1}-stderr.txt`, p.stderr());
    }
    for (const f of ["state.json"]) {
      const src = join(tree.accountsDir, f);
      if (existsSync(src)) copyFileSync(src, join(dir, f));
    }
    const exchanges = fake.exchanges();
    const canaryHits = canary.hits.length;
    fake.stop();
    canary.stop();
    sink.stop();

    const seeded = [
      ...setup.accounts.flatMap((a) => [accessTokenOf(a.label), refreshTokenOf(a.label)]),
      ...refreshTokens,
      ...(setup.legacy ? ["access-legacy"] : []),
      ...(setup.extraSecrets ?? []),
    ];
    const leaks = scanLeaks(dir, [...new Set(seeded)]);
    checks.push(
      ok(
        "[standing] no credential-shaped string in client-visible evidence",
        leaks.length === 0,
        leaks.join("; ") || "clean"
      )
    );

    const failedChecks = checks.filter((c) => !c.ok).map((c) => c.name);
    const obs: Obs = { canary: canaryHits, mainCount, exchanges, failedChecks, notes };
    const record: RunRecord = {
      rowId,
      variant,
      dir,
      checks,
      obs,
      error,
      pass: failedChecks.length === 0 && error === undefined,
      preflight: pre,
      egress,
    };
    writeFileSync(
      join(dir, "result.json"),
      JSON.stringify({ pin: opts.pin ?? null, ...record }, null, 2)
    );
    // A passing run (or a mutant run that did not error: its evidence is `dir`) drops its
    // temp tree; a failing or erroring real run keeps it as evidence.
    if (record.pass || (opts.mutant && error === undefined)) {
      rmSync(tree.root, { recursive: true, force: true });
    }
    return record;
  } finally {
    for (const release of releases) {
      try {
        release();
      } catch {
        /* already stopped */
      }
    }
  }
}
