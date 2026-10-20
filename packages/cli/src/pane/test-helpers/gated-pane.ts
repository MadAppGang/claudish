/** Real-magmux test driver. Deliberately has NO timings seam: D-A/D-B use production defaults. */
import { expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MagmuxReply } from "../magmux-client.js";
import { type PaneSession, type PaneSessionOptions, startPaneSession } from "../pane-session.js";
import type { PaneSnapshot, SettledTurn } from "../types.js";
import { type ObservedClient, observeClients } from "./client-observer.js";
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
const unrouteOf = new WeakMap<GateRun, () => void>();

type TestClient = ObservedClient;

export function clientOf(r: GateRun): TestClient {
  return (r.s as unknown as { client: TestClient }).client;
}

export async function startGatePane(scenario: string, opts: Options = {}): Promise<GateRun> {
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
  // A pane's first gated send can leave from inside `attach()`, before `startPaneSession`
  // returns: observe every client as it is created, not `s.client` afterwards.
  const unroute = observeClients(t.sockRoot, observe);
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
    unroute();
    killLeftovers({ sockRoot: t.sockRoot, ids: [uuid] });
    t.cleanup();
    throw error;
  }
  const r: GateRun = { scenario, s, t, uuid, transcript, log, sends, turns, transitions };
  open.add(r);
  unrouteOf.set(r, unroute);
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
    unrouteOf.get(r)?.();
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
