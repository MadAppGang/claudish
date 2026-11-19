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
  | "claude-code-installer"
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
// The standalone installer and release downloads of the Claude Code binary.
const INSTALLER =
  /https?:\/\/[^\s'"]*?(claude\.ai\/install|downloads\.claude\.ai|claude-code[^\s'"]*\/releases?\/|claude-code-releases)/i;
// `secrets.NAME` or `secrets['NAME']` / `secrets["NAME"]`, any case: GitHub contexts are
// case-insensitive.
const SECRETS =
  /\bsecrets\s*(?:\.\s*(?:ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)\b|\[\s*(['"])(?:ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)\1\s*\])/i;
// A `${{ }}` expression: GitHub expands it before the shell runs, shell comments included.
const EXPRESSION = /\$\{\{[\s\S]*?\}\}/g;
// The local scripts that download, boot or run Claude Code, and the package scripts that start
// them; a workflow that starts one runs it.
const SCRIPTS =
  /(\bscripts\/(boot-canary|routing-review|test-macos|weekly-macos-tests)\.ts\b|\b(review:routing|test:macos)(?![\w:-]))/;
// Shells whose `-c` argument is itself a command line.
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
// `<shell> [options] -c '<command line>'` and `eval '<command line>'`, quoted.
const NESTED_COMMAND =
  /(?:^|[\s;&|(])(?:(?:\S*\/)?(?:bash|sh|zsh|dash)\s+(?:-\w+\s+)*-\w*c\w*|eval)\s+(['"])(.*?)\1/g;
// Words that come before the command word without being the command.
const WRAPPERS = new Set([
  "sudo",
  "npx",
  "bunx",
  "exec",
  "command",
  "eval",
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
const ENV_OPTIONS_WITH_VALUE = new Set(["-u", "--unset", "-C", "--chdir"]);

function clip(text: string): string {
  const one = text.trim().replace(/\s+/g, " ");
  return one.length > 120 ? `${one.slice(0, 117)}...` : one;
}

function unquote(word: string): string {
  return word.replace(/^["']+|["']+$/g, "");
}

/** The command word of one simple command, after assignments and wrappers. */
/** The index after the options starting at `i`; an option in `withValue` also takes the next word. */
function skipOptions(words: string[], i: number, withValue: Set<string>): number {
  let j = i;
  while (j < words.length && words[j].startsWith("-")) j += withValue.has(words[j]) ? 2 : 1;
  return j;
}

/** Where the command starts after `bash -c` (index past `-c`), or undefined for no `-c`. */
function afterShellCommandOption(words: string[], i: number): number | undefined {
  let j = i + 1;
  while (j < words.length && /^-\w+$/.test(words[j]) && !/^-\w*c\w*$/.test(words[j])) j++;
  return j < words.length && /^-\w*c\w*$/.test(words[j]) ? j + 1 : undefined;
}

/**
 * The command word of one simple command, after assignments and wrappers, as a path's basename:
 * `/bin/bash`, `/usr/bin/env` and `/usr/local/bin/claude` read as `bash`, `env` and `claude`.
 */
function commandWord(segment: string): string | undefined {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length) {
    const word = unquote(words[i].replace(/^\(+/, ""));
    const base = word.split("/").pop() ?? word;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || WRAPPERS.has(base)) {
      i++;
    } else if (base === "env") {
      // `env [-i] [-u NAME] [-S] [NAME=value]... command`; `-S`'s string is the command line.
      i = skipOptions(words, i + 1, ENV_OPTIONS_WITH_VALUE);
    } else if (SHELLS.has(base) && afterShellCommandOption(words, i) !== undefined) {
      // `bash -c <command line>`: the command line's first word is the command.
      i = afterShellCommandOption(words, i) as number;
    } else if (base === "timeout") {
      i = skipOptions(words, i + 1, TIMEOUT_OPTIONS_WITH_VALUE) + 1; // past the duration
    } else {
      return base;
    }
  }
  return undefined;
}

function stripShellComment(line: string): string {
  return line.replace(/(^|\s)#.*$/, "");
}

function runsClaude(run: string, depth = 0): string | undefined {
  for (const line of run.split("\n")) {
    const code = stripShellComment(line);
    for (const segment of code.split(/&&|\|\||;|\||\$\(|`/)) {
      const word = commandWord(segment);
      if (word === "claude" || word?.endsWith("/claude")) return line;
    }
    // A quoted `-c` or `eval` argument is a command line of its own; parse it as one.
    if (depth < 3) {
      for (const match of code.matchAll(NESTED_COMMAND)) {
        if (runsClaude(match[2], depth + 1) !== undefined) return line;
      }
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
      // In a `run:` the shell sees only its code; GitHub sees only its `${{ }}` expressions.
      const shellCode = key === "run" ? runCode(value) : value;
      const evaluated = key === "run" ? (value.match(EXPRESSION) ?? []).join("\n") : value;
      if (shellCode.includes(PACKAGE)) add(where, "claude-code-package", value);
      if (INSTALLER.test(shellCode)) add(where, "claude-code-installer", value);
      if (SECRETS.test(evaluated)) add(where, "anthropic-secret", value);
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
    [
      "the API key by bracket access",
      stepYaml("run: echo\n        env:\n          K: ${{ secrets['ANTHROPIC_API_KEY'] }}"),
      "anthropic-secret",
    ],
    [
      "the API key by bracket access with spaces and double quotes",
      stepYaml('run: echo\n        env:\n          K: ${{ secrets[ "ANTHROPIC_API_KEY" ] }}'),
      "anthropic-secret",
    ],
    [
      "the API key in lower case",
      stepYaml("run: echo\n        env:\n          K: ${{ secrets.anthropic_api_key }}"),
      "anthropic-secret",
    ],
    [
      "the OAuth token in mixed case by bracket access",
      stepYaml("run: echo\n        env:\n          K: ${{ SECRETS['Claude_Code_OAuth_Token'] }}"),
      "anthropic-secret",
    ],
    [
      "the API key in an if condition",
      stepYaml("run: echo\n        if: secrets.ANTHROPIC_API_KEY != ''"),
      "anthropic-secret",
    ],
    [
      "the API key in an expression inside a shell comment",
      stepYaml("run: |\n          echo ok # ${{ secrets.ANTHROPIC_API_KEY }}"),
      "anthropic-secret",
    ],
    ["the macOS gate package script", stepYaml("run: bun run test:macos"), "claude-code-script"],
    [
      "the macOS gate package script with flags",
      stepYaml("run: bun run test:macos --full"),
      "claude-code-script",
    ],
    ["the macOS gate script", stepYaml("run: bun scripts/test-macos.ts"), "claude-code-script"],
    [
      "the nightly part runner",
      stepYaml("run: bun scripts/weekly-macos-tests.ts --part 1/7"),
      "claude-code-script",
    ],
    ["claude inside bash -c", stepYaml("run: bash -c 'claude -p hi'"), "claude-command"],
    ["claude inside sh -c", stepYaml('run: sh -c "echo x && claude"'), "claude-command"],
    ["claude inside zsh -lc", stepYaml("run: zsh -lc 'FOO=1 claude --version'"), "claude-command"],
    [
      "claude inside dash -c with an option first",
      stepYaml("run: dash -e -c 'cd /tmp; claude -p x'"),
      "claude-command",
    ],
    ["claude after eval", stepYaml("run: eval claude -p hi"), "claude-command"],
    ["claude in an eval string", stepYaml('run: eval "claude -p hi"'), "claude-command"],
    [
      "claude in bash -c inside eval",
      stepYaml("run: eval \"bash -c 'claude -p hi'\""),
      "claude-command",
    ],
    ["claude inside /bin/bash -c", stepYaml("run: /bin/bash -c 'claude -p hi'"), "claude-command"],
    ["claude after /usr/bin/env", stepYaml("run: /usr/bin/env claude --version"), "claude-command"],
    ["claude by its full path", stepYaml("run: /usr/local/bin/claude -p hi"), "claude-command"],
    [
      "claude after env -i and an assignment",
      stepYaml("run: env -i PATH=/usr/local/bin:/usr/bin claude --version"),
      "claude-command",
    ],
    ["claude after env -u NAME", stepYaml("run: env -u HOME claude -p hi"), "claude-command"],
    ["claude in an env -S string", stepYaml("run: env -S 'claude -p hi'"), "claude-command"],
    ["claude after /usr/bin/sudo", stepYaml("run: /usr/bin/sudo claude -p hi"), "claude-command"],
    [
      "the standalone installer piped into bash",
      stepYaml("run: curl -fsSL https://claude.ai/install.sh | bash"),
      "claude-code-installer",
    ],
    [
      "the Windows installer",
      stepYaml("run: irm https://claude.ai/install.ps1 | iex"),
      "claude-code-installer",
    ],
    [
      "a download from downloads.claude.ai",
      stepYaml("run: curl -fsSLO https://downloads.claude.ai/claude-code/stable/linux-x64/claude"),
      "claude-code-installer",
    ],
    [
      "a GitHub release download of claude-code",
      stepYaml(
        "run: curl -LO https://github.com/anthropics/claude-code/releases/download/v2.1.0/claude"
      ),
      "claude-code-installer",
    ],
    [
      "a claude-code-releases bucket download",
      stepYaml(
        "run: curl -O https://storage.googleapis.com/dist/claude-code-releases/2.1.0/claude"
      ),
      "claude-code-installer",
    ],
    [
      "the installer URL as an action input",
      stepYaml(
        "uses: some/download@v1\n        with:\n          url: https://claude.ai/install.sh"
      ),
      "claude-code-installer",
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
    [
      "the package named in a trailing shell comment",
      stepYaml("run: 'echo ok # do not install @anthropic-ai/claude-code'"),
    ],
    [
      "the package named in a shell comment line",
      stepYaml(
        "run: |\n          # Never install @anthropic-ai/claude-code here.\n          echo ok"
      ),
    ],
    [
      "the secret's name as shell text, outside an expression",
      stepYaml('run: echo "secrets.ANTHROPIC_API_KEY is not used here"'),
    ],
    [
      "another secret by bracket access",
      stepYaml("run: echo\n        env:\n          K: ${{ secrets['OPENROUTER_API_KEY'] }}"),
    ],
    ["the macOS gate's own tests", stepYaml("run: bun test scripts/test-macos.test.ts")],
    [
      "the nightly runner's own tests",
      stepYaml("run: bun test scripts/weekly-macos-tests.test.ts"),
    ],
    [
      "the nightly installer",
      stepYaml("run: bun scripts/install-weekly-macos-tests.ts --uninstall"),
    ],
    ["another package script", stepYaml("run: bun run test:macos-bridge")],
    ["bash -c without claude", stepYaml("run: bash -c 'echo claude'")],
    ["bash running a script file", stepYaml("run: bash scripts/check.sh claude")],
    ["eval without claude", stepYaml('run: eval "echo claude"')],
    ["/usr/bin/env running another program", stepYaml("run: /usr/bin/env node claude.js")],
    ["env -i running echo", stepYaml("run: env -i PATH=/usr/bin echo claude")],
    ["env -u NAME running another program", stepYaml("run: env -u claude node x.js")],
    ["/bin/bash running a script file", stepYaml("run: /bin/bash scripts/check.sh claude")],
    ["a program in a directory named for claude", stepYaml("run: /opt/claude/bin/run --x")],
    [
      "a claude.ai page that is not the installer",
      stepYaml("run: curl -fsSL https://claude.ai/docs"),
    ],
    [
      "the claude-code repository page",
      stepYaml("run: curl https://github.com/anthropics/claude-code"),
    ],
    [
      "another project's release download",
      stepYaml("run: curl -LO https://github.com/MadAppGang/magmux/releases/download/v1/x.tar.gz"),
    ],
    [
      "the installer URL in a shell comment",
      stepYaml("run: |\n          # not https://claude.ai/install.sh\n          echo ok"),
    ],
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
