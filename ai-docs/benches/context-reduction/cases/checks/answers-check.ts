// Grades answers.md of the research case against the known answers.
//
// madbench starts this program with the Check envelope on stdin. Each line
// of answers.md that starts with a question number ("3. value" or "3) value")
// is one answer. Backticks, quotes and a final full stop around the value are
// removed; the rest must match the known answer exactly. Score: the share of
// the 12 answers that match. Pass: all 12.
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Envelope = { session?: { work_dir?: string }; work_dir?: string };

// Read from claudish at 533e4233 (v14.26.0), one per question, in order.
const EXPECTED = [
  "0.19.0",
  "isStrippedFromChildEnv",
  "packages/cli/src/handlers/shared/anthropic-error.ts",
  "CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK",
  "inMcpSession",
  "dynamic-models-catalog.key",
  "CLAUDISH_TOKEN_FILE",
  "300000",
  "150000",
  "120000",
  "packages/cli/src/providers/native-route.ts",
  "CLAUDISH_PANE_CHILD",
];

function emit(pass: boolean, score: number, reason: string, evidence: Record<string, unknown>): never {
  console.log(JSON.stringify({ pass, score, reason, evidence }));
  process.exit(0);
}

const envelope = JSON.parse(await Bun.stdin.text()) as Envelope;
const workDir = envelope.session?.work_dir ?? envelope.work_dir;
if (!workDir) emit(false, 0, "the envelope names no work_dir", {});

let text = "";
try {
  text = readFileSync(join(workDir, "answers.md"), "utf8");
} catch {
  emit(false, 0, "answers.md is absent", {});
}

const given = new Map<number, string>();
for (const line of text.split("\n")) {
  const m = line.match(/^\s*(\d{1,2})[.)]\s*(.*)$/);
  if (!m) continue;
  const n = Number(m[1]);
  if (given.has(n)) continue;
  const value = m[2]
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, "")
    .replace(/\.$/, "")
    .replace(/^[`'"]+|[`'"]+$/g, "")
    .trim();
  given.set(n, value);
}

const rows = EXPECTED.map((want, i) => {
  const got = given.get(i + 1) ?? "";
  return { n: i + 1, right: got === want, got };
});
const right = rows.filter((r) => r.right).length;
emit(right === EXPECTED.length, right / EXPECTED.length, `answers: ${right} of ${EXPECTED.length} right`, {
  wrong: rows.filter((r) => !r.right).map((r) => `${r.n}: ${r.got || "(none)"}`),
});
