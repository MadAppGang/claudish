/**
 * E20 executable parity: the CURRENT built binary against the parent of the Phase 2a
 * commit (v14.4.1, `579114b1`) built with ONLY the test seam backported.
 *
 *   bun ai-docs/benches/account-pool-validation/e20.ts \
 *     --baseline <worktree> --out <dir> [--skip-mutants] [--only <case>]
 *
 * Each case runs the SAME scenario on both binaries: same recording fake, same
 * seed, same request. Both run as `claudish serve` (the direct entry, no Claude
 * Code) under the macOS offline sandbox, so a binary on which the seam is not
 * armed fails to reach a real vendor instead of sending fake tokens there. The
 * seam is proved armed on each binary BEFORE any case (a request must reach the
 * fake); a binary that fails the proof is aborted.
 *
 * Compared: the normalized request(s) at the fake and at the canary (method,
 * path, headers, payload; ids, timestamps and the version string masked, every
 * mask counted in the result) and the client-visible status and body.
 * Four mutants of the CURRENT bundle must each turn their mapped case red.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { killTree } from "./direct.ts";
import {
  type Recorded,
  type ResponsesReply,
  SCRIPTED_400,
  SCRIPTED_500,
  type TokenMode,
  startRecordingCanary,
  startRecordingFake,
} from "./e20-fake.ts";
import {
  FAKE_SECRETS,
  UPSTREAM_EVIDENCE_FILES,
  argProblems,
  clientLeaks,
  e20Verdict,
  headerStabilityDiff,
  outputLeaks,
  refreshRejectedAllReps,
} from "./e20-gate.ts";
import { startEgressSink } from "./egress-sink.ts";
import { type Mutant, emitMutantTree } from "./mutants.ts";
import {
  KNOWN_EGRESS,
  LAUNCHER,
  OFFLINE_PROFILE,
  REPO,
  buildEnv,
  makeRowRoot,
  run,
  sha256File,
} from "./row-env.ts";
import { seedHome } from "./seed.ts";

const SLOT = "claude-sonnet-4-6";
const PROMPT = "Reply with the single word OK.";
const SESSION_ID = "e20-fixed-session";
const ANSWER = "FAKE_ANSWER_OK";
export interface BinaryRef {
  id: string;
  launcher: string;
  /** The tree whose git state is the pin. */
  tree: string;
}

export interface CaseDef {
  id: string;
  doc: string;
  seed: "legacy" | "legacy-expired" | "none";
  responses: ResponsesReply;
  tokenMode: TokenMode;
  /** `compare`: identical or DIFFERENT. `expected-divergence`: recorded, never pass or fail. */
  mode: "compare" | "expected-divergence";
  /** Requests that must reach the metered canary on EVERY binary (null: not asserted). */
  canaryMin: number | null;
  /** The request class that proves the case reached its upstream (else the case is aborted). */
  needs: "responses" | "token" | "canary";
}

export const CASES: CaseDef[] = [
  {
    id: "legacy-ok",
    doc: "V16: codex-oauth.json only, fresh token; /responses answers 200 SSE",
    seed: "legacy",
    responses: { type: "text", text: ANSWER },
    tokenMode: "ok",
    mode: "compare",
    canaryMin: 0,
    needs: "responses",
  },
  {
    id: "legacy-error",
    doc: "V16: same seed; /responses answers 500 server_error (the terminal-error remap)",
    seed: "legacy",
    responses: { type: "status", status: 500, body: SCRIPTED_500 },
    tokenMode: "ok",
    mode: "compare",
    canaryMin: 0,
    needs: "responses",
  },
  {
    id: "legacy-terminal",
    doc: "V16 (added): same seed; /responses answers 400 invalid_request_error, which the terminal-error decision remaps to 400 + upstream_status",
    seed: "legacy",
    responses: { type: "status", status: 400, body: SCRIPTED_400 },
    tokenMode: "ok",
    mode: "compare",
    canaryMin: 0,
    needs: "responses",
  },
  {
    id: "apikey",
    doc: "V16/V17: no pool, no legacy, OPENAI_CODEX_API_KEY is the subject; the canary answers 500",
    seed: "none",
    responses: { type: "text", text: ANSWER },
    tokenMode: "ok",
    mode: "compare",
    canaryMin: 1,
    needs: "canary",
  },
  {
    id: "refresh-rejected",
    doc: "V16: codex-oauth.json with expires_at 1 (long past), token endpoint answers invalid_grant (A2/A4 changed this shape on purpose)",
    seed: "legacy-expired",
    responses: { type: "text", text: ANSWER },
    tokenMode: "invalid_grant",
    mode: "expected-divergence",
    canaryMin: 0,
    needs: "token",
  },
];

/** The four V16 mutants of the CURRENT bundle (rows-contract.md V16), each mapped to its red case. */
export const V16_MUTANTS: Array<Mutant & { redIn: string; stands: string }> = [
  {
    id: "V16-endpoint-path",
    rows: ["V16"],
    redIn: "legacy-ok",
    stands:
      "remove the OAuth endpoint override (kept loopback: the path changes, the host does not)",
    expect: "the legacy request lands on another path at the fake",
    edits: [
      {
        find: `      headers: buildOAuthHeaders(token, accountId),
      endpoint: resolveUpstreamUrl(CODEX_RESPONSES_ENDPOINT),`,
        replace: `      headers: buildOAuthHeaders(token, accountId),
      endpoint: resolveUpstreamUrl(CODEX_RESPONSES_ENDPOINT.replace("/codex/responses", "/codex/mutant")),`,
      },
    ],
  },
  {
    id: "V16-omit-header",
    rows: ["V16"],
    redIn: "legacy-ok",
    stands: "omit an OAuth header in buildOAuthHeaders",
    expect: "the legacy request has no originator header",
    edits: [
      {
        find: `    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    accept: "text/event-stream"
  };
  if (accountId) {`,
        replace: `    "OpenAI-Beta": "responses=experimental",
    accept: "text/event-stream"
  };
  if (accountId) {`,
      },
    ],
  },
  {
    id: "V16-drop-transform",
    rows: ["V16"],
    redIn: "legacy-ok",
    stands: "drop the payload transform (store:false, include)",
    expect: "the legacy payload lacks store:false and include",
    edits: [
      {
        find: 'return { ...p, store: false, include: ["reasoning.encrypted_content"] };',
        replace: "return p;",
      },
    ],
  },
  {
    // Supplementary, NOT one of the four: the single-site drop above is DEAD because
    // the request builder (`codexExtras`) already puts store:false and include in the
    // base payload, so the credential's transform is redundant. This one drops both
    // layers to show that the payload comparison itself can fail.
    id: "V16-drop-transform-both-layers",
    rows: ["V16"],
    redIn: "legacy-ok",
    stands:
      "SUPPLEMENTARY: drop the payload transform at both layers (credential and request builder)",
    expect: "the legacy payload lacks store:false and include",
    edits: [
      {
        find: 'return { ...p, store: false, include: ["reasoning.encrypted_content"] };',
        replace: "return p;",
      },
      {
        find: '...this.codexExtras ? { store: false, include: ["reasoning.encrypted_content"] } : {}',
        replace: "...{}",
      },
    ],
  },
  {
    id: "V16-remap",
    rows: ["V16"],
    redIn: "legacy-error",
    stands: "change the terminal-error remap",
    expect: "the 500 answer is remapped to a terminal 400",
    edits: [
      {
        find: "if (isTerminalError(response.status, errorText8, transportTerminal ?? isTerminal429(errorText8))) {",
        replace:
          "if (true || isTerminalError(response.status, errorText8, transportTerminal ?? isTerminal429(errorText8))) {",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Normalization

const DROP_HEADERS = new Set(["host", "content-length", "connection", "accept-encoding"]);
const MASKED_KEYS = new Set(["session_id", "x-client-request-id", "x-request-id", "request-id"]);
const PATTERNS: Array<[string, RegExp, string]> = [
  ["uuid", /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>"],
  ["iso-time", /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<TIME>"],
  ["epoch", /\b1[5-9]\d{8}(?:\d{3})?\b/g, "<EPOCH>"],
  ["message-id", /\b(?:msg|resp|req)_[A-Za-z0-9]+/g, "<ID>"],
];

export type Masks = Record<string, number>;
/** Exact strings replaced by a token: the version string and the row's temp root. */
export type Literals = Array<[string, string]>;

export function maskString(value: string, literals: Literals, masks: Masks): string {
  let out = value;
  for (const [name, re, to] of PATTERNS) {
    out = out.replace(re, () => {
      masks[name] = (masks[name] ?? 0) + 1;
      return to;
    });
  }
  for (const [literal, to] of literals) {
    if (out.includes(literal)) {
      masks[`literal:${to}`] = (masks[`literal:${to}`] ?? 0) + out.split(literal).length - 1;
      out = out.split(literal).join(to);
    }
  }
  return out;
}

export function maskValue(value: unknown, literals: Literals, masks: Masks, key = ""): unknown {
  if (typeof value === "string") {
    if (MASKED_KEYS.has(key.toLowerCase())) {
      masks[`key:${key}`] = (masks[`key:${key}`] ?? 0) + 1;
      return "<MASKED>";
    }
    return maskString(value, literals, masks);
  }
  if (Array.isArray(value)) return value.map((v) => maskValue(v, literals, masks));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = maskValue((value as Record<string, unknown>)[k], literals, masks, k);
    }
    return out;
  }
  return value;
}

export interface NormalizedRequest {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: unknown;
}

export function normalizeRequest(r: Recorded, literals: Literals, masks: Masks): NormalizedRequest {
  const headers: Record<string, string> = {};
  for (const k of Object.keys(r.headers).sort()) {
    if (DROP_HEADERS.has(k)) continue;
    headers[k] = maskValue(r.headers[k], literals, masks, k) as string;
  }
  let body: unknown = r.body;
  try {
    body = r.body ? JSON.parse(r.body) : null;
  } catch {
    /* keep text */
  }
  return {
    method: r.method,
    path: r.path,
    search: maskString(r.search, literals, masks),
    headers,
    body: maskValue(body, literals, masks),
  };
}

/** Human-readable deep diff: one line per differing leaf. */
export function diffValues(a: unknown, b: unknown, path = "$"): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const bothObj = a && b && typeof a === "object" && typeof b === "object";
  if (bothObj && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    return [...keys].flatMap((k) =>
      diffValues(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${path}${Array.isArray(a) ? `[${k}]` : `.${k}`}`
      )
    );
  }
  return [`${path}: baseline=${JSON.stringify(a)} candidate=${JSON.stringify(b)}`];
}

// ---------------------------------------------------------------------------
// One run

export interface Capture {
  fake: NormalizedRequest[];
  canary: NormalizedRequest[];
  client: { status: number; body: unknown };
  /** Informational: not compared (the verdict header did not exist before the pool). */
  clientHeaders: Record<string, string>;
  /** Every response header, for the credential-echo scan only (not compared). */
  allClientHeaders: Record<string, string>;
  /** Credentials found in the binary's full stdout and stderr of this run (in memory). */
  outputLeaks: string[];
  egress: string[];
  masks: Masks;
  stderrTail: string;
}

interface Pin {
  id: string;
  launcher: string;
  version: string;
  launcherSha256: string;
  bundleSha256: string;
  gitHead: string;
  gitStatusPorcelain: string;
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

function pinOf(bin: BinaryRef, env: Record<string, string>): Pin {
  const bundle = join(bin.launcher, "..", "..", "dist", "index.js");
  return {
    id: bin.id,
    launcher: bin.launcher,
    version: run(["node", bin.launcher, "--version"], { env, cwd: bin.tree }),
    launcherSha256: sha256File(bin.launcher),
    bundleSha256: sha256File(bundle),
    gitHead: run(["git", "rev-parse", "HEAD"], { cwd: bin.tree }),
    gitStatusPorcelain: run(["git", "status", "--porcelain"], { cwd: bin.tree }),
  };
}

export async function runOnce(
  bin: BinaryRef,
  c: CaseDef,
  literals: Literals,
  rawDir?: string
): Promise<Capture & { rawFake: Recorded[]; rawCanary: Recorded[] }> {
  const tree = makeRowRoot();
  // Every handle is tracked as it is acquired and released in the one finally below, so a
  // setup failure (seed, slots write, spawn) cannot leave a listener or a child behind.
  // The row root is removed when the run finishes, kept (evidence) when anything throws.
  let finished = false;
  let fake: ReturnType<typeof startRecordingFake> | undefined;
  let canary: ReturnType<typeof startRecordingCanary> | undefined;
  let sink: Awaited<ReturnType<typeof startEgressSink>> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const lits: Literals = [...literals, [tree.root, "<ROOT>"]];
    fake = startRecordingFake({ responses: c.responses, tokenMode: c.tokenMode });
    canary = startRecordingCanary();
    sink = await startEgressSink(join(tree.root, "egress.jsonl"));
    const env = buildEnv({
      tree,
      accountsLog: join(tree.root, "accounts.jsonl"),
      fakeOrigin: fake.origin,
      canaryOrigin: canary.origin,
      sinkPort: sink.port,
      claudePath: "/nonexistent/claude-not-used-by-serve",
    });
    await seedHome({
      home: tree.home,
      accountsDir: tree.accountsDir,
      accounts: [],
      legacy: c.seed !== "none",
    });
    if (c.seed === "legacy-expired") {
      writeFileSync(
        join(tree.home, ".claudish", "codex-oauth.json"),
        JSON.stringify({
          access_token: "access-legacy",
          refresh_token: "refresh-legacy",
          expires_at: 1,
          account_id: "acct-legacy",
        }),
        { mode: 0o600 }
      );
    }
    const slotsPath = join(tree.root, "slots.json");
    writeFileSync(
      slotsPath,
      JSON.stringify([{ slot: SLOT, model: "gpt-6.1-sol", provider: "openai-codex" }])
    );

    const port = await freePort();
    child = Bun.spawn(
      [
        "sandbox-exec",
        "-p",
        OFFLINE_PROFILE,
        "node",
        bin.launcher,
        "serve",
        "--port",
        String(port),
        "--models",
        slotsPath,
      ],
      { cwd: tree.cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" }
    );
    let out = "";
    let err = "";
    const drain = async (s: ReadableStream<Uint8Array>, into: (t: string) => void) => {
      const reader = s.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        into(dec.decode(value));
      }
    };
    void drain(child.stdout as ReadableStream<Uint8Array>, (t) => {
      out += t;
    });
    void drain(child.stderr as ReadableStream<Uint8Array>, (t) => {
      err += t;
    });
    {
      const deadline = Date.now() + 30_000;
      while (!out.includes("listening on")) {
        if (Date.now() > deadline || child.exitCode !== null) {
          throw new Error(`serve did not start (${bin.id}): stdout=${out} stderr=${err}`);
        }
        await Bun.sleep(50);
      }
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": "placeholder-not-a-credential",
        },
        body: JSON.stringify({
          model: SLOT,
          max_tokens: 64,
          stream: false,
          messages: [{ role: "user", content: PROMPT }],
          metadata: { user_id: JSON.stringify({ session_id: SESSION_ID }) },
        }),
        signal: AbortSignal.timeout(90_000),
      });
      const text = await res.text();
      await Bun.sleep(400);
      const masks: Masks = {};
      let bodyJson: unknown = text;
      try {
        bodyJson = JSON.parse(text);
      } catch {
        /* keep text */
      }
      const clientHeaders: Record<string, string> = {};
      for (const [k, v] of res.headers) {
        if (k.startsWith("x-claudish") || k === "content-type") clientHeaders[k] = v;
      }
      const allClientHeaders = Object.fromEntries(res.headers);
      const result = {
        fake: fake.requests.map((r) => normalizeRequest(r, lits, masks)),
        canary: canary.requests.map((r) => normalizeRequest(r, lits, masks)),
        client: { status: res.status, body: maskValue(bodyJson, lits, masks) },
        clientHeaders,
        allClientHeaders,
        outputLeaks: outputLeaks({ stdout: out, stderr: err }),
        egress: sink.attempts.map((a) => `${a.method} ${a.target}`),
        masks,
        stderrTail: err.split("\n").slice(-8).join("\n"),
        rawFake: [...fake.requests],
        rawCanary: [...canary.requests],
      };
      if (rawDir) {
        mkdirSync(rawDir, { recursive: true });
        writeFileSync(join(rawDir, "fake-requests.json"), JSON.stringify(fake.requests, null, 2));
        writeFileSync(
          join(rawDir, "canary-requests.json"),
          JSON.stringify(canary.requests, null, 2)
        );
        writeFileSync(
          join(rawDir, "client-response.json"),
          JSON.stringify(
            { status: res.status, headers: Object.fromEntries(res.headers), body: bodyJson },
            null,
            2
          )
        );
        writeFileSync(join(rawDir, "serve-stdout.txt"), out);
        writeFileSync(join(rawDir, "serve-stderr.txt"), err);
      }
      finished = true;
      return result;
    }
  } finally {
    // The launcher spawns the bundle as a child: kill the whole tree, not the launcher.
    if (child) killTree(child.pid, "SIGKILL");
    fake?.stop();
    canary?.stop();
    sink?.stop();
    if (finished) rmSync(tree.root, { recursive: true, force: true });
  }
}

/** Seam proof: a request must reach the fake (or the canary for the api-key arm). */
export async function proveSeam(bin: BinaryRef, literals: Literals): Promise<string | null> {
  const probe: CaseDef = { ...(CASES[0] as CaseDef), id: "seam-proof" };
  const r = await runOnce(bin, probe, literals);
  const reached = r.fake.some((q) => q.path.endsWith("/codex/responses"));
  if (!reached) {
    return `no /codex/responses request reached the fake (fake saw: ${r.fake.map((q) => `${q.method} ${q.path}`).join(", ") || "nothing"}; client ${r.client.status})`;
  }
  if (r.canary.length > 0)
    return `the canary was contacted ${r.canary.length}x during the seam proof`;
  return null;
}

// ---------------------------------------------------------------------------
// Comparison and reporting

export type Outcome =
  | "identical"
  | "expected divergence"
  | "DIFFERENT"
  | "ABORTED"
  | "DEAD-MUTANT"
  | "mutant red";

function comparable(c: Capture) {
  return { fake: c.fake, canary: c.canary, client: c.client };
}

function checkEgress(egress: string[]): string[] {
  return egress.filter((e) => !KNOWN_EGRESS.test(e));
}

export function scanSecrets(dir: string): {
  files: number;
  allowlisted: number;
  violations: string[];
} {
  let files = 0;
  let allowlisted = 0;
  const violations: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        if (name === "mutants") continue; // copies of the bundle, not evidence text
        walk(p);
        continue;
      }
      if (name.endsWith(".diff")) continue;
      files++;
      const text = readFileSync(p, "utf8");
      for (const m of text.matchAll(
        /sk-[A-Za-z0-9_-]{6,}|eyJ[A-Za-z0-9_-]{10,}|\b(?:access|refresh)-(?:legacy|A|B)\b|(?:at|rt)-rotated-\d+/g
      )) {
        // A fake credential is allowed only in the upstream-request evidence files.
        if (FAKE_SECRETS.has(m[0]) && UPSTREAM_EVIDENCE_FILES.has(name)) allowlisted++;
        else violations.push(`${p}: ${m[0]}`);
      }
    }
  };
  walk(dir);
  return { files, allowlisted, violations };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  // Raw values are validated BEFORE resolve(): resolve("") is the current directory.
  const rawBaseline = flag("--baseline");
  const rawOut = flag("--out");
  const only = flag("--only");
  const sameAsCandidate = (b: string) => {
    try {
      return realpathSync(resolve(b)) === realpathSync(REPO);
    } catch {
      return false;
    }
  };
  const argErrors = argProblems(
    { baseline: rawBaseline, out: rawOut, only, onlyGiven: args.includes("--only") },
    CASES.map((c) => c.id),
    sameAsCandidate
  );
  if (rawBaseline && !argErrors.length && !existsSync(resolve(rawBaseline)))
    argErrors.push(`--baseline ${rawBaseline} does not exist`);
  if (argErrors.length) {
    for (const p of argErrors) console.error(p);
    console.error(
      "usage: e20.ts --baseline <worktree> --out <dir> [--seam-diff <file>] [--skip-mutants] [--only <case>]"
    );
    process.exit(2);
  }
  const baselineTree = resolve(rawBaseline as string);
  const out = resolve(rawOut as string);
  mkdirSync(out, { recursive: true });
  const baseline: BinaryRef = {
    id: "baseline",
    launcher: join(baselineTree, "packages/cli/bin/claudish.cjs"),
    tree: baselineTree,
  };
  const candidate: BinaryRef = { id: "candidate", launcher: LAUNCHER, tree: REPO };

  // Pins are recorded before any result is read.
  const pinEnv = {
    PATH: process.env.PATH ?? "",
    HOME: "/nonexistent-e20-home",
    CLAUDISH_DISABLE_KEYCHAIN: "1",
  };
  const pins = { baseline: pinOf(baseline, pinEnv), candidate: pinOf(candidate, pinEnv) };
  // The backport diff: --seam-diff <file>, else <out>/seam-backport.diff.
  const seamDiff = resolve(flag("--seam-diff") ?? join(out, "seam-backport.diff"));
  const seamDiffSha256 = existsSync(seamDiff)
    ? createHash("sha256").update(readFileSync(seamDiff)).digest("hex")
    : null;
  writeFileSync(
    join(out, "pins.json"),
    JSON.stringify({ ...pins, seamDiffSha256, bun: Bun.version }, null, 2)
  );
  console.log(`baseline  ${pins.baseline.version} bundle ${pins.baseline.bundleSha256}`);
  console.log(`candidate ${pins.candidate.version} bundle ${pins.candidate.bundleSha256}`);

  const literals: Literals = [pins.baseline.version, pins.candidate.version]
    .map((v) => v.replace(/^claudish version\s+/, "").trim())
    .filter(Boolean)
    .map((v): [string, string] => [v, "<VERSION>"]);

  // Seam proof per binary; a binary that fails is aborted (no case runs on it).
  const armed: Record<string, string | null> = {};
  for (const bin of [baseline, candidate]) {
    armed[bin.id] = await proveSeam(bin, literals);
    console.log(
      `seam ${bin.id}: ${armed[bin.id] === null ? "ARMED" : `NOT ARMED: ${armed[bin.id]}`}`
    );
  }
  writeFileSync(join(out, "seam-proof.json"), JSON.stringify(armed, null, 2));

  const summary: Array<{ id: string; outcome: Outcome; detail: string }> = [];
  const captured: Record<string, Capture> = {};

  for (const c of CASES) {
    if (only && c.id !== only) continue;
    const caseDir = join(out, c.id);
    mkdirSync(caseDir, { recursive: true });
    if (armed.baseline !== null || armed.candidate !== null) {
      const detail = `seam not armed on ${[armed.baseline && "baseline", armed.candidate && "candidate"].filter(Boolean).join(" and ")}`;
      writeFileSync(
        join(caseDir, "result.json"),
        JSON.stringify({ case: c.id, pins, outcome: "ABORTED", detail }, null, 2)
      );
      summary.push({ id: c.id, outcome: "ABORTED", detail });
      continue;
    }
    // Two runs per binary: the second proves the masked comparison is stable (flake check).
    const runs: Record<
      string,
      Array<Capture & { rawFake: Recorded[]; rawCanary: Recorded[] }>
    > = {};
    for (const bin of [baseline, candidate]) {
      runs[bin.id] = [];
      for (let i = 0; i < 2; i++) {
        runs[bin.id]?.push(
          await runOnce(bin, c, literals, i === 0 ? join(caseDir, bin.id) : undefined)
        );
      }
    }
    const b = runs.baseline?.[0] as Capture;
    const k = runs.candidate?.[0] as Capture;
    captured[c.id] = k;
    captured[`baseline:${c.id}`] = b;
    const b2 = runs.baseline?.[1] as Capture;
    const k2 = runs.candidate?.[1] as Capture;
    const stable = {
      baseline: [...diffValues(comparable(b), comparable(b2), "$"), ...headerStabilityDiff(b, b2)],
      candidate: [...diffValues(comparable(k), comparable(k2), "$"), ...headerStabilityDiff(k, k2)],
    };
    const diff = diffValues(comparable(b), comparable(k));
    const diff2 = diffValues(comparable(b2), comparable(k2));
    const problems: string[] = [];
    // Every repetition, not only the first, meets the egress, upstream and canary checks.
    for (const [name, cap] of [
      ["baseline", b],
      ["candidate", k],
      ["baseline repetition 2", b2],
      ["candidate repetition 2", k2],
    ] as const) {
      const bad = checkEgress(cap.egress);
      if (bad.length) problems.push(`${name} egress to unknown target: ${bad.join("; ")}`);
      // A fake credential may sit in the upstream-request evidence, never in what the client sees.
      for (const leak of clientLeaks(cap)) problems.push(`${name}: ${leak}`);
      for (const leak of cap.outputLeaks) problems.push(`${name}: ${leak}`);
      const reached =
        c.needs === "responses"
          ? cap.fake.some((q) => q.path.endsWith("/codex/responses"))
          : c.needs === "token"
            ? cap.fake.some((q) => q.path.endsWith("/oauth/token"))
            : cap.canary.length > 0;
      if (!reached)
        problems.push(
          `${name}: the case never reached its upstream (${c.needs}); seam not exercised`
        );
      if (c.canaryMin !== null) {
        const n = cap.canary.length;
        if (c.canaryMin === 0 ? n !== 0 : n < c.canaryMin)
          problems.push(
            `${name}: canary count ${n}, expected ${c.canaryMin === 0 ? "0" : `>= ${c.canaryMin}`}`
          );
      }
    }
    for (const [name, d] of Object.entries(stable)) {
      if (d.length) problems.push(`${name} is not self-stable across two runs: ${d.join(" | ")}`);
    }
    let outcome: Outcome;
    let divergenceProblems: string[] = [];
    if (problems.length) outcome = "ABORTED";
    else if (c.mode === "expected-divergence") {
      // Explicit per-binary expectations (e20-gate.ts); any other difference is DIFFERENT.
      divergenceProblems = refreshRejectedAllReps([b, b2], [k, k2], [diff, diff2]);
      outcome = divergenceProblems.length ? "DIFFERENT" : "expected divergence";
    } else outcome = diff.length ? "DIFFERENT" : "identical";
    const result = {
      case: c.id,
      doc: c.doc,
      pins,
      seamDiffSha256,
      mode: c.mode,
      outcome,
      problems,
      divergenceProblems,
      diff,
      stable,
      baseline: { ...b, rawNote: "raw captures in ./baseline" },
      candidate: { ...k, rawNote: "raw captures in ./candidate" },
    };
    writeFileSync(join(caseDir, "result.json"), JSON.stringify(result, null, 2));
    summary.push({
      id: c.id,
      outcome,
      detail:
        problems.length > 0
          ? problems.join("; ")
          : divergenceProblems.length > 0
            ? divergenceProblems.join("; ")
            : diff.length === 0
              ? `request(s) at fake=${k.fake.length} canary=${k.canary.length}, client ${k.client.status}`
              : `${diff.length} differing field(s)`,
    });
    console.log(
      `${c.id}: ${outcome}${diff.length ? ` (${diff.length} diffs)` : ""}${problems.length ? ` PROBLEMS: ${problems.join("; ")}` : ""}${divergenceProblems.length ? ` UNEXPECTED: ${divergenceProblems.join("; ")}` : ""}`
    );
  }

  // Mutants: each must turn its case red against the UNMUTATED candidate's capture.
  if (!args.includes("--skip-mutants")) {
    const mutantsRoot = join(out, "mutants");
    for (const m of V16_MUTANTS) {
      const c = CASES.find((x) => x.id === m.redIn) as CaseDef;
      const ref = captured[c.id];
      const refBase = captured[`baseline:${c.id}`];
      if (!ref || !refBase) {
        // A mutant is never skipped silently: its red case did not produce a capture.
        if (only && c.id !== only) continue; // partial run, this mutant is out of scope
        summary.push({
          id: `mutant ${m.id}`,
          outcome: "ABORTED",
          detail: `its red case ${c.id} has no capture (aborted or not run)`,
        });
        continue;
      }
      if (m.edits.length === 0) {
        summary.push({ id: `mutant ${m.id}`, outcome: "ABORTED", detail: "no edit built" });
        continue;
      }
      const launcher = emitMutantTree(m, join(mutantsRoot, m.id));
      const bin: BinaryRef = { id: m.id, launcher, tree: join(mutantsRoot, m.id) };
      const armedErr = await proveSeam(bin, literals);
      let outcome: Outcome;
      let detail: string;
      if (m.id !== "V16-endpoint-path" && armedErr) {
        outcome = "ABORTED";
        detail = `seam proof failed on the mutant: ${armedErr}`;
      } else {
        const r = await runOnce(bin, c, literals, join(out, "mutant-raw", m.id));
        const dCand = diffValues(comparable(ref), comparable(r));
        const dBase = diffValues(comparable(refBase), comparable(r));
        outcome = dCand.length > 0 ? "mutant red" : "DEAD-MUTANT";
        detail = `${m.stands}; red in ${c.id}: ${dCand.length} diff(s) vs unmutated candidate, ${dBase.length} vs baseline; canary=${r.canary.length}`;
        writeFileSync(
          join(out, "mutant-raw", m.id, "diff.json"),
          JSON.stringify({ vsCandidate: dCand, vsBaseline: dBase }, null, 2)
        );
        // Standing check: a mutant run that reached an unknown target is not evidence.
        const badEgress = checkEgress(r.egress);
        if (badEgress.length) {
          outcome = "ABORTED";
          detail += `; UNKNOWN EGRESS ${badEgress.join("; ")}`;
        }
        for (const leak of [...clientLeaks(r), ...r.outputLeaks]) {
          outcome = "ABORTED";
          detail += `; CLIENT LEAK ${leak}`;
        }
        // No V16 mutant may reach the metered canary (saved runs: canary=0).
        if (r.canary.length > 0) {
          outcome = "ABORTED";
          detail += `; CANARY CONTACTED ${r.canary.length}x`;
        }
      }
      summary.push({ id: `mutant ${m.id}`, outcome, detail });
      console.log(`mutant ${m.id}: ${outcome} - ${detail}`);
    }
  }

  const scan = scanSecrets(out);
  writeFileSync(join(out, "secret-scan.json"), JSON.stringify(scan, null, 2));
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(
    `secret scan: ${scan.files} files, ${scan.allowlisted} allowlisted fake values, ${scan.violations.length} violations`
  );
  const expected = {
    cases: CASES.filter((c) => !only || c.id === only).map((c) => c.id),
    mutants: args.includes("--skip-mutants")
      ? []
      : V16_MUTANTS.filter((m) => !only || m.redIn === only).map((m) => `mutant ${m.id}`),
  };
  const verdict = e20Verdict(summary, armed, scan.violations.length, expected);
  for (const reason of verdict.reasons) console.log(`E20 FAIL: ${reason}`);
  console.log(`E20 exit ${verdict.code}`);
  process.exit(verdict.code);
}

if (import.meta.main) await main();
