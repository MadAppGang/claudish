/**
 * Teardown tests for `installShutdown`. Every one fires on a SPECIFIC regression in the
 * quit path, because that path is the one an app cannot recover from: a shutdown that
 * throws half-way leaves the terminal in raw mode inside the alternate screen, and the
 * reader's next prompt needs `reset` to come back.
 *
 * THE EXIT-PATH TESTS RUN IN SUBPROCESSES AND SEND REAL SIGNALS. They have to. This file
 * has been believed correct and been wrong three times, and each time the belief rested
 * on mocks: a stubbed `process.exit` proves the function was reached, not that the process
 * ended; a hand-called handler proves nothing about WHO the kernel delivers a signal to
 * when two owners registered for it. So the child sends itself a real signal, records
 * each step to a file with `appendFileSync` (synchronous, so `process.exit` cannot
 * truncate it, and immune to the renderer's stdout capture), and the parent asserts the
 * exact order and the exact exit code.
 *
 * Every child arms a REF'D 4s guard timer that exits 99. That is the negative control: a
 * teardown that never reaches `process.exit` reports 99 instead of drifting out with a
 * misleading 0, so a green result here cannot be vacuous.
 *
 * The in-process stubs are `Pick<CliRenderer, "destroy">` / `Pick<Root, "unmount">`, which
 * the signature admits directly — no `as unknown as` cast, and a cast is exactly what
 * stops anyone writing these tests. */
import { afterAll, describe, expect, test } from "bun:test";
// `appendFileSync` is NOT imported despite appearing below: its only occurrences are
// inside the STRING that builds the child process's source, so claudish's
// `noUnusedLocals` (which the skill's own tsconfig leaves off) correctly called the
// real import dead.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { OWNED_SIGNALS, installShutdown } from "./shutdown";

const noop = (): void => {};
const boom = (): never => {
  throw new Error("boom");
};

const SHUTDOWN = Bun.fileURLToPath(new URL("./shutdown.ts", import.meta.url));
/** `bun -e` resolves bare specifiers from cwd, and the real-renderer children import
 * `@opentui/core` — so every child runs with the skill root (the package boundary) as
 * its cwd. */
const SKILL_ROOT = Bun.fileURLToPath(new URL("../../", import.meta.url));
const WORK = mkdtempSync(join(tmpdir(), "opentui-shutdown-"));
afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
});

/** 128 + the OS's own signal number. Restated here from the policy, NOT read back from
 * the implementation, and resolved through `node:os` because the numbers are
 * platform-specific (SIGBUS is 10 on darwin, 7 on Linux). */
const expectedCode = (sig: NodeJS.Signals): number => {
  const signum = (constants.signals as unknown as Record<string, number | undefined>)[sig];
  if (typeof signum !== "number") throw new Error(`${sig} has no number on ${process.platform}`);
  return 128 + signum;
};

// ---------------------------------------------------------------------------
// Subprocess harness
// ---------------------------------------------------------------------------

/** How a teardown step fails. `plain` is an ordinary Error; `hostile` and `nasty` are the
 * throwables whose FORMATTING throws — the defect that skipped `destroy()` entirely. */
type Fault = "none" | "plain" | "hostile" | "nasty";

const THROWABLES = `
const plainBoom = () => { throw new Error("boom") }
// The reported repro: an object whose toString() throws. String(err) reaches
// Symbol.toPrimitive and the formatter itself throws.
const hostileBoom = () => {
  const o = {}
  Object.defineProperty(o, "toString", { value: () => { throw new Error("toString boom") } })
  Object.defineProperty(o, Symbol.toPrimitive, { value: () => { throw new Error("toPrimitive boom") } })
  throw o
}
// The other half of the same defect: an Error whose OWN stack/message getters throw, so
// the \`err instanceof Error\` branch is the one that explodes.
const nastyBoom = () => {
  const e = new Error("nasty")
  Object.defineProperty(e, "stack", { get() { throw new Error("stack getter boom") }, configurable: true })
  Object.defineProperty(e, "message", { get() { throw new Error("message getter boom") }, configurable: true })
  throw e
}
`;

const throwFor = (f: Fault): string =>
  f === "none"
    ? ""
    : f === "plain"
      ? "plainBoom()"
      : f === "hostile"
        ? "hostileBoom()"
        : "nastyBoom()";

interface ChildOpts {
  /** How the child ends: a real signal it sends itself, the returned quit function, that
   * function called concurrently, or an uncaught throw. */
  readonly via: NodeJS.Signals | "quit" | "quit-twice" | "crash";
  readonly unmount?: Fault;
  readonly destroy?: Fault;
  /** `undefined` = two-method stubs. Otherwise a REAL `createCliRenderer` with those
   * `exitSignals`, to measure who actually owns the signal. */
  readonly rendererExitSignals?: NodeJS.Signals[];
}

interface ChildResult {
  readonly code: number | null;
  readonly signal: string | null;
  /** Teardown steps in the order the child actually performed them. */
  readonly log: string[];
  readonly stderr: string;
}

async function runChild(opts: ChildOpts): Promise<ChildResult> {
  const logPath = join(WORK, `${crypto.randomUUID()}.log`);
  const trigger =
    opts.via === "quit"
      ? 'await quit(); rec("resolved"); clearTimeout(guard)'
      : opts.via === "quit-twice"
        ? 'await Promise.all([quit(), quit(), quit()]); await quit(); rec("resolved"); clearTimeout(guard)'
        : opts.via === "crash"
          ? 'setTimeout(() => { throw new Error("app boom") }, 1)'
          : `process.kill(process.pid, ${JSON.stringify(opts.via)})`;

  const renderer =
    opts.rendererExitSignals === undefined
      ? `const renderer = { destroy: () => { rec("destroy"); ${throwFor(opts.destroy ?? "none")} } }`
      : // An own `destroy` property SHADOWS the prototype method, so the renderer's own
        // internal `this.destroy()` — the one its exitHandler calls — is recorded too. That
        // is how a second owner becomes visible as a second "destroy" line.
        `import { createCliRenderer } from "@opentui/core"
       const renderer = await createCliRenderer({
         exitSignals: ${JSON.stringify(opts.rendererExitSignals)},
         exitOnCtrlC: false,
         screenMode: "main-screen",
       })
       const realDestroy = renderer.destroy.bind(renderer)
       renderer.destroy = () => { rec("destroy"); realDestroy() }`;

  const src = [
    'import { appendFileSync } from "node:fs"',
    `import { installShutdown } from ${JSON.stringify(SHUTDOWN)}`,
    `const rec = (s) => appendFileSync(${JSON.stringify(logPath)}, s + "\\n")`,
    THROWABLES,
    renderer,
    `const root = { unmount: () => { rec("unmount"); ${throwFor(opts.unmount ?? "none")} } }`,
    'const quit = installShutdown(renderer, root, [() => rec("disposer")])',
    // REF'D on purpose: it is the only thing keeping the loop alive on the quit path, so
    // a teardown that hangs reports 99 rather than looking like a clean exit.
    'const guard = setTimeout(() => { rec("GUARD-FIRED"); process.exit(99) }, 4000)',
    trigger,
  ].join("\n");

  const p = Bun.spawn(["bun", "-e", src], {
    env: { ...process.env },
    cwd: SKILL_ROOT,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const [, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  let log: string[] = [];
  try {
    log = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  } catch {
    /* child died before recording */
  }
  return { code: p.exitCode, signal: p.signalCode, log, stderr };
}

/** The contract, in one place: stop the app's own work, take the tree down, then restore
 * the terminal. */
const ORDER = ["disposer", "unmount", "destroy"];

// ---------------------------------------------------------------------------

describe("OWNED_SIGNALS", () => {
  // It used to be "OpenTUI's default set MINUS SIGINT", because it was handed to
  // `createCliRenderer` — which is what made the renderer a second teardown owner. The
  // renderer is now given `exitSignals: []`, so this module registers the complete set.
  test("is the complete default set, SIGINT included, because nothing else registers any", () => {
    expect(OWNED_SIGNALS).toEqual([
      "SIGINT",
      "SIGTERM",
      "SIGQUIT",
      "SIGABRT",
      "SIGHUP",
      "SIGBREAK",
      "SIGPIPE",
      "SIGBUS",
    ]);
    expect(OWNED_SIGNALS).toContain("SIGINT");
    expect(OWNED_SIGNALS).toContain("SIGBUS");
  });

  test("every signal it claims is one it can actually register and remove", () => {
    const before = OWNED_SIGNALS.map((s) => process.listenerCount(s));
    const shutdown = installShutdown({ destroy: noop }, { unmount: noop });
    // SIGBREAK is Windows-only: `process.on` accepts it on darwin, it just never fires.
    expect(OWNED_SIGNALS.map((s) => process.listenerCount(s))).toEqual(before.map((n) => n + 1));
    void shutdown();
    expect(OWNED_SIGNALS.map((s) => process.listenerCount(s))).toEqual(before);
  });
});

describe("exit-code policy — 128 + signum, never 0", () => {
  test("a signal never maps to a success code, and no two collide", () => {
    const codes = OWNED_SIGNALS.filter((s) => s !== "SIGBREAK").map(expectedCode);
    for (const c of codes) expect(c).toBeGreaterThan(128);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test("the numbers a shell would report", () => {
    if (process.platform !== "darwin") return; // signal numbers are platform-specific
    expect({
      SIGINT: expectedCode("SIGINT"),
      SIGQUIT: expectedCode("SIGQUIT"),
      SIGABRT: expectedCode("SIGABRT"),
      SIGHUP: expectedCode("SIGHUP"),
      SIGPIPE: expectedCode("SIGPIPE"),
      SIGBUS: expectedCode("SIGBUS"),
      SIGTERM: expectedCode("SIGTERM"),
    }).toEqual({
      SIGINT: 130,
      SIGQUIT: 131,
      SIGABRT: 134,
      SIGHUP: 129,
      SIGPIPE: 141,
      SIGBUS: 138,
      SIGTERM: 143,
    });
  });
});

describe("installShutdown — teardown always completes", () => {
  // THE DEFECT: `root.unmount()` and `renderer.destroy()` ran unguarded, so a throw from
  // the first skipped the second. Restoring the terminal is the step that must not be
  // skipped.
  test("a throwing unmount still reaches renderer.destroy(), and does not reject", async () => {
    let destroyed = false;
    const shutdown = installShutdown(
      {
        destroy: () => {
          destroyed = true;
        },
      },
      { unmount: boom }
    );
    await shutdown();
    expect(destroyed).toBe(true);
  });

  test("a throwing destroy does not reject either — the app can still await the end", async () => {
    let unmounted = false;
    const shutdown = installShutdown(
      { destroy: boom },
      {
        unmount: () => {
          unmounted = true;
        },
      }
    );
    await shutdown();
    expect(unmounted).toBe(true);
  });

  // THE FORMATTER DEFECT, in process. `String(err)` inside the catch reached a throwing
  // `Symbol.toPrimitive`, so the catch block itself threw and took the rest of teardown
  // with it.
  test("an unmount that throws an unprintable object still reaches destroy()", async () => {
    const hostile: Record<PropertyKey, unknown> = {};
    Object.defineProperty(hostile, "toString", {
      value: () => {
        throw new Error("toString boom");
      },
    });
    Object.defineProperty(hostile, Symbol.toPrimitive, {
      value: () => {
        throw new Error("toPrimitive boom");
      },
    });
    let destroyed = false;
    const shutdown = installShutdown(
      {
        destroy: () => {
          destroyed = true;
        },
      },
      {
        unmount: () => {
          throw hostile;
        },
      }
    );
    await shutdown();
    expect(destroyed).toBe(true);
  });

  test("an Error whose own stack getter throws does not stop teardown either", async () => {
    const nasty = new Error("nasty");
    Object.defineProperty(nasty, "stack", {
      get() {
        throw new Error("stack getter boom");
      },
      configurable: true,
    });
    Object.defineProperty(nasty, "message", {
      get() {
        throw new Error("message getter boom");
      },
      configurable: true,
    });
    let destroyed = false;
    const shutdown = installShutdown(
      {
        destroy: () => {
          destroyed = true;
        },
      },
      {
        unmount: () => {
          throw nasty;
        },
      }
    );
    await shutdown();
    expect(destroyed).toBe(true);
  });

  // DISPOSERS. `installShutdown(renderer, root)` took no extra teardown, while this file
  // forbids `process.exit()` everywhere else — so an app-owned `setInterval` had nowhere
  // to be cleared and kept the loop alive past the shutdown that was meant to end it.
  test("disposers run, once each, BEFORE the tree comes down", async () => {
    const seen: string[] = [];
    const shutdown = installShutdown(
      { destroy: () => seen.push("destroy") },
      { unmount: () => seen.push("unmount") },
      [() => seen.push("disposer-a"), () => seen.push("disposer-b")]
    );
    await shutdown();
    expect(seen).toEqual(["disposer-a", "disposer-b", "unmount", "destroy"]);
  });

  test("a throwing disposer stops neither the unmount nor the destroy", async () => {
    const seen: string[] = [];
    const shutdown = installShutdown(
      { destroy: () => seen.push("destroy") },
      { unmount: () => seen.push("unmount") },
      [boom, () => seen.push("disposer")]
    );
    await shutdown();
    expect(seen).toEqual(["disposer", "unmount", "destroy"]);
  });

  // The three steps are guarded INDEPENDENTLY and at the same level, so not even a
  // pathological disposers collection can skip the terminal restore.
  test("a disposers collection that throws on iteration still leaves the terminal restored", async () => {
    const exploding = new Proxy([] as Array<() => void>, {
      get() {
        throw new Error("array boom");
      },
    }) as ReadonlyArray<() => void>;
    const seen: string[] = [];
    const shutdown = installShutdown(
      { destroy: () => seen.push("destroy") },
      { unmount: () => seen.push("unmount") },
      exploding
    );
    await shutdown();
    expect(seen).toEqual(["unmount", "destroy"]);
  });

  test("an app-owned interval is actually cleared, so nothing survives teardown", async () => {
    let ticks = 0;
    const t = setInterval(() => {
      ticks++;
    }, 1);
    const shutdown = installShutdown({ destroy: noop }, { unmount: noop }, [
      () => clearInterval(t),
    ]);
    await shutdown();
    const after = ticks;
    await new Promise((r) => setTimeout(r, 20));
    expect(ticks).toBe(after);
  });

  test("teardown is idempotent however many times it is called", async () => {
    let n = 0;
    const shutdown = installShutdown(
      {
        destroy: () => {
          n += 1;
        },
      },
      { unmount: noop },
      [
        () => {
          n += 10;
        },
      ]
    );
    await Promise.all([shutdown(), shutdown(), shutdown()]);
    await shutdown();
    expect(n).toBe(11);
  });

  // Registration is not the same as listing: SIGBUS has to be a real listener, and every
  // listener has to come off again or a second renderer in the same process (a server
  // taking the stream again) inherits the first one's handlers.
  test("it registers SIGBUS, and removes every listener it added", async () => {
    const count = () => ({
      SIGINT: process.listenerCount("SIGINT"),
      SIGBUS: process.listenerCount("SIGBUS"),
      SIGTERM: process.listenerCount("SIGTERM"),
      uncaught: process.listenerCount("uncaughtException"),
      rejection: process.listenerCount("unhandledRejection"),
    });
    const before = count();
    const shutdown = installShutdown({ destroy: noop }, { unmount: noop });
    const during = count();
    expect(during.SIGBUS).toBe(before.SIGBUS + 1);
    expect(during.SIGINT).toBe(before.SIGINT + 1);
    expect(during.uncaught).toBe(before.uncaught + 1);
    await shutdown();
    expect(count()).toEqual(before);
  });
});

/**
 * REAL SIGNALS, REAL PROCESSES. Everything below spawns a child, sends it an actual
 * signal, and reads back the order it tore down in and the code it died with.
 */
describe("installShutdown — real signals, real processes", () => {
  // THE MASKING DEFECT: every signal used to exit 0. A SIGABRT or SIGBUS — a fatal
  // termination — reported success to whatever supervises the app.
  test.each([
    "SIGTERM",
    "SIGINT",
    "SIGQUIT",
    "SIGABRT",
    "SIGHUP",
    "SIGPIPE",
    "SIGBUS",
  ] as NodeJS.Signals[])(
    "%s tears down in order and exits 128+signum",
    async (sig) => {
      const r = await runChild({ via: sig });
      expect(r.log).toEqual(ORDER);
      expect(r.code).toBe(expectedCode(sig));
    },
    30_000
  );

  test("a normal quit tears down in the same order and the process ends 0", async () => {
    // No `process.exit` on this path: the returned function tears down and hands control
    // back, and the program ends by letting the loop drain. `resolved` proves the promise
    // settled — an unguarded step used to reject it instead.
    const r = await runChild({ via: "quit" });
    expect(r.log).toEqual([...ORDER, "resolved"]);
    expect(r.code).toBe(0);
  }, 30_000);

  test("a fatal signal is distinguishable from a clean quit and from every other signal", async () => {
    const [abrt, bus, term, quit] = await Promise.all([
      runChild({ via: "SIGABRT" }),
      runChild({ via: "SIGBUS" }),
      runChild({ via: "SIGTERM" }),
      runChild({ via: "quit" }),
    ]);
    const codes = [abrt.code, bus.code, term.code, quit.code];
    expect(new Set(codes).size).toBe(4);
    expect(quit.code).toBe(0);
    for (const c of [abrt.code, bus.code, term.code]) expect(c).not.toBe(0);
  }, 60_000);

  test("concurrent calls run every step exactly once and still end the process", async () => {
    const r = await runChild({ via: "quit-twice" });
    expect(r.log).toEqual([...ORDER, "resolved"]);
    expect(r.code).toBe(0);
  }, 30_000);
});

describe("installShutdown — a throwing step never strands the process", () => {
  // 99 is the guard timer, i.e. "never exited at all". These four are the exact shapes
  // that produced it.
  test("a throwing unmount still reaches destroy() and still exits", async () => {
    const r = await runChild({ via: "SIGTERM", unmount: "plain" });
    expect(r.log).toEqual(ORDER);
    expect(r.code).toBe(expectedCode("SIGTERM"));
  }, 30_000);

  // THE CASE THAT HUNG. `unmount` throws an object whose `toString()` also throws, so the
  // catch block's own `String(err)` threw: `renderer.destroy()` never ran, the exit never
  // ran, and `done` was already latched so no retry could clean up. Measured exit: 99.
  test("an unmount throwing an unprintable object still reaches destroy() and still exits", async () => {
    const r = await runChild({ via: "SIGTERM", unmount: "hostile" });
    expect(r.log).toEqual(ORDER);
    expect(r.code).toBe(expectedCode("SIGTERM"));
    expect(r.code).not.toBe(99); // 99 is the guard: the process hung
  }, 30_000);

  test("an unmount throwing an Error with a throwing stack getter behaves the same", async () => {
    const r = await runChild({ via: "SIGTERM", unmount: "nasty" });
    expect(r.log).toEqual(ORDER);
    expect(r.code).toBe(expectedCode("SIGTERM"));
  }, 30_000);

  test("a throwing destroy still exits — the terminal restore was attempted", async () => {
    const r = await runChild({ via: "SIGTERM", destroy: "plain" });
    expect(r.log).toEqual(ORDER);
    expect(r.code).toBe(expectedCode("SIGTERM"));
  }, 30_000);

  test("every step throwing unprintably still exits, and the failures are reported after destroy()", async () => {
    const r = await runChild({ via: "SIGTERM", unmount: "hostile", destroy: "nasty" });
    expect(r.log).toEqual(ORDER);
    expect(r.code).toBe(expectedCode("SIGTERM"));
    expect(r.stderr).toContain("shutdown: root.unmount");
    expect(r.stderr).toContain("shutdown: renderer.destroy");
    expect(r.stderr).toContain("<unprintable throwable>"); // formatted, not thrown
  }, 30_000);

  test("a throwing unmount does not strand the normal-quit path either", async () => {
    const r = await runChild({ via: "quit", unmount: "hostile", destroy: "plain" });
    expect(r.log).toEqual([...ORDER, "resolved"]);
    expect(r.code).toBe(0);
  }, 30_000);

  test("the crash path tears down first, then reports, then exits 1", async () => {
    const r = await runChild({ via: "crash", unmount: "hostile" });
    expect(r.log).toEqual(ORDER);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("app boom");
  }, 30_000);
});

/**
 * THE SECOND OWNER. These two run a REAL `createCliRenderer` from the pinned version and
 * send it a REAL SIGTERM. Nothing here is stubbed, because the whole question is which
 * handler the process calls first — and that is decided by registration order inside
 * OpenTUI, which no mock reproduces.
 */
describe("installShutdown — the renderer must not be a second teardown owner", () => {
  test("with exitSignals: [] there is exactly ONE destroy(), in the documented order", async () => {
    const r = await runChild({ via: "SIGTERM", rendererExitSignals: [] });
    expect(r.log).toEqual(ORDER);
    expect(r.log.filter((l) => l === "destroy")).toHaveLength(1);
    expect(r.code).toBe(expectedCode("SIGTERM"));
  }, 60_000);

  // THE REGRESSION WITNESS, and the negative control for the test above: hand the renderer
  // the same signal and it wins the race, because it was constructed first. The tree comes
  // down AFTER the terminal was restored, and destroy() runs twice. This is what the
  // bootstrap used to do, and it is why the bootstrap must now pass `[]`.
  test("handing the renderer the same signal reproduces the double-destroy in the wrong order", async () => {
    const r = await runChild({ via: "SIGTERM", rendererExitSignals: ["SIGTERM"] });
    expect(r.log).toEqual(["destroy", ...ORDER]);
    expect(r.log.filter((l) => l === "destroy")).toHaveLength(2);
    expect(r.code).toBe(expectedCode("SIGTERM"));
  }, 60_000);
});
