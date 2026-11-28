import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "boot-canary.ts");

import { armHandoff, policySourcesReading } from "./boot-canary.plugin-probe.js";

describe("the host creds file writer", () => {
  /** How long a reader of the pipe may wait for its writer before it is killed. */
  const READER_TIMEOUT_MS = 5_000;

  function pipeDir() {
    return mkdtempSync(join(tmpdir(), "canary-handoff-"));
  }

  /**
   * A stand-in shell that exits at once with `code`, writing nothing into the pipe: a redirection
   * error, or a writer killed. Its last command before the exit creates `<shell>.ran`, so a test
   * can wait for it to have run instead of for a fixed time.
   */
  function failingShell(dir: string, code: number): { shell: string; ran: string } {
    const shell = join(dir, `shell-exit-${code}`);
    const ran = `${shell}.ran`;
    writeFileSync(shell, `#!/bin/sh\n: > ${JSON.stringify(ran)}\nexit ${code}\n`, { mode: 0o755 });
    return { shell, ran };
  }

  /**
   * A stand-in shell that creates the writer's `.written` marker (its last argument) without
   * a reader, waits `pauseSeconds`, then exits with `code`: a writer paused, or failing, after
   * its marker.
   */
  function markerShell(dir: string, code: number, pauseSeconds: number): string {
    const shell = join(dir, `shell-marker-exit-${code}`);
    writeFileSync(
      shell,
      `#!/bin/sh\nfor last in "$@"; do :; done\n: > "$last"\nsleep ${pauseSeconds}\nexit ${code}\n`,
      { mode: 0o755 }
    );
    return shell;
  }

  /** How long a stand-in shell may take to start on a loaded machine. */
  const START_WAIT_MS = 10_000;

  /** Waits for `path` to exist, up to `ms`. */
  async function appeared(path: string, ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while (!existsSync(path) && Date.now() < until) await Bun.sleep(10);
    return existsSync(path);
  }

  test("a reader that takes the whole handoff reads read", async () => {
    const dir = pipeDir();
    try {
      const pipe = join(dir, "creds.pipe");
      const check = armHandoff(pipe);
      // a writer that exits before opening the pipe leaves `cat` blocked on its open: the
      // timeout kills it, and the test fails on the signal instead of hanging
      const got = spawnSync("/bin/cat", [pipe], {
        env: { PATH: "/usr/bin:/bin" },
        encoding: "utf8",
        timeout: READER_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
      expect(got.signal).toBeNull();
      expect(got.stdout).toContain("ANTHROPIC_AUTH_TOKEN");
      expect(await check()).toBe("read");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no reader reads unread", async () => {
    const dir = pipeDir();
    try {
      expect(await armHandoff(join(dir, "creds.pipe"))()).toBe("unread");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(
    "a writer that exits without writing reads writer_failed, whatever its exit code",
    async () => {
      const dir = pipeDir();
      try {
        for (const code of [0, 1, 2]) {
          const { shell, ran } = failingShell(dir, code);
          const check = armHandoff(join(dir, "creds.pipe"), shell);
          // on a loaded machine the stand-in can take longer than the check's exit grace to start
          expect(await appeared(ran, START_WAIT_MS)).toBe(true);
          expect(await check()).toBe("writer_failed");
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      // three stand-ins, each with its own start wait, past Bun's 5 s default
    },
    3 * START_WAIT_MS + 5_000
  );

  test(
    "a writer paused after its marker reads read once it exits 0",
    async () => {
      const dir = pipeDir();
      try {
        const pipe = join(dir, "creds.pipe");
        const check = armHandoff(pipe, markerShell(dir, 0, 1));
        expect(await appeared(`${pipe}.written`, START_WAIT_MS)).toBe(true);
        expect(await check()).toBe("read");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    START_WAIT_MS + 15_000
  );

  test(
    "a marker that appears between the last check and the kill reads read",
    async () => {
      const dir = pipeDir();
      try {
        const pipe = join(dir, "creds.pipe");
        const shell = join(dir, "shell-blocked");
        const ran = `${shell}.ran`;
        writeFileSync(shell, `#!/bin/sh\n: > ${JSON.stringify(ran)}\nexec sleep 30\n`, {
          mode: 0o755,
        });
        // the kill stands in for the race: the writer finishes its marker just before the signal
        const check = armHandoff(pipe, shell, (writer) => {
          writeFileSync(`${pipe}.written`, "");
          writer.kill("SIGKILL");
        });
        expect(await appeared(ran, START_WAIT_MS)).toBe(true);
        expect(await check()).toBe("read");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    START_WAIT_MS + 5_000
  );

  test(
    "a writer that exits non-zero after its marker reads writer_failed",
    async () => {
      const dir = pipeDir();
      try {
        const pipe = join(dir, "creds.pipe");
        const check = armHandoff(pipe, markerShell(dir, 3, 0));
        expect(await appeared(`${pipe}.written`, START_WAIT_MS)).toBe(true);
        expect(await check()).toBe("writer_failed");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    START_WAIT_MS + 15_000
  );
});

/** Runs the canary with a binary that does not exist: a usage error must leave before it is read. */
function canary(...args: string[]): { status: number | null; stderr: string; outMade: boolean } {
  const dir = mkdtempSync(join(tmpdir(), "canary-usage-"));
  const out = join(dir, "out");
  try {
    const run = spawnSync(
      process.execPath,
      [SCRIPT, "--bin", join(dir, "no-such-claude"), "--out", out, ...args],
      { encoding: "utf8", env: process.env }
    );
    return { status: run.status, stderr: run.stderr, outMade: existsSync(out) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a run that fails leaves no report and no screen of an earlier run", () => {
  const dir = mkdtempSync(join(tmpdir(), "canary-stale-"));
  const out = join(dir, "out");
  const report = join(out, "results.json");
  // a scenario this run does not name: its screen is of an earlier run too
  const screen = join(out, "agent.screen.txt");
  const other = join(out, "notes.txt");
  try {
    mkdirSync(out);
    writeFileSync(report, '{"version":"0.0.0","results":{}}\n');
    writeFileSync(screen, "an earlier screen\n");
    writeFileSync(other, "not a file of the canary\n");
    const run = spawnSync(
      process.execPath,
      [SCRIPT, "--bin", join(dir, "no-such-claude"), "--out", out, "--scenarios", "boot"],
      { encoding: "utf8", env: process.env }
    );
    expect(run.status).not.toBe(0);
    expect(existsSync(report)).toBe(false);
    expect(existsSync(screen)).toBe(false);
    expect(existsSync(other)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a usage error keeps the report and the screens of an earlier run", () => {
  const dir = mkdtempSync(join(tmpdir(), "canary-kept-"));
  const out = join(dir, "out");
  const report = join(out, "results.json");
  const screen = join(out, "boot.screen.txt");
  try {
    mkdirSync(out);
    writeFileSync(report, '{"version":"0.0.0","results":{}}\n');
    writeFileSync(screen, "an earlier screen\n");
    // `--bin` is the last flag read, and it has no value
    const run = spawnSync(
      process.execPath,
      [SCRIPT, "--out", out, "--scenarios", "boot", "--bin"],
      {
        encoding: "utf8",
        env: process.env,
      }
    );
    expect(run.stderr).toContain("--bin needs a value");
    expect(run.status).toBe(2);
    expect(existsSync(report)).toBe(true);
    expect(existsSync(screen)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A stand-in `claude` for the `pluginprobe` scenario, never Claude Code: it answers `--version`,
 * and otherwise prints an init event listing the installed plugins of `CLAUDE_CONFIG_DIR`, the
 * synthetic answer and a successful result with `num_turns: 0`, and exits 0. The result text
 * follows the prompt, as Claude Code 2.1.332's does: `/effort` prints its usage line, and `/cost`
 * prints the subscription line when `CLAUDE_CONFIG_DIR` holds a `.credentials.json` with a
 * `claudeAiOauth` login, else the cost table.
 * `othereffort` answers `/effort` with other text, as a Claude Code whose `/effort` changed would;
 * `nologin` never reads the login file, as a Claude Code that stored its login elsewhere would.
 * `model` instead posts to `/v1/messages` and prints a real assistant event; `noplugins` prints
 * an init event with no `plugins` field; `wrongpath` lists each plugin at another path; `hang`
 * prints the init event and then nothing until it is killed; `fatal` prints the init event and
 * an error result, and exits 1; `turn` ends on a result with `num_turns: 1`; `userenv` first
 * sends a request to the user settings' `env` base URL, as a Claude Code whose user `env` beat
 * the flag `env` would; `helper` first runs the project settings' `apiKeyHelper`;
 * `errorthenok` prints an error result before the successful one; `tworesults` prints the
 * successful result twice; `resultfirst` prints a successful result before init too;
 * `holdstdout` leaves a child holding stdout open (its pid in `holder.pid`) and exits 0;
 * `holddetached` does the same with a child in a session of its own, out of reach of a group
 * kill (pids appended to `detached.pids`); `errorzero` ends on an `error_during_execution`
 * result with `num_turns: 0` and no `is_error`; `startuphelpers` first runs the user settings'
 * `proxyAuthHelper` when `CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER` is set and its
 * `otelHeadersHelper` when `CLAUDE_CODE_ENABLE_TELEMETRY` is, as Claude Code does at boot.
 * Every mode but `nohandoff` reads the file `CLAUDE_CODE_HOST_CREDS_FILE` names when the
 * host-managed marker is set, as 2.1.332's `REr()` does at init; `costcrash` exits 3 with no
 * output when the prompt is `/cost` under the marker. Every mode first connects to the unix
 * socket `ANTHROPIC_UNIX_SOCKET` names, when it is set, as an Anthropic API request would, and
 * to the one `CLAUDE_CODE_RUNNER_MODEL_SOCKET` names, as a runner's model request would.
 * A successful result carries `subtype: "success"`, as Claude Code's does.
 *
 * The wrapper file is the binary the canary reads its Claude Code strings from: it holds the
 * policy source names and provider switches of `bundle` (default {@link BUNDLE_STRINGS}).
 */
type FakeMode =
  | "ok"
  | "model"
  | "noplugins"
  | "wrongpath"
  | "hang"
  | "fatal"
  | "turn"
  | "userenv"
  | "helper"
  | "errorthenok"
  | "tworesults"
  | "resultfirst"
  | "holdstdout"
  | "holddetached"
  | "errorzero"
  | "startuphelpers"
  | "othereffort"
  | "nologin"
  | "markerlogin"
  | "userinterface"
  | "userapikey"
  | "nohandoff"
  | "costcrash"
  | "probeleak";

/** 2.1.332's list of command-valued settings (`Nrd`), as its binary spells it. */
const COMMAND_SETTINGS_LITERAL =
  'var Nrd=["apiKeyHelper","awsAuthRefresh","awsCredentialExport","fileSuggestion","gcpAuthRefresh","otelHeadersHelper","processWrapper","policyHelpers","proxyAuthHelper","statusLine","subagentStatusLine"],';

/** The strings the canary looks for in a Claude Code binary, as 2.1.332 carries them. */
const BUNDLE_STRINGS = [
  '"managed-settings.json"',
  '"managed-settings.d"',
  '"managed-mcp.json"',
  '"com.anthropic.claudecode"',
  '"remote-settings.json"',
  '"hybrid-settings"',
  COMMAND_SETTINGS_LITERAL,
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_USE_COWORK_PLUGINS",
  "CLAUDE_CODE_USE_CCR_V2",
  "CLAUDE_CODE_USE_NATIVE_FILE_SEARCH",
  "CLAUDE_CODE_USE_POWERSHELL_TOOL",
  "CLAUDE_CODE_USE_",
];

function fakeClaude(dir: string, mode: FakeMode, bundle: string[] = BUNDLE_STRINGS): string {
  const script = join(dir, `fake-claude-${mode}.js`);
  writeFileSync(
    script,
    `const fs = require("fs"), path = require("path"), cp = require("child_process");
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("9.9.9 (Claude Code)\\n"); process.exit(0); }
const file = path.join(process.env.CLAUDE_CONFIG_DIR, "plugins", "installed_plugins.json");
const installed = JSON.parse(fs.readFileSync(file, "utf8")).plugins;
const mode = ${JSON.stringify(mode)};
// 2.1.332's launch modes: safe mode loads no installed plugin, and restricted mode reads no user,
// project or local settings, so nothing they enable loads. \`probeleak\` ignores both under the
// host-managed marker, as a probe that lost them would.
const on = (key) => ["1", "true"].includes(process.env[key] ?? "") &&
  !(mode === "probeleak" && process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST);
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; } };
const enabled = on("CLAUDE_CODE_RESTRICTED") ? {} : {
  ...readJson(path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json")).enabledPlugins,
  ...readJson(path.join(process.cwd(), ".claude", "settings.json")).enabledPlugins,
};
const plugins = on("CLAUDE_CODE_SAFE_MODE") ? [] : Object.entries(installed)
  .filter(([id]) => enabled[id] === true)
  .map(([id, rows]) => ({
    name: id.split("@")[0], path: rows[0].installPath, source: id, version: rows[0].version,
  }));
if (mode === "wrongpath") for (const p of plugins) p.path += "-elsewhere";
const print = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
const exit = (code) => process.stdout.write("", () => process.exit(code));
const prompt = args[args.indexOf("-p") + 1];
const loginFile = path.join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json");
// 2.1.332 keeps the credential store off limits under the host-managed marker
const storeOffLimits = Boolean(process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST) && mode !== "markerlogin";
const marked = Boolean(process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST);
if (mode === "costcrash" && marked && prompt === "/cost") process.exit(3);
// 2.1.332's REr(): under the marker, the host creds file is read at init
if (mode !== "nohandoff" && marked && process.env.CLAUDE_CODE_HOST_CREDS_FILE) {
  try { fs.readFileSync(process.env.CLAUDE_CODE_HOST_CREDS_FILE); } catch {}
}
const subscribed = mode !== "nologin" && !storeOffLimits && fs.existsSync(loginFile) &&
  Boolean(JSON.parse(fs.readFileSync(loginFile, "utf8")).claudeAiOauth);
const answer = prompt === "/effort"
  ? (mode === "othereffort" ? "Set effort to high" : "Usage: /effort <low|medium|high|auto>")
  : prompt === "/cost"
    ? (subscribed ? "You are currently using your subscription to power your Claude Code usage" : "Estimated cost:        $0.0000")
    : "";
(async () => {
  for (const socket of [process.env.ANTHROPIC_UNIX_SOCKET, process.env.CLAUDE_CODE_RUNNER_MODEL_SOCKET]) {
    if (!socket) continue;
    await new Promise((settle) => {
      const s = require("net").connect(socket);
      s.on("connect", () => { s.end(); settle(); });
      s.on("error", () => settle());
    });
  }
  if (mode === "userenv") {
    const user = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8"));
    try { await fetch(user.env.ANTHROPIC_BASE_URL + "/api/hello"); } catch {}
  }
  if (mode === "helper") {
    const project = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".claude", "settings.json"), "utf8"));
    cp.execFileSync(project.apiKeyHelper);
  }
  if (mode === "userinterface") {
    const user = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8"));
    if (user.statusLine) cp.execFileSync(user.statusLine.command);
  }
  if (mode === "userapikey") {
    const user = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8"));
    if (user.apiKeyHelper) cp.execFileSync(user.apiKeyHelper);
  }
  if (mode === "startuphelpers") {
    const user = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8"));
    if (process.env.CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER) cp.execFileSync(user.proxyAuthHelper);
    if (process.env.CLAUDE_CODE_ENABLE_TELEMETRY) cp.execFileSync(user.otelHeadersHelper);
  }
  const ok = { type: "result", subtype: "success", is_error: false, num_turns: 0 };
  if (mode === "resultfirst") print(ok);
  print({ type: "system", subtype: "init", ...(mode === "noplugins" ? {} : { plugins }) });
  if (mode === "hang") return setInterval(() => {}, 1000);
  if (mode === "errorthenok") print({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0 });
  if (mode === "tworesults") print(ok);
  if (mode === "holdstdout") {
    const holder = cp.spawn("/bin/sleep", ["60"], { stdio: ["ignore", "inherit", "ignore"] });
    fs.writeFileSync(path.join(${JSON.stringify(dir)}, "holder.pid"), String(holder.pid));
    holder.unref();
  }
  if (mode === "holddetached") {
    const holder = cp.spawn("/bin/sleep", ["60"], { stdio: ["ignore", "inherit", "ignore"], detached: true });
    fs.appendFileSync(path.join(${JSON.stringify(dir)}, "detached.pids"), holder.pid + "\\n");
    holder.unref();
  }
  if (mode === "errorzero") {
    print({ type: "result", subtype: "error_during_execution", num_turns: 0 });
    return exit(0);
  }
  if (mode === "fatal") {
    print({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0 });
    return exit(1);
  }
  if (mode === "model") {
    try { await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST", body: "{}" }); } catch {}
    print({ type: "assistant", message: { model: "claude-fake" } });
  } else {
    print({ type: "assistant", message: { model: "<synthetic>" } });
  }
  print({ ...ok, num_turns: mode === "turn" ? 1 : 0, total_cost_usd: 0, result: answer });
  exit(0);
})();
`
  );
  const bin = join(dir, `fake-claude-${mode}`);
  writeFileSync(
    bin,
    `#!/bin/sh\n# ${bundle.join(" ")}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
    {
      mode: 0o755,
    }
  );
  return bin;
}

describe("the policy source names, against the binary's version", () => {
  /** Every name claudish checks is present except `absent`. */
  const holdsAllBut =
    (...absent: string[]) =>
    (name: string) =>
      !absent.includes(name);

  test("a name missing from a binary older than its first version reads known, and says so", () => {
    const { reading, notYet } = policySourcesReading(holdsAllBut("hybrid-settings"), "2.1.296");
    expect(reading).toBe("known");
    expect(notYet).toEqual(["hybrid-settings: not yet in 2.1.296"]);
  });

  test("a name missing from the binary at its first version reads missing", () => {
    const { reading } = policySourcesReading(holdsAllBut("hybrid-settings"), "2.1.332");
    expect(reading).toBe("missing:hybrid-settings");
  });

  test("a name missing from a binary newer than its first version reads missing", () => {
    expect(policySourcesReading(holdsAllBut("hybrid-settings"), "2.1.400").reading).toBe(
      "missing:hybrid-settings"
    );
    expect(policySourcesReading(holdsAllBut("hybrid-settings"), "2.2.0").reading).toBe(
      "missing:hybrid-settings"
    );
    expect(policySourcesReading(holdsAllBut("remote-settings.json"), "2.1.296").reading).toBe(
      "missing:remote-settings.json"
    );
  });

  test("a binary version that is not x.y.z reads unreadable", () => {
    for (const version of ["unknown", "2.1", "2.1.x", ""]) {
      expect(policySourcesReading(holdsAllBut(), version).reading).toBe("unreadable");
    }
  });
});

describe("the pluginprobe scenario, on a stand-in claude", () => {
  function runProbe(mode: FakeMode, bundle?: string[]) {
    const dir = mkdtempSync(join(tmpdir(), "canary-probe-"));
    const out = join(dir, "out");
    const detachedPids: number[] = [];
    const readDetached = () => {
      const file = join(dir, "detached.pids");
      if (!existsSync(file)) return;
      for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
        detachedPids.push(Number(line));
      }
    };
    try {
      const run = spawnSync(
        process.execPath,
        [
          SCRIPT,
          "--bin",
          fakeClaude(dir, mode, bundle),
          "--out",
          out,
          "--scenarios",
          "pluginprobe",
        ],
        {
          encoding: "utf8",
          // a stand-in that hangs is killed after 3 s instead of the canary's 10 s and 30 s
          env: { ...process.env, BOOT_CANARY_PROBE_RUN_MS: "3000" },
          timeout: 60_000,
        }
      );
      readDetached();
      const report = JSON.parse(readFileSync(join(out, "results.json"), "utf8")) as {
        results: { pluginprobe: Record<string, unknown> };
      };
      const holder = join(dir, "holder.pid");
      const holderPid = existsSync(holder) ? Number(readFileSync(holder, "utf8")) : undefined;
      return {
        status: run.status,
        stdout: run.stdout,
        reading: report.results.pluginprobe,
        holderPid,
        detachedPids,
      };
    } finally {
      // a detached holder left by `holddetached` is this test's own process: it goes here
      for (const pid of detachedPids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a probe that lists the installed plugin and makes no request reads ok", () => {
    const { status, reading, stdout } = runProbe("ok");
    expect(reading).toEqual({
      boot: "init",
      agentRejected: false,
      registry: "absent",
      probe: "ok",
      plugins: "installed",
      productionRequests: 0,
      modelRequests: 0,
      realTurns: 0,
      sideEffects: "none",
      exit: "0",
      result: "turns:0",
      policySources: "known",
      providerSwitches: "known",
      policyGate: "open",
      answer: "effort-usage",
      login: "subscription",
      probeLogin: "none",
      handoff: "unread",
      handoffControl: "read",
      unixSocket: "unused",
      runnerSocket: "unused",
      commandSettings: "known",
      userHelperGate: "user_command_setting",
      userApiKeyHelper: "not-run probe=ok",
      restrictedMode: "matches",
      safeMode: "refused",
      ok: true,
    });
    expect(stdout).toContain("ok   pluginprobe");
    expect(status).toBe(0);
  }, 60_000);

  test("a probe that lists what the caller's launch mode takes away reads differs", () => {
    const { status, reading } = runProbe("probeleak");
    expect(reading.restrictedMode).toBe(
      "differs:probe=projectonly@modemkt,useronly@modemkt;plain="
    );
    expect(reading.safeMode).toBe("refused");
    expect(reading.ok).toBe(false);
    expect(status).toBe(1);
  }, 60_000);

  test("a model request and a real assistant event turn the scenario red", () => {
    const { status, reading } = runProbe("model");
    expect(reading.probe).toBe("turns");
    expect(reading.modelRequests).toBe(1);
    expect(reading.realTurns).toBe(1);
    expect(reading.ok).toBe(false);
    expect(status).toBe(1);
  }, 60_000);

  test("a plugin listed at a path other than the installed copy turns the scenario red", () => {
    const { status, reading } = runProbe("wrongpath");
    expect(reading.probe).toBe("ok");
    expect(reading.plugins).toBe("absent");
    expect(status).toBe(1);
  }, 60_000);

  test("a probe that prints init and then hangs until killed turns the scenario red", () => {
    const { status, reading } = runProbe("hang");
    expect(reading.probe).toBe("timeout");
    expect(reading.plugins).toBe("absent");
    expect(reading.exit).toBe("killed");
    expect(reading.result).toBe("none");
    expect(status).toBe(1);
  }, 60_000);

  test("a probe that prints init and then a fatal result turns the scenario red", () => {
    const { status, reading } = runProbe("fatal");
    expect(reading.probe).toBe("bad_result");
    expect(reading.exit).toBe("1");
    expect(reading.result).toBe("bad_result");
    expect(status).toBe(1);
  }, 60_000);

  for (const mode of ["errorthenok", "tworesults", "resultfirst"] as const) {
    test(`a ${mode} result sequence that exits 0 turns the scenario red`, () => {
      const { status, reading } = runProbe(mode);
      expect(reading.probe).toBe("bad_result");
      expect(reading.exit).toBe("0");
      expect(reading.result).toBe("bad_result");
      expect(status).toBe(1);
    }, 60_000);
  }

  test("a run that exits while a child holds stdout has that child killed", () => {
    const { reading, holderPid } = runProbe("holdstdout");
    expect(reading.exit).toBe("0");
    expect(holderPid).toBeGreaterThan(0);
    let alive = true;
    try {
      process.kill(holderPid as number, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 60_000);

  test("an error_during_execution result with num_turns 0 and no is_error turns the scenario red", () => {
    const { status, reading } = runProbe("errorzero");
    expect(reading.probe).toBe("bad_result");
    expect(reading.exit).toBe("0");
    expect(reading.result).toBe("bad_result");
    expect(status).toBe(1);
  }, 60_000);

  test("a run whose stdout a detached descendant holds open still settles, as stdout-held", () => {
    const started = Date.now();
    const { status, reading, detachedPids } = runProbe("holddetached");
    expect(detachedPids.length).toBeGreaterThan(0);
    expect(reading.exit).toBe("stdout-held");
    expect(reading.probe).toBe("timeout");
    expect(status).toBe(1);
    // 3 s for the production probe, 3 s + the grace for the full run: far below the holder's 60 s
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);

  test("user startup helpers do not run with their switches in the server environment", () => {
    const { status, reading } = runProbe("startuphelpers");
    expect(reading.sideEffects).toBe("none");
    expect(reading.probe).toBe("ok");
    expect(status).toBe(0);
  }, 60_000);

  test("a binary that lacks a policy source name claudish checks turns the scenario red", () => {
    const { status, reading } = runProbe(
      "ok",
      BUNDLE_STRINGS.filter((s) => s !== '"hybrid-settings"')
    );
    expect(reading.policySources).toBe("missing:hybrid-settings");
    expect(status).toBe(1);
  }, 60_000);

  test("a source name that survives only inside a longer name, or unquoted, turns the scenario red", () => {
    const { status, reading } = runProbe("ok", [
      ...BUNDLE_STRINGS.filter((s) => s !== '"remote-settings.json"'),
      '"new-remote-settings.json"',
      "cache/remote-settings.json.bak",
    ]);
    expect(reading.policySources).toBe("missing:remote-settings.json");
    expect(status).toBe(1);
  }, 60_000);

  test("a binary whose command-valued settings list gains or loses a name, or holds none, turns the scenario red", () => {
    const changed = COMMAND_SETTINGS_LITERAL.replace(
      '"apiKeyHelper",',
      '"apiKeyHelper","newHelper",'
    ).replace('"fileSuggestion",', "");
    const added = runProbe("ok", [
      ...BUNDLE_STRINGS.filter((s) => s !== COMMAND_SETTINGS_LITERAL),
      changed,
    ]);
    expect(added.reading.commandSettings).toBe("unknown:+newHelper,-fileSuggestion");
    expect(added.status).toBe(1);
    const none = runProbe(
      "ok",
      BUNDLE_STRINGS.filter((s) => s !== COMMAND_SETTINGS_LITERAL)
    );
    expect(none.reading.commandSettings).toBe("unreadable");
    expect(none.status).toBe(1);
  }, 120_000);

  test("a user statusLine that runs at a probe boot turns the scenario red", () => {
    const { status, reading } = runProbe("userinterface");
    expect(reading.sideEffects).toBe("helper:user-statusLine");
    expect(status).toBe(1);
  }, 60_000);

  test("a user apiKeyHelper that runs at the direct boot is reported, while claudish's own path starts no probe", () => {
    const { status, reading } = runProbe("userapikey");
    expect(reading.userApiKeyHelper).toBe("ran probe=ok");
    expect(reading.userHelperGate).toBe("user_command_setting");
    expect(reading.sideEffects).toBe("none");
    expect(status).toBe(0);
  }, 60_000);

  test("a binary with a provider switch claudish does not withhold, or without one it does, turns the scenario red", () => {
    const added = runProbe("ok", [...BUNDLE_STRINGS, "CLAUDE_CODE_USE_NEWCLOUD"]);
    expect(added.reading.providerSwitches).toBe("unknown:+CLAUDE_CODE_USE_NEWCLOUD");
    expect(added.status).toBe(1);
    const gone = runProbe(
      "ok",
      BUNDLE_STRINGS.filter((s) => s !== "CLAUDE_CODE_USE_MANTLE")
    );
    expect(gone.reading.providerSwitches).toBe("unknown:-CLAUDE_CODE_USE_MANTLE");
    expect(gone.status).toBe(1);
  }, 120_000);

  test("a result with a turn turns the scenario red", () => {
    const { status, reading } = runProbe("turn");
    expect(reading.probe).toBe("turns");
    expect(reading.exit).toBe("0");
    expect(reading.result).toBe("turns:1");
    expect(status).toBe(1);
  }, 60_000);

  test("an /effort answer other than its usage line turns the scenario red", () => {
    const { status, reading } = runProbe("othereffort");
    expect(reading.probe).toBe("ok");
    expect(reading.answer).toBe("other");
    expect(status).toBe(1);
  }, 60_000);

  test("a world whose subscription login Claude Code does not read turns the scenario red", () => {
    const { status, reading } = runProbe("nologin");
    expect(reading.probe).toBe("ok");
    expect(reading.login).toBe("none");
    expect(status).toBe(1);
  }, 60_000);

  test("a Claude Code that reads the stored login under the host-managed marker turns the scenario red", () => {
    const { status, reading } = runProbe("markerlogin");
    expect(reading.probe).toBe("ok");
    expect(reading.login).toBe("subscription");
    expect(reading.probeLogin).toBe("subscription");
    expect(status).toBe(1);
  }, 60_000);

  test("a /cost boot under the marker that crashes reads unreadable, not none, and turns the scenario red", () => {
    const { status, reading } = runProbe("costcrash");
    expect(reading.probe).toBe("ok");
    expect(reading.login).toBe("subscription");
    expect(reading.probeLogin).toBe("unreadable");
    expect(status).toBe(1);
  }, 60_000);

  test("a Claude Code that never reads the host creds file under the marker turns the scenario red", () => {
    const { status, reading } = runProbe("nohandoff");
    expect(reading.probe).toBe("ok");
    expect(reading.handoff).toBe("unread");
    expect(reading.handoffControl).toBe("unread");
    expect(status).toBe(1);
  }, 60_000);

  test("an init event without a plugins list turns the scenario red", () => {
    const { status, reading } = runProbe("noplugins");
    expect(reading.probe).toBe("plugins_malformed");
    expect(reading.plugins).toBe("absent");
    expect(status).toBe(1);
  }, 60_000);

  test("a request to the user settings' env base URL during the production run turns the scenario red", () => {
    const { status, reading } = runProbe("userenv");
    expect(reading.probe).toBe("ok");
    expect(reading.productionRequests).toBe(1);
    expect(status).toBe(1);
  }, 60_000);

  test("a project apiKeyHelper that runs turns the scenario red", () => {
    const { status, reading } = runProbe("helper");
    expect(reading.sideEffects).toBe("helper:apiKeyHelper");
    expect(status).toBe(1);
  }, 60_000);
});

describe("boot-canary usage errors exit 2 before anything boots", () => {
  test("a scenario named twice", () => {
    const run = canary("--scenarios", "boot,agent,boot", "--jobs", "2");
    expect(run.stderr).toContain("scenario boot is named twice");
    expect(run.status).toBe(2);
    expect(run.outMade).toBe(false);
  });

  test("an unknown scenario", () => {
    const run = canary("--scenarios", "boot,nope");
    expect(run.stderr).toContain("unknown scenario nope");
    expect(run.status).toBe(2);
  });

  test("--jobs with no value", () => {
    const run = canary("--scenarios", "boot", "--jobs");
    expect(run.stderr).toContain("--jobs needs a value");
    expect(run.status).toBe(2);
    expect(run.outMade).toBe(false);
  });

  test("a flag followed by another flag", () => {
    const run = canary("--scenarios", "--jobs", "2");
    expect(run.stderr).toContain("--scenarios needs a value");
    expect(run.status).toBe(2);
  });

  for (const bad of ["0", "1.5"]) {
    test(`--jobs ${bad}`, () => {
      const run = canary("--scenarios", "boot", "--jobs", bad);
      expect(run.stderr).toContain("--jobs takes a whole number, 1 or more");
      expect(run.status).toBe(2);
    });
  }
});
