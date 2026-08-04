#!/usr/bin/env bun
/**
 * madbench — full-stack benchmark: real Claude Code → claudish MCP → 3 real models.
 *
 *   bun run madbench                 # desktop 1Password (a human approves prompts)
 *   bun run madbench --verbose       # mirror the session stream live
 *   bun run madbench --models 3      # how many distinct models to require
 *
 * Unattended (CI): set OP_SERVICE_ACCOUNT_TOKEN. Token auth never raises a
 * desktop dialog and bypasses the handshake lock, so the run needs no human.
 *
 * With desktop auth this run WILL raise 1Password approval prompts — one per
 * `createClient()`. The runner says so up front rather than letting dialogs
 * arrive unexplained.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CHECKS } from "./checks.js";
import {
  extractCatalogModels,
  extractClaudishCalls,
  extractFinalText,
  runSession,
} from "./session.js";
import type { AuthMode, BenchObservation, CheckResult } from "./types.js";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const SERVER_ENTRY = resolve(REPO_ROOT, "packages/cli/src/index.ts");
const LOG_ROOT = resolve(REPO_ROOT, "logs/madbench");
const REAL_CONFIG = join(homedir(), ".claudish", "config.json");

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const eq = argv.find((a) => a.startsWith(`--${n}=`));
  if (eq) return eq.slice(n.length + 3);
  const i = argv.indexOf(`--${n}`);
  return i !== -1 ? argv[i + 1] : undefined;
};
const verbose = argv.includes("--verbose");
const requiredModels = Number(flag("models") ?? 3);
const timeoutMs = Number(flag("timeout") ?? 600_000);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = join(LOG_ROOT, stamp);
mkdirSync(RUN_DIR, { recursive: true });
const RUN_LOG = join(RUN_DIR, "run.log");

function log(line: string): void {
  try {
    writeFileSync(RUN_LOG, `${line}\n`, { flag: "a" });
  } catch {
    /* logging must never take the run down */
  }
  process.stdout.write(`${line}\n`);
}

function md5(p: string): string {
  try {
    return createHash("md5").update(readFileSync(p)).digest("hex");
  } catch {
    return "<absent>";
  }
}

/**
 * The task. Deliberately shaped so every assertion is model-agnostic:
 *
 *  - The model roster is NOT pinned. Claude Code is told to consult claudish's
 *    live catalog and pick the newest itself, so the benchmark keeps working
 *    when vendors ship. What is checked is that it picked N distinct REAL ones.
 *  - The question has exactly one correct answer, expressible as digits, so
 *    grading never depends on prose style, verbosity, or a model's willingness
 *    to follow a format instruction.
 */
function buildPrompt(runToken: string, expected: string, n: number): string {
  return [
    "You have a claudish MCP server available. Do this precisely:",
    "",
    "1. Call the claudish `list_models` tool to see what models are available.",
    `2. From that list choose the ${n} NEWEST, most capable models you can find.`,
    `   They must be ${n} genuinely DIFFERENT models, and every model id you use`,
    "   must be one that appeared in the list.",
    `3. For EACH of those ${n} models, call the claudish \`run_prompt\` tool with`,
    "   that model and this exact prompt:",
    `      "What is 17 multiplied by 23? Reply with only the number."`,
    "4. Report a short table of model id and the answer it returned.",
    "",
    `Run token for this benchmark: ${runToken}`,
    `(The correct answer is ${expected}; do not tell the models that.)`,
  ].join("\n");
}

async function main(): Promise<void> {
  const latest = join(LOG_ROOT, "latest");
  try {
    if (existsSync(latest)) unlinkSync(latest);
    symlinkSync(RUN_DIR, latest);
  } catch {
    /* convenience only */
  }

  const authMode: AuthMode = process.env.OP_SERVICE_ACCOUNT_TOKEN ? "service-account" : "desktop";
  const runToken = `MADBENCH-${stamp.slice(0, 19)}`;
  const expectedAnswer = String(17 * 23);

  log("madbench — real Claude Code → claudish MCP → real models");
  log(`run dir:   ${RUN_DIR}`);
  log(`auth mode: ${authMode}`);
  if (authMode === "desktop") {
    log("");
    log("  ⚠  Desktop 1Password auth. This run WILL raise approval prompts — one per");
    log("     SDK client handshake. Stay at the keyboard and approve them, or set");
    log("     OP_SERVICE_ACCOUNT_TOKEN to run unattended.");
    log("");
  }

  // Isolated config, seeded read-only from the real one. The MCP server is
  // spawned via `env -i` with CLAUDISH_CONFIG pointed here, so the real file is
  // never a write target and the run cannot clobber it.
  const real = (() => {
    try {
      return JSON.parse(readFileSync(REAL_CONFIG, "utf-8")) as Record<string, unknown>;
    } catch {
      return {} as Record<string, unknown>;
    }
  })();
  const armConfig: Record<string, unknown> = {
    version: "1.0.0",
    defaultProfile: "default",
    profiles: {},
  };
  if (typeof real.onepasswordAccount === "string") {
    armConfig.onepasswordAccount = real.onepasswordAccount;
  }
  if (Array.isArray(real.onepasswordEnvironments)) {
    armConfig.onepasswordEnvironments = real.onepasswordEnvironments;
  }
  const claudishConfigPath = join(RUN_DIR, "claudish-config.json");
  writeFileSync(claudishConfigPath, JSON.stringify(armConfig, null, 2), "utf-8");

  if (authMode === "desktop" && !armConfig.onepasswordAccount) {
    log("❌ No `onepasswordAccount` in ~/.claudish/config.json and no service-account token.");
    log("   On a multi-account machine the MCP server cannot pick an account without a TTY,");
    log("   so every model would fail to get a key. Set one and re-run.");
    process.exit(2);
  }

  const before = md5(REAL_CONFIG);
  log(`real config md5 before: ${before}`);

  const prompt = buildPrompt(runToken, expectedAnswer, requiredModels);
  writeFileSync(join(RUN_DIR, "prompt.txt"), prompt, "utf-8");
  log(`\n▶ running session (timeout ${Math.round(timeoutMs / 1000)}s)…`);

  const session = await runSession({
    serverEntry: SERVER_ENTRY,
    claudishConfigPath,
    runDir: RUN_DIR,
    prompt,
    timeoutMs,
    authMode,
    cwd: REPO_ROOT,
    verbose,
  });

  const calls = extractClaudishCalls(session.frames);
  const obs: BenchObservation = {
    runToken,
    authMode,
    exitCode: session.exitCode,
    timedOut: session.timedOut,
    durationMs: session.durationMs,
    frames: session.frames,
    ...(session.frames.find((f) => f.type === "system" && f.subtype === "init")
      ? { init: session.frames.find((f) => f.type === "system" && f.subtype === "init") }
      : {}),
    calls,
    catalogModels: extractCatalogModels(calls),
    finalText: extractFinalText(session.frames),
    stdout: session.stdout,
    stderr: session.stderr,
    expectedAnswer,
  };

  writeFileSync(join(RUN_DIR, "stream.jsonl"), session.stdout, "utf-8");
  writeFileSync(join(RUN_DIR, "stderr.log"), session.stderr, "utf-8");
  writeFileSync(join(RUN_DIR, "calls.json"), JSON.stringify(calls, null, 2), "utf-8");

  log(`  session exited ${session.exitCode} in ${Math.round(session.durationMs / 1000)}s`);
  log(`  claudish tool calls: ${calls.length}`);
  for (const c of calls) {
    log(`    - ${c.tool}${c.model ? ` model=${c.model}` : ""}${c.isError ? " [ERROR]" : ""}`);
  }

  const results: CheckResult[] = CHECKS.map((check) => {
    let failures: string[];
    try {
      failures = check.run(obs);
    } catch (err) {
      failures = [`check threw: ${err instanceof Error ? err.message : String(err)}`];
    }
    return {
      id: check.id,
      description: check.description,
      passed: failures.length === 0,
      failures,
    };
  });

  log("");
  for (const r of results) {
    log(
      r.passed ? `  ✅ ${r.id}` : `  ❌ ${r.id}\n${r.failures.map((f) => `       ${f}`).join("\n")}`
    );
  }

  const after = md5(REAL_CONFIG);
  const isolationOk = before === after;
  if (!isolationOk) log(`\n❌ ISOLATION BREACH — real config changed: ${before} → ${after}`);

  const passed = results.filter((r) => r.passed).length;
  writeFileSync(
    join(RUN_DIR, "report.json"),
    JSON.stringify(
      {
        stamp,
        runToken,
        authMode,
        durationMs: session.durationMs,
        exitCode: session.exitCode,
        timedOut: session.timedOut,
        modelsUsed: [...new Set(calls.map((c) => c.model).filter(Boolean))],
        configHash: { before, after },
        results,
      },
      null,
      2
    ),
    "utf-8"
  );

  const modelsUsed = [...new Set(calls.map((c) => c.model).filter(Boolean))];
  writeFileSync(
    join(RUN_DIR, "report.md"),
    `# madbench — ${stamp}

${passed}/${results.length} checks passed · auth \`${authMode}\` · ${Math.round(session.durationMs / 1000)}s

${isolationOk ? `✅ \`~/.claudish/config.json\` unchanged (\`${before}\`)` : `❌ real config CHANGED: \`${before}\` → \`${after}\``}

## Models the agent chose

${modelsUsed.length > 0 ? modelsUsed.map((m) => `- \`${m}\``).join("\n") : "_none_"}

These are not pinned. The prompt asked for the newest models and Claude Code
resolved that against claudish's live catalog, so this list is expected to change
over time. What is asserted is that they are distinct, real, and each returned
${expectedAnswer}.

## Checks

| check | result | notes |
|---|---|---|
${results
  .map(
    (r) =>
      `| \`${r.id}\` | ${r.passed ? "✅ pass" : "❌ FAIL"} | ${r.passed ? r.description : r.failures.join("; ").replace(/\|/g, "\\|")} |`
  )
  .join("\n")}

## Artifacts

\`stream.jsonl\` (full session), \`calls.json\` (claudish calls paired with results),
\`prompt.txt\`, \`mcp-config.json\`, \`claudish-config.json\`, \`stderr.log\`.
`,
    "utf-8"
  );

  log(`\n${passed}/${results.length} checks passed`);
  log(`report: ${join(RUN_DIR, "report.md")}`);
  process.exit(passed === results.length && isolationOk ? 0 : 1);
}

main().catch((err) => {
  log(`madbench crashed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
