/**
 * Launch-shape conformance canary: boot one Claude Code binary in a headless magmux pane once per
 * spawn shape claudish uses (and once per boot dialog it must recognise), and assert what claudish's
 * own screen classifier and session-registry reader read. No credentials, no model call, no prompt,
 * no dialog ever answered.
 *
 * Why (ai-docs/reports/pane-ui-independent-signals.md): the `--agent` label in the input box's top
 * rule broke every agent slot, though every Claude Code from 2.1.288 drew it. The fixtures never
 * booted a valid agent. This boots each shape against each new release, on macOS and Linux.
 *
 * Usage:
 *   bun scripts/boot-canary.ts [--bin <claude binary>] [--scenarios a,b] [--expect <json>] [--out <dir>]
 * Exit 0 when every scenario reads as expected, 1 on any mismatch, 2 on a usage error.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CLAUDISH_PLACEHOLDER_API_KEY,
  CLAUDISH_PLACEHOLDER_AUTH_TOKEN,
  buildClaudishSettingsOverlay,
} from "../packages/cli/src/claude-runner.js";
import { MagmuxClient } from "../packages/cli/src/pane/magmux-client.js";
import {
  agentRejectedLine,
  readBoot,
  screenText,
} from "../packages/cli/src/pane/screen-classifier.js";
import {
  type ScreenState,
  applyFrame,
  emptyScreen,
} from "../packages/cli/src/pane/screen-model.js";
import { SessionRegistry } from "../packages/cli/src/pane/session-registry.js";

const SCENARIOS = [
  "boot",
  "agent",
  "badagent",
  "onboarding",
  "trust",
  "apikey",
  "bypass",
  "mcp",
  "settingserr",
  "nokey",
] as const;
type Scenario = (typeof SCENARIOS)[number];

/** What one boot read as. `boot` is `repl`, `booting`, `dialog:<name>`, `choice` or `exited`. */
interface Reading {
  boot: string;
  agentRejected: boolean;
  /** the registry record's status, `absent` when no live record matched the session id */
  registry: string;
}

const MAX_MS = 25_000;
/** A boot is read once the screen has been static this long (the logo animates for ~10 s). */
const QUIET_MS = 4_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function usage(msg: string): never {
  console.error(`boot-canary: ${msg}`);
  process.exit(2);
}

function claudeBinary(): string {
  const given = arg("--bin");
  if (given) return resolve(given);
  try {
    return execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
  } catch {
    usage("no --bin and no `claude` on PATH");
  }
}

function shapeFor(
  scenario: Scenario,
  version: string,
  cwd: string
): {
  args: string[];
  env: Record<string, string>;
  claudeJson: Record<string, unknown>;
  overlay: Record<string, unknown>;
} {
  const statusLine = { type: "command", command: "printf 'canary'", padding: 0 };
  // claudish's own overlay for a proxied pane child, so the canary tracks it
  const overlay = buildClaudishSettingsOverlay(statusLine, true, true);
  const claudeJson: Record<string, unknown> = {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: version,
    numStartups: 5,
    projects: {
      [cwd]: {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
        allowedTools: [],
      },
    },
    customApiKeyResponses: { approved: [CLAUDISH_PLACEHOLDER_API_KEY.slice(-20)], rejected: [] },
  };
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
    ANTHROPIC_API_KEY: CLAUDISH_PLACEHOLDER_API_KEY,
    ANTHROPIC_AUTH_TOKEN: CLAUDISH_PLACEHOLDER_AUTH_TOKEN,
  };
  const args = [
    "--model",
    "haiku",
    "--dangerously-skip-permissions",
    "--session-id",
    crypto.randomUUID(),
  ];
  const mcpJson = JSON.stringify({
    mcpServers: { canary: { command: "/usr/bin/true", args: [] } },
  });
  switch (scenario) {
    case "boot":
      break;
    case "agent":
      args.push("--agent", "Explore");
      break;
    case "badagent":
      args.push("--agent", "zzz-not-a-real-agent");
      break;
    case "onboarding":
      delete claudeJson.hasCompletedOnboarding;
      delete claudeJson.lastOnboardingVersion;
      break;
    case "trust":
      claudeJson.projects = {};
      break;
    case "apikey":
      delete claudeJson.customApiKeyResponses;
      break;
    case "bypass":
      delete overlay.skipDangerousModePermissionPrompt;
      break;
    case "mcp":
      writeFileSync(join(cwd, ".mcp.json"), mcpJson);
      break;
    case "settingserr":
      mkdirSync(join(cwd, ".claude"), { recursive: true });
      writeFileSync(
        join(cwd, ".claude", "settings.json"),
        '{"permissions": {"allow": "not-an-array"}, "hooks": 7}'
      );
      break;
    case "nokey":
      for (const k of Object.keys(env)) delete env[k];
      delete overlay.forceLoginMethod;
      break;
  }
  return { args, env, claudeJson, overlay };
}

async function runScenario(
  scenario: Scenario,
  bin: string,
  version: string,
  sockDir: string,
  outDir: string
): Promise<Reading> {
  const world = join(sockDir, `w-${scenario}`);
  rmSync(world, { recursive: true, force: true });
  const cfg = join(world, "cfg");
  mkdirSync(cfg, { recursive: true });
  mkdirSync(join(world, "cwd"), { recursive: true });
  const cwd = realpathSync(join(world, "cwd"));
  const shape = shapeFor(scenario, version, cwd);
  writeFileSync(join(cfg, ".claude.json"), JSON.stringify(shape.claudeJson, null, 2));
  const overlayPath = join(world, "overlay.json");
  writeFileSync(overlayPath, JSON.stringify(shape.overlay));
  // magmux treats a `-e` string that names claude specially: go through a wrapper
  const wrapper = join(world, "pane.sh");
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec "$CANARY_BIN" --settings "$CANARY_SETTINGS" ${shape.args.map((a) => `'${a}'`).join(" ")}\n`
  );
  chmodSync(wrapper, 0o755);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(CLAUDE|MAGMUX_|ANTHROPIC_)/.test(k)) continue;
    if (k === "TERM_PROGRAM" || k === "ENABLE_IDE_INTEGRATION") continue;
    env[k] = v;
  }
  Object.assign(env, shape.env, {
    COLUMNS: "160",
    LINES: "50",
    CLAUDE_CONFIG_DIR: cfg,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    CANARY_BIN: bin,
    CANARY_SETTINGS: overlayPath,
  });

  const id = `canary-${scenario}`;
  const sessionId = shape.args[shape.args.indexOf("--session-id") + 1] as string;
  const registry = new SessionRegistry({ configDir: cfg, sessionUuid: sessionId });
  let mm: ChildProcess | null = null;
  let client: MagmuxClient | null = null;
  let screen: ScreenState = emptyScreen(160, 50);
  let exited = false;
  let registryStatus = "absent";
  let scrollback = "";
  const t0 = Date.now();
  try {
    mm = spawn(
      "magmux",
      ["--headless", "--no-status", "--id", id, "--sock-dir", sockDir, "-e", wrapper],
      {
        cwd,
        env,
        stdio: "ignore",
        detached: true,
      }
    );
    client = await MagmuxClient.connect(join(sockDir, `magmux-${id}.sock`), { timeoutMs: 10_000 });
    let lastChange = 0;
    client.on("frame", (f) => {
      const prev = screen.seq;
      screen = applyFrame(screen, f);
      if (screen.seq !== prev) lastChange = Date.now();
    });
    client.on("exit", () => {
      exited = true;
    });
    await client.request({ type: "watch", pane: 0, mode: "frames", fps: 10 });
    while (Date.now() - t0 < MAX_MS) {
      await Bun.sleep(100);
      const rec = registry.read();
      if (rec) registryStatus = rec.status ?? "no-status";
      if (exited) break;
      if (lastChange && Date.now() - lastChange >= QUIET_MS) break;
    }
    // a child that exits in ~0.3 s (a rejected --agent) is gone before its first frame;
    // its last words are in the dead pane's scrollback
    if (exited) {
      await Bun.sleep(300);
      const cap = await client.request<{ text?: string }>(
        { type: "capture", pane: 0, offset: 200 },
        2000
      );
      if (cap.ok) scrollback = cap.result.text ?? "";
    }
  } finally {
    try {
      await client?.request({ type: "close_pane", pane: 0, force: true }, 2000);
    } catch {
      /* the pane may already be gone */
    }
    client?.close();
    try {
      if (mm?.pid) process.kill(-mm.pid, "SIGTERM");
    } catch {
      /* already exited */
    }
  }
  const text = `${screenText(screen)}\n${scrollback}`;
  const b = readBoot(screen);
  const reading: Reading = {
    boot:
      exited && b.kind === "booting" ? "exited" : b.kind === "dialog" ? `dialog:${b.name}` : b.kind,
    agentRejected: agentRejectedLine(text) !== null,
    registry: registryStatus,
  };
  writeFileSync(join(outDir, `${scenario}.screen.txt`), `${screen.lines.join("\n")}\n`);
  rmSync(world, { recursive: true, force: true });
  return reading;
}

async function main(): Promise<void> {
  const bin = claudeBinary();
  const version =
    execFileSync(bin, ["--version"], { encoding: "utf8" }).trim().split(/\s/)[0] ?? "unknown";
  const wanted = (arg("--scenarios") ?? SCENARIOS.join(",")).split(",").map((s) => s.trim());
  for (const s of wanted) if (!SCENARIOS.includes(s as Scenario)) usage(`unknown scenario ${s}`);
  const expectPath = arg("--expect") ?? join(import.meta.dir, "boot-canary.expect.json");
  const expected = JSON.parse(readFileSync(expectPath, "utf8")) as Record<string, Partial<Reading>>;
  const outDir = resolve(arg("--out") ?? "canary-out");
  mkdirSync(outDir, { recursive: true });
  // macOS caps a socket path at 104 bytes: a short directory under /tmp, never $TMPDIR
  const sockDir = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "ccanary-"));

  console.log(`boot-canary: Claude Code ${version} (${bin})`);
  const results: Record<string, Reading & { ok: boolean }> = {};
  let failed = 0;
  try {
    for (const s of wanted as Scenario[]) {
      const r = await runScenario(s, bin, version, sockDir, outDir);
      const want = expected[s] ?? {};
      const ok = (Object.keys(want) as (keyof Reading)[]).every((k) => want[k] === r[k]);
      if (!ok) failed++;
      results[s] = { ...r, ok };
      console.log(
        `${ok ? "ok  " : "FAIL"} ${s.padEnd(12)} boot=${r.boot} registry=${r.registry}` +
          `${r.agentRejected ? " agent-rejected" : ""}${ok ? "" : `  expected ${JSON.stringify(want)}`}`
      );
    }
  } finally {
    rmSync(sockDir, { recursive: true, force: true });
  }
  writeFileSync(join(outDir, "results.json"), `${JSON.stringify({ version, results }, null, 2)}\n`);
  if (failed) {
    console.log(`boot-canary: ${failed} scenario(s) read differently from ${expectPath}`);
    process.exit(1);
  }
}

await main();
