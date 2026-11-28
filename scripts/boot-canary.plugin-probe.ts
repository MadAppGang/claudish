/**
 * The boot canary's `pluginprobe` check: claudish's plugin probe (packages/cli/src/mcp-session/
 * plugin-probe.ts) run against one Claude Code binary in an isolated config, so a Claude Code
 * release that breaks the probe turns the canary red instead of silently handing a
 * `create_session` child no plugins.
 *
 * The world: a `directory` marketplace `canarymkt` with one plugin, `canary` 1.0.0, installed
 * as a user row at a cache copy, enabled in user settings. The copy carries a `SessionStart`
 * hook and an MCP server that each write a marker file, so a probe that runs plugin hooks or
 * starts plugin MCP servers is seen. The user settings' `env` names a loopback listener as
 * `ANTHROPIC_BASE_URL` with a placeholder key, so a probe whose own closed `env` block lost to a
 * user `env` is seen as a request. The user settings also name a `proxyAuthHelper` and an
 * `otelHeadersHelper`, and the server environment carries the switches that start them at boot
 * (`CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER` with a proxy, `CLAUDE_CODE_ENABLE_TELEMETRY` over
 * OTLP/HTTP), so a probe that keeps either switch runs a marker-writing user helper. They name a
 * `processWrapper`, `statusLine`, `subagentStatusLine` and `fileSuggestion` too, the user
 * command settings claudish's gate admits, so one that runs at a `-p` boot is seen. The config
 * dir holds a `{}` `remote-settings.json`, as an ordinary login leaves it, which claudish's
 * probe gate must admit (`policyGate: open`). The untrusted cwd's project settings define every
 * command-valued setting Claude Code 2.1.332 lists (`apiKeyHelper`, `awsAuthRefresh`, ...),
 * each writing a marker, so a probe that runs one is seen. The config dir also holds a
 * placeholder Claude subscription login (`.credentials.json` with `claudeAiOauth`), which Claude
 * Code reads there when `CLAUDE_CONFIG_DIR` is set (its Keychain item name then carries a hash of
 * the dir, so the Mac's own login is never found), the login a subscription user's machine has.
 * The probe's host-managed marker keeps the credential store off limits, so a production boot
 * must not read it, while a boot without the marker must. The server environment also names a
 * host creds file (`CLAUDE_CODE_HOST_CREDS_FILE`), the launcher handoff 2.1.332's `REr()` reads
 * under the marker and whose `env` can restore `ANTHROPIC_AUTH_TOKEN`: a named pipe holding a
 * placeholder bearer, re-armed before each boot, so a boot that reads it is seen (its writer
 * marks a write that returned; a writer that ends without one reads `writer_failed`). No
 * production boot may read it, and no request may carry its token (`handoff`); a
 * control boot of the production argv with the variable handed back must (`handoffControl`),
 * which proves the binary still reads the handoff. It names `ANTHROPIC_UNIX_SOCKET` too, a unix
 * listener that records every connection: no boot built from the production environment may
 * connect to it (`unixSocket`), and `CLAUDE_CODE_RUNNER_MODEL_SOCKET`, a second such listener
 * (`runnerSocket`). Every boot gets the canary's outbound fence on top of the probe's own
 * environment: outbound attempts go to the closed `HTTPS_PROXY` port and reach no one.
 *
 * Three boots, all against the listener, which answers 400 to everything and records each
 * request:
 * 1. `spawnPluginProbe` with claudish's own argv (`pluginProbeArgs`) and environment
 *    (`pluginProbeEnv`, closed base URL): it must answer `ok` with the installed copy in its
 *    list, the listener must see no request at all, and no helper may have run.
 * 2. The same argv run to its exit with the listener and the placeholder key in the probe's own
 *    `env`, so a turn would reach it, and the cwd's settings files removed (with a key, Claude
 *    Code may run `apiKeyHelper`; the production probe never has one): exit 0 within the run's
 *    deadline, init first and then exactly one `result` event with `subtype: "success"`,
 *    `is_error: false` and `num_turns: 0` (the production rule), no `/v1/messages` request, no
 *    assistant event other than `/effort`'s synthetic one, and the result text must be
 *    `/effort`'s usage line, so a Claude Code whose `/effort` turns into a turn, a picker or a
 *    setter turns the canary red. When the run exits, its whole process group is killed, so a
 *    child still holding its stdout goes too; a descendant outside the group that holds stdout
 *    reads as `exit: stdout-held` once the run's deadline and a grace pass.
 * 3. The production argv with `-p /cost` in place of the probe prompt, twice: without the
 *    host-managed marker its answer must be the subscription line (`login`), which proves the
 *    world's placeholder login is readable, the subscription branch that made `/cost` take 8 to
 *    9 s on a real machine (here it is fast: no transcripts, and the usage fetch fails at the
 *    closed proxy); with the production environment, marker included, it must not be
 *    (`probeLogin`). That second boot counts only when it ended with init, one successful
 *    result and exit 0; a boot that crashed or printed nothing reads `unreadable`.
 *
 * After all three: no marker, no transcript.
 *
 * 4. A fourth world: the user settings gain an `apiKeyHelper`, lose the two switch-gated helpers,
 *    and the server environment carries no switch. `inheritedPluginsFor` must start no probe
 *    there (`userHelperGate: user_command_setting`); a direct `spawnPluginProbe` of the
 *    production argv then shows whether that boot runs the helper (`userApiKeyHelper`, reported
 *    and not compared).
 *
 * 5. A fifth world, apart from the others: a marketplace with two plugins, one enabled in the
 *    user settings and one enabled only in the caller folder's project settings. For each of
 *    `CLAUDE_CODE_RESTRICTED=1` and `CLAUDE_CODE_SAFE_MODE=1`, `inheritedPluginsFor` runs with
 *    the switch in the caller's launch environment only (the server environment holds none, as
 *    Claude Code withholds both from what it starts). Under `CLAUDE_CODE_RESTRICTED` the caller
 *    probe's plugin list must be exactly a plain `-p` boot's in the caller folder under the same
 *    switch (`restrictedMode: matches`). Under `CLAUDE_CODE_SAFE_MODE` claudish must start no
 *    probe and answer `caller_mode_unmodelled` (`safeMode: refused`): on 2.1.332 safe mode keeps
 *    the init list (the summary shows the plain boot's list unchanged, measured) while running
 *    none of those plugins' commands or skills. The world runs only when boot 1 answered `ok`;
 *    otherwise both read `skipped:probe=<cause>`.
 *
 * The binary itself is read for the names claudish's checks depend on: every managed policy
 * source name the probe's gate looks for, each as a whole quoted string (`policySources`), its
 * `CLAUDE_CODE_USE_*` names, whose provider switches must be exactly the ones the probe withholds
 * (`providerSwitches`), and its command-valued settings list, which must equal claudish's
 * (`commandSettings`). A renamed source, a new or dropped provider switch, or a command setting
 * added or gone turns the canary red. A wholly new policy source under a new name is not seen
 * this way.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { managedPolicySourcePresent } from "../packages/cli/src/mcp-session/inherited-settings.js";
import {
  COMMAND_SETTINGS,
  PLUGIN_PROBE_TIMEOUT_MS,
  PROBE_HOST_CREDS_FILE_VAR,
  PROBE_HOST_MANAGED_MARKER,
  PROBE_PROVIDER_SWITCHES,
  type PluginProbeRequest,
  inheritedPluginsFor,
  pluginProbeArgs,
  pluginProbeEnv,
  pluginProbeSettings,
  spawnPluginProbe,
} from "../packages/cli/src/mcp-session/plugin-probe.js";

/** What the check read. Every field is compared with `boot-canary.expect.json`. */
export interface PluginProbeReading {
  /** `init` when the full run printed its init event, else `no-init` */
  boot: string;
  agentRejected: boolean;
  registry: string;
  /** `spawnPluginProbe`'s answer: `ok` or its fail-closed cause */
  probe: string;
  /** `installed` when the probe listed the installed copy at its path, else `absent` */
  plugins: string;
  /** requests of any kind the listener saw while `spawnPluginProbe` ran */
  productionRequests: number;
  /** requests to `/v1/messages` (or below it) the listener saw during the full run */
  modelRequests: number;
  /** assistant events other than `/effort`'s synthetic answer */
  realTurns: number;
  /** `effort-usage` when the full run's result text is `/effort`'s usage line, else `other` */
  answer: string;
  /**
   * `subscription` when the `/cost` boot without the host-managed marker answered with the
   * subscription line (Claude Code read the world's placeholder login), else `none`
   */
  login: string;
  /**
   * the same reading for the `/cost` boot with the production argv and environment, marker
   * included: `none` when the probe reads no stored login, `unreadable` when that boot did not
   * end with init, one successful result and exit 0
   */
  probeLogin: string;
  /**
   * `unread` when no boot built from the production environment read the world's host creds
   * file and no request carried its token, `read:<boots>` naming the boots whose reader took
   * the writer's whole write, `token-sent`, or `writer_failed:<boots>` naming the boots whose
   * writer ended without a write that returned (the reading then proves nothing)
   */
  handoff: string;
  /**
   * the control boot's {@link HandoffOutcome} (the production argv, the creds file variable
   * handed back): `read` when it took the writer's whole write, `unread`, or `writer_failed`
   */
  handoffControl: string;
  /**
   * `unused` when no boot built from the production environment connected to the unix socket
   * the server environment names as `ANTHROPIC_UNIX_SOCKET`, else `connected:<count>`
   */
  unixSocket: string;
  /**
   * `unused` when no boot built from the production environment connected to the unix socket
   * the server environment names as `CLAUDE_CODE_RUNNER_MODEL_SOCKET`, else `connected:<count>`
   */
  runnerSocket: string;
  /**
   * markers and transcripts the boots left: `none`, or a comma list of `hook`, `mcp`,
   * `helper:<setting>` (a project command-valued setting ran) and `transcript`
   */
  sideEffects: string;
  /**
   * the full run's exit code, `killed` when it ran past its deadline, `signal:<name>`, or
   * `stdout-held` when its stdout was still open a grace after the deadline
   */
  exit: string;
  /**
   * the full run's result events, by the production rule: `turns:<num_turns>` for init and
   * then exactly one result with `subtype: "success"` and `is_error: false`, `bad_result` for a
   * result before init, a second one or one that is not that success, `none` for no result
   */
  result: string;
  /**
   * `known`, `missing:<names>` (the policy source names the binary does not hold, each at or
   * above its first version), or `unreadable` (the binary or its version could not be read)
   */
  policySources: string;
  /** `known`, or `unknown:+<new>,-<gone>`: the binary's provider switches against the list */
  providerSwitches: string;
  /**
   * `open` when claudish's probe gate admits the world's config dir (its empty
   * `remote-settings.json`, as an ordinary login leaves it), else `present`
   */
  policyGate: string;
  /**
   * `known`, `unknown:+<new>,-<gone>` (the binary's command-valued settings list against
   * claudish's), or `unreadable` when the binary holds no one such list
   */
  commandSettings: string;
  /**
   * `inheritedPluginsFor`'s outcome in the fourth world (a user `apiKeyHelper`, no startup
   * helper switch): `user_command_setting`, or the outcome it answered instead
   */
  userHelperGate: string;
  /**
   * reported, not compared: whether a direct `spawnPluginProbe` of the production argv in that
   * world ran the user `apiKeyHelper` (`ran`, `not-run`), with the probe's outcome
   */
  userApiKeyHelper: string;
  /**
   * the fifth world under `CLAUDE_CODE_RESTRICTED=1` in the caller's launch environment
   * ({@link ModeReading}): `matches` when the caller probe listed exactly what a plain boot
   * under the switch lists
   */
  restrictedMode: string;
  /**
   * the fifth world under `CLAUDE_CODE_SAFE_MODE=1` in the caller's launch environment:
   * `refused` when `inheritedPluginsFor` started no probe and answered `caller_mode_unmodelled`,
   * else `not-refused:<outcome>:<probes started>`
   */
  safeMode: string;
}

/**
 * The managed policy source names claudish's plugin probe gate looks for, as Claude Code
 * 2.1.332 spells them in its binary, each with the first Claude Code version measured to hold
 * it (`null`: held by every version the canary has booted, 2.1.296 included). Each must appear
 * as a whole quoted string (`"…"`, `'…'` or a template literal), so a renamed
 * `new-remote-settings.json` does not pass for `remote-settings.json`.
 */
const POLICY_SOURCE_NAMES: readonly { name: string; since: string | null }[] = [
  { name: "managed-settings.json", since: null },
  { name: "managed-settings.d", since: null },
  { name: "managed-mcp.json", since: null },
  { name: "com.anthropic.claudecode", since: null },
  { name: "remote-settings.json", since: null },
  { name: "hybrid-settings", since: "2.1.332" },
];

/** `x.y.z` as three numbers, or null for anything else. */
function versionParts(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whether `a` is lower than `b`, compared numerically part by part. */
function versionBelow(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] as number) < (b[i] as number);
  }
  return false;
}

/**
 * {@link PluginProbeReading.policySources} for a binary at `version` whose bytes hold a name
 * when `holds` says so: a name is required only from its first version on, so one missing from
 * an older binary reads known and is listed in `notYet` (`<name>: not yet in <version>`). A
 * version that is not `x.y.z` reads `unreadable`.
 */
export function policySourcesReading(
  holds: (name: string) => boolean,
  version: string
): { reading: string; notYet: string[] } {
  const binary = versionParts(version);
  if (binary === null) return { reading: "unreadable", notYet: [] };
  const missing: string[] = [];
  const notYet: string[] = [];
  for (const { name, since } of POLICY_SOURCE_NAMES) {
    if (holds(name)) continue;
    const first = since === null ? null : versionParts(since);
    if (first !== null && versionBelow(binary, first))
      notYet.push(`${name}: not yet in ${version}`);
    else missing.push(name);
  }
  return { reading: missing.length > 0 ? `missing:${missing.join(",")}` : "known", notYet };
}

/**
 * Claude Code 2.1.332's `CLAUDE_CODE_USE_*` names that are not provider switches: a plugin
 * source, a remote-session transport, a search backend, a tool.
 */
const NON_PROVIDER_USE_NAMES = [
  "CLAUDE_CODE_USE_COWORK_PLUGINS",
  "CLAUDE_CODE_USE_CCR_V2",
  "CLAUDE_CODE_USE_NATIVE_FILE_SEARCH",
  "CLAUDE_CODE_USE_POWERSHELL_TOOL",
];

/** Every `CLAUDE_CODE_USE_<NAME>` in `bytes` (the bare prefix, with no name, left out). */
function useNamesIn(bytes: Buffer): Set<string> {
  const prefix = Buffer.from("CLAUDE_CODE_USE_");
  const names = new Set<string>();
  const isNameByte = (b: number | undefined) =>
    b !== undefined && ((b >= 0x41 && b <= 0x5a) || (b >= 0x30 && b <= 0x39) || b === 0x5f);
  for (let at = bytes.indexOf(prefix); at >= 0; at = bytes.indexOf(prefix, at + 1)) {
    let end = at + prefix.length;
    while (isNameByte(bytes[end])) end++;
    if (end > at + prefix.length) names.add(bytes.toString("latin1", at, end));
  }
  return names;
}

/** Whether `bytes` hold `name` as a whole string literal, in any of JavaScript's quotes. */
function holdsQuoted(bytes: Buffer, name: string): boolean {
  return ['"', "'", "`"].some((q) => bytes.includes(`${q}${name}${q}`));
}

/** `+<new>` then `-<gone>` of `found` against `known`, each sorted. */
function listDiff(found: readonly string[], known: readonly string[]): string[] {
  const added = found.filter((n) => !known.includes(n)).sort();
  const gone = known.filter((n) => !found.includes(n)).sort();
  return [...added.map((n) => `+${n}`), ...gone.map((n) => `-${n}`)];
}

/** One array literal of quoted setting names, e.g. `["apiKeyHelper","statusLine"]`. */
const NAME_ARRAY = /^\[("[A-Za-z][A-Za-z0-9]*",)*"[A-Za-z][A-Za-z0-9]*"\]$/;

/**
 * The binary's list of command-valued settings (2.1.332's `Nrd`): the distinct array literals of
 * quoted names holding `"apiKeyHelper"`, `"statusLine"` and `"proxyAuthHelper"`. Null unless
 * exactly one such list exists.
 */
function commandSettingsIn(bytes: Buffer): string[] | null {
  const anchor = Buffer.from('"apiKeyHelper"');
  const lists = new Set<string>();
  for (let at = bytes.indexOf(anchor); at >= 0; at = bytes.indexOf(anchor, at + 1)) {
    const open = bytes.lastIndexOf(0x5b, at);
    const close = bytes.indexOf(0x5d, at);
    if (open < 0 || close < 0 || at - open > 4096 || close - at > 4096) continue;
    const literal = bytes.toString("latin1", open, close + 1);
    if (!NAME_ARRAY.test(literal)) continue;
    const names = JSON.parse(literal) as string[];
    if (names.includes("statusLine") && names.includes("proxyAuthHelper")) lists.add(literal);
  }
  if (lists.size !== 1) return null;
  return JSON.parse([...lists][0] as string) as string[];
}

/**
 * {@link PluginProbeReading.policySources}, `providerSwitches` and `commandSettings` of the
 * binary at `bin`.
 */
function bundleNames(
  bin: string,
  version: string
): {
  policySources: string;
  policySourcesNotYet: string[];
  providerSwitches: string;
  commandSettings: string;
} {
  let bytes: Buffer;
  try {
    bytes = readFileSync(realpathSync(bin));
  } catch {
    return {
      policySources: "unreadable",
      policySourcesNotYet: [],
      providerSwitches: "unreadable",
      commandSettings: "unreadable",
    };
  }
  const sources = policySourcesReading((name) => holdsQuoted(bytes, name), version);
  const switches = [...useNamesIn(bytes)].filter((n) => !NON_PROVIDER_USE_NAMES.includes(n));
  const diff = listDiff(switches, PROBE_PROVIDER_SWITCHES);
  const commands = commandSettingsIn(bytes);
  const commandDiff = commands ? listDiff(commands, COMMAND_SETTINGS) : [];
  return {
    policySources: sources.reading,
    policySourcesNotYet: sources.notYet,
    providerSwitches: diff.length > 0 ? `unknown:${diff.join(",")}` : "known",
    commandSettings:
      commands === null
        ? "unreadable"
        : commandDiff.length > 0
          ? `unknown:${commandDiff.join(",")}`
          : "known",
  };
}

/**
 * The canary's own tests' override of both deadlines (`BOOT_CANARY_PROBE_RUN_MS`): a stand-in
 * that hangs would otherwise cost 10 s and 30 s.
 */
function deadlineOverride(): number | undefined {
  const override = Number(process.env.BOOT_CANARY_PROBE_RUN_MS);
  return Number.isFinite(override) && override > 0 ? override : undefined;
}

/** How long the full run may take to exit. */
function fullRunMs(): number {
  return deadlineOverride() ?? 30_000;
}

/**
 * The server environment's switches that start a user helper at boot in Claude Code 2.1.332:
 * `CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER` with a proxy runs `proxyAuthHelper`, and telemetry over
 * OTLP/HTTP prefetches `otelHeadersHelper`. The probe must withhold both switches; the user
 * settings name both helpers, each writing a marker.
 */
const STARTUP_HELPER_SWITCHES: Record<string, string> = {
  CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER: "1",
  HTTPS_PROXY: "http://127.0.0.1:9",
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  OTEL_METRICS_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9",
};

/**
 * Added by the canary on top of the probe's own environment, never part of it: an outbound
 * request goes to a closed proxy port and reaches no one, and the boot never updates itself.
 * Neither decides which plugins load.
 */
const CANARY_OUTBOUND_FENCE: Record<string, string> = {
  HTTPS_PROXY: "http://127.0.0.1:9",
  DISABLE_AUTOUPDATER: "1",
};

/** A key no endpoint accepts; it only lets a turn reach the loopback listener. */
const CANARY_PLACEHOLDER_KEY = "sk-ant-boot-canary-placeholder-not-a-key";

/** The bearer the world's host creds file hands over; no endpoint accepts it. */
const HANDOFF_PLACEHOLDER_TOKEN = "sk-ant-boot-canary-handoff-placeholder-not-a-token";

/** How long after a boot settles its creds file writer may still be reporting its exit. */
const HANDOFF_EXIT_GRACE_MS = 200;

/** How long a writer that has created its marker may take to exit before it is killed. */
const HANDOFF_MARKED_EXIT_MS = 5_000;

/**
 * What one boot did with the world's host creds file: `read` when the writer's write into the
 * pipe returned (a reader took the handoff) and the writer then exited 0, or its marker first
 * showed only after the kill of a writer still running, `unread` when the
 * writer was still waiting for a reader, `writer_failed` when the writer ended without a write
 * that returned (a redirection error, a broken pipe, a writer that could not start), or ended
 * other than with 0 after its marker, or did not exit within {@link HANDOFF_MARKED_EXIT_MS}
 * of it.
 */
export type HandoffOutcome = "read" | "unread" | "writer_failed";

/** The `handoff` reading of the production boots, from what each boot did with the creds file. */
function handoffReadingOf(reads: string[], tokenSent: boolean, writerFailures: string[]): string {
  if (reads.length > 0) return `read:${reads.join(",")}`;
  if (tokenSent) return "token-sent";
  if (writerFailures.length > 0) return `writer_failed:${writerFailures.join(",")}`;
  return "unread";
}

/**
 * Arms the world's host creds file at `path` for one boot: a named pipe, mode 0600 as 2.1.332's
 * `h()` requires, whose writer (`shell`, blocked on the open until a reader comes) holds the
 * handoff `h()` accepts: an `env` with {@link HANDOFF_PLACEHOLDER_TOKEN} as
 * `ANTHROPIC_AUTH_TOKEN`, no expiry, and this live process as its launcher. The writer creates
 * `<path>.written` only once its write has returned, so an exit alone never reads as `read`;
 * nor does the marker alone: `read` also needs the writer's exit 0 after it, which the check
 * waits for. The returned check, called once the boot has settled, kills a writer still waiting
 * (`kill`, SIGKILL by default), removes the pipe and the marker, and answers the
 * {@link HandoffOutcome}. A marker first seen after that kill was made before it: the write had
 * returned, so the boot read the handoff.
 */
export function armHandoff(
  path: string,
  shell = "/bin/sh",
  kill: (writer: ChildProcess) => void = (writer) => writer.kill("SIGKILL")
): () => Promise<HandoffOutcome> {
  const written = `${path}.written`;
  rmSync(path, { force: true });
  rmSync(written, { force: true });
  const made = spawnSync("/usr/bin/mkfifo", ["-m", "600", path]);
  if (made.status !== 0) throw new Error(`mkfifo ${path} failed: ${String(made.stderr)}`);
  const payload = JSON.stringify({
    env: { ANTHROPIC_AUTH_TOKEN: HANDOFF_PLACEHOLDER_TOKEN },
    expiresAt: null,
    pid: process.pid,
    procStart: Math.round(performance.timeOrigin),
  });
  const writer = spawn(
    shell,
    ["-c", 'printf %s "$1" > "$2" && : > "$3"', "sh", payload, path, written],
    { stdio: "ignore" }
  );
  let ended = false;
  let failedToStart = false;
  let exitCode: number | null = null;
  const exited = new Promise<void>((settle) => {
    writer.on("exit", (code) => {
      ended = true;
      exitCode = code;
      settle();
    });
    writer.on("error", () => {
      ended = true;
      failedToStart = true;
      settle();
    });
  });
  return async () => {
    await Promise.race([exited, Bun.sleep(HANDOFF_EXIT_GRACE_MS)]);
    // a writer past its marker is only finishing: wait for its exit, bounded
    const markedBeforeKill = existsSync(written);
    if (!ended && markedBeforeKill) {
      await Promise.race([exited, Bun.sleep(HANDOFF_MARKED_EXIT_MS)]);
    }
    const waiting = !ended;
    if (waiting) {
      kill(writer);
      await exited;
    }
    const marked = !failedToStart && existsSync(written);
    rmSync(path, { force: true });
    rmSync(written, { force: true });
    if (marked && !waiting && exitCode === 0) return "read";
    // the marker appeared between the check above and the kill: the write had returned
    if (marked && waiting && !markedBeforeKill) return "read";
    if (marked) return "writer_failed";
    return waiting ? "unread" : "writer_failed";
  };
}

/**
 * A Claude subscription login no endpoint accepts, in the shape Claude Code 2.1.332 stores in
 * `<config dir>/.credentials.json`. The expiry is a year ahead, so no boot tries a refresh.
 */
function placeholderSubscriptionLogin(): unknown {
  return {
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-boot-canary-placeholder-not-a-token",
      refreshToken: "sk-ant-ort01-boot-canary-placeholder-not-a-token",
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    },
  };
}

/** `/effort`'s usage line with no argument: its levels, `auto`, and maybe `ultracode`. */
const EFFORT_USAGE = /^Usage: \/effort <[^\n]*\|auto[^\n]*>$/;

/** `/cost`'s (`/usage`'s) first line on a Claude subscription login. */
const SUBSCRIPTION_USAGE_LINE = "You are currently using your subscription";

/**
 * The command-valued settings of Claude Code 2.1.332 (its `Nrd` list) that take a command or
 * script path as a string, and those that take `{type: "command", command}`.
 */
const HELPER_SETTINGS = [
  "apiKeyHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "gcpAuthRefresh",
  "otelHeadersHelper",
  "proxyAuthHelper",
  "processWrapper",
];
const COMMAND_OBJECT_SETTINGS = ["statusLine", "subagentStatusLine", "fileSuggestion"];

/** The interactive interface's command settings, set in the world's user settings too. */
const USER_INTERFACE_COMMANDS = COMMAND_OBJECT_SETTINGS;

/** The marker the fourth world's user `apiKeyHelper` writes, reported apart from `sideEffects`. */
const USER_API_KEY_HELPER_MARKER = "helper-user-apiKeyHelper";

function put(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

/**
 * The untrusted cwd's project settings: every command-valued setting as a script writing
 * `helper-<setting>` into `markers`, and the telemetry and proxy switches some of them wait for.
 */
function writeProjectHelpers(cwd: string, markers: string, scripts: string): void {
  const script = (name: string) => {
    const path = join(scripts, `${name}.sh`);
    put(path, `#!/bin/sh\necho ran > '${join(markers, `helper-${name}`)}'\necho placeholder\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const project: Record<string, unknown> = {};
  for (const name of HELPER_SETTINGS) project[name] = script(name);
  for (const name of COMMAND_OBJECT_SETTINGS) {
    project[name] = { type: "command", command: script(name) };
  }
  project.policyHelpers = { macos: { path: script("policyHelpers") } };
  project.env = {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
  };
  put(join(cwd, ".claude", "settings.json"), project);
  put(join(cwd, ".claude", "settings.local.json"), {
    apiKeyHelper: script("localApiKeyHelper"),
  });
}

/** The isolated world under `world`: config dir, home, cwd, marketplace, cache copy, markers. */
function buildWorld(
  world: string,
  listenerUrl: string
): {
  cfg: string;
  home: string;
  cwd: string;
  copy: string;
  markers: string;
} {
  const cfg = join(world, "cfg");
  const home = join(world, "home");
  const cwd = join(world, "cwd");
  const market = join(world, "market");
  const markers = join(world, "markers");
  const copy = join(cfg, "plugins", "cache", "canarymkt", "canary", "1.0.0");
  for (const dir of [cfg, home, cwd, markers]) mkdirSync(dir, { recursive: true });
  put(join(market, ".claude-plugin", "marketplace.json"), {
    name: "canarymkt",
    owner: { name: "canary" },
    plugins: [{ name: "canary", source: { source: "github", repo: "example-invalid/canary" } }],
  });
  put(join(cfg, "plugins", "known_marketplaces.json"), {
    canarymkt: {
      source: { source: "directory", path: market },
      installLocation: market,
      lastUpdated: "2026-11-01T00:00:00.000Z",
    },
  });
  put(join(copy, ".claude-plugin", "plugin.json"), {
    name: "canary",
    version: "1.0.0",
    description: "boot canary",
  });
  put(join(copy, "agents", "canary-agent.md"), "---\nname: canary-agent\ndescription: x\n---\nx\n");
  put(join(copy, "hooks", "hooks.json"), {
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: `echo hook > '${join(markers, "hook")}'` }] },
      ],
    },
  });
  put(join(copy, ".mcp.json"), {
    mcpServers: {
      canarymcp: { command: "/bin/sh", args: ["-c", `echo mcp > '${join(markers, "mcp")}'`] },
    },
  });
  const stamp = "2026-11-01T00:00:00.000Z";
  put(join(cfg, "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: {
      "canary@canarymkt": [
        {
          scope: "user",
          installPath: copy,
          version: "1.0.0",
          installedAt: stamp,
          lastUpdated: stamp,
        },
      ],
    },
  });
  // A user `env` that would open the probe, were the probe's flag `env` not to outrank it, and
  // the user helpers that the server environment's switches (STARTUP_HELPER_SWITCHES) start at
  // boot. User settings are trusted, so only a withheld switch keeps them from running.
  const userHelper = (name: string) => {
    const path = join(world, "helper-scripts", `user-${name}.sh`);
    put(
      path,
      `#!/bin/sh\necho ran > '${join(markers, `helper-user-${name}`)}'\necho placeholder\n`
    );
    chmodSync(path, 0o755);
    return path;
  };
  // The four command-valued user settings claudish's probe gate admits must not run at a `-p`
  // boot: each writes a marker, so one that runs turns `sideEffects` red.
  put(join(cfg, "settings.json"), {
    enabledPlugins: { "canary@canarymkt": true },
    env: { ANTHROPIC_API_KEY: CANARY_PLACEHOLDER_KEY, ANTHROPIC_BASE_URL: listenerUrl },
    proxyAuthHelper: userHelper("proxyAuthHelper"),
    otelHeadersHelper: userHelper("otelHeadersHelper"),
    processWrapper: userHelper("processWrapper"),
    ...Object.fromEntries(
      USER_INTERFACE_COMMANDS.map((name) => [name, { type: "command", command: userHelper(name) }])
    ),
  });
  // What an ordinary login leaves: an empty server-managed cache, which the probe gate admits.
  put(join(cfg, "remote-settings.json"), "{}");
  put(join(cfg, ".credentials.json"), placeholderSubscriptionLogin());
  chmodSync(join(cfg, ".credentials.json"), 0o600);
  writeProjectHelpers(cwd, markers, join(world, "helper-scripts"));
  put(join(world, "probe-settings.json"), pluginProbeSettings(null));
  return { cfg, home, cwd, copy, markers };
}

/** A transcript Claude Code wrote under `<cfg>/projects`, if any. */
function wroteTranscript(cfg: string): boolean {
  const projects = join(cfg, "projects");
  if (!existsSync(projects)) return false;
  return readdirSync(projects, { recursive: true }).some((f) => String(f).endsWith(".jsonl"));
}

/** How long after {@link fullRunMs} the run settles even with its stdout still open. */
const STDOUT_HOLD_GRACE_MS = 2_000;

/**
 * Runs `bin` with `args` to its exit (its process group killed at {@link fullRunMs}, and again
 * when it exits, so a child of a wrapper still holding stdout goes too), and returns its
 * stdout events and how it ended, once stdout is closed. A descendant that left the group (a
 * new session or group of its own) is out of reach of the group kill and can hold stdout open:
 * {@link STDOUT_HOLD_GRACE_MS} after the run's deadline the run settles anyway, its exit read
 * as `stdout-held` (a red reading), and stdout is let go.
 */
function runToExit(
  bin: string,
  args: string[],
  cwd: string,
  env: Record<string, string>
): Promise<{ events: unknown[]; exit: string }> {
  return new Promise((settle) => {
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
    });
    let killed = false;
    let exited = false;
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      killed = !exited;
      killGroup();
    }, fullRunMs());
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let settled = false;
    const done = (code: number | null, signal: NodeJS.Signals | null, held = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      const events: unknown[] = [];
      for (const line of out.split("\n")) {
        try {
          events.push(JSON.parse(line));
        } catch {
          // not an event
        }
      }
      const exit = held
        ? "stdout-held"
        : killed
          ? "killed"
          : code !== null
            ? String(code)
            : `signal:${signal}`;
      settle({ events, exit });
    };
    const hardTimer = setTimeout(() => {
      killGroup();
      child.stdout?.destroy();
      done(exitCode, exitSignal, true);
    }, fullRunMs() + STDOUT_HOLD_GRACE_MS);
    child.on("error", () => done(null, null));
    child.on("exit", (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      // a wrapper's child may still hold stdout: the group goes, and stdout then closes
      killGroup();
    });
    child.on("close", () => done(exitCode, exitSignal));
  });
}

type Event = {
  type?: unknown;
  subtype?: unknown;
  message?: { model?: unknown };
  is_error?: unknown;
  num_turns?: unknown;
  result?: unknown;
};

/** The text of the last `result` event, or "" when there is none or it carries no text. */
function resultTextOf(events: Event[]): string {
  const last = events.filter((e) => e.type === "result").at(-1);
  return typeof last?.result === "string" ? last.result : "";
}

/** {@link PluginProbeReading.answer} of the full run's events. */
function answerOf(events: Event[]): string {
  return EFFORT_USAGE.test(resultTextOf(events)) ? "effort-usage" : "other";
}

/** {@link PluginProbeReading.login} of the `/cost` run's events. */
function loginOf(events: Event[]): string {
  return resultTextOf(events).startsWith(SUBSCRIPTION_USAGE_LINE) ? "subscription" : "none";
}

/**
 * {@link PluginProbeReading.probeLogin} of the marked `/cost` boot: its login reading only when
 * the boot ended with init, exactly one successful result and exit 0, else `unreadable`. A boot
 * that crashed or printed nothing answers with no subscription line either, and would otherwise
 * read as `none`, the passing value.
 */
function probeLoginOf(run: { events: unknown[]; exit: string }): string {
  const events = run.events as Event[];
  if (run.exit !== "0" || !resultOf(events).startsWith("turns:")) return "unreadable";
  return loginOf(events);
}

/** The result events as {@link PluginProbeReading.result} reads them. */
function resultOf(events: Event[]): string {
  let afterInit = false;
  const results: Event[] = [];
  for (const e of events) {
    if (e.type === "system" && e.subtype === "init") afterInit = true;
    if (e.type !== "result") continue;
    if (!afterInit) return "bad_result";
    results.push(e);
  }
  const [only] = results;
  if (!only) return "none";
  // the production rule: exactly `subtype: "success"` and `is_error: false`
  const success = (e: Event) => e.subtype === "success" && e.is_error === false;
  if (results.length > 1 || !results.every(success)) return "bad_result";
  return `turns:${String(only.num_turns)}`;
}

/**
 * Every marker the boots left but those `except` names, as
 * {@link PluginProbeReading.sideEffects} names them.
 */
function markersIn(markers: string, except: readonly string[] = []): string[] {
  const names = existsSync(markers) ? readdirSync(markers).sort() : [];
  return names
    .filter((name) => !except.includes(name))
    .map((name) => (name.startsWith("helper-") ? `helper:${name.slice(7)}` : name));
}

/**
 * The fourth world's two readings. The user settings gain an `apiKeyHelper` writing
 * {@link USER_API_KEY_HELPER_MARKER}, and `serverEnv` carries no startup helper switch.
 * `inheritedPluginsFor` runs as `createSession` would for a child in the world's cwd with a
 * caller in another folder (its host launch read as a plain `claude` there, the machine's own
 * managed paths never read): it must start no probe and answer `user_command_setting`. Then a
 * direct `spawnPluginProbe` of the production argv and environment shows whether that boot runs
 * the helper; that reading is reported, not compared.
 */
async function userApiKeyHelperCheck(
  bin: string,
  world: string,
  paths: ReturnType<typeof buildWorld>,
  serverEnv: Record<string, string>
): Promise<{ userHelperGate: string; userApiKeyHelper: string }> {
  const { cfg, cwd, markers } = paths;
  const helper = join(world, "helper-scripts", "user-apiKeyHelper.sh");
  put(
    helper,
    `#!/bin/sh\necho ran > '${join(markers, USER_API_KEY_HELPER_MARKER)}'\necho placeholder\n`
  );
  chmodSync(helper, 0o755);
  const userFile = join(cfg, "settings.json");
  const user = JSON.parse(readFileSync(userFile, "utf8")) as Record<string, unknown>;
  // only the apiKeyHelper is new: the switch-gated helpers go, so nothing else can explain a run
  const { proxyAuthHelper: _p, otelHeadersHelper: _o, ...rest } = user;
  put(userFile, { ...rest, apiKeyHelper: helper });

  const callerDir = join(world, "caller");
  mkdirSync(callerDir, { recursive: true });
  const started: PluginProbeRequest[] = [];
  const handover = await inheritedPluginsFor({
    setupReal: realpathSync(callerDir),
    childCwd: cwd,
    layer: null,
    childFlags: [],
    env: serverEnv,
    managed: { remoteSettingsFile: null, hybridSettingsDir: null },
    hostPid: 2,
    // the caller was started with the server's own config dir
    readHostLaunch: () => ({
      argv: ["/usr/local/bin/claude"],
      cwd: realpathSync(callerDir),
      env:
        serverEnv.CLAUDE_CONFIG_DIR === undefined
          ? {}
          : { CLAUDE_CONFIG_DIR: serverEnv.CLAUDE_CONFIG_DIR },
    }),
    policyPlatform: "other",
    runner: async (req) => {
      started.push(req);
      return { ok: false, cause: "spawn_failed" };
    },
  });
  const userHelperGate =
    started.length > 0 ? `probed:${handover?.outcome}` : String(handover?.outcome ?? "none");

  const direct = existsSync(bin)
    ? await spawnPluginProbe({
        cwd,
        args: pluginProbeArgs(join(world, "probe-settings.json"), [], cwd),
        env: { ...pluginProbeEnv(serverEnv), ...CANARY_OUTBOUND_FENCE, CLAUDE_PATH: bin },
        timeoutMs: deadlineOverride() ?? PLUGIN_PROBE_TIMEOUT_MS,
      })
    : ({ ok: false, cause: "no_claude_binary" } as const);
  const ran = existsSync(join(markers, USER_API_KEY_HELPER_MARKER));
  return {
    userHelperGate,
    userApiKeyHelper: `${ran ? "ran" : "not-run"} probe=${direct.ok ? "ok" : direct.cause}`,
  };
}

/**
 * One launch mode switch's reading in the fifth world: `matches` when the caller probe's plugin
 * sources equal a plain boot's under the switch, `differs:probe=<…>;plain=<…>` with both sorted
 * source lists, or `unreadable:<boot>=<cause>` when a boot gave no list.
 */
export type ModeReading = string;

/** A plain `-p` boot's argv: what a caller's own `claude -p /effort` reads, nothing quieter. */
const PLAIN_BOOT_ARGS = [
  "--output-format",
  "stream-json",
  "--verbose",
  "--no-session-persistence",
  "-p",
  "/effort",
];

/** The fifth world's switches, each with the value a caller's launch carries. */
const MODE_SWITCHES = [
  ["restrictedMode", "CLAUDE_CODE_RESTRICTED", "modelled"],
  ["safeMode", "CLAUDE_CODE_SAFE_MODE", "refused"],
] as const;

/** {@link ModeReading} of the plain boot under a switch and the caller probe under it. */
function modeReadingOf(plain: string[] | string, probed: string[] | string): ModeReading {
  if (typeof plain === "string") return `unreadable:plain=${plain}`;
  if (typeof probed === "string") return `unreadable:probe=${probed}`;
  if (probed.join(",") === plain.join(",")) return "matches";
  return `differs:probe=${probed.join(",")};plain=${plain.join(",")}`;
}

/** The sorted sources of a probe's list, or why there is none. */
function sourcesOf(
  result: Awaited<ReturnType<typeof spawnPluginProbe>> | undefined
): string[] | string {
  if (!result) return "not-run";
  if (!result.ok) return result.cause;
  return result.plugins.map((p) => p.source).sort();
}

/**
 * The fifth world under `world/modes`: a `directory` marketplace `modemkt` with `useronly`
 * (enabled in the user settings) and `projectonly` (enabled only in the caller folder's project
 * settings), both installed as user rows. For each {@link MODE_SWITCHES} entry,
 * `inheritedPluginsFor` runs with the switch in the caller's launch environment and none in the
 * server environment, its probes started by `spawnPluginProbe` against `bin`; the caller probe's
 * list is compared with plain boots in the caller folder with and without the switch.
 */
async function launchModeCheck(
  bin: string,
  world: string,
  baseEnv: Record<string, string>
): Promise<{ restrictedMode: ModeReading; safeMode: ModeReading; lines: string[] }> {
  const root = join(world, "modes");
  const cfg = join(root, "cfg");
  const home = join(root, "home");
  const market = join(root, "market");
  for (const dir of [cfg, home]) mkdirSync(dir, { recursive: true });
  const caller = join(root, "caller");
  const child = join(root, "child");
  mkdirSync(caller, { recursive: true });
  mkdirSync(child, { recursive: true });
  const names = ["useronly", "projectonly"];
  put(join(market, ".claude-plugin", "marketplace.json"), {
    name: "modemkt",
    owner: { name: "canary" },
    plugins: names.map((name) => ({
      name,
      source: { source: "github", repo: `example-invalid/${name}` },
    })),
  });
  put(join(cfg, "plugins", "known_marketplaces.json"), {
    modemkt: {
      source: { source: "directory", path: market },
      installLocation: market,
      lastUpdated: "2026-11-01T00:00:00.000Z",
    },
  });
  const stamp = "2026-11-01T00:00:00.000Z";
  const rows: Record<string, unknown[]> = {};
  for (const name of names) {
    const copy = join(cfg, "plugins", "cache", "modemkt", name, "1.0.0");
    put(join(copy, ".claude-plugin", "plugin.json"), {
      name,
      version: "1.0.0",
      description: "boot canary",
    });
    put(
      join(copy, "agents", `${name}-agent.md`),
      `---\nname: ${name}-agent\ndescription: x\n---\nx\n`
    );
    rows[`${name}@modemkt`] = [
      {
        scope: "user",
        installPath: copy,
        version: "1.0.0",
        installedAt: stamp,
        lastUpdated: stamp,
      },
    ];
  }
  put(join(cfg, "plugins", "installed_plugins.json"), { version: 2, plugins: rows });
  put(join(cfg, "settings.json"), { enabledPlugins: { "useronly@modemkt": true } });
  put(join(caller, ".claude", "settings.json"), {
    enabledPlugins: { "projectonly@modemkt": true },
  });
  const callerReal = realpathSync(caller);
  const childReal = realpathSync(child);
  const timeoutMs = deadlineOverride() ?? PLUGIN_PROBE_TIMEOUT_MS;
  const serverEnv = { ...baseEnv, HOME: home, CLAUDE_CONFIG_DIR: cfg };
  const plain = (extra: Record<string, string>) =>
    existsSync(bin)
      ? spawnPluginProbe({
          cwd: callerReal,
          args: PLAIN_BOOT_ARGS,
          env: {
            ...serverEnv,
            ...extra,
            ...CANARY_OUTBOUND_FENCE,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            CLAUDE_PATH: bin,
          },
          timeoutMs,
        })
      : Promise.resolve({ ok: false, cause: "no_claude_binary" } as const);

  const without = sourcesOf(await plain({}));
  const lines = [`plain boot, no switch: ${String(without)}`];
  const readings: Record<string, ModeReading> = {};
  for (const [field, key, expected] of MODE_SWITCHES) {
    const switched = sourcesOf(await plain({ [key]: "1" }));
    const byCwd = new Map<string, Awaited<ReturnType<typeof spawnPluginProbe>>>();
    const handover = await inheritedPluginsFor({
      setupReal: callerReal,
      childCwd: childReal,
      layer: null,
      childFlags: [],
      env: serverEnv,
      managed: { remoteSettingsFile: null, hybridSettingsDir: null },
      hostPid: 2,
      // the caller was started with the switch; the server has none
      readHostLaunch: () => ({
        argv: ["/usr/local/bin/claude"],
        cwd: callerReal,
        env: { CLAUDE_CONFIG_DIR: cfg, [key]: "1" },
      }),
      policyPlatform: "other",
      runner: async (req) => {
        const result = existsSync(bin)
          ? await spawnPluginProbe({
              ...req,
              env: { ...req.env, ...CANARY_OUTBOUND_FENCE, CLAUDE_PATH: bin },
            })
          : ({ ok: false, cause: "no_claude_binary" } as const);
        byCwd.set(req.cwd, result);
        return result;
      },
    });
    const probed = sourcesOf(byCwd.get(callerReal));
    const changed = String(switched) !== String(without) ? "changes" : "does not change";
    lines.push(
      `${key}=1 (${changed} the plain list): plain boot ${String(switched)}; caller probe ${String(probed)} (handover ${handover?.outcome ?? "none"})`
    );
    readings[field] =
      expected === "modelled"
        ? modeReadingOf(switched, probed)
        : handover?.outcome === "caller_mode_unmodelled" && byCwd.size === 0
          ? "refused"
          : `not-refused:${handover?.outcome ?? "none"}:${byCwd.size}`;
  }
  return {
    restrictedMode: readings.restrictedMode ?? "not-run",
    safeMode: readings.safeMode ?? "not-run",
    lines,
  };
}

/**
 * Runs the check in `world` (created and left for the caller to remove) against `bin`, whose
 * `--version` printed `version`, with `baseEnv` as the environment the probe's own is built from. Returns the reading and a text
 * summary for `pluginprobe.screen.txt`.
 */
export async function runPluginProbeCheck(
  bin: string,
  version: string,
  world: string,
  baseEnv: Record<string, string>
): Promise<{ reading: PluginProbeReading; summary: string }> {
  const requests: string[] = [];
  let handoffTokenSent = false;
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      requests.push(`${req.method} ${new URL(req.url).pathname}`);
      for (const [, value] of req.headers) {
        if (value.includes(HANDOFF_PLACEHOLDER_TOKEN)) handoffTokenSent = true;
      }
      return new Response("{}", { status: 400, headers: { "content-type": "application/json" } });
    },
  });
  const listenerUrl = `http://127.0.0.1:${listener.port}`;
  // a unix socket path is capped at 104 bytes on macOS, so it lives in a short temp dir
  const socketDir = mkdtempSync(join(tmpdir(), "canary-sock-"));
  const socketPath = join(socketDir, "anthropic.sock");
  let unixConnections = 0;
  const unixListener = Bun.listen({
    unix: socketPath,
    socket: {
      open(socket) {
        unixConnections++;
        socket.end();
      },
      data() {},
    },
  });
  const runnerSocketPath = join(socketDir, "runner.sock");
  let runnerConnections = 0;
  const runnerListener = Bun.listen({
    unix: runnerSocketPath,
    socket: {
      open(socket) {
        runnerConnections++;
        socket.end();
      },
      data() {},
    },
  });
  let probed: Awaited<ReturnType<typeof spawnPluginProbe>>;
  let productionRequests: string[];
  let productionMarkers: string[];
  let run: { events: unknown[]; exit: string };
  let costRun: { events: unknown[]; exit: string };
  let probeCostRun: { events: unknown[]; exit: string };
  const handoffReads: string[] = [];
  const handoffWriterFailures: string[] = [];
  let handoffControl: HandoffOutcome;
  let paths: ReturnType<typeof buildWorld>;
  let policyGate: string;
  let userHelperGate: string;
  let userApiKeyHelper: string;
  let modes: Awaited<ReturnType<typeof launchModeCheck>>;
  try {
    paths = buildWorld(world, listenerUrl);
    const { cfg, home, cwd } = paths;
    // only the world's own config dir: the machine's managed paths never decide the reading
    const gateSource = managedPolicySourcePresent(
      { remoteSettingsFile: null, hybridSettingsDir: null },
      { CLAUDE_CONFIG_DIR: cfg, HOME: home },
      cwd
    );
    policyGate = gateSource === undefined ? "open" : "present";
    // the settings file a production probe gets with no layer: disableAllHooks and the closed env
    const settingsFile = join(world, "probe-settings.json");
    put(settingsFile, pluginProbeSettings(null));
    const args = pluginProbeArgs(settingsFile, [], cwd);
    const handoffFile = join(world, "host-creds.pipe");
    const env = {
      ...pluginProbeEnv({
        ...baseEnv,
        ...STARTUP_HELPER_SWITCHES,
        [PROBE_HOST_CREDS_FILE_VAR]: handoffFile,
        ANTHROPIC_UNIX_SOCKET: socketPath,
        CLAUDE_CODE_RUNNER_MODEL_SOCKET: runnerSocketPath,
        HOME: home,
        CLAUDE_CONFIG_DIR: cfg,
      }),
      ...CANARY_OUTBOUND_FENCE,
    };
    // each boot below gets a freshly armed creds file; `name` is listed when the boot opened it
    const withHandoff = async <T>(name: string, boot: () => Promise<T>): Promise<T> => {
      const opened = armHandoff(handoffFile);
      try {
        return await boot();
      } finally {
        const outcome = await opened();
        if (outcome === "read") handoffReads.push(name);
        if (outcome === "writer_failed") handoffWriterFailures.push(name);
      }
    };

    // `CLAUDE_PATH` names `bin`; a missing one would send findClaudeBinary to the Mac's own claude
    probed = await withHandoff("probe", async () =>
      existsSync(bin)
        ? await spawnPluginProbe({
            cwd,
            args,
            env: { ...env, CLAUDE_PATH: bin },
            timeoutMs: deadlineOverride() ?? PLUGIN_PROBE_TIMEOUT_MS,
          })
        : ({ ok: false, cause: "no_claude_binary" } as const)
    );
    productionRequests = [...requests];
    requests.length = 0;
    productionMarkers = markersIn(paths.markers);
    // The project helpers pin the production run only. The run below carries a key, and with
    // one Claude Code 2.1.332 ran the local `apiKeyHelper` at a probe boot (measured with the
    // earlier `/cost` prompt, once in two canary runs); the production probe never carries a key.
    rmSync(join(cwd, ".claude"), { recursive: true, force: true });

    // A placeholder key and the listener: without a key a turn stops at "Not logged in"
    // before any request, and an `/effort` that became a model call would go unseen. The
    // production settings file's closed `env` block would override both, so this run's file
    // holds the same settings with the listener and the key in its `env` instead.
    const openEnv = { ANTHROPIC_API_KEY: CANARY_PLACEHOLDER_KEY, ANTHROPIC_BASE_URL: listenerUrl };
    const openSettings = join(world, "probe-settings-listener.json");
    const production = pluginProbeSettings(null);
    put(openSettings, { ...production, env: { ...(production.env as object), ...openEnv } });
    run = await withHandoff("full", () =>
      runToExit(bin, pluginProbeArgs(openSettings, [], cwd), cwd, { ...env, ...openEnv })
    );

    // `/cost` as the prompt, twice. Without the host-managed marker (in the environment and in
    // the settings `env` block), its subscription line proves the world's placeholder login is
    // readable; with the production argv and environment, the marker keeps the credential store
    // off limits, so the same login must not be read.
    const cost = (file: string) => [...pluginProbeArgs(file, [], cwd).slice(0, -1), "/cost"];
    const { [PROBE_HOST_MANAGED_MARKER]: _marker, ...unmarkedEnv } = env;
    const { [PROBE_HOST_MANAGED_MARKER]: _settingsMarker, ...unmarkedSettingsEnv } =
      production.env as Record<string, string>;
    const unmarkedSettings = join(world, "probe-settings-unmarked.json");
    put(unmarkedSettings, { ...production, env: unmarkedSettingsEnv });
    costRun = await withHandoff("cost", () =>
      runToExit(bin, cost(unmarkedSettings), cwd, unmarkedEnv)
    );
    probeCostRun = await withHandoff("probecost", () =>
      runToExit(bin, cost(settingsFile), cwd, env)
    );

    // The control: the production argv and environment with the creds file variable handed
    // back, in the environment and in the settings `env` block. It must open the file, or the
    // `handoff` reading above proves nothing about this binary.
    const { [PROBE_HOST_CREDS_FILE_VAR]: _handoffSetting, ...handoffSettingsEnv } =
      production.env as Record<string, string>;
    const controlSettings = join(world, "probe-settings-handoff.json");
    put(controlSettings, { ...production, env: handoffSettingsEnv });
    const controlOpened = armHandoff(handoffFile);
    await runToExit(
      bin,
      args.map((a) => (a === settingsFile ? controlSettings : a)),
      cwd,
      { ...env, [PROBE_HOST_CREDS_FILE_VAR]: handoffFile }
    );
    handoffControl = await controlOpened();

    // The fourth world: the same, plus a user `apiKeyHelper`, and no startup helper switch in
    // the server environment. claudish's own path must start no probe; a direct boot of the
    // production argv shows whether Claude Code would have run the helper.
    ({ userHelperGate, userApiKeyHelper } = await userApiKeyHelperCheck(bin, world, paths, {
      ...baseEnv,
      HOME: home,
      CLAUDE_CONFIG_DIR: cfg,
    }));

    // The fifth world: the launch mode switches, read from the caller's launch environment. It
    // compares probe lists, so it runs only once the production probe gave one: a binary that
    // already failed it is red, and seven more boots to their deadline would add nothing.
    const skipped = probed.ok ? undefined : `skipped:probe=${probed.cause}`;
    modes = skipped
      ? { restrictedMode: skipped, safeMode: skipped, lines: [] }
      : await launchModeCheck(bin, world, baseEnv);
  } finally {
    listener.stop(true);
    unixListener.stop(true);
    runnerListener.stop(true);
    rmSync(socketDir, { recursive: true, force: true });
  }

  const { cfg, copy, markers } = paths;
  const listed =
    probed.ok && probed.plugins.some((p) => p.source === "canary@canarymkt" && p.path === copy);
  const typed = run.events as Event[];
  const sideEffects = [
    ...markersIn(markers, [USER_API_KEY_HELPER_MARKER]),
    ...(wroteTranscript(cfg) ? ["transcript"] : []),
  ];
  const names = bundleNames(bin, version);
  const reading: PluginProbeReading = {
    boot: typed.some((e) => e.type === "system" && e.subtype === "init") ? "init" : "no-init",
    agentRejected: false,
    registry: "absent",
    probe: probed.ok ? "ok" : probed.cause,
    plugins: listed ? "installed" : "absent",
    productionRequests: productionRequests.length,
    modelRequests: requests.filter((r) => / \/v1\/messages(\/|$)/.test(r)).length,
    realTurns: typed.filter((e) => e.type === "assistant" && e.message?.model !== "<synthetic>")
      .length,
    sideEffects: sideEffects.length > 0 ? sideEffects.join(",") : "none",
    exit: run.exit,
    result: resultOf(typed),
    answer: answerOf(typed),
    login: loginOf(costRun.events as Event[]),
    probeLogin: probeLoginOf(probeCostRun),
    handoff: handoffReadingOf(handoffReads, handoffTokenSent, handoffWriterFailures),
    handoffControl,
    unixSocket: unixConnections > 0 ? `connected:${unixConnections}` : "unused",
    runnerSocket: runnerConnections > 0 ? `connected:${runnerConnections}` : "unused",
    policySources: names.policySources,
    providerSwitches: names.providerSwitches,
    commandSettings: names.commandSettings,
    policyGate,
    userHelperGate,
    userApiKeyHelper,
    restrictedMode: modes.restrictedMode,
    safeMode: modes.safeMode,
  };
  const summary = [
    `probe: ${reading.probe}`,
    `listed: ${probed.ok ? probed.plugins.map((p) => `${p.source} ${p.path}`).join(" | ") : "-"}`,
    `production requests: ${productionRequests.join(", ") || "none"}`,
    `events: ${typed.map((e) => `${String(e.type)}${e.subtype ? `/${String(e.subtype)}` : ""}`).join(" ")}`,
    `requests (full and /cost runs): ${requests.join(", ") || "none"}`,
    `side effects: ${reading.sideEffects} (after the production run: ${productionMarkers.join(",") || "none"})`,
    `exit: ${reading.exit}, result: ${reading.result}, answer: ${JSON.stringify(resultTextOf(typed))}`,
    `/cost run without the marker: exit ${costRun.exit}, login: ${reading.login}; with it: exit ${probeCostRun.exit}, login: ${reading.probeLogin}`,
    `host creds file: ${reading.handoff}; control boot with it handed back: ${reading.handoffControl}`,
    `ANTHROPIC_UNIX_SOCKET listener: ${reading.unixSocket}; CLAUDE_CODE_RUNNER_MODEL_SOCKET listener: ${reading.runnerSocket}`,
    `policy sources: ${reading.policySources}${names.policySourcesNotYet.length > 0 ? ` (${names.policySourcesNotYet.join("; ")})` : ""}, provider switches: ${reading.providerSwitches}, command settings: ${reading.commandSettings}, policy gate: ${reading.policyGate}`,
    `user apiKeyHelper world: claudish's gate ${reading.userHelperGate}; a direct production-argv boot: ${reading.userApiKeyHelper}`,
    `launch mode world: restrictedMode ${reading.restrictedMode}, safeMode ${reading.safeMode}`,
    ...modes.lines.map((line) => `  ${line}`),
  ].join("\n");
  return { reading, summary };
}
