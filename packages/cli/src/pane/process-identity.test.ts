import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type GroupSnapshot,
  type PaneIdentity,
  type PsRow,
  WATCHER_FUNCTIONS,
  WATCHER_SCRIPT,
  etimeSeconds,
  formatGroupFile,
  groupCheck,
  isLaunchDirPath,
  isPaneMagmuxCommand,
  isPaneWatcherCommand,
  liveEscaped,
  mergeSnapshots,
  paneIdentityMatches,
  parseGroupFile,
  parsePsTable,
  readProcessTable,
  readProcessTableAsync,
  sameSnapshot,
  setPsSpawnForTest,
  startedAt,
  verifiedGroupSnapshot,
} from "./process-identity.js";
import { FIXTURES } from "./test-helpers/fixtures.js";
import { SANDBOX_REFUSED_PS, withProcessTableUnavailable } from "./test-helpers/hermetic-env.js";

// A REAL `ps -ax -ww -o pid=,ppid=,pgid=,lstart=,command=` of one live pane (watcher, magmux,
// pane leader), captured by impl3/capture-ps.ts; home paths redacted to /opt/u.
const fx = JSON.parse(readFileSync(join(FIXTURES, "ps", "live-pane.json"), "utf8")) as {
  paneId: string;
  sessionUuid: string;
  sockRoot: string;
  panePid: number;
  ps: string;
};
const table = parsePsTable(fx.ps);
const magRow = table.find((r) => r.command.includes("magmux --headless")) as PsRow;
const leader = table.find((r) => r.pid === fx.panePid) as PsRow;
const watcherRow = table.find((r) => r.command.startsWith("/bin/sh -c")) as PsRow;
const ctlDir = (
  magRow.command.match(/'([^']+)\/pane-launch\.sh'/) as RegExpMatchArray
)[1] as string;
const pane: PaneIdentity = { paneId: fx.paneId, sessionUuid: fx.sessionUuid, ctlDir };

const scratch = mkdtempSync("/tmp/pid-test-");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("parsePsTable on a real table", () => {
  test("three rows: watcher, magmux (own group), the pane leader (own group)", () => {
    expect(table).toHaveLength(3);
    expect(magRow.pgid).toBe(magRow.pid);
    expect(leader.pgid).toBe(leader.pid);
    expect(leader.ppid).toBe(magRow.pid);
    expect(leader.lstart).toMatch(/^\w{3} \w{3} \d+ \d\d:\d\d:\d\d \d{4}$/);
  });

  test("the watcher is recognised by argv0 + pane id (the sweep's 'watcher alive' check)", () => {
    expect(isPaneWatcherCommand(watcherRow.command, fx.paneId)).toBe(true);
    expect(isPaneWatcherCommand(watcherRow.command, "c1-other-t01-000000")).toBe(false);
  });
});

describe("TS predicates", () => {
  test("magmux is identified by `--id <paneId> --sock-dir`, never by pid", () => {
    expect(isPaneMagmuxCommand(magRow.command, fx.paneId)).toBe(true);
    expect(isPaneMagmuxCommand(magRow.command, "c1-other-t01-000000")).toBe(false);
    expect(isPaneMagmuxCommand(leader.command, fx.paneId)).toBe(false);
    expect(isPaneMagmuxCommand(watcherRow.command, fx.paneId)).toBe(false);
  });

  test("a pane member carries --session-id <uuid> or <ctlDir>/pane-launch.sh", () => {
    expect(paneIdentityMatches(leader.command, pane)).toBe(true);
    expect(
      paneIdentityMatches(leader.command, { ...pane, sessionUuid: "x", ctlDir: "/nope" })
    ).toBe(false);
    const preExec = `/bin/sh -c . '${ctlDir}/pane-launch.sh'`;
    expect(paneIdentityMatches(preExec, { ...pane, sessionUuid: "x" })).toBe(true);
  });

  test("the verified snapshot is the pgid's members, only while one still carries the identity", () => {
    const snap = verifiedGroupSnapshot(table, fx.panePid, pane);
    expect(snap).toEqual({
      pgid: fx.panePid,
      members: [{ pid: leader.pid, lstart: leader.lstart }],
    });
    expect(
      verifiedGroupSnapshot(table, fx.panePid, { ...pane, sessionUuid: "x", ctlDir: "/n" })
    ).toBeNull();
    expect(verifiedGroupSnapshot(table, 1, pane)).toBeNull();
  });

  test("group check: passes on a recorded (pid, start); fails on the same pid with another start", () => {
    const snap = verifiedGroupSnapshot(table, fx.panePid, pane);
    expect(groupCheck(table, snap)).toBe(true);
    const reused = table.map((r) =>
      r.pid === leader.pid ? { ...r, lstart: "Thu Jan 1 00:00:00 2099" } : r
    );
    expect(groupCheck(reused, snap)).toBe(false);
    expect(
      groupCheck(
        table.filter((r) => r.pid !== leader.pid),
        snap
      )
    ).toBe(false);
    expect(groupCheck(table, null)).toBe(false);
  });

  test("an unidentifiable survivor still passes when it was recorded (the orphan_grandchild case)", () => {
    const grandchild: PsRow = {
      pid: 999_001,
      ppid: 1,
      pgid: fx.panePid,
      lstart: leader.lstart,
      command: "sleep 300",
    };
    const withChild = [...table, grandchild];
    const snap = verifiedGroupSnapshot(withChild, fx.panePid, pane);
    const leaderGone = withChild.filter((r) => r.pid !== leader.pid);
    expect(verifiedGroupSnapshot(leaderGone, fx.panePid, pane)).toBeNull();
    expect(groupCheck(leaderGone, snap)).toBe(true);
  });

  test("group file round trip and snapshot merge", () => {
    const snap = verifiedGroupSnapshot(table, fx.panePid, pane);
    expect(parseGroupFile(formatGroupFile(snap!))).toEqual(snap);
    expect(mergeSnapshots(snap, { pgid: 7, members: [] }, table)).toBe(snap);
    expect(mergeSnapshots(snap, null, table)).toBe(snap);
  });

  test("merge prunes members that died: a long session's group record stays bounded", () => {
    let rec = verifiedGroupSnapshot(table, fx.panePid, pane);
    // 500 ticks, each sampling a different short-lived process in the pane group
    for (let i = 0; i < 500; i++) {
      const brief: PsRow = { ...leader, pid: 90_000 + i, ppid: leader.pid, command: "ls -la" };
      const withBrief = [...table, brief];
      rec = mergeSnapshots(rec, verifiedGroupSnapshot(withBrief, fx.panePid, pane), withBrief);
    }
    const live = verifiedGroupSnapshot(table, fx.panePid, pane);
    rec = mergeSnapshots(rec, live, table);
    expect(rec?.members.length).toBe(live?.members.length);
    expect(sameSnapshot(rec, live)).toBe(true);
    expect(groupCheck(table, rec)).toBe(true);
  });

  test("merge keeps a recorded escaped shell whose parent died while a verified member lives", () => {
    // claude (in the pane group) starts a run_in_background shell in its own group (measured on
    // 2.1.291), then dies without its own cleanup: the shell is reparented to pid 1 while the
    // claudish wrapper, which carries --session-id, is still a verified member.
    const claude: PsRow = { ...leader, pid: leader.pid + 11, ppid: leader.pid, command: "claude" };
    const bg: PsRow = {
      pid: leader.pid + 7002,
      ppid: claude.pid,
      pgid: leader.pid + 7002,
      lstart: leader.lstart,
      command: "/bin/zsh -c eval 'npm run dev'",
    };
    const before = [...table, claude, bg];
    const rec = verifiedGroupSnapshot(before, fx.panePid, pane) as GroupSnapshot;
    expect(rec.escaped).toEqual([{ pid: bg.pid, lstart: bg.lstart }]);

    const devServer: PsRow = { ...bg, pid: bg.pid + 1, ppid: bg.pid, command: "node server.js" };
    const after = [...table, { ...bg, ppid: 1 }, devServer];
    const fresh = verifiedGroupSnapshot(after, fx.panePid, pane) as GroupSnapshot;
    expect(fresh.escaped).toBeUndefined(); // the chain now ends at pid 1
    const merged = mergeSnapshots(rec, fresh, after) as GroupSnapshot;
    expect(merged.members).toEqual(fresh.members);
    expect(liveEscaped(after, merged).sort()).toEqual([bg.pid, devServer.pid].sort());

    // a recorded pair that died, or whose pid now has another start time, drops out
    const reused = after.map((r) =>
      r.pid === bg.pid ? { ...r, lstart: "Thu Jan 1 00:00:00 2099" } : r
    );
    expect(mergeSnapshots(rec, fresh, reused)?.escaped).toBeUndefined();
    expect(mergeSnapshots(rec, fresh, table)?.escaped).toBeUndefined();
  });
});

/** Run the watcher's shell functions against the same real table through a fake `ps`. */
function shell(script: string, opts: { ctl?: string; root?: string; rows?: PsRow[] } = {}): string {
  const bin = join(scratch, "bin");
  mkdirSync(bin, { recursive: true });
  // the watcher's own ps format: pid=,pgid=,lstart=,command= (the TS table minus ppid)
  const shellTable = (opts.rows ?? table)
    .map((r) => `${r.pid} ${r.pgid} ${r.lstart} ${r.command}`)
    .join("\n");
  writeFileSync(join(scratch, "table.txt"), `${shellTable}\n`);
  // honours `-p <pid>` with `-o command=` (mag_ok) and prints the whole table otherwise
  writeFileSync(
    join(bin, "ps"),
    `#!/bin/sh\npid=""\nwhile [ $# -gt 0 ]; do [ "$1" = -p ] && pid=$2; shift; done\nif [ -n "$pid" ]; then awk -v p="$pid" '$1 == p { $1 = ""; $2 = ""; $3 = ""; $4 = ""; $5 = ""; $6 = ""; $7 = ""; sub(/^ +/, ""); print }' ${join(scratch, "table.txt")}; else cat ${join(scratch, "table.txt")}; fi\n`,
    { mode: 0o755 }
  );
  const r = spawnSync(
    "/bin/sh",
    [
      "-c",
      `${WATCHER_FUNCTIONS}\n${script}`,
      "claudish-pane-watcher",
      fx.paneId,
      fx.sessionUuid,
      opts.ctl ?? ctlDir,
      "s",
      "r",
      "t",
      opts.root ?? fx.sockRoot,
    ],
    { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` } }
  );
  return (r.stdout ?? "").trim();
}

describe("the generated watcher shell agrees with the TS predicates on the same table", () => {
  test("the script parses under bash's sh and under dash", () => {
    expect(spawnSync("/bin/sh", ["-n", "-c", WATCHER_SCRIPT]).status).toBe(0);
    const dash = spawnSync("dash", ["-n", "-c", WATCHER_SCRIPT]);
    if (!dash.error) expect(dash.status).toBe(0);
  });

  test("escaped_live ≡ liveEscaped: an own-group descendant, listed only while its (pid, start) matches", () => {
    // Claude Code 2.1.291 runs a run_in_background Bash as its own group leader (measured)
    const bg: PsRow = {
      pid: leader.pid + 7001,
      ppid: leader.pid,
      pgid: leader.pid + 7001,
      lstart: leader.lstart,
      command: "/bin/zsh -c eval 'sleep 317'",
    };
    const withBg = [...table, bg];
    const snap = verifiedGroupSnapshot(withBg, fx.panePid, pane) as GroupSnapshot;
    expect(snap.escaped).toEqual([{ pid: bg.pid, lstart: bg.lstart }]);
    expect(parseGroupFile(formatGroupFile(snap))).toEqual(snap);
    expect(groupCheck(withBg, snap)).toBe(true);
    expect(liveEscaped(withBg, snap)).toEqual([bg.pid]);
    const reused = withBg.map((r) =>
      r.pid === bg.pid ? { ...r, lstart: "Thu Jan 1 00:00:00 2099" } : r
    );
    expect(liveEscaped(reused, snap)).toEqual([]);
    const ctl = join(scratch, "launch-EsC123");
    mkdirSync(ctl, { recursive: true });
    writeFileSync(join(ctl, "group"), formatGroupFile(snap));
    expect(shell("escaped_live", { ctl, rows: withBg })).toBe(String(bg.pid));
    expect(shell("escaped_live", { ctl, rows: reused })).toBe("");
    // a member line never matches an escaped row: group_ok still needs the recorded pgid
    expect(shell(`pg=${bg.pgid}; member_in_pg && echo Y || echo N`, { ctl, rows: withBg })).toBe(
      "N"
    );
  });

  test("mag_ok / find_mag", () => {
    expect(shell(`mag=${magRow.pid}; mag_ok && echo Y || echo N`)).toBe("Y");
    expect(shell(`mag=${leader.pid}; mag_ok && echo Y || echo N`)).toBe("N");
    expect(shell(`find_mag && echo "$mag"`)).toBe(String(magRow.pid));
  });

  test("group_ok by identity, by recorded member, and refused for a reused pid", () => {
    expect(shell(`pg=${fx.panePid}; group_ok && echo Y || echo N`)).toBe("Y");
    const ctl = join(scratch, "launch-AbC123");
    mkdirSync(ctl, { recursive: true });
    const snap = verifiedGroupSnapshot(table, fx.panePid, pane)!;
    writeFileSync(join(ctl, "group"), formatGroupFile(snap));
    // ctl differs from the leader's argv and the uuid is wrong → only the recorded member can pass
    const r1 = spawnSync(
      "/bin/sh",
      [
        "-c",
        `${WATCHER_FUNCTIONS}\npg=${fx.panePid}; group_ok && echo Y || echo N`,
        "w",
        fx.paneId,
        "wrong-uuid",
        ctl,
        "s",
        "r",
        "t",
        scratch,
      ],
      {
        encoding: "utf8",
        env: { PATH: `${join(scratch, "bin")}:/usr/bin:/bin` },
      }
    );
    expect(r1.stdout.trim()).toBe(groupCheck(table, snap) ? "Y" : "N");
    writeFileSync(
      join(ctl, "group"),
      formatGroupFile({
        pgid: fx.panePid,
        members: [{ pid: leader.pid, lstart: "Thu Jan 1 00:00:00 2099" }],
      })
    );
    const r2 = spawnSync(
      "/bin/sh",
      [
        "-c",
        `${WATCHER_FUNCTIONS}\npg=${fx.panePid}; group_ok && echo Y || echo N`,
        "w",
        fx.paneId,
        "wrong-uuid",
        ctl,
        "s",
        "r",
        "t",
        scratch,
      ],
      {
        encoding: "utf8",
        env: { PATH: `${join(scratch, "bin")}:/usr/bin:/bin` },
      }
    );
    expect(r2.stdout.trim()).toBe("N");
  });

  test("launch_dir_ok ≡ isLaunchDirPath (R3-M2): direct child, launch-XXXXXX, real dir", () => {
    const root = mkdtempSync(join(scratch, "root-"));
    const good = join(root, "launch-AbC123");
    mkdirSync(good);
    const nested = join(root, "x", "launch-AbC123");
    mkdirSync(nested, { recursive: true });
    const badName = join(root, "launch-AbC12");
    mkdirSync(badName);
    const link = join(root, "launch-LnK123");
    symlinkSync(good, link);
    for (const p of [good, nested, badName, link, join(root, "launch-NoNe12"), "/etc"]) {
      const sh = shell(`launch_dir_ok "${p}" && echo Y || echo N`, { root });
      expect(sh).toBe(isLaunchDirPath(root, p) ? "Y" : "N");
    }
    expect(isLaunchDirPath(root, good)).toBe(true);
  });
});

describe("start times from etime (timezone-free)", () => {
  test("etime forms: mm:ss, hh:mm:ss, dd-hh:mm:ss", () => {
    expect(etimeSeconds("05:07")).toBe(307);
    expect(etimeSeconds("1:02:03")).toBe(3723);
    expect(etimeSeconds("01-02:32:10")).toBe(95_530);
  });

  test("a row with etime gets startMs = spawn time - etime; a row without it parses as before", () => {
    const at = Date.UTC(2026, 9, 20, 12, 0, 0);
    const [row] = parsePsTable(
      "  796     1   796 01-02:30:47 Mon Oct 19 20:34:11 2026     /System/Finder\n",
      at
    );
    expect(row).toMatchObject({ pid: 796, pgid: 796, lstart: "Mon Oct 19 20:34:11 2026" });
    expect(row?.command).toBe("/System/Finder");
    expect(row?.startMs).toBe(at - 95_447_000);
    expect(startedAt(row as PsRow, at - 95_447_000 + 1500)).toBe(true);
    expect(startedAt(row as PsRow, at - 95_447_000 + 2500)).toBe(false);
    expect(parsePsTable(fx.ps).every((r) => r.startMs === undefined)).toBe(true);
  });

  test("a real read carries this process's start within the tolerance", () => {
    const self = readProcessTable()?.find((r) => r.pid === process.pid) as PsRow;
    const started = Date.now() - process.uptime() * 1000;
    expect(Math.abs((self.startMs as number) - started)).toBeLessThan(2000);
  });
});

describe("the process table when ps cannot run (macOS refuses the setuid ps in any sandbox)", () => {
  test("a real read lists the reader itself, synchronously and asynchronously", async () => {
    expect(readProcessTable()?.some((r) => r.pid === process.pid)).toBe(true);
    expect((await readProcessTableAsync())?.some((r) => r.pid === process.pid)).toBe(true);
  });

  test("readProcessTableAsync resolves null, never rejects, when execFile throws synchronously", async () => {
    // Bun throws EPERM from execFile itself; a rejection here is unhandled in setPanePid
    // and exits the MCP server with status 1
    await withProcessTableUnavailable(async () => {
      await expect(readProcessTableAsync()).resolves.toBeNull();
      expect(readProcessTable()).toBeNull();
    });
  });

  test("a failure passed to the callback, and output with no row, read as unavailable too", async () => {
    const prev = setPsSpawnForTest({
      ...SANDBOX_REFUSED_PS,
      execFile: (_f, _a, _o, cb) => cb(Object.assign(new Error("ps: exit 1"), { code: 1 }), ""),
    });
    try {
      expect(await readProcessTableAsync()).toBeNull();
    } finally {
      setPsSpawnForTest(prev);
    }
    const real = setPsSpawnForTest({
      execFileSync: () => "\n",
      execFile: (_f, _a, _o, cb) => cb(null, ""),
    });
    try {
      expect(readProcessTable()).toBeNull();
      expect(await readProcessTableAsync()).toBeNull();
    } finally {
      setPsSpawnForTest(real);
    }
  });

  test.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))(
    "inside a real macOS sandbox: both reads are unavailable and the process exits 0",
    () => {
      // `void …then(…)` is the shape of the real call site (pane-session setPanePid): a
      // rejection there is unhandled and exits the process with code 1.
      const modulePath = join(import.meta.dir, "process-identity.ts");
      const script =
        `import { readProcessTable, readProcessTableAsync } from ${JSON.stringify(modulePath)};\n` +
        `const sync = readProcessTable();\n` +
        `void readProcessTableAsync().then((t) => { console.log(String(sync) + " " + String(t)); process.exit(0); });\n` +
        "setInterval(() => {}, 1000);\n" +
        `setTimeout(() => { console.log("timeout"); process.exit(3); }, 10000);\n`;
      const res = spawnSync(
        "/usr/bin/sandbox-exec",
        ["-p", "(version 1)(allow default)", process.execPath, "--no-env-file", "-e", script],
        { encoding: "utf8", timeout: 20_000 }
      );
      expect({ status: res.status, stdout: res.stdout.trim() }).toEqual({
        status: 0,
        stdout: "null null",
      });
    },
    30_000
  );
});

/** The whole watcher script, its owner already gone (stdin at EOF), against a stand-in `ps`. */
function watcherAfterOwnerDeath(psBody: string): {
  status: number | null;
  left: Record<string, boolean>;
} {
  const root = mkdtempSync(join(scratch, "wroot-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ps"), `#!/bin/sh\n${psBody}\n`, { mode: 0o755 });
  const paneId = "c1-zz-twatch-abcdef";
  const ctl = join(root, "launch-CtL123");
  const turn = join(root, "launch-TuRn12");
  const sock = join(root, `magmux-${paneId}.sock`);
  const rec = join(root, "panes", `${paneId}.json`);
  mkdirSync(ctl);
  mkdirSync(turn);
  mkdirSync(join(root, "panes"));
  writeFileSync(sock, "");
  writeFileSync(rec, "{}");
  const r = spawnSync(
    "/bin/sh",
    ["-c", WATCHER_SCRIPT, "claudish-pane-watcher", paneId, "uuid", ctl, sock, rec, turn, root],
    { encoding: "utf8", input: "", env: { PATH: `${bin}:/usr/bin:/bin` } }
  );
  const left = Object.fromEntries(
    Object.entries({ ctl, turn, sock, rec }).map(([k, p]) => [k, existsSync(p)])
  );
  return { status: r.status, left };
}

describe("the watcher when its owner dies and ps cannot run", () => {
  test("nothing verifiable: exit 1, the socket, record and dirs are kept for a later sweep", () => {
    // what /bin/sh reports when the sandbox refuses the exec
    const r = watcherAfterOwnerDeath('echo "ps: Operation not permitted" >&2; exit 126');
    expect(r.status).toBe(1);
    expect(r.left).toEqual({ ctl: true, turn: true, sock: true, rec: true });
  });

  test("control: a readable table with no pane process left → files removed, exit 0", () => {
    const r = watcherAfterOwnerDeath(`echo "    1     1 ${leader.lstart} /sbin/launchd"`);
    expect(r.status).toBe(0);
    expect(r.left).toEqual({ ctl: false, turn: false, sock: false, rec: false });
  });
});
