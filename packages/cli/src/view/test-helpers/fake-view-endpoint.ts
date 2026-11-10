/**
 * Test-only stand-ins for the two sockets a viewer dials: a claudish view endpoint
 * (`claudish.view.v1`, JSON Lines) and a pane's read-only magmux view socket (NDJSON). Both record
 * every line they receive, so a test can prove what a viewer sent and what it never sent.
 *
 * The endpoint answers like `ViewServer` does where the viewer can tell: a claim publishes the new
 * holder as an `item.upsert` before its reply, as `ViewClaims` notifies inside the resize.
 *
 * Run as a script (`bun fake-view-endpoint.ts <root> <item json>`), it binds an endpoint named for
 * its own process and prints `ready` once listening, so a test can SIGKILL a real owner.
 */

import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import type { ViewHolder } from "../../pane/contract.js";
import type { ViewItem } from "../../pane/view-contract.js";
import { endpointNameOf, endpointPathOf, endpointsDirOf } from "../endpoints.js";

type Json = Record<string, unknown>;

/** A private root with an `endpoints/` directory, as `ensureSockRoot` leaves one. */
export function makeViewRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  mkdirSync(endpointsDirOf(root), { recursive: true, mode: 0o700 });
}

function lines(sock: Socket, onLine: (line: string) => void): void {
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    buf += chunk;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  });
  sock.on("error", () => {});
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export interface FakeEndpointOptions {
  root: string;
  item: ViewItem;
  /** the label the server would derive from the viewer's term_program */
  label?: string;
  /** endpoint file name; default this process's own, so two fakes in one root need one each */
  name?: string;
  /** what `hello` answers as the server's version */
  version?: string;
}

export class FakeViewEndpoint {
  readonly received: Json[] = [];
  readonly path: string;
  item: ViewItem;
  /** renew answers `view_not_held` while true */
  refuseRenew = false;
  private readonly server: Server;
  private readonly conns = new Set<Socket>();
  private grants = 0;
  private seq = 0;

  private constructor(private readonly o: FakeEndpointOptions) {
    this.item = o.item;
    this.path = endpointPathOf(o.root, o.name ?? endpointNameOf());
    this.server = createServer((sock) => this.accept(sock));
  }

  static async start(o: FakeEndpointOptions): Promise<FakeViewEndpoint> {
    const ep = new FakeViewEndpoint(o);
    rmSync(ep.path, { force: true });
    await listen(ep.server, ep.path);
    return ep;
  }

  ops(): string[] {
    return this.received.map((m) => String(m.op));
  }

  /** Publish a row to every connection, as the feed does past both gates. */
  upsert(item: ViewItem): void {
    this.item = item;
    for (const c of this.conns) this.event(c, { event: "item.upsert", item });
  }

  remove(reason = "evicted"): void {
    for (const c of this.conns)
      this.event(c, { event: "item.remove", target: this.item.target, reason });
  }

  closing(): void {
    for (const c of this.conns) this.event(c, { event: "server.closing" }, 0);
  }

  /** Another holder takes the view. */
  steal(view: ViewHolder): void {
    this.upsert({ ...this.item, view } as ViewItem);
  }

  async close(): Promise<void> {
    for (const c of this.conns) c.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    rmSync(this.path, { force: true });
  }

  private accept(sock: Socket): void {
    this.conns.add(sock);
    sock.on("close", () => this.conns.delete(sock));
    lines(sock, (line) => this.onLine(sock, line));
  }

  private send(sock: Socket, m: Json): void {
    if (!sock.destroyed) sock.write(`${JSON.stringify(m)}\n`);
  }

  private event(sock: Socket, body: Json, sub = 1): void {
    this.seq += 1;
    this.send(sock, { type: "event", sub, seq: this.seq, ...body });
  }

  private onLine(sock: Socket, line: string): void {
    const m = JSON.parse(line) as Json;
    this.received.push(m);
    const id = m.id;
    const args = (m.args ?? {}) as Json;
    const ok = (result: unknown): void => this.send(sock, { id, ok: true, result });
    const fail = (code: string): void =>
      this.send(sock, { id, ok: false, error: { code, message: code } });
    switch (m.op) {
      case "hello":
        ok({
          protocol: "claudish.view.v1",
          server: {
            pid: process.pid,
            version: this.o.version ?? "test",
            started_at: new Date().toISOString(),
            endpoint: this.o.name ?? endpointNameOf(),
            front_end: "none",
          },
          contract_version: 1,
          capabilities: ["view"],
        });
        return;
      case "list":
        ok({ items: [this.item] });
        return;
      case "subscribe":
        ok({ sub: 1 });
        this.event(sock, { event: "snapshot", items: [this.item] });
        return;
      case "claim": {
        this.grants += 1;
        const view: ViewHolder = {
          holder: "terminal",
          label: this.o.label ?? "a terminal",
          since: new Date().toISOString(),
          claim_id: `grant-${this.grants}`,
        };
        this.upsert({ ...this.item, view } as ViewItem);
        ok({ granted: true, view, resize: { cols: args.cols, rows: args.rows, changed: true } });
        return;
      }
      case "renew":
        if (this.refuseRenew) fail("view_not_held");
        else ok({ view: this.item.view ?? null });
        return;
      case "release":
        ok({ view: null });
        return;
      case "resize":
        ok({ cols: args.cols, rows: args.rows, changed: true });
        return;
      default:
        fail("unknown_op");
    }
  }
}

export interface FakeMagmuxViewOptions {
  path: string;
  /** frames sent after each `watch` reply, the first of them a keyframe */
  frames: object[];
  /** answer `capabilities` with this `readOnly` */
  readOnly?: unknown;
}

/** A pane's read-only magmux view socket: snapshot first, capabilities, watch, frames. */
export class FakeMagmuxView {
  readonly received: Json[] = [];
  private readonly server: Server;
  private readonly conns = new Set<Socket>();

  private constructor(private readonly o: FakeMagmuxViewOptions) {
    this.server = createServer((sock) => this.accept(sock));
  }

  static async start(o: FakeMagmuxViewOptions): Promise<FakeMagmuxView> {
    const v = new FakeMagmuxView(o);
    rmSync(o.path, { force: true });
    await listen(v.server, o.path);
    return v;
  }

  types(): string[] {
    return this.received.map((m) => String(m.type));
  }

  /** A frame pushed to every connection now, watched or not, as a late frame can be. */
  push(frame: object): void {
    for (const c of this.conns) c.write(`${JSON.stringify(frame)}\n`);
  }

  async close(): Promise<void> {
    for (const c of this.conns) c.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    rmSync(this.o.path, { force: true });
  }

  private accept(sock: Socket): void {
    this.conns.add(sock);
    sock.on("close", () => this.conns.delete(sock));
    sock.write(
      `${JSON.stringify({ type: "snapshot", panes: [{ pane: 0, state: "running", rows: 24, cols: 80 }] })}\n`
    );
    lines(sock, (line) => {
      const m = JSON.parse(line) as Json;
      this.received.push(m);
      const reply = (result: Json): void => {
        sock.write(`${JSON.stringify({ type: "reply", id: m.id, ok: true, result })}\n`);
      };
      if (m.type === "capabilities") reply({ readOnly: this.o.readOnly ?? true, protocol: 1 });
      else if (m.type === "watch") {
        // the reply and the keyframe in one write, as one socket read can deliver them
        const out = [
          { type: "reply", id: m.id, ok: true, result: { pane: 0, rows: 24, cols: 80 } },
        ];
        sock.write(`${[...out, ...this.o.frames].map((x) => JSON.stringify(x)).join("\n")}\n`);
      } else if (m.type === "unwatch") reply({ pane: 0, watching: false });
      else if (m.type === "resync") reply({ pane: 0, resync: true });
      else
        sock.write(
          `${JSON.stringify({ type: "reply", id: m.id, ok: false, code: "forbidden", error: "read only" })}\n`
        );
    });
  }
}

if (import.meta.main) {
  const [root, itemJson] = process.argv.slice(2);
  if (!root || !itemJson) throw new Error("usage: fake-view-endpoint.ts <root> <item json>");
  makeViewRoot(root);
  await FakeViewEndpoint.start({ root, item: JSON.parse(itemJson) as ViewItem });
  process.stdout.write("ready\n");
}
