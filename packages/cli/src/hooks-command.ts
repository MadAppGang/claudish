/**
 * `claudish hooks` — inspect, check and scaffold hooks.
 *
 *   claudish hooks list [--json]                     every hook in effective order, then load errors
 *   claudish hooks check <file> [--json]             load one module in isolation and validate it
 *   claudish hooks init [dir]                        write example-hook.ts + claudish-hooks.d.ts
 *   claudish hooks corpus [--write] [--json]         replay recorded transcripts for divergences
 *   claudish hooks telemetry [--enable | --disable]  show or change the upload consent
 *
 * `list` exists because the hook system is otherwise invisible: a user who edits
 * `hooks.severity` has no way to tell whether their glob matched, or whether a
 * built-in is off because it is scoped to foreign routes. It prints the
 * effective order, which is the order actions are applied in.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { HOOKS_AMBIENT_DTS } from "./hooks/ambient-dts.generated.js";
import { OBSERVER_HOOK_ID, observerEnabled } from "./hooks/builtins/observer.js";
import { parseHooksConfig } from "./hooks/config.js";
import { loadHookSet } from "./hooks/index.js";
import { loadUserHooks } from "./hooks/loader.js";
import { buildCorpus } from "./hooks/observer/corpus.js";
import { HOOK_API_VERSION } from "./hooks/public.js";
import type { RegisteredHook } from "./hooks/registry.js";
import { outboxPath } from "./hooks/telemetry/aggregate.js";
import { activeConfigFile, loadConfig } from "./profile-config.js";
import { cliAnsi } from "./theme/ansi.js";

// Theme-aware colour helpers. cliAnsi() is resolved inside each helper (at
// render time), never at module load — theme detection runs at CLI startup,
// after this module is imported.
const paint = (code: "GREEN" | "YELLOW" | "DIM" | "BOLD" | "RED") => (s: string) => {
  const a = cliAnsi();
  return `${a[code]}${s}${a.RESET}`;
};
const green = paint("GREEN");
const yellow = paint("YELLOW");
const red = paint("RED");
const dim = paint("DIM");
const bold = paint("BOLD");

function severityColor(sev: string): string {
  if (sev === "fix") return green(sev);
  if (sev === "warn") return yellow(sev);
  return dim(sev);
}

/** A hook as `list --json` and `check --json` print it (§4.9). */
function hookRow(hook: RegisteredHook, severity: string) {
  return {
    id: hook.id,
    source: hook.source,
    events: [...hook.events],
    defaultSeverity: hook.defaultSeverity,
    severity,
    routes: hook.routes,
    models: [...hook.models],
    order: hook.order,
    unsafe: hook.unsafe,
  };
}

/* ───────────── list ───────────── */

async function list(json: boolean): Promise<number> {
  // The config-load reporters write to stderr as they do for every claudish run (stdout
  // stays pure JSON with --json). Per-module warnings are not printed twice: each is in
  // `errors`, which this command reports.
  const set = await loadHookSet({ hostMode: "other", moduleWarn: () => {} });
  const rows = set.registry.hooks.map((h) => hookRow(h, set.registry.severityOf(h)));

  if (json) {
    console.log(
      JSON.stringify(
        {
          apiVersion: HOOK_API_VERSION,
          configFile: activeConfigFile(),
          hooks: rows,
          errors: set.errors,
          behaviorConfigFound: set.behaviorConfigFound,
        },
        null,
        2
      )
    );
    return 0;
  }

  console.log(bold("\nHooks, in effective order\n"));
  // A severity says how a hook acts once it runs; the observer also needs its own
  // switch, so without it a `fix` row would read as active.
  const observerOff = !observerEnabled(set.config);
  for (const r of rows) {
    const overridden =
      r.severity !== r.defaultSeverity ? dim(` (default ${r.defaultSeverity})`) : "";
    const unsafe = r.unsafe ? ` ${red("UNSAFE")}` : "";
    const inactive =
      r.id === OBSERVER_HOOK_ID && observerOff
        ? dim(" (inactive: hooks.observer.enabled is off)")
        : "";
    console.log(
      `  ${severityColor(r.severity).padEnd(18)} ${r.id}${overridden}${unsafe}${inactive}`
    );
    const scope = [
      `${r.source}`,
      `events ${r.events.join(", ")}`,
      `routes ${r.routes}`,
      r.models.join(",") !== "*" ? `models ${r.models.join(", ")}` : null,
      r.order !== "normal" ? `order ${r.order}` : null,
    ].filter(Boolean);
    console.log(`  ${dim(scope.join(" · "))}\n`);
  }
  console.log(dim(`  config: ${activeConfigFile()}\n`));

  if (set.errors.length > 0) {
    console.log(bold("Not loaded\n"));
    for (const e of set.errors) console.log(`  ${yellow(e.module)}\n  ${dim(e.reason)}\n`);
  }
  if (set.behaviorConfigFound) {
    console.log(
      yellow('  A "behavior" block is in the config. It is no longer read: move it to "hooks".\n')
    );
  }
  return 0;
}

/* ───────────── check ───────────── */

async function check(file: string | undefined, json: boolean): Promise<number> {
  if (!file) {
    console.error("Usage: claudish hooks check <file> [--json]");
    return 1;
  }
  const path = resolve(process.cwd(), file);
  const notes: string[] = [];
  const loaded = await loadUserHooks({
    modules: [path],
    configDir: process.cwd(),
    hostMode: "other",
    warn: (line) => notes.push(line),
  });
  const valid = loaded.errors.length === 0 && loaded.hooks.length > 0;
  const hooks = loaded.hooks.map((u) => ({
    id: u.id,
    events: Object.keys(u.def.on ?? {})
      .filter((k) => (u.def.on as Record<string, unknown>)[k] !== undefined)
      .concat(Object.keys((u.def as { raw?: object }).raw ?? {}).map((k) => `raw.${k}`)),
    unsafe: (u.def as { unsafe?: boolean }).unsafe === true,
  }));

  if (json) {
    console.log(JSON.stringify({ file: path, valid, hooks, errors: loaded.errors }, null, 2));
    return valid ? 0 : 1;
  }

  console.log(`\n  ${valid ? green("valid") : red("invalid")}  ${path}\n`);
  for (const h of hooks) {
    console.log(`  ${h.id}${h.unsafe ? ` ${red("UNSAFE")}` : ""}  ${dim(h.events.join(", "))}`);
  }
  if (hooks.length === 0 && loaded.errors.length === 0) {
    console.log(`  ${yellow("the module exports no hook")}`);
  }
  for (const e of loaded.errors) console.log(`  ${red("✗")} ${e.reason}`);
  console.log();
  return valid ? 0 : 1;
}

/* ───────────── init ───────────── */

const EXAMPLE_HOOK = `/// <reference path="./claudish-hooks.d.ts" />
/**
 * An example claudish hook. Add its path to "hooks.modules" in
 * ~/.claudish/config.json, then run \`claudish hooks list\` to see it.
 *
 * Check it with: claudish hooks check example-hook.ts
 */
import type { HookDefinition } from "claudish/hooks";

export default {
  apiVersion: 1,
  id: "reply-language",
  description: "Asks foreign models to answer in English",
  routes: "foreign",
  on: {
    request(ctx) {
      ctx.log(\`request for \${ctx.route.modelId}\`);
      return [{ type: "injectSystemNote", text: "Always answer in English." }];
    },
  },
} satisfies HookDefinition;
`;

function init(dirArg: string | undefined): number {
  const dir = dirArg ? resolve(process.cwd(), dirArg) : join(homedir(), ".claudish", "hooks");
  const files: Array<[string, string]> = [
    [join(dir, "example-hook.ts"), EXAMPLE_HOOK],
    [join(dir, "claudish-hooks.d.ts"), HOOKS_AMBIENT_DTS],
  ];
  const existing = files.filter(([path]) => existsSync(path)).map(([path]) => path);
  if (existing.length > 0) {
    for (const path of existing) console.error(`${path} already exists; not overwriting it.`);
    return 1;
  }
  mkdirSync(dir, { recursive: true });
  for (const [path, text] of files) writeFileSync(path, text, { flag: "wx" });
  console.log(`\n  wrote ${files.map(([p]) => p).join("\n  wrote ")}\n`);
  console.log(dim(`  Add "${files[0]?.[0]}" to "hooks.modules" in ${activeConfigFile()}.\n`));
  return 0;
}

/* ───────────── corpus ───────────── */

/** Per-model breakdown — the actionable part: it says WHICH models need a rule. */
function printByModel(records: { model?: string; outcome: string }[]): void {
  const byModel = new Map<string, { ok: number; degraded: number }>();
  for (const r of records) {
    const m = r.model ?? "unknown";
    const e = byModel.get(m) ?? { ok: 0, degraded: 0 };
    if (r.outcome === "degraded") e.degraded++;
    else e.ok++;
    byModel.set(m, e);
  }
  if (byModel.size === 0) return;

  console.log(bold("  by model (degraded / ok)\n"));
  const ranked = [...byModel.entries()].sort(
    (a, b) => b[1].degraded - a[1].degraded || b[1].ok - a[1].ok
  );
  for (const [model, v] of ranked) {
    const flag = v.degraded > 0 ? yellow(String(v.degraded)) : dim(String(v.degraded));
    console.log(`    ${model.padEnd(26)} ${flag} / ${v.ok}`);
  }
  console.log();
}

function corpus(write: boolean, json: boolean): number {
  const result = buildCorpus({ write });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  const degraded = result.records.filter((r) => r.outcome === "degraded");
  const ok = result.records.filter((r) => r.outcome === "ok");
  const catchable = degraded.filter((r) => r.observedPaths.length > 0);

  console.log(bold("\nBehavior divergence corpus\n"));
  console.log(`  transcripts scanned : ${result.scanned}`);
  console.log(`  plan-exit records   : ${result.records.length}`);
  console.log(`  ${green("plan found")}          : ${ok.length}`);
  console.log(`  ${yellow("degraded (no plan)")}  : ${degraded.length}`);
  console.log(`  of those, a hook would have fired on ${catchable.length}\n`);

  printByModel(result.records);

  if (result.outputPath) console.log(dim(`  appended to ${result.outputPath}\n`));
  else if (write) console.log(dim("  nothing to write (no records found)\n"));
  else console.log(dim("  pass --write to append these records to the divergence log\n"));
  return 0;
}

/* ───────────── telemetry ───────────── */

/**
 * Flip `hooks.telemetry.enabled` in the global config, preserving every other
 * key byte-for-byte. A RAW read-modify-write, deliberately not
 * `saveConfig(loadConfig())`: `loadConfig` merges through an allow-list, so any
 * key it does not enumerate would be dropped on save.
 */
function setTelemetryEnabled(value: boolean): void {
  // The ACTIVE global config: with `--config` / `CLAUDISH_CONFIG` that is the
  // override, which is also the file `loadConfig` reads back below.
  const path = activeConfigFile();
  let cfg: Record<string, unknown> = {};
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        cfg = parsed as Record<string, unknown>;
      }
    }
  } catch {
    // Garbled file → start from empty rather than crash. Matches readRawConfig.
  }
  const hooks =
    cfg.hooks && typeof cfg.hooks === "object" && !Array.isArray(cfg.hooks)
      ? { ...(cfg.hooks as Record<string, unknown>) }
      : {};
  hooks.telemetry = { enabled: value };
  cfg.hooks = hooks;
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");
}

/**
 * Show — and change — the behaviour-telemetry opt-in. It states the retention
 * period and the never-send list up front, because consent to something
 * unstated is not consent.
 */
function telemetry(action: "status" | "enable" | "disable", json: boolean): number {
  if (action !== "status") setTelemetryEnabled(action === "enable");

  const on = parseHooksConfig(loadConfig().hooks, () => {}).telemetry?.enabled === true;
  // Reports are spooled at exit and delivered by a LATER run, so a non-zero
  // count is normal rather than a symptom.
  let pending = 0;
  try {
    const path = outboxPath();
    if (existsSync(path)) pending = readFileSync(path, "utf8").split("\n").filter(Boolean).length;
  } catch {
    // An unreadable outbox is not worth failing a status command over.
  }

  if (json) {
    console.log(JSON.stringify({ enabled: on, pendingReports: pending }, null, 2));
    return 0;
  }

  console.log(bold("\nBehavior telemetry\n"));
  console.log(`  status  : ${on ? green("enabled") : dim("disabled")}`);
  console.log(`  pending : ${pending} session report(s) awaiting delivery\n`);

  if (!on) {
    console.log("  Opting in shares which models violate Claude Code conventions,");
    console.log("  so hooks can be written for models we cannot test ourselves.\n");
    console.log(dim("  Sent    : model, provider, built-in hook id, tool name, decision counts,"));
    console.log(dim("            a coarse context bucket, and categorical path relations"));
    console.log(dim("  Never   : your own hook ids, MCP tool names on their rows, file paths,"));
    console.log(dim("            argument values, prompts, code, model output, credentials,"));
    console.log(dim("            or repo/branch/project names"));
    console.log(dim("  Session : identified by a salted hash, unlinkable across sessions"));
    console.log(dim("  Kept    : 12 months, then non-identifying weekly aggregates only\n"));
    console.log(`  Enable with ${bold("claudish hooks telemetry --enable")}\n`);
    return 0;
  }

  console.log(dim("  Local journalling is always on and unaffected by this setting.\n"));
  console.log(`  Disable with ${bold("claudish hooks telemetry --disable")}\n`);
  return 0;
}

/* ───────────── dispatch ───────────── */

const USAGE = `Usage:
  claudish hooks list      [--json]
  claudish hooks check     <file> [--json]
  claudish hooks init      [dir]
  claudish hooks corpus    [--write] [--json]
  claudish hooks telemetry [--enable | --disable] [--json]
`;

/** Run `claudish hooks <action>`. Returns the process exit code. */
export async function hooksCommand(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  const positional = argv.filter((a) => !a.startsWith("-"));
  const action = positional[0] ?? "list";

  switch (action) {
    case "list":
      return list(json);
    case "check":
      return check(positional[1], json);
    case "init":
      return init(positional[1]);
    case "corpus":
      return corpus(argv.includes("--write"), json);
    case "telemetry":
      return telemetry(
        argv.includes("--enable") ? "enable" : argv.includes("--disable") ? "disable" : "status",
        json
      );
    default:
      console.error(`Unknown action "${action}".\n\n${USAGE}`);
      return 1;
  }
}
