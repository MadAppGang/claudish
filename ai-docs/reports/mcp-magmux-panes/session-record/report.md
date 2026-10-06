# Report — MCP `team` and `create_session` as interactive Claude Code in headless magmux panes

Session `dev-feature-mcp-magmux-panes-20261002-a7c3` · depth full · automation autonomous ·
requested by peer session `claudish-mcp-feedback` on the user's behalf · base `feat/session-records`
(user choice, rebased onto `51104c76`) · release PR #288 → v10.4.0 (ships session-records too, user choice).

## Feature summary

Every MCP `team` slot (and CLI `team` / `--team`) and every `create_session` now runs as an interactive
Claude Code session launched through claudish inside its own headless magmux pane, driven over the socket.
The `-p`/stream-json spawn path is deleted. The MCP surface gains the mod contract v1 verbs (list, status rows,
idempotent cancel, capture / `capture_session`) that the peer's Claude Code mod polls.

## Requirements

| Req | Status | Evidence |
|---|---|---|
| FR1 team slots interactive in panes | Done | live V1 (3 models incl. 2 native) |
| FR2 create_session interactive; send_input; one-shot vs interactive | Done | live V7 |
| FR3 env scrub, `-y`, minted `--session-id` | Done | live V6 (no "Transcript saving is off") |
| FR4 driving edges; content not state flag | Done | transcript turn oracle (`pane/transcript-follower.ts`) |
| FR5 transcript answer source, capture fallback | Done | live V1, V3 |
| FR6 require_pattern / min_output_bytes / response files / status files / slots map / judge | Done | live V3 negative + positive; black-box suite |
| FR7 failure re-derivation (API error, dead pane, unknown agent, boot) | Done | live V2 `agent_rejected` |
| FR8 delete the `-p` path | Done | residue sweep clean (impl phase 6) |
| FR9 mod contract A–D frozen and sent before landing | Done | `mod-contract-v1.md`; peer ACK; CA-12 + CA-13 merged |
| FR10 channel frames | Done | live V9 + wire-format test |
| FR11 tool-list pins updated | Done | e2e pins (14 tools) |
| NFR1 no orphans | Done | live V5 + SIGKILL reap 1.7 s |
| NFR2–NFR6 | Done | see implementation-log.md |

## Architecture decisions (architecture.md)

One `pane/` module consumed by team and channel (D1); one headless magmux per slot (D2); transcript is the
turn oracle, magmux only liveness/screen/input (D3); boot from screen content, dialogs never accepted (D4); no
timer after the prompt is accepted (D10); prompt delivery by file with read coverage; per-pane watcher with
(pid, start time) identity; records of 10.4.0 kept byte-compatible for the Magus monitor (§20).

## Implementation

114 commits over `origin/main` (102 of them this migration on top of session-records): 217 files,
+35,667 / −8,452 (vs session-records: 208 files, +31,745 / −10,320). Six implementation sub-phases plus
code-review and test fixes — `implementation-log.md`.

## Reviews

- Plan: round 1 multi-model panel (gpt-6.1-sol, kimi-k3, glm-5.3, internal) FAIL 4C/12H → revision 1 →
  round 2 (2 internal) FAIL 1C/7H → revision 2 → round 3 CONDITIONAL (0C/1H, adopted as §19 constraints).
- Code: iteration 1 CONDITIONAL 0C/5H/17M/29L (4 area reviewers) → fixes → iteration 2 PASS 0C/0H/2M/13L; the
  2 MEDIUMs fixed in Phase 6.

## Tests

- Full suite: bun 1.4.0 5029/36/0; bun 1.3.10 (CI) 5028/37/0 (pre-rebase); post-rebase overlap suites 94/0.
- Black-box (blind, internal writer): 22/22 after 2 implementation fixes; negative control proven.

## Real validation (Phase 7, iteration 1 of 3)

PASS — V1–V9 and R3, R8, R13, R14, R16, R17 against the built 10.4.0 MCP server with real models.
`ai-docs/reports/mcp-magmux-panes/phase7-live-validation.md`. Spend $0.13 metered. `run` wall time 9.5 s
(3 slots).

## Gates (gates.log, verbatim)

- gate skipped: plan-review round 2 externals — claudish absent (MCP server disconnected after resume; 2 independent internal reviewers substituted). Round 1 ran the full panel (gpt-6.1-sol, kimi-k3, glm-5.3): FAIL 4C/12H.
- gate skipped: code-review externals — claudish absent (MCP team tool disconnected; CLI present but team is MCP-only). 4 area-split internal reviewers substituted.

## Known issues / follow-ups

- gpt-5-mini `stats/*.json` estimates $2/$8 per M (`is_estimated:true`); `cost_usd` may be overstated for it
  (pre-existing pricing, outside this feature).
- A background shell started and orphaned between two 2 s group refreshes is never recorded (narrow gap).
- Reusing a team `path` requires clearing the previous run's files first (existing `setupSession` rule);
  run_ids stay distinct when it is cleared.
- Deferred LOW findings are listed in implementation-log.md ("Code-review fixes (iteration 1)").
- CI wall time ~14–15 min locally; `test.yml` timeout raised to 25 min (PR #288 CI ran 15m34s).
- `proxy-server.test.ts` "keyless custom endpoint" test timed out once in CI (5 s); untouched by this branch,
  3/3 locally; main's own CI also failed once on 2026-09-26 (cause not checked). Tracked in ROADMAP.md.

## Release

- PR #288 merged as `d392cf18`. CI went green after scrubbing a high-entropy FAKE token from the redaction
  test's history (GitGuardian false positive). The value is now `redaction-probe-not-a-real-credential`; all
  114 commits were re-signed; only the PR branch was force-pushed.
- Tag `v10.4.0` on the merge commit. `release.yml` run 37474052125 succeeded (build ×4, release, publish-npm,
  update-homebrew).
- npm: `claudish@10.4.0` and the four `@claudish/magmux-*@10.4.0` resolvable by 2026-10-06T14:01:10Z;
  `latest = 10.4.0`. A clean install carries `magmux-darwin-arm64`; `claudish --version` → 10.4.0.
- Peer `claudish-mcp-feedback` was told the version and the two contract-relevant facts.
