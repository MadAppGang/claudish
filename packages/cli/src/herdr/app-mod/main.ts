/**
 * The claudish mod for Herdr.app: a right-hand panel listing every claudish session on this
 * machine, each opening its live screen read only in a window. Built to
 * `herdr-app-mod/claudish/main.js` (ES module; `herdr`, `gpui-kit`, `gpui-base` and `crypto` are
 * the host's) and installed with `claudish herdr install-app-mod`.
 *
 * One file, three roles (`props().role`): the panel (default); `titlebar`, the bar of the window
 * a session shows in; `toggle`, a button that shows or hides the panel's layout node. The logic
 * is in `controller.ts` and `model.ts`; this file only adapts Herdr's host to it and draws.
 */

// biome-ignore lint/style/useNodejsImportProtocol: the Herdr.app mod runtime names this module "crypto"
import { createHash } from "crypto";
import { h_flex, v_flex } from "gpui-base";
import { type AsyncContext, View, div } from "gpui-kit";
import {
  closeOverlay,
  exec,
  hc,
  home,
  layout,
  openOverlay,
  props,
  readTextFile,
  run,
  terminals,
  theme,
  watchFolder,
} from "herdr";
import { type ModHost, PanelController } from "./controller.js";
import { type ModRow, isPanelVisible, panelNodeId, rowsOf } from "./model.js";

const host: ModHost = {
  exec: (command, args, options) => exec(command, args, options),
  hc: (args) => hc(args),
  readTextFile: (path) => readTextFile(path),
  terminals: () => terminals(),
  openOverlay: (spec) => openOverlay(spec),
  killTerminal: (address) => {
    run("terminal.kill", { terminal: address });
  },
  home: () => home(),
  sha256Hex: (s) => createHash("sha256").update(s).digest("hex"),
  now: () => Date.now(),
};

type Role = "panel" | "titlebar" | "toggle";

function roleOf(): Role {
  const role = props()?.role;
  return role === "titlebar" || role === "toggle" ? role : "panel";
}

const STATE_COLOUR: Record<ModRow["state"], string> = {
  working: "working",
  blocked: "blocked",
  done: "done",
  idle: "idle",
  error: "ansi1",
};

export default class ClaudishPanel extends View {
  private role: Role = "panel";
  private ctl: PanelController | null = null;

  init(_props: unknown, cx: AsyncContext): void {
    this.role = roleOf();
    if (this.role !== "panel") return;
    const ctl = new PanelController(host);
    this.ctl = ctl;
    cx.spawn(async (cx) => {
      await ctl.boot();
      cx.notify();
      let pendingWatch: Promise<unknown> | null = null;
      for (;;) {
        if (!ctl.visible || ctl.phase !== "ready") {
          await ctl.changed();
          continue;
        }
        await ctl.tick();
        cx.notify();
        const waits: Promise<unknown>[] = [
          cx.sleep(Math.max(250, ctl.nextWaitMs())),
          ctl.changed(),
        ];
        const dir = ctl.feedDir;
        if (ctl.watching && dir) {
          pendingWatch ??= watchFolder(dir)
            .catch(() => null)
            .finally(() => {
              pendingWatch = null;
            });
          waits.push(pendingWatch);
        }
        await Promise.race(waits);
      }
    });
  }

  async close(): Promise<void> {
    this.ctl?.closeViews();
  }

  render(cx: AsyncContext) {
    if (this.role === "titlebar") return this.renderTitlebar();
    if (this.role === "toggle") return this.renderToggle();
    const ctl = this.ctl;
    if (ctl) {
      ctl.setVisible(isPanelVisible(layout()));
      ctl.noteTerminals(terminals());
    }
    return this.renderPanel(cx, ctl);
  }

  private renderPanel(cx: AsyncContext, ctl: PanelController | null) {
    const t = theme();
    const rows = ctl ? rowsOf(ctl.items, ctl.selected) : [];
    const header = h_flex()
      .px(10)
      .py(6)
      .gap(6)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(div().font_semibold().text_color(t.foreground).child("claudish"))
      .child(
        div()
          .text_color(t.dim)
          .child(rows.length ? String(rows.length) : "")
      );
    const list = v_flex()
      .id("claudish-rows")
      .flex_1()
      .overflow_y_scrollbar()
      .children(rows.map((row) => this.renderRow(cx, row)));
    const note = ctl?.message
      ? div().px(10).py(6).text_size(12).text_color(t.muted).child(ctl.message)
      : div();
    return v_flex()
      .id("claudish-panel")
      .size_full()
      .bg(t.chrome ?? t.surface)
      .text_size(13)
      .child(header)
      .child(note)
      .child(list);
  }

  private renderRow(_cx: AsyncContext, row: ModRow) {
    const t = theme();
    const colour = t[STATE_COLOUR[row.state]] ?? t.dim;
    return h_flex()
      .id(`row-${row.target}`)
      .px(10)
      .py(5)
      .gap(8)
      .items_center()
      .cursor_pointer()
      .when(row.selected, (el: { bg: (c: string | undefined) => unknown }) => el.bg(t.selected))
      .hover((s: { bg: (c: string | undefined) => unknown }) => s.bg(t.hover))
      .on_click((_e: unknown, cx: AsyncContext) => {
        const ctl = this.ctl;
        if (!ctl) return;
        cx.spawn(async (cx) => {
          await ctl.select(row.target);
          cx.notify();
        });
      })
      .child(div().w(8).h(8).rounded(4).flex_none().bg(colour))
      .child(
        v_flex()
          .flex_1()
          .child(
            div()
              .truncate()
              .text_color(row.finished ? t.muted : t.foreground)
              .child(row.title)
          )
          .child(div().truncate().text_size(11).text_color(t.dim).child(row.detail))
      );
  }

  private renderTitlebar() {
    const t = theme();
    const p = props() ?? {};
    const terminal = typeof p.terminal === "string" ? p.terminal : null;
    const overlay = typeof p.overlay === "string" ? p.overlay : null;
    return h_flex()
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.surface)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .child(
        div()
          .flex_1()
          .truncate()
          .text_color(t.foreground)
          .child(`claudish · ${String(p.title ?? "")}`)
      )
      .child(div().text_color(t.dim).child("read only · Enter takes the view"))
      .child(
        div()
          .id("claudish-close")
          .px(6)
          .cursor_pointer()
          .text_color(t.muted)
          .hover((s: { text_color: (c: string | undefined) => unknown }) =>
            s.text_color(t.foreground)
          )
          .on_click(() => {
            // the window closes itself when its terminal ends; the viewer releases its claim
            if (terminal) run("terminal.kill", { terminal });
            else if (overlay) closeOverlay(overlay);
          })
          .child("✕")
      );
  }

  private renderToggle() {
    const t = theme();
    return div()
      .id("claudish-toggle")
      .px(8)
      .cursor_pointer()
      .text_color(t.muted)
      .hover((s: { text_color: (c: string | undefined) => unknown }) => s.text_color(t.foreground))
      .on_click(() => {
        const id = panelNodeId(layout());
        if (id) run("layout.toggle", { id });
      })
      .child("claudish");
  }
}
