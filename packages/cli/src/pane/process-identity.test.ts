import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type PaneIdentity,
  type PsRow,
  WATCHER_FUNCTIONS,
  WATCHER_SCRIPT,
  formatGroupFile,
  groupCheck,
  isLaunchDirPath,
  isPaneMagmuxCommand,
  isPaneWatcherCommand,
  mergeSnapshots,
  paneIdentityMatches,
  parseGroupFile,
  parsePsTable,
  sameSnapshot,
  verifiedGroupSnapshot,
} from "./process-identity.js";
import { FIXTURES } from "./test-helpers/fixtures.js";

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
    expect(mergeSnapshots(snap, { pgid: 7, members: [] })).toBe(snap);
    expect(mergeSnapshots(snap, null)).toBe(snap);
  });

  test("merge prunes members that died: a long session's group record stays bounded", () => {
    let rec = verifiedGroupSnapshot(table, fx.panePid, pane);
    // 500 ticks, each sampling a different short-lived process in the pane group
    for (let i = 0; i < 500; i++) {
      const brief: PsRow = { ...leader, pid: 90_000 + i, ppid: leader.pid, command: "ls -la" };
      rec = mergeSnapshots(rec, verifiedGroupSnapshot([...table, brief], fx.panePid, pane));
    }
    const live = verifiedGroupSnapshot(table, fx.panePid, pane);
    rec = mergeSnapshots(rec, live);
    expect(rec?.members.length).toBe(live?.members.length);
    expect(sameSnapshot(rec, live)).toBe(true);
    expect(groupCheck(table, rec)).toBe(true);
  });
});

/** Run the watcher's shell functions against the same real table through a fake `ps`. */
function shell(script: string, opts: { ctl?: string; root?: string } = {}): string {
  const bin = join(scratch, "bin");
  mkdirSync(bin, { recursive: true });
  // the watcher's own ps format: pid=,pgid=,lstart=,command= (the TS table minus ppid)
  const shellTable = table.map((r) => `${r.pid} ${r.pgid} ${r.lstart} ${r.command}`).join("\n");
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
