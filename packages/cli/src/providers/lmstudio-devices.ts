/**
 * Which machine runs an LM Studio model when LM Link connects several.
 *
 * LM Studio's HTTP lists have no device field, and a chat or load request cannot
 * name a device. The `lms` command-line tool knows both sides: `lms ls --json`
 * says where each copy of a model is stored, and `lms ps --json` where each
 * loaded instance runs. A REST load follows the Mac-wide preferred device when
 * several machines hold the model, and `lms load` stays on this machine while a
 * local copy exists. Those two are the only ways to place a model.
 *
 * `lms` describes the machine it runs on, so none of this applies to an
 * LM Studio server on another host.
 *
 * A model id carries its machine as a suffix: `qwen/qwen3.8-27b~m1`. The suffix
 * is claudish's; LM Studio never sees it.
 */

import { execFile } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { credentialValuesFromRequest } from "../handlers/shared/call-context.js";
import { redactExactValues } from "../redact.js";

export const LMSTUDIO_DEVICE_SEPARATOR = "~";
/** The machine suffix for the machine claudish runs on. */
export const LMSTUDIO_THIS_MACHINE = "local";

const LIST_TIMEOUT_MS = 5_000;
const LOAD_TIMEOUT_MS = 600_000;

/** Runs `lms` with `args`. Answers its stdout, or null when it could not run or exited non-zero. */
export type LmsRunner = (args: string[], timeoutMs: number) => Promise<string | null>;

function execLms(binary: string, args: string[], timeoutMs: number) {
  return new Promise<{ stdout: string | null; missing: boolean }>((resolve) => {
    execFile(binary, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolve({
        stdout: error ? null : stdout,
        missing: (error as NodeJS.ErrnoException | null)?.code === "ENOENT",
      });
    });
  });
}

/** `CLAUDISH_LMS_BIN`, else `lms` on the PATH, else LM Studio's own install path. */
export const runLms: LmsRunner = async (args, timeoutMs) => {
  const configured = process.env.CLAUDISH_LMS_BIN;
  if (configured) return (await execLms(configured, args, timeoutMs)).stdout;
  const onPath = await execLms("lms", args, timeoutMs);
  if (!onPath.missing) return onPath.stdout;
  return (await execLms(join(homedir(), ".lmstudio", "bin", "lms"), args, timeoutMs)).stdout;
};

/** Splits a machine suffix off a model id. A leading `~` is a moving pointer, not a suffix. */
export function splitLMStudioDevice(modelId: string): { model: string; device?: string } {
  const at = modelId.lastIndexOf(LMSTUDIO_DEVICE_SEPARATOR);
  if (at <= 0 || at === modelId.length - 1) return { model: modelId };
  return { model: modelId.slice(0, at), device: modelId.slice(at + 1) };
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

interface LinkPeer {
  id: string;
  name: string;
}

interface LinkStatus {
  self: string;
  preferred?: string;
  peers: LinkPeer[];
}

interface StoredCopy {
  modelKey: string;
  deviceIdentifier: string | null;
  maxContextLength?: number;
}

interface LoadedRow {
  identifier: string;
  modelKey?: string;
  deviceIdentifier: string | null;
  contextLength?: number;
}

function parseJson<T>(text: string | null): T | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function readLink(run: LmsRunner): Promise<LinkStatus | null> {
  const raw = parseJson<{
    deviceIdentifier?: string;
    preferredDeviceIdentifier?: string;
    peers?: { deviceIdentifier?: string; deviceName?: string; status?: string }[];
  }>(await run(["link", "status", "--json"], LIST_TIMEOUT_MS));
  if (!raw?.deviceIdentifier) return null;
  const peers: LinkPeer[] = [];
  for (const peer of raw.peers ?? []) {
    if (peer.status === "connected" && peer.deviceIdentifier && peer.deviceName) {
      peers.push({ id: peer.deviceIdentifier, name: peer.deviceName });
    }
  }
  return { self: raw.deviceIdentifier, preferred: raw.preferredDeviceIdentifier, peers };
}

async function readLoaded(run: LmsRunner): Promise<LoadedRow[] | null> {
  return parseJson<LoadedRow[]>(await run(["ps", "--json"], LIST_TIMEOUT_MS));
}

/** A device name fit for a model id: `:` would read as concurrency, `~` as another suffix. */
function machineLabel(peer: LinkPeer): string {
  return /^[\w. -]+$/.test(peer.name) ? peer.name : peer.id;
}

export interface LMStudioMachines {
  /** Machine labels per model key, this machine first. */
  labelsByModel: Map<string, string[]>;
  /** `<model key>~<label>` to the window of its loaded instance. */
  loadedWindows: Map<string, number>;
  /** `<model key>~<label>` to the most that copy supports. */
  maxWindows: Map<string, number>;
}

/** What LM Link offers, or null when `lms` is absent or no other machine is connected. */
export async function readLMStudioMachines(
  run: LmsRunner = runLms
): Promise<LMStudioMachines | null> {
  const [link, stored, loaded] = await Promise.all([
    readLink(run),
    run(["ls", "--json"], LIST_TIMEOUT_MS).then((text) => parseJson<StoredCopy[]>(text)),
    readLoaded(run),
  ]);
  if (!link || link.peers.length === 0 || !Array.isArray(stored)) return null;

  const labelOf = (device: string | null): string | undefined => {
    if (device === null || device === link.self) return LMSTUDIO_THIS_MACHINE;
    const peer = link.peers.find((p) => p.id === device);
    return peer ? machineLabel(peer) : undefined;
  };

  const labelsByModel = new Map<string, string[]>();
  const maxWindows = new Map<string, number>();
  for (const copy of stored) {
    const label = labelOf(copy.deviceIdentifier);
    if (!label) continue;
    if (copy.maxContextLength) {
      maxWindows.set(`${copy.modelKey}${LMSTUDIO_DEVICE_SEPARATOR}${label}`, copy.maxContextLength);
    }
    const labels = labelsByModel.get(copy.modelKey) ?? [];
    if (!labels.includes(label)) labels.push(label);
    labelsByModel.set(copy.modelKey, labels);
  }
  for (const labels of labelsByModel.values()) {
    labels.sort(
      (a, b) => Number(b === LMSTUDIO_THIS_MACHINE) - Number(a === LMSTUDIO_THIS_MACHINE)
    );
  }

  const loadedWindows = new Map<string, number>();
  for (const row of Array.isArray(loaded) ? loaded : []) {
    const label = labelOf(row.deviceIdentifier);
    if (label && row.modelKey && row.contextLength) {
      loadedWindows.set(`${row.modelKey}${LMSTUDIO_DEVICE_SEPARATOR}${label}`, row.contextLength);
    }
  }
  return { labelsByModel, loadedWindows, maxWindows };
}

/** How the picker names the machine claudish runs on. */
const THIS_MACHINE_NAME = "this Mac";

/** The machine a picker row runs on, and the model id without its machine suffix. */
export interface LMStudioMachine {
  name: string;
  modelId: string;
}

/**
 * One row per machine that holds the model. A model `lms` does not list stays
 * as it was. An unloaded copy reports no window, unless it cannot reach
 * `defaultWindow`: then its maximum is the most a load can give it.
 */
export function expandModelsToMachines<
  T extends {
    id: string;
    displayName?: string;
    contextWindow?: number;
    maxContextWindow?: number;
    contextCeiling?: number;
    machine?: LMStudioMachine;
  },
>(models: T[], machines: LMStudioMachines, defaultWindow?: number): T[] {
  return models.flatMap((model) => {
    const labels = machines.labelsByModel.get(model.id);
    if (!labels) return [model];
    return labels.map((label) => {
      const id = `${model.id}${LMSTUDIO_DEVICE_SEPARATOR}${label}`;
      const max = machines.maxWindows.get(id);
      const ceiling = defaultWindow && max && max < defaultWindow ? max : undefined;
      const loaded = machines.loadedWindows.get(id);
      const name = label === LMSTUDIO_THIS_MACHINE ? THIS_MACHINE_NAME : label;
      return {
        ...model,
        id,
        displayName: `${model.displayName ?? model.id} (${name})`,
        machine: { name, modelId: model.id },
        contextWindow: loaded ?? ceiling,
        maxContextWindow: loaded ?? max,
        // The original row's ceiling is the model's maximum, the same on every machine.
        contextCeiling: loaded ?? max ?? model.contextCeiling,
      };
    });
  });
}

export interface LMStudioInstance {
  /** The id to send as the request's `model`. */
  instanceId: string;
  contextLength?: number;
}

export interface EnsureLMStudioInstance {
  baseUrl: string;
  /** The model key, without its machine suffix. */
  model: string;
  device: string;
  /** The context length to load with, and the least a running instance must have. */
  contextLength?: number;
  headers?: Record<string, string>;
  run?: LmsRunner;
  log?: (message: string) => void;
  /** The lock that keeps claudish processes from changing the preferred device at once. */
  lockPath?: string;
  lockPollMs?: number;
}

const LOCK_POLL_MS = 250;

function defaultLockPath(): string {
  return join(homedir(), ".claudish", "lmstudio-machine.lock");
}

/** A claim on a dead lock: the one waiter whose pid file it holds may remove that lock. */
const CLAIM = "takeover";

/**
 * One look at the lock: whether its owner lives, and an identity that tells this
 * directory from a later one at the same path. Undefined when there is no lock.
 */
export function lookAtLock(lockPath: string): { alive: boolean; identity: string } | undefined {
  const identity = lockIdentity(lockPath);
  if (identity === undefined) return undefined;
  let owner = "";
  try {
    owner = readFileSync(join(lockPath, "owner"), "utf-8");
  } catch {
    // Not signed yet.
  }
  const pid = Number.parseInt(owner, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    // Taken an instant ago and not yet signed, unless it has sat unsigned for a whole load.
    try {
      return { alive: Date.now() - statSync(lockPath).mtimeMs < LOAD_TIMEOUT_MS, identity };
    } catch {
      return undefined;
    }
  }
  return { alive: pidAlive(pid), identity };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockIdentity(path: string): string | undefined {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch {
    return undefined;
  }
  let owner = "";
  try {
    owner = readFileSync(join(path, "owner"), "utf-8");
  } catch {
    // An unsigned lock has an empty owner.
  }
  return `${stats.ino}:${stats.birthtimeMs}:${owner}`;
}

/**
 * Removes the dead lock a waiter looked at, and nothing else; answers whether it
 * did. Two waiters can see the same dead owner, and the first may already hold a
 * new lock at the path when the second acts. The lock never leaves its path: a
 * waiter first claims it by placing its pid file inside it, which only one
 * waiter can do, and then removes it only if it is still the directory it
 * looked at. A claim inside a live lock is withdrawn. A claim is cleared only
 * once the process it names has exited, so a waiter that pauses between its
 * check and its removal keeps its claim.
 */
export function takeOverStaleLock(lockPath: string, identity: string): boolean {
  const claim = join(lockPath, CLAIM);
  if (!makeClaim(claim)) {
    clearStaleClaim(claim);
    return false;
  }
  if (lockIdentity(lockPath) !== identity) {
    rmSync(claim, { recursive: true, force: true });
    return false;
  }
  rmSync(lockPath, { recursive: true, force: true });
  return true;
}

/**
 * Places this process's pid file in `claim`. The pid is written to a draft
 * first and then linked into place, and a link to a name that exists fails: so
 * one waiter makes the claim, and a claim is never seen without its pid. A
 * claim directory with no pid file is no claim.
 */
function makeClaim(claim: string): boolean {
  const draft = `${claim}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    try {
      // Never recursive: that would make again a lock another waiter removed.
      mkdirSync(claim);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
    }
    writeFileSync(draft, String(process.pid));
    linkSync(draft, join(claim, "pid"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(draft, { force: true });
  }
}

function claimPid(claim: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(join(claim, "pid"), "utf-8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Clears a claim whose waiter has exited; a claim of a running waiter stays. */
function clearStaleClaim(claim: string): void {
  const pid = claimPid(claim);
  if (pid === undefined || pidAlive(pid)) return;
  // Read again just before: another waiter may have cleared it and claimed anew.
  if (claimPid(claim) === pid) rmSync(claim, { recursive: true, force: true });
}

/** Writes the owner whole: a reader sees no owner or this pid, never part of it. */
function signLock(lockPath: string): void {
  const draft = join(lockPath, `owner.${process.pid}`);
  writeFileSync(draft, String(process.pid));
  renameSync(draft, join(lockPath, "owner"));
}

/**
 * The preferred device is a setting of the whole Mac, shared by every claudish
 * process. A directory is the lock because `mkdir` either creates it or fails,
 * with nothing in between; a lock whose owner has exited is taken over.
 */
async function withMachineLock<T>(
  lockPath: string,
  pollMs: number,
  work: () => Promise<T>
): Promise<T> {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOAD_TIMEOUT_MS + LIST_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const look = lookAtLock(lockPath);
    if (look === undefined) continue;
    if (!look.alive && takeOverStaleLock(lockPath, look.identity)) continue;
    if (Date.now() > deadline) {
      throw new Error(
        `Another claudish process is placing an LM Studio model (lock ${lockPath}). Retry when it finishes.`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  let own: string | undefined;
  try {
    signLock(lockPath);
    own = lockIdentity(lockPath);
    return await work();
  } finally {
    // A lock another process took over after judging this one dead is that process's now.
    if (own === undefined || lockIdentity(lockPath) === own) {
      rmSync(lockPath, { recursive: true, force: true });
    }
  }
}

let machineQueue: Promise<unknown> = Promise.resolve();

/** One preferred-device change at a time: it is a setting of the whole Mac. */
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const result = machineQueue.then(work, work);
  machineQueue = result.catch(() => undefined);
  return result;
}

function requireMachine(link: LinkStatus, device: string): string {
  const wanted = device.toLowerCase();
  if (wanted === LMSTUDIO_THIS_MACHINE) return link.self;
  const peer = link.peers.find(
    (p) => p.id.toLowerCase() === wanted || machineLabel(p).toLowerCase() === wanted
  );
  if (peer) return peer.id;
  const known = [LMSTUDIO_THIS_MACHINE, ...link.peers.map(machineLabel)].join(", ");
  throw new Error(
    `LM Studio machine "${device}" is not connected through LM Link. Connected: ${known}.`
  );
}

/** The context length to load with: the provider's default, within what this copy supports. */
function loadContextLength(
  stored: StoredCopy[] | null,
  model: string,
  device: string,
  link: LinkStatus,
  wanted: number | undefined
): number | undefined {
  if (wanted === undefined) return undefined;
  const copy = stored?.find(
    (row) => row.modelKey === model && (row.deviceIdentifier ?? link.self) === device
  );
  return copy?.maxContextLength ? Math.min(wanted, copy.maxContextLength) : wanted;
}

/** A smaller instance cannot hold the conversation Claude Code will send it. */
function assertContextLength(
  identifier: string,
  actual: number | undefined,
  wanted: number | undefined
): void {
  if (wanted === undefined || actual === undefined || actual >= wanted) return;
  throw new Error(
    `LM Studio runs ${identifier} with ${actual} tokens of context and claudish needs ${wanted}. Reload it with more context in LM Studio, or pass --context-window ${actual} to accept this size.`
  );
}

function ambiguityError(identifier: string): Error {
  return new Error(
    `LM Studio has instances named ${identifier} on more than one machine, so a request cannot select one. Unload one of them in LM Studio.`
  );
}

/**
 * The instance of `model` running on `device`, loaded there if it is not.
 *
 * LM Studio gives copies on two machines the same identifier when each is loaded
 * by REST, and a request names only the identifier. So a load on this machine
 * takes its own identifier through `lms load`, which keeps a local copy local,
 * and a load on a linked machine goes through REST, which follows the preferred
 * device.
 *
 * Throws when the model cannot be placed on that machine: a request must not
 * run on a machine the user did not pick.
 */
export async function ensureLMStudioInstance(
  options: EnsureLMStudioInstance
): Promise<LMStudioInstance> {
  const {
    baseUrl,
    model,
    device,
    headers,
    contextLength,
    run = runLms,
    log,
    lockPath = defaultLockPath(),
    lockPollMs = LOCK_POLL_MS,
  } = options;
  if (!isLoopbackUrl(baseUrl)) {
    throw new Error(
      `LM Studio at ${baseUrl} is on another host, so claudish cannot choose the machine "${device}" there. Remove the ~${device} suffix.`
    );
  }
  return serialized(() =>
    withMachineLock(lockPath, lockPollMs, async () => {
      const link = await readLink(run);
      if (!link) throw new Error("Could not read LM Link status: `lms link status --json` failed.");
      const target = requireMachine(link, device);
      const isOnTarget = (row: LoadedRow) => (row.deviceIdentifier ?? link.self) === target;
      const isThisMachine = target === link.self;
      const identifier = isThisMachine
        ? `${model}${LMSTUDIO_DEVICE_SEPARATOR}${LMSTUDIO_THIS_MACHINE}`
        : model;

      const before = await readLoaded(run);
      if (!before) throw listError();
      const hasNamesake = (name: string) =>
        before.some((row) => row.identifier === name && !isOnTarget(row));
      const stored = parseJson<StoredCopy[]>(await run(["ls", "--json"], LIST_TIMEOUT_MS));
      const length = loadContextLength(stored, model, target, link, contextLength);
      const running = before.find((row) => row.modelKey === model && isOnTarget(row));
      if (running) {
        if (hasNamesake(running.identifier)) throw ambiguityError(running.identifier);
        assertContextLength(running.identifier, running.contextLength, length);
        return { instanceId: running.identifier, contextLength: running.contextLength };
      }
      if (hasNamesake(identifier)) throw ambiguityError(identifier);

      // The name the new copy answers to: the REST load reports it, and the CLI load sets it.
      let expected = identifier;
      if (isThisMachine) {
        const lengthArgs = length === undefined ? [] : ["-c", String(length)];
        const loaded = await run(
          ["load", model, "--identifier", identifier, "-y", ...lengthArgs],
          LOAD_TIMEOUT_MS
        );
        if (loaded === null) throw new Error(`LM Studio could not load ${model} on this machine.`);
      } else {
        const reported = await loadOnLinkedMachine(
          { baseUrl, model, device, headers, run, log },
          link,
          target,
          length
        );
        expected = reported ?? identifier;
      }

      const after = await readLoaded(run);
      if (!after) throw listError();
      const placed = after.find((row) => row.identifier === expected && isOnTarget(row));
      if (!placed) {
        throw new Error(
          `LM Studio loaded ${model} on a different machine than ${device}. Another LM Link client may have changed the preferred device; retry.`
        );
      }
      if (after.some((row) => row.identifier === expected && !isOnTarget(row))) {
        throw ambiguityError(expected);
      }
      assertContextLength(placed.identifier, placed.contextLength, length);
      return { instanceId: placed.identifier, contextLength: placed.contextLength };
    })
  );
}

function listError(): Error {
  return new Error(
    "Could not list the running LM Studio instances: `lms ps --json` failed. Without that list claudish cannot tell which machine a model name reaches."
  );
}

/**
 * A REST load with `target` preferred for its duration. Answers the `instance_id`
 * LM Studio reports for the new copy, when the response carries one.
 */
async function loadOnLinkedMachine(
  options: Omit<EnsureLMStudioInstance, "contextLength"> & { run: LmsRunner },
  link: LinkStatus,
  target: string,
  contextLength: number | undefined
): Promise<string | undefined> {
  const { baseUrl, model, device, headers, run, log } = options;
  const original = link.preferred;
  const mustSwitch = original !== target;
  if (mustSwitch) {
    const switched = await run(["link", "set-preferred-device", target], LIST_TIMEOUT_MS);
    if (switched === null) throw new Error(`Could not select LM Link device ${device}.`);
  }
  try {
    const response = await fetch(`${baseUrl}/api/v1/models/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        model,
        ...(contextLength === undefined ? {} : { context_length: contextLength }),
      }),
      signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      // A server may quote the key it rejected, and this message is logged before
      // any request lease knows the key, so the body is masked here.
      const body = redactExactValues(await response.text(), credentialValuesFromRequest(headers));
      throw new Error(`LM Studio could not load ${model} on ${device}: ${response.status} ${body}`);
    }
    const body = (await response.json().catch(() => null)) as { instance_id?: unknown } | null;
    return typeof body?.instance_id === "string" && body.instance_id !== ""
      ? body.instance_id
      : undefined;
  } finally {
    if (mustSwitch && original) {
      const restored = await run(["link", "set-preferred-device", original], LIST_TIMEOUT_MS);
      if (restored === null) log?.(`Could not restore LM Link preferred device ${original}.`);
    }
  }
}
