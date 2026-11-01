# Account pool: built-binary validation (MTL-260)

Drives the BUILT claudish (`packages/cli/bin/claudish.cjs`, which starts
`packages/cli/dist/index.js`) against a fake Codex upstream and checks the Codex
account pool end to end. The unit and loopback suites run the handler from `src/`;
this bench runs the artifact users install. Rationale and per-row text:
`ai-docs/architecture/accounts-validation.md`. The contract each row implements is
`rows-contract.md` in the session directory (a reviewed gate; `rows.ts` throws on
load when a run row lacks a contract field).

## Run

```bash
bun install --frozen-lockfile                                # a fresh worktree has no node_modules
bun run --cwd packages/cli build                             # build the bundle ONCE; the bench never rebuilds
bun ai-docs/benches/account-pool-validation/mutants.ts --check          # anchors unique + each mutant still parses
bun ai-docs/benches/account-pool-validation/run-row.ts --list
bun ai-docs/benches/account-pool-validation/run-row.ts --row V11:direct # one row id (V1 runs every variant)
bun ai-docs/benches/account-pool-validation/run-row.ts --all            # every run row, then its mutants
```

Options: `--out <dir>` (default `$SESSION_PATH/validation`), `--no-offline` (see traps).
Do not pipe a long run through `tee` into a lossy buffer: results are files.

Output under `<out>/`: `pin.json`, `rows-summary.md` (pin first, one line per row), and
`rows/<ROW>/` per row: `result.json`/`outcome.json` (checks, each source's evidence),
`accounts.jsonl`, `fake.jsonl`, `canary.jsonl`, `egress.jsonl`, `state.json`, the
`response-*.json` replies or `transcript-*.jsonl`/`stdout.txt`/`stderr.txt`, the `serve-*`
logs, `preflight/`, and `mutant-<id>/` for each mutant run.

## What a row proves

Three sources must agree (`agree.ts`, per class: switch rows, no-switch rows, V17):
the proxy's `accounts.jsonl`, the fake's request log (what reached the wire), and the
third source (the Claude Code transcript for `session` rows; the HTTP response for
`direct` rows, a named relaxation in each row's `transcript` field).

Standing assertions on every run (`harness.ts`): a pre-flight V11-shaped request reaches
a SEPARATE fake on a separate HOME; the canary is proved alive (one hit, then reset);
the canary count equals the row's stated number; no non-loopback contact except
`CONNECT us-central1-claudish-6da10.cloudfunctions.net:443` (refused by the egress sink);
HOME is never the real home; no credential in any product-output file (every file in the run directory except the
`EVIDENCE_FILES` list in `harness.ts`: new output files are scanned by default).

Mutants (`mutants.ts`): textual edits of a SCRATCH COPY of the bundle
(`<out>/mutant-trees/<id>/`, never the repo's `dist/`). Each row runs against the real
bundle (expect the contract) and then against each mutant (expect the red condition,
usually canary 1). A required mutant that does not turn its row red is `DEAD-MUTANT`
and the row is "not evidence". Negative controls (`*-DEAD`) are expected to stay dead.

Verdicts: `PASS`, `FAIL` (re-run once to rule out a flake), `DEAD-MUTANT`, `ERROR`.

## Traps (each one cost time once)

- **Kill the whole process tree.** `bin/claudish.cjs` spawns the bundle as a child; killing
  the launcher orphans a `serve` that keeps its port and lock file. `direct.ts` `killTree`.
- **A temp HOME needs a catalog** in `~/.claudish/cloud-models-catalog-v3.json`
  (`seed.ts` copies the repo's test data), or claudish answers 400 "catalog not available".
- **One unavoidable outbound contact.** `warmRecommendedModels` fetches the hard-coded
  catalog host at proxy start and no environment variable disables it. The egress sink
  refuses it; `--offline` (default) wraps each child in a macOS `sandbox-exec` profile
  that denies non-loopback network. `--no-offline` drops the profile (the sink still records).
- **`-p` fires no title request.** Every `/responses` request of a `-p` or `direct` row is a
  main attempt (`classify` is `() => "main"` for direct rows).
- **Two plain POSTs have different `prompt_cache_key`s.** `conversationKey()` hashes
  `metadata.user_id.session_id`; without it each process draws a random fallback. V3 passes one.
- **Retried 429s hide a missing switch.** Claude Code retries a transient 429, so attempts,
  body hash and the answer still agree under `V11-no-rotation`. Only `reason: quota-switch`
  and a single `requestId` per switch turn red.
- **Claude Code retries a 5xx and a transient 429** (10 attempts over minutes). A session row
  whose red condition is such an answer (V1, V8, V17) sets `CLAUDE_CODE_MAX_RETRIES=0` so the
  text is printed at once and the canary counts only the proxy's own contact. A mutant session
  run is cut at 45 s; the red condition is "canary at least one".
- **A single-edit mutant can be dead behind a redundant net.** 2a put a second net behind
  several sites (V1's dispatch loop, V1c/V1d's transport and handler checks). The mutant that
  turns the row red removes both; the single-edit form is kept as a `*-DEAD` negative control.
- **The O_EXCL mutant (V2) does not break safety**, only availability: the read-back after
  the write keeps the holders apart (one exchange, three HTTP 503). The row catches it through
  the four-HTTP-200 check, not the exchange count.
- **Do not run `biome check --write` on the whole directory** while another stage owns files in
  it: pass your own files.
- **Temp trees (`pool-row-*` under the OS temp dir) are removed when a run finishes** (a
  pre-flight that completed, a passing row, a mutant run that did not error, an E20 case run) and
  are KEPT when a run fails or throws, so the evidence stays. A failing real row therefore leaves
  its tree in `$TMPDIR`: delete it by hand once read.
- **E20 exit code.** Nonzero for a secret-scan violation, an unarmed seam, any ABORTED entry, any
  case other than `identical` (`expected divergence` for `refresh-rejected`, whose expectations are
  explicit in `e20-gate.ts`), and any required mutant that is not red. `V16-drop-transform` is the
  one named negative control and never fails the exit code. Pure rules: `e20-gate.ts`.
- **`mutant-trees/` is bulky** (6.6 MB per mutant) and reproducible: `mutants.ts --emit <id> <dir>`.
- **State the files cannot express** (exhaustion marks, an old usage snapshot) is written by
  the production `StateStore` in a CHILD process whose env is the row's (`seed.ts --state-child`).
- **Locks.** A dead-holder lock file is a pid from a process that already exited, host =
  `os.hostname()`. The lock directory does not exist in a fresh HOME: create it before `chmod`.
- **Restore permissions in `finally`.** Rows `chmod 000` a file or `0500` a directory; the
  harness registers the restore with `onCleanup` so a failed row cannot leave an unreadable tree.
- **zsh.** Quote globs (`--include='*.ts'`); an unquoted one is a zsh error.
- **Never edit `packages/*/src`** from here. A product defect is recorded in `failures.md`.

## Files (ownership)

| File | Job |
|---|---|
| `rows.ts` | the row table; validates every contract field on load |
| `run-row.ts` | CLI and orchestrator: pin, real run, flake retry, mutant runs, `rows-summary.md` |
| `harness.ts` | the run engine: temp tree, fake, canary, sink, pre-flight, standing assertions, leak scan |
| `agree.ts` | the per-class three-source check (pure) |
| `direct.ts` | `claudish serve` start, `postMessage`, `killTree` |
| `fake-upstream.ts` | fake Codex upstream: token endpoint (delay, mode, revoke-on-use), `/responses` |
| `canary.ts` | the metered-host listener (`api.openai.com`), with `reset()` |
| `seed.ts` | `config.json`, token files, legacy file, catalog copy; production-code state seeding |
| `row-env.ts` | whitelist child env, real-home guard, offline profile, pin |
| `egress-sink.ts` | loopback `HTTP(S)_PROXY` that records and refuses non-loopback targets |
| `mutants.ts` | the textual mutants, `--check`, `--emit` |
| `e20.ts`, `e20-*.ts` | E20 parity (stage 4c; not edited by 4b) |
