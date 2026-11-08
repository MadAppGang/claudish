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
   `.github/magmux.env` (with a checksum per platform; `test.yml` installs the same
   pin). The pin, not that repo's latest release, decides what ships. If the pinned
   release lacks a platform asset or a checksum does not match, the build fails
   before anything publishes. Preflight lists the PINNED tag's assets.

## CI/CD

`release.yml`, triggered by `push` of a tag matching `v*`. It runs **no tests** —
`test.yml` triggers only on `pull_request` and `push` to `main`. The tag is
therefore the gate: everything must be green before the tag leaves the machine.

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

`boot-canary.yml` also runs on PRs that touch `pane/` and every 6 hours: it boots
each spawn shape against the Claude Code pinned in `.github/claude-code.version`
(blocking cell) and npm's latest (non-blocking). It is not part of `release.yml`.
A red pinned cell means the pane boot reader no longer matches Claude Code —
fix that before releasing, the same as a red `test.yml`.

npm publishing uses OIDC trusted publishing, so no `NPM_TOKEN` exists and nothing
can be published from a developer machine. `HOMEBREW_TAP_TOKEN` is the only
release secret, and only the tap job uses it.

**What a soft-fail looks like here** — this workflow has four shapes that stay
green while shipping nothing, so a green conclusion is not evidence of a publish:

- The magmux platform publish loop ends in
  `|| echo "Failed to publish @claudish/${name} (may already exist)"`. A genuine
  failure is swallowed and the job still succeeds. Query each platform package on
  npm; do not read the run's conclusion.
- The `codesign` step is `continue-on-error: true`. Unsigned macOS binaries ship
  green.
- The CHANGELOG commit and push are deliberately non-fatal, with a comment
  explaining why. A missing changelog commit is expected behaviour under a race,
  not a failure.
- `update-homebrew` is gated on `vars.ENABLE_HOMEBREW == 'true'` and is SKIPPED,
  not failed, when unset. A skipped job reads as green.

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
  minutes later. Poll for up to 15 minutes before treating a package as missing,
  and read the job log's `+ <package>@<version>` lines to tell the two apart.
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
download, and `test.yml` runs the pane suites against the same pin — MCP slots run
in magmux panes, so the magmux that ships must be the one that was tested, and a
new magmux release must not change what an existing claudish tag ships. A missing
asset or checksum mismatch BLOCKS the release before anything publishes. Bump the
pin deliberately (tag and all four sums together) after the pane suites pass on it.

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

verified: 2026-10-30 @ e6c35b6d
