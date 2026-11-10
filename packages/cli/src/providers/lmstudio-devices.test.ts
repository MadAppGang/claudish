/**
 * Choosing the machine that runs an LM Studio model through LM Link.
 *
 * `lms` is replaced by an in-memory LM Studio that follows the behaviour
 * measured live: a REST load lands on the preferred device and takes the model
 * key as its identifier on every machine, `lms load` stays on this machine, and
 * `lms ps` reports `deviceIdentifier: null` for this machine.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LmsRunner,
  ensureLMStudioInstance,
  expandModelsToMachines,
  isLoopbackUrl,
  lookAtLock,
  readLMStudioMachines,
  splitLMStudioDevice,
  takeOverStaleLock,
} from "./lmstudio-devices.js";

const SELF = "self-id";
const M1 = "m1-id";
const BASE = "http://localhost:1234";

interface Row {
  identifier: string;
  modelKey: string;
  deviceIdentifier: string | null;
  contextLength: number;
}

let preferred: string;
let loaded: Row[];
let stored: { modelKey: string; deviceIdentifier: string | null; maxContextLength?: number }[];
let lmsLoads: string[][];
let lmsLoadFails: boolean;
let lastLoadBody: unknown;
let contextLengthAfterLoad: number;
let preferredWrites: string[];
let loadStatus: number;
/** Where the next load lands, when it must not follow the preferred device. */
let loadsOn: string | undefined;
let psFails: boolean;
/** An instance another client loads while claudish's load runs. */
let appearsDuringLoad: Row | undefined;
/** The instance name LM Studio gives the loaded copy, when it is not the model key. */
let loadedAs: string | undefined;
/** The body of a failed load. */
let loadErrorBody: string;
/** Runs while the load request is answered. */
let duringLoad: (() => void) | undefined;
let lockDir: string;

const run: LmsRunner = async (args) => {
  const command = args.join(" ");
  if (command === "link status --json") {
    return JSON.stringify({
      deviceIdentifier: SELF,
      preferredDeviceIdentifier: preferred,
      peers: [
        { deviceIdentifier: M1, deviceName: "m1", status: "connected" },
        { deviceIdentifier: "gone-id", deviceName: "gone", status: "disconnected" },
      ],
    });
  }
  if (command === "ls --json") return JSON.stringify(stored);
  if (command === "ps --json") return psFails ? null : JSON.stringify(loaded);
  if (args[0] === "load") {
    if (lmsLoadFails) return null;
    lmsLoads.push(args.slice(1));
    loaded.push({
      identifier: args[3] as string,
      modelKey: args[1] as string,
      deviceIdentifier: null,
      contextLength: 64_000,
    });
    return "";
  }
  if (args[0] === "link" && args[1] === "set-preferred-device") {
    preferred = args[2] as string;
    preferredWrites.push(preferred);
    return "";
  }
  throw new Error(`unexpected lms ${command}`);
};

const realFetch = globalThis.fetch;

beforeEach(() => {
  preferred = M1;
  loaded = [];
  stored = [
    { modelKey: "both", deviceIdentifier: null },
    { modelKey: "both", deviceIdentifier: M1 },
    { modelKey: "only-m1", deviceIdentifier: M1 },
    { modelKey: "only-here", deviceIdentifier: null },
    { modelKey: "on-gone", deviceIdentifier: "gone-id" },
  ];
  preferredWrites = [];
  lmsLoads = [];
  lmsLoadFails = false;
  lastLoadBody = undefined;
  contextLengthAfterLoad = 64_000;
  loadStatus = 200;
  loadsOn = undefined;
  psFails = false;
  appearsDuringLoad = undefined;
  loadedAs = undefined;
  loadErrorBody = "no memory";
  duringLoad = undefined;
  lockDir = mkdtempSync(join(tmpdir(), "claudish-lms-lock-"));
  globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
    if (loadStatus !== 200) return new Response(loadErrorBody, { status: loadStatus });
    lastLoadBody = JSON.parse(String(init?.body));
    const { model } = lastLoadBody as { model: string };
    const device = loadsOn ?? preferred;
    loaded.push({
      identifier: loadedAs ?? model,
      modelKey: model,
      deviceIdentifier: device === SELF ? null : device,
      contextLength: contextLengthAfterLoad,
    });
    if (appearsDuringLoad) loaded.push(appearsDuringLoad);
    duringLoad?.();
    return Response.json({ instance_id: loadedAs ?? model, status: "loaded" });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(lockDir, { recursive: true, force: true });
});

describe("splitLMStudioDevice", () => {
  test("splits the machine off the model id", () => {
    expect(splitLMStudioDevice("qwen/qwen3.8-27b~m1")).toEqual({
      model: "qwen/qwen3.8-27b",
      device: "m1",
    });
  });

  test("leaves an id with no suffix alone", () => {
    expect(splitLMStudioDevice("qwen/qwen3.8-27b")).toEqual({ model: "qwen/qwen3.8-27b" });
  });

  test("a leading ~ is a moving pointer", () => {
    expect(splitLMStudioDevice("~vendor/latest")).toEqual({ model: "~vendor/latest" });
  });
});

describe("isLoopbackUrl", () => {
  test.each([
    ["http://localhost:1234", true],
    ["http://127.0.0.1:1234", true],
    ["http://[::1]:1234", true],
    ["http://192.168.1.20:1234", false],
    ["not a url", false],
  ])("%s -> %p", (url, expected) => {
    expect(isLoopbackUrl(url)).toBe(expected);
  });
});

describe("rows per machine", () => {
  const models: {
    id: string;
    displayName?: string;
    contextWindow?: number;
    machine?: { name: string; modelId: string };
  }[] = [
    { id: "both", displayName: "Both Model", contextWindow: 213_176 },
    { id: "only-m1" },
    { id: "only-here" },
    { id: "on-gone" },
    { id: "not-in-lms" },
  ];

  async function expanded() {
    const machines = await readLMStudioMachines(run);
    if (!machines) throw new Error("expected machines");
    return expandModelsToMachines(models, machines);
  }

  test("a model on both machines gets one row each, this machine first", async () => {
    expect((await expanded()).map((m) => m.id)).toEqual([
      "both~local",
      "both~m1",
      "only-m1~m1",
      "only-here~local",
      "on-gone",
      "not-in-lms",
    ]);
  });

  test("the display name states the machine", async () => {
    const rows = await expanded();
    expect(rows.find((m) => m.id === "both~m1")?.displayName).toBe("Both Model (m1)");
    expect(rows.find((m) => m.id === "both~local")?.displayName).toBe("Both Model (this Mac)");
    expect(rows.find((m) => m.id === "only-m1~m1")?.displayName).toBe("only-m1 (m1)");
  });

  test("each row names its machine and the model without the suffix", async () => {
    const rows = await expanded();
    expect(rows.find((m) => m.id === "both~m1")?.machine).toEqual({ name: "m1", modelId: "both" });
    expect(rows.find((m) => m.id === "both~local")?.machine).toEqual({
      name: "this Mac",
      modelId: "both",
    });
    expect(rows.find((m) => m.id === "not-in-lms")?.machine).toBeUndefined();
  });

  test("a window comes from the instance on that machine only", async () => {
    loaded = [{ identifier: "both", modelKey: "both", deviceIdentifier: M1, contextLength: 8_192 }];

    const rows = await expanded();

    expect(rows.find((m) => m.id === "both~m1")?.contextWindow).toBe(8_192);
    expect(rows.find((m) => m.id === "both~local")?.contextWindow).toBeUndefined();
  });

  test("an unloaded copy whose maximum is below the default reports that maximum", async () => {
    stored = [
      { modelKey: "both", deviceIdentifier: M1, maxContextLength: 32_768 },
      { modelKey: "both", deviceIdentifier: null, maxContextLength: 262_144 },
    ];
    const machines = await readLMStudioMachines(run);
    if (!machines) throw new Error("expected machines");

    const models: { id: string; contextWindow?: number }[] = [{ id: "both" }];
    const rows = expandModelsToMachines(models, machines, 64_000);

    expect(rows.find((m) => m.id === "both~m1")?.contextWindow).toBe(32_768);
    expect(rows.find((m) => m.id === "both~local")?.contextWindow).toBeUndefined();
  });

  test("each row carries the most that copy can use", async () => {
    stored = [
      { modelKey: "both", deviceIdentifier: M1, maxContextLength: 32_768 },
      { modelKey: "both", deviceIdentifier: null, maxContextLength: 262_144 },
    ];
    const machines = await readLMStudioMachines(run);
    if (!machines) throw new Error("expected machines");
    const models: { id: string; maxContextWindow?: number }[] = [{ id: "both" }];

    const rows = expandModelsToMachines(models, machines, 64_000);

    expect(rows.find((m) => m.id === "both~m1")?.maxContextWindow).toBe(32_768);
    expect(rows.find((m) => m.id === "both~local")?.maxContextWindow).toBe(262_144);
  });

  test("a running copy can use only the size it was loaded with", async () => {
    stored = [{ modelKey: "both", deviceIdentifier: M1, maxContextLength: 262_144 }];
    loaded = [{ identifier: "both", modelKey: "both", deviceIdentifier: M1, contextLength: 8_192 }];
    const machines = await readLMStudioMachines(run);
    if (!machines) throw new Error("expected machines");
    const models: { id: string; maxContextWindow?: number }[] = [{ id: "both" }];

    const rows = expandModelsToMachines(models, machines, 64_000);

    expect(rows.find((m) => m.id === "both~m1")?.maxContextWindow).toBe(8_192);
  });

  test("no connected machine means no labels", async () => {
    const lonely: LmsRunner = async (args, timeout) => {
      if (args.join(" ") === "link status --json") {
        return JSON.stringify({ deviceIdentifier: SELF, peers: [] });
      }
      return run(args, timeout);
    };

    expect(await readLMStudioMachines(lonely)).toBeNull();
  });

  test("a missing lms means no labels", async () => {
    expect(await readLMStudioMachines(async () => null)).toBeNull();
  });
});

describe("ensureLMStudioInstance", () => {
  const ensure = (model: string, device: string, contextLength?: number) =>
    ensureLMStudioInstance({
      baseUrl: BASE,
      model,
      device,
      contextLength,
      run,
      lockPath: join(lockDir, "machine.lock"),
      lockPollMs: 10,
    });

  test("reuses an instance already running on the machine", async () => {
    loaded = [{ identifier: "both", modelKey: "both", deviceIdentifier: M1, contextLength: 9_000 }];

    expect(await ensure("both", "m1")).toEqual({ instanceId: "both", contextLength: 9_000 });
    expect(preferredWrites).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(lmsLoads).toEqual([]);
  });

  test("a load on this machine takes its own identifier and leaves the preference alone", async () => {
    const instance = await ensure("both", "local");

    expect(instance).toEqual({ instanceId: "both~local", contextLength: 64_000 });
    expect(loaded[0]?.deviceIdentifier).toBeNull();
    expect(preferredWrites).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("a copy on the other machine does not stop a load on this one", async () => {
    loaded = [{ identifier: "both", modelKey: "both", deviceIdentifier: M1, contextLength: 9_000 }];

    expect((await ensure("both", "local")).instanceId).toBe("both~local");
  });

  test("a load on a linked machine switches the preference and restores it", async () => {
    preferred = SELF;

    expect((await ensure("both", "m1")).instanceId).toBe("both");
    expect(loaded[0]?.deviceIdentifier).toBe(M1);
    expect(preferredWrites).toEqual([M1, SELF]);
    expect(preferred).toBe(SELF);
  });

  test("does not touch the setting when the machine is already preferred", async () => {
    await ensure("both", "m1");

    expect(loaded[0]?.deviceIdentifier).toBe(M1);
    expect(preferredWrites).toEqual([]);
  });

  test("the machine name matches in any case, and by device id", async () => {
    await ensure("both", "M1");
    loaded = [];
    await ensure("both", M1);

    expect(loaded[0]?.deviceIdentifier).toBe(M1);
  });

  test("the load asks for the default context length", async () => {
    await ensure("both", "m1", 64_000);
    await ensure("only-here", "local", 64_000);

    expect(lastLoadBody).toEqual({ model: "both", context_length: 64_000 });
    expect(lmsLoads[0]).toEqual([
      "only-here",
      "--identifier",
      "only-here~local",
      "-y",
      "-c",
      "64000",
    ]);
  });

  test("the context length stays within what that copy supports", async () => {
    stored = [{ modelKey: "both", deviceIdentifier: M1, maxContextLength: 8_192 }];

    await ensure("both", "m1", 64_000);

    expect(lastLoadBody).toEqual({ model: "both", context_length: 8_192 });
  });

  test("a running instance smaller than the request is refused with both sizes", async () => {
    loaded = [{ identifier: "both", modelKey: "both", deviceIdentifier: M1, contextLength: 8_192 }];

    await expect(ensure("both", "m1", 64_000)).rejects.toThrow(/8192.*64000/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("the refusal names the flag that accepts the running size", async () => {
    loaded = [{ identifier: "both", modelKey: "both", deviceIdentifier: M1, contextLength: 8_192 }];

    await expect(ensure("both", "m1", 64_000)).rejects.toThrow("--context-window 8192");
  });

  test("a running instance at the model's maximum is accepted", async () => {
    stored = [{ modelKey: "both", deviceIdentifier: M1, maxContextLength: 8_192 }];
    loaded = [{ identifier: "both", modelKey: "both", deviceIdentifier: M1, contextLength: 8_192 }];

    expect((await ensure("both", "m1", 64_000)).contextLength).toBe(8_192);
  });

  test("a running instance larger than the request is accepted", async () => {
    loaded = [
      { identifier: "both", modelKey: "both", deviceIdentifier: M1, contextLength: 128_000 },
    ];

    expect((await ensure("both", "m1", 64_000)).contextLength).toBe(128_000);
  });

  test("a load that comes up smaller than requested is refused", async () => {
    contextLengthAfterLoad = 8_192;

    await expect(ensure("both", "m1", 64_000)).rejects.toThrow(/8192.*64000/);
  });

  test("a failed load on a linked machine restores the preference and names the status", async () => {
    preferred = SELF;
    loadStatus = 500;

    await expect(ensure("both", "m1")).rejects.toThrow(/500 no memory/);
    expect(preferred).toBe(SELF);
  });

  test("a failed load on this machine is reported", async () => {
    lmsLoadFails = true;

    await expect(ensure("both", "local")).rejects.toThrow(/could not load both on this machine/);
  });

  test("a copy LM Studio names differently is found by the instance_id the load returned", async () => {
    preferred = SELF;
    loadedAs = "only-m1:2";

    const instance = await ensure("only-m1", "m1");

    expect(instance.instanceId).toBe("only-m1:2");
  });

  test("a load that lands on another machine is refused", async () => {
    loadsOn = SELF;

    await expect(ensure("both", "m1")).rejects.toThrow(/different machine/);
  });

  test("two instances sharing a name are refused before any request can pick the wrong one", async () => {
    loaded = [
      { identifier: "both", modelKey: "both", deviceIdentifier: null, contextLength: 1 },
      { identifier: "both", modelKey: "both", deviceIdentifier: M1, contextLength: 1 },
    ];

    await expect(ensure("both", "m1")).rejects.toThrow(/more than one machine/);
    await expect(ensure("both", "local")).rejects.toThrow(/more than one machine/);
  });

  test("a load that would create a second instance with that name is refused first", async () => {
    loaded = [{ identifier: "both", modelKey: "other", deviceIdentifier: null, contextLength: 1 }];

    await expect(ensure("both", "m1")).rejects.toThrow(/more than one machine/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("a machine that is not connected is refused and the connected ones are named", async () => {
    await expect(ensure("both", "gone")).rejects.toThrow(/Connected: local, m1/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("a server on another host is refused without running lms", async () => {
    const never = mock(async () => null);

    await expect(
      ensureLMStudioInstance({
        baseUrl: "http://192.168.1.20:1234",
        model: "both",
        device: "m1",
        run: never,
      })
    ).rejects.toThrow(/on another host/);
    expect(never).not.toHaveBeenCalled();
  });

  test("an unreadable instance list stops the load", async () => {
    psFails = true;

    await expect(ensure("both", "m1")).rejects.toThrow("lms ps --json");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(preferredWrites).toEqual([]);
  });

  test("a namesake that appears on another machine during the load is refused", async () => {
    appearsDuringLoad = {
      identifier: "both",
      modelKey: "both",
      deviceIdentifier: null,
      contextLength: 64_000,
    };

    await expect(ensure("both", "m1")).rejects.toThrow("more than one machine");
  });

  test("another process holding the machine lock makes the load wait", async () => {
    const lock = join(lockDir, "machine.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), String(process.pid));
    let settled = false;
    const pending = ensure("only-m1", "m1").then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    expect(preferredWrites).toEqual([]);

    rmSync(lock, { recursive: true, force: true });
    await pending;
    expect(settled).toBe(true);
  });

  test("a lock left by a process that has exited is taken over", async () => {
    const lock = join(lockDir, "machine.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "999999999");

    await ensure("only-m1", "m1");

    expect(preferredWrites).toEqual([]);
    expect(existsSync(lock)).toBe(false);
  });

  test("a takeover leaves alone a lock another waiter took after the look", () => {
    const lock = join(lockDir, "machine.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "999999999");
    const look = lookAtLock(lock);
    expect(look?.alive).toBe(false);

    // A second waiter takes the dead lock over and holds a new one.
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), String(process.pid));

    takeOverStaleLock(lock, look?.identity ?? "");

    expect(readFileSync(join(lock, "owner"), "utf-8")).toBe(String(process.pid));
    expect(readdirSync(lockDir)).toEqual(["machine.lock"]);
    expect(readdirSync(lock)).toEqual(["owner"]);
  });

  test("a waiter that finds another waiter's claim leaves the dead lock to it", () => {
    const lock = join(lockDir, "machine.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "999999999");
    const look = lookAtLock(lock);
    mkdirSync(join(lock, "takeover"));
    writeFileSync(join(lock, "takeover", "pid"), String(process.ppid));

    takeOverStaleLock(lock, look?.identity ?? "");

    expect(existsSync(join(lock, "owner"))).toBe(true);
  });

  test("a claim left by a waiter that exited is cleared, then the dead lock is taken over", () => {
    const lock = join(lockDir, "machine.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "999999999");
    const claim = join(lock, "takeover");
    mkdirSync(claim);
    writeFileSync(join(claim, "pid"), "999999999");

    takeOverStaleLock(lock, lookAtLock(lock)?.identity ?? "");
    expect(existsSync(claim)).toBe(false);
    takeOverStaleLock(lock, lookAtLock(lock)?.identity ?? "");

    expect(existsSync(lock)).toBe(false);
  });

  test("a takeover never removes the claim of a waiter that followed an exited one", () => {
    const lock = join(lockDir, "machine.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "999999999");
    const claim = join(lock, "takeover");
    mkdirSync(claim);
    writeFileSync(join(claim, "pid"), "999999999");
    writeFileSync(join(claim, "after-999999999"), String(process.ppid));

    expect(takeOverStaleLock(lock, lookAtLock(lock)?.identity ?? "")).toBe(false);

    expect(readFileSync(join(claim, "after-999999999"), "utf-8")).toBe(String(process.ppid));
    expect(existsSync(join(lock, "owner"))).toBe(true);
  });

  test("a takeover of a lock another waiter already removed does not make it again", () => {
    const lock = join(lockDir, "machine.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "999999999");
    const look = lookAtLock(lock);
    rmSync(lock, { recursive: true, force: true });

    expect(takeOverStaleLock(lock, look?.identity ?? "")).toBe(false);
    expect(existsSync(lock)).toBe(false);
  });

  test("an empty claim directory is no claim: the dead lock is taken over", () => {
    const lock = join(lockDir, "machine.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "999999999");
    mkdirSync(join(lock, "takeover"));

    expect(takeOverStaleLock(lock, lookAtLock(lock)?.identity ?? "")).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  test("an old claim of a waiter that still runs is left alone, however long it has paused", () => {
    const lock = join(lockDir, "machine.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "999999999");
    const claim = join(lock, "takeover");
    mkdirSync(claim);
    writeFileSync(join(claim, "pid"), String(process.ppid));
    const old = new Date(Date.now() - 120_000);
    utimesSync(claim, old, old);

    takeOverStaleLock(lock, lookAtLock(lock)?.identity ?? "");

    expect(existsSync(claim)).toBe(true);
    expect(existsSync(join(lock, "owner"))).toBe(true);
  });

  test("an empty owner file reads as a lock taken an instant ago", () => {
    const lock = join(lockDir, "machine.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "");

    expect(lookAtLock(lock)?.alive).toBe(true);
  });

  test("a copy a takeover left aside is removed once its process has exited", async () => {
    preferred = SELF;
    const exited = join(lockDir, "machine.lock.dead.999999999.abc");
    mkdirSync(join(exited, "takeover"), { recursive: true });
    writeFileSync(join(exited, "owner"), "999999999");
    const running = join(lockDir, `machine.lock.dead.${process.ppid}.def`);
    mkdirSync(running);

    await ensure("only-m1", "m1");

    expect(existsSync(exited)).toBe(false);
    expect(existsSync(running)).toBe(true);
  });

  test("a release leaves alone a lock that is no longer its own", async () => {
    preferred = SELF;
    const lock = join(lockDir, "machine.lock");
    duringLoad = () => {
      // Another process judged this one dead and holds a lock of its own now.
      rmSync(lock, { recursive: true, force: true });
      mkdirSync(lock);
      writeFileSync(join(lock, "owner"), String(process.ppid));
    };

    await ensure("only-m1", "m1");

    expect(readFileSync(join(lock, "owner"), "utf-8")).toBe(String(process.ppid));
  });

  test("a takeover removes the dead lock it looked at", () => {
    const lock = join(lockDir, "machine.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "999999999");

    takeOverStaleLock(lock, lookAtLock(lock)?.identity ?? "");

    expect(readdirSync(lockDir)).toEqual([]);
  });

  test("a failed load's error never quotes the key the load was signed with", async () => {
    preferred = SELF;
    loadStatus = 401;
    loadErrorBody = '{"error":"invalid key Bearer lms-secret-0123456789"}';

    const error = await ensureLMStudioInstance({
      baseUrl: BASE,
      model: "only-m1",
      device: "m1",
      headers: { Authorization: "Bearer lms-secret-0123456789" },
      run,
      lockPath: join(lockDir, "machine.lock"),
      lockPollMs: 10,
    }).catch((e: unknown) => e as Error);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("401");
    expect((error as Error).message).not.toContain("lms-secret-0123456789");
  });

  test("the lock is released after a failed load", async () => {
    preferred = SELF;
    loadStatus = 500;

    await expect(ensure("only-m1", "m1")).rejects.toThrow("500");

    expect(existsSync(join(lockDir, "machine.lock"))).toBe(false);
  });

  test("concurrent loads change the preferred device one at a time", async () => {
    preferred = SELF;

    await Promise.all([ensure("only-m1", "m1"), ensure("both", "m1")]);

    expect(preferredWrites).toEqual([M1, SELF, M1, SELF]);
  });
});
