#!/usr/bin/env bun
/**
 * MCP × 1Password e2e harness.
 *
 *   bun run test:mcp                      # every scenario
 *   bun run test:mcp:op                   # the 1Password group
 *   bun run test:mcp -- --scenario op-cold --verbose
 *
 * Drives a real `claudish --mcp` server over stdio JSON-RPC with a stripped
 * environment and an isolated config, and writes every observation to
 * `logs/mcp-e2e/<stamp>/`.
 *
 * The suite guards its own isolation: it hashes the real
 * `~/.claudish/config.json` before and after the run and fails loudly if it
 * changed. That is not paranoia — the repo's existing e2e tests write that file
 * directly and have destroyed a real user's 1Password configuration twice.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { redactSecrets } from "../redact.js";
import { REAL_CONFIG_PATH, buildArmConfig, buildArmEnv, checkPreconditions } from "./env.js";
import { driveServer } from "./jsonrpc-client.js";
import { SCENARIOS } from "./scenarios.js";
import type { Observation, ObservationView, Scenario, SessionLog, Verdict } from "./types.js";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const SERVER_ENTRY = resolve(REPO_ROOT, "packages/cli/src/index.ts");
const LOG_ROOT = resolve(REPO_ROOT, "logs/mcp-e2e");
const SESSIONS_DIR = join(homedir(), ".claudish", "sessions");

// ── args ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);

const onlyScenario = flag("scenario");
const onlyGroup = flag("group");
const verbose = has("verbose");
const keepLogs = Number(flag("keep-logs") ?? Number.NaN);

// ── run dir ──────────────────────────────────────────────────────────────────

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = join(LOG_ROOT, stamp);
mkdirSync(RUN_DIR, { recursive: true });
const RUN_LOG = join(RUN_DIR, "run.log");

function log(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  try {
    appendFileSync(RUN_LOG, `${stamped}\n`);
  } catch {
    // never let logging take the run down
  }
  process.stdout.write(`${line}\n`);
}

function refreshLatestSymlink(): void {
  const latest = join(LOG_ROOT, "latest");
  try {
    if (existsSync(latest)) unlinkSync(latest);
    symlinkSync(RUN_DIR, latest);
  } catch {
    // symlink is a convenience, not a requirement
  }
}

function md5(path: string): string {
  try {
    return createHash("md5").update(readFileSync(path)).digest("hex");
  } catch {
    return "<absent>";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── session log collection ───────────────────────────────────────────────────

/** Session dirs created after `sinceMs` — the children this arm spawned. */
function collectSessionLogs(sinceMs: number): SessionLog[] {
  const out: SessionLog[] = [];
  try {
    for (const id of readdirSync(SESSIONS_DIR)) {
      const dir = join(SESSIONS_DIR, id);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(dir);
      } catch {
        continue;
      }
      if (!st.isDirectory() || st.birthtimeMs < sinceMs) continue;
      const read = (f: string) => {
        try {
          return redactSecrets(readFileSync(join(dir, f), "utf-8"));
        } catch {
          return "";
        }
      };
      let meta: Record<string, unknown> | null = null;
      try {
        meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
      } catch {
        meta = null;
      }
      out.push({ sessionId: id, meta, stderr: read("stderr.log"), output: read("output.log") });
    }
  } catch {
    // no sessions dir yet — fine
  }
  return out;
}

// ── observation view ─────────────────────────────────────────────────────────

function view(obs: Observation): ObservationView {
  return {
    ...obs,
    hasSpan(prefix: string) {
      return obs.spans.some((s) => s.name.startsWith(prefix));
    },
    resolveRequests() {
      const names = new Set<string>();
      for (const s of obs.spans) {
        const m = s.name.match(/^op:resolve\((.+)\)$/);
        if (!m) continue;
        for (const n of m[1].split(",")) if (n.trim()) names.add(n.trim());
      }
      return [...names].sort();
    },
    grepStderr(re: RegExp) {
      return obs.stderr.split("\n").filter((l) => re.test(l));
    },
  };
}

// ── one arm ──────────────────────────────────────────────────────────────────

async function runScenario(sc: Scenario, gapBeforeSeconds: number): Promise<Verdict> {
  const armDir = join(RUN_DIR, sc.id);
  mkdirSync(armDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  log(`\n▶ ${sc.id} — ${sc.description}`);
  if (gapBeforeSeconds > 0) log(`  (idled ${gapBeforeSeconds}s before this arm)`);

  const config = buildArmConfig(sc.config);
  const configPath = join(armDir, "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

  const replicas = sc.concurrency ?? 1;
  const observations: Observation[] = [];

  const runReplica = async (replica: number): Promise<Observation> => {
    const env = buildArmEnv({
      parent: process.env,
      keepKeys: sc.keepKeys,
      extra: {
        ...sc.env,
        // Isolation: the child reads THIS file, never ~/.claudish/config.json.
        CLAUDISH_CONFIG: configPath,
        // Observability: flips the trace into live-print so op spans stream out.
        CLAUDISH_STARTUP_TRACE: "1",
        CLAUDISH_OP_LOCK_TRACE: "1",
        CLAUDISH_MCP_TOOLS: "all",
      },
    });

    const suffix = replicas > 1 ? `.${replica}` : "";
    writeFileSync(
      join(armDir, `env${suffix}.txt`),
      `${Object.keys(env).sort().join("\n")}\n`,
      "utf-8"
    );

    const since = Date.now();
    const res = await driveServer({
      serverEntry: SERVER_ENTRY,
      cwd: REPO_ROOT,
      env,
      calls: sc.calls,
      timeoutMs: sc.timeoutMs ?? 90_000,
      logFile: join(armDir, `stream${suffix}.log`),
      verbose,
    });

    writeFileSync(join(armDir, `stderr${suffix}.log`), res.stderr, "utf-8");
    writeFileSync(
      join(armDir, `stdout${suffix}.jsonl`),
      `${res.frames.map((f) => JSON.stringify(f)).join("\n")}\n`,
      "utf-8"
    );
    writeFileSync(
      join(armDir, `trace${suffix}.txt`),
      `${res.spans.map((s) => s.raw.trim()).join("\n")}\n`,
      "utf-8"
    );

    const sessionLogs = collectSessionLogs(since);
    if (sessionLogs.length > 0) {
      writeFileSync(
        join(armDir, `sessions${suffix}.json`),
        JSON.stringify(sessionLogs, null, 2),
        "utf-8"
      );
    }

    return {
      scenarioId: sc.id,
      replica,
      exitCode: res.exitCode,
      signal: res.signal,
      timedOut: res.timedOut,
      durationMs: res.durationMs,
      frames: res.frames,
      stderr: res.stderr,
      spans: res.spans,
      toolText: res.toolText,
      sessionLogs,
      configUsed: config,
      envNames: Object.keys(env).sort(),
    };
  };

  if (replicas > 1) {
    // Concurrent arm: the whole point is the simultaneous handshake, so these
    // must start together rather than be staggered.
    observations.push(
      ...(await Promise.all(Array.from({ length: replicas }, (_, i) => runReplica(i))))
    );
  } else {
    observations.push(await runReplica(0));
  }

  let failures: string[];
  try {
    failures = sc.assert(observations.map(view));
  } catch (err) {
    failures = [`assertion threw: ${err instanceof Error ? err.message : String(err)}`];
  }

  const verdict: Verdict = {
    scenarioId: sc.id,
    passed: failures.length === 0,
    failures,
    durationMs: Date.now() - t0,
    startedAt,
    finishedAt: new Date().toISOString(),
    gapBeforeSeconds,
  };
  writeFileSync(join(armDir, "verdict.json"), JSON.stringify(verdict, null, 2), "utf-8");

  log(
    verdict.passed
      ? `  ✅ pass (${verdict.durationMs}ms)`
      : `  ❌ FAIL (${verdict.durationMs}ms)\n${failures.map((f) => `     - ${f}`).join("\n")}`
  );
  return verdict;
}

// ── reports ──────────────────────────────────────────────────────────────────

function writeReports(verdicts: Verdict[], configHash: { before: string; after: string }): void {
  const passed = verdicts.filter((v) => v.passed).length;
  writeFileSync(
    join(RUN_DIR, "report.json"),
    JSON.stringify(
      {
        stamp,
        total: verdicts.length,
        passed,
        failed: verdicts.length - passed,
        configHash,
        verdicts,
      },
      null,
      2
    ),
    "utf-8"
  );

  const rows = verdicts
    .map((v) => {
      const status = v.passed ? "✅ pass" : "❌ FAIL";
      const notes = v.passed ? "" : v.failures.join("; ").replace(/\|/g, "\\|");
      return `| \`${v.scenarioId}\` | ${status} | ${v.durationMs}ms | ${v.gapBeforeSeconds}s | ${notes} |`;
    })
    .join("\n");

  const isolation =
    configHash.before === configHash.after
      ? `✅ \`~/.claudish/config.json\` unchanged (\`${configHash.before}\`)`
      : `❌ **\`~/.claudish/config.json\` CHANGED** — \`${configHash.before}\` → \`${configHash.after}\`. Something in this run wrote the real config. That is the bug this harness exists to prevent.`;

  writeFileSync(
    join(RUN_DIR, "report.md"),
    `# MCP × 1Password e2e — ${stamp}

${passed}/${verdicts.length} arms passed.

${isolation}

| arm | result | duration | gap before | notes |
|---|---|---|---|---|
${rows}

The **gap before** column matters: 1Password suppresses Automated Unlock for 15s
after a burst of denied handshakes, and during that window every request is denied
instantly — including sequential ones from unrelated processes. An arm that expects
success and ran <40s after an auth-failing arm may be measuring the penalty box
rather than its own behaviour. Check this column before believing a surprising result.

Per-arm artifacts live in \`<arm>/\`: \`config.json\` (what it actually ran with),
\`env.txt\` (names only), \`stdout.jsonl\`, \`stderr.log\`, \`trace.txt\` (startup-trace
spans), \`stream.log\` (interleaved), \`sessions.json\` (child session dirs).
`,
    "utf-8"
  );
}

function pruneOldRuns(keep: number): void {
  if (!Number.isFinite(keep) || keep < 1) return;
  try {
    const runs = readdirSync(LOG_ROOT)
      .filter((n) => n !== "latest")
      .map((n) => ({ n, p: join(LOG_ROOT, n) }))
      .filter((r) => {
        try {
          return statSync(r.p).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => b.n.localeCompare(a.n));
    for (const r of runs.slice(keep)) rmSync(r.p, { recursive: true, force: true });
  } catch {
    // pruning is best-effort
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

/** Apply the --group/--scenario filters, in declared run order. */
function selectScenarios(): Scenario[] {
  let selected = SCENARIOS.slice().sort((a, b) => a.order - b.order);
  if (onlyGroup) selected = selected.filter((s) => s.group === onlyGroup);
  if (onlyScenario) selected = selected.filter((s) => s.id === onlyScenario);
  return selected;
}

/** Refuse to run when the machine can't make any arm meaningful. */
function assertPreconditions(): void {
  const problems = checkPreconditions();
  if (problems.length === 0) return;
  log("\n❌ preconditions not met:");
  for (const p of problems) log(`   - ${p}`);
  log("\nRefusing to run — every arm would fail for the same reason.");
  process.exit(2);
}

async function main(): Promise<void> {
  refreshLatestSymlink();
  log("MCP × 1Password e2e harness");
  log(`run dir: ${RUN_DIR}`);

  assertPreconditions();

  const selected = selectScenarios();
  if (selected.length === 0) {
    log(`No scenarios matched (scenario=${onlyScenario ?? "*"} group=${onlyGroup ?? "*"}).`);
    process.exit(2);
  }
  log(`running ${selected.length} arm(s): ${selected.map((s) => s.id).join(", ")}`);

  const before = md5(REAL_CONFIG_PATH);
  log(`real config md5 before: ${before}`);

  const verdicts: Verdict[] = [];
  let lastCooldown = 0;
  for (const sc of selected) {
    verdicts.push(await runScenario(sc, lastCooldown));
    lastCooldown = sc.cooldownSeconds ?? 0;
    if (lastCooldown > 0) {
      log(`  ⏳ cooling down ${lastCooldown}s (1Password denial suppression window)`);
      await sleep(lastCooldown * 1000);
    }
  }

  const after = md5(REAL_CONFIG_PATH);
  log(`real config md5 after:  ${after}`);
  if (before !== after) {
    log("❌ ISOLATION BREACH — the real ~/.claudish/config.json changed during this run.");
  }

  writeReports(verdicts, { before, after });
  if (Number.isFinite(keepLogs)) pruneOldRuns(keepLogs);
  refreshLatestSymlink();

  const failed = verdicts.filter((v) => !v.passed);
  log(`\n${verdicts.length - failed.length}/${verdicts.length} passed`);
  log(`report: ${join(RUN_DIR, "report.md")}`);
  process.exit(failed.length > 0 || before !== after ? 1 : 0);
}

main().catch((err) => {
  log(`harness crashed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
