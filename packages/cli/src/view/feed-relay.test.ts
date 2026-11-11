import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { OWNER_START36 } from "../pane/pane-launch.js";
import type { ViewItem } from "../pane/view-contract.js";
import { endpointNameOf } from "./endpoints.js";
import {
  FEED_MIN_INTERVAL_MS,
  type FeedFile,
  FeedRelay,
  FeedRelayBusy,
  type FeedStamp,
  checkFeed,
  defaultFeedPath,
} from "./feed-relay.js";
import { FakeViewEndpoint, makeViewRoot } from "./test-helpers/fake-view-endpoint.js";
import { ViewClient } from "./view-client.js";

const FAKE_ENDPOINT_SCRIPT = join(import.meta.dir, "test-helpers", "fake-view-endpoint.ts");
const T = 20_000;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function newRoot(): string {
  const root = `/tmp/cpf-${randomBytes(4).toString("hex")}`;
  makeViewRoot(root);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function item(id: string, extra: Record<string, unknown> = {}): ViewItem {
  return {
    kind: "session",
    target: `s:${id}`,
    session_id: id,
    slot: id,
    model: "cx@gpt-6",
    provider: null,
    state: "RUNNING",
    reason: null,
    reason_detail: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    tool_calls: 0,
    turns_completed: 0,
    last_activity_at: null,
    idle_seconds: null,
    activity: null,
    pane: null,
    recent: null,
    agent_requested: null,
    agent: null,
    view: null,
    started_at: "2026-11-10T00:00:00.000Z",
    completed_at: null,
    elapsed_seconds: 0,
    prompt_summary: "say hi",
    prompts_sent: 1,
    pending_inputs: 0,
    subagents: [],
    magmux: null,
    ...extra,
  } as ViewItem;
}

/** an endpoint name that parses, for this process, distinct per suffix */
function epName(suffix: string): string {
  return `c${process.pid}-${suffix}.sock`;
}

/** a stamp no running process has */
const FAKE_STAMP: FeedStamp = {
  pid: 999_999,
  start36: "zzzzz",
  started_at: "2026-11-11T00:00:00.000Z",
};

async function until(probe: () => boolean, what: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > end) throw new Error(`${what} not seen in ${ms} ms`);
    await Bun.sleep(10);
  }
}

function readFeed(root: string): FeedFile | null {
  try {
    return JSON.parse(readFileSync(defaultFeedPath(root), "utf8")) as FeedFile;
  } catch {
    return null;
  }
}

async function endpoint(root: string, name: string, items: ViewItem[]): Promise<FakeViewEndpoint> {
  const [first, ...rest] = items;
  const ep = await FakeViewEndpoint.start({
    root,
    item: first as ViewItem,
    name,
    version: `v-${name}`,
  });
  cleanups.push(() => ep.close());
  for (const i of rest) ep.upsert(i);
  return ep;
}

async function relayOn(root: string, o: { minIntervalMs?: number } = {}): Promise<FeedRelay> {
  const relay = new FeedRelay({
    root,
    stamp: FAKE_STAMP,
    // the in-process fakes share this process's pid with a made-up start: treat every name as live
    endpointsAlive: async (names) => new Set(names),
    ...o,
  });
  cleanups.push(() => relay.stop());
  await relay.start();
  return relay;
}

describe("feed relay", () => {
  test(
    "merges every server's items into one 0600 file, written by rename, stamped with the relay",
    async () => {
      const root = newRoot();
      await endpoint(root, epName("aaaa1"), [item("one")]);
      const second = await endpoint(root, epName("aaaa2"), [item("two")]);
      const relay = await relayOn(root);
      await until(() => (readFeed(root)?.items.length ?? 0) === 2, "both servers' items");
      const feed = readFeed(root) as FeedFile;
      expect(feed.relay).toEqual(FAKE_STAMP);
      expect(feed.servers).toEqual([
        { endpoint: epName("aaaa1"), pid: process.pid, version: `v-${epName("aaaa1")}` },
        { endpoint: epName("aaaa2"), pid: process.pid, version: `v-${epName("aaaa2")}` },
      ]);
      expect(feed.items.map((i) => i.target)).toEqual(["s:one", "s:two"]);
      const path = defaultFeedPath(root);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(root, "feed")).mode & 0o777).toBe(0o700);
      expect(relay.path).toBe(path);
      // each write replaces the file whole: a new inode, and no temporary file left beside it
      const before = statSync(path).ino;
      const writes = relay.writes;
      second.upsert(item("two", { state: "AWAITING_INPUT" }));
      await until(() => relay.writes > writes, "the next write");
      expect(statSync(path).ino).not.toBe(before);
      expect(readdirSync(join(root, "feed"))).toEqual(["feed.json"]);
      expect(readFeed(root)?.items.find((i) => i.target === "s:two")).toMatchObject({
        state: "AWAITING_INPUT",
      });
    },
    T
  );

  test(
    "writes at most four times a second, only when the set changed, and ends on the last state",
    async () => {
      const root = newRoot();
      const ep = await endpoint(root, epName("bbbb1"), [item("one")]);
      const relay = await relayOn(root);
      await until(() => (readFeed(root)?.items.length ?? 0) === 1, "the first item");
      const start = Date.now();
      const writesBefore = relay.writes;
      for (let n = 1; n <= 40; n++) {
        ep.upsert(item("one", { tool_calls: n }));
        await Bun.sleep(10);
      }
      const elapsed = Date.now() - start;
      await until(
        () => (readFeed(root)?.items[0] as { tool_calls?: number } | undefined)?.tool_calls === 40,
        "the last upsert in the file"
      );
      const writes = relay.writes - writesBefore;
      // 40 changes in about half a second: one write per 250 ms window, plus the trailing one
      expect(writes).toBeLessThanOrEqual(Math.ceil(elapsed / FEED_MIN_INTERVAL_MS) + 2);
      expect(writes).toBeGreaterThanOrEqual(1);
      // the same row again changes nothing, so nothing is written
      const settled = relay.writes;
      ep.upsert(item("one", { tool_calls: 40 }));
      await Bun.sleep(FEED_MIN_INTERVAL_MS * 2);
      expect(relay.writes).toBe(settled);
    },
    T
  );

  test(
    "a server that appears after the relay started is listed; one that says it is closing is dropped",
    async () => {
      const root = newRoot();
      const relay = await relayOn(root);
      await until(() => readFeed(root) !== null, "the first file");
      expect(readFeed(root)).toMatchObject({ servers: [], items: [] });
      const ep = await endpoint(root, epName("cccc1"), [item("late")]);
      await until(() => readFeed(root)?.items[0]?.target === "s:late", "the late server's item");
      ep.remove();
      await until(() => readFeed(root)?.items.length === 0, "the removed item gone");
      ep.upsert(item("again"));
      await until(() => readFeed(root)?.items.length === 1, "an upsert after the removal");
      ep.closing();
      await until(() => readFeed(root)?.servers.length === 0, "the closing server gone");
      expect(readFeed(root)?.items).toEqual([]);
      expect(relay.snapshot()).toEqual({ servers: [], items: [] });
    },
    T
  );

  test(
    "a SIGKILLed server's items go, and the relay does not dial it again",
    async () => {
      const root = newRoot();
      const child = Bun.spawn(
        [process.execPath, FAKE_ENDPOINT_SCRIPT, root, JSON.stringify(item("doomed"))],
        { stdout: "pipe", stderr: "inherit", env: { ...process.env } }
      );
      cleanups.push(() => {
        child.kill("SIGKILL");
      });
      const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
      // the real process table decides liveness here
      const relay = new FeedRelay({ root, stamp: FAKE_STAMP });
      cleanups.push(() => relay.stop());
      await relay.start();
      await until(() => readFeed(root)?.items[0]?.target === "s:doomed", "the child's item");
      child.kill("SIGKILL");
      await child.exited;
      await until(() => readFeed(root)?.servers.length === 0, "the dead server dropped", 10_000);
      expect(readFeed(root)?.items).toEqual([]);
      expect(relay.snapshot().servers).toEqual([]);
    },
    T
  );

  test(
    "the file is removed when the relay stops, but not a file another relay wrote since",
    async () => {
      const root = newRoot();
      const relay = await relayOn(root);
      await until(() => readFeed(root) !== null, "the first file");
      await relay.stop();
      expect(existsSync(defaultFeedPath(root))).toBe(false);

      const second = await relayOn(root);
      await until(() => readFeed(root) !== null, "the second relay's file");
      const other: FeedFile = {
        relay: { pid: 999_998, start36: "yyyyy", started_at: "2026-11-11T00:00:00.000Z" },
        written_at: "2026-11-11T00:00:00.000Z",
        servers: [],
        items: [],
      };
      writeFileSync(defaultFeedPath(root), JSON.stringify(other), { mode: 0o600 });
      await second.stop();
      expect(readFeed(root)?.relay.pid).toBe(999_998);
    },
    T
  );

  test("a second relay is refused while the stamped one runs, and allowed once it is gone", async () => {
    const root = newRoot();
    const live: FeedFile = {
      // this test process is the "other" relay: alive by the process table
      relay: { pid: process.pid, start36: OWNER_START36, started_at: "x" },
      written_at: "x",
      servers: [],
      items: [],
    };
    makeFeedDir(root);
    writeFileSync(defaultFeedPath(root), JSON.stringify(live), { mode: 0o600 });
    const busy = new FeedRelay({ root, stamp: FAKE_STAMP });
    cleanups.push(() => busy.stop());
    await expect(busy.start()).rejects.toBeInstanceOf(FeedRelayBusy);

    writeFileSync(
      defaultFeedPath(root),
      JSON.stringify({ ...live, relay: { pid: 999_997, start36: "xxxxx", started_at: "x" } }),
      { mode: 0o600 }
    );
    const relay = await relayOn(root);
    await until(() => readFeed(root)?.relay.pid === FAKE_STAMP.pid, "the new relay's stamp");
    expect(relay.writes).toBeGreaterThanOrEqual(1);
  });

  test(
    "a server whose first connection failed is tried again on the backstop, with no directory change",
    async () => {
      const root = newRoot();
      await endpoint(root, epName("eeee1"), [item("one")]);
      let attempts = 0;
      const relay = new FeedRelay({
        root,
        stamp: FAKE_STAMP,
        endpointsAlive: async (names) => new Set(names),
        backstopMs: 30,
        connect: async (path) => {
          attempts += 1;
          if (attempts === 1) throw new Error("refused once");
          return ViewClient.connect(path, { hello: { name: "relay", kind: "relay" } });
        },
      });
      cleanups.push(() => relay.stop());
      await relay.start();
      await until(() => (readFeed(root)?.items.length ?? 0) === 1, "the item after a retry", 2_000);
      expect(attempts).toBe(2);
    },
    T
  );
});

describe("checkFeed (--feed-check)", () => {
  test("missing, a dead stamp, and a live stamp", async () => {
    const root = newRoot();
    const path = defaultFeedPath(root);
    expect(await checkFeed(path)).toEqual({ alive: false, reason: "missing" });
    makeFeedDir(root);
    writeFileSync(path, JSON.stringify({ relay: FAKE_STAMP, servers: [], items: [] }));
    expect(await checkFeed(path)).toEqual({
      alive: false,
      reason: "relay_gone",
      relay: FAKE_STAMP,
    });
    const own = { pid: process.pid, start36: OWNER_START36, started_at: "x" };
    writeFileSync(path, JSON.stringify({ relay: own, servers: [], items: [] }));
    expect(await checkFeed(path)).toEqual({ alive: true, relay: own });
    writeFileSync(path, "{ half a fi");
    expect(await checkFeed(path)).toEqual({ alive: false, reason: "missing" });
    // the endpoint naming carries the same pid and start, so one liveness rule serves both
    expect(endpointNameOf(own.pid, own.start36)).toBe(`c${process.pid}-${OWNER_START36}.sock`);
  });
});

function makeFeedDir(root: string): void {
  mkdirSync(join(root, "feed"), { recursive: true, mode: 0o700 });
}
