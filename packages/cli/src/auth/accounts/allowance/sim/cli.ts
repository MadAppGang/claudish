/**
 * The tournament's command line (architecture §4 `cli.ts`): the only file of
 * `allowance/` that may read a clock, `process` or spawn (the purity guard
 * skips it), and it is never imported by the CLI bundle.
 *
 *   bun run packages/cli/src/auth/accounts/allowance/sim/cli.ts \
 *     [--seeds 200] [--scenario <substring>] [--days 28] [--json] [--jobs N]
 *     [--contestants sticky,ebr,lookahead,governing-fefo,water-fill]
 *     [--plan-latency <ms>] [--set NAME=value …]
 *   bun run sim:allowance -- …
 *
 * It runs the adversarial round, measures PLAN_LATENCY as the p95 of the
 * in-process `planFor` timing on a warm-up run (until the §6 step 12 bench
 * replaces it), runs every (scenario, seed) unit with every contestant on the
 * same trace, and prints one comparison table per scenario plus the §4 gate.
 * `--jobs N` splits the units over N child processes of itself. It writes no
 * file; a bench report copies the output into `ai-docs/benches/`.
 */

import { DEFAULT_ALLOWANCE_CONFIG } from "../constants.js";
import type { AllowanceConfig } from "../types.js";
import {
  type Aggregate,
  type RunSummary,
  aggregate,
  gate,
  quantile,
  summarize,
} from "./metrics.js";
import { runScenario } from "./run.js";
import { SCENARIOS, type Scenario, scenariosMatching } from "./scenarios.js";
import { CONTESTANTS, type Contestant, type ContestantName, runAdversarial } from "./tournament.js";
import { generateTrace } from "./traces.js";

/** Monday 2026-10-26 00:00 UTC: every run starts here (the §5 T0). */
const START = Date.UTC(2026, 9, 26);

interface Args {
  seeds: number;
  scenario: string | undefined;
  days: number;
  json: boolean;
  jobs: number;
  contestants: ContestantName[];
  planLatencyMs: number | null;
  shard: { k: number; n: number } | null;
  overrides: Partial<AllowanceConfig>;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    seeds: 200,
    scenario: undefined,
    days: 28,
    json: false,
    jobs: 1,
    contestants: CONTESTANTS.map((c) => c.name),
    planLatencyMs: null,
    shard: null,
    overrides: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    switch (a) {
      case "--seeds":
        args.seeds = Number(v);
        i++;
        break;
      case "--scenario":
        args.scenario = v;
        i++;
        break;
      case "--days":
        args.days = Number(v);
        i++;
        break;
      case "--json":
        args.json = true;
        break;
      case "--jobs":
        args.jobs = Math.max(1, Number(v));
        i++;
        break;
      case "--contestants":
        args.contestants = (v ?? "").split(",").filter(Boolean) as ContestantName[];
        i++;
        break;
      case "--plan-latency":
        args.planLatencyMs = Number(v);
        i++;
        break;
      case "--shard": {
        const [k, n] = (v ?? "").split("/").map(Number);
        args.shard = { k: k ?? 0, n: n ?? 1 };
        i++;
        break;
      }
      case "--set": {
        const [name, value] = (v ?? "").split("=");
        if (name && value !== undefined && name in DEFAULT_ALLOWANCE_CONFIG) {
          (args.overrides as Record<string, unknown>)[name] = Number.isNaN(Number(value))
            ? value
            : Number(value);
        } else {
          throw new Error(`--set: unknown constant ${name}`);
        }
        i++;
        break;
      }
      default:
        if (a?.startsWith("--")) throw new Error(`unknown flag ${a}`);
    }
  }
  return args;
}

/** One (scenario, seed): every contestant on the same trace. */
function runUnit(
  scenario: Scenario,
  seed: number,
  args: Args,
  cfg: AllowanceConfig,
  planLatencyMs: number
): RunSummary[] {
  const trace = generateTrace(seed, scenario.profile, args.days, scenario.accounts(START), {
    start: START,
  });
  const out: RunSummary[] = [];
  for (const contestant of CONTESTANTS.filter((c) => args.contestants.includes(c.name))) {
    const times = { plan: [] as number[], alerts: [] as number[] };
    const log = runScenario({
      seed,
      scenario,
      contestant,
      days: args.days,
      start: START,
      trace,
      cfg,
      planLatencyMs,
      measure: (kind, fn) => {
        const t = performance.now();
        const r = fn();
        times[kind].push(performance.now() - t);
        return r;
      },
    });
    out.push(
      summarize(log, cfg, {
        alerts: scenario.alerts && contestant.deployable,
        planMs: times.plan,
        alertMs: times.alerts,
      })
    );
  }
  return out;
}

/** PLAN_LATENCY: the p95 of `planFor` on a 3-day warm-up of `lookahead`. */
function measurePlanLatency(cfg: AllowanceConfig): number {
  const scenario = SCENARIOS.find((s) => s.name === "steady · 2× offset 26 h") ?? SCENARIOS[0];
  const lookahead = CONTESTANTS.find((c) => c.name === "lookahead") as Contestant;
  if (!scenario) return 20;
  const days = 3;
  const trace = generateTrace(0, scenario.profile, days, scenario.accounts(START), {
    start: START,
  });
  const times: number[] = [];
  runScenario({
    seed: 0,
    scenario,
    contestant: lookahead,
    days,
    start: START,
    trace,
    cfg,
    planLatencyMs: 0,
    measure: (kind, fn) => {
      const t = performance.now();
      const r = fn();
      if (kind === "plan") times.push(performance.now() - t);
      return r;
    },
  });
  return Math.max(1, Math.ceil(quantile(times, 0.95)));
}

/** Every (scenario, seed), the alert scenarios first: they cost the most, and `i mod n` then spreads them over the shards. */
function units(args: Args): { scenario: Scenario; seed: number }[] {
  const out: { scenario: Scenario; seed: number }[] = [];
  const scenarios = scenariosMatching(args.scenario).sort(
    (a, b) => Number(b.alerts) - Number(a.alerts)
  );
  for (const scenario of scenarios) {
    for (let seed = 1; seed <= args.seeds; seed++) out.push({ scenario, seed });
  }
  return out;
}

async function runSharded(args: Args, planLatencyMs: number): Promise<RunSummary[]> {
  const self = new URL(import.meta.url).pathname;
  const pass = process.argv.slice(2).filter((_, i, all) => {
    const prev = all[i - 1];
    return (
      !["--jobs", "--shard", "--plan-latency"].includes(all[i] ?? "") &&
      !["--jobs", "--shard", "--plan-latency"].includes(prev ?? "")
    );
  });
  const children = Array.from({ length: args.jobs }, (_, k) =>
    Bun.spawn(
      [
        "bun",
        "run",
        self,
        ...pass,
        "--shard",
        `${k}/${args.jobs}`,
        "--plan-latency",
        String(planLatencyMs),
      ],
      { stdout: "pipe", stderr: "inherit" }
    )
  );
  const outputs = await Promise.all(children.map((c) => new Response(c.stdout).text()));
  const codes = await Promise.all(children.map((c) => c.exited));
  if (codes.some((c) => c !== 0)) throw new Error(`a shard failed: exit codes ${codes.join(",")}`);
  return outputs.flatMap((o) =>
    o
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as RunSummary)
  );
}

// ---------------------------------------------------------------------------
// Rendering

function fmt(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (!Number.isFinite(n)) return "∞";
  return n.toFixed(digits);
}

function mcu(n: number): string {
  return fmt(n / 1e6, 2);
}

function delta(n: number | null, scale = 1, digits = 2): string {
  if (n === null) return "";
  const v = n / scale;
  return ` (${v > 0 ? "+" : ""}${v.toFixed(digits)})`;
}

function table(rows: readonly Aggregate[]): string {
  const head =
    "| contestant | unserved Mcu med / p95 (Δ sticky) | DW blocked h med / p95 (Δ) | blocked h 7d / 5h | waste % | longest gap h | switches /100 req · /day | rebuild Mcu | stale % | plans /day · p95 ms | alert step p95 ms | fc err | band | WARN lead h | false alarms | flaps / clears | missed |";
  const sep = `|${"---|".repeat(17)}`;
  const lines = rows.map((a) => {
    const al = a.alerts;
    return `| ${a.contestant} | ${mcu(a.unservedCu.median)} / ${mcu(a.unservedCu.p95)}${a.contestant === "sticky" ? "" : delta(a.unservedVsSticky, 1e6)} | ${fmt(a.demandWeightedBlockedHours.median)} / ${fmt(a.demandWeightedBlockedHours.p95)}${a.contestant === "sticky" ? "" : delta(a.blockedVsSticky, 1, 1)} | ${fmt(a.blockedHours7d.median, 0)} / ${fmt(a.blockedHours5h.median, 0)} | ${fmt(a.wastePct.median)} | ${fmt(a.longestGapH.median, 0)} | ${fmt(a.switchesPer100.median)} · ${fmt(a.switchesPerDay.median)} | ${mcu(a.rebuildCu.median)} | ${a.staleShare === null ? "—" : fmt(100 * a.staleShare)} | ${fmt(a.plansPerDay, 0)} · ${fmt(a.planMsP95, 1)} | ${fmt(a.alertMsP95, 0)} | ${a.forecastServedError === null ? "—" : `${fmt(100 * a.forecastServedError, 0)} %`} | ${a.bandCoverage === null ? "—" : fmt(a.bandCoverage, 2)} | ${al ? fmt(al.leadTimeH) : "—"} | ${al?.falseAlarmRate == null ? "—" : `${fmt(100 * al.falseAlarmRate, 0)} %`} | ${al ? `${al.flaps} / ${al.clears}` : "—"} | ${al ? al.missedGaps : "—"} |`;
  });
  return [head, sep, ...lines].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg: AllowanceConfig = { ...DEFAULT_ALLOWANCE_CONFIG, ...args.overrides };

  if (args.shard) {
    const all = units(args);
    for (let i = args.shard.k; i < all.length; i += args.shard.n) {
      const u = all[i];
      if (!u) continue;
      const t = performance.now();
      for (const s of runUnit(u.scenario, u.seed, args, cfg, args.planLatencyMs ?? 20)) {
        process.stdout.write(`${JSON.stringify(s)}\n`);
      }
      process.stderr.write(
        `[shard ${args.shard.k}] ${u.scenario.name} seed ${u.seed}: ${((performance.now() - t) / 1000).toFixed(1)} s\n`
      );
    }
    return;
  }

  const started = performance.now();
  const adversarial = runAdversarial(cfg);
  const planLatencyMs = args.planLatencyMs ?? measurePlanLatency(cfg);
  process.stderr.write(`[sim] PLAN_LATENCY ${planLatencyMs} ms (p95 of planFor, in-process)\n`);

  let runs: RunSummary[];
  if (args.jobs > 1) runs = await runSharded(args, planLatencyMs);
  else {
    runs = [];
    for (const u of units(args)) {
      const t = performance.now();
      runs.push(...runUnit(u.scenario, u.seed, args, cfg, planLatencyMs));
      process.stderr.write(
        `[sim] ${u.scenario.name} seed ${u.seed}: ${((performance.now() - t) / 1000).toFixed(1)} s\n`
      );
    }
  }
  const aggregates = aggregate(runs);
  const gates = (["ebr", "lookahead"] as const)
    .filter((c) => args.contestants.includes(c))
    .map((c) => gate(c, aggregates, adversarial));

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ planLatencyMs, days: args.days, seeds: args.seeds, adversarial, aggregates, gates }, null, 2)}\n`
    );
    return;
  }

  const out: string[] = [];
  out.push(
    `# allowance tournament · ${args.seeds} seeds × ${args.days} d · PLAN_LATENCY ${planLatencyMs} ms · ${((performance.now() - started) / 1000).toFixed(0)} s\n`
  );
  out.push("## Adversarial traces (served tasks; oracle; 7d gaps in hours)\n");
  out.push("| trace | contestant | served | promised | oracle | gaps | pass |");
  out.push("|---|---|---|---|---|---|---|");
  for (const s of adversarial.served) {
    out.push(
      `| ${s.trace} | ${s.contestant} | ${s.served} | ${s.expected ?? "—"} | ${s.oracle} | ${s.gaps.map((g) => `${g.startH}→${g.endH}`).join(", ") || "none"} | ${s.pass ? "✓" : "✗"} |`
    );
  }
  out.push("\n| trace | under | pass | result |");
  out.push("|---|---|---|---|");
  for (const c of adversarial.checks)
    out.push(`| ${c.trace} | ${c.under} | ${c.pass ? "✓" : "✗"} | ${c.detail} |`);

  const scenarios = [...new Set(aggregates.map((a) => a.scenario))];
  for (const name of scenarios) {
    const rows = aggregates
      .filter((a) => a.scenario === name)
      .sort(
        (a, b) => args.contestants.indexOf(a.contestant) - args.contestants.indexOf(b.contestant)
      );
    out.push(`\n## ${name}\n`);
    out.push(table(rows));
  }
  out.push("\n## Gate (§4)\n");
  for (const g of gates) {
    out.push(`- **${g.contestant}: ${g.pass ? "PASSES" : "does not pass"}**`);
    for (const i of g.items) out.push(`  - ${i.item}. ${i.pass ? "✓" : "✗"} ${i.detail}`);
  }
  process.stdout.write(`${out.join("\n")}\n`);
}

await main();
