/**
 * Whether a Bash command only prints files. Its output is the files' text,
 * which the model needs verbatim to edit them, the same as a Read: compressed,
 * the model prints the file again to find the exact text.
 *
 * The rule is an allowlist. The command is split, outside quotes, into
 * segments on `;`, `&&`, `||` and newlines, and each segment into stages on
 * `|`. It is a file print when every segment is harmless and at least one
 * prints a file:
 *
 * - a segment PRINTS a file when its first stage is a printer with a file
 *   operand (`cat`, `nl`, `head`, `tail`, `bat`, `less`, `more`, `sed -n` with
 *   a `p` script) and every later stage is a printer with no operand
 *   (`cat f | head -60`);
 * - a segment is HARMLESS when every stage is a printer or a locator (`cd`,
 *   `pwd`, `echo`, `ls`, `wc`, `grep`, `egrep`, `rg`, `sort`, `uniq`, `cut`).
 *
 * Anything else makes it not a file print, so its output is compressed as
 * before: any other program (a test runner, a build), a redirection other
 * than `2>/dev/null` / `2>&1`, `$(…)`, backticks, `&`, a heredoc, `tail -f`,
 * `sed -i`, and shell keywords such as `for`.
 */

const PRINTERS = new Set(["cat", "nl", "head", "tail", "bat", "less", "more", "sed"]);
const LOCATORS = new Set([
  "cd",
  "pwd",
  "echo",
  "ls",
  "wc",
  "grep",
  "egrep",
  "rg",
  "sort",
  "uniq",
  "cut",
]);

/** A word, or one of the operators the rule reads. */
type Token = { word: string } | { op: ";" | "|" };

/** Thrown inside the lexer for a command the rule refuses to reason about. */
class Refused extends Error {}

/** Splits a command into words and operators, honouring quotes. */
class Lexer {
  private readonly tokens: Token[] = [];
  private word = "";
  private inWord = false;
  private i = 0;

  constructor(private readonly command: string) {}

  run(): Token[] {
    for (; this.i < this.command.length; this.i++) this.step(this.command[this.i] as string);
    this.endWord();
    return this.tokens;
  }

  private step(c: string): void {
    if (c === "'") this.singleQuoted();
    else if (c === '"') this.doubleQuoted();
    else if (c === "\\") this.escaped();
    else if (c === " " || c === "\t") this.endWord();
    else if (c === "\n" || c === ";") this.operator(";");
    else if (c === "&" || c === "|") this.andOr(c);
    else if (c === ">" || c === "<") this.redirection(c);
    else this.append(c);
  }

  private append(text: string): void {
    this.word += text;
    this.inWord = true;
  }

  private endWord(): void {
    if (this.inWord) this.tokens.push({ word: this.word });
    this.word = "";
    this.inWord = false;
  }

  private operator(op: ";" | "|"): void {
    this.endWord();
    this.tokens.push({ op });
  }

  private singleQuoted(): void {
    const end = this.command.indexOf("'", this.i + 1);
    if (end < 0) throw new Refused();
    this.append(this.command.slice(this.i + 1, end));
    this.i = end;
  }

  private doubleQuoted(): void {
    let text = "";
    let j = this.i + 1;
    for (; j < this.command.length && this.command[j] !== '"'; j++) {
      if (this.command[j] === "\\" && j + 1 < this.command.length) j++;
      text += this.command[j];
    }
    if (j >= this.command.length) throw new Refused();
    this.append(text);
    this.i = j;
  }

  private escaped(): void {
    const next = this.command[this.i + 1];
    if (next === undefined) return;
    this.i++;
    if (next !== "\n") this.append(next);
  }

  /** `&&` and `||` separate segments, `|` separates stages, `&` is refused. */
  private andOr(c: string): void {
    if (this.command[this.i + 1] === c) {
      this.operator(";");
      this.i++;
    } else if (c === "|") this.operator("|");
    else throw new Refused();
  }

  /** Only stderr dropped or merged: `2>/dev/null`, `2>&1`. */
  private redirection(c: string): void {
    if (c !== ">" || !this.inWord || this.word !== "2") throw new Refused();
    const rest = this.command.slice(this.i + 1);
    const target = ["/dev/null", "&1"].find((t) => rest.startsWith(t));
    if (target === undefined) throw new Refused();
    this.word = "";
    this.inWord = false;
    this.i += target.length;
  }
}

/** The command's tokens, or undefined for a command the rule refuses to reason about. */
function tokenize(command: string): Token[] | undefined {
  if (["`", "$(", "<("].some((t) => command.includes(t))) return undefined;
  try {
    return new Lexer(command).run();
  } catch (err) {
    if (err instanceof Refused) return undefined;
    throw err;
  }
}

/** Non-option operands of a stage's arguments. */
function operands(args: string[]): string[] {
  return args.filter((a) => !a.startsWith("-"));
}

/** Whether `args` (without the program name) give a printer a file to print. */
function printsFile(program: string, args: string[]): boolean | undefined {
  if (program === "sed") {
    // `sed -n '<range>p' <file>…`: one script that only prints lines.
    if (
      !args.includes("-n") ||
      args.some((a) => a === "-i" || a.startsWith("-i") || a.startsWith("--in-place"))
    ) {
      return undefined;
    }
    const [script, ...files] = operands(args);
    if (script === undefined || !/^[0-9,$+~]*p$/.test(script)) return undefined;
    return files.length > 0;
  }
  if (
    program === "tail" &&
    args.some((a) => a === "-f" || a === "-F" || a.startsWith("--follow"))
  ) {
    return undefined;
  }
  // `head -n 300 f`: a numeric operand is an option's value, not a file.
  return operands(args).some((a) => !/^\+?[0-9]+$/.test(a));
}

/** One stage's part: "file" prints a file, "filter" passes text on, "search" shows matches. */
function stageKind(stage: string[], first: boolean): "file" | "filter" | "search" | undefined {
  const [program, ...args] = stage;
  if (program === undefined) return undefined;
  if (LOCATORS.has(program)) return "search";
  if (!PRINTERS.has(program)) return undefined;
  const file = printsFile(program, args);
  if (file === undefined) return undefined;
  // First: a printer with nothing to read is refused. Later: `x | cat other.ts` is refused.
  if (first !== file) return undefined;
  return file ? "file" : "filter";
}

/** "print", "harmless", or undefined for a stage list the rule does not accept. */
function classifySegment(stages: string[][]): "print" | "harmless" | undefined {
  let prints = false;
  for (const [index, stage] of stages.entries()) {
    const kind = stageKind(stage, index === 0);
    if (kind === undefined) return undefined;
    if (kind === "file") prints = true;
    // `cat f | grep x` shows matches, not the file.
    if (kind === "search" && index > 0) prints = false;
  }
  return prints ? "print" : "harmless";
}

/** Whether a Bash `command` does nothing but print files (see the module comment). */
export function isFilePrintCommand(command: string): boolean {
  const tokens = tokenize(command);
  if (tokens === undefined) return false;
  let anyPrint = false;
  let stages: string[][] = [[]];
  const closeSegment = (): boolean => {
    const nonEmpty = stages.filter((s) => s.length > 0);
    if (nonEmpty.length === 0) return stages.length === 1; // a blank line or `;;`
    if (nonEmpty.length !== stages.length) return false; // `| x` or `x |`
    const kind = classifySegment(stages);
    if (kind === undefined) return false;
    if (kind === "print") anyPrint = true;
    return true;
  };
  for (const token of tokens) {
    if ("word" in token) {
      (stages[stages.length - 1] as string[]).push(token.word);
    } else if (token.op === "|") {
      stages.push([]);
    } else {
      if (!closeSegment()) return false;
      stages = [[]];
    }
  }
  if (!closeSegment()) return false;
  return anyPrint;
}
