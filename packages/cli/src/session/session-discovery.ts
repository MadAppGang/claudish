/**
 * session-discovery — find resumable Claude Code sessions, grouped by worktree.
 *
 * Claude Code stores one JSONL transcript per session at
 * `~/.claude/projects/<slugged-cwd>/<session-uuid>.jsonl`. The FILENAME is the id
 * `claude --resume` takes, so nothing here has to parse a file to know what to resume.
 *
 * SCALE IS THE DESIGN CONSTRAINT, and it is not hypothetical. MEASURED on this machine:
 * 5,656 transcripts across 219 project directories, 2.57 GB in total, the largest single
 * file 73.5 MB. Reading transcripts to build a list is therefore off the table — it
 * would be gigabytes of I/O to draw one screen. Two rules follow, and everything below
 * is shaped by them:
 *
 *   1. THE LIST IS BUILT FROM DIRECTORY NAMES AND `stat` ALONE. Grouping, worktree
 *      identity and recency all come from the path and the mtime, so opening a
 *      transcript is never on the path to a rendered row.
 *   2. DETAIL IS HYDRATED LAZILY, AND ONLY IN BOUNDED CHUNKS. `hydrateSession` reads a
 *      64 KB head and a 128 KB tail with positioned reads — never the middle, never the
 *      whole file — so a 73 MB transcript costs the same as a 73 KB one.
 */

import { execFile, execFileSync } from "node:child_process";
import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { projectDirNameFor } from "../channel/parent-proof.js";

/** Head bytes scanned for the `entrypoint` marker. See `isAgentSession`. */
const ENTRYPOINT_BYTES = 8192;

/** Where Claude Code keeps transcripts. */
export const PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * Claude Code's directory name for a working directory: every character outside
 * `[A-Za-z0-9]` becomes `-`. MEASURED against real directories —
 * `/Users/jack/mag/claudish/.claude/worktrees/x` becomes
 * `-Users-jack-mag-claudish--claude-worktrees-x`, the doubled dash being the `/` and
 * the `.` of `/.claude` in sequence, and a live run in a cwd named `fresh_cwd.v1`
 * created `…-fresh-cwd-v1`: the `_` is replaced too. This used to replace only `/` and
 * `.`, so a cwd with `_`, a space or `@` produced a transcript path that did not exist.
 *
 * ONE rule: this is `projectDirNameFor` (`channel/parent-proof.ts`), the function the
 * parent-conversation proof searches with, so the path claudish derives for a child's
 * transcript and the directory the proof looks in cannot drift apart. Callers pass a
 * realpath (`transcriptPathFor` resolves one; git hands out real paths).
 *
 * The mapping is deliberately NOT inverted anywhere in this file. It is lossy — a `-`
 * in the slug could have been any non-alphanumeric character — so un-slugging a path
 * would guess. Every real path here comes from git or from the caller instead.
 */
export function slugForPath(absPath: string): string {
  return projectDirNameFor(absPath);
}

/**
 * Where Claude Code will write the transcript for a session running in `cwd`
 * under `sessionUuid`. Both halves are known before the child starts — claudish
 * mints the uuid and passes it as `--session-id` — so this is a derivation, not
 * a search by mtime.
 *
 * **The slug is taken from the REALPATH.** Claude Code resolves symlinks before
 * slugging, and every other caller here starts from a path git handed it, which
 * is already real. A path that came from a user (`work_dir`, `process.cwd()`
 * inside a symlinked worktree, anything under macOS `/tmp` → `/private/tmp`)
 * has not been resolved, and its raw slug names a directory that does not
 * exist. That is exactly how the two silent-success sessions' transcripts were
 * declared "missing": they were under the session's own `work_dir`, in a
 * project directory nobody thought to look in.
 *
 * Falls back to the path as given when it cannot be resolved — a cwd that has
 * since been deleted should still produce the best guess available, not null.
 */
export function transcriptPathFor(cwd: string, sessionUuid: string): string {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // Deleted, unreadable, or never existed. The unresolved slug is still the
    // right answer whenever no symlink was involved.
  }
  return join(PROJECTS_DIR, slugForPath(real), `${sessionUuid}.jsonl`);
}

/** A resumable session. Fields below `sizeBytes` are absent until `hydrateSession`. */
export interface SessionRow {
  /** The UUID `claude --resume` accepts. Taken from the filename. */
  id: string;
  file: string;
  mtimeMs: number;
  /**
   * When the transcript was CREATED. Free from the same `stat` as `mtimeMs`.
   *
   * Optional because a row can be built without one (tests, and any future source that
   * is not a `stat`), and every reader must treat an absent value as "unknown" rather
   * than as "old" — see `findLatestSessionId`, which falls back instead of excluding.
   */
  birthtimeMs?: number;
  sizeBytes: number;
  /** Claude Code's own generated title, the single best label for a session. */
  title?: string;
  /** The opening user prompt, cleaned of slash-command envelopes. */
  firstPrompt?: string;
  gitBranch?: string;
  /** Display columns of the final user message — "how big was the last thing I said". */
  lastMessageChars?: number;
  hydrated?: boolean;
  /**
   * The tail of the conversation, oldest → newest, user and assistant interleaved.
   *
   * A title says what a session was ABOUT; the last exchange says where it got to, which
   * is the thing you actually need to decide whether it is the one to resume.
   */
  recentTurns?: Array<{ role: "user" | "assistant"; text: string }>;
  /** Whether the deep search for a human turn has already run — see `hydrateConversation`. */
  conversationDeepened?: boolean;
  /**
   * How the session was launched: `cli` for one a human started, `sdk-cli` for one
   * driven programmatically. Read during the list pass because it decides whether the
   * row is OFFERED at all, and a filter cannot wait for lazy hydration.
   * Undefined when the marker was not in the file's first 8 KB.
   */
  entrypoint?: string;
}

/**
 * Whether this session was machine-driven rather than started by a person.
 *
 * claudish itself is a prolific source of these: every `team` member, every MCP channel
 * `create_session`, every `-p` one-shot and every e2e test spawns a real Claude Code
 * session that lands in the same project directory as your own work. MEASURED across
 * this repository: 1,923 of 2,018 transcripts are `sdk-cli` — so 95% of an unfiltered
 * picker is noise, and the seven interactive sessions you actually want are buried.
 *
 * FAILS OPEN. An unknown entrypoint (23 of 2,018, where the marker fell outside the
 * head we read) counts as a human session, because hiding a real conversation is a much
 * worse error than showing a spurious one.
 */
export function isAgentSession(row: SessionRow): boolean {
  return row.entrypoint !== undefined && row.entrypoint !== "cli";
}

/** One worktree (or the repo root) and every session recorded inside it. */
export interface WorktreeGroup {
  /** Worktree name, or `(root)` for the main checkout. */
  name: string;
  /** Absolute path when known from git; null for a worktree that has been deleted. */
  path: string | null;
  /** Whether git still lists this worktree. Sessions outlive their worktree. */
  live: boolean;
  /** Whether this is the worktree claudish is running in. */
  current: boolean;
  sessions: SessionRow[];
  /** mtime of the most recent session in the group. */
  lastActiveMs: number;
  /** Branch checked out in this worktree, short form. Absent for a deleted one. */
  branch?: string;
  /**
   * When the worktree came into existence.
   *
   * The directory's birthtime for a live worktree — the honest answer, and free from the
   * `stat` we already do. For a deleted one there is no directory left, so it falls back
   * to the OLDEST session recorded in it, which is when work there demonstrably started.
   */
  createdMs?: number;
  /** Whether any session here is still being written. */
  activeNow: boolean;
  /** Changed files (`git status --porcelain`). Undefined until enrichment resolves. */
  dirty?: number;
  /** Commits ahead of / behind upstream. Undefined when there is no upstream. */
  ahead?: number;
  behind?: number;
}

export interface RepoContext {
  /** The main checkout's absolute path. */
  root: string;
  /** The worktree cwd currently sits in (may equal `root`). */
  current: string;
  /** Absolute paths of every worktree git still knows about, including `root`. */
  liveWorktrees: string[];
  /** Worktree path → short branch name. Parsed from the same porcelain block, so free. */
  branchByPath: Map<string, string>;
}

/**
 * Locate the repository and its live worktrees.
 *
 * `--git-common-dir` is what distinguishes the main checkout from a worktree: inside a
 * worktree `--show-toplevel` is the worktree itself, while the common dir still points
 * at the parent's `.git`. Returns null outside a repository, which is a normal
 * condition (the picker then falls back to every project directory).
 */
export function getRepoContext(cwd: string = process.cwd()): RepoContext | null {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };
  const current = git(["rev-parse", "--show-toplevel"]);
  const commonDir = git(["rev-parse", "--git-common-dir"]);
  if (!current || !commonDir) return null;

  // `--git-common-dir` answers an absolute `/repo/.git` from a worktree and a bare
  // `.git` from the main checkout, so only the absolute form identifies the root.
  const root = commonDir.endsWith("/.git") ? commonDir.slice(0, -"/.git".length) : current;

  // `git worktree list --porcelain` emits a block per worktree:
  //   worktree /abs/path
  //   HEAD <sha>
  //   branch refs/heads/<name>       (absent when detached)
  // so the branch comes out of the call we already make, at no extra cost.
  const liveWorktrees: string[] = [];
  const branchByPath = new Map<string, string>();
  const porcelain = git(["worktree", "list", "--porcelain"]);
  if (porcelain) {
    let currentPath: string | null = null;
    for (const line of porcelain.split("\n")) {
      if (line.startsWith("worktree ")) {
        currentPath = line.slice("worktree ".length);
        liveWorktrees.push(currentPath);
      } else if (line.startsWith("branch ") && currentPath) {
        branchByPath.set(currentPath, line.slice("branch ".length).replace(/^refs\/heads\//, ""));
      }
    }
  }
  return { root, current, liveWorktrees, branchByPath };
}

/** `~/.claude/projects` entries, or `[]` when the directory does not exist yet. */
function projectDirs(): string[] {
  try {
    return readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Transcript files in one project directory, as `stat`-only rows. */
function sessionsIn(dirName: string): SessionRow[] {
  const dir = join(PROJECTS_DIR, dirName);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const rows: SessionRow[] = [];
  for (const n of names) {
    const file = join(dir, n);
    try {
      const st = statSync(file);
      // A zero-byte transcript is a session that died before writing anything; it
      // cannot be resumed into anything meaningful, so it is not offered.
      if (st.size === 0) continue;
      const row: SessionRow = {
        id: basename(n, ".jsonl"),
        file,
        mtimeMs: st.mtimeMs,
        birthtimeMs: st.birthtimeMs,
        sizeBytes: st.size,
      };
      // Classify here, in the list pass, because `entrypoint` decides whether the row is
      // shown at all — a lazily-hydrated filter would paint 2,000 rows and then collapse
      // to 70. MEASURED at 8 KB: 97ms across 2,018 files and the marker is found in
      // 1,995 of them; at 4 KB it misses 305, which is not worth the saving.
      const head = readChunk(file, 0, Math.min(ENTRYPOINT_BYTES, st.size));
      const m = /"entrypoint":"([a-z-]+)"/.exec(head);
      if (m) row.entrypoint = m[1];
      rows.push(row);
    } catch {
      // Raced with a delete. Skip.
    }
  }
  return rows;
}

/**
 * Fill in each live worktree's `dirty` / `ahead` / `behind`, off the render path.
 *
 * SPLIT FROM DISCOVERY ON PURPOSE, because the two have very different costs. MEASURED
 * on this repo: `git for-each-ref` answers ahead/behind for EVERY branch in one 16ms
 * call, while `git status --porcelain` costs ~40ms per worktree and cannot be batched —
 * 331ms across eight worktrees. Discovery itself is 10–17ms, so folding status into it
 * would make the picker twenty times slower to appear in exchange for a column most
 * users glance at once.
 *
 * So the picker paints immediately with what is free (branch, dates, activity) and calls
 * this afterwards; rows fill in as it resolves. Mutates the groups in place and resolves
 * when every probe has settled. Never throws — a worktree whose status cannot be read
 * simply keeps `undefined`, which the UI renders as "unknown" rather than as "clean".
 */
export async function enrichWorktreeGit(groups: WorktreeGroup[], repoRoot: string): Promise<void> {
  const run = (cwd: string, args: string[]): Promise<string> =>
    new Promise((resolve) => {
      execFile("git", args, { cwd, encoding: "utf-8" }, (err, stdout) =>
        resolve(err ? "" : stdout)
      );
    });

  // One call for every branch's upstream tracking, e.g. `main [ahead 2, behind 1]`.
  const trackByBranch = new Map<string, { ahead?: number; behind?: number }>();
  const refs = await run(repoRoot, [
    "for-each-ref",
    "--format=%(refname:short)\t%(upstream:track)",
    "refs/heads/",
  ]);
  for (const line of refs.split("\n")) {
    const [name, track] = line.split("\t");
    if (!name || !track) continue;
    const ahead = /ahead (\d+)/.exec(track)?.[1];
    const behind = /behind (\d+)/.exec(track)?.[1];
    if (ahead || behind) {
      trackByBranch.set(name, {
        ...(ahead ? { ahead: Number(ahead) } : {}),
        ...(behind ? { behind: Number(behind) } : {}),
      });
    }
  }

  // Status is per-worktree and unbatchable, so run them concurrently rather than in
  // series — the cost becomes the slowest single probe instead of their sum.
  await Promise.all(
    groups.map(async (g) => {
      if (g.branch) Object.assign(g, trackByBranch.get(g.branch) ?? {});
      if (!g.path || !g.live) return;
      const out = await run(g.path, ["status", "--porcelain"]);
      g.dirty = out.split("\n").filter((l) => l.trim().length > 0).length;
    })
  );
}

/** True when `p` is `root` itself or lives beneath it. Path-segment aware, so
 * `/repo-old` is NOT under `/repo` — the exact confusion the slug cannot avoid. */
function isUnder(p: string, root: string): boolean {
  return p === root || p.startsWith(`${root}/`);
}

/**
 * The absolute `cwd` a project directory's sessions ran in, read from a transcript.
 *
 * Claude Code records `cwd` on most records, so the head of any one transcript settles
 * what the lossy slug cannot: whether `-Users-j-mag-claudish-old` is this repo's
 * `old/` subdirectory or a different checkout called `claudish-old`.
 *
 * Deliberately called ONLY for the ambiguous case — a directory whose slug extends the
 * root's with no worktree marker. Doing it for all 219 project directories on this
 * machine would put ~200 file opens on the picker's startup path to answer a question
 * git has already answered for every case that matters.
 *
 * The known gap, stated rather than hidden: a DELETED worktree that lived outside the
 * root is invisible — git no longer lists it and its slug does not extend the root's, so
 * nothing points at it. Finding those would cost the full scan this avoids.
 */
function readProjectCwd(dirName: string): string | null {
  const rows = sessionsIn(dirName);
  if (rows.length === 0) return null;
  // Newest first: an old transcript may predate a directory move.
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const row of rows.slice(0, 2)) {
    for (const r of parseRecords(
      readChunk(row.file, 0, Math.min(HEAD_BYTES, row.sizeBytes)),
      false
    )) {
      if (typeof r.cwd === "string" && r.cwd) return r.cwd;
    }
  }
  return null;
}

/**
 * A session is treated as LIVE when its transcript was touched within this window.
 *
 * Claude Code appends continuously while a session is open — mode lines, snapshots and
 * titles land alongside messages — so a recent mtime is a good liveness proxy and the
 * only one available without inspecting processes. 120s is deliberately generous: the
 * cost of calling a finished session "active" is a misleading dot, while the cost of
 * calling a live one dead is offering to resume a session that is currently writing,
 * which is the genuinely damaging mistake.
 */
export const ACTIVE_WINDOW_MS = 120_000;

export function isActive(row: SessionRow, now = Date.now()): boolean {
  return now - row.mtimeMs < ACTIVE_WINDOW_MS;
}

/**
 * Group every session belonging to `repo` by worktree.
 *
 * Assignment is by LONGEST MATCHING SLUG PREFIX against the known worktree paths, which
 * is what correctly folds a session started in a subdirectory back into its worktree:
 * `…-worktrees-gemini-fix-packages-cli` is a session run from `packages/cli` inside the
 * `gemini-fix` worktree, not a worktree called `gemini-fix-packages-cli`. Matching
 * shortest-first would put it in its own phantom group, and splitting the slug on `-`
 * cannot work at all because worktree names contain dashes.
 *
 * Worktrees git no longer lists still appear, marked `live: false`. Their transcripts
 * remain on disk and remain resumable, and hiding them would silently drop history.
 */
export function discoverWorktreeGroups(repo: RepoContext): WorktreeGroup[] {
  const rootSlug = slugForPath(repo.root);
  // EVERY project directory is considered, not just those whose slug starts with the
  // root's. A slug-prefix filter is wrong in both directions, because the slug is lossy:
  //   - it ADMITS a foreign sibling — `/Users/j/mag/claudish-old` slugs to
  //     `-Users-j-mag-claudish-old`, which prefix-matches the root just as a real
  //     subdirectory would, so another project's sessions get listed as resumable here;
  //   - it DROPS a legitimate worktree created outside the root, which
  //     `git worktree add ../repo-feature` does by default — git knows about it, the
  //     prefix test does not, and it never reaches the picker at all.
  // Ownership is decided below against git's own worktree list and, where that cannot
  // settle it, against the transcript's recorded `cwd`.
  const mine = projectDirs();

  // Longest first so the most specific worktree claims a directory before the root does.
  const known = [...repo.liveWorktrees]
    .map((p) => ({ path: p, slug: slugForPath(p) }))
    .sort((a, b) => b.slug.length - a.slug.length);

  const groups = new Map<string, WorktreeGroup>();
  /**
   * Group name → the absolute `cwd` its sessions recorded, for the dead-worktree fold
   * below. Populated lazily and only for groups with no live path, since that is the
   * only case the fold has to adjudicate.
   */
  const groupCwd = new Map<string, string>();
  const upsert = (name: string, path: string | null, live: boolean): WorktreeGroup => {
    let g = groups.get(name);
    if (!g) {
      g = {
        name,
        path,
        live,
        current: path !== null && path === repo.current,
        sessions: [],
        lastActiveMs: 0,
        activeNow: false,
        ...(path ? { branch: repo.branchByPath.get(path) } : {}),
      };
      groups.set(name, g);
    }
    return g;
  };

  const WORKTREE_MARK = "--claude-worktrees-";
  // The root's slug is a prefix of EVERY worktree directory under it
  // (`-Users-jack-mag-claudish` prefixes `-Users-jack-mag-claudish--claude-worktrees-x`),
  // so the root must never win a prefix match — it would swallow every worktree whose
  // directory no live worktree claims. MEASURED before this exclusion: 43 project
  // directories collapsed into 6 groups, with 1,471 sessions wrongly filed under
  // `(root)`. Worktree ownership is therefore decided by the MARKER first, and the
  // root only claims directories that have no marker at all.
  const worktreeMatches = known.filter((k) => k.path !== repo.root);

  for (const dir of mine) {
    const at = dir.indexOf(WORKTREE_MARK);
    let name: string;
    let path: string | null;
    let live: boolean;

    // 1. A worktree git currently lists, matched on its REAL path's slug. This is the
    //    only branch that can see a worktree living outside the root.
    const hit = worktreeMatches.find((k) => dir === k.slug || dir.startsWith(`${k.slug}-`));
    if (hit) {
      path = hit.path;
      live = true;
      name = hit.path === repo.root ? "(root)" : basename(hit.path);
    } else if (at !== -1 && dir.startsWith(rootSlug)) {
      // 2. A worktree git no longer lists, nested under this root. Its transcripts
      //    survive and stay resumable, so it keeps a group. Un-slugging is lossy, so a
      //    deleted worktree's subdirectory sessions may carry a suffix in the heading
      //    rather than being silently merged or dropped.
      path = null;
      live = false;
      name = dir.slice(at + WORKTREE_MARK.length);
    } else if (dir === rootSlug) {
      // 3. The main checkout itself.
      name = "(root)";
      path = repo.root;
      live = true;
    } else if (dir.startsWith(`${rootSlug}-`) && at === -1) {
      // 4. AMBIGUOUS: the slug extends the root's, with no worktree marker. That is
      //    either a subdirectory of this repo (`<root>/packages/cli`) or a different
      //    project whose name merely starts the same way (`<root>-old`, `<root>.bak` —
      //    `.` slugs to `-` too). The slug cannot tell them apart, so ask the
      //    transcript, which records the absolute `cwd` it ran in.
      const cwd = readProjectCwd(dir);
      if (!cwd || !isUnder(cwd, repo.root)) continue; // a foreign sibling — not ours
      name = "(root)";
      path = repo.root;
      live = true;
    } else {
      // Belongs to some other repository entirely.
      continue;
    }

    const g = upsert(name, path, live);
    if (path) groupCwd.set(name, path);
    else if (!groupCwd.has(name)) {
      const cwd = readProjectCwd(dir);
      if (cwd) groupCwd.set(name, cwd);
    }
    for (const s of sessionsIn(dir)) {
      g.sessions.push(s);
      if (s.mtimeMs > g.lastActiveMs) g.lastActiveMs = s.mtimeMs;
    }
  }

  // Fold a deleted worktree's subdirectory groups back into the worktree itself.
  //
  // A live worktree gets this free from the prefix match against its real path, but a
  // deleted one has no path to match, so `mcp-failed-auth` and
  // `mcp-failed-auth-packages-cli` arrive as two headings for one worktree. Names are
  // all we have, so the fold is name-based: a group merges into the LONGEST other group
  // whose name it extends with a `-`. That rule cannot merge two genuinely different
  // worktrees, because a worktree named `foo-bar` only absorbs `foo-bar-<something>`,
  // and if a real worktree `foo-bar-baz` also exists it is itself a group and wins by
  // being longer.
  const names = [...groups.keys()].sort((a, b) => b.length - a.length);
  for (const name of [...groups.keys()]) {
    const g = groups.get(name);
    if (!g || g.live) continue;
    const parent = names.find((n) => n !== name && name.startsWith(`${n}-`) && groups.has(n));
    if (!parent) continue;
    const into = groups.get(parent)!;

    // NAME SHAPE IS NOT ENOUGH — confirm the descent against the recorded `cwd`.
    //
    // The name test cannot tell "a subdirectory of worktree X" from "a sibling worktree
    // called X-something". For LIVE worktrees git settles it, but two DEAD siblings both
    // reach here: worktrees `resume` and `resume-message` under one root would see
    // `resume-message` folded into `resume`, losing its heading and filing its sessions
    // under an unrelated worktree — the "silently drop history" outcome this pass exists
    // to avoid. So the transcripts decide: fold only when the child really did run
    // beneath the parent.
    const childCwd = groupCwd.get(name);
    const parentCwd = groupCwd.get(parent);
    if (!childCwd || !parentCwd || !isUnder(childCwd, parentCwd)) continue;

    into.sessions.push(...g.sessions);
    into.lastActiveMs = Math.max(into.lastActiveMs, g.lastActiveMs);
    groups.delete(name);
  }

  for (const g of groups.values()) {
    g.sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    g.activeNow = g.sessions.some((s) => isActive(s));
    // Birthtime for a live worktree is the real creation moment. For a deleted one the
    // directory is gone, so the oldest session is the best available evidence of when
    // work there began.
    if (g.path) {
      try {
        g.createdMs = statSync(g.path).birthtimeMs;
      } catch {
        /* removed under us; fall through to the session-based estimate */
      }
    }
    if (!g.createdMs && g.sessions.length > 0) {
      g.createdMs = g.sessions.reduce((m, s) => Math.min(m, s.mtimeMs), Number.POSITIVE_INFINITY);
    }
  }

  // Current worktree first, then most recently active. The current worktree is almost
  // always what the user means, and making them hunt for it would defeat the point.
  return [...groups.values()]
    .filter((g) => g.sessions.length > 0)
    .sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      return b.lastActiveMs - a.lastActiveMs;
    });
}

// ---------------------------------------------------------------------------
// Lazy hydration — bounded reads only
// ---------------------------------------------------------------------------

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 128 * 1024;

/** Read up to `len` bytes at `pos`. Returns "" on any I/O failure. */
function readChunk(file: string, pos: number, len: number): string {
  if (len <= 0) return "";
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.allocUnsafe(len);
    const n = readSync(fd, buf, 0, len, pos);
    return buf.subarray(0, n).toString("utf-8");
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

/** Parse the complete JSONL records in a chunk, discarding partial edge lines. */
function parseRecords(chunk: string, dropFirstPartial: boolean): Record<string, unknown>[] {
  const lines = chunk.split("\n");
  // A tail chunk almost always begins mid-record, and a head chunk almost always ends
  // mid-record. Dropping the affected edge is why a bounded read is safe at all.
  if (dropFirstPartial) lines.shift();
  else lines.pop();
  const out: Record<string, unknown>[] = [];
  for (const l of lines) {
    if (!l) continue;
    try {
      const o = JSON.parse(l);
      if (o && typeof o === "object") out.push(o);
    } catch {
      /* truncated or not a record */
    }
  }
  return out;
}

/**
 * Flatten Claude Code's string-or-blocks message content to plain text.
 *
 * Blocks join with a NEWLINE, not a space. They are separate paragraphs of one message,
 * and the reader renders them as such; every other consumer runs the result through
 * `cleanPrompt`, which collapses all whitespace, so the separator is invisible to them
 * and the length `lastMessageChars` reports is unchanged either way.
 */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      b && typeof b === "object" && typeof (b as any).text === "string" ? (b as any).text : ""
    )
    .join("\n");
}

/**
 * Strip the envelopes Claude Code wraps around slash commands and hook output, so a
 * session invoked as `/investigate` previews as its actual prompt rather than as
 * `<command-message>investigate</command-message><command-name>…`.
 */
/**
 * Envelopes the HARNESS posts as `user` records, which no human typed.
 *
 * A Claude Code transcript records more than a conversation on the `user` side. Tool
 * results are the obvious case and are already filtered by shape, but background-task
 * events arrive as ordinary `user` records carrying a `<task-notification>` payload — and
 * `cleanPrompt` strips the tags and keeps the body, so one surfaced in the transcript tail
 * as `you  b8kmietd6 Monitor event: "v7.45.0 release run and npm publish"`. Attributing a
 * callback to the person is worse than dropping a turn: the panel exists to show what was
 * last ASKED, and the reader has no way to tell the misattribution from the real thing.
 *
 * Matched on the RAW text before `cleanPrompt`, because cleaning is what destroys the
 * evidence. `[Request interrupted by user]` is a harness marker too — a real action, but
 * not prose, and it says nothing about where the session got to.
 */
const HARNESS_ENVELOPES = [
  "<task-notification>",
  "<system-reminder>",
  "<local-command-stdout>",
  "<user-prompt-submit-hook>",
] as const;

export function isHarnessNoise(raw: string): boolean {
  const t = raw.trimStart();
  if (t.startsWith("[Request interrupted by user")) return true;
  return HARNESS_ENVELOPES.some((e) => t.startsWith(e));
}

/**
 * One turn of the MAIN conversation, before any presentation-level cleaning.
 *
 * `raw` is exactly what the record carried, joined across its text blocks — no envelope
 * stripping, no whitespace collapsing. The two consumers want different cleanings (the
 * picker's preview collapses a turn to one line; the reader keeps its paragraphs), and a
 * shared helper that had already collapsed the text could not serve the second.
 */
export interface RawTurn {
  role: "user" | "assistant";
  raw: string;
}

/**
 * THE definition of "a turn of the main conversation", in one place.
 *
 * Every surface that reads a transcript needs the same five exclusions, and they are not
 * guessable from the record shape alone — which is why they live here rather than being
 * re-derived at each call site:
 *
 *   1. only `user` and `assistant` records are conversation at all (a transcript also
 *      carries `ai-title`, `mode`, `attachment`, `file-history-snapshot`, …);
 *   2. `isMeta` marks a record the harness posted, not prose;
 *   3. `isSidechain` marks SUBAGENT traffic — a different conversation that happens to
 *      share the file;
 *   4. a `user` record whose content is a `tool_result` is the harness replying to the
 *      model, not the person speaking;
 *   5. `isHarnessNoise` catches the envelopes (`<task-notification>`, `<system-reminder>`,
 *      hook output, interrupt markers) that arrive as ordinary `user` records.
 *
 * Returns `null` for anything that fails one of them, or that carries no text at all —
 * an assistant record holding only `tool_use` or `thinking` blocks has no prose in it.
 */
export function mainConversationTurn(r: Record<string, unknown>): RawTurn | null {
  if (r.type !== "user" && r.type !== "assistant") return null;
  if (r.isMeta || r.isSidechain) return null;
  const content = (r.message as { content?: unknown } | undefined)?.content;
  if (
    Array.isArray(content) &&
    content.some((b) => (b as { type?: unknown })?.type === "tool_result")
  ) {
    return null;
  }
  const raw = contentText(content);
  if (!raw.trim() || isHarnessNoise(raw)) return null;
  return { role: r.type === "user" ? "user" : "assistant", raw };
}

function cleanPrompt(text: string): string {
  return text
    .replace(/<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/g, " ")
    .replace(/<local-command-[a-z-]+>[\s\S]*?<\/local-command-[a-z-]+>/g, " ")
    .replace(/<[^>]{1,40}>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fill in a row's title, opening prompt, branch and last-message size.
 *
 * Idempotent and cheap to call from a render path: it returns immediately once
 * `hydrated` is set, and touches at most 192 KB regardless of transcript size.
 */
export function hydrateSession(row: SessionRow): SessionRow {
  if (row.hydrated) return row;
  row.hydrated = true;

  // Re-stat a LIVE session before reading its tail. `sizeBytes` was captured during the
  // list pass, and a session that is still appending — exactly the ones the picker marks
  // with a green dot, and the most likely thing a user picks — will have grown since.
  // Using the stale size aims the tail window at the middle of the file, so the "current"
  // title and last message come from an older part of it, or from nothing at all if it
  // grew by more than TAIL_BYTES.
  if (isActive(row)) {
    try {
      row.sizeBytes = statSync(row.file).size;
    } catch {
      // Deleted mid-scan; the bounded reads below cope with a stale size.
    }
  }

  const head = parseRecords(readChunk(row.file, 0, Math.min(HEAD_BYTES, row.sizeBytes)), false);
  for (const r of head) {
    if (!row.gitBranch && typeof r.gitBranch === "string") row.gitBranch = r.gitBranch;
    if (!row.firstPrompt && r.type === "user" && !r.isMeta) {
      const raw = contentText((r.message as any)?.content);
      const t = isHarnessNoise(raw) ? "" : cleanPrompt(raw);
      if (t) row.firstPrompt = t;
    }
    if (row.gitBranch && row.firstPrompt) break;
  }

  // The title is regenerated as a session evolves, so the LAST `ai-title` is the current
  // one — hence reading the tail rather than the head for it.
  const tailStart = Math.max(0, row.sizeBytes - TAIL_BYTES);
  const tail = parseRecords(
    readChunk(row.file, tailStart, row.sizeBytes - tailStart),
    tailStart > 0
  );
  for (let i = tail.length - 1; i >= 0; i--) {
    const r = tail[i]!;
    if (!row.title && r.type === "ai-title" && typeof r.aiTitle === "string" && r.aiTitle.trim()) {
      row.title = r.aiTitle.trim();
    }
    if (row.lastMessageChars === undefined && r.type === "user" && !r.isMeta) {
      const raw = contentText((r.message as any)?.content);
      const t = isHarnessNoise(raw) ? "" : cleanPrompt(raw);
      if (t) row.lastMessageChars = t.length;
    }
  }
  row.recentTurns = extractRecentTurns(tail);
  return row;
}

/**
 * How far back the deep pass will look for a human turn, and why it exists at all.
 *
 * MEASURED on a 7.8 MB transcript in this repository: the last 128 KB (`TAIL_BYTES`, what
 * `hydrateSession` reads) holds 25 assistant turns and ZERO human ones — the most recent
 * thing the person said is roughly half a megabyte back, behind a wall of tool traffic.
 * So the per-role quota below is necessary but not sufficient: it reserves the slot, and
 * the slot stays empty because the record is outside the window.
 *
 * Widening `TAIL_BYTES` is the wrong fix. It is paid by EVERY row on EVERY keystroke —
 * the list hydrates about twenty rows at a time — to serve a panel that shows one. This
 * budget is paid once, for the selected row only, and only when the cheap window came up
 * empty.
 */
const DEEP_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * A PER-ROLE quota, not a flat count, and the difference is the whole feature.
 *
 * "Last 6 turns" sounds like a conversation and is not one in an agentic transcript: the
 * assistant narrates several prose turns per human prompt, so the trailing six are very
 * often six assistant turns and the panel showed a monologue. The human's last message is
 * usually present and merely further back — it is what says what the session was ASKED
 * to do, which is most of what decides whether it is the one to resume. Reserving it a
 * slot guarantees it appears however deep it sits.
 */
const RECENT_AI_TURNS = 5;
const RECENT_USER_TURNS = 1;

/**
 * The last few real turns of a conversation, oldest → newest: the most recent human
 * message plus the last handful from the model.
 *
 * Walks the tail BACKWARDS and stops as soon as both quotas are filled, so a 73 MB
 * transcript costs the same as a small one — the records are already parsed by the caller
 * either way. Reversing at the end restores chronological order, and because the walk is
 * strictly backwards that is a true ordering, not a re-sort: the user turn lands wherever
 * it actually occurred relative to the model's, above them when it came first.
 *
 * What counts as a turn is the rest of the difficulty. A Claude Code transcript is mostly
 * NOT conversation: tool results are posted as `user` records, tool calls and thinking are
 * blocks inside `assistant` records, and slash commands arrive wrapped in
 * `<command-name>` envelopes. Rendering those verbatim would fill the panel with
 * `[{"type":"tool_result"…}]` and teach the reader nothing. So a turn must carry actual
 * prose: tool-result records are skipped outright, non-text blocks are dropped, and what
 * survives is collapsed to one line.
 */
function extractRecentTurns(
  records: Record<string, unknown>[]
): Array<{ role: "user" | "assistant"; text: string }> {
  const out: Array<{ role: "user" | "assistant"; text: string }> = [];
  let ai = 0;
  let user = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    if (ai >= RECENT_AI_TURNS && user >= RECENT_USER_TURNS) break;
    const r = records[i]!;
    if (r.type !== "user" && r.type !== "assistant") continue;
    const role = r.type === "user" ? "user" : "assistant";
    // Quota check BEFORE the content work: once a role is satisfied the remaining
    // records of that role cost nothing but the type test.
    if (role === "assistant" ? ai >= RECENT_AI_TURNS : user >= RECENT_USER_TURNS) continue;
    const turn = mainConversationTurn(r);
    if (!turn) continue;
    const text = cleanPrompt(turn.raw);
    if (!text) continue;
    out.push({ role, text });
    if (role === "assistant") ai++;
    else user++;
  }
  return out.reverse();
}

/**
 * Second pass for the DETAILS panel: go and find the human turn the cheap window missed.
 *
 * Runs at most once per row (`conversationDeepened`) and returns immediately when the
 * turns already include a `user` — so on a short session, or any session where the person
 * spoke recently, it costs one array scan and no I/O at all.
 *
 * IT DOES NOT RE-PARSE THE WINDOW. Handing 4 MB of JSONL to `parseRecords` would mean
 * `JSON.parse` on every assistant record and every tool result in it, to keep one line.
 * Instead the lines are filtered by SUBSTRING first — a `user` record always carries
 * `"type":"user"` — and only the survivors are parsed, walking backwards so the first hit
 * is the newest and the loop stops there.
 *
 * The turn is PREPENDED. It is necessarily older than everything `hydrateSession` found,
 * because that pass looked at the newest bytes and found no human turn in them, so
 * chronological order puts it first. What separates it from the model turns below it is
 * tool traffic, not silence — the panel shows the last thing asked and the last things
 * said, which is what it is for, not a contiguous slice of the transcript.
 */
export function hydrateConversation(row: SessionRow): SessionRow {
  if (row.conversationDeepened) return row;
  row.conversationDeepened = true;
  const turns = row.recentTurns;
  if (!turns || turns.some((t) => t.role === "user")) return row;

  const start = Math.max(0, row.sizeBytes - DEEP_TAIL_BYTES);
  const chunk = readChunk(row.file, start, row.sizeBytes - start);
  if (!chunk) return row;
  const lines = chunk.split("\n");
  // A window that starts mid-file starts mid-line; that fragment is not a record.
  if (start > 0) lines.shift();

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"type":"user"')) continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const turn = mainConversationTurn(r);
    if (!turn || turn.role !== "user") continue;
    const text = cleanPrompt(turn.raw);
    if (!text) continue;
    turns.unshift({ role: "user", text });
    if (row.lastMessageChars === undefined) row.lastMessageChars = text.length;
    return row;
  }
  return row;
}

/** The best label available for a row: its title, else its opening prompt, else its id. */
export function sessionLabel(row: SessionRow): string {
  return row.title || row.firstPrompt || row.id;
}

/**
 * The newest transcript for `cwd` — the session that just ended.
 *
 * This is how the end-of-session summary learns the id to print in its resume command
 * without claudish having to parse the child's stdout. Newest-by-mtime is exact here
 * because the summary runs moments after the child exited, so the session it just ran
 * is necessarily the most recently written transcript for that directory.
 */
export function findLatestSessionId(cwd: string = process.cwd(), sinceMs = 0): string | null {
  // `sinceMs` bounds the guess to transcripts touched during THIS session.
  //
  // Newest-by-mtime is only "necessarily" the session that just ran when one session
  // owns the directory. A second terminal in the same cwd, a `team` run or an MCP
  // channel child all write here too and any of them can be the most recently touched
  // at the moment claudish exits — which would print a resume command naming someone
  // else's conversation, as a line the user is invited to paste. Filtering by the
  // proxy's start time cannot make the guess right, but it does make it fail closed:
  // when nothing in this directory was written during the session, the answer is null
  // and the card prints no resume line at all.
  const touched = sessionsIn(slugForPath(cwd)).filter((r) => r.mtimeMs >= sinceMs);
  if (touched.length === 0) return null;

  // Prefer a transcript that was CREATED during this run, before falling back to the
  // newest one merely touched during it.
  //
  // Newest-by-mtime alone loses to any conversation that is still being written in the
  // same directory, and the loudest such writer is a Claude Code session that launched
  // claudish in the first place: it appends on every turn, so it is always the freshest
  // file at the moment claudish exits. MEASURED — a run inside this worktree printed
  // `--resume 35188908-…`, the id of the OUTER session, while the child printed
  // `49ca22f8-…` for itself. The child's transcript is the one born during the window;
  // the outer session's predates it. A resumed session keeps its original file and so
  // would be missed here, but that path never reaches this function: `resumedSessionId`
  // is already known and takes precedence at the call site.
  const born = touched.filter((r) => r.birthtimeMs !== undefined && r.birthtimeMs >= sinceMs);
  const pool = born.length > 0 ? born : touched;
  return pool.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a)).id;
}
