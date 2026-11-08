/**
 * v2e-real-lib.ts with a fake item store and a fake gate: no keychain, no lock file, no network.
 * Review round 6 findings B1-B4.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  FINISHING_SAFELY,
  type Gate,
  type ItemStore,
  NOT_STRICT_EVIDENCE,
  RUN_ENDING,
  type RealRecord,
  type RealVerdict,
  type ShutdownDeps,
  type ShutdownResult,
  classifyVerdict,
  forceExpiry,
  installSafeSignals,
  needsReauthOf,
  restoreIfStillForced,
  restoreUnderGate,
  shutdownUnderGate,
} from "./v2e-real-lib.ts";

const GEN1: RealRecord = {
  accessToken: "access-A",
  refreshToken: "refresh-A",
  generation: 1,
  fingerprint: "fp-1",
  expiresAt: 2_000_000_000_000,
  extraField: "kept",
};
const GEN2: RealRecord = {
  accessToken: "at-rotated-1",
  refreshToken: "rt-rotated-1",
  generation: 2,
  fingerprint: "fp-2",
  expiresAt: 2_000_000_100_000,
};

/** One item in memory; `onRead` runs before each read (to simulate another process). */
function fakeStore(initial: RealRecord | null) {
  const s = {
    value: initial ? structuredClone(initial) : null,
    writes: [] as RealRecord[],
    onRead: undefined as undefined | ((n: number) => void),
    reads: 0,
  };
  const store: ItemStore = {
    async read() {
      s.onRead?.(++s.reads);
      return s.value ? structuredClone(s.value) : null;
    },
    async write(r) {
      s.writes.push(structuredClone(r));
      s.value = structuredClone(r);
    },
  };
  return { s, store };
}

/** A gate that logs enter/exit; `held` decides the fence answer. */
function fakeGate(log: string[], held = () => true): Gate {
  return async (work) => {
    log.push("gate acquired");
    try {
      return await work(held);
    } finally {
      log.push("gate released");
    }
  };
}

describe("B1: forcing expiry takes the product's refresh gate and reads after acquiring it", () => {
  test("the write happens inside the gate and keeps every other field", async () => {
    const { s, store } = fakeStore(GEN1);
    const log: string[] = [];
    const gate: Gate = async (work) => {
      log.push("gate acquired");
      const r = await work(() => {
        log.push("fence checked");
        return true;
      });
      log.push("gate released");
      return r;
    };
    const { before, forced } = await forceExpiry(store, gate);
    expect(before).toEqual(GEN1);
    expect(forced).toEqual({ ...GEN1, expiresAt: 0 });
    expect(s.writes).toEqual([{ ...GEN1, expiresAt: 0 }]);
    expect(log).toEqual(["gate acquired", "fence checked", "gate released"]);
  });

  test("a rotation that lands while the script waits for the gate is the base, never overwritten", async () => {
    // GPT: another claudish process rotates between the inspection and the mutation.
    const { s, store } = fakeStore(GEN1);
    const gate: Gate = async (work) => {
      s.value = structuredClone(GEN2); // the other process held the gate and rotated
      return work(() => true);
    };
    const { before } = await forceExpiry(store, gate);
    expect(before.generation).toBe(2);
    expect(s.writes).toEqual([{ ...GEN2, expiresAt: 0 }]);
    expect(s.writes.some((w) => w.refreshToken === "refresh-A")).toBe(false);
  });

  test("an open journal (a refresh in progress or interrupted) refuses and writes nothing", async () => {
    const { s, store } = fakeStore({ ...GEN1, journal: { state: "refreshing" } });
    await expect(forceExpiry(store, fakeGate([]))).rejects.toThrow(/journal is open/);
    expect(s.writes).toEqual([]);
  });

  test("a lost gate (the fence says no) writes nothing", async () => {
    const { s, store } = fakeStore(GEN1);
    await expect(
      forceExpiry(
        store,
        fakeGate([], () => false)
      )
    ).rejects.toThrow(/gate was lost/);
    expect(s.writes).toEqual([]);
  });

  test("an absent item refuses", async () => {
    const { store } = fakeStore(null);
    await expect(forceExpiry(store, fakeGate([]))).rejects.toThrow(/absent/);
  });
});

describe("B2: restore only what this run forced, under the same gate", () => {
  test("still forced (same generation and fingerprint, expiresAt 0): the original expiry is back", async () => {
    const { s, store } = fakeStore({ ...GEN1, expiresAt: 0 });
    const log: string[] = [];
    expect(await restoreIfStillForced(store, fakeGate(log), GEN1)).toBe("restored");
    expect(s.value).toEqual(GEN1);
    expect(log).toEqual(["gate acquired", "gate released"]);
  });

  test("a newer generation is never written over", async () => {
    const { s, store } = fakeStore(GEN2);
    expect(await restoreIfStillForced(store, fakeGate([]), GEN1)).toBe("newer-generation");
    expect(s.writes).toEqual([]);
  });

  test("same generation but new material, an open journal, or an expiry already changed: left alone", async () => {
    for (const [cur, want] of [
      [{ ...GEN1, expiresAt: 0, fingerprint: "fp-x" }, "material-changed"],
      [{ ...GEN1, expiresAt: 0, journal: { state: "refreshing" } }, "journal-open"],
      [{ ...GEN1, expiresAt: 5 }, "not-forced"],
    ] as const) {
      const { s, store } = fakeStore(cur);
      expect(await restoreIfStillForced(store, fakeGate([]), GEN1)).toBe(want);
      expect(s.writes).toEqual([]);
    }
  });

  test("an absent item is named, not recreated", async () => {
    const { s, store } = fakeStore(null);
    expect(await restoreIfStillForced(store, fakeGate([]), GEN1)).toBe("absent");
    expect(s.writes).toEqual([]);
  });
});

describe("R7-1: the rollback snapshot is kept BEFORE the expiry write", () => {
  test("write commits, then throws: the original expiresAt is restored under the same gate", async () => {
    // The product's writeKeychainItem reads back itself: a write can land and still throw.
    const { s, store } = fakeStore(GEN1);
    const inner = store.write;
    let writes = 0;
    store.write = async (r) => {
      await inner(r);
      if (++writes === 1) throw new Error("Keychain write did not round-trip");
    };
    const log: string[] = [];
    let snapshot = null as RealRecord | null;
    const err = await forceExpiry(store, fakeGate(log), (b) => {
      snapshot = b;
    }).catch((e: Error) => e);
    expect(s.value?.expiresAt).toBe(GEN1.expiresAt as number);
    expect(s.value).toEqual(GEN1);
    expect(snapshot).toEqual(GEN1);
    expect(String(err)).toMatch(/round-trip.*in-place restore: restored/);
    // Both writes (the forced one and the restore) happened inside ONE gate hold.
    expect(log).toEqual(["gate acquired", "gate released"]);
  });

  test("verification read throws: the original expiresAt is restored", async () => {
    const { s, store } = fakeStore(GEN1);
    s.onRead = (n) => {
      if (n === 2) throw new Error("security: verification read failed");
    };
    let snapshot = null as RealRecord | null;
    const err = await forceExpiry(store, fakeGate([]), (b) => {
      snapshot = b;
    }).catch((e: Error) => e);
    expect(s.value?.expiresAt).toBe(GEN1.expiresAt as number);
    expect(snapshot).toEqual(GEN1);
    expect(String(err)).toMatch(/verification read failed.*in-place restore: restored/);
  });

  test("the in-place restore fails too: the snapshot is still with the caller, and the end restores", async () => {
    const { s, store } = fakeStore(GEN1);
    s.onRead = (n) => {
      if (n === 2 || n === 3) throw new Error("security: read failed");
    };
    let snapshot = null as RealRecord | null;
    const err = await forceExpiry(store, fakeGate([]), (b) => {
      snapshot = b;
    }).catch((e: Error) => e);
    expect(s.value?.expiresAt).toBe(0);
    expect(snapshot).not.toBeNull();
    expect(String(err)).toMatch(/in-place restore: restore FAILED/);
    expect(await restoreIfStillForced(store, fakeGate([]), snapshot as unknown as RealRecord)).toBe(
      "restored"
    );
    expect(s.value).toEqual(GEN1);
  });

  test("a write that did NOT commit is not written again", async () => {
    const { s, store } = fakeStore(GEN1);
    store.write = async () => {
      throw new Error("security: write refused");
    };
    await expect(forceExpiry(store, fakeGate([]))).rejects.toThrow(/in-place restore: not-forced/);
    expect(s.value).toEqual(GEN1);
  });

  test("R8-2: the end began while forceExpiry waited for the gate: nothing written", async () => {
    const { s, store } = fakeStore(GEN1);
    let snapshot = null as RealRecord | null;
    await expect(
      forceExpiry(
        store,
        fakeGate([]),
        (b) => {
          snapshot = b;
        },
        () => true
      )
    ).rejects.toThrow(RUN_ENDING);
    expect(s.writes).toEqual([]);
    expect(snapshot).toBeNull();
  });

  test("R8-2: the end began during forceExpiry's read: nothing written", async () => {
    const { s, store } = fakeStore(GEN1);
    let stopping = false;
    s.onRead = () => {
      stopping = true;
    };
    await expect(
      forceExpiry(
        store,
        fakeGate([]),
        () => {},
        () => stopping
      )
    ).rejects.toThrow(RUN_ENDING);
    expect(s.writes).toEqual([]);
  });

  test("a forced record whose other fields changed is left alone", async () => {
    const { s, store } = fakeStore({ ...GEN1, expiresAt: 0, extraField: "changed" });
    expect(await restoreIfStillForced(store, fakeGate([]), GEN1)).toBe("material-changed");
    expect(s.writes).toEqual([]);
  });
});

/**
 * The product's refresh gate as an in-memory mutex: FIFO, an optional bounded acquire, and a
 * fence that answers whether THIS hold is the current one.
 */
function fakeLock() {
  let tail: Promise<void> = Promise.resolve();
  let holder: symbol | null = null;
  const gate =
    (timeoutMs?: number): Gate =>
    async (work) => {
      const me = Symbol("hold");
      let release!: () => void;
      const mine = new Promise<void>((r) => {
        release = r;
      });
      const prev = tail;
      tail = prev.then(() => mine);
      if (timeoutMs !== undefined) {
        const got = await Promise.race([
          prev.then(() => true),
          Bun.sleep(timeoutMs).then(() => false),
        ]);
        if (!got) {
          void prev.then(release);
          throw new Error(`could not acquire the gate: timeout after ${timeoutMs} ms`);
        }
      } else await prev;
      holder = me;
      try {
        return await work(() => holder === me);
      } finally {
        holder = null;
        release();
      }
    };
  return { gate };
}

/**
 * One serve doing the product's rotation under the gate: journal, exchange (OpenAI accepts and
 * revokes the old refresh token), PAUSE, persist. A SIGKILL during the pause loses the rotation.
 */
function fakeServe(lock: ReturnType<typeof fakeLock>, store: ItemStore, events: string[]) {
  let killed = false;
  let resumePersist!: () => void;
  const persistAllowed = new Promise<void>((r) => {
    resumePersist = r;
  });
  let onKill!: () => void;
  const killedP = new Promise<void>((r) => {
    onKill = r;
  });
  const refresh = lock.gate()(async () => {
    const rec = await store.read();
    await store.write({ ...rec, journal: { state: "refreshing" } });
    events.push("exchange accepted");
    await Promise.race([persistAllowed, killedP]);
    if (killed) {
      events.push("rotation lost (killed before persist)");
      return;
    }
    await store.write({ ...GEN2, journal: null });
    events.push("persisted");
  });
  return {
    refresh,
    resumePersist,
    kill: () => {
      killed = true;
      events.push("kill");
      onKill();
    },
  };
}

async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(2);
  }
}

describe("R7-2: an interrupted run kills the serves only with the refresh gate held", () => {
  const deps = (
    lock: ReturnType<typeof fakeLock>,
    store: ItemStore,
    serve: ReturnType<typeof fakeServe>,
    flags: { stopped: boolean; warned: string[] }
  ): ShutdownDeps => ({
    stopIssuing: () => {
      flags.stopped = true;
    },
    gateWithin: (ms) => lock.gate(ms),
    gate: lock.gate(),
    killServes: async () => serve.kill(),
    restore: (holdsLock) => restoreUnderGate(store, holdsLock, GEN1),
    warn: (line) => flags.warned.push(line),
  });

  test("SIGINT between exchange acceptance and persist: the kill waits for the gate", async () => {
    const { s, store } = fakeStore({ ...GEN1, expiresAt: 0 });
    const lock = fakeLock();
    const events: string[] = [];
    const serve = fakeServe(lock, store, events);
    const flags = { stopped: false, warned: [] as string[] };
    const sig = new EventEmitter();
    const said: string[] = [];
    let exitCode: number | null = null;
    let result: ShutdownResult | undefined;
    installSafeSignals(
      sig,
      async () => {
        result = await shutdownUnderGate(deps(lock, store, serve, flags), "acct", 5_000);
      },
      (code) => {
        exitCode = code;
      },
      (line) => said.push(line)
    );

    await until(() => events.includes("exchange accepted"));
    sig.emit("SIGINT");
    await Bun.sleep(30);
    expect(flags.stopped).toBe(true); // no new request once the end began
    expect(events).not.toContain("kill"); // the serve holds the gate mid-rotation
    // A second Ctrl-C does not skip the safe finish.
    sig.emit("SIGINT");
    expect(said).toEqual([FINISHING_SAFELY]);
    expect(events).not.toContain("kill");

    serve.resumePersist();
    await serve.refresh;
    await until(() => exitCode !== null);
    expect(events).toEqual(["exchange accepted", "persisted", "kill"]);
    expect(s.value?.generation).toBe(2); // the rotation OpenAI accepted is persisted
    expect(result).toEqual({ killedUnderGate: true, restore: "newer-generation" });
    expect(exitCode as unknown as number).toBe(130);
    expect(flags.warned).toEqual([]);
  });

  test("gate not free within the bound: kills anyway and says so, never silently", async () => {
    const { store } = fakeStore({ ...GEN1, expiresAt: 0 });
    const lock = fakeLock();
    const events: string[] = [];
    const serve = fakeServe(lock, store, events); // never resumes its persist
    const flags = { stopped: false, warned: [] as string[] };
    await until(() => events.includes("exchange accepted"));
    const result = await shutdownUnderGate(deps(lock, store, serve, flags), "acct", 50);
    expect(events).toEqual(["exchange accepted", "kill", "rotation lost (killed before persist)"]);
    expect(flags.warned).toHaveLength(1);
    expect(flags.warned[0]).toContain("not free within");
    expect(flags.warned[0]).toContain("may have been interrupted");
    expect(flags.warned[0]).toContain("`claudish` login");
    // The killed holder's gate is then taken for the restore, which leaves the open journal.
    expect(result).toEqual({ killedUnderGate: false, restore: "journal-open" });
  });

  test("no refresh in flight: kill and restore inside one gate hold", async () => {
    const { s, store } = fakeStore({ ...GEN1, expiresAt: 0 });
    const order: string[] = [];
    const gate: Gate = async (work) => {
      order.push("gate acquired");
      try {
        return await work(() => true);
      } finally {
        order.push("gate released");
      }
    };
    const result = await shutdownUnderGate(
      {
        stopIssuing: () => void order.push("stop issuing"),
        gateWithin: () => gate,
        gate,
        killServes: async () => void order.push("kill"),
        restore: (h) => restoreUnderGate(store, h, GEN1),
        warn: () => void order.push("warn"),
      },
      "acct"
    );
    expect(order).toEqual(["stop issuing", "gate acquired", "kill", "gate released"]);
    expect(result).toEqual({ killedUnderGate: true, restore: "restored" });
    expect(s.value).toEqual(GEN1);
  });
});

describe("B3: needsReauth is read from providers['openai-codex'].accounts[id]", () => {
  const state = (accounts: Record<string, unknown>) => ({
    version: 1,
    providers: { "openai-codex": { accounts } },
  });
  test("the account's own mark", () => {
    const mark = { failedGeneration: 2 };
    expect(needsReauthOf(state({ dc53ea1b2616: { needsReauth: mark } }), "dc53ea1b2616")).toEqual(
      mark
    );
  });
  test("a mark on another account does not count", () => {
    expect(
      needsReauthOf(state({ bbbbbbbbbbbb: { needsReauth: { x: 1 } } }), "dc53ea1b2616")
    ).toBeNull();
  });
  test("the old wrong paths (top-level accounts, top-level id) are not read", () => {
    const wrong = {
      accounts: { dc53ea1b2616: { needsReauth: 1 } },
      dc53ea1b2616: { needsReauth: 1 },
    };
    expect(needsReauthOf(wrong, "dc53ea1b2616")).toBeNull();
  });
});

describe("B4: any false verdict field fails; strict needs the memo window", () => {
  const all: RealVerdict = {
    bothOk: true,
    generationAdvancedByOne: true,
    fingerprintChanged: true,
    expiryInFuture: true,
    allOnThisAccount: true,
    noReauth: true,
    memoWindowMet: true,
  };
  test("all true: exit 0, observational and strict", () => {
    expect(classifyVerdict(all)).toMatchObject({ exitCode: 0, observational: true, strict: true });
  });
  test("memo window missed (run 1 took 12.3 s): exit 1, observational only, NOT EVIDENCE printed", () => {
    const c = classifyVerdict({ ...all, memoWindowMet: false });
    expect(c).toMatchObject({ exitCode: 1, observational: true, strict: false });
    expect(c.lines.join("\n")).toContain(NOT_STRICT_EVIDENCE);
  });
  test.each(Object.keys(all).filter((k) => k !== "memoWindowMet"))("%s false: exit 1", (k) => {
    const c = classifyVerdict({ ...all, [k]: false });
    expect(c.exitCode).toBe(1);
    expect(c.observational).toBe(false);
    expect(c.lines[0]).toContain(k);
  });
});
