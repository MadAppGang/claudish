import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import { eventually, sessionItem } from "../herdr/test-helpers/view-items.js";
import type { CaptureResult } from "../pane/contract.js";
import type {
  SessionViewItem,
  ViewEvent,
  ViewListResult,
  ViewResizeAnswer,
} from "../pane/view-contract.js";
import { makeViewRoot } from "./test-helpers/fake-view-endpoint.js";
import { type ClaimCaller, ViewClaims } from "./view-claims.js";
import { ViewClient } from "./view-client.js";
import { ViewDirectory, type ViewSessionSource } from "./view-directory.js";
import { ViewFeed } from "./view-feed.js";
import { ViewServer } from "./view-server.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanups.splice(0).reverse()) await stop();
});

async function rig() {
  const root = `/tmp/vbb-${randomBytes(4).toString("hex")}`;
  makeViewRoot(root);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const rows = new Map<string, SessionViewItem>(
    ["a", "b"].map((id) => [
      id,
      {
        ...sessionItem(id),
        magmux: { pane_id: `c1-${id}`, view_socket: join(root, `magmux-${id}.view`) },
      } as SessionViewItem,
    ])
  );
  const sizes = new Map<string, { cols: number; rows: number; seq: number }>(
    ["a", "b"].map((id) => [id, { cols: 80, rows: 24, seq: 1 }])
  );
  const feed = new ViewFeed({ debounceMs: 5 });
  const claims = new ViewClaims({ notify: (t) => feed.changed(t, true) });
  const source: ViewSessionSource = {
    sessionRow: (id) => rows.get(id) ?? null,
    listSessionRows: () => [...rows.values()],
    viewDetail: (id) => {
      const item = rows.get(id);
      return item
        ? {
            prompt_summary: item.prompt_summary,
            prompts_sent: item.prompts_sent,
            pending_inputs: item.pending_inputs,
            subagents: item.subagents,
            magmux: item.magmux,
          }
        : null;
    },
    captureSession: (id, since, _spans, caller = { kind: "mcp" }) => {
      const size = sizes.get(id);
      if (!size) throw new Error("no session");
      claims.renewFromCapture(`s:${id}`, caller);
      return claims.stamp(
        since === size.seq
          ? { unchanged: true as const, seq: size.seq, final: false }
          : { ...size, cursor: { x: 0, y: 0 }, lines: ["test screen"], final: false },
        `s:${id}`,
        caller
      );
    },
    transcriptSession: (id) => ({
      session_id: id,
      cursor: "test-cursor",
      lines: [{ kind: "assistant", text: "test answer" }],
      more: false,
      final: false,
    }),
    resizeSession: async (id, cols, height, caller: ClaimCaller = { kind: "mcp" }) => {
      const size = sizes.get(id);
      if (!size) throw new Error("no session");
      const changed = size.cols !== cols || size.rows !== height;
      const next = { cols, rows: height, seq: size.seq + Number(changed) };
      sizes.set(id, next);
      claims.claim(`s:${id}`, caller);
      return claims.stamp({ session_id: id, ...next, changed }, `s:${id}`, caller);
    },
  };
  const absent = (): never => {
    throw new Error("no such test item");
  };
  const directory = new ViewDirectory({
    sessions: source,
    team: {
      listSlots: () => [],
      slot: () => null,
      capture: absent,
      transcript: absent,
      resize: async () => absent(),
    },
    replays: { list: () => [], capture: absent, resize: async () => absent() },
    claims,
  });
  feed.setBuilder((t) => directory.item(t));
  const peers = new Set(["c999-abc.sock"]);
  const server = await ViewServer.start({
    root,
    directory,
    claims,
    feed,
    version: "black-box-test",
    peerAlive: (name) => peers.has(name),
  });
  if (!server) throw new Error("test server failed to bind its short private socket");
  cleanups.push(() => {
    server.close();
    for (const id of rows.keys()) claims.forget(`s:${id}`);
  });
  async function client(kind: "viewer" | "relay" = "viewer") {
    const c = await ViewClient.connect(server!.endpointPath, {
      hello: { name: "test reader", kind, front_end: "herdr" },
    });
    cleanups.push(() => c.close());
    return c;
  }
  return { root, rows, feed, server, client };
}

describe("local read-only view protocol over real Unix sockets", () => {
  test("TEST-16 REQ-2 REQ-28 REQ-39 endpoint is a 0600 socket under 0700 directories", async () => {
    const r = await rig();

    expect(statSync(r.root).mode & 0o777).toBe(0o700);
    expect(statSync(join(r.root, "endpoints")).mode & 0o777).toBe(0o700);
    expect(statSync(r.server.endpointPath).isSocket()).toBe(true);
    expect(statSync(r.server.endpointPath).mode & 0o777).toBe(0o600);
    r.server.close();
    expect(existsSync(r.server.endpointPath)).toBe(false);
  });

  test("TEST-17 REQ-2 REQ-3 REQ-5 REQ-6 REQ-7 REQ-8 independent subscriptions get filtered full rows in sequence", async () => {
    const r = await rig();
    const a = await r.client();
    const b = await r.client();
    const seenA: ViewEvent[] = [];
    const seenB: ViewEvent[] = [];
    a.on("event", (e) => seenA.push(e));
    b.on("event", (e) => seenB.push(e));

    await a.request("subscribe", { targets: ["s:a"] });
    await b.request("subscribe", { targets: ["s:b"] });
    await eventually(() => {
      expect(seenA.some((e) => e.event === "snapshot")).toBe(true);
      expect(seenB.some((e) => e.event === "snapshot")).toBe(true);
    });
    for (const [client, target, seen] of [
      [a, "s:a", seenA],
      [b, "s:b", seenB],
    ] as const) {
      expect(client.helloResult).toMatchObject({
        protocol: "claudish.view.v1",
        contract_version: 1,
      });
      expect(client.helloResult?.capabilities.at(-1)).toBe("view");
      const snap = seen.find((e) => e.event === "snapshot");
      expect(snap?.event === "snapshot" ? snap.items.map((i) => i.target) : []).toEqual([target]);
    }

    for (const id of ["a", "b"]) {
      const item = r.rows.get(id)!;
      r.rows.set(id, { ...item, tokens_in: 100, tokens_out: 20, cost_usd: 0.25, activity: "Bash" });
      r.feed.changed(`s:${id}`, true);
    }
    await eventually(() => {
      expect(seenA.filter((e) => e.event === "item.upsert")).toHaveLength(1);
      expect(seenB.filter((e) => e.event === "item.upsert")).toHaveLength(1);
    });

    for (const [id, seen] of [
      ["a", seenA],
      ["b", seenB],
    ] as const) {
      const event = seen.find((e) => e.event === "item.upsert");
      const expected = r.rows.get(id);
      if (!expected) throw new Error(`missing test row ${id}`);
      expect(event?.event === "item.upsert" ? event.item : null).toEqual(expected);
      expect(seen.map((e) => e.seq)).toEqual([...seen.map((e) => e.seq)].sort((x, y) => x - y));
      expect(new Set(seen.map((e) => e.seq)).size).toBe(seen.length);
      const text = JSON.stringify(seen);
      expect(text).not.toContain("hook-inbox.jsonl");
      expect(text).not.toContain("tokens.json");
      expect(text).not.toContain("/panes/");
      expect(text).not.toContain(join(r.root, `magmux-${id}.sock`));
    }
  });

  test.each(["viewer", "relay"] as const)(
    "TEST-18 REQ-4 REQ-10 REQ-28 %s cannot invoke input or peer-only operations",
    async (kind) => {
      const r = await rig();
      const c = await r.client(kind);
      const before = await c.request<ViewListResult>("list");
      for (const op of [
        "send_input",
        "cancel_session",
        "create_session",
        "scroll_session",
        "scroll",
        "replay.scroll",
        "replay.close",
      ]) {
        await expect(
          c.request(op, { target: "s:a", replay_id: "replay-a", input: "must not deliver" })
        ).rejects.toMatchObject({ code: "forbidden" });
      }
      await expect(c.request("not-a-real-operation")).rejects.toMatchObject({ code: "unknown_op" });
      expect(await c.request<ViewListResult>("list")).toEqual(before);
      expect(await c.request<CaptureResult>("capture", { target: "s:a" })).toMatchObject({
        cols: 80,
        rows: 24,
        lines: ["test screen"],
        final: false,
      });
    }
  );

  test("TEST-19 REQ-4 REQ-28 peer identity must be another live endpoint", async () => {
    const r = await rig();
    for (const endpoint of [undefined, r.server.endpointName, "c998-abc.sock"]) {
      await expect(
        ViewClient.connect(r.server.endpointPath, {
          hello: { name: "invalid peer", kind: "peer", endpoint },
        })
      ).rejects.toMatchObject({ code: "forbidden" });
    }

    const peer = await ViewClient.connect(r.server.endpointPath, {
      hello: { name: "valid peer", kind: "peer", endpoint: "c999-abc.sock" },
    });
    cleanups.push(() => peer.close());
    expect((await peer.request<ViewListResult>("list")).items).toHaveLength(2);
  });

  test("TEST-20 REQ-12 REQ-13 resize without claim fails and leaves visible dimensions unchanged", async () => {
    const r = await rig();
    const c = await r.client();

    await expect(c.request("resize", { target: "s:a", cols: 110, rows: 30 })).rejects.toMatchObject(
      { code: "view_not_held" }
    );

    expect(await c.request<CaptureResult>("capture", { target: "s:a" })).toMatchObject({
      cols: 80,
      rows: 24,
      view: null,
      final: false,
    });
  });

  test("TEST-21 REQ-12 REQ-13 same-size take steals view; only latest holder may resize", async () => {
    const r = await rig();
    const a = await r.client();
    const b = await r.client();
    const first = await a.request<{ view: { claim_id: string }; resize: ViewResizeAnswer }>(
      "claim",
      { target: "s:a", cols: 100, rows: 30 }
    );
    expect(first.resize).toMatchObject({ cols: 100, rows: 30, changed: true });

    const second = await b.request<{ view: { claim_id: string }; resize: ViewResizeAnswer }>(
      "claim",
      { target: "s:a", cols: 100, rows: 30 }
    );

    expect(second.view.claim_id).not.toBe(first.view.claim_id);
    expect(second.resize).toMatchObject({ cols: 100, rows: 30, changed: false });
    await expect(a.request("resize", { target: "s:a", cols: 120, rows: 35 })).rejects.toMatchObject(
      { code: "view_not_held" }
    );
    await b.request("resize", { target: "s:a", cols: 120, rows: 35 });
    expect(await a.request<CaptureResult>("capture", { target: "s:a" })).toMatchObject({
      cols: 120,
      rows: 35,
      view: { claim_id: second.view.claim_id, holder: "herdr" },
    });
  });

  test("TEST-22 REQ-18 holder disconnect clears view but leaves session running", async () => {
    const r = await rig();
    const holder = await r.client();
    const reader = await r.client();
    await holder.request("claim", { target: "s:a", cols: 80, rows: 24 });

    holder.close();
    await eventually(() => expect(r.rows.get("a")?.state).toBe("RUNNING"));
    for (let i = 0; i < 100; i++) {
      const listed = await reader.request<ViewListResult>("list");
      if (listed.items.find((x) => x.target === "s:a")?.view === null) break;
      await Bun.sleep(10);
    }

    expect(
      (await reader.request<ViewListResult>("list")).items.find((x) => x.target === "s:a")
    ).toMatchObject({ state: "RUNNING", view: null });
    expect(await reader.request<CaptureResult>("capture", { target: "s:a" })).toMatchObject({
      final: false,
    });
  });

  test("TEST-40 REQ-4 REQ-28 REQ-36 oversized unterminated line closes only its sender", async () => {
    const r = await rig();
    const healthy = await r.client();
    const sock = new Socket();
    cleanups.push(() => {
      sock.destroy();
    });
    let reply = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      reply += chunk;
    });
    sock.on("error", () => {});
    const closed = new Promise<void>((resolve) => sock.once("close", () => resolve()));
    await new Promise<void>((resolve, reject) => {
      sock.once("error", reject);
      sock.connect(r.server.endpointPath, resolve);
    });

    sock.write("x".repeat(64 * 1024 + 1));
    await closed;

    expect(reply).toContain("line_too_long");
    expect((await healthy.request<ViewListResult>("list")).items).toHaveLength(2);
  });
});
