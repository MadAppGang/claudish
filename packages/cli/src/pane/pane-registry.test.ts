/**
 * Process-wide pane safety against REAL magmux (architecture §2.11, §12.3): the parallel
 * shutdown reap, the watcher's clean exit, the owner-SIGKILL gate with two panes (and the
 * fd-hygiene measurement behind it), decoys that must never be signalled, the startup
 * sweep, the cross-owner pane limit, and the R3-M1 spawn-failure reap.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { type Server, createServer } from "node:net";
import { join } from "node:path";
import { waitForExit } from "../process-tree.js";
import { MagmuxConnectError } from "./magmux-client.js";
import {
  MIN_MAGMUX_VERSION,
  OWNER_START36,
  assertMagmuxAvailable,
  ensureSockRoot,
  spawnPaneWatcher,
} from "./pane-launch.js";
import {
  MAX_LIVE_PANES,
  PaneLimitError,
  type PaneRecord,
  type RegisteredPane,
  livePaneCount,
  ownerAlive,
  ownerStartOfSelf,
  probeSocket,
  readRecord,
  readRecords,
  reapAllPanes,
  refreshGroupOf,
  releasePaneReservations,
  removePaneFiles,
  reservePanes,
  reservedPaneCount,
  setSocketDialForTest,
  sweepOrphanPanes,
  updateRecord,
  writeRecord,
} from "./pane-registry.js";
import { startPaneSession } from "./pane-session.js";
import {
  formatGroupFile,
  isPaneRecordPath,
  isPaneSockPath,
  isPaneWatcherCommand,
  magmuxNeedle,
  pidMayBeAlive,
  recordPathOf,
  sockPathOf,
} from "./process-identity.js";
import {
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  type PaneTestEnv,
  killLeftovers,
  makePaneTestEnv,
  orphanReport,
  requireProcessTable,
  waitNoOrphans,
  withProcessTableUnavailable,
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

/**
 * A socket inode nothing listens on, made the way a magmux leaves one: a child binds it and
 * is SIGKILLed, so no close() runs and the kernel keeps the file. A dial is then refused
 * with ECONNREFUSED. Closing an in-process server instead is not portable: Bun 1.3.10 (the
 * CI pin) removes the file, and the dial answers ENOENT. (A plain file there answers
 * ENOTSOCK, which is not proof of a stale socket.)
 */
async function staleSocket(path: string): Promise<void> {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(path)}, () => console.log("up"));`,
    ],
    { env: { ...process.env }, stdout: "pipe", stderr: "inherit" }
  );
  await child.stdout.getReader().read(); // "up": bound and listening
  child.kill("SIGKILL");
  await child.exited;
  expect(lstatSync(path).isSocket()).toBe(true);
}

function deadPid(): number {
  const p = Bun.spawnSync(["/usr/bin/true"], { env: { ...process.env } });
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
    text = execFileSync("lsof", ["-a", "-U", "-p", pids.join(",")], {
      env: { ...process.env },
      encoding: "utf8",
    });
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
    expect(requireProcessTable().some((r) => isPaneWatcherCommand(r.command, s.paneId))).toBe(
      false
    );
    expect(existsSync(s.sockPath)).toBe(false);
    expect(readRecord(t.sockRoot, s.paneId)).toBeNull();
  }, 30_000);

  test("with the process table unavailable a pane starts, records its pid and reaps by its handle", async () => {
    const t = env();
    const { s, uuid } = await withProcessTableUnavailable(async () => {
      const started = await hangSession(t);
      // onSnapshot → setPanePid → readProcessTableAsync must resolve, never reject
      for (let i = 0; i < 100 && !readRecord(t.sockRoot, started.s.paneId)?.panePid; i++)
        await Bun.sleep(50);
      await Bun.sleep(200);
      expect(readRecord(t.sockRoot, started.s.paneId)?.panePid).toBeGreaterThan(0);
      started.s.cancel();
      await started.s.reaped();
      return started;
    });
    expect(s.snapshot().state).toBe("CANCELLED");
    expect(readRecord(t.sockRoot, s.paneId)).toBeNull();
    const left = await waitNoOrphans({ sockRoot: t.sockRoot, ids: [uuid] });
    expect(left).toEqual({ processes: [], files: [] });
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
    const decoy = spawn("sleep", ["60"], {
      env: { ...process.env },
      detached: true,
      stdio: "ignore",
    });
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
    const decoy = spawn("sleep", ["60"], {
      env: { ...process.env },
      detached: true,
      stdio: "ignore",
    });
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
      { env: { ...process.env }, stdio: "ignore" }
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
    await staleSocket(stale);
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
    writeFileSync(fake, `#!/bin/sh\necho 'magmux ${MIN_MAGMUX_VERSION} (fake)'\n`);
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
      requireProcessTable().some(
        (r) => r.command.includes("claudish-pane-watcher") && r.command.includes(t.sockRoot)
      )
    ).toBe(false);
    expect(orphanReport({ sockRoot: t.sockRoot, ids: [uuid] })).toEqual({
      processes: [],
      files: [],
    });
  }, 20_000);

  test("a record that cannot be written refuses the start and leaves no launch dir", async () => {
    const t = env();
    const root = ensureSockRoot(t.sockRoot);
    chmodSync(join(root, "panes"), 0o500); // still private, but unwritable
    try {
      const uuid = crypto.randomUUID();
      await expect(
        startPaneSession({
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
          sockRoot: root,
          decide: () => ({ state: "COMPLETED" }),
          onBlocked: () => "wait",
        })
      ).rejects.toThrow(/cannot write the pane record/);
      expect(readdirSync(root).filter((n) => n.startsWith("launch-"))).toEqual([]);
      expect(livePaneCount(root)).toBe(0);
    } finally {
      chmodSync(join(root, "panes"), 0o700);
    }
  }, 20_000);
});

/** `ps -o <field>= -p <pid>`, or null when the pid is gone. */
function psField(pid: number, field: string): number | null {
  try {
    const v = execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], {
      env: { ...process.env },
      encoding: "utf8",
    });
    return Number(v.trim());
  } catch {
    return null;
  }
}

describe("escaped background shells (code-review iteration 2, M2)", () => {
  test("a shell whose parent died before the wrapper stays in the group file; the watcher ends it, no orphan", async () => {
    const t = env();
    ensureSockRoot(t.sockRoot);
    const ctl = join(t.sockRoot, "launch-EsCaP1");
    const turn = join(t.sockRoot, "launch-EsCaP2");
    mkdirSync(ctl, { mode: 0o700 });
    mkdirSync(turn, { mode: 0o700 });
    const uuid = crypto.randomUUID();
    const paneId = `c${deadPid()}-zz-tescape-abcdef`;
    // The pane group, as a real pane runs it: a session leader standing in for the claudish
    // wrapper (its argv carries --session-id), and under it "claude", which starts a
    // background shell in a process group of its own (as 2.1.291 runs run_in_background)
    // and then dies on a line from the test while the wrapper lives on.
    const claude = `const c = require("node:child_process").spawn("sleep", ["300"], { detached: true, stdio: "ignore" }); c.unref(); console.log(c.pid); process.stdin.once("data", () => process.exit(0));`;
    const wrapper = spawn(
      "/bin/sh",
      ["-c", `"${process.execPath}" -e "$CLAUDE"; sleep 60; :`, "wrapper", "--session-id", uuid],
      {
        detached: true,
        stdio: ["pipe", "pipe", "ignore"],
        env: { PATH: "/usr/bin:/bin", CLAUDE: claude },
      }
    );
    extraProcs.push(wrapper);
    const bgPid = await new Promise<number>((resolve, reject) => {
      let buf = "";
      wrapper.stdout?.on("data", (d: Buffer) => {
        buf += d.toString();
        if (buf.includes("\n")) resolve(Number(buf.trim()));
      });
      wrapper.on("exit", (c) => reject(new Error(`wrapper exited ${c}`)));
    });
    const wrapperPid = wrapper.pid as number;
    try {
      expect(psField(bgPid, "pgid")).toBe(bgPid);
      const pane = {
        paneId,
        root: t.sockRoot,
        identity: { paneId, sessionUuid: uuid, ctlDir: ctl },
        panePid: () => wrapperPid,
        group: null,
      } as unknown as RegisteredPane;
      refreshGroupOf(pane, requireProcessTable());
      expect(pane.group?.escaped?.map((m) => m.pid)).toEqual([bgPid]);

      wrapper.stdin?.write("die\n"); // claude dies without its own cleanup
      for (let i = 0; i < 100 && psField(bgPid, "ppid") !== 1; i++) await Bun.sleep(50);
      expect(psField(bgPid, "ppid")).toBe(1);
      // a refresh in the window between claude's death and the wrapper's exit, while the
      // wrapper still carries the identity (so the fresh snapshot is a verified one)
      const table = requireProcessTable();
      expect(table.find((r) => r.pid === wrapperPid)?.command).toContain(`--session-id ${uuid}`);
      refreshGroupOf(pane, table);
      expect(pane.group?.members.some((m) => m.pid === wrapperPid)).toBe(true);
      expect(pane.group?.escaped?.map((m) => m.pid)).toEqual([bgPid]);

      // the owner is gone: the watcher reads the same group file and ends both
      const w = spawnPaneWatcher({
        paneId,
        sessionUuid: uuid,
        ctlDir: ctl,
        sockPath: join(t.sockRoot, `magmux-${paneId}.sock`),
        recordPath: join(t.sockRoot, "panes", `${paneId}.json`),
        turnDir: turn,
        sockRoot: t.sockRoot,
      });
      w.stdin?.end();
      expect(await waitForExit(w, 10_000)).toBe(true);
      expect(alive(wrapperPid)).toBe(false);
      expect(alive(bgPid)).toBe(false);
      expect(existsSync(ctl)).toBe(false);
    } finally {
      for (const target of [bgPid, -wrapperPid]) {
        try {
          process.kill(target, "SIGKILL");
        } catch {
          // already ended by the watcher
        }
      }
    }
  }, 30_000);
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
            env: { ...process.env },
            encoding: "utf8",
          }).trim()
        : "";
    if (process.platform === "darwin") expect(mode).toBe("600");
    expect(
      JSON.parse(readFileSync(join(t.sockRoot, "panes", `${rec.paneId}.json`), "utf8")).paneId
    ).toBe(rec.paneId);
  });
  test("R3-M2: a record is trusted only when its paneId is valid and names its own file", () => {
    const t = env();
    const root = ensureSockRoot(t.sockRoot);
    const victim = join(t.tmp, "victim.json");
    writeFileSync(victim, "{}");
    const base = {
      ownerPid: 1,
      ownerStart: "x",
      watcherPid: null,
      magmuxPid: null,
      panePid: null,
      sessionUuid: "u",
      sockPath: "/s",
      launcherDir: "/l",
      turnDir: "/t",
      createdAt: "now",
    };
    // a planted record whose paneId climbs out of the root, and one naming another file
    const hostile = `../../${t.tmp.split("/").pop()}/victim`;
    writeFileSync(
      join(root, "panes", "c1-zz-tbad-000001.json"),
      JSON.stringify({ ...base, paneId: hostile })
    );
    writeFileSync(
      join(root, "panes", "c1-zz-tbad-000002.json"),
      JSON.stringify({ ...base, paneId: "c1-zz-tother-000003" })
    );
    expect(readRecord(root, "c1-zz-tbad-000001")).toBeNull();
    expect(readRecord(root, "c1-zz-tbad-000002")).toBeNull();
    expect(readRecords(root)).toEqual([]);
    // the path predicates compare against the root, never a path against itself
    expect(isPaneRecordPath(root, recordPathOf(root, hostile), hostile)).toBe(false);
    expect(isPaneSockPath(root, sockPathOf(root, "../x"), "../x")).toBe(false);
    expect(isPaneRecordPath(root, recordPathOf(root, "c1-ok-t-000004"), "c1-ok-t-000004")).toBe(
      true
    );
    removePaneFiles(root, { paneId: hostile, sockPath: "/s", launcherDir: "", turnDir: "" });
    expect(existsSync(victim)).toBe(true);
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

describe("with the process table unavailable (a sandbox refuses ps): owners judged by kill(pid, 0)", () => {
  /** A listening unix socket standing in for a live magmux. */
  async function liveSocket(path: string): Promise<Server> {
    const server = createServer((c) => c.end());
    await new Promise<void>((resolve) => server.listen(path, resolve));
    return server;
  }

  /**
   * A pane record as another owner's sweep or count would find it: owned by THIS live
   * process, or by a pid that is gone (an owner SIGKILLed inside a sandbox, so its
   * record has no ownerStart and nothing removed it). The socket is stale (`staleSocket`),
   * as a dead magmux leaves it.
   */
  async function ownerPane(
    t: PaneTestEnv,
    label: string,
    owner: "live" | "dead"
  ): Promise<PaneRecord> {
    const root = ensureSockRoot(t.sockRoot);
    const ownerPid = owner === "live" ? process.pid : deadPid();
    const paneId = `c${ownerPid}-${OWNER_START36}-t${label}-abcdef`;
    const ctl = join(root, `launch-${label}Ctl1`);
    const turn = join(root, `launch-${label}Trn1`);
    mkdirSync(ctl, { mode: 0o700 });
    mkdirSync(turn, { mode: 0o700 });
    const rec: PaneRecord = {
      paneId,
      ownerPid,
      ownerStart: owner === "live" ? ownerStartOfSelf() : "",
      watcherPid: null,
      magmuxPid: owner === "dead" ? deadPid() : null, // a dead owner's magmux died with it
      panePid: null,
      sessionUuid: crypto.randomUUID(),
      sockPath: sockPathOf(root, paneId),
      launcherDir: ctl,
      turnDir: turn,
      createdAt: new Date().toISOString(),
    };
    await staleSocket(rec.sockPath);
    writeRecord(root, rec);
    return rec;
  }

  const filesOf = (rec: PaneRecord) => [rec.sockPath, rec.launcherDir, rec.turnDir];

  test("the ps-free probe: ESRCH is dead; success and EPERM are alive", () => {
    expect(pidMayBeAlive(process.pid)).toBe(true);
    expect(pidMayBeAlive(deadPid())).toBe(false);
    expect(pidMayBeAlive(1)).toBe(true); // launchd/init: EPERM
  });

  test("a live owner: counted, and the sweep keeps its record, socket and dirs", async () => {
    const t = env();
    const rec = await ownerPane(t, "lv", "live");
    expect(await withProcessTableUnavailable(() => livePaneCount(t.sockRoot))).toBe(1);
    const r = await withProcessTableUnavailable(() => sweepOrphanPanes(t.sockRoot));
    // alive by kill(pid, 0) alone is unverified, so the pane is listed as kept
    expect(r).toEqual({ reaped: [], cleaned: [], kept: [rec.paneId] });
    expect(readRecord(t.sockRoot, rec.paneId)).not.toBeNull();
    for (const p of filesOf(rec)) expect(existsSync(p)).toBe(true);
  });

  test("a record a sandboxed owner wrote (no ownerStart), swept later with a working ps: kept", async () => {
    // the owner could not read its lstart; its pane id still embeds its start time
    const t = env();
    const rec = await ownerPane(t, "sb", "live");
    updateRecord(t.sockRoot, rec.paneId, { ownerStart: "" });
    expect(await livePaneCount(t.sockRoot)).toBe(1);
    const r = await sweepOrphanPanes(t.sockRoot);
    expect(r).toEqual({ reaped: [], cleaned: [], kept: [] });
    for (const p of filesOf(rec)) expect(existsSync(p)).toBe(true);
  });

  test("a dead owner whose magmux is gone: not counted, and the sweep removes its files", async () => {
    const t = env();
    const rec = await ownerPane(t, "dd", "dead");
    expect(await withProcessTableUnavailable(() => livePaneCount(t.sockRoot))).toBe(0);
    const r = await withProcessTableUnavailable(() => sweepOrphanPanes(t.sockRoot));
    expect(r.cleaned).toEqual([rec.paneId]);
    expect(readRecord(t.sockRoot, rec.paneId)).toBeNull();
    for (const p of filesOf(rec)) expect(existsSync(p)).toBe(false);
  });

  test("dead owners never fill the pane limit", async () => {
    const t = env();
    for (let i = 0; i < MAX_LIVE_PANES; i++)
      await ownerPane(t, i.toString(36).padStart(2, "0"), "dead");
    // 48 records of dead owners: a start must still be admitted, not refused as pane_limit
    await withProcessTableUnavailable(() => reservePanes(1, t.sockRoot));
    releasePaneReservations(1);
  });

  test("a dead owner whose magmux still answers: not counted, files kept, nothing signalled", async () => {
    const t = env();
    const rec = await ownerPane(t, "dm", "dead");
    rmSync(rec.sockPath);
    const server = await liveSocket(rec.sockPath);
    try {
      expect(await withProcessTableUnavailable(() => livePaneCount(t.sockRoot))).toBe(0);
      const r = await withProcessTableUnavailable(() => sweepOrphanPanes(t.sockRoot));
      expect(r.kept).toEqual([rec.paneId]);
      expect(readRecord(t.sockRoot, rec.paneId)).not.toBeNull();
      for (const p of filesOf(rec)) expect(existsSync(p)).toBe(true);
    } finally {
      server.close();
    }
  }, 20_000);

  test("a dead owner whose watcher pid may be alive: kept (the watcher may be mid-job)", async () => {
    const t = env();
    const rec = await ownerPane(t, "dw", "dead");
    updateRecord(t.sockRoot, rec.paneId, { watcherPid: process.pid });
    const r = await withProcessTableUnavailable(() => sweepOrphanPanes(t.sockRoot));
    expect(r.kept).toEqual([rec.paneId]);
    for (const p of filesOf(rec)) expect(existsSync(p)).toBe(true);
  });

  test("a dead owner's refused socket whose magmux pid may be alive, or was never recorded: kept", async () => {
    // a LIVE listener with a full accept queue refuses too (darwin); only a dead pid proves it gone
    for (const magmuxPid of [process.pid, null]) {
      const t = env();
      const rec = await ownerPane(t, "dr", "dead");
      updateRecord(t.sockRoot, rec.paneId, { magmuxPid });
      const r = await withProcessTableUnavailable(() => sweepOrphanPanes(t.sockRoot));
      expect({ magmuxPid, r }).toEqual({
        magmuxPid,
        r: { reaped: [], cleaned: [], kept: [rec.paneId] },
      });
      for (const p of filesOf(rec)) expect(existsSync(p)).toBe(true);
    }
  });

  test("recordless sockets without a table: a live owner's is left alone; a dead owner's are kept, live or refused", async () => {
    // no table names the pane's magmux, so a refusal proves nothing about it
    const t = env();
    const root = ensureSockRoot(t.sockRoot);
    const gone = deadPid();
    const ownLive = join(root, `magmux-c${process.pid}-${OWNER_START36}-tls-abcdef.sock`);
    const deadLive = join(root, `magmux-c${gone}-${OWNER_START36}-tdl-abcdef.sock`);
    const deadRefused = join(root, `magmux-c${gone}-${OWNER_START36}-tdr-abcdef.sock`);
    const servers = [await liveSocket(ownLive), await liveSocket(deadLive)];
    await staleSocket(deadRefused);
    try {
      const r = await withProcessTableUnavailable(() => sweepOrphanPanes(root));
      expect(r.reaped).toEqual([]);
      expect(r.kept.sort()).toEqual([
        `c${gone}-${OWNER_START36}-tdl-abcdef`,
        `c${gone}-${OWNER_START36}-tdr-abcdef`,
      ]);
      expect(r.cleaned).toEqual([]);
      expect([ownLive, deadLive, deadRefused].map((p) => existsSync(p))).toEqual([
        true,
        true,
        true,
      ]);
    } finally {
      for (const s of servers) s.close();
    }
  }, 20_000);

  /** Run `fn` with every pane-socket dial failing with `code`. */
  async function withDialError<T>(code: string, fn: () => Promise<T>): Promise<T> {
    const prev = setSocketDialForTest(() =>
      Promise.reject(new MagmuxConnectError(`connect ${code}`, code))
    );
    try {
      return await fn();
    } finally {
      setSocketDialForTest(prev);
    }
  }

  const INCONCLUSIVE = ["EPERM", "EACCES", "EMFILE", "ENFILE", "ENOTSOCK"];
  const STALE = ["ECONNREFUSED", "ENOENT"];

  test("a dead owner's record: an inconclusive probe keeps the files, a stale one removes them", async () => {
    for (const code of [...INCONCLUSIVE, ...STALE]) {
      const t = env();
      const rec = await ownerPane(t, "pr", "dead");
      const r = await withDialError(code, () =>
        withProcessTableUnavailable(() => sweepOrphanPanes(t.sockRoot))
      );
      const removed = STALE.includes(code);
      expect({ code, r }).toEqual({
        code,
        r: { reaped: [], cleaned: removed ? [rec.paneId] : [], kept: removed ? [] : [rec.paneId] },
      });
      for (const p of filesOf(rec)) expect(`${code} ${existsSync(p)}`).toBe(`${code} ${!removed}`);
    }
  }, 30_000);

  test("a dead owner's recordless socket without a table: kept, whatever the dial reports", async () => {
    // no table names its magmux, so a refusal is inconclusive; an ENOENT while the socket
    // is still on disk is a refusal too (old Bun reports ENOENT for every failed connect)
    for (const code of [...INCONCLUSIVE, ...STALE]) {
      const t = env();
      const root = ensureSockRoot(t.sockRoot);
      const id = `c${deadPid()}-${OWNER_START36}-trp-abcdef`;
      const sock = sockPathOf(root, id);
      await staleSocket(sock);
      const r = await withDialError(code, () =>
        withProcessTableUnavailable(() => sweepOrphanPanes(root))
      );
      expect({ code, kept: r.kept, cleaned: r.cleaned }).toEqual({ code, kept: [id], cleaned: [] });
      expect(`${code} ${existsSync(sock)}`).toBe(`${code} true`);
    }
  }, 30_000);
});

describe("a dial that reports ENOENT is checked against the path (Bun < 1.4 reports it for every failure)", () => {
  // replays Bun 1.3.10 on any Bun: every failed unix connect answers ENOENT
  async function probeWithEnoent(path: string, magmuxMayLive: boolean) {
    const prev = setSocketDialForTest(() =>
      Promise.reject(new MagmuxConnectError("connect ENOENT", "ENOENT"))
    );
    try {
      return await probeSocket(path, magmuxMayLive);
    } finally {
      setSocketDialForTest(prev);
    }
  }

  test("missing → stale; plain file → ENOTSOCK; mode 000 → EACCES; any other socket → a refusal", async () => {
    const t = env();
    const root = ensureSockRoot(t.sockRoot);
    const refused = join(root, "magmux-refused.sock");
    await staleSocket(refused);
    const locked = join(root, "magmux-locked.sock");
    await staleSocket(locked);
    chmodSync(locked, 0o000);
    const plain = join(root, "magmux-plain.sock");
    writeFileSync(plain, "");
    expect(await probeWithEnoent(join(root, "magmux-none.sock"), true)).toEqual({
      state: "stale",
      code: "ENOENT",
    });
    expect(await probeWithEnoent(plain, false)).toEqual({
      state: "inconclusive",
      code: "ENOTSOCK",
    });
    expect(await probeWithEnoent(locked, false)).toEqual({ state: "inconclusive", code: "EACCES" });
    // a refusal is stale only with the pane's magmux proven dead
    expect(await probeWithEnoent(refused, true)).toEqual({
      state: "inconclusive",
      code: "ECONNREFUSED",
    });
    expect(await probeWithEnoent(refused, false)).toEqual({ state: "stale", code: "ECONNREFUSED" });
  }, 20_000);

  test("an lstat that fails with anything but ENOENT proves nothing: inconclusive, even with magmux dead", async () => {
    const t = env();
    const root = ensureSockRoot(t.sockRoot);
    const hidden = join(root, "hidden");
    mkdirSync(hidden, { mode: 0o700 });
    const sock = join(hidden, "magmux-hidden.sock");
    await staleSocket(sock);
    chmodSync(hidden, 0o000); // lstat of the socket inside now fails with EACCES
    try {
      expect(await probeWithEnoent(sock, false)).toEqual({ state: "inconclusive", code: "EACCES" });
    } finally {
      chmodSync(hidden, 0o700);
    }
    expect(existsSync(sock)).toBe(true);
  }, 20_000);
});

describe("the pane-socket probe: ENOENT, or ECONNREFUSED with magmux proven dead, is stale", () => {
  test("real sockets: live → answers; refused or missing → stale; mode 000 or a plain file → inconclusive", async () => {
    const t = env();
    const root = ensureSockRoot(t.sockRoot);
    const live = join(root, "magmux-live.sock");
    const locked = join(root, "magmux-locked.sock");
    const servers = [createServer((c) => c.end()), createServer((c) => c.end())];
    await new Promise<void>((resolve) => servers[0]?.listen(live, resolve));
    await new Promise<void>((resolve) => servers[1]?.listen(locked, resolve));
    chmodSync(locked, 0o000);
    const refused = join(root, "magmux-refused.sock");
    await staleSocket(refused);
    const plain = join(root, "magmux-plain.sock");
    writeFileSync(plain, "");
    try {
      const answers = await probeSocket(live, true);
      expect(answers.state).toBe("answers");
      if (answers.state === "answers") answers.client.close();
      expect(await probeSocket(refused, false)).toEqual({ state: "stale", code: "ECONNREFUSED" });
      expect(await probeSocket(join(root, "magmux-none.sock"), true)).toEqual({
        state: "stale",
        code: "ENOENT",
      });
      expect(await probeSocket(locked, false)).toEqual({ state: "inconclusive", code: "EACCES" });
      expect(await probeSocket(plain, false)).toEqual({ state: "inconclusive", code: "ENOTSOCK" });
    } finally {
      for (const s of servers) s.close();
    }
  }, 20_000);

  test("ECONNREFUSED while the pane's magmux may live is inconclusive", async () => {
    // darwin refuses a LIVE listener whose accept queue is full (magmux sockdir.go ReapStale)
    const prev = setSocketDialForTest(() =>
      Promise.reject(new MagmuxConnectError("connect ECONNREFUSED", "ECONNREFUSED"))
    );
    try {
      expect(await probeSocket("/nonexistent/magmux-busy.sock", true)).toEqual({
        state: "inconclusive",
        code: "ECONNREFUSED",
      });
    } finally {
      setSocketDialForTest(prev);
    }
  });

  test("with a readable table, a dead owner's refused recordless socket: kept while a magmux for its id runs, removed once none does", async () => {
    const t = env();
    const root = ensureSockRoot(t.sockRoot);
    const id = `c${deadPid()}-${OWNER_START36}-trf-abcdef`;
    const sock = sockPathOf(root, id);
    await staleSocket(sock);
    // a process whose argv carries the pane's magmux needle, as a busy magmux's would
    const mag = Bun.spawn(["/bin/sh", "-c", "sleep 30; true", "sh", magmuxNeedle(id)], {
      env: { ...process.env },
    });
    try {
      expect(await sweepOrphanPanes(root)).toEqual({ reaped: [], cleaned: [], kept: [id] });
      expect(existsSync(sock)).toBe(true);
    } finally {
      mag.kill("SIGKILL");
      await mag.exited;
    }
    expect(await sweepOrphanPanes(root)).toEqual({ reaped: [], cleaned: [id], kept: [] });
    expect(existsSync(sock)).toBe(false);
  }, 20_000);

  test("a dial that never settles is inconclusive", async () => {
    const prev = setSocketDialForTest(() => new Promise<never>(() => {}));
    try {
      expect(await probeSocket("/nonexistent/magmux-x.sock", false)).toEqual({
        state: "inconclusive",
        code: "ETIMEDOUT",
      });
    } finally {
      setSocketDialForTest(prev);
    }
  }, 20_000);

  test("with a readable table, a dead owner's recordless socket that refuses access (EACCES) is kept", async () => {
    // outside any sandbox: the sweep keeps what it cannot probe instead of unlinking it
    const t = env();
    const root = ensureSockRoot(t.sockRoot);
    const id = `c${deadPid()}-${OWNER_START36}-tea-abcdef`;
    const sock = sockPathOf(root, id);
    const server = createServer((c) => c.end());
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    chmodSync(sock, 0o000);
    try {
      const r = await sweepOrphanPanes(root);
      expect(r).toEqual({ reaped: [], cleaned: [], kept: [id] });
      expect(existsSync(sock)).toBe(true);
    } finally {
      server.close();
    }
  }, 20_000);
});

describe("owner identity: one check for the pane limit, the record sweep and the socket sweep", () => {
  const selfId = (start36: string) => `c${process.pid}-${start36}-towner-abcdef`;

  test("no ownerStart: the start time the pane id embeds must match the live pid's", () => {
    const table = requireProcessTable();
    const owner = { ownerPid: process.pid, ownerStart: "" };
    expect(ownerAlive({ ...owner, paneId: selfId(OWNER_START36) }, table)).toBe(true);
    // the same pid now running a process that started an hour later: a reused pid
    const anHourEarlier = (Number.parseInt(OWNER_START36, 36) - 3_600_000).toString(36);
    expect(ownerAlive({ ...owner, paneId: selfId(anHourEarlier) }, table)).toBe(false);
    const gone = deadPid();
    expect(
      ownerAlive(
        { ownerPid: gone, ownerStart: "", paneId: `c${gone}-${OWNER_START36}-towner-abcdef` },
        table
      )
    ).toBe(false);
  });

  test("a recorded ownerStart still decides by lstart", () => {
    const table = requireProcessTable();
    const paneId = selfId(OWNER_START36);
    expect(
      ownerAlive({ paneId, ownerPid: process.pid, ownerStart: ownerStartOfSelf() }, table)
    ).toBe(true);
    expect(
      ownerAlive({ paneId, ownerPid: process.pid, ownerStart: "Thu Jan 1 00:00:00 1970" }, table)
    ).toBe(false);
  });

  test("the id start check does not depend on the process timezone", () => {
    const dir = import.meta.dir;
    const script = [
      `import { ownerAlive } from ${JSON.stringify(join(dir, "pane-registry.ts"))};`,
      `import { OWNER_START36 } from ${JSON.stringify(join(dir, "pane-launch.ts"))};`,
      `import { readProcessTable } from ${JSON.stringify(join(dir, "process-identity.ts"))};`,
      "const paneId = `c${process.pid}-${OWNER_START36}-ttz-abcdef`;",
      'console.log(ownerAlive({ paneId, ownerPid: process.pid, ownerStart: "" }, readProcessTable() ?? []));',
    ].join("\n");
    // at least two of these differ from any system zone
    for (const tz of ["UTC", "Pacific/Kiritimati", "America/Adak"]) {
      const r = Bun.spawnSync([process.execPath, "-e", script], {
        env: { ...process.env, TZ: tz },
      });
      expect(`${tz}: ${r.stdout.toString().trim()}`).toBe(`${tz}: true`);
    }
  }, 30_000);

  test("the recordless-socket sweep keeps a live owner's socket under a non-system TZ", async () => {
    // bun test runs with TZ=UTC; the socket's id embeds this process's own start
    const t = env();
    const root = ensureSockRoot(t.sockRoot);
    const sock = join(root, `magmux-${selfId(OWNER_START36)}.sock`);
    const server = createServer((c) => c.end());
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    try {
      const r = await sweepOrphanPanes(root);
      expect(r.cleaned).toEqual([]);
      expect(r.kept).toEqual([]);
      expect(existsSync(sock)).toBe(true);
    } finally {
      server.close();
    }
  }, 20_000);
});
