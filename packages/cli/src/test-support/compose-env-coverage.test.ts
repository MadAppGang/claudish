/**
 * #304 → #310 — static cross-check: every CLAUDISH_* env name the code READS
 * must be injected by docker-compose.yml's `environment:` list, unless it is
 * explicitly exempted below as not-for-containers.
 *
 * The compose `environment:` list is an explicit allowlist: the env file is
 * used for interpolation only, so a knob written there for a name the list
 * does not carry never reaches the process — the proxy runs on its defaults
 * whatever the operator wrote. That is how five #91/#293 failover knobs and
 * the #218 kill switch shipped documented but unreachable (#304); #310
 * widened the check from the failover family to all CLAUDISH_* names and
 * found the same state for 22 more runtime knobs, including the two
 * never-hang kill switches (FIRST_EVENT_TIMEOUT_MS, PREVISIBLE_REFORWARD_MAX)
 * and the key-rotation overlap (PROXY_KEY_PREVIOUS).
 *
 * What this test pins, in both directions:
 *   1. code → compose: every name read in production sources (tests excluded)
 *      appears in the compose list, or carries an entry in EXEMPT below with
 *      the reason it is not for containers. The default for a NEW name is
 *      "must be injected" — adding a read without a compose line (or an
 *      exemption) fails this test.
 *   2. compose → code: every CLAUDISH_* name in the compose list is read by
 *      the code — a renamed knob would otherwise leave a dead compose line
 *      that looks configurable and is not.
 *   3. empty-string safety (#310 review): compose's `${VAR:-}` makes every
 *      injected name PRESENT with value "", so for compose-injected names a
 *      `?? fallback` read is a trap — "" is not nullish, the fallback never
 *      fires, and "" becomes a live value (Number("") === 0 turned the
 *      overflow floor OFF; the catalog URL chain fetched ""). Reads of those
 *      names must treat "" as unset at the site.
 *
 * Read shapes covered: `.NAME` dot access on `process.env` (or the `env`
 * parameter objects that carry it), `["NAME"]` bracket access with a literal
 * string, and the failover dynamic templates (`env[`CLAUDISH_FAILOVER_${role}`]`,
 * `env[`${key}_LABEL`]`). The templates cannot be extracted as literals, so
 * the closed role set {OPUS,SONNET,HAIKU,FABLE} is resolved here, and the
 * resolution is itself pinned: if FAILOVER_ROLES ever grows a fifth role, the
 * bare-role anchor assertion below fails and forces the family (and compose)
 * to follow.
 *
 * Positive controls (a detector that silently matches nothing proves nothing):
 *   - the compose parser must find the known 23-name family (parser alive);
 *   - the code scan must collect a broad, named population (scanner alive);
 *   - the bracket shape is proven on a synthetic fixture — zero production
 *     sites use it today, so only a fixture keeps the shape from silently
 *     rotting until the first real `process.env["CLAUDISH_…"]` appears;
 *   - the gap checker must report a name on a synthetic compose that lacks it
 *     (verdict alive — the mutation, run as a fixture so the real repository
 *     is never touched).
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const COMPOSE_FILE = join(REPO_ROOT, "docker-compose.yml");

/** The closed role set — mirrors FAILOVER_ROLES in fork/failover.ts. */
const ROLES = ["OPUS", "SONNET", "HAIKU", "FABLE"] as const;

/**
 * #310's not-for-containers list. Every entry states WHY the name is exempt —
 * an exemption without a reason is how a real gap hides. And an exemption can
 * never outlive its read: the stale-exemption test below requires each name
 * to still be read somewhere in packages/cli/src, so a rename that drops the
 * read also fails this suite until the exemption is removed — at which point
 * the name is back under the must-be-injected default.
 */
const EXEMPT: ReadonlyArray<{ name: string; why: string }> = [
  {
    name: "CLAUDISH_ACTIVE_MODEL_NAME",
    why: "set by the claudish runner for the spawned session's status line; never a proxy knob",
  },
  { name: "CLAUDISH_IS_LOCAL", why: "statusline pair of CLAUDISH_ACTIVE_MODEL_NAME" },
  {
    name: "CLAUDISH_MODEL",
    why: "CLI default-model knob; the proxy reads it only for stats attribution (detectInvocationMode in proxy-server.ts), never for routing",
  },
  {
    name: "CLAUDISH_HOST",
    why: "standalone-proxy bind default; compose's command pins --host and argv overrides the env (standalone-proxy.ts:58-61), so an injected value is dead by construction",
  },
  {
    name: "CLAUDISH_MCP_TOOLS",
    why: "gates the MCP stdio server (--mcp), a host-side process; no MCP server runs in the proxy container",
  },
  {
    name: "CLAUDISH_CATALOG_TTL_HOURS",
    why: "launcher cache-warm CLI knob; the proxy reads CLAUDISH_CATALOG_URL, not the warm TTL",
  },
  { name: "CLAUDISH_TEST_ENV_ALLOW", why: "test harness gate (test-support/env-gate.ts)" },
  { name: "CLAUDISH_TEST_ENV_STRICT", why: "test harness gate (test-support/env-gate.ts)" },
  { name: "CLAUDISH_TEST_HOME_SANDBOX", why: "test harness preload (test-preload.ts)" },
  { name: "CLAUDISH_TEST_REAL_HOME", why: "test harness preload (test-preload.ts)" },
  {
    name: "CLAUDISH_TEST_PRESET_HOME",
    why: "test harness preload (test-preload.ts) — launcher-side flag for a preset HOME on bun >= 1.4/POSIX (#570); never a proxy knob",
  },
  {
    name: "CLAUDISH_TEST_SANDBOX_PROOF",
    why: "test harness preload (test-preload.ts) — which evidence let the run proceed; read by the #242 pin, never a proxy knob",
  },
];
const EXEMPT_NAMES = new Set(EXEMPT.map((e) => e.name));

/** #654/#663 — the per-endpoint budget family shape: suffix is the endpoint
 *  name uppercased, non-alphanumerics as `_` (`vllm-myia` → `VLLM_MYIA`). */
const ENDPOINT_BUDGET_FAMILY_RE = /^CLAUDISH_ENDPOINT_(?:TOKEN_BUDGET|BIG_LIMIT)_[A-Z0-9_]+$/;

/** Recursively collect non-test .ts files under packages/cli/src. */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

export interface ScanResult {
  /** Literal name → where it is read (file:line). */
  staticReads: Map<string, string[]>;
  /** Template-literal reads that resolve onto the role family. */
  dynamicBareRole: boolean;
  dynamicSuffixes: Set<string>;
  /** #654 — template reads of the per-endpoint budget family. */
  dynamicEndpointBudget: boolean;
}

/**
 * Scan sources for the shapes the code uses to read the environment.
 * `\benv\b`: standalone `env.` / `env[…]` (parameter objects that carry the
 * process env, e.g. initFailover's) — must NOT match `xenv.`/`myenv.`;
 * `process.env` matched by its own alternative.
 */
export function scanSources(files: { path: string; text: string }[]): ScanResult {
  const staticReads = new Map<string, string[]>();
  let dynamicBareRole = false;
  let dynamicEndpointBudget = false;
  const dynamicSuffixes = new Set<string>();
  const dotRe = /(?:process\.env|\benv\b)\.(CLAUDISH_[A-Z0-9_]+)/g;
  const bracketRe = /(?:process\.env|\benv\b)\[\s*["'](CLAUDISH_[A-Z0-9_]+)["']\s*\]/g;
  const dynamicBareRe = /env\[`CLAUDISH_FAILOVER_\$\{[^}]+\}`\]/;
  // `env[`${key}_LABEL`]` — capture the suffix WITHOUT its joining underscore
  // (the required name is built as `${role}_${suffix}`).
  const dynamicSuffixRe = /env\[`\$\{key\}_([A-Z]+)`\]/g;
  // #654 — the per-endpoint budget knobs read by template
  // (`CLAUDISH_ENDPOINT_TOKEN_BUDGET_${suffix}`, `…_BIG_LIMIT_${suffix}`).
  const dynamicEndpointBudgetRe = /env\[`CLAUDISH_ENDPOINT_(?:TOKEN_BUDGET|BIG_LIMIT)_\$\{[^}]+\}`\]/;
  for (const f of files) {
    const lines = f.text.split("\n");
    lines.forEach((line, i) => {
      const where = `${f.path.replace(SRC_ROOT + "\\", "").replace(/\\/g, "/")}:${i + 1}`;
      for (const re of [dotRe, bracketRe]) {
        for (const m of line.matchAll(re)) {
          const list = staticReads.get(m[1]) ?? [];
          list.push(where);
          staticReads.set(m[1], list);
        }
      }
      if (dynamicBareRe.test(line)) dynamicBareRole = true;
      if (dynamicEndpointBudgetRe.test(line)) dynamicEndpointBudget = true;
      for (const m of line.matchAll(dynamicSuffixRe)) dynamicSuffixes.add(m[1]);
    });
  }
  return { staticReads, dynamicBareRole, dynamicSuffixes, dynamicEndpointBudget };
}

/** Extract the CLAUDISH_* names the compose environment: list injects. */
export function composeEnvNames(composeText: string): Set<string> {
  const names = new Set<string>();
  for (const m of composeText.matchAll(/^\s*- (CLAUDISH_[A-Z0-9_]+)=\$\{/gm)) {
    names.add(m[1]);
  }
  return names;
}

/**
 * The full set of names the code can read, dynamic templates resolved onto
 * the role family. Exemptions are NOT subtracted here — see coverageGaps.
 */
export function requiredNames(scan: ScanResult): Set<string> {
  const required = new Set<string>();
  for (const name of scan.staticReads.keys()) required.add(name);
  if (scan.dynamicBareRole) {
    for (const role of ROLES) required.add(`CLAUDISH_FAILOVER_${role}`);
  }
  for (const suffix of scan.dynamicSuffixes) {
    for (const role of ROLES) required.add(`CLAUDISH_FAILOVER_${role}_${suffix}`);
  }
  return required;
}

/** Direction 1 verdict: names the code reads that compose does not inject. */
export function coverageGaps(scan: ScanResult, composeNames: Set<string>): string[] {
  const gaps: string[] = [];
  for (const name of requiredNames(scan)) {
    if (EXEMPT_NAMES.has(name)) continue;
    if (!composeNames.has(name)) gaps.push(name);
  }
  return gaps.sort();
}

/** Direction 2 verdict: CLAUDISH_* compose entries the code no longer reads. */
export function deadComposeEntries(scan: ScanResult, composeNames: Set<string>): string[] {
  const required = requiredNames(scan);
  return [...composeNames]
    .filter((n) => !required.has(n))
    // #663 r1 — a literal of the per-endpoint budget family IS read by the
    // code: the family is consumed by a template whose suffix is the
    // operator-defined endpoint name, which no static scan can enumerate.
    // Only honored while the template read is live (dynamicEndpointBudget) —
    // delete the read and every family literal is dead again, as it should
    // be. Accepted price: a typo'd family literal also passes direction 2;
    // bounded by the endpoint-name spelling itself, which the resolver
    // rejects loudly at load.
    .filter((n) => !(scan.dynamicEndpointBudget && ENDPOINT_BUDGET_FAMILY_RE.test(n)))
    .sort();
}

/** A compose-injected name read with `??` whose effective RHS is not `""`. */
export interface EmptyStringTrap {
  name: string;
  where: string;
  rhs: string;
}

/**
 * Read shape the empty-string rule refuses: `NAME ?? <something not "">` on a
 * name the compose list injects. Scoped to compose-injected names on purpose —
 * CLI-only knobs (exemptions) never see compose's "" and may keep `?? "24"`
 * style defaults freely. The `??` must follow the name directly;
 * `NAME?.trim() ?? x` is a different shape this deliberately does not chase
 * (zero sites today — the optional-chain read is covered by per-name pins
 * where it exists).
 */
const NULLISH_READ_RE = /(?:process\.env|\benv\b)\.(CLAUDISH_[A-Z0-9_]+)\s*\?\?/g;

/**
 * The effective right-hand side of a `??`: walk a chain of env reads
 * (`env.A ?? env.B ?? "terminal"`) to its terminal and return the terminal's
 * literal value ("" for an empty string literal), or the first token when the
 * terminal is not a string literal — a non-literal fallback cannot be proven
 * empty, so it is reported and a human decides.
 */
function resolveNullishRhs(tail: string): string {
  let rest = tail;
  for (let hop = 0; hop < 5; hop++) {
    const trimmed = rest.replace(/^\s+/, "");
    const envHop = trimmed.match(/^(?:process\.env|\benv\b)\.[A-Za-z0-9_]+\s*\?\?\s*/);
    if (!envHop) {
      rest = trimmed;
      break;
    }
    rest = trimmed.slice(envHop[0].length);
  }
  const literal = rest.match(/^(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/);
  if (literal) return literal[1] ?? literal[2] ?? literal[3] ?? "";
  const token = rest.match(/^\S+/);
  return token ? token[0] : "(unparseable rhs)";
}

/** Direction 3 verdict: compose-injected names whose `??` fallback makes "" live. */
export function emptyUnsafeNullishReads(
  files: { path: string; text: string }[],
  composeNames: Set<string>
): EmptyStringTrap[] {
  const traps: EmptyStringTrap[] = [];
  for (const f of files) {
    for (const m of f.text.matchAll(NULLISH_READ_RE)) {
      const name = m[1];
      if (!composeNames.has(name)) continue;
      const rhs = resolveNullishRhs(f.text.slice(m.index! + m[0].length, m.index! + m[0].length + 200));
      if (rhs === "") continue;
      const line = f.text.slice(0, m.index!).split("\n").length;
      traps.push({ name, rhs, where: `${f.path.replace(SRC_ROOT + "\\", "").replace(/\\/g, "/")}:${line}` });
    }
  }
  return traps;
}

describe("#310 compose env coverage (all CLAUDISH_*)", () => {
  const composeText = readFileSync(COMPOSE_FILE, "utf-8");
  const files = collectSourceFiles(SRC_ROOT).map((path) => ({ path, text: readFileSync(path, "utf-8") }));
  const scan = scanSources(files);
  const composeNames = composeEnvNames(composeText);

  test("positive control: the compose parser sees the known families", () => {
    // If this fires, the parser is matching nothing and every assertion below
    // is vacuously green — the exact blindness this control exists to catch.
    for (const role of ROLES) {
      expect(composeNames.has(`CLAUDISH_FAILOVER_${role}`)).toBe(true);
      for (const suffix of ["LABEL", "DIRECTION", "NOTE", "RESET"]) {
        expect(composeNames.has(`CLAUDISH_FAILOVER_${role}_${suffix}`)).toBe(true);
      }
    }
    expect(composeNames.has("CLAUDISH_FAILOVER_ROLE_MODELS")).toBe(true);
    expect(composeNames.has("CLAUDISH_FAILOVER_ACTIVE")).toBe(true);
    expect(composeNames.has("CLAUDISH_FAILOVER_AUTO")).toBe(true);
    // #310 additions — one per themed group.
    expect(composeNames.has("CLAUDISH_FIRST_EVENT_TIMEOUT_MS")).toBe(true);
    expect(composeNames.has("CLAUDISH_PROXY_KEY_PREVIOUS")).toBe(true);
    expect(composeNames.has("CLAUDISH_DEFAULT_PROVIDER")).toBe(true);
    expect(composeNames.has("CLAUDISH_TELEMETRY")).toBe(true);
  });

  test("positive control: the source scanner collected a broad population", () => {
    // initFailover (fork/failover.ts) and the #310 runtime knobs, read as
    // literals across the tree.
    for (const name of [
      "CLAUDISH_FAILOVER_ACTIVE",
      "CLAUDISH_FAILOVER_AUTO",
      "CLAUDISH_FAILOVER_ROLE_MODELS",
      "CLAUDISH_FAILOVER_ARM_AFTER",
      "CLAUDISH_FAILOVER_SESSION_DWELL_MS",
      "CLAUDISH_FAILOVER_RECOVERY_GRACE_MS",
      "CLAUDISH_NATIVE_MODEL_PIN",
      "CLAUDISH_NATIVE_FOREIGN_TOKEN_GUARD",
      "CLAUDISH_NATIVE_HEADER_NAMES_LOG",
      "CLAUDISH_FIRST_EVENT_TIMEOUT_MS",
      "CLAUDISH_PREVISIBLE_REFORWARD_MAX",
      "CLAUDISH_PROXY_KEY_PREVIOUS",
      "CLAUDISH_STALL_THRESHOLD_MS",
      "CLAUDISH_TELEMETRY",
      "CLAUDISH_STATS",
      "CLAUDISH_DEFAULT_PROVIDER",
    ]) {
      expect(scan.staticReads.has(name)).toBe(true);
    }
    // The dynamic role family is detected, not assumed.
    expect(scan.dynamicBareRole).toBe(true);
    expect(scan.dynamicSuffixes.has("LABEL")).toBe(true);
    // The widened population is what #310 measured (52 literal names at
    // b967fae); the floor leaves room for small refactors without letting
    // the scanner quietly degrade to the failover family alone.
    expect(scan.staticReads.size).toBeGreaterThanOrEqual(45);
  });

  test("the #654 endpoint-budget family is detected and deliberately NOT required (operator-suffixed)", () => {
    // `CLAUDISH_ENDPOINT_TOKEN_BUDGET_<NAME>` / `CLAUDISH_ENDPOINT_BIG_LIMIT_<NAME>`
    // are suffixed with the CUSTOM-ENDPOINT name — an open operator-defined set
    // (vllm-myia, qwen-token-plan, …), unlike the failover roles' closed four.
    // They cannot be enumerated for `requiredNames`, and they cannot sit in
    // EXEMPT either (an exemption must anchor to a literal read). What this
    // pins instead, both directions:
    //   1. the DETECTOR sees the family (delete the read below and this goes
    //      red — the family never silently escapes the scanner's universe);
    //   2. the family stays absent from requiredNames by DESIGN — the operator
    //      gesture is a per-deployment compose `environment:` line, documented
    //      in .env.sidecar.example; without that line the knob is inert (#654
    //      AC1), which is itself pinned in endpoint-token-budget.test.ts.
    expect(scan.dynamicEndpointBudget).toBe(true);
    const familyRequired = [...requiredNames(scan)].some((n) =>
      n.startsWith("CLAUDISH_ENDPOINT_TOKEN_BUDGET_") || n.startsWith("CLAUDISH_ENDPOINT_BIG_LIMIT_")
    );
    expect(familyRequired).toBe(false);
    // #663 r1 — the two literals compose carries for the endpoint this
    // deployment arms. Dropping either line from docker-compose.yml must go
    // red HERE first: without the literal the knob never reaches the
    // container (#310's whole failure mode) and nothing else watches it.
    expect(composeNames.has("CLAUDISH_ENDPOINT_TOKEN_BUDGET_VLLM_MYIA")).toBe(true);
    expect(composeNames.has("CLAUDISH_ENDPOINT_BIG_LIMIT_VLLM_MYIA")).toBe(true);
    // …and direction 2 counts them as read (template read live) — the
    // no-dead-knobs test would otherwise force them back out of compose.
    expect(deadComposeEntries(scan, composeNames)).not.toContain("CLAUDISH_ENDPOINT_TOKEN_BUDGET_VLLM_MYIA");
    expect(deadComposeEntries(scan, composeNames)).not.toContain("CLAUDISH_ENDPOINT_BIG_LIMIT_VLLM_MYIA");
    // The family allowance is keyed to the live template read: kill the read
    // (synthetic scan with dynamicEndpointBudget=false) and the literal is
    // dead again — the allowance can never outlive the code it points at.
    const noTemplate = scanSources([{ path: "synthetic-none.ts", text: "const x = 1;\n" }]);
    expect(deadComposeEntries(noTemplate, new Set(["CLAUDISH_ENDPOINT_TOKEN_BUDGET_VLLM_MYIA"])))
      .toEqual(["CLAUDISH_ENDPOINT_TOKEN_BUDGET_VLLM_MYIA"]);
    // Detector liveness on a synthetic source (same shape as the module read).
    const synthetic = scanSources([
      {
        path: "synthetic-endpoint-budget.ts",
        text: 'const raw = env[`CLAUDISH_ENDPOINT_TOKEN_BUDGET_${suffix}`] ?? "";\n',
      },
    ]);
    expect(synthetic.dynamicEndpointBudget).toBe(true);
  });

  test("positive control: the bracket read shape is live (synthetic fixture)", () => {
    // Zero production sites use process.env["CLAUDISH_…"] today — without this
    // fixture the bracket regex could rot until the first real bracket read
    // ships unpinned.
    const synthetic = scanSources([
      { path: "synthetic-bracket.ts", text: `const v = process.env["CLAUDISH_BRACKET_FIXTURE"] ?? "";\n` },
    ]);
    expect(synthetic.staticReads.has("CLAUDISH_BRACKET_FIXTURE")).toBe(true);
  });

  test("every env name the code reads is injected or exempted (#310 AC1)", () => {
    const gaps = coverageGaps(scan, composeNames);
    const detail = gaps.map((g) => {
      const where = scan.staticReads.get(g) ?? ["(dynamic role-family read)"];
      const exempt = EXEMPT.find((e) => e.name === g);
      return `  ${g} — read at ${where.join(", ")}${exempt ? ` (exempt: ${exempt.why})` : ""}`;
    });
    expect(gaps).toEqual([], `names read in code but absent from docker-compose.yml environment:\n${detail.join("\n")}\n(the env file only interpolates — these never reach a container; add them to compose or to EXEMPT with a reason)`);
  });

  test("every CLAUDISH_* compose entry is read by the code (no dead knobs)", () => {
    const dead = deadComposeEntries(scan, composeNames);
    expect(dead).toEqual([], `compose entries the code never reads (renamed knob? stale line?):\n  ${dead.join("\n  ")}`);
  });

  test("no stale exemptions — every EXEMPT name is still read somewhere", () => {
    // An exemption that no longer corresponds to a read is how a future gap
    // hides: the name would be skipped forever for a reason that no longer
    // exists. Each must anchor to a live read.
    const stale = EXEMPT.filter((e) => !scan.staticReads.has(e.name));
    expect(stale.map((e) => e.name)).toEqual([], `exemptions whose read disappeared (rename? deletion?) — remove them:\n${stale.map((e) => `  ${e.name} — ${e.why}`).join("\n")}`);
  });

  test("empty-string safety: no compose-injected name is read with `?? <non-empty>` (#310 review)", () => {
    // compose injects every listed name as "" — for those names "" must behave
    // like unset, and `?? nonEmpty` is the one read shape where it does not.
    // First real catch (pre-fix tree, this PR): openrouter.ts:21
    // CLAUDISH_CATALOG_URL ?? FIREBASE_CATALOG_URL ?? "https://…cloudfunctions…".
    const traps = emptyUnsafeNullishReads(files, composeNames);
    expect(traps).toEqual([], `compose injects these names as "" — a ?? whose effective RHS is not "" makes "" a live value:\n${traps.map((t) => `  ${t.name} — ?? ${t.rhs} (${t.where})`).join("\n")}`);
  });

  test("positive control: the empty-string trap detector fires on the pre-fix openrouter shape", () => {
    // This IS openrouter.ts:20-23 as it stood before this PR's fix — the ?? chain
    // over two env reads ending in the cloudfunctions URL, the guard's first real
    // catch (run red on the unfixed tree before the fix landed). The empty-RHS
    // read next to it must NOT be flagged.
    const preFixShape = [
      {
        path: "prefix-openrouter.ts",
        text: [
          "const FIREBASE_CATALOG_URL =",
          "  process.env.CLAUDISH_CATALOG_URL ??",
          "  process.env.FIREBASE_CATALOG_URL ??",
          '  "https://us-central1-claudish-6da10.cloudfunctions.net/queryModels?status=active&catalog=slim&limit=1000";',
          "",
        ].join("\n"),
      },
      {
        path: "prefix-safe.ts",
        text: 'const raw = (env.CLAUDISH_CAPABILITY_QUERY_MAX_ASKS ?? "").trim();\n',
      },
    ];
    const names = new Set(["CLAUDISH_CATALOG_URL", "CLAUDISH_CAPABILITY_QUERY_MAX_ASKS"]);
    const traps = emptyUnsafeNullishReads(preFixShape, names);
    expect(traps.length).toBe(1);
    expect(traps[0].name).toBe("CLAUDISH_CATALOG_URL");
    expect(traps[0].where).toBe("prefix-openrouter.ts:2");
    expect(traps[0].rhs).toContain("cloudfunctions.net");
  });

  test("positive control (mutation): the gap checker reports a name the compose lacks", () => {
    // Synthetic fixture: the real compose minus one #310 knob. The checker
    // must name it — proving the verdict function can fail, not just return [].
    const gutted = composeText.replace(
      /^\s*- CLAUDISH_FIRST_EVENT_TIMEOUT_MS=\$\{CLAUDISH_FIRST_EVENT_TIMEOUT_MS:-\}\r?\n/m,
      ""
    );
    const gaps = coverageGaps(scan, composeEnvNames(gutted));
    expect(gaps).toContain("CLAUDISH_FIRST_EVENT_TIMEOUT_MS");
    // And the direction-2 checker on a synthetic name nothing reads.
    const withGhost = composeText + "      - CLAUDISH_GHOST_KNOB=${CLAUDISH_GHOST_KNOB:-}\n";
    expect(deadComposeEntries(scan, composeEnvNames(withGhost))).toContain("CLAUDISH_GHOST_KNOB");
  });
});
