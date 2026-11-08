// Offline replay: feed the real child transcript through the production reducer and settle rule.
// Usage: bun replay-settle.ts REPO TRANSCRIPT SCREEN
import { readFileSync } from "node:fs";
const argv = process.argv.slice(2);
const repo = argv[0],
  transcript = argv[1],
  screenPath = argv[2];
const P = repo + "/packages/cli/src/pane";
const F = await import(P + "/transcript-follower.ts");
const S = await import(P + "/settle-rule.ts");
const M = await import(P + "/screen-model.ts");
const C = await import(P + "/screen-classifier.ts");
const raw = readFileSync(transcript, "utf8").split("\n");
const lines = [];
let acc = 0;
raw.forEach((s, i) => {
  const rec = s.trim() ? JSON.parse(s) : null;
  if (rec) lines.push({ offset: acc + 1, n: i + 1, rec });
  acc += Buffer.byteLength(s) + 1;
});
const witnessText = lines.find((l) => l.rec.type === "user" && l.rec.origin?.kind === "human").rec
  .message.content;
const full = readFileSync(screenPath, "utf8");
const text = full.endsWith("\n") ? full.slice(0, -1) : full;
const rows = text.split("\n").length;
const cols = Math.max(...text.split("\n").map((l) => l.length));
const scr = M.applyCapture(M.emptyScreen(cols, rows), { text, rows, cols }, 0);
const box = C.inputBox(scr);
const boxEmpty = box === null ? false : box.text === "";
const screen = {
  boxEmpty,
  choiceDialog: C.hasChoiceDialog(scr),
  working: C.isWorking(scr),
  aboveBoxQuietMs: 120000,
};
console.log(
  "screen facts (final screen.txt):",
  screen,
  "box rows",
  box ? [box.top, box.bottom] : null
);
const witness = { kind: "text", text: witnessText };
const at = (stopLine, override) => {
  const st = F.initialFollowerState((p) => p);
  F.openTurnState(st, { index: 1, offset: 0, witness, delivery: null });
  const upto = lines.filter((l) => l.n <= stopLine);
  upto.forEach((l) => F.applyRecord(st, l.rec, l.offset));
  const v0 = F.turnView(st.turns[0]);
  const v = override ? override(v0) : v0;
  const d = S.decideSettle({
    turn: v,
    session: st.session,
    transcriptQuietMs: 120000,
    chatQuietMs: 120000,
    screen,
    paneExited: false,
  });
  return { v, d };
};
const cuts = [
  ["after turn_duration 08:19:00 (line 654)", 654],
  ["after injected plugin message (line 663)", 663],
  ["after turn_duration 08:19:24 (line 673)", 673],
  ["end of file", 1e9],
];
cuts.forEach(([label, ln]) => {
  const r = at(ln);
  const v = r.v;
  console.log("\n== " + label);
  console.log({
    acceptedAt: v.acceptedAt,
    lastAssistant: v.lastAssistant,
    td: v.turnDurationAfterLast,
    waking: v.wakingAfterLast,
    pendingTool: v.pendingTool ? v.pendingTool.name : null,
    agentsLaunched: v.agentsLaunched,
    agentsCompleted: v.agentsCompleted,
    stopHookAfterLast: v.stopHookSummaryAfterLast,
    session: r.session,
  });
  console.log("decision:", r.d);
});
const cf = at(1e9, (v) => ({ ...v, agentsCompleted: v.agentsLaunched }));
console.log(
  "\n== counterfactual: end of file with agentsCompleted := agentsLaunched\ndecision:",
  cf.d
);
