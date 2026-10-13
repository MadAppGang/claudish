# UI-independent signals for interactive Claude Code panes: final report

> **Corrections after this report (2026-10-13).**
> - **D3b is not a defect for `team` and one-shot sessions.** Not awaiting a background shell is the
>   deliberate design D23 / R3-M5 (`ai-docs/architecture/pane-session.md`, "Background work"): a dev
>   server, watcher or `tail -f` never ends, and the slot names the shell in its `detail` as
>   `background_shell_open: <command>`. The research runs did carry that detail; the explorer read only
>   the state. The real defect was the INTERACTIVE case: the follow-up answer after the notification
>   re-settles the same turn and never reached `get_output`. Fixed in `SessionManager.appendAnswer`.
> - **Layer 1 (argv first prompt) is rejected.** A pane child receives every prompt the way a user gives
>   it (typed, pasted, image paste); an argv prompt covers only plain text on the first turn.
> - Evidence paths (`findings/…`, `raw/…`) refer to the gitignored session
>   `ai-docs/sessions/dev-research-cc-slot-signals-20261008-b41e/`, which does not survive a fresh clone.



Session `dev-research-cc-slot-signals-20261008-b41e` · 2026-10-09 · for Jack
Trigger: `--agent` label in Claude Code's input-box border made every agent slot fail `boot_timeout` (patched in `cada488a`).
Authoritative source: `synthesis/iteration-4.md`. Citation keys E1-E13 are `findings/explorer-N.md`.

## Executive Summary

Most of what claudish reads from the screen can be replaced by signals that do not depend on how Claude Code draws. Three things cannot.

What can stop depending on the screen: boot-ready, working/idle, "a permission or plan dialog opened", Stop-hook running, `/compact`, and background-work quiescence. The primary replacement is Claude Code's session registry file (`~/.claude/sessions/<pid>.json`), which holds `idle`, `busy`, `waiting` and `shell`. It is undocumented, so the screen rules stay as a fallback. "Agent applied" comes from the SessionStart hook (`agent_type`), and "agent rejected" from the process exit code. The first prompt can be passed as a documented argv argument, which removes the keystroke-readiness question.

What cannot: naming which boot dialog is blocking (config prediction helps, the text stays on screen); prompt admission, which stays on the transcript; and panel commands such as `/cost`.

The incident was a coverage gap for the agent-labelled spawn shape, not drawing drift. Dialog texts were byte-identical across 2.1.288-2.1.293.

Recommended path: first fix the one High defect found (a background Bash is killed and reported as `succeeded`), using a settle-time registry read plus screen-row veto. Then argv first prompt, a Linux and macOS spawn-shape canary, and a telemetry-first registry reader. Park the in-child mod.

## Research Questions

**Q1. Can hooks injected through the `--settings` overlay replace the screen?** Partly. No hook means "the box accepts a prompt". SessionStart fires 112-266 ms before the box in claudish's own argv and env (23/23, E9), so it is a precondition, not a trigger. Hooks do answer: boot passed every gate, agent applied (`agent_type`), which dialog is open (PermissionRequest names `tool_name` and `permission_mode`), final message or error (Stop, StopFailure), and compaction (Pre/PostCompact). No hook marks a dialog closing. Hooks merge intact through the overlay (11/11 in real claudish panes, E6). `disableAllHooks` and `--bare` remove them detectably, with the registry still written (E10).

**Q2. Mods and the statusLine?** The statusLine is a corroborator only. A mod (`PromptHint.isWorking`, `$.prompt.submit`) works in a claudish pane (11/11) but is the riskiest surface: early-access label, a remote kill switch (#99130 served it off on 2.1.288/289), trust-gated, and it delays SessionStart by about 250 ms. Parked.

**Q3. Claude Code's own channels?** The session registry is the useful one (maps to a pane by `sessionId`, 11/11 and 20/20). The messaging socket delivers prompts only as peer messages (`isMeta:true`), which fail today's admission witness. Channels and Remote Control are unusable for proxied slots. magmux 0.14.0 forwards no in-child signal to a watcher, so the owner channel must be a file, a socket in the control dir, or the registry.

**Q4. Has the case against non-interactive mode changed?** No. Under stream-json an unknown `--agent` still exits 0, no `turn_duration` is written, dialogs are skipped, and `sdk-cli` quota weighting is a concern (#97074). Print mode and the SDK stay rejected for panes (E4, E8).

**Q5. How should what stays on screen fail loudly, and how do we catch drawing changes?** Cross-check against the registry: if registry `idle` is seen and no box is recognised within 2 s, fail. That fired at 2.30-2.35 s in 7/7 misread runs with 0 false positives in 7 healthy runs (E5). A static-screen timer is fragile because the idle screen animates for about 10 s. For release, a spawn-shape conformance canary that boots through claudish's own env and overlay with no probe mod. It needs no secret and no model call, and the matrix runs unchanged on Linux arm64 (10/10 identical, E13).

**Round 2 gap questions**
- *Readiness under load (E7):* registry first `idle` and mod first `PromptHint` are keystroke-safe, 0 stranded sends in 80. Every loaded failure was a slow user hook holding the prompt, which the current screen rule fails equally.
- *Signals inside real claudish panes (E6):* hooks, registry and pid mapping all work there. argv works but claudish blocks it at three layers.
- *Stability (E8):* ranks the candidates by documentation status, not richness (see Decision Table).

**Round 3 gap questions**
- *What reorders SessionStart (E9):* the probe mod itself, not claudish's shape. SessionStart leads the box in 23/23 production-shape runs.
- *argv in the proxied env and under a hold (E9):* 10/10 and 5/5. A slow SessionStart hook holds argv prompts too, which is documented.
- *Plan, `/compact`, AskUserQuestion, policy switches, background work (E10):* the registry signals dialog open (ahead of the screen) and close. Its writer survives `disableAllHooks`, `--bare` and `disableAgentView`. Raw states include `shell`.
- *Dropping `ANTHROPIC_API_KEY` against #13 (E9):* the token alone prevents the API-key dialog on a fresh config (2/2). #13 needs the token absent.

**Round 4 gap questions**
- *D2/D3 end to end through claudish (E11):* `/compact` settles correctly (path L, 6/6). Background agents are handled (9/9). Background Bash is broken (below).
- *Auto-compaction mid-turn (E11):* the registry stays `busy` with zero writes, the screen reads idle, and the enclosing turn gets one `turn_duration`. claudish does not settle falsely (3/3).
- *User-scope `disableAgentView` and `allowManagedHooksOnly` (E12):* the former makes `claude agents --json` refuse (9/9), so the raw file must be the primary reader. The latter is ignored at user scope. The registry writer is unaffected.
- *D5 reach (E12):* every route that hands Claude Code the literal alias `haiku` is bitten in plan mode.
- *The ~4 s boot (E12):* 3.65-4.11 s of 4.5-4.8 s is a blocking catalog warm-up (D16).
- *Controlled load and Linux (E13):* 20/20 `create_session` runs passed with 0 boot or admit timeouts, and the Linux arm64 boot matrix equals macOS.

## What claudish reads from the screen today, and what replaces each

All counts are Claude Code 2.1.293 unless noted (E11 and E12 ran 2.1.294). Stability classes: Doc-stable, Doc-preview, Undoc, Remote, Policy.

| # | Decision today | Primary UI-independent signal | Backup | Measured reliability | Stability | Stays on screen |
|---|---|---|---|---|---|---|
| 1 | Boot ready, keystroke-safe | argv for the first prompt; for typed prompts, registry first `idle` (status-less record = booting) | mod first PromptHint; box frame | argv 40/40, 9/9, 10/10 proxied; registry 20/20 idle, 19/20 load, 0/40 stranded; 20/20 `create_session`; `idle` precedes box 42/42 | argv Doc-stable; registry Undoc | `inputBox` as fallback and as the cross-check |
| 2 | Boot passed every gate | SessionStart `source:"startup"` | registry record; first statusLine | 11/11, 23/23, 17/17, 20/20 | Doc-stable + Policy | nothing |
| 3 | Boot dialog: blocked? | prevent or predict at spawn; else absence of registry record and SessionStart while pid lives | hook/statusLine silence | silent 5/5 (E1), 5 dialogs (E5), 60 s hold (E3); same on Linux | absence; env vars Doc-stable | nothing |
| 4 | Boot dialog: which one? | prediction from config | none in-child | texts byte-identical 2.1.288-293 (50 runs) | config fields Undoc | naming (`NAMED_DIALOGS`) |
| 5 | Agent rejected | process exit 1 in 0.3-0.5 s, no registry record | magmux `exit` event | every bad-agent run, 5 versions, Linux | CLI behaviour | the reason text |
| 6 | Agent applied (new check) | SessionStart `agent_type` equals requested | statusLine `agent.name`; raw registry `agent`; not `--json` | 2/2, 3/3, 2/2 | Doc-stable / Undoc | nothing |
| 7 | First prompt delivery | argv with `--` before the template line, server-only channel | typing gated on registry `idle` | 40/40, 9/9, 10/10, 5/5 under hold | Doc-stable | nothing |
| 8 | Later prompts (`send_input`) | typing gated on a new persistent registry `idle` (`shell` also input-ready) | mod `asUser` (parked) | 20/20 idle, 19/20 load; screen gate wrong during `/compact` | Undoc | box for `@`/`!` lines; registry-absent case |
| 9 | Prompt admission | transcript witness stays the oracle | registry `busy`; UPS `prompt_id` | record can land 15-102 ms after end-of-turn `idle` (25/25) | transcript | panel commands (`/cost`) |
| 10 | Prompt held behind user hooks | registry `busy` + no UPS + no transcript file = SessionStart hold | screen row `running <Event> hooks...` | 12 SessionStart + 3 UPS/Stop holds; registry `busy` 15/15 | hold documented; registry Undoc | the row, to name the event |
| 11 | Permission or plan dialog opens | registry `waiting` + `waitingFor` | PermissionRequest (names via `tool_name`) | plan 4/4, 34-36 ms ahead of screen; tool permission 1/1 | registry Undoc; hook Doc-stable | fallback |
| 12 | Dialog closes | registry back to `idle`/`busy` | transcript rejected `tool_result` | 8/8; no hook fires | Undoc | nothing |
| 13 | AskUserQuestion | registry `waitingFor:"input needed"` | PermissionRequest(`AskUserQuestion`) | 4/4 and 4/4 | registry Undoc; hook Doc-stable | fallback |
| 14 | Working | registry `busy`; new `statusUpdatedAt` = turn edge | mod `isWorking`; `turn_duration` | high across E3, E6, E7, E9, E10, E13; screen false during `/compact`, auto-compaction, background waits | Undoc | fallback rule |
| 15 | Stop hook running | registry `busy` until Stop hooks end | `stop_hook_summary` | 5 s and 24.8 s hooks | Undoc | fallback; regex `hooks?` |
| 16 | Transcript saving off | path known at boot; file absent after first `turn_duration` | none | E2 | Doc-stable | nothing |
| 17 | Screen answer/error rows (degraded) | Stop `last_assistant_message`; StopFailure `error` | transcript | Stop 9/9 | Doc-stable | keep the degraded path |
| 18 | `/compact`, auto-compaction | registry `busy` to `idle` | PostCompact; `compact_boundary` | manual 3/3 + 6/6; auto 3/3 | registry Undoc; hooks Doc-stable | `Compacting...` row, display only |
| 19 | Slot quiescent after background work | registry `idle` = done; `busy` past `turn_duration` = agent live; `shell` = not quiescent | `pendingBackgroundAgentCount`; screen rows | agent handled 9/9; shell mishandled 6/6 | registry Undoc | the two rows, display only |

## Recommended Layers

Build order from iteration 4. No code here.

1. **Layer 5 plus the text half of Layer 6, with D1, D8 and the D3b veto from the screen rows.**
   - *Removes:* the High defect in the degraded path, with no new reader (the `N shell still running` and `Waiting for N background agent` rows veto a settle).
   - *Evidence:* E11 table, E10.
   - *Risk:* low; display text is not a contract.
   - *Touches:* `screen-classifier.ts`, `screen-model.ts`, `pane/test-fixtures/screens/` (compacting and background-wait fixtures from `raw/r3b/runs/`). Do D16 with this step.
2. **Layer 2a: one registry read at settle time.**
   - *Removes:* D3b properly. If `status` is `shell` (or `busy` after a `turn_duration` with no pending agent count), do not settle and do not reap.
   - *Evidence:* the registry reached `shell` 41-79 ms before the follower read `turn_duration`, and the settle fires 0.5-1.5 s later (6/6). No poller needed.
   - *Risk:* low; a missing record falls back to step 1.
   - *Touches:* new reader under `pane/`, `pane-session.ts`, `settle-rule.ts`.
3. **Layer 1: argv first prompt.**
   - *Removes:* the typed-readiness question for the first prompt, and 0.7-1.0 s of idle-to-busy gap.
   - *Evidence:* 40/40, 9/9, 10/10; documented.
   - *Risk:* low, but claudish blocks it at three layers and needs a server-only prompt channel; `claude-runner` must re-emit `--`. The owner must ignore the transient first `idle`.
   - *Touches:* `pane-launch.ts`, `cli.ts:979-986`, `child-env.ts:167`, `claude-runner.ts`, team spawn in `pane-session.ts`, `create_session` in `mcp-server.ts`.
4. **Layer 0a: drop the `ANTHROPIC_API_KEY` placeholder, keep the token.**
   - *Removes:* the fresh-config API-key dialog (D4).
   - *Evidence:* 2/2 and 3/3.
   - *Risk:* untested with a real OAuth login or native routes.
   - *Touches:* `claude-runner.ts:1846-1871`.
5. **Layer 7: spawn-shape conformance canary, macOS plus Linux cells, pinned and latest Claude Code.**
   - *Removes:* the next incident like this one, caught before users.
   - *Evidence:* E5 (83 runs, 5 versions) and E13 (Linux, 10/10 identical).
   - *Risk:* x64 and musl unmeasured. Needs a Claude Code version pin file, an unprivileged user, and `scripts/boot-canary.ts` (not yet written).
   - *Touches:* `.github/`, new script.
6. **Layer 2 (rest): registry reader for typed-prompt gating, dialogs and hold diagnosis.** Telemetry-only first. Raw file validated (pid alive, `procStart`, known `version`); `claude agents --json` only opportunistic.
7. **Layer 3: hooks in the overlay.** `type:"command"`, `async:true`, exit 0, one line to the per-pane control dir, concatenated inside `mergeUserSettingsIfPresent`; every SessionStart consumer checks `source`.
8. **Layer 6 P2 and hold detection.** Needs Layer 2. Clock starts at the first `idle`. No new `FailureReason` (contract v1 is frozen); use an optional field.
9. **Layer 0b.** Predict the remaining dialogs; add "CLAUDE.md imports" and "Settings Error" to `NAMED_DIALOGS`.
10. **Layer 4: in-child mod.** Parked until the types drop "EARLY ACCESS" and #99130 closes.

## Incidental claudish defects found

Severity: High = wrong result or billing reported as success; Medium = slot blocks, misreports or overpays under a common condition; Low = residue or latent trap. Evidence paths are relative to `findings/`.

| # | Defect | Severity | Evidence | Scope |
|---|---|---|---|---|
| D3b | Background Bash: claudish settles on `turn_duration` #1 and kills the pane; `team` reports `succeeded` with the launch acknowledgement; interactive `get_output` loses the final answer | **High** (team, one-shot); Medium interactive | E11 `table.txt`, `raw/r4a/runs/{csbash,teambash,cibash}*` | session/settle |
| D16 | Catalog freshness judged on server `generatedAt`; every launch blocks 3.65-4.11 s on a refresh that cannot freshen | Medium | E12 `raw/r4b/runs/{n*,ttl*}` | **outside session-start scope (catalog)** |
| D5 | `haiku` in plan mode runs and bills Sonnet (~$0.11 vs ~$0.01 per turn); reach: `--model haiku`, `CLAUDISH_MODEL`, `ANTHROPIC_MODEL`, `team` entry, `create_session` | Medium | E12 `raw/r4c/strings-*`, E2 `plan1` | **outside scope (routing/model)** |
| D4 | API-key placeholder raises "Detected a custom API key" on every fresh config dir; slot likely blocks at boot [inference] | Medium | E9 `raw/r3a/runs/k13-*`, `g7-*` | session start |
| D9 | `admit_deadline` (30 s) races a 30 s UPS hook timeout, so a held prompt reads as an admission failure | Medium | E7 `load-hint-12` | session start |
| D1 | `isWorking` reads a compacting session as idle; no false settle today | Low (Medium if a consumer trusts the screen alone) | E10, E11 `acstats.txt` | classifier |
| D2 | No `turn_duration` for `/compact`; path L settles it 6/6 | Low | E11 | settle |
| D6 | `forceLoginMethod:"console"` becomes an OAuth flow if the token is ever absent | Low | E9 | session start |
| D7 | `AI_AGENT=...` leaks into the pane child; effect unknown | Low | E9 | env |
| D8 | `/\(running Stop hook\b/` misses plural `hooks` | Low | E1, E7, E9 | classifier |
| D10 | Rejected `--agent` leaks `/tmp/cc-socks/<pid>.sock` (Claude Code) | Low | E5 | upstream |
| D11 | `~/.claudish/sessions/<id>/` left behind per `create_session` | Low | E6, E13 | cleanup |
| D12 | `remoteControlAtStartup: true` opens a Remote Control session per native pane (user setting) | Low | E3, E10 | upstream |
| D13 | `NEXT_STEP.boot_timeout` gives wrong advice for a misread boot | Low | E5 | session start |
| D14 | `CLAUDE_CODE_CHILD_SESSION` strip (`magmux-wrapper.ts:62`) is unpinned; losing it silently disables registry and transcript saving | Low (High if it regresses) | E8, E6 | session start |
| D15 | Claude Code adds a `projects` entry to the real `~/.claude.json` per pane cwd | Low | E1, E7 | upstream |
| D17 | `CLAUDISH_MODEL`/`ANTHROPIC_MODEL` from the environment are not normalized (`internal` reaches Claude Code raw) | Low | E12 | **outside scope (routing/model)** |

Not defects but facts to record: the pane's inner claudish is the global install, so a worktree fix does not run in panes until installed (E12). D3a (background agents) is no defect.

## Evidence Quality Assessment

- **Unanimous / strong (2+ explorers, measured live):** unknown agent exits 1; boot dialogs silence hooks, statusLine and registry; registry `idle` and PromptHint mark the REPL mount ahead of the box; SessionStart precedes the mount without a mod; registry and PromptHint are keystroke-safe; argv record is identical to typed; slow user hooks hold prompts, registry `busy` throughout; registry maps by `sessionId`; in-turn dialog opening visible ahead of the screen and no hook marks the close; registry writer survives every policy switch measured; `/compact` and auto-compaction read idle on screen; background shell is `shell`, agent is `busy`; print mode rejected; #13 prevented by the token; Linux arm64 boot matrix equals macOS.
- **Moderate (one strong explorer or small n):** stability classes (E8 alone); P2 cross-check (7/7, 0/7); mod ~250 ms SessionStart delay; `--json` refused under user-scope `disableAgentView` (9/9, 3 runs); ~4 s = catalog-warm (3 + 3 runs); auto-compaction (3/3 each path, forced with a scripted upstream); status-less first record (20/20, one explorer); controlled-load smoke (10 + 10, peers present).
- **Single-source / inferred:** claudish's three argv blockers; D3b with a real model and the `team` file-delivery path; D4's boot block; managed-scope behaviour (docs only); D16's `generatedAt` mechanism (effect proven by control, mechanism read from code); `sdk-cli` weighting (#97074).
- **Factual Integrity: about 96%.** About 7 of about 170 claims remain unsourced or docs-only.
- **Agreement Score: 84% (21 of 25 key findings supported by 2+ explorers or independent sources).** The single-explorer findings are the three argv blockers, the catalog-warm finding, the Linux finding and the status-less record.

## Source Analysis

**Official documentation (quality High, pulled 2026-10-08, 24 pages in `raw/q8/docs/` plus the Q1 set):** agent-view (JSON listing, session state, where state is stored), env-vars, agent-sdk/typescript (`session_state_changed`), hooks and hooks-guide, settings and settings-reference (`disableAllHooks`, `allowManagedHooksOnly`, precedence), cli-reference, interactive-mode, permissions, cross-session-messaging, plugin/mod pages. One doc line matters most: rendered text is "display text, not a stable format" (hooks.md:2162).

**CHANGELOG (High):** upstream `CHANGELOG.md`, 8,557 lines, head 2.1.293; used for feature dates (`claude agents --json` 2.1.145, `waitingFor` 2.1.162, mods 2.1.287).

**GitHub issues (Medium-High, status as of the research date):** #96438 (torn `}` in the registry file, open), #95439 (`sessionId` not updated on `/clear`, open), #93824 (Windows `ListAgents`), #99130 (mod served OFF), #13 (onboarding OAuth), #97074 (`sdk-cli` weighting), #97521, #93872, #87883. Community A/Bs treated as Low.

**Binary inspection (Medium-High):** `strings` on 2.1.293 and 2.1.294 for the registry writer gate, `bye()` alias swaps and the `shell` state.

**Live experiment corpus:** all measured on claudish's real child shape or plain `claude` in headless magmux 0.14.0, with fake upstreams for nearly all proxied runs. Run counts as reported by explorers (some are run directories, not counted trials):

| Explorer | Round | Topic | Runs |
|---|---|---|---|
| E1 | 1 | hooks | 206 run directories |
| E2 | 1 | mod, statusLine | 32 |
| E3 | 1 | channels, registry | 26 |
| E4 | 1 | print mode, SDK | scenario sets e41-e43 (count not reported) |
| E5 | 1 | classifier hardening | 83 (5 Claude Code versions 2.1.288-2.1.293) |
| E6 | 2 | real claudish panes | 11 Rig A runs plus variants |
| E7 | 2 | readiness under load | 200 plus 6 smoke |
| E8 | 2 | stability | docs, CHANGELOG, gh, `strings`; read-only |
| E9 | 3 | argv, reorder, key | about 87 run directories (42 ablation variants) |
| E10 | 3 | plan, compact, policy, background | 41 plus 1 smoke |
| E11 | 4 | D2/D3 through claudish | about 30 (scripted upstream, $0) |
| E12 | 4 | policy scopes, D5, boot decomposition | about 15 |
| E13 | 4 | Linux canary, load | 20 `create_session` plus a 10-scenario Linux matrix |

Claude Code versions 2.1.288 to 2.1.294 (2.1.293 for rounds 1-3 and E13; 2.1.294 for E11 and E12 after an auto-update mid-round). Platforms: macOS arm64, plus one Linux arm64 glibc container (`debian:bookworm-slim`). Spend: about $0.42 (E10), $1.13 estimated (E7, subscription-billed), about 10 haiku turns (E6), and $0 for the fake-upstream rounds; E13 used a native route with `costUsd` null and 1.34 M cached input tokens.

## Methodology

- **Agents:** general-purpose explorers in rounds 1-3 (E1-E10); round 4 (E11-E13) and this report by Sonnet 5.5. Four exploration rounds and four syntheses (iteration 1 through 4).
- **Round 1:** one explorer per question Q1-Q5. **Round 2:** E6-E8 on real claudish panes, readiness under load, stability. **Round 3:** E9-E10 on reorder, argv, key placeholder, registry vs hooks vs screen. **Round 4:** E11-E13 on end-to-end settle behaviour, policy scopes, boot decomposition, Linux and load.
- **Method:** every claim was measured in a live pane where possible. The screen classifier was replayed against recorded frames. Contradictions were resolved by re-reading raw logs (C1-C24, five of them new in round 4). One orchestrator correction: E13's note that `dist/index.js` predated `cada488a` was wrong; the build included the fix.
- **Convergence status, stated honestly:** the k=3 consecutive-match 80% rule was NOT formally met. Overlap vs iteration 3 was 76.0% (19 of 25), the 3-way overlap was 57.7% strict and 76.9% on a "still present" reading, and the new-information ratio was 12.0% (24% counting changed findings). The new items were by-products of gap-filling, but two substantive corrections came in round 4 (`/compact` is handled; only background Bash is broken). The session was finalized at the user's request after the extra round, not by the criterion.

## Recommendations

**Do now**
1. Fix D3b: add the screen-row veto (Layer 5), then the settle-time registry read (Layer 2a). Decide the product policy first: wait for the notification turn like the agent case, or return the acknowledgement with an explicit "background shell was killed" note.
2. Fix D16 (stamp the fetch time for the catalog freshness test, or revalidate by generation id). It is small and saves about 4 s on every slot boot on stale-publication days. It is a catalog fix, outside the session-start scope.
3. Pin `CLAUDE_CODE_CHILD_SESSION` stripping and settle path L with tests (D14, D2).
4. Deliver the first prompt as argv (Layer 1) via a server-only prompt channel, with `--` re-emitted before the template line.
5. Decide D5 (map `haiku` to a concrete discovered id, or document it).

**Measure while building**
6. Ship the registry reader (Layer 2 rest) telemetry-only first, with raw-file validation and the screen as degraded mode. Log disagreements against the screen on real machines; this also fills the clean-load gap.
7. Build the canary with a Linux cell (`pinned` blocks, `latest` warns). Add x64 to the first run.
8. Before Layer 0a, test dropping the key on a fresh config with a real OAuth login and on native routes.
9. Re-verify rows measured on 2.1.293 against 2.1.294 and later.
10. Ask the owner of the out-of-repo peer mod whether it tolerates an additive contract field before any Layer 6 change.

## Limitations

- **Not tested:** a fresh config with a real OAuth login; native routes for the key drop; Grove, Pro trial and Chrome offer dialogs; managed-scope `allowManagedHooksOnly` and `disableAgentView` (docs only, the brief forbade writing to `/Library`); x64 and musl Linux; `create_session` end to end on Linux; D3b with a live non-Anthropic model, the `team` file-delivery path, a long-running shell, a failing `/compact`, and a compaction longer than the 32 s quiet window; argv through `create_session` itself (needs the server-only channel); a quiet-machine load measurement at n >= 30 with a hook-holding arm; 1Password prehydration on a machine with `op://` references.
- **Scripted upstreams:** E11 and most proxied runs used fake upstreams, so model behaviour (whether a real model backgrounds a shell) is not re-tested.
- **Registry:** an undocumented file. Open bugs #96438 and #95439 apply, and it carries no documented stability guarantee. Hence the degraded screen mode.
- **Mod residue:** rollout flag on a claudish-only machine, `asUser` under a hold, and treatment of a `system`-origin turn are unmeasured; low priority while Layer 4 is parked.
- **Sample sizes:** several results are n=3 (policy scopes, catalog-warm, auto-compaction) and the load results are smokes, not rates. When the agent label first appeared (before 2.1.288) was not determined.
- **Convergence:** not formally reached; later versions may change registry behaviour.
