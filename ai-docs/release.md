# Release playbook — claudish

## Authority

- `CLAUDE.md`, section "Releasing" — owns the procedure: which files are bumped by
  hand, why `packages/cli/src/version.ts` is generated rather than edited, why
  `git push --tags` is forbidden here, and how to release from a worktree.
- `.github/workflows/release.yml` — owns publishing. Everything that reaches a
  registry or a user is a step in this file.
- `.github/workflows/test.yml` — owns the quality gate, and its header comment
  explains why it holds no API-key secrets. That comment is load-bearing; read it
  before adding a secret.
- `cliff.toml` — owns changelog generation. `CHANGELOG.md` is written by CI, never
  by hand.

## Artifacts

One tag produces all of these. `packages/cli/package.json` is the manifest npm
publishes; the root `package.json` is private and versions the monorepo.

- npm `claudish` — the CLI. Published from `packages/cli` with `--provenance`.
- npm `@claudish/magmux-{darwin,linux}-{arm64,x64}` — four platform packages
  carrying the magmux binary, referenced from the CLI's `optionalDependencies`.
- A GitHub Release carrying four `claudish-*` binaries, the four magmux binaries,
  `manifest.json` and `checksums.txt`.
- The Homebrew formula in `MadAppGang/homebrew-tap`, when the repository variable
  `ENABLE_HOMEBREW` is `true`.

"Released" means npm serves the version AND the GitHub Release exists with its
assets. The Homebrew tap is downstream of both.

## Stages

`none` — one tag push fans out to every artifact with no manual promotion between
them. The `needs:` chain inside `release.yml` (build → release → publish-npm) is
internal ordering, not a promotion gate: nothing waits on a human, and there is no
prerelease channel or staging registry. A tag matching `*alpha*` or `*beta*` marks
the GitHub Release as a prerelease, which is the only variant.

## Dependencies

1. **Lockfile in sync** — `bun install --frozen-lockfile` proves it. The release
   workflow runs a plain `bun install`, so a drifted lockfile is not caught by CI.
2. **Internal lockstep** — the four `packages/magmux-*` packages must publish at
   the same version as `claudish`, because the workflow rewrites the CLI's
   `optionalDependencies` to the release version at publish time. A CLI published
   against platform packages that do not exist at that version installs
   "successfully" and then fails to find the binary at runtime.
3. **External prerequisite, every release** — the build downloads magmux from
   `MadAppGang/magmux`, a different repository, at the tag pinned in
   `.github/magmux.env` (with a checksum per platform; `bun run test:macos` installs the
   same pin). The pin, not that repo's latest release, decides what ships. If the pinned
   release lacks a platform asset or a checksum does not match, the build fails
   before anything publishes. Preflight lists the PINNED tag's assets.

## CI/CD

`release.yml`, triggered by `push` of a tag matching `v*`. It runs **no tests**.
`test.yml` triggers on `pull_request`, `push` to `main` and `workflow_dispatch`;
every trigger runs Linux jobs only, the `idle` and `rest` groups among them. No GitHub
workflow starts a macOS runner. The `pane` group, the `macOnly` files of `idle` and `rest`
(skipped on Linux), macos-bridge, the blind hook tests and hook loading on macOS run only
on this Mac, in `bun run test:macos`, which
must be green before the tag (`CLAUDE.md`, Releasing). The blind hook
tests and the hook loading (S1) tests run locally under `bun run test:macos --full` and in
the last nightly part (`--part 7/7`); the default `bun run test:macos` skips them. In CI, the Linux `hooks-loading` job runs
the S1 tests on every pull request and push. The tag is therefore
the gate: everything must be green before the tag leaves the machine.

**Tiers.** Pull requests and `bun run test:macos` run the ESSENTIAL tier
(`packages/cli/scripts/test-tiers.json`: the files listed for each slow category, at most
three, whatever their time; the `pinned` files, whatever their time; and, outside the slow
categories, no other file measured at 2 s or more); `bun run test:macos --full` runs
the FULL tier. A dispatch of `test.yml` and `weekly-tests.yml` run the `idle` and `rest`
groups of the GITHUB tier on Linux, without their `macOnly` files. The GITHUB tier is the
essential files plus every weekly file measured under `githubMaxSeconds` or not measured.
Weekly files measured at `githubMaxSeconds` or more run only on this Mac. The target is
every GitHub job under 50 s;
the tier does not cap a job's wall time (`ai-docs/architecture/testing.md`). The WEEKLY tier (full minus essential) runs on the owner's Mac in 7
nightly parts, one a night at 03:00 local: `scripts/weekly-macos-tests.ts` under launchd
runs `bun run test:macos --part <k>/7` on origin's main, k being the part with no result or
the oldest result, and writes
`~/Library/Logs/claudish-weekly-tests/part<k>.json`. A red part also writes
`RED-<UTC date>-part<k>.json` (date, part, commit, failing tests, log path) and shows a
notification naming it; triage reads and deletes the marker. `weekly-tests.yml` runs the
Linux github tier every Sunday (11:00 UTC; a failed run on `main` opens or updates the issue "Weekly
full test run failed"). The release gate is `bun run test:macos` on the release commit,
`bun scripts/weekly-macos-tests.ts --check` (every part green within 7 days) and
`bun run review:routing` on the release commit (a PASS verdict). A green
essential gate says nothing about a weekly file changed since its part last ran: for such
a change, run that part by hand (`--part <k>`) or `bun run test:macos --full`.
`ai-docs/architecture/testing.md` § Test tiers has the list and how to promote a file.

**The version bump is the PR's last commit, and it gets its own green run.** Once the
PR's CI is green, commit the bump (`CLAUDE.md`, Releasing) and push it, wait for that
commit's PR CI to finish green, then merge and tag the merge commit. The bump
regenerates `version.ts` and `bundled-recommended-list.json`, so a merge before its
run finishes tags a tree no CI validated.

**The PR run tests a merge preview, not the merge commit.** On `pull_request`,
`test.yml` checks out GitHub's merge of the PR head into `main`. Before tagging,
confirm the merge commit's tree equals
`git merge-tree --write-tree <main before the merge> <tested PR head>`; if `main`
moved in between, the tag would mark an untested tree.

When `main` moves under an open release PR, run `gh pr update-branch <n>`. Do not
re-run the PR's workflow: a re-run reuses the merge SHA of the original event, so it
tests the stale tree again. `update-branch` makes a new head that already contains
`main`, its `pull_request` run tests that tree, and the merge commit's tree then equals
the head's tree exactly. 12.3.2 needed this when PR #320 landed during the release PR's
CI run.

**Local gates do not replace the clean runner.** Run `bun run typecheck` again
after the LAST test file lands, not only after the source change. Treat CI as the
only neutral environment for tests that touch credentials or `~/.claudish`
caches: a developer machine (and a claudish-spawned session even more) carries
state a clean runner lacks. The 10.3.0 PR needed four CI runs for three faults
no local run showed — a test reading `~/.claudish/probe-models.json`, a type
error in a test written after the last typecheck, and a global `fetch` stub
counting a background request only a clean runner makes.

**The live catalog is the same trap, from both directions.** A test that reads the
cloud models catalog breaks when the catalog publishes a new generation (10.5.0:
grok-4.3 gained `xhigh`, so a Grok effort test failed on `main` too) and when the
runner has none cached (a request with an explicit provider awaits
`ensureCatalogReady(5000)`, equal to bun's 5 s test timeout, and shares any
earlier test's pending warm through a module-global promise). A failure on the
PR that also fails on a clean export of `origin/main` is not the release's, but
it is still a red gate: make the test hermetic (seed the catalog; disable and
reset the warm) and re-run, rather than tag over it.

The Claude Code boot check that gates a release is the "Claude Code boot canary" step of
`bun run test:macos` (the essential and the full tier). It boots each spawn shape against
the Claude Code pinned in `.github/claude-code.version`, fetched with `npm pack` (the
per-platform package; the Mac's own Claude Code is never used), with every scenario
booting at once (`--jobs`). Read the step's lines: a scenario that booted and read
differently means the pane boot reader no longer matches Claude Code, and a scenario that
did not boot or connect is a failed start. Fix the first, and rerun the gate for the
second.

Nightly part 1 (`bun run test:macos --part 1/7`) also boots npm's `latest` Claude Code,
with `scripts/boot-canary-latest.ts`. This step is advisory. The summary shows it as
`ADVISORY PASS` or `ADVISORY FAIL`, and it never makes the gate red. An `ADVISORY FAIL`
tells you that a new Claude Code release breaks a spawn shape before the pin moves to it.
No workflow file runs a canary.

Each run writes its canary output (`results.json` and one screen per spawn shape) to a
new temp directory of its own. The gate prints its path as `canary output: <dir>`, and
the advisory step writes to `<dir>/latest`. The gate does not remove these directories;
macOS removes old files in `$TMPDIR`.

**No GitHub workflow installs, downloads or runs Claude Code.**
`scripts/no-claude-code-in-ci.test.ts` (in test.yml's `scripts` job on every pull
request) parses every workflow and fails on `anthropics/claude-code-action`, an
`@anthropic-ai/claude-code` package, the standalone installer or a release download
(`claude.ai/install`, `downloads.claude.ai`, a `claude-code` release URL), the `ANTHROPIC_API_KEY` or
`CLAUDE_CODE_OAUTH_TOKEN` secret, a `claude` command (also inside a quoted
`bash`/`sh`/`zsh`/`dash -c` or `eval` string), or a step that starts a script that
downloads or runs Claude Code: `scripts/boot-canary.ts`, `scripts/boot-canary-latest.ts`,
`scripts/routing-review.ts`, `scripts/test-macos.ts`, `scripts/weekly-macos-tests.ts`, `bun run test:macos` or
`bun run review:routing`. Claude Code runs only on the Mac, on the owner's own login.

**The routing rulebook review is `bun run review:routing`, on the release commit.**
`scripts/routing-review.ts` exports the committed ref (default `HEAD`) with
`git archive` into a directory under the system temp directory, removes every
`.claude/`, `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.mcp.json` and
`.claude.json` from it, and runs `claude -p` there on the user's Claude Code login with
`--safe-mode`, `--strict-mcp-config`, `--setting-sources project` and only the Read,
Glob and Grep tools. Uncommitted edits are never reviewed (it warns when there are any).
It signs only with the claude.ai login. Before the export it refuses (exit 1, nothing
started) unless a claude.ai login is present (an OAuth access token in `.credentials.json`
or the Keychain login item) AND no API-key route exists: `primaryApiKey` in `.claude.json`,
the Console key Keychain item, or an `apiKeyHelper`, a `forceLoginMethod` other than
`claudeai`, or an Anthropic credential or base URL in the `env` of `managed-settings.json` or
any file in `managed-settings.d/`. A store that is present but empty, unreadable or not
answering refuses too, so a Mac holding both a login and a Console key must remove the key.
The refusal names the store, never a value.
It prints the verdict and each violation, writes `result.json` beside the export, and keeps
Claude Code's own JSON output there as `claude-output.json` (turns, cost, model).
Exit 0 is PASS; exit 1 is FAIL, an unreadable verdict, or Claude Code failing or
running past 20 minutes; exit 2 is a usage error. Anything but 0 stops the tag.
`--ref <rev>` reviews another commit, `--bin <claude>` names the binary, and
`--dry-run` exports the tree and prints the argv without starting Claude Code. A routing
pull request's author may run it on the branch before merge. `release.yml` no longer
reviews routing: its `bundled-list` job only refuses a bundled recommended list
unchanged since the previous tag, and the publish waits on it.

npm publishing uses OIDC trusted publishing, so no `NPM_TOKEN` exists and nothing
can be published from a developer machine. `HOMEBREW_TAP_TOKEN` is the only
release secret, and only the tap job uses it.

**What a soft-fail looks like here** — this workflow has three shapes that stay
green while shipping nothing, so a green conclusion is not evidence of a publish:

- The magmux platform publish loop ends in
  `|| echo "Failed to publish @claudish/${name} (may already exist)"`. A genuine
  failure is swallowed and the job still succeeds. Query each platform package on
  npm; do not read the run's conclusion.
- The CHANGELOG commit and push are deliberately non-fatal, with a comment
  explaining why. A missing changelog commit is expected behaviour under a race,
  not a failure.
- `update-homebrew` is gated on `vars.ENABLE_HOMEBREW == 'true'` and is SKIPPED,
  not failed, when unset. A skipped job reads as green.

The darwin binaries are built on `ubuntu-latest` and checked by
`scripts/check-darwin-binary.sh` (Mach-O arch, the embedded OpenTUI library of the
target), which fails the build. There is no `codesign` step: Bun ad-hoc signs the
binary. No step runs a darwin binary before it ships; `bun run test:macos --full` and
the last nightly part (`--part 7/7`) run the hook loading tests on a Mac under the same
Bun (`latest`). The default `bun run test:macos` does not run them.

**Reading a red `Tests` run** — shapes observed on PR #351, where the junit
summary and the log grep disagreed with the job's conclusion:

- junit can report 0 failures while `bun test` exits 1 from an "Unhandled error
  between tests": an exception at module load or after a test ended. Read the
  `[ci-tests] rest: … exit N` line and search the log for "Unhandled error"
  (run 40139308118).
- A junit failure with no message text does not match a log grep for failed
  tests. Parse the junit XML: on the first PR #351 run the log grep found 2 of
  the 4 failures.
- The CI checkout is shallow: there is no `origin/main` and no old commit. A
  test that runs git history commands at module load fails the whole `rest`
  group.
- The `macos-bridge and script tests` step is skipped when the rest step fails,
  so its own failures appear only on the next run.
- A release PR can get no `pull_request` run while main moves
  (`mergeable: UNKNOWN`). Merging main into the release branch starts one.

### Run a workflow job locally with act

`bun run act:local` (`scripts/act-local.ts`) runs a `release.yml` job on this Mac
with `act`, in Docker, so a job can be tried before the tag. It needs Docker
running and the image `catthehacker/ubuntu:act-latest` already pulled (it runs
with `--pull=false`). It runs the committed HEAD; uncommitted edits are not in
the run, and the script warns when there are any.

```
bun scripts/act-local.ts --job bundled-list --tag-case changed    # exit 0: "bundled recommended list changed since v0.0.0-act.base"
bun scripts/act-local.ts --job bundled-list --tag-case unchanged  # exit 1: "::error::the bundled recommended list was not regenerated ..."
bun scripts/act-local.ts --list                                   # act's job list for release.yml
bun scripts/act-local.ts --dry-run [--job <id>]                   # act -n: plans every step, starts no container
```

`--tag-case` simulates a `v*` tag push: in the clone, HEAD is tagged
`v0.0.0-act.base`, one commit is added (`changed` appends a newline to the bundled
recommended list, or to the `--change <path>` file; `unchanged` is an empty
commit) and tagged `v0.0.0-act.tag`, and act gets a push event for that tag. The
exit code is act's own; 2 is a usage error or a refused job, 1 a setup failure.
`--keep` keeps the temp dir and prints its path. `--workflow <file>` picks
another file under `.github/workflows` for `--list` and `--dry-run`.

How it keeps a run local and free of secrets:

- act runs in a temp repository that holds only the current commit and the
  `v*` tags merged into it, never in the worktree. No other branch, tag or
  object of the source is in it. The test tags and commits exist only there.
  Its `origin` push URL is `push-disabled-by-act-local`. The temp dir is
  removed at exit.
- Every git command runs with no `GIT_*` variable and with
  `core.hooksPath=/dev/null`, and `git init` uses an empty template, so no
  git hook of the caller's runs.
- act gets empty `--secret-file`, `--var-file`, `--env-file` and
  `--input-file` files, and never `-s`, `--secret`, `--var`, `--env` or
  `--input`. `--container-daemon-socket -` keeps the Docker socket out of the
  job containers, and `--rm` removes them.
- act's environment passes only PATH, USER, LANG, TMPDIR and DOCKER_CONTEXT
  from the caller. HOME and XDG_CONFIG_HOME are new empty dirs, so act reads no
  user config. DOCKER_HOST names the caller's Docker. DOCKER_CONFIG is a new
  dir holding only a `config.json` of `{}`, so act reads no registry credential,
  even when it pulls an image that is not present. No token (GITHUB_TOKEN,
  GH_TOKEN, NPM_TOKEN, ANTHROPIC_*) reaches act.
- The run stops before act starts when an actrc exists at `~/.actrc`,
  `~/.config/act/actrc`, `~/Library/Application Support/act/actrc` or the
  clone's `.actrc`: an actrc can add `-s` flags.
- A real run is allowed only for a job in `RUNNABLE_JOBS`. Any other job exits 2
  and act never starts. Ctrl-C, SIGTERM and a closed terminal (SIGHUP) reach
  act, and the temp dir is removed after act exits.

Which `release.yml` jobs can run:

- `bundled-list` runs fully. It reads only the git history of the clone.
- `build` cannot: it downloads magmux with `gh` and the workflow token, a
  secret.
- `release` cannot: it pushes the changelog to main and creates the GitHub
  Release.
- `publish-npm` cannot: it publishes to npm over OIDC.
- `update-homebrew` cannot: it needs `HOMEBREW_TAP_TOKEN` and pushes to the
  tap. With no variables it is not even planned (`vars.ENABLE_HOMEBREW` is
  unset).

`--list` and `--dry-run` work for every job. A dry run of the whole
`release.yml` exits 0; it plans the steps and runs none of them, so its green
says nothing about whether a step works.

## Deploy monitoring

`none` — claudish publishes packages and binaries. No service is deployed, so
there is nothing to poll for health. The post-publish checks belong under
Verification.

## Verification

- `git ls-remote --tags origin refs/tags/vX.Y.Z` — exactly one ref, at the merge
  commit on `main`, not at a branch head.
- `npm view claudish version` and `npm view claudish dist-tags` — npm only moves
  `latest` to the highest semver, so a publish that leaves `latest` behind is
  invisible to `npm i`. A 404 right after the job prints `+ claudish@X.Y.Z` is
  propagation, not a failed publish: for 10.3.0 each package appeared 1 to 6
  minutes later. Read the job log's `+ <package>@<version>` lines to tell the two
  apart.
- Poll two registry URLs directly, not `dist-tags.latest` and not `npm view`:
  the per-version manifest `https://registry.npmjs.org/claudish/X.Y.Z` AND the
  tarball `https://registry.npmjs.org/claudish/-/claudish-X.Y.Z.tgz`. The package
  is served when both answer 200. `latest` can move before the tarball exists, and
  `npm install claudish` then fails with E404. Wait up to 60 minutes after the
  job's `+ claudish@X.Y.Z` line before treating the package as stuck.
  Measured from that line to the manifest answering 200: 14.1.0 about 17 min,
  14.10.1 17 min 43 s, 14.14.0 about 19 min, 14.15.0 about 18 min, 14.12.0 and
  14.13.0 about 55 min (each cleared with no version bump), 14.18.5 25 min 45 s.
  On 14.18.5 the tarball still answered 404 at 26 min 6 s, with `latest` already
  at 14.18.5, and answered 200 by 30 min 34 s.
- `npm view @claudish/magmux-darwin-arm64 versions` and its three siblings — this
  is the check the swallowed publish failure above makes necessary.
- `gh release view vX.Y.Z` — exists, not a draft, assets attached.
- `npx -y claudish@X.Y.Z --version` in a clean environment. Install success alone
  is insufficient where `optionalDependencies` are involved: run the binary.

## Rollback

- **A pushed tag** — immutable. Never delete it, never move it. Fix forward.
- **An npm version** — immutable. Mask, then fix forward:
  `npm dist-tag add claudish@<last-good> latest` stops new installs bleeding, then
  `npm deprecate claudish@X.Y.Z "<reason>"` warns durably. Release X.Y.Z+1. Never
  unpublish; it breaks dependents and npm constrains it tightly.
- **A partial platform publish** — publish the missing `@claudish/magmux-*`
  packages at the SAME version. Never leave the CLI live against platform packages
  that do not exist.
- **The Homebrew formula** — mutable. Revert the commit in `MadAppGang/homebrew-tap`.
- **A burned version number** — first-to-origin wins. Renumber upward and
  re-release; never ship different content under a taken number, because
  same-version drift is invisible to installed clients forever.

## Decisions

The repository owner authorises each release, per run. A release command may run
the whole pipeline unattended when told so in that run's request; authorisation
never carries to the next invocation.

Two constraints hold regardless of who authorises:

- Never `npm publish` locally. CI/CD publishes; OIDC means a local publish cannot
  work, and attempting one races the workflow.
- Releases run from a git worktree, where tags, branches and the stash stack are
  shared with the main checkout and every sibling worktree. Never `git stash`
  during a release; use a WIP commit.

SETTLED, then SUPERSEDED — the magmux source. On 2026-09-23 (v10.0.2) the build
kept downloading the LATEST release of `MadAppGang/magmux`. Since `7563ab21`
(10.4.0) it is PINNED: `.github/magmux.env` holds the tag and one checksum per
platform, `release.yml` refuses a pin below `MIN_MAGMUX_VERSION` and verifies each
download, and the pane suites run against the same pin in `bun run test:macos` on this
Mac (no GitHub workflow runs them) — MCP slots run in
magmux panes, so the magmux that ships must be the one that was tested, and a new
magmux release must not change what an existing claudish tag ships. A missing asset
or checksum mismatch BLOCKS the release before anything publishes. Bump the pin
deliberately (tag and all four sums together) after `bun run test:macos --full` passes on it.

SETTLED 2026-09-15 — the two `displayWidth` tests in
`packages/cli/src/tui/viz/color.test.ts`. They were NOT flaky and must NOT be
quarantined. They compare `fallbackClusterWidth` against `Bun.stringWidth`, which
is a LIVE ORACLE whose Unicode tables move between Bun releases, and their budgets
(1081 total, 17 in `other`) are calibrated to one build. `test.yml` pins CI to Bun
`1.3.10`; a developer on Bun `1.4.0` measures `total 3017` with `other` at 576,
almost all `U+1160..U+11FF` — conjoining Hangul Jamo, which 1.4.0 measures as
zero-width. No claudish code changed. The tests now read the pin out of
`test.yml` and skip with a message naming both versions when the running Bun is
not the pinned one, so the local red is gone and the gate's coverage is not.

When the Bun pin is bumped, RE-BASELINE those budgets against the new oracle.
Never widen them to clear a red run: the budget is the whole assertion.

verified: 2026-11-17 @ be4e389a
