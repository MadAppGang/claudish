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
3. **External prerequisite, every release** — the build downloads magmux from the
   LATEST release of `MadAppGang/magmux`, a different repository. The version that
   ships is therefore decided at build time by another repo's release state, not
   by anything in this one. If that download fails or that repo has no matching
   platform asset, the build fails before anything publishes.

## CI/CD

`release.yml`, triggered by `push` of a tag matching `v*`. It runs **no tests** —
`test.yml` triggers only on `pull_request` and `push` to `main`. The tag is
therefore the gate: everything must be green before the tag leaves the machine.

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

## Deploy monitoring

`none` — claudish publishes packages and binaries. No service is deployed, so
there is nothing to poll for health. The post-publish checks belong under
Verification.

## Verification

- `git ls-remote --tags origin refs/tags/vX.Y.Z` — exactly one ref, at the merge
  commit on `main`, not at a branch head.
- `npm view claudish version` and `npm view claudish dist-tags` — npm only moves
  `latest` to the highest semver, so a publish that leaves `latest` behind is
  invisible to `npm i`.
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

TODO — not settled by detection, and worth answering on the next release:
- whether a failed magmux download from `MadAppGang/magmux` should block a release
  or pin to a known-good magmux tag instead of `latest`.

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

verified: 2026-09-15 @ 22cef36
