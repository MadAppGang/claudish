# Draft for MadAppGang/madbench: document how to swap ONE plugin in madbench-evals

Status: draft, not filed. It needs Jack's approval first. Classification (madbench-evals
gap rule, step 2): **present but hard to find**. The feature exists and works at preflight. The
skills mention it, but they do not show the case of swapping one installed plugin, or what it
costs a bench that needs host state. This is a skills documentation fix, so no stand-in is
needed.

```
$ madbench version
madbench 0.54.0
$ madbench skills --check --dir ~/.claude/plugins/cache/magus/madbench/0.12.3/skills
skills 0.53.0 · madbench 0.54.0 · stale
```

## Title

madbench-evals: show `harness.config.plugins` as the way to swap one installed plugin, and what
`home` then needs

## The case that hit it

claudish's `recommended-effort` Bench (`ai-docs/benches/recommended-effort/` in
MadAppGang/claudish) has to compare the installed `claudish@magus` plugin's `claudish-usage`
skill with a working-tree version of that skill. Everything else must stay the same. The Bench
ran at `sandbox: workspace` because level `home` hides `~/.claudish`. At `workspace` the host
loaded the installed plugin, so the skill under test was never in the run. Nothing in
madbench-evals told the author which key swaps one plugin. The answer, `harness.config.plugins`,
is in `docs/harness.md` §3a and §4 ("Plugin tree | `config.plugins` (preferred)",
`~/.claude/plugins/cache/magus/dev/3.3.0  # a folder inside your own registry`). The skill has
the key, but three facts that decide whether a bench can use it are missing.

## What madbench-evals lacks (measured against the 0.53.0 skill set)

1. **The swap itself.** `harness-and-sandbox.md` §6 and `schema.md` §1a describe staging a
   plugin folder. Neither says that staging REPLACES the host's plugin set: the registry lives
   in the run's own HOME, so no host plugin loads unless it is staged too. Neither shows the
   use "run against this version of a plugin I have installed" (a cache folder, `~` expanded).
   `docs/harness.md` shows both.
2. **`config.plugins` and host state.** §6 ends "Plugin staging needs sandbox level `home` or
   higher". It does not say what a bench loses at `home` (every host file under `~`), or that
   `sandbox.share.paths` with `access: rw` brings one path back
   (`docs/sandbox-levels.md` § Sharing things into a sandbox). A bench whose tool keeps its
   state in `~/.<tool>` reads the first sentence and stays at `workspace`, where `config.plugins`
   is refused (`docs/harness.md` §3a, Requirements). It ends up running the host's plugin instead.
3. **Symlinks in a staged plugin stay symlinks.** A plugin folder whose skill is a symlink into
   a working tree, the obvious way to keep it current, is copied with the link intact
   (v0.54.0 tree: `internal/sandbox/common.go` `copyDir` recreates `e.Link` with
   `os.Symlink`). At `home` on macOS the read confinement should then deny the target. That
   follows from `docs/sandbox-levels.md` § `home` and was not run. `docs/` does not cover it,
   and preflight cannot see it.

Separately, the skill set is stale against 0.54.0: `harness-and-sandbox.md` §9 says
"`version` | print version — **there is no `--version` flag**". 0.54.0 ships `madbench --version`
and `madbench changelog` (`madbench changelog`: "madbench --version now works and prints what
madbench version prints").

## Proposed patch to `skills/madbench-evals/harness-and-sandbox.md` §6

Append after the paragraph that starts "Use `config.plugins` alone when…":

```markdown
**Swapping one plugin.** Staging is the way to run against a plugin version of your choosing,
an installed one (`~/.claude/plugins/cache/<mkt>/<plugin>/<version>`, `~` expanded) or a
folder beside the bench. Staging REPLACES the host's plugin set: the registry is the run's
own HOME, so a host plugin you did not stage does not load. To A/B one file of a plugin
(a skill's `SKILL.md`), stage two folders that differ only in that file, one per variant
through a param (`plugins: ["{{plugin}}"]`), and declare
`guard_changes: {allow: [harness/config/plugins]}`.

**It needs `home`, so bring back what the tool needs.** At `none` and `workspace` madbench
refuses `config.plugins`. At `home`, every host path under `~` is hidden. A tool that keeps
state there (credentials, caches) gets it back with a live share:

    sandbox:
      level: home
      share:
        paths:
          - { from: ~/.mytool, to: ~/.mytool, access: rw }

**Copy files into the folder; do not symlink them.** A staged plugin is copied with its
symlinks intact. At `home` on macOS the read confinement denies a link target outside the
sandbox, and preflight does not catch it.
```

And in §9's command table, replace the `version` row:

```markdown
| `version` | print version; `madbench --version` prints the same (0.54.0+) |
| `changelog` | print the release notes (0.54.0+) |
```

## Why not a local workaround

A copy of the skill into the workspace (`<testdata>/.claude/skills/…`) is project scope at
`workspace`. The installed plugin's skill still loads beside it at user scope, so the run has
both and measures neither. madbench's own mechanism is the only clean swap.

## Addendum: `home` and tools installed under `~` (measured on the same Bench, 2026-10-23)

A bench that moves to `home` for `config.plugins` hits the read confinement wherever its MCP
server or the processes that server spawns live under the real home. It failed four times in a
row. Each time the cause showed up in a different place:

| Step | What was hidden | What the run reported |
|---|---|---|
| MCP `command: "bun"` → `/Users/jack/.bun/bin/bun` | `~/.bun` | run3, 24/24: `environment:mcp-reachable: MCP server "claudish" did not answer madbench's pre-launch handshake: the initialize deadline elapsed before the server answered: context deadline exceeded; exit: signal: killed`, plus the CLI's `{"error":"Connection closed","errorCode":"CONNECTION_CLOSED","name":"claudish"}` |
| a bundle at `<repo>/packages/cli/dist/index.js` importing `@opentui/*` from `<repo>/packages/cli/node_modules` → `<repo>/node_modules/.bun` | the package root above the declared script directory | run4/run5: `the server closed stdout before answering initialize (the CONNECTION_CLOSED shape); stderr: error: Unexpected while resolving package '@opentui/core' from '…/packages/cli/dist/index.js'`. Sharing only the two `node_modules` trees did not fix it; sharing `packages/cli` and the root `package.json` did |
| the server's own temp root `/tmp/claudish-mux-501` | `/tmp` outside the allow-set | run6: the server logged `[mcp] stale pane sweep failed: EPERM: operation not permitted, lstat '/tmp/claudish-mux-501'` |
| an interactive Claude Code child the server starts in the same HOME | madbench's first-run seeding only on an interactive host | run7: the child stopped at "Welcome to Claude Code v2.1.309 … Let's get started. Choose the text style…" (claudish: `first_run_dialog`) because the host was `interactive: false` |

Separately, `access: ro` is refused at `home`, and only at preflight: `madbench list` loads the
bench. The message is `sandbox: level home cannot share "/Users/jack/.bun" read-only — a local process writes anything it can read; use access: copy to snapshot it, or level container`.
`copy` is not usable for `~/.bun` (29 GB), so the shares are `rw`.

Two things to report:

1. **Bug-shaped (needs a reproduction from madbench):** in the first case the failed-server row
   carried no stderr and no hint that the `command` itself was unreadable. `docs/harness.md`
   says a failed row carries "the server's own words — JSON-RPC error, stderr tail, exit
   status". A binary that cannot be executed produces no words. Preflight could flag a bare
   `command` that resolves on PATH into a directory the `home` profile will hide. It already
   resolves `command` on this machine (§ MCP declarations).
2. **Skills text (proposed, `harness-and-sandbox.md` §4 or §7a):**

```markdown
**At `home`, a server's toolchain is part of the server.** The profile declares an MCP
server's absolute `command`, `args` and `cwd`, and the directory its script sits in. It does
NOT declare:
- a bare `command` that PATH resolves under `~` (`bun` in `~/.bun/bin`, `claude` in
  `~/.local/bin`): write it absolute, and share the install directory (`access: rw`; `ro` is
  container-only, and `copy` duplicates the whole tree);
- the package root above the script (`node_modules`, `package.json`): share it;
- temp or socket directories the server uses (`/tmp/<tool>-<uid>`): point the tool at a
  dedicated directory and share that.
Interactive children the server starts in the run's HOME need madbench's first-run seeding,
which only an interactive host gets: make the host `interactive: true` with
`--permission-mode bypassPermissions`. Prove the server with one single-trial Scenario
(`environment:mcp-reachable`) before a sweep.
```
