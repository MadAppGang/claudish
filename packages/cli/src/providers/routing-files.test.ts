import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const ROUTING_MODULES = new Set([
  "routing-rules",
  "route-candidates",
  "catalog-client",
  "all-models-cache",
  "catalog-reachability",
  "bundled-list",
  "default-provider",
]);
const ROUTING_CALL = /(?<!\.)\b(?:route|explainRoute)\s*\(/g;
const CATALOG_READER = /\b(?:readAllModelsCache|getCatalogEntries)\b/;
const NON_SOURCE_DIRS = new Set(["test-fixtures", "fixtures", "test-helpers"]);

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return NON_SOURCE_DIRS.has(entry.name) ? [] : files(path);
    return /\.tsx?$/.test(entry.name) &&
      !/\.test(?:-helper)?\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
      ? [path]
      : [];
  });
}

function isRoutingDeclaration(source: string, afterOpenParen: number): boolean {
  // Declaration parameters end at a body; transpiled call expressions do not.
  let depth = 1;
  let quote = "";
  for (let index = afterOpenParen; index < source.length; index++) {
    const char = source[index]!;
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth--;
      if (depth === 0) return /^\s*\{/.test(source.slice(index + 1));
    }
  }
  return false;
}

function routingReasons(source: string, loader: "ts" | "tsx"): string[] {
  const transpiler = new Bun.Transpiler({ loader });
  // An executable header is not a value import or a routing call.
  const moduleSource = source.replace(/^#![^\r\n]*(?:\r?\n|$)/, "");
  const imports = transpiler.scanImports(moduleSource);
  const reasons: string[] = [];
  for (const entry of imports) {
    const basename = entry.path
      .split("/")
      .at(-1)!
      .replace(/\.(?:[cm]?[jt]sx?)$/, "");
    if (ROUTING_MODULES.has(basename)) reasons.push(`value import ${entry.path}`);
  }
  const emitted = transpiler.transformSync(moduleSource);
  const hasRoutingCall = Array.from(emitted.matchAll(ROUTING_CALL)).some(
    (match) => !isRoutingDeclaration(emitted, match.index! + match[0].length)
  );
  if (hasRoutingCall || CATALOG_READER.test(emitted))
    reasons.push("routing call or catalog-reader identifier");
  return reasons;
}

// dorny/paths-filter's routing entry is a YAML sequence of path strings. Fail
// rather than silently treating an unreadable or empty filter as no routing.
function routingPatterns(text: string): string[] {
  const block = text.split(/\r?\n/);
  let inRouting = false;
  const result: string[] = [];
  for (const line of block) {
    if (/^routing:\s*(?:#.*)?$/.test(line)) {
      inRouting = true;
      continue;
    }
    if (inRouting && /^\S/.test(line) && !line.trimStart().startsWith("#")) break;
    if (!inRouting) continue;
    const match = line.match(/^\s+-\s+(?:'([^']+)'|"([^"]+)"|([^#]+?))\s*(?:#.*)?$/);
    if (match) result.push((match[1] ?? match[2] ?? match[3]!).trim());
  }
  if (result.length === 0) throw new Error("routing filter contains no readable routing patterns");
  return result;
}
const matches = (path: string, patterns: readonly string[]) => {
  const positives = patterns.filter((pattern) => !pattern.startsWith("!"));
  const negatives = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1));
  return (
    positives.some((pattern) => new Bun.Glob(pattern).match(path)) &&
    !negatives.some((pattern) => new Bun.Glob(pattern).match(path))
  );
};

type WorkflowStep = {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "working-directory"?: string;
  "continue-on-error"?: boolean | string;
};
function forkGuard() {
  const repo = resolve(import.meta.dir, "../../../..");
  return Bun.YAML.parse(
    readFileSync(join(repo, ".github/workflows/routing-fork-guard.yml"), "utf8")
  ) as {
    on: Record<string, unknown>;
    jobs: Record<
      string,
      {
        permissions: Record<string, string>;
        steps: WorkflowStep[];
      }
    >;
  };
}
const expression = (value: string) => "$" + "{{ " + value + " }}";

describe("REQ-108 R4.2: routing-fork-guard/verdict commit status", () => {
  test("REQ-108: the base-branch guard owns statuses:write and never checks out the head", () => {
    const workflow = forkGuard();
    expect(Object.keys(workflow.on)).toContain("pull_request_target");
    expect(Object.keys(workflow.on)).not.toContain("pull_request");
    const guard = workflow.jobs.guard!;
    expect(guard.permissions.statuses).toBe("write");
    const checkouts = guard.steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]!.with?.ref).toBe(expression("github.event.pull_request.base.sha"));
    expect(checkouts[0]!.with?.["sparse-checkout"]).toBe(".github/routing-files.yml");
    expect(checkouts[0]!.with?.["persist-credentials"]).toBe(false);
  });

  test("REQ-108: the final non-cancelled step posts the required context to the PR head", () => {
    const steps = forkGuard().jobs.guard!.steps;
    const post = steps.at(-1)!;
    expect(post.if).toBe(expression("!cancelled()"));
    expect(post.env).toMatchObject({
      GH_TOKEN: expression("github.token"),
      HEAD_SHA: expression("github.event.pull_request.head.sha"),
      OUTCOME: expression("steps.check.outcome"),
    });
    expect(post.env?.RUN_URL).toBe(
      expression("github.server_url") +
        "/" +
        expression("github.repository") +
        "/actions/runs/" +
        expression("github.run_id")
    );
    expect(post.run).toMatch(
      /gh api\s+--method POST\s+"repos\/\$GITHUB_REPOSITORY\/statuses\/\$HEAD_SHA"/
    );
    expect(post.run).toContain('context="routing-fork-guard/verdict"');
    expect(post.run).toContain('state="$state"');
    expect(post.run).toContain('description="$description"');
    expect(post.run).toContain('target_url="$RUN_URL"');
    expect(JSON.stringify(post)).not.toContain("secrets.");
  });

  test("REQ-108: a failed or skipped check posts failure, never a successful verdict", () => {
    const steps = forkGuard().jobs.guard!.steps;
    expect(steps.some((step) => step.id === "check")).toBe(true);
    const script = steps.at(-1)!.run!;
    expect(script).toMatch(
      /if\s+\[\s+"\$OUTCOME"\s+=\s+"success"\s+\];\s*then\s+state=success\b[\s\S]*?\belse\s+state=failure\b[\s\S]*?\bfi/
    );
    expect(script).toContain("set -euo pipefail");
  });
});

describe("R4.2 RB-16 RB-27: routing review filter is complete", () => {
  test("R4.2: every value importer and routing call site is covered by the CI routing filter", () => {
    // Paths are resolved only when this test runs in packages/cli/src/providers.
    const src = resolve(import.meta.dir, "..");
    const repo = resolve(src, "../../..");
    const patterns = routingPatterns(readFileSync(join(repo, ".github/routing-files.yml"), "utf8"));
    const uncovered = files(src).flatMap((path) => {
      const reasons = routingReasons(
        readFileSync(path, "utf8"),
        path.endsWith(".tsx") ? "tsx" : "ts"
      );
      const repoPath = relative(repo, path).split("\\").join("/");
      return reasons.length && !matches(repoPath, patterns) ? [{ file: repoPath, reasons }] : [];
    });
    expect(uncovered).toEqual([]);
    expect(matches("packages/cli/src/proxy-server.ts", patterns)).toBe(true);
  });

  test("RB-27 R4.2: dispatcher and every pinned-model entry point remain in the filter", () => {
    const repo = resolve(import.meta.dir, "../../../..");
    const patterns = routingPatterns(readFileSync(join(repo, ".github/routing-files.yml"), "utf8"));
    for (const name of [
      "proxy-server.ts",
      "index.ts",
      "cli.ts",
      "mcp-server.ts",
      "claude-runner.ts",
      "mcp-session/session-manager.ts",
      "mcp-session/types.ts",
      "team-orchestrator.ts",
      "pane/child-env.ts",
      "pane/pane-launch.ts",
      "pane/pane-session.ts",
      "recommended-listing.ts",
      "probe/probe-chain.ts",
      "auth/credentials/prehydrate.ts",
      "tui/components/RoutingContent.tsx",
    ])
      expect(matches(`packages/cli/src/${name}`, patterns)).toBe(true);
    for (const name of [
      "ai-docs/architecture/routing-rulebook.md",
      "ai-docs/architecture/routing.md",
      "packages/cli/scripts/generate-bundled-list.ts",
      ".github/routing-files.yml",
      ".github/workflows/routing-rulebook.yml",
      ".github/workflows/routing-fork-guard.yml",
      ".github/workflows/routing-review-release.yml",
      ".github/workflows/release.yml",
    ])
      expect(matches(name, patterns)).toBe(true);
  });

  test("R4.2: scanner ignores comments and type-only imports but catches a live value reference", () => {
    expect(
      routingReasons('// route("x"); readAllModelsCache();\nexport const ordinary = 1;', "ts")
    ).toEqual([]);
    expect(
      routingReasons(
        'import type { Route } from "./routing-rules.js"; export type T = Route;',
        "ts"
      )
    ).toEqual([]);
    expect(
      routingReasons('import { route } from "./routing-rules.js"; export const run = route;', "ts")
        .length
    ).toBeGreaterThan(0);
    expect(routingReasons("export const read = readAllModelsCache;", "ts")).toContain(
      "routing call or catalog-reader identifier"
    );
    expect(routingReasons("export const read = getCatalogEntries;", "ts")).toContain(
      "routing call or catalog-reader identifier"
    );
    expect(
      routingReasons('export function run() { return explainRoute("x"); }', "ts").length
    ).toBeGreaterThan(0);
    expect(
      routingReasons('export const A = () => <div>{route("x")}</div>;', "tsx").length
    ).toBeGreaterThan(0);
    expect(
      routingReasons(
        '#!/usr/bin/env bun\nimport { route } from "./routing-rules.js"; export const run = route;',
        "ts"
      ).length
    ).toBeGreaterThan(0);
    expect(
      routingReasons('#!/usr/bin/env bun\n// route("x");\nexport const ordinary = 1;', "ts")
    ).toEqual([]);
  });

  test("R4.2: scanner ignores member route calls but catches bare calls and namespace value imports", () => {
    expect(routingReasons('export function run() { return this.route("x"); }', "ts")).toEqual([]);
    expect(
      routingReasons(
        'export const run = (x: { route(value: string): string }) => x.route("x");',
        "ts"
      )
    ).toEqual([]);
    expect(routingReasons('export function run() { return route("x"); }', "ts")).toContain(
      "routing call or catalog-reader identifier"
    );
    expect(
      routingReasons(
        'import * as routing from "./routing-rules.js"; export const run = () => routing.route("x");',
        "ts"
      )
    ).toContain("value import ./routing-rules.js");
  });

  test.each(["route", "explainRoute"])(
    "R4.2: scanner ignores a private %s method declaration called through this",
    (name) => {
      const source = `export class Ordinary {
        private ${name}(x = String(")")) { return x; }
        run(x: string) { return this.${name}(x); }
      }`;

      expect(routingReasons(source, "ts")).toEqual([]);
    }
  );

  test.each(["route", "explainRoute"])(
    "R4.2: scanner ignores a function declaration named %s",
    (name) => {
      const source = `export function ${name}(x: string) { return x; }`;

      expect(routingReasons(source, "ts")).toEqual([]);
    }
  );

  test.each(["route", "explainRoute"])(
    "R4.2: scanner flags a bare %s call even when that function is declared locally",
    (name) => {
      const source = `export function ${name}(x: string) { return x; }
        export const run = () => ${name}("x");`;

      expect(routingReasons(source, "ts")).toEqual(["routing call or catalog-reader identifier"]);
    }
  );

  test.each(["route", "explainRoute"])(
    "R4.2: scanner flags a bare call inside a %s declaration body",
    (name) => {
      const source = `export class Ordinary {
        private ${name}(x: string) { return route(x); }
        run(x: string) { return this.${name}(x); }
      }`;

      expect(routingReasons(source, "ts")).toEqual(["routing call or catalog-reader identifier"]);
    }
  );

  test("R4.2: a new uncovered routing file is detected by the scanner (negative control)", () => {
    const source =
      'import { route } from "./providers/routing-rules.js"; export const invoke = route;';
    const path = "packages/cli/src/new-routing-entry.ts";
    expect(routingReasons(source, "ts").length).toBeGreaterThan(0);
    expect(matches(path, ["packages/cli/src/providers/**"])).toBe(false);
    expect(matches(path, ["packages/cli/src/**"])).toBe(true);
  });
});

describe("routing rulebook review executable", () => {
  function reviewSteps() {
    const repo = resolve(import.meta.dir, "../../../..");
    const workflow = Bun.YAML.parse(
      readFileSync(join(repo, ".github/workflows/routing-rulebook.yml"), "utf8")
    ) as { jobs: { review: { steps: WorkflowStep[] } } };
    return workflow.jobs.review.steps;
  }

  function installStep() {
    const step = reviewSteps().find((entry) => entry.id === "claude");
    if (!step) throw new Error("review job has no claude step");
    return step;
  }

  test("review uses the executable path from the claude step", () => {
    const review = reviewSteps().find((step) => step.id === "review");
    expect(review?.with?.path_to_claude_code_executable).toBe(
      expression("steps.claude.outputs.path")
    );
  });

  test("claude step precedes the review step in the same job", () => {
    const steps = reviewSteps();
    const installIndex = steps.findIndex((step) => step.id === "claude");
    const reviewIndex = steps.findIndex((step) => step.id === "review");

    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(reviewIndex).toBeGreaterThan(installIndex);
  });

  test("claude step runs under the same condition as the review step", () => {
    const review = reviewSteps().find((step) => step.id === "review");
    expect(review?.if).toBeDefined();
    expect(installStep().if).toBe(review?.if);
  });

  test("claude step installs the exact pinned version", () => {
    const step = installStep();
    expect(String(step.env?.CLAUDE_CODE_VERSION)).toMatch(/^\d+\.\d+\.\d+$/);
    expect(step.run).toMatch(
      /\bnpm[ \t]+install\b[^\n]*[ \t]"?@anthropic-ai\/claude-code@\$CLAUDE_CODE_VERSION\b/
    );
    expect(step.run).not.toContain("@latest");
  });

  // The action installs its own Claude Code version when it gets no path. The step must
  // install that same version, so a new action commit needs a new version beside it here.
  test("claude step version matches the pinned action commit", () => {
    const review = reviewSteps().find((step) => step.id === "review");
    expect({
      action: review?.uses,
      version: String(installStep().env?.CLAUDE_CODE_VERSION),
    }).toEqual({
      action: "anthropics/claude-code-action@61a9c274fa7110a66dfafc1bbbced03833eb25fe",
      version: "2.1.319",
    });
  });

  test("claude step gives every timeout a kill-after grace period", () => {
    const script = installStep().run ?? "";
    const calls = [...script.matchAll(/\btimeout[ \t]+/g)];
    const forced = [...script.matchAll(/\btimeout[ \t]+(?:-k[ \t]+|--kill-after=)\d+/g)];

    expect(calls.length).toBeGreaterThan(0);
    expect(forced).toHaveLength(calls.length);
  });

  test("claude step does not reference credentials", () => {
    const step = installStep();
    for (const value of [...Object.values(step.env ?? {}), step.run ?? ""]) {
      expect(String(value)).not.toMatch(/secrets\.|github\.token/);
    }
  });

  test("claude step runs in the runner temporary directory", () => {
    expect(installStep()["working-directory"]).toBe(expression("runner.temp"));
  });

  test("claude step limits npm install to 30 seconds and allows install scripts", () => {
    const script = installStep().run ?? "";
    const installs = [...script.matchAll(/\bnpm[ \t]+install\b/g)];
    const boundedInstalls = [
      ...script.matchAll(
        /\btimeout[ \t]+(?:(?:-k[ \t]+|--kill-after=)\d+s?[ \t]+)?(\d+)s?[ \t]+npm[ \t]+install\b/g
      ),
    ];

    expect(installs.length).toBeGreaterThan(0);
    expect(boundedInstalls).toHaveLength(installs.length);
    for (const [, seconds] of boundedInstalls) {
      expect(Number(seconds)).toBeGreaterThan(0);
      expect(Number(seconds)).toBeLessThanOrEqual(30);
    }
    expect(script).not.toContain("--ignore-scripts");
  });

  test("claude step has a total timeout budget of at most 20 seconds", () => {
    const script = installStep().run ?? "";
    const calls = [...script.matchAll(/\btimeout[ \t]+/g)];
    const durations = [
      ...script.matchAll(
        /\btimeout[ \t]+(?:(?:-k[ \t]+|--kill-after=)\d+(?:\.\d+)?s?[ \t]+)?(\d+(?:\.\d+)?)s?(?=[ \t])/g
      ),
    ];

    expect(calls.length).toBeGreaterThan(0);
    expect(durations).toHaveLength(calls.length);
    expect(
      durations.reduce((total, [, seconds]) => total + Number(seconds), 0)
    ).toBeLessThanOrEqual(20);
  });

  test.each([
    { name: "publishes the path after a matching version", install: "ok", version: "match" },
    { name: "warns when npm fails", install: "fail", version: "match" },
    { name: "warns when the install times out", install: "timeout", version: "match" },
    { name: "warns when the version differs", install: "ok", version: "mismatch" },
    { name: "warns when the version command fails", install: "ok", version: "fail" },
  ])("claude step $name", ({ install, version }) => {
    const step = installStep();
    if (!step.run || !step.env?.CLAUDE_CODE_VERSION) {
      throw new Error("claude step needs a run script and pinned version");
    }
    const dir = mkdtempSync(join(tmpdir(), "rulebook-install-"));
    try {
      const bin = join(dir, "bin");
      const output = join(dir, "output");
      const prefix = join(dir, "claude-code");
      mkdirSync(bin);
      writeFileSync(output, "");
      const stub = (name: string, body: string) =>
        writeFileSync(join(bin, name), "#!/bin/bash\nset -eu\n" + body, { mode: 0o755 });

      stub(
        "timeout",
        [
          'case "$1" in -k) shift 2 ;; --kill-after=*) shift ;; esac',
          "shift",
          'if [[ "$1" == npm && "$STUB_INSTALL" == timeout ]]; then exit 124; fi',
          "export STUB_BOUNDED=1",
          'exec "$@"',
        ].join("\n")
      );
      stub(
        "npm",
        [
          '[[ "${STUB_BOUNDED:-}" == 1 && "$1" == install && "$2" == --prefix ]] || exit 1',
          '[[ "$3" == "$RUNNER_TEMP/claude-code" && "$STUB_INSTALL" != fail ]] || exit 1',
          'mkdir -p "$3/node_modules/.bin"',
          'cp "$PATH_STUBS/claude-version" "$3/node_modules/.bin/claude"',
        ].join("\n")
      );
      stub(
        "claude-version",
        [
          '[[ "$STUB_BOUNDED" == 1 && "$#" == 1 && "$1" == --version ]]',
          'version="$CLAUDE_CODE_VERSION"',
          'if [[ "$STUB_VERSION" == mismatch ]]; then version="0.$version"; fi',
          'printf "%s (Claude Code)\n" "$version"',
          '[[ "$STUB_VERSION" != fail ]]',
        ].join("\n")
      );

      const result = Bun.spawnSync(
        ["/bin/bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", step.run],
        {
          cwd: dir,
          env: {
            ...Object.fromEntries(
              Object.entries(step.env).map(([key, value]) => [key, String(value)])
            ),
            PATH: bin + ":/usr/bin:/bin",
            PATH_STUBS: bin,
            RUNNER_TEMP: dir,
            GITHUB_OUTPUT: output,
            STUB_INSTALL: install,
            STUB_VERSION: version,
          },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const stdout = result.stdout.toString();
      const written = readFileSync(output, "utf8");
      expect(result.exitCode).toBe(0);
      if (install === "ok" && version === "match") {
        expect(written).toBe("path=" + join(prefix, "node_modules/.bin/claude") + "\n");
        expect(stdout).not.toMatch(/^::warning::/m);
      } else {
        expect(written).not.toMatch(/^path=/m);
        expect(stdout).toMatch(/^::warning::/m);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("claude step writes the path output without continuing on error", () => {
    const step = installStep();
    expect(String(step["continue-on-error"])).not.toBe("true");
    expect(step.run).toMatch(
      /\b(?:echo|printf)[ \t]+[^\n]*\bpath=[^\n]*>>?[ \t]*"?\$GITHUB_OUTPUT\b/
    );
  });
});
