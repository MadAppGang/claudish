/**
 * Process-wide pane safety against REAL magmux (architecture §2.11, §12.3): the parallel
 * shutdown reap, the watcher's clean exit, the owner-SIGKILL gate with two panes (and the
 * fd-hygiene measurement behind it), decoys that must never be signalled, the startup
 * sweep, the cross-owner pane limit, and the R3-M1 spawn-failure reap.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitForExit } from "../process-tree.js";
import { assertMagmuxAvailable, ensureSockRoot, spawnPaneWatcher } from "./pane-launch.js";
import {
  MAX_LIVE_PANES,
  PaneLimitError,
  type PaneRecord,
  livePaneCount,
  ownerStartOfSelf,
  readRecord,
  reapAllPanes,
  releasePaneReservations,
  reservePanes,
  reservedPaneCount,
  sweepOrphanPanes,
  writeRecord,
} from "./pane-registry.js";
import { startPaneSession } from "./pane-session.js";
import { formatGroupFile, isPaneWatcherCommand, readProcessTable } from "./process-identity.js";
import {
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  type PaneTestEnv,
  killLeftovers,
  makePaneTestEnv,
  orphanReport,
  waitNoOrphans,
} from "./test-helpers/hermetic-env.js";

const OWNER = join(import.meta.dir, "test-helpers", "pane-owner.ts");
const envs: PaneTestEnv[] = [];
const extraProcs: ChildProcess[] = [];

afterAll(async () => {
  for (const p of extraProcs) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
  for (const t of envs) {
    killLeftovers({ sockRoot: t.sockRoot });
    t.cleanup();
  }
});

function env(): PaneTestEnv {
  const t = makePaneTestEnv();
  envs.push(t);
  return t;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function deadPid(): number {
  const p = Bun.spawnSync(["/usr/bin/true"]);
  return p.pid;
}

async function hangSession(t: PaneTestEnv, label = "01") {
  const uuid = crypto.randomUUID();
  const s = await startPaneSession({
    kind: "t",
    label,
    callerFlags: [],
    spawnModel: "contract-fake-model",
    cwd: t.cwd,
    sessionUuid: uuid,
    transcriptPath: t.transcriptPathFor(uuid),
    slotEnv: {},
    shape: "one-shot",
    initialPrompt: "@@HANG@@",
    readAvailable: true,
    parentEnv: t.env,
    sockRoot: t.sockRoot,
    decide: () => ({ state: "COMPLETED" }),
    onBlocked: () => "wait",
    timings: { replStableMs: 200 },
  });
  await s.ready;
  return { s, uuid };
}

interface OwnerInfo {
  owner: number;
  panes: Array<{ paneId: string; uuid: string; state: string; panePid: number }>;
  records: PaneRecord[];
}

async function startOwner(
  t: PaneTestEnv,
  n: number
): Promise<{ proc: ChildProcess; info: OwnerInfo }> {
  const proc = spawn(process.execPath, [OWNER], {
    env: {
      ...t.env,
      PANE_OWNER_SPEC: JSON.stringify({
        n,
        sockRoot: t.sockRoot,
        cwd: t.cwd,
        configDir: t.configDir,
        env: t.env,
      }),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  extraProcs.push(proc);
  const line = await new Promise<string>((resolve, reject) => {
    let buf = "";
    proc.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) resolve(buf.slice(0, nl));
    });
    proc.on("exit", (c) => reject(new Error(`owner exited ${c} before reporting`)));
  });
  return { proc, info: JSON.parse(line) as OwnerInfo };
}

/** lsof's unix-socket table for `pids`: pid → [{fd, addr, peer}]. */
function unixFds(pids: number[]): Map<number, Array<{ fd: string; addr: string; peer: string }>> {
  const out = new Map<number, Array<{ fd: string; addr: string; peer: string }>>();
  let text = "";
  try {
    text = execFileSync("lsof", ["-a", "-U", "-p", pids.join(",")], { encoding: "utf8" });
  } catch (e) {
    text = String((e as { stdout?: string }).stdout ?? "");
  }
  for (const l of text.split("\n").slice(1)) {
    const m = l.match(
      /^\S+\s+(\d+)\s+\S+\s+(\S+)\s+unix\s+(0x[0-9a-f]+)\s+\S+\s+(?:->(0x[0-9a-f]+))?/
    );
    if (!m) continue;
    const pid = Number(m[1]);
    const arr = out.get(pid) ?? [];
    arr.push({ fd: m[2] as string, addr: m[3] as string, peer: m[4] ?? "" });
    out.set(pid, arr);
  }
  return out;
}

describe.skipIf(!MAGMUX)(`pane registry, real magmux (${MAGMUX ? "" : NO_MAGMUX_MESSAGE})`, () => {
  test("reapAllPanes reaps five live panes in parallel within ≈ 3 s; nothing is left", async () => {
    const t = env();
    const sessions = await Promise.all(["1", "2", "3", "4", "5"].map((l) => hangSession(t, l)));
    const pgids = sessions.map(({ s }) => s.snapshot().panePid ?? 0);
    const t0 = Date.now();
    await reapAllPanes("shutdown");
    const took = Date.now() - t0;
    expect(took).toBeLessThan(4500);
    for (const { s } of sessions) expect(s.snapshot().state).toBe("CANCELLED");
    const left = await waitNoOrphans({
      sockRoot: t.sockRoot,
      ids: sessions.map((x) => x.uuid),
      pgids,
    });
    expect(left).toEqual({ processes: [], files: [] });
  }, 30_000);

  test("a clean reap ends the watcher: no claudish-pane-watcher <paneId> after reaped()", async () => {
    const t = env();
    const { s } = await hangSession(t);
    const rec = readRecord(t.sockRoot, s.paneId) as PaneRecord;
    expect(rec.watcherPid).toBeGreaterThan(0);
    expect(alive(rec.watcherPid as number)).toBe(true);
    s.cancel();
    await s.reaped();
    expect(readProcessTable().some((r) => isPaneWatcherCommand(r.command, s.paneId))).toBe(false);
    expect(existsSync(s.sockPath)).toBe(false);
    expect(readRecord(t.sockRoot, s.paneId)).toBeNull();
  }, 30_000);

  test("GATE: owner SIGKILL with two panes → both watchers remove group, magmux, socket, dirs, record (≤ 5 s); no watcher pipe leaked", async () => {
    const t = env();
    const { proc, info } = await startOwner(t, 2);
    expect(info.panes).toHaveLength(2);
    const watchers = info.records.map((r) => r.watcherPid as number);
    const mags = info.records.map((r) => r.magmuxPid as number);
    // fd hygiene: the owner holds each watcher's write end; neither magmux nor the sibling watcher may.
    const fds = unixFds([info.owner, ...watchers, ...mags]);
    const ownerEnds = new Map<number, string>(); // watcher pid → owner-side address of its stdin pair
    for (const w of watchers) {
      const w0 = fds.get(w)?.find((f) => f.fd.startsWith("0"));
      expect(w0).toBeDefined();
      ownerEnds.set(w, w0?.peer as string);
      expect((fds.get(info.owner) ?? []).some((f) => f.addr === w0?.peer)).toBe(true);
    }
    for (const [w, end] of ownerEnds)
      for (const other of [...watchers.filter((x) => x !== w), ...mags])
        expect((fds.get(other) ?? []).some((f) => f.addr === end || f.peer === end)).toBe(false);
    writeFileSync(join(t.tmp, "gate-lsof.json"), JSON.stringify({ info, fds: [...fds] }, null, 1));

    const t0 = Date.now();
    proc.kill("SIGKILL");
    await waitForExit(proc, 2000);
    const left = await waitNoOrphans(
      {
        sockRoot: t.sockRoot,
        ids: info.panes.map((p) => p.uuid),
        pgids: info.panes.map((p) => p.panePid),
      },
      8000
    );
    const took = Date.now() - t0;
    expect(left).toEqual({ processes: [], files: [] });
    expect(took).toBeLessThan(5500);
    for (const w of watchers) expect(alive(w)).toBe(false);
    // evidence for the implementation log
    process.stderr.write(
      `[gate] owner SIGKILL → clean in ${took} ms; lsof: ${JSON.stringify([...fds])}\n`
    );
  }, 40_000);

  test("decoy: the watcher never signals a pid that fails its identity check", async () => {
    const t = env();
    ensureSockRoot(t.sockRoot);
    const decoy = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    extraProcs.push(decoy);
    const ctl = join(t.sockRoot, "launch-DeCoY1");
    const turn = join(t.sockRoot, "launch-DeCoY2");
    mkdirSync(ctl, { mode: 0o700 });
    mkdirSync(turn, { mode: 0o700 });
    writeFileSync(join(ctl, "magmux.pid"), `${decoy.pid}\n`);
    // the decoy's pid, but another start time: a reused pid
    writeFileSync(
      join(ctl, "group"),
      formatGroupFile({
        pgid: decoy.pid as number,
        members: [{ pid: decoy.pid as number, lstart: "Thu Jan 1 00:00:00 2099" }],
      })
    );
    const paneId = `c${deadPid()}-zz-tdecoy-abcdef`;
    const w = spawnPaneWatcher({
      paneId,
      sessionUuid: crypto.randomUUID(),
      ctlDir: ctl,
      sockPath: join(t.sockRoot, `magmux-${paneId}.sock`),
      recordPath: join(t.sockRoot, "panes", `${paneId}.json`),
      turnDir: turn,
      sockRoot: t.sockRoot,
    });
    w.stdin?.end(); // EOF without "done": the owner is gone
    expect(await waitForExit(w, 8000)).toBe(true);
    expect(alive(decoy.pid as number)).toBe(true);
    expect(existsSync(ctl)).toBe(false); // nothing verified alive → files cleaned
    decoy.kill("SIGKILL");
  }, 20_000);

  test("sweep: a dead-owner record is identity-validated; a decoy pid is kept, never signalled", async () => {
    const t = env();
    ensureSockRoot(t.sockRoot);
    const decoy = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    extraProcs.push(decoy);
    const ctl = join(t.sockRoot, "launch-SwEeP1");
    mkdirSync(ctl, { mode: 0o700 });
    writeFileSync(
      join(ctl, "group"),
      formatGroupFile({
        pgid: decoy.pid as number,
        members: [{ pid: decoy.pid as number, lstart: "Thu Jan 1 00:00:00 2099" }],
      })
    );
    const paneId = `c${deadPid()}-zz-tsweep-abcdef`;
    writeRecord(t.sockRoot, {
      paneId,
      ownerPid: deadPid(),
      ownerStart: "Thu Jan 1 00:00:00 1970",
      watcherPid: null,
      magmuxPid: decoy.pid as number,
      panePid: decoy.pid as number,
      sessionUuid: crypto.randomUUID(),
      sockPath: join(t.sockRoot, `magmux-${paneId}.sock`),
      launcherDir: ctl,
      turnDir: "",
      createdAt: new Date().toISOString(),
    });
    const r = await sweepOrphanPanes(t.sockRoot);
    expect(r.kept).toContain(paneId);
    expect(alive(decoy.pid as number)).toBe(true);
    expect(readRecord(t.sockRoot, paneId)).toBeNull();
    decoy.kill("SIGKILL");
  }, 20_000);

  test("sweep: a record whose watcher is alive is skipped (the watcher is mid-job)", async () => {
    const t = env();
    ensureSockRoot(t.sockRoot);
    const paneId = `c${deadPid()}-zz-tw-abcdef`;
    const fakeWatcher = spawn(
      "/bin/sh",
      ["-c", "sleep 30; :", "claudish-pane-watcher", paneId, "x"],
      { stdio: "ignore" }
    );
    extraProcs.push(fakeWatcher);
    await Bun.sleep(100);
    writeRecord(t.sockRoot, {
      paneId,
      ownerPid: deadPid(),
      ownerStart: "x",
      watcherPid: fakeWatcher.pid as number,
      magmuxPid: null,
      panePid: null,
      sessionUuid: "u",
      sockPath: join(t.sockRoot, `magmux-${paneId}.sock`),
      launcherDir: join(t.sockRoot, "launch-nOnE12"),
      turnDir: "",
      createdAt: "",
    });
    const r = await sweepOrphanPanes(t.sockRoot);
    expect(r.kept).toContain(paneId);
    expect(readRecord(t.sockRoot, paneId)).not.toBeNull();
    fakeWatcher.kill("SIGKILL");
    rmSync(join(t.sockRoot, "panes", `${paneId}.json`), { force: true });
  }, 20_000);

  test("sweep: an orphaned real pane (owner AND watcher SIGKILLed) is verified, killed and cleaned", async () => {
    const t = env();
    const { proc, info } = await startOwner(t, 1);
    const rec = info.records[0] as PaneRecord;
    process.kill(rec.watcherPid as number, "SIGKILL");
    await Bun.sleep(100);
    proc.kill("SIGKILL");
    await waitForExit(proc, 2000);
    await Bun.sleep(300);
    expect(alive(rec.magmuxPid as number)).toBe(true);
    const r = await sweepOrphanPanes(t.sockRoot);
    expect(r.reaped).toContain(rec.paneId);
    const left = await waitNoOrphans({
      sockRoot: t.sockRoot,
      ids: [rec.sessionUuid],
      pgids: [rec.panePid ?? 0],
    });
    expect(left).toEqual({ processes: [], files: [] });
  }, 40_000);

  test("sweep: recordless sockets — a refused one is unlinked; a live one is identity-checked and killed", async () => {
    const t = env();
    ensureSockRoot(t.sockRoot);
    const stale = join(t.sockRoot, `magmux-c${deadPid()}-zz-tstale-abcdef.sock`);
    writeFileSync(stale, "");
    const id = `c${deadPid()}-zz-tlive-abcdef`;
    const mag = spawn(
      MAGMUX as string,
      ["--headless", "--no-status", "--id", id, "--sock-dir", t.sockRoot, "-e", "sleep 60"],
      {
        env: { PATH: "/usr/bin:/bin", HOME: t.home, SHELL: "/bin/sh", COLUMNS: "80", LINES: "24" },
        stdio: "ignore",
        detached: true,
      }
    );
    extraProcs.push(mag);
    const sock = join(t.sockRoot, `magmux-${id}.sock`);
    for (let i = 0; i < 100 && !existsSync(sock); i++) await Bun.sleep(50);
    const r = await sweepOrphanPanes(t.sockRoot);
    expect(r.cleaned.some((x) => x.includes("tstale"))).toBe(true);
    expect(r.reaped).toContain(id);
    expect(await waitForExit(mag, 3000)).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(sock)).toBe(false);
    expect(orphanReport({ sockRoot: t.sockRoot }).processes).toEqual([]);
  }, 20_000);

  test("pane limit: counted across owners; reapFailed and dead-owner records never count", async () => {
    const t = env();
    const { proc, info } = await startOwner(t, 1);
    expect(livePaneCount(t.sockRoot)).toBe(1); // the OTHER process's pane
    const base: Omit<PaneRecord, "paneId"> = {
      ownerPid: process.pid,
      ownerStart: ownerStartOfSelf(),
      watcherPid: null,
      magmuxPid: null,
      panePid: null,
      sessionUuid: "u",
      sockPath: "/nope",
      launcherDir: "/nope",
      turnDir: "",
      createdAt: "",
    };
    writeRecord(t.sockRoot, { ...base, paneId: "c1-zz-tfailed-000000", reapFailed: true });
    writeRecord(t.sockRoot, { ...base, paneId: "c1-zz-tdead-000000", ownerPid: deadPid() });
    expect(livePaneCount(t.sockRoot)).toBe(1);
    for (let i = 0; i < MAX_LIVE_PANES - 1; i++)
      writeRecord(t.sockRoot, { ...base, paneId: `c1-zz-tfill${i}-000000` });
    expect(livePaneCount(t.sockRoot)).toBe(MAX_LIVE_PANES);
    expect(() => reservePanes(1, t.sockRoot)).toThrow(PaneLimitError);
    for (let i = 0; i < MAX_LIVE_PANES - 1; i++)
      rmSync(join(t.sockRoot, "panes", `c1-zz-tfill${i}-000000.json`));
    reservePanes(2, t.sockRoot);
    expect(livePaneCount(t.sockRoot)).toBe(3);
    releasePaneReservations(2);
    for (const n of ["c1-zz-tfailed-000000", "c1-zz-tdead-000000"])
      rmSync(join(t.sockRoot, "panes", `${n}.json`));
    proc.kill("SIGKILL");
    const left = await waitNoOrphans({
      sockRoot: t.sockRoot,
      ids: info.panes.map((p) => p.uuid),
      pgids: info.panes.map((p) => p.panePid),
    });
    expect(left).toEqual({ processes: [], files: [] });
  }, 40_000);

  test("R3-M1: a magmux spawn failure reaps at once — record and dirs gone, no watcher, livePaneCount 0", async () => {
    const t = env();
    const fake = join(t.tmp, "magmux-fake");
    writeFileSync(fake, "#!/bin/sh\necho 'magmux 0.14.0 (fake)'\n");
    chmodSync(fake, 0o755);
    await assertMagmuxAvailable(fake); // passes the version gate …
    rmSync(fake);
    mkdirSync(fake); // … then the binary becomes unspawnable (EACCES on a directory)
    const uuid = crypto.randomUUID();
    // the watcher and the record exist BEFORE magmux is spawned (X-L4), so this is a real reap
    const s = await startPaneSession({
      kind: "t",
      label: "01",
      callerFlags: [],
      spawnModel: "fake-answer",
      cwd: t.cwd,
      sessionUuid: uuid,
      transcriptPath: t.transcriptPathFor(uuid),
      slotEnv: {},
      shape: "one-shot",
      initialPrompt: "x",
      readAvailable: true,
      parentEnv: t.env,
      sockRoot: t.sockRoot,
      magmuxBinary: fake,
      decide: () => ({ state: "COMPLETED" }),
      onBlocked: () => "wait",
    });
    const snap = await s.terminal;
    expect(snap.state).toBe("FAILED");
    expect(snap.reason).toBe("pane_lost");
    expect(snap.detail).toContain("magmux spawn failed");
    await s.reaped();
    expect(livePaneCount(t.sockRoot)).toBe(0);
    expect(
      readProcessTable().some(
        (r) => r.command.includes("claudish-pane-watcher") && r.command.includes(t.sockRoot)
      )
    ).toBe(false);
    expect(orphanReport({ sockRoot: t.sockRoot, ids: [uuid] })).toEqual({
      processes: [],
      files: [],
    });
  }, 20_000);
});

describe("records", () => {
  test("a record round-trips and is written 0600", () => {
    const t = env();
    ensureSockRoot(t.sockRoot);
    const rec: PaneRecord = {
      paneId: "c1-zz-trt-000000",
      ownerPid: 1,
      ownerStart: "Mon Oct 6 12:00:00 2026",
      watcherPid: 2,
      magmuxPid: null,
      panePid: null,
      sessionUuid: "u",
      sockPath: "/s",
      launcherDir: "/l",
      turnDir: "/t",
      createdAt: "now",
    };
    writeRecord(t.sockRoot, rec);
    expect(readRecord(t.sockRoot, rec.paneId)).toEqual({ ...rec, reapFailed: false });
    const mode =
      Bun.file(join(t.sockRoot, "panes", `${rec.paneId}.json`)).size >= 0
        ? execFileSync("stat", ["-f", "%Lp", join(t.sockRoot, "panes", `${rec.paneId}.json`)], {
            encoding: "utf8",
          }).trim()
        : "";
    if (process.platform === "darwin") expect(mode).toBe("600");
    expect(
      JSON.parse(readFileSync(join(t.sockRoot, "panes", `${rec.paneId}.json`), "utf8")).paneId
    ).toBe(rec.paneId);
  });
});

describe("reservations", () => {
  test("a start that throws before it took its reservation still uses up the one held for it", async () => {
    const t = env();
    const before = reservedPaneCount();
    reservePanes(2, t.sockRoot);
    expect(reservedPaneCount()).toBe(before + 2);
    // A claudish subcommand name as the model is refused before anything is spawned.
    for (const label of ["01", "02"]) {
      const err = await startPaneSession({
        kind: "t",
        label,
        callerFlags: [],
        spawnModel: "update",
        cwd: t.cwd,
        sessionUuid: crypto.randomUUID(),
        transcriptPath: t.transcriptPathFor("x"),
        slotEnv: {},
        shape: "one-shot",
        initialPrompt: "x",
        readAvailable: true,
        parentEnv: t.env,
        sockRoot: t.sockRoot,
        decide: () => ({ state: "COMPLETED" }),
        onBlocked: () => "wait",
      }).catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe("invalid_args");
    }
    expect(reservedPaneCount()).toBe(before);
  });
});
