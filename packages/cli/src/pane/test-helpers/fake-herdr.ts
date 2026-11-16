/**
 * A fake herdr 0.9.5 socket server for tests: newline-delimited JSON, `{id, method, params}`.
 * Test-only. It keeps workspaces, tabs and panes in memory and runs no program.
 *
 * Shapes follow the 0.9.5 schema and the measurements recorded with it:
 * - errors are `{code, message}`, `pane_not_found` for an unknown pane.
 * - events are `{event:"pane_focused", data:{...}}`, pushed on an `events.subscribe` connection.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakePane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  agent: { source: string; agent: string; state: string; seq: number | null } | null;
  metadata: Array<Record<string, unknown>>;
}

export interface FakeTab {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  panes: string[];
}

export interface FakeCall {
  method: string;
  params: Record<string, unknown>;
  outcome: "replied" | "error";
}

class FakeError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

export class FakeHerdr {
  readonly calls: FakeCall[] = [];
  readonly tabs = new Map<string, FakeTab>();
  readonly panes = new Map<string, FakePane>();
  private readonly subscribers = new Set<Socket>();
  private readonly sockets = new Set<Socket>();
  private nextTab = new Map<string, number>();
  private nextPane = new Map<string, number>();
  private constructor(
    readonly path: string,
    private readonly dir: string | null,
    private readonly server: Server
  ) {}

  /** In `dir` when given (left in place at stop), else in a temp dir of its own. */
  static async start(dir?: string): Promise<FakeHerdr> {
    const own = dir ? null : mkdtempSync(join(tmpdir(), "fake-herdr-"));
    const path = join(dir ?? (own as string), "herdr.sock");
    const server = createServer();
    const fake = new FakeHerdr(path, own, server);
    server.on("connection", (s) => fake.accept(s));
    await new Promise<void>((resolve) => server.listen(path, resolve));
    return fake;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
  }

  /* ───────────── test setup and inspection ───────────── */

  /** A workspace with one tab and one pane; returns their ids. */
  addWorkspace(workspaceId: string, label = "1"): { tabId: string; paneId: string } {
    const tab = this.newTab(workspaceId, label);
    const pane = this.newPane(tab);
    return { tabId: tab.tab_id, paneId: pane.pane_id };
  }

  callsOf(method: string): FakeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Push an event to every subscriber, as herdr would on a user act (`pane_focused`). */
  emitForTest(event: string, data: Record<string, unknown>): void {
    const line = `${JSON.stringify({ event, data: { ...data, type: event } })}\n`;
    for (const s of this.subscribers) if (!s.destroyed) s.write(line);
  }

  /* ───────────── the socket ───────────── */

  /**
   * herdr 0.9.5 answers ONE request per connection and then closes it (measured: the reply, then
   * `close` 1 ms later; a second request written on the same connection gets no answer). Only an
   * `events.subscribe` connection stays open. The fake does the same, so a client that reuses a
   * connection fails here as it fails against herdr.
   */
  private accept(sock: Socket): void {
    sock.setEncoding("utf8");
    this.sockets.add(sock);
    let buf = "";
    let taken = false;
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line.trim() || taken) continue;
        taken = true;
        this.onLine(sock, line);
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      this.sockets.delete(sock);
      this.subscribers.delete(sock);
    });
  }

  private onLine(sock: Socket, line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = obj(JSON.parse(line));
    } catch {
      sock.end(`${JSON.stringify({ id: "", error: { code: "invalid_json", message: "bad" } })}\n`);
      return;
    }
    const id = typeof msg.id === "string" ? msg.id : "";
    const method = typeof msg.method === "string" ? msg.method : "";
    const params = obj(msg.params);
    if (method === "events.subscribe") {
      this.subscribers.add(sock);
      this.calls.push({ method, params, outcome: "replied" });
      sock.write(`${JSON.stringify({ id, result: { type: "subscription_started" } })}\n`);
      return;
    }
    const call: FakeCall = { method, params, outcome: "replied" };
    this.calls.push(call);
    let reply: Record<string, unknown>;
    try {
      reply = { id, result: this.run(method, params) };
    } catch (e) {
      call.outcome = "error";
      reply =
        e instanceof FakeError
          ? { id, error: { code: e.code, message: e.message } }
          : { id, error: { code: "internal", message: String(e) } };
    }
    if (!sock.destroyed) sock.end(`${JSON.stringify(reply)}\n`);
  }

  /* ───────────── methods ───────────── */

  private run(method: string, p: Record<string, unknown>): Record<string, unknown> {
    switch (method) {
      case "ping":
        return { type: "pong", version: "0.9.5", protocol: 22 };
      case "tab.list":
        return {
          type: "tab_list",
          tabs: [...this.tabs.values()]
            .filter((t) => t.workspace_id === String(p.workspace_id ?? ""))
            .map((t) => ({
              tab_id: t.tab_id,
              workspace_id: t.workspace_id,
              number: t.number,
              label: t.label,
              pane_count: t.panes.length,
            })),
        };
      case "pane.report_agent": {
        const pane = this.mustPane(p.pane_id);
        pane.agent = {
          source: String(p.source),
          agent: String(p.agent),
          state: String(p.state),
          seq: typeof p.seq === "number" ? p.seq : null,
        };
        return { type: "ok" };
      }
      case "pane.report_metadata":
        this.mustPane(p.pane_id).metadata.push(p);
        return { type: "ok" };
      case "pane.release_agent":
        this.mustPane(p.pane_id).agent = null;
        return { type: "ok" };
      default:
        throw new FakeError("unknown_method", `unknown method ${method}`);
    }
  }

  /* ───────────── state ───────────── */

  private newTab(workspaceId: string, label: string): FakeTab {
    const n = (this.nextTab.get(workspaceId) ?? 0) + 1;
    this.nextTab.set(workspaceId, n);
    const tab: FakeTab = {
      tab_id: `${workspaceId}:t${n}`,
      workspace_id: workspaceId,
      number: n,
      label,
      panes: [],
    };
    this.tabs.set(tab.tab_id, tab);
    return tab;
  }

  private newPane(tab: FakeTab): FakePane {
    const n = (this.nextPane.get(tab.workspace_id) ?? 0) + 1;
    this.nextPane.set(tab.workspace_id, n);
    const pane: FakePane = {
      pane_id: `${tab.workspace_id}:p${n}`,
      tab_id: tab.tab_id,
      workspace_id: tab.workspace_id,
      agent: null,
      metadata: [],
    };
    this.panes.set(pane.pane_id, pane);
    tab.panes.push(pane.pane_id);
    return pane;
  }

  private mustPane(id: unknown): FakePane {
    const p = this.panes.get(String(id));
    if (!p) throw new FakeError("pane_not_found", `pane ${String(id)} not found`);
    return p;
  }
}
