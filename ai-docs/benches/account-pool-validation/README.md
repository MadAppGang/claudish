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
bun ai-docs/benches/account-pool-validation/mutants.ts --check          # expect: 33 OK, 0 BAD (anchors unique + each mutant still parses)
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
HOME is never the real home, except in V2e (below: `security` finds keychains only through
`$HOME`, so V2e passes the real HOME with `CLAUDISH_CONFIG` naming a config that lists only the
fake account); no credential in any product-output file (every file in the run directory except the
`EVIDENCE_FILES` list in `harness.ts`: new output files are scanned by default).

The leak scans (`harness.ts` `scanLeaks`, `cred-shape-scan.ts`):

- **Every file is read whole**, in 4 MiB windows with a 64 KiB overlap (`fileWindows`). No file is
  skipped for its size; an earlier version skipped files over 5 MB without failing.
- **Exact values.** The bench's own credentials are searched by value in product output
  (`runSecrets`): the seeded tokens, the refresh tokens the fake accepts, the row's mid-run extras,
  and every token the fake actually ISSUED (`Fake.issued()`, recorded before the answer is sent).
  The `at-rotated-N` shape net stays as a second net.
- **Real credentials, by shape.** A credential that enters from OUTSIDE is not one of those values
  (run 14 recorded a real 1821-char JWT bearer in `fake.jsonl`). `realCredentialFindings` scans every
  file of the run, `fake.jsonl`, `bodies/` and `preflight/` included, for a JWT (three base64url
  segments, the first starting `eyJ`, at least 100 chars) or an `sk-` key of at least 20 chars that is
  not one of the bench's own values. A finding fails `[standing] no real-credential-shaped string in
  any run file`. It names file, byte offset, length and a sha256 prefix, never the value. Bundle copies
  are not scanned (`BUNDLE_DIRS`: `mutant-trees/`, `mutant-tree/`, `mutants/`, `dist/`,
  `node_modules/`, `.git/`); a `mutant-<id>/` directory is scanned by that mutant's own run. E20's
  `scanSecrets` runs the same shape scan over `--out`, and `v2e-real.ts` runs it over its `--out` last
  and reports found / not found.

**No parent request follows a redirect.** The offline sandbox wraps the product child, not the Bun
parent. Every parent-side HTTP request goes through `direct.ts` `parentFetch`, which forces
`redirect: "manual"`; a 3xx comes back as `DirectReply.redirect` (status and `Location`, never
contacted). In a row that is `notes.harnessError` plus a failed `[standing]` check: ERROR, no flake
retry, never PASS, and a mutant run is ERROR, never RED. In E20 it is a problem (case ABORTED), a
failed seam proof, or a harness error of a mutant run (ABORTED). `direct.test.ts` fails on any new
bare `fetch(` in the bench.

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
- **An E20 mutant is red only with its own upstream request.** Each `V16_MUTANTS` entry declares
  `evidence`, the request that proves the mutated code ran (`POST /backend-api/codex/mutant` for the
  endpoint mutant, `POST /backend-api/codex/responses` for the others). `mutantVerdict`: a harness
  error (egress, leak, canary, redirect) or a missing evidence request is ABORTED (fails the exit code,
  never red); evidence plus a difference from the unmutated candidate is red; evidence and no
  difference is DEAD-MUTANT. A difference alone (a crash, a refused start) proves nothing.
- **`mutant-trees/` is bulky** (6.6 MB per mutant) and reproducible: `mutants.ts --emit <id> <dir>`.
- **State the files cannot express** (exhaustion marks, an old usage snapshot) is written by
  the production `StateStore` in a CHILD process whose env is the row's (`seed.ts --state-child`).
- **Locks.** A dead-holder lock file is a pid from a process that already exited, host =
  `os.hostname()`. The lock directory does not exist in a fresh HOME: create it before `chmod`.
- **Restore permissions in `finally`.** Rows `chmod 000` a file or `0500` a directory; the
  harness registers the restore with `onCleanup` so a failed row cannot leave an unreadable tree.
- **zsh.** Quote globs (`--include='*.ts'`); an unquoted one is a zsh error.
- **Never edit `packages/*/src`** from here. A product defect is recorded in `failures.md`.

## Row V2e (keychain memo bypass) and `--recover-keychain`

V2e is the only row that touches the macOS keychain: it stores ONE fake item in your default
(login) keychain, so it is NOT part of `--all`. Run it by name, once, on purpose:

```bash
bun ai-docs/benches/account-pool-validation/run-row.ts --row V2e --out <dir>
```

What it does: two `serve` processes on an expired token stored in the default keychain through
claudish's native path (`CLAUDISH_DISABLE_KEYCHAIN` not 1, no keychain redirect). Exchange count
must be 1 and the second process must use the rotated bearer. The mutant
`V2e-keychain-reads-memoized` drops `uncached` from `KeychainTokenStore.read`, so the second
process re-reads the stale memo and exchanges a revoked token. Timing precondition: both replies
must arrive < 3 s after the POSTs (the memo window); a slower run is an ERROR, never a PASS or a RED.

Why the default keychain: an earlier design created a throwaway keychain and added it to the
per-user search list, which is one setting shared by every running program. Observed on
2026-11-02, in this order: the V2e guard saw the new keychain file in the search list and restored
the list around each run; during those runs other programs (`gh`, Claude Code) raised stacked "wants
to use the login keychain" dialogs; the Mac had to be rebooted. That the search-list change CAUSED
the dialogs and the freeze is INFERRED, not proven (`ai-docs/architecture/keychain.md`). The design
is retired anyway: the bench now creates no keychain and changes no search list, default keychain,
lock state or keychain setting.

Safety (`keychain-guard.ts`, every part unit-tested with a fake `security`):

- Allowlist: the bench runs only `security find-generic-password` and
  `security delete-generic-password`, each exactly `-s claudish-accounts -a
  openai-codex:aaaaaaaaaaaa` (plus `-w` on a value read). Any other subcommand, flag, service or
  account (your real `openai-codex:...` items, anything under service `claudish`) throws before a
  process is spawned.
- The item is written only by the product's own writer: a child runs `KeychainTokenStore.write`
  (`writeKeychainItem`: `security -i add-generic-password ... -U -T /usr/bin/security`). The
  bench itself writes nothing.
- Preflight: one attribute-only read (no `-w`). Absent (exit 44) proceeds. A present item refuses
  the run ("a leftover bench item exists; run `--recover-keychain` to delete it"); it is never
  deleted automatically. Any other result refuses.
- HOME is the REAL home (owner decision: `security` finds keychains only through `$HOME`). The seed
  child and both serve processes get `CLAUDISH_CONFIG=<row dir>/home/.claudish/config.json`; the row
  refuses before the seed child if that config lists any `openai-codex` account other than
  `aaaaaaaaaaaa` (`assertFakeOnlyConfig`). With a non-empty account list the product ignores the
  legacy `~/.claudish/codex-oauth.json` (`AccountRegistry.refreshLegacySource`, registry.ts). Serve
  still writes its logs and startup metrics under the real `~/.claudish`.
- Every bench `security` call has a 15 s hard timeout. The FIRST timeout stops everything: no
  further keychain call except the one cleanup delete, every producer is killed, and the row is an
  ERROR. If a dialog appears, do not answer it: that is the finding.
- The product's own calls (inside serve) are watched: `ps` every 500 ms; a `security` process under
  the seed child or a serve that has run 5 s trips the guard the same way. 5 s because the product
  kills its own call at 10 s. This does NOT bound the dialogs to one: a call shorter than a poll can
  be missed, the other serve can start a call before the trip, and whether killing `security`
  closes its dialog is unmeasured.
- Cleanup (`finally`, SIGINT, SIGTERM, exit): every producer (seed child, both serve trees,
  registered at spawn) is killed and confirmed gone FIRST; then exactly one
  `delete-generic-password -s claudish-accounts -a openai-codex:aaaaaaaaaaaa`, only when this run
  started the product writer. Exit 44 (already gone) is fine. A producer not confirmed gone keeps
  the recovery file and the lock. The row has a 90 s deadline after which the cleanup still runs.
- Before the product writer starts, the recovery file
  `$TMPDIR/account-pool-validation-keychain-recovery.json` (0600, also `<row dir>/keychain-state.json`)
  records `{service, account, pid, startedAt}`; a successful cleanup removes it. A leftover file
  makes the next V2e run refuse and print the command.
- One lock file (`$TMPDIR/account-pool-validation-keychain.lock`, owner pid, stale after 5 min or a
  dead pid) keeps two bench runs apart; the second fails fast.
- `security-calls.json` in the row directory lists every call (values masked).

**After a crash, a leftover-item refusal, or an ERROR that names a cleanup failure:**

```bash
bun ai-docs/benches/account-pool-validation/run-row.ts --recover-keychain
```

It runs the same single delete of the fake item and removes the recovery file. By hand:
`security delete-generic-password -s claudish-accounts -a openai-codex:aaaaaaaaaaaa`.

Sandbox: the offline `sandbox-exec` profile may block the `securityd` mach service. Try V2e WITH the
sandbox first. Only if that fails for a reason you record, add
`--v2e-no-sandbox --v2e-no-sandbox-reason "<why>"`; the reason is written to the row's `outcome.json`
and the egress sink and the canary stay on.

## Files (ownership)

| File | Job |
|---|---|
| `rows.ts` | the row table; validates every contract field on load |
| `run-row.ts` | CLI and orchestrator: pin, real run, flake retry, mutant runs, `rows-summary.md` |
| `harness.ts` | the run engine: temp tree, fake, canary, sink, pre-flight, standing assertions, leak scan |
| `agree.ts` | the per-class three-source check (pure) |
| `direct.ts` | `claudish serve` start, `postMessage`, `parentFetch` (never follows a redirect), `killTree` |
| `cred-shape-scan.ts` | windowed file reads; the real-credential shape scan (file, offset, length, sha256 prefix; never the value) |
| `fake-upstream.ts` | fake Codex upstream: token endpoint (delay, mode, revoke-on-use, `issued()`), `/responses` |
| `canary.ts` | the metered-host listener (`api.openai.com`), with `reset()` |
| `seed.ts` | `config.json`, token files, legacy file, catalog copy; production-code state seeding |
| `row-env.ts` | whitelist child env, real-home guard, offline profile, pin |
| `egress-sink.ts` | loopback `HTTP(S)_PROXY` that records and refuses non-loopback targets |
| `mutants.ts` | the textual mutants, `--check`, `--emit` |
| `keychain-guard.ts` | V2e only: `security` allowlist, preflight, stop after the first timeout, one cleanup delete, lock, recovery, deadline |
| `e20.ts`, `e20-*.ts` | E20 parity (stage 4c; not edited by 4b) |
