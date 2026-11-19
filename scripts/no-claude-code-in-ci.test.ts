/**
 * No GitHub workflow installs, downloads or runs Claude Code. Claude Code runs only on the
 * local Mac, on the user's own login: the release gate's boot canary (`bun run test:macos`)
 * and the routing review (`bun run review:routing`).
 *
 * The detector parses each workflow as YAML and walks every value, so a YAML comment that
 * names `claude` never matches; only what a runner would act on does.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

type FindingKind =
  | "claude-code-action"
  | "claude-code-package"
  | "anthropic-secret"
  | "claude-command"
  | "claude-code-script";

interface Finding {
  file: string;
  where: string;
  kind: FindingKind;
  text: string;
}

const ACTION = /anthropics\/claude-code-action/;
const PACKAGE = "@anthropic-ai/claude-code";
const SECRETS = /secrets\.(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)\b/;
// The local scripts that spawn Claude Code; a workflow that starts one runs it.
const SCRIPTS = /(\bscripts\/(boot-canary|routing-review)\.ts\b|\breview:routing\b)/;
// Words that come before the command word without being the command.
const WRAPPERS = new Set([
  "sudo",
  "npx",
  "bunx",
  "exec",
  "command",
  "env",
  "time",
  "nohup",
  "!",
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "{",
  "(",
]);
const TIMEOUT_OPTIONS_WITH_VALUE = new Set(["-k", "-s", "--kill-after", "--signal"]);

function clip(text: string): string {
  const one = text.trim().replace(/\s+/g, " ");
  return one.length > 120 ? `${one.slice(0, 117)}...` : one;
}

function unquote(word: string): string {
  return word.replace(/^["']+|["']+$/g, "");
}

/** The command word of one simple command, after assignments and wrappers. */
function commandWord(segment: string): string | undefined {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || WRAPPERS.has(word)) {
      i++;
      continue;
    }
    if (word === "timeout") {
      i++;
      while (i < words.length && words[i].startsWith("-")) {
        i += TIMEOUT_OPTIONS_WITH_VALUE.has(words[i]) ? 2 : 1;
      }
      i++; // the duration
      continue;
    }
    return unquote(word.replace(/^\(+/, ""));
  }
  return undefined;
}

function stripShellComment(line: string): string {
  return line.replace(/(^|\s)#.*$/, "");
}

function runsClaude(run: string): string | undefined {
  for (const line of run.split("\n")) {
    const code = stripShellComment(line);
    for (const segment of code.split(/&&|\|\||;|\||\$\(|`/)) {
      const word = commandWord(segment);
      if (word === "claude" || word?.endsWith("/claude")) return line;
    }
  }
  return undefined;
}

function runCode(run: string): string {
  return run.split("\n").map(stripShellComment).join("\n");
}

/** Every Claude Code use in one workflow file's text. */
function claudeCodeFindings(file: string, yamlText: string): Finding[] {
  const findings: Finding[] = [];
  const add = (where: string, kind: FindingKind, text: string) =>
    findings.push({ file, where, kind, text: clip(text) });

  const visit = (value: unknown, where: string, key: string | undefined) => {
    if (typeof value === "string") {
      if (key === "uses" && ACTION.test(value)) add(where, "claude-code-action", value);
      if (value.includes(PACKAGE)) add(where, "claude-code-package", value);
      if (SECRETS.test(value)) add(where, "anthropic-secret", value);
      if (key === "run") {
        const line = runsClaude(value);
        if (line !== undefined) add(where, "claude-command", line);
        if (SCRIPTS.test(runCode(value))) add(where, "claude-code-script", value);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${where}[${index}]`, undefined));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (SECRETS.test(k)) add(where ? `${where}.${k}` : k, "anthropic-secret", k);
        visit(v, where ? `${where}.${k}` : k, k);
      }
    }
  };

  visit(Bun.YAML.parse(yamlText), "", undefined);
  return findings;
}

function kindsOf(yamlText: string): FindingKind[] {
  return [...new Set(claudeCodeFindings("t.yml", yamlText).map((f) => f.kind))];
}

function stepYaml(step: string): string {
  return `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - ${step}\n`;
}

const WORKFLOWS = resolve(import.meta.dir, "..", ".github", "workflows");

describe("no GitHub workflow uses Claude Code", () => {
  test("every workflow file is free of Claude Code", () => {
    const files = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));
    expect(files.length).toBeGreaterThan(0);
    const findings = files.flatMap((name) =>
      claudeCodeFindings(`.github/workflows/${name}`, readFileSync(join(WORKFLOWS, name), "utf8"))
    );
    if (findings.length > 0) {
      throw new Error(
        `Claude Code found in GitHub workflows:\n${findings
          .map((f) => `${f.file}: ${f.where}: ${f.kind}: ${f.text}`)
          .join("\n")}`
      );
    }
  });
});

describe("the detector finds each kind", () => {
  const cases: [string, string, FindingKind][] = [
    [
      "a step using claude-code-action",
      stepYaml("uses: anthropics/claude-code-action@abc123"),
      "claude-code-action",
    ],
    [
      "a step using its base-action",
      stepYaml("uses: anthropics/claude-code-action/base-action@abc123"),
      "claude-code-action",
    ],
    [
      "a job using it as a reusable workflow",
      "on: push\njobs:\n  a:\n    uses: anthropics/claude-code-action/.github/workflows/x.yml@abc\n",
      "claude-code-action",
    ],
    [
      "an npm install of the package",
      stepYaml("run: npm install -g @anthropic-ai/claude-code@2.1.0"),
      "claude-code-package",
    ],
    [
      "an npm pack of a per-platform package",
      stepYaml("run: npm pack @anthropic-ai/claude-code-linux-x64"),
      "claude-code-package",
    ],
    [
      "the API key in a step env",
      stepYaml("run: echo hi\n        env:\n          K: ${{ secrets.ANTHROPIC_API_KEY }}"),
      "anthropic-secret",
    ],
    [
      "the API key as an action input",
      stepYaml(
        "uses: some/action@v1\n        with:\n          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}"
      ),
      "anthropic-secret",
    ],
    [
      "the OAuth token in a job env",
      "on: push\njobs:\n  a:\n    runs-on: x\n    env:\n      T: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}\n    steps:\n      - run: echo\n",
      "anthropic-secret",
    ],
    ["claude as the command", stepYaml("run: claude -p hi"), "claude-command"],
    [
      "claude behind an assignment and timeout",
      stepYaml("run: FOO=1 timeout -k 5 60 claude --version"),
      "claude-command",
    ],
    ["claude after &&", stepYaml("run: echo x && claude"), "claude-command"],
    ["claude by a quoted path", stepYaml("run: '\"$D/claude\" --version'"), "claude-command"],
    [
      "claude on a later line",
      stepYaml("run: |\n          set -e\n          claude -p x"),
      "claude-command",
    ],
    [
      "the boot canary script",
      stepYaml("run: bun scripts/boot-canary.ts --bin x"),
      "claude-code-script",
    ],
    [
      "the routing review script",
      stepYaml("run: bun scripts/routing-review.ts"),
      "claude-code-script",
    ],
    [
      "the routing review package script",
      stepYaml("run: bun run review:routing"),
      "claude-code-script",
    ],
  ];

  for (const [name, yaml, kind] of cases) {
    test(name, () => {
      expect(kindsOf(yaml)).toEqual([kind]);
    });
  }
});

describe("the detector leaves clean workflows alone", () => {
  const clean: [string, string][] = [
    ["a YAML comment", `# claude -p hi\n${stepYaml("run: echo ok")}`],
    ["a shell comment", stepYaml("run: bun run build:cli # needs claude?")],
    ["the pin file read", stepYaml("run: cat .github/claude-code.version")],
    ["claudish", stepYaml("run: claudish --version")],
    ["claude as an argument", stepYaml('run: echo "claude"')],
    ["a path that only contains claude", stepYaml("run: ls packages/claude-thing")],
    ["a test run named for the canary", stepYaml("run: bun test scripts/boot-canary.test.ts")],
  ];

  for (const [name, yaml] of clean) {
    test(name, () => {
      expect(claudeCodeFindings("t.yml", yaml)).toEqual([]);
    });
  }

  test("commandWord skips assignments and wrappers", () => {
    expect(commandWord("A=1 B=2 sudo timeout --signal TERM 5 claude -p")).toBe("claude");
    expect(commandWord("  bunx claudish")).toBe("claudish");
    expect(commandWord("")).toBeUndefined();
  });
});
