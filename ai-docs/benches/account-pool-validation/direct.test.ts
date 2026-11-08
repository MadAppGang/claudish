import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Check } from "./agree.ts";
import { killTree, pidGone, postMessage, redirectOf } from "./direct.ts";
import { standingBroken } from "./e20-gate.ts";
import { applyRedirects } from "./harness.ts";
import { harnessErrorOf } from "./run-row.ts";

// Review finding (round 5, HIGH): the parent's fetch followed redirects. The offline sandbox
// wraps the product child, not the Bun parent, so a product answer redirecting to a
// non-loopback host would have made the parent contact that host.

const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** A loopback listener that records every request and answers with `reply`. */
function listener(reply: () => Response) {
  const hits: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      hits.push(`${req.method} ${new URL(req.url).pathname}`);
      return reply();
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, hits };
}

describe("postMessage never follows a redirect", () => {
  test("a 302 to a non-loopback host is captured as a failure, with no second request", async () => {
    const target = "https://exfil.invalid/collect";
    const product = listener(
      () => new Response(null, { status: 302, headers: { location: target } })
    );
    const reply = await postMessage(product.url, "hi", undefined, 5_000);
    // Following would have thrown (unresolvable host) and set connectionError instead.
    expect(reply.connectionError).toBeUndefined();
    expect(reply.status).toBe(302);
    expect(reply.redirect).toEqual({ status: 302, location: target });
    expect(product.hits).toEqual(["POST /v1/messages"]);
  });

  test("a 302 to a second loopback listener: that listener receives no request", async () => {
    const elsewhere = listener(() => new Response("followed"));
    const product = listener(
      () => new Response(null, { status: 302, headers: { location: `${elsewhere.url}/followed` } })
    );
    const reply = await postMessage(product.url, "hi", undefined, 5_000);
    expect(elsewhere.hits).toEqual([]);
    expect(product.hits).toEqual(["POST /v1/messages"]);
    expect(reply.redirect?.status).toBe(302);
  });

  test("a 200 carries no redirect", async () => {
    const product = listener(() => Response.json({ ok: true }));
    const reply = await postMessage(product.url, "hi", undefined, 5_000);
    expect(reply.status).toBe(200);
    expect(reply.redirect).toBeUndefined();
  });

  test.each([301, 302, 303, 307, 308])("redirectOf captures %i with its Location", (status) => {
    const res = new Response(null, { status, headers: { location: "http://203.0.113.9/" } });
    expect(redirectOf(res)).toEqual({ status, location: "http://203.0.113.9/" });
  });
});

describe("a captured redirect is a harness error, never a PASS", () => {
  test("applyRedirects sets harnessError and fails a [standing] check", () => {
    const notes: Record<string, unknown> = {};
    const checks: Check[] = [];
    applyRedirects([{ status: 302, location: "https://exfil.invalid/collect" }], notes, checks);
    expect(harnessErrorOf(notes)).toContain("HTTP 302");
    expect(harnessErrorOf(notes)).toContain("exfil.invalid");
    expect(standingBroken(checks)).toBe(true);
    expect(checks.every((c) => !c.ok)).toBe(true);
  });

  test("a row's own harness error is kept, the redirect appended", () => {
    const notes: Record<string, unknown> = { harnessError: "precondition" };
    applyRedirects([{ status: 307, location: null }], notes, []);
    expect(harnessErrorOf(notes)).toMatch(/^precondition; .*HTTP 307/);
  });

  test("no redirect leaves the run untouched", () => {
    const notes: Record<string, unknown> = {};
    const checks: Check[] = [];
    applyRedirects([], notes, checks);
    expect(notes).toEqual({});
    expect(checks).toEqual([]);
  });
});

// Review round 8 (GPT HIGH 1): a terminal Ctrl-C signals the whole FOREGROUND process group.
// A serve in the parent's group got SIGINT directly (the launcher forwards it, the product
// exits at once) while the parent was still waiting for the refresh gate: GPT measured
// `childExit: 130` with `parentKillCalled: false`. Real processes, all synthetic: a bun parent
// (its own group leader, as a shell makes a foreground job) runs the REAL `startServe` with
// a node "launcher" that prints the listening line and exits 130 on SIGINT, like the product.
describe("R8-1: a detached serve does not get the terminal's SIGINT", () => {
  const roots: string[] = [];
  const pids: number[] = [];
  afterEach(() => {
    for (const p of pids.splice(0)) {
      for (const target of [-p, p]) {
        try {
          process.kill(target, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    }
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  const here = import.meta.dir;
  /** The parent: startServe, then the safe-signal end that waits (the gate) before it kills. */
  const PARENT = `
import { appendFileSync } from "node:fs";
import { startServe } from ${JSON.stringify(join(here, "direct.ts"))};
import { installSafeSignals } from ${JSON.stringify(join(here, "v2e-real-lib.ts"))};
const [launcher, events, detached] = process.argv.slice(2);
const note = (e) => appendFileSync(events, JSON.stringify(e) + "\\n");
const s = await startServe({
  env: { PATH: process.env.PATH ?? "" },
  cwd: process.cwd(),
  slotsPath: "/dev/null",
  launcher,
  detached: detached === "1",
  readyTimeoutMs: 15000,
});
s.exited.then((code) => note({ event: "childExit", code }));
installSafeSignals(
  process,
  async () => {
    note({ event: "cleanupStarted" });
    await Bun.sleep(600); // waiting for the refresh gate
    note({ event: "parentKillCalled" });
    s.kill("SIGKILL");
    await s.exited;
  },
  (code) => process.exit(code),
  () => {}
);
note({ event: "ready", childPid: s.pid });
setInterval(() => {}, 1000);
`;
  /** The serve: exits 130 on SIGINT, as the launcher + product do. */
  const SERVE = `
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
console.log("listening on 127.0.0.1");
setInterval(() => {}, 1000);
`;

  async function ctrlC(detached: boolean) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "r8-pgrp-")));
    roots.push(dir);
    writeFileSync(join(dir, "parent.ts"), PARENT);
    writeFileSync(join(dir, "serve.cjs"), SERVE);
    const events = join(dir, "events.jsonl");
    writeFileSync(events, "");
    const read = () =>
      readFileSync(events, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { event: string; code?: number; childPid?: number });
    // Its own group, like a shell's foreground job: the test runner is not in it.
    const parent = Bun.spawn(
      ["bun", join(dir, "parent.ts"), join(dir, "serve.cjs"), events, detached ? "1" : "0"],
      { cwd: dir, detached: true, stdout: "ignore", stderr: "pipe", stdin: "ignore" }
    );
    pids.push(parent.pid);
    const deadline = Date.now() + 15_000;
    while (!read().some((e) => e.event === "ready")) {
      if (Date.now() > deadline || parent.exitCode !== null)
        throw new Error(`parent did not start: ${await new Response(parent.stderr).text()}`);
      await Bun.sleep(25);
    }
    const childPid = read().find((e) => e.event === "ready")?.childPid as number;
    pids.push(childPid);
    process.kill(-parent.pid, "SIGINT"); // the terminal's Ctrl-C: the whole foreground group
    await Bun.sleep(300); // the parent is still "waiting for the gate"
    const aliveWhileWaiting = !pidGone(childPid);
    const parentCode = await Promise.race([parent.exited, Bun.sleep(10_000).then(() => "hung")]);
    return {
      aliveWhileWaiting,
      parentCode,
      events: read().map((e) => e.event),
      all: read(),
      childPid,
    };
  }

  test("SIGINT to the parent's group: the serve lives until the parent's end kills it", async () => {
    const r = await ctrlC(true);
    expect(r.aliveWhileWaiting).toBe(true);
    expect(r.events).toEqual(["ready", "cleanupStarted", "parentKillCalled", "childExit"]);
    expect(r.all.find((e) => e.event === "childExit")?.code).not.toBe(130);
    expect(r.parentCode).toBe(130);
    expect(pidGone(r.childPid)).toBe(true);
  }, 30_000);

  test("control, same group (the old startServe): the serve exits 130 before the parent's kill", async () => {
    const r = await ctrlC(false);
    expect(r.aliveWhileWaiting).toBe(false);
    expect(r.all.find((e) => e.event === "childExit")?.code).toBe(130);
    expect(r.events.indexOf("childExit")).toBeLessThan(r.events.indexOf("parentKillCalled"));
  }, 30_000);

  test("killTree with group: a member re-parented to pid 1 is still killed", async () => {
    // sh starts a background sleep and exits: the sleep is no longer under the root's pid.
    const root = Bun.spawn(["sh", "-c", "sleep 30 >/dev/null 2>&1 & echo $!"], {
      detached: true,
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    pids.push(root.pid);
    const orphan = Number((await new Response(root.stdout).text()).trim());
    pids.push(orphan);
    await root.exited;
    expect(pidGone(orphan)).toBe(false);
    killTree(root.pid, "SIGKILL", { group: true });
    const deadline = Date.now() + 5_000;
    while (!pidGone(orphan) && Date.now() < deadline) await Bun.sleep(25);
    expect(pidGone(orphan)).toBe(true);
  }, 15_000);
});

describe("every parent-side fetch in the bench refuses redirects", () => {
  test("each fetch( call is parentFetch's own (redirect: manual) or a server handler", () => {
    const dir = new URL("./", import.meta.url);
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      const lines = readFileSync(new URL(f, dir), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/(?<![.\w])fetch\(/.test(line)) return;
        const handler = /^\s*(async\s+)?fetch\(req\)/.test(line);
        const manual = line.includes('redirect: "manual"');
        if (!handler && !manual) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
