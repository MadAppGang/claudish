/**
 * A fake herdr 0.9.5 socket server for tests: newline-delimited JSON, `{id, method, params}`.
 * Test-only. It keeps workspaces, tabs and panes in memory and runs no program.
 *
 * Shapes follow the 0.9.5 schema and the measurements recorded with it:
 * - `layout.apply` requires `tab_label` and a `{type:"pane"}` root, creates a tab without focusing
 *   it, and answers `{type:"layout_apply", layout:{tab_id, focused_pane_id, ...}}`.
 * - `pane.split` takes `target_pane_id` and rejects `pane_id` and `command`.
 * - `pane.move` into a zoomed tab answers `changed:false, reason:"zoomed_tab"`; a move that empties
 *   its tab closes that tab and names it in `closed_tab_id`.
 * - closing a tab's last pane closes the tab.
 * - errors are `{code, message}` with `pane_not_found`, `tab_not_found`, `target_pane_not_found`.
 * - events are `{event:"pane_closed", data:{...}}`, and follow the reply of the call that caused them.
 *
 * Faults are scripted per method with `script(method, fault)`, used once each in order:
 * `drop` runs the call and sends no reply, `drop-unexecuted` neither runs nor replies, `close`
 * runs it and then drops the connection, `{error}` answers that error without running it, and
 * `{hold}` runs it and waits for the test to release the reply (or drop it).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Fault = "drop" | "drop-unexecuted" | "close" | { error: string } | { hold: Held };

/** A reply the test releases or drops. */
export class Held {
  executed: Promise<void>;
  private markExecuted!: () => void;
  private decide!: (send: boolean) => void;
  readonly decision: Promise<boolean>;
  constructor() {
    this.executed = new Promise((r) => {
      this.markExecuted = r;
    });
    this.decision = new Promise((r) => {
      this.decide = r;
    });
  }
  /** internal */
  ran(): void {
    this.markExecuted();
  }
  release(): void {
    this.decide(true);
  }
  drop(): void {
    this.decide(false);
  }
}

export interface FakePane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  label: string | null;
  cwd: string | null;
  command: string[] | null;
  env: Record<string, string>;
  /** true for panes the test made as "the user's" */
  user: boolean;
  agent: { source: string; agent: string; state: string; seq: number | null } | null;
  metadata: Array<Record<string, unknown>>;
}

export interface FakeTab {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  panes: string[];
  zoomed: boolean;
  focused_pane_id: string | null;
}

export interface FakeCall {
  method: string;
  params: Record<string, unknown>;
  outcome: "replied" | "error" | "dropped" | "unexecuted" | "closed";
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
  focusedTab = new Map<string, string>();
  private readonly faults = new Map<string, Fault[]>();
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

  /** A workspace with one user tab and one user pane; returns the pane id. */
  addWorkspace(workspaceId: string, label = "1"): { tabId: string; paneId: string } {
    const tab = this.newTab(workspaceId, label);
    const pane = this.newPane(tab, { user: true });
    this.focusedTab.set(workspaceId, tab.tab_id);
    return { tabId: tab.tab_id, paneId: pane.pane_id };
  }

  /** A user tab with `n` user panes. */
  addUserTab(workspaceId: string, label: string, n = 1): FakeTab {
    const tab = this.newTab(workspaceId, label);
    for (let i = 0; i < n; i++) this.newPane(tab, { user: true });
    return tab;
  }

  /**
   * What herdr does when it finishes a creation late: a tab with one non-user pane appears and
   * `tab_created` is emitted.
   */
  lateCreate(workspaceId: string, label: string): FakeTab {
    const tab = this.newTab(workspaceId, label);
    this.newPane(tab, { user: false });
    this.emit("tab_created", { tab: this.tabInfo(tab) });
    return tab;
  }

  script(method: string, ...faults: Fault[]): void {
    this.faults.set(method, [...(this.faults.get(method) ?? []), ...faults]);
  }

  zoom(tabId: string, zoomed: boolean): void {
    const tab = this.mustTab(tabId);
    tab.zoomed = zoomed;
    this.emit("layout_updated", { layout: this.layoutOf(tab) });
  }

  tabsIn(workspaceId: string): FakeTab[] {
    return [...this.tabs.values()].filter((t) => t.workspace_id === workspaceId);
  }

  tabByLabel(workspaceId: string, label: string): FakeTab | undefined {
    return this.tabsIn(workspaceId).find((t) => t.label === label);
  }

  /** Panes created by any call (not by the test as the user's), live now. */
  placedPanes(): FakePane[] {
    return [...this.panes.values()].filter((p) => !p.user);
  }

  callsOf(method: string): FakeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Simulate a pane's program exiting: herdr closes the pane and emits `pane_exited`. */
  exitPane(paneId: string): void {
    const p = this.panes.get(paneId);
    if (!p) return;
    this.removePane(p);
    this.emit("pane_exited", { pane_id: paneId, workspace_id: p.workspace_id });
  }

  /** Push an event to every subscriber, as herdr would on a user act (`pane_focused`). */
  emitForTest(event: string, data: Record<string, unknown>): void {
    this.emit(event, data);
  }

  /** Close every connection the server has, subscriptions included. */
  dropConnections(): void {
    for (const s of this.sockets) s.destroy();
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
        void this.onLine(sock, line);
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      this.sockets.delete(sock);
      this.subscribers.delete(sock);
    });
  }

  private async onLine(sock: Socket, line: string): Promise<void> {
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
    const fault = this.faults.get(method)?.shift();
    const call: FakeCall = { method, params, outcome: "replied" };
    this.calls.push(call);
    if (fault === "drop-unexecuted") {
      call.outcome = "unexecuted";
      return;
    }
    if (fault && typeof fault === "object" && "error" in fault) {
      call.outcome = "error";
      sock.end(`${JSON.stringify({ id, error: { code: fault.error, message: fault.error } })}\n`);
      return;
    }
    const events: Array<[string, Record<string, unknown>]> = [];
    let reply: Record<string, unknown>;
    try {
      reply = { id, result: this.run(method, params, events) };
    } catch (e) {
      call.outcome = "error";
      reply =
        e instanceof FakeError
          ? { id, error: { code: e.code, message: e.message } }
          : { id, error: { code: "internal", message: String(e) } };
    }
    if (fault && typeof fault === "object" && "hold" in fault) {
      fault.hold.ran();
      const send = await fault.hold.decision;
      if (!send) {
        call.outcome = "dropped";
        this.flushEvents(events);
        return;
      }
    }
    if (fault === "drop") {
      call.outcome = "dropped";
      this.flushEvents(events);
      return;
    }
    if (fault === "close") {
      call.outcome = "closed";
      sock.destroy();
      this.flushEvents(events);
      return;
    }
    if (!sock.destroyed) sock.end(`${JSON.stringify(reply)}\n`);
    this.flushEvents(events);
  }

  private flushEvents(events: Array<[string, Record<string, unknown>]>): void {
    for (const [event, data] of events) this.emit(event, data);
  }

  private emit(event: string, data: Record<string, unknown>): void {
    const line = `${JSON.stringify({ event, data: { ...data, type: event } })}\n`;
    for (const s of this.subscribers) if (!s.destroyed) s.write(line);
  }

  /* ───────────── methods ───────────── */

  private run(
    method: string,
    p: Record<string, unknown>,
    ev: Array<[string, Record<string, unknown>]>
  ): Record<string, unknown> {
    switch (method) {
      case "ping":
        return { type: "pong", version: "0.9.5", protocol: 22 };
      case "pane.get":
        return { type: "pane_info", pane: this.paneInfo(this.mustPane(p.pane_id)) };
      case "tab.list":
        return {
          type: "tab_list",
          tabs: this.tabsIn(String(p.workspace_id ?? "")).map((t) => this.tabInfo(t)),
        };
      case "layout.apply":
        return this.layoutApply(p, ev);
      case "pane.split":
        return this.paneSplit(p, ev);
      case "pane.move":
        return this.paneMove(p, ev);
      case "pane.close": {
        const pane = this.mustPane(p.pane_id);
        this.removePane(pane, ev);
        ev.push(["pane_closed", { pane_id: pane.pane_id, workspace_id: pane.workspace_id }]);
        return { type: "ok" };
      }
      case "tab.close": {
        const tab = this.mustTab(p.tab_id);
        for (const id of [...tab.panes]) {
          const pane = this.panes.get(id);
          if (pane) this.removePane(pane);
        }
        this.tabs.delete(tab.tab_id);
        ev.push(["tab_closed", { tab_id: tab.tab_id, workspace_id: tab.workspace_id }]);
        return { type: "ok" };
      }
      case "tab.rename": {
        const tab = this.mustTab(p.tab_id);
        tab.label = String(p.label ?? "");
        return { type: "tab_info", tab: this.tabInfo(tab) };
      }
      case "pane.zoom":
        throw new FakeError("unexpected", "this fake does not zoom on request");
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

  private layoutApply(
    p: Record<string, unknown>,
    ev: Array<[string, Record<string, unknown>]>
  ): Record<string, unknown> {
    const label = p.tab_label;
    if (typeof label !== "string" || !label)
      throw new FakeError("invalid_params", "tab_label is required by this fake");
    const root = obj(p.root);
    if (root.type !== "pane") throw new FakeError("invalid_params", 'root must be {type:"pane"}');
    const ws = String(p.workspace_id ?? "");
    if (!this.focusedTab.has(ws)) throw new FakeError("workspace_not_found", `no ${ws}`);
    const tab = this.newTab(ws, label);
    const pane = this.newPane(tab, {
      user: false,
      label: typeof root.label === "string" ? root.label : null,
      cwd: typeof root.cwd === "string" ? root.cwd : null,
      command: Array.isArray(root.command) ? root.command.map(String) : null,
      env: obj(root.env) as Record<string, string>,
    });
    if (p.focus === true) this.focusedTab.set(ws, tab.tab_id);
    ev.push(["tab_created", { tab: this.tabInfo(tab) }]);
    ev.push(["layout_updated", { layout: this.layoutOf(tab) }]);
    ev.push(["pane_created", { pane: this.paneInfo(pane) }]);
    return {
      type: "layout_apply",
      layout: {
        workspace_id: ws,
        tab_id: tab.tab_id,
        zoomed: false,
        focused_pane_id: pane.pane_id,
        root: { type: "pane", pane_id: pane.pane_id, label: pane.label, command: pane.command },
      },
    };
  }

  private paneSplit(
    p: Record<string, unknown>,
    ev: Array<[string, Record<string, unknown>]>
  ): Record<string, unknown> {
    if ("pane_id" in p) throw new FakeError("invalid_params", "unknown field `pane_id`");
    if ("command" in p) throw new FakeError("invalid_params", "unknown field `command`");
    if (typeof p.target_pane_id !== "string")
      throw new FakeError("invalid_params", "this fake requires target_pane_id");
    const target = this.mustPane(p.target_pane_id);
    const tab = this.mustTab(target.tab_id);
    const pane = this.newPane(tab, { user: false, env: obj(p.env) as Record<string, string> });
    ev.push(["pane_created", { pane: this.paneInfo(pane) }]);
    return { type: "pane_info", pane: this.paneInfo(pane) };
  }

  private paneMove(
    p: Record<string, unknown>,
    ev: Array<[string, Record<string, unknown>]>
  ): Record<string, unknown> {
    const pane = this.mustPane(p.pane_id);
    const dest = obj(p.destination);
    if (dest.type !== "tab") throw new FakeError("invalid_params", "this fake moves to a tab only");
    const to = this.tabs.get(String(dest.tab_id));
    if (!to) throw new FakeError("tab_not_found", `tab ${String(dest.tab_id)} not found`);
    if (dest.target_pane_id !== undefined && !this.panes.has(String(dest.target_pane_id)))
      throw new FakeError(
        "target_pane_not_found",
        `target pane ${String(dest.target_pane_id)} not found`
      );
    const base = { previous_pane_id: pane.pane_id, previous_tab_id: pane.tab_id };
    if (to.tab_id === pane.tab_id)
      return { type: "pane_move", move_result: { changed: false, reason: "same_tab", ...base } };
    if (to.zoomed)
      return {
        type: "pane_move",
        move_result: { changed: false, reason: "zoomed_tab", ...base, pane: this.paneInfo(pane) },
      };
    const from = this.mustTab(pane.tab_id);
    from.panes = from.panes.filter((id) => id !== pane.pane_id);
    let closed: string | null = null;
    if (from.panes.length === 0) {
      this.tabs.delete(from.tab_id);
      closed = from.tab_id;
      ev.push(["tab_closed", { tab_id: from.tab_id, workspace_id: from.workspace_id }]);
    }
    to.panes.push(pane.pane_id);
    pane.tab_id = to.tab_id;
    ev.push(["layout_updated", { layout: this.layoutOf(to) }]);
    return {
      type: "pane_move",
      move_result: {
        changed: true,
        ...base,
        pane: this.paneInfo(pane),
        ...(closed ? { closed_tab_id: closed } : {}),
        focused_pane_id: to.focused_pane_id,
      },
    };
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
      zoomed: false,
      focused_pane_id: null,
    };
    this.tabs.set(tab.tab_id, tab);
    return tab;
  }

  private newPane(tab: FakeTab, o: Partial<FakePane> & { user: boolean }): FakePane {
    const n = (this.nextPane.get(tab.workspace_id) ?? 0) + 1;
    this.nextPane.set(tab.workspace_id, n);
    const pane: FakePane = {
      pane_id: `${tab.workspace_id}:p${n}`,
      tab_id: tab.tab_id,
      workspace_id: tab.workspace_id,
      label: o.label ?? null,
      cwd: o.cwd ?? null,
      command: o.command ?? null,
      env: o.env ?? {},
      user: o.user,
      agent: null,
      metadata: [],
    };
    this.panes.set(pane.pane_id, pane);
    tab.panes.push(pane.pane_id);
    tab.focused_pane_id ??= pane.pane_id;
    return pane;
  }

  private removePane(pane: FakePane, ev?: Array<[string, Record<string, unknown>]>): void {
    this.panes.delete(pane.pane_id);
    const tab = this.tabs.get(pane.tab_id);
    if (!tab) return;
    tab.panes = tab.panes.filter((id) => id !== pane.pane_id);
    if (tab.focused_pane_id === pane.pane_id) tab.focused_pane_id = tab.panes[0] ?? null;
    if (tab.panes.length === 0) {
      this.tabs.delete(tab.tab_id);
      const closed: [string, Record<string, unknown>] = [
        "tab_closed",
        { tab_id: tab.tab_id, workspace_id: tab.workspace_id },
      ];
      if (ev) ev.push(closed);
      else this.emit(closed[0], closed[1]);
    }
  }

  private mustPane(id: unknown): FakePane {
    const p = this.panes.get(String(id));
    if (!p) throw new FakeError("pane_not_found", `pane ${String(id)} not found`);
    return p;
  }

  private mustTab(id: unknown): FakeTab {
    const t = this.tabs.get(String(id));
    if (!t) throw new FakeError("tab_not_found", `tab ${String(id)} not found`);
    return t;
  }

  private tabInfo(t: FakeTab): Record<string, unknown> {
    return {
      tab_id: t.tab_id,
      workspace_id: t.workspace_id,
      number: t.number,
      label: t.label,
      focused: this.focusedTab.get(t.workspace_id) === t.tab_id,
      pane_count: t.panes.length,
    };
  }

  private paneInfo(p: FakePane): Record<string, unknown> {
    return {
      pane_id: p.pane_id,
      workspace_id: p.workspace_id,
      tab_id: p.tab_id,
      label: p.label,
      ...(p.agent ? { agent: p.agent.agent, agent_status: p.agent.state } : {}),
    };
  }

  private layoutOf(t: FakeTab): Record<string, unknown> {
    return {
      workspace_id: t.workspace_id,
      tab_id: t.tab_id,
      zoomed: t.zoomed,
      focused_pane_id: t.focused_pane_id,
      panes: t.panes.map((pane_id) => ({ pane_id })),
    };
  }
}
