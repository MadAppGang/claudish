/** Real-magmux test driver. Deliberately has NO timings seam: D-A/D-B use production defaults. */
import { expect } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { MagmuxClient, type MagmuxReply } from "../magmux-client.js";
import { type PaneSession, type PaneSessionOptions, startPaneSession } from "../pane-session.js";
import type { PaneSnapshot, SettledTurn } from "../types.js";
import {
  type PaneTestEnv,
  killLeftovers,
  makePaneTestEnv,
  newSessionUuid,
  waitNoOrphans,
} from "./hermetic-env.js";

export type Message = Record<string, unknown>;
export type Request = (message: Message, timeout?: number) => Promise<MagmuxReply>;
export interface SendTrace {
  message: Message;
  at: number;
  timeout: number | undefined;
  reply?: MagmuxReply;
  repliedAt?: number;
}
export interface GateRun {
  scenario: string;
  s: PaneSession;
  t: PaneTestEnv;
  uuid: string;
  transcript: string;
  log: string;
  sends: SendTrace[];
  turns: SettledTurn[];
  transitions: Array<{ to: string; at: number }>;
}
type Options = Omit<Partial<PaneSessionOptions>, "timings"> & {
  env?: Record<string, string>;
  prepare?: (t: PaneTestEnv, uuid: string) => Partial<Omit<PaneSessionOptions, "timings">>;
};
const open = new Set<GateRun>();
const routeKeysOf = new WeakMap<GateRun, string[]>();

interface TestClient {
  request: Request;
  close(): void;
}

export function clientOf(r: GateRun): TestClient {
  return (r.s as unknown as { client: TestClient }).client;
}

/**
 * Socket root (with a trailing slash) -> the observer of the pane started under it.
 *
 * A pane's first gated send can leave from inside `attach()`, before `startPaneSession`
 * returns: wrapping `s.client` afterwards misses it. So every client is handed to its
 * pane's observer as `MagmuxClient.connect` / `MagmuxClient.dial` return it.
 */
const routes = new Map<string, (client: TestClient) => void>();
let creationHooked = false;

/** Wrap the two client-creation statics once. With no matching route they pass through. */
function hookClientCreation(): void {
  if (creationHooked) return;
  creationHooked = true;
  const statics = MagmuxClient as unknown as Record<
    "connect" | "dial",
    (sockPath: string, ...rest: unknown[]) => Promise<TestClient>
  >;
  for (const name of ["connect", "dial"] as const) {
    const real = statics[name].bind(MagmuxClient);
    statics[name] = async (sockPath, ...rest) => {
      const client = await real(sockPath, ...rest);
      for (const [root, observe] of routes) if (sockPath.startsWith(root)) observe(client);
      return client;
    };
  }
}

/** The raw root and its realpath form (`/tmp` is `/private/tmp` on macOS); the root may not exist yet. */
function routeKeys(sockRoot: string): string[] {
  const keys = new Set([`${sockRoot}/`]);
  try {
    keys.add(`${join(realpathSync(dirname(sockRoot)), basename(sockRoot))}/`);
  } catch {
    // parent missing: only the raw key can match
  }
  return [...keys];
}

function unroute(keys: string[]): void {
  for (const key of keys) routes.delete(key);
}

export async function startGatePane(scenario: string, opts: Options = {}): Promise<GateRun> {
  hookClientCreation();
  const t = makePaneTestEnv({ CONTRACT_FAKE_MAX_MS: "120000", ...opts.env });
  const uuid = newSessionUuid();
  const log = join(t.tmp, "submits.jsonl");
  t.env.FAKE_SUBMIT_LOG = log;
  const { env: _env, prepare, ...over } = opts;
  const prepared = prepare?.(t, uuid) ?? {};
  const transcript = prepared.transcriptPath ?? over.transcriptPath ?? t.transcriptPathFor(uuid);
  const turns: SettledTurn[] = [];
  const transitions: GateRun["transitions"] = [];
  const sends: SendTrace[] = [];
  // Observe replacement connections too: I17 must count sends across a real redial.
  const seen = new WeakSet<TestClient>();
  const observe = (client: TestClient | null) => {
    if (!client || seen.has(client)) return;
    seen.add(client);
    const real = client.request.bind(client);
    client.request = async (message, timeout) => {
      if (message.type !== "send") return real(message, timeout);
      const trace: SendTrace = { message: { ...message }, at: Date.now(), timeout };
      sends.push(trace);
      const reply = await real(message, timeout);
      trace.reply = reply;
      trace.repliedAt = Date.now();
      return reply;
    };
  };
  const keys = routeKeys(t.sockRoot);
  for (const key of keys) routes.set(key, observe);
  let s: PaneSession;
  try {
    s = await startPaneSession({
      kind: "s",
      label: "gate",
      callerFlags: [],
      spawnModel: `fake-${scenario}`,
      cwd: t.cwd,
      sessionUuid: uuid,
      transcriptPath: transcript,
      slotEnv: {},
      shape: "interactive",
      readAvailable: true,
      parentEnv: t.env,
      sockRoot: t.sockRoot,
      ...over,
      ...prepared,
      decide: (turn) => {
        turns.push(turn);
        if (opts.decide) return opts.decide(turn);
        if (opts.shape !== "one-shot") return "continue";
        if (!turn.answer.trim()) return { state: "EMPTY", reason: "empty_output" };
        return { state: "COMPLETED" };
      },
      onBlocked: opts.onBlocked ?? (() => "wait"),
      onTransition: (transition) => {
        transitions.push({ to: transition.to, at: Date.parse(transition.at) });
        opts.onTransition?.(transition);
      },
    });
  } catch (error) {
    unroute(keys);
    killLeftovers({ sockRoot: t.sockRoot, ids: [uuid] });
    t.cleanup();
    throw error;
  }
  const r: GateRun = { scenario, s, t, uuid, transcript, log, sends, turns, transitions };
  open.add(r);
  routeKeysOf.set(r, keys);
  // Backstop: a client assigned without passing connect/dial is still observed.
  let current: TestClient | null = clientOf(r);
  observe(current);
  Object.defineProperty(s, "client", {
    configurable: true,
    get: () => current,
    set: (client: TestClient | null) => {
      current = client;
      observe(client);
    },
  });
  return r;
}

export async function gateUntil(
  r: GateRun,
  predicate: (snapshot: PaneSnapshot) => boolean,
  ms = 20_000
): Promise<PaneSnapshot> {
  const end = Date.now() + ms;
  for (;;) {
    const snapshot = r.s.snapshot();
    if (predicate(snapshot)) return snapshot;
    if (Date.now() >= end)
      throw new Error(
        `condition not met: ${JSON.stringify({ snapshot, diagnostics: r.s.diagnostics(), sends: r.sends })}`
      );
    await Bun.sleep(25);
  }
}

export function submissions(r: GateRun): Array<{ text: string; at: number }> {
  if (!existsSync(r.log)) return [];
  return readFileSync(r.log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function gatedSends(r: GateRun): SendTrace[] {
  return r.sends.filter(({ message }) => message.noGate !== true);
}

/** Assertions happen before deleting the root; even an assertion failure reaps every pane. */
export async function disposeGatePane(r: GateRun): Promise<void> {
  if (!open.has(r)) return;
  r.s.cancel();
  await r.s.reaped();
  const report = await waitNoOrphans({
    sockRoot: r.t.sockRoot,
    ids: [r.uuid],
    pgids: [r.s.snapshot().panePid ?? 0],
  });
  try {
    expect(report).toEqual({ processes: [], files: [] });
  } finally {
    open.delete(r);
    unroute(routeKeysOf.get(r) ?? []);
    killLeftovers({ sockRoot: r.t.sockRoot, ids: [r.uuid] });
    r.t.cleanup();
  }
}

export async function disposeGatePanes(): Promise<void> {
  // Shared-cwd tests need both children stopped before either environment is removed.
  for (const r of open) r.s.cancel();
  const results = await Promise.allSettled([...open].map(disposeGatePane));
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}
