/**
 * The claudish mod for Herdr.app: a right-hand panel of claudish runs on this machine. Run tabs on
 * top (the latest selected), the selected run's header and band rows, one tab per session of the
 * run with a Screen | Text switch, and the screen area: a live or replayed screen opens read only
 * in the keyed window, a session that never started shows its reason and records, and Text shows
 * the transcript. Built to `herdr-app-mod/claudish/main.js` (ES module; `herdr`, `gpui-kit`,
 * `gpui-base` and `crypto` are the host's) and installed with `claudish herdr install-app-mod`.
 *
 * One file, three roles (`props().role`): the panel (default); `titlebar`, the bar of the window
 * a session shows in; `toggle`, a button that shows or hides the panel's layout node. The logic
 * is in `controller.ts`, `runs.ts` and `model.ts`; this file only adapts Herdr's host to it and
 * draws.
 */

// biome-ignore lint/style/useNodejsImportProtocol: the Herdr.app mod runtime names this module "crypto"
import { createHash } from "crypto";
import { h_flex, v_flex } from "gpui-base";
import { type AsyncContext, type NativeElement, View, div } from "gpui-kit";
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
import { type ModHost, PanelController, PanelSeat } from "./controller.js";
import { isPanelVisible, panelNodeId } from "./model.js";
import { type Ink, type Palette, paletteFor } from "./palette.js";
import {
  type PanelRow,
  type PanelRun,
  type RunTab,
  failureCard,
  footerLine,
  recordCard,
  runTabs,
} from "./runs.js";

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

/** One panel among the copies Herdr may start (a docked one and a split pane). */
const seat = new PanelSeat();

type Role = "panel" | "titlebar" | "toggle";

function roleOf(): Role {
  const role = props()?.role;
  return role === "titlebar" || role === "toggle" ? role : "panel";
}

type Theme = Record<string, string>;
type El = NativeElement;

/** model lines shown at their own height; more than this scroll inside 240 px */
const ROWS_BEFORE_SCROLL = 6;
type Colour = `#${string}`;

/** A theme colour by name, as a `#rrggbb` the toolkit accepts; the fallback when it is missing. */
function colour(t: Theme, name: string, fallback: Colour): Colour {
  const v = t[name];
  return typeof v === "string" && v.startsWith("#") ? (v as Colour) : fallback;
}

function chip(text: string, ink: Ink, opts: { bold?: boolean; minW?: number } = {}): El {
  return div()
    .px(6)
    .py(1)
    .flex_none()
    .when(opts.minW !== undefined, (el: El) => el.min_w(opts.minW))
    .bg(ink.bg)
    .text_color(ink.fg)
    .when(opts.bold === true, (el: El) => el.font_bold())
    .whitespace_nowrap()
    .child(text);
}

export default class ClaudishPanel extends View {
  private role: Role = "panel";
  private ctl: PanelController | null = null;
  /** another copy holds the panel; this one only says so */
  private standby = false;

  init(_props: unknown, cx: AsyncContext): void {
    this.role = roleOf();
    if (this.role !== "panel") return;
    if (seat.take(this)) {
      this.startPanel(cx);
      return;
    }
    this.standby = true;
    cx.spawn(async (cx) => {
      while (!seat.take(this)) await seat.freed();
      this.standby = false;
      this.startPanel(cx);
      cx.notify();
    });
  }

  private startPanel(cx: AsyncContext): void {
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
    seat.release(this);
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

  /** Run a controller action from a click, then redraw. */
  private act(cx: AsyncContext, action: (ctl: PanelController) => Promise<void> | void): void {
    const ctl = this.ctl;
    if (!ctl) return;
    cx.spawn(async (cx) => {
      await action(ctl);
      cx.notify();
    });
  }

  private renderPanel(cx: AsyncContext, ctl: PanelController | null) {
    const t = theme();
    const p = paletteFor(t.background);
    const panel = v_flex()
      .id("claudish-panel")
      .size_full()
      .bg(colour(t, "chrome", colour(t, "surface", "#1B1D22")))
      .text_size(13)
      .on_size_change((size: { width: number }) => {
        if (ctl) ctl.width = size.width;
      });
    if (this.standby || !ctl) {
      const why = this.standby ? "claudish is open in another panel" : "starting";
      return panel.child(
        div()
          .px(14)
          .py(10)
          .text_color(colour(t, "muted", "#9AA0AB"))
          .child(why)
      );
    }
    const current = ctl.currentRun();
    const row = ctl.currentRow();
    const tabs = runTabs(ctl.runs(), current?.key ?? null, ctl.maxTabs(), Date.now());
    panel.child(this.runStrip(cx, ctl, tabs, t, p));
    if (ctl.earlierOpen && tabs.earlier.length > 0)
      panel.child(this.earlierList(cx, tabs.earlier, t, p));
    if (ctl.message)
      panel.child(
        div()
          .px(14)
          .py(6)
          .text_size(12)
          .text_color(colour(t, "muted", "#9AA0AB"))
          .child(ctl.message)
      );
    if (current) {
      panel.child(this.runHeader(ctl, current, t, p));
      panel.child(this.rowList(cx, current, row, t, p));
    }
    panel.child(this.screenArea(cx, ctl, row, t));
    if (row)
      panel.child(
        div()
          .px(14)
          .py(6)
          .border_t(1)
          .border_color(colour(t, "border", "#2C2F37"))
          .text_size(12)
          .text_color(colour(t, "dim", "#6F7581"))
          .truncate()
          .child(footerLine(row, ctl.mode))
      );
    return panel;
  }

  private tab(
    id: string,
    selected: boolean,
    t: Theme,
    onClick: (cx: AsyncContext) => void,
    children: El[]
  ): El {
    return h_flex()
      .id(id)
      .px(12)
      .py(7)
      .gap(6)
      .flex_none()
      .items_center()
      .cursor_pointer()
      .border_r(1)
      .border_color(colour(t, "border", "#2C2F37"))
      .when(selected, (el: El) =>
        el
          .bg(colour(t, "selected", "#262A33"))
          .font_bold()
          .border_b(2)
          .border_color(colour(t, "accent", "#6F9CE8"))
      )
      .hover((s: El) => s.bg(colour(t, "hover", "#23262D")))
      .on_click((_e: unknown, cx: AsyncContext) => onClick(cx))
      .children(children);
  }

  private dot(tone: keyof Palette["text"], p: Palette): El {
    return div().text_color(p.text[tone]).child("●");
  }

  private runStrip(
    cx: AsyncContext,
    ctl: PanelController,
    tabs: { tabs: RunTab[]; earlier: RunTab[] },
    t: Theme,
    p: Palette
  ): El {
    const strip = h_flex()
      .id("claudish-runs")
      .w_full()
      .overflow_hidden()
      .border_b(1)
      .border_color(colour(t, "border", "#2C2F37"))
      .bg(colour(t, "surface", "#17191D"));
    for (const r of tabs.tabs)
      strip.child(
        this.tab(`run-${r.key}`, r.selected, t, (cx) => this.act(cx, (c) => c.selectRun(r.key)), [
          this.dot(r.tone, p),
          div().truncate().max_w(160).child(r.name),
          div()
            .text_color(colour(t, "dim", "#7D8390"))
            .text_size(12)
            .child(r.age),
        ])
      );
    strip.child(div().flex_1());
    if (tabs.earlier.length > 0)
      strip.child(
        this.tab(
          "runs-earlier",
          ctl.earlierOpen,
          t,
          (cx) => this.act(cx, (c) => c.toggleEarlier()),
          [div().child(`+${tabs.earlier.length} earlier`)]
        )
      );
    void cx;
    return strip;
  }

  private earlierList(cx: AsyncContext, earlier: RunTab[], t: Theme, p: Palette): El {
    void cx;
    return v_flex()
      .id("claudish-earlier")
      .max_h(220)
      .overflow_y_scrollbar()
      .border_b(1)
      .border_color(colour(t, "border", "#2C2F37"))
      .children(
        earlier.map((r) =>
          h_flex()
            .id(`earlier-${r.key}`)
            .px(14)
            .py(5)
            .gap(8)
            .items_center()
            .cursor_pointer()
            .hover((s: El) => s.bg(colour(t, "hover", "#23262D")))
            .on_click((_e: unknown, cx: AsyncContext) => this.act(cx, (c) => c.selectRun(r.key)))
            .child(this.dot(r.tone, p))
            .child(div().flex_1().truncate().child(r.name))
            .child(
              div()
                .text_color(colour(t, "dim", "#7D8390"))
                .text_size(12)
                .child(r.age)
            )
        )
      );
  }

  private runHeader(ctl: PanelController, current: PanelRun, t: Theme, p: Palette): El {
    const muted = colour(t, "dim", "#7D8390");
    return h_flex()
      .flex_none()
      .px(14)
      .pt(10)
      .pb(4)
      .gap(10)
      .items_center()
      .child(div().flex_none().font_bold().text_color(p.mark).child("◆ claudish"))
      .child(div().flex_none().font_bold().child(current.name))
      .child(div().flex_none().text_color(muted).child(current.counts))
      .when(current.meta !== null, (el: El) =>
        el.child(
          div()
            .truncate()
            .text_color(muted)
            .child(current.meta ?? "")
        )
      )
      .child(div().flex_1())
      .child(this.modeToggle(ctl, t));
  }

  /** Screen | Text for the selected model line. */
  private modeToggle(ctl: PanelController, t: Theme): El {
    const toggle = h_flex()
      .flex_none()
      .rounded(6)
      .overflow_hidden()
      .border_1()
      .border_color(colour(t, "border", "#343842"));
    for (const mode of ["screen", "text"] as const)
      toggle.child(
        div()
          .id(`mode-${mode}`)
          .px(12)
          .py(4)
          .cursor_pointer()
          .when(ctl.mode === mode, (el: El) => el.bg(colour(t, "selected", "#262A33")).font_bold())
          .hover((s: El) => s.bg(colour(t, "hover", "#23262D")))
          .on_click((_e: unknown, cx: AsyncContext) => this.act(cx, (c) => c.setMode(mode)))
          .child(mode === "screen" ? "Screen" : "Text")
      );
    return toggle;
  }

  private rowList(
    cx: AsyncContext,
    current: PanelRun,
    selected: PanelRow | null,
    t: Theme,
    p: Palette
  ): El {
    void cx;
    return (
      v_flex()
        .id("claudish-rows")
        .flex_none()
        .px(14)
        .pt(4)
        .pb(10)
        .gap(4)
        // a scroll box takes its whole max height, so only a long run gets one
        .when(current.rows.length > ROWS_BEFORE_SCROLL, (el: El) =>
          el.max_h(240).overflow_y_scrollbar()
        )
        .children(current.rows.map((r) => this.bandRow(r, r.target === selected?.target, t, p)))
    );
  }

  private bandRow(r: PanelRow, selected: boolean, t: Theme, p: Palette): El {
    const [tokensIn, tokensOut] = r.tokens.includes(" ↓")
      ? [r.tokens.slice(0, r.tokens.indexOf(" ↓")), r.tokens.slice(r.tokens.indexOf(" ↓") + 1)]
      : [r.tokens, null];
    return h_flex()
      .id(`row-${r.target}`)
      .px(4)
      .py(3)
      .gap(6)
      .items_center()
      .rounded(4)
      .overflow_hidden()
      .cursor_pointer()
      .when(selected, (el: El) =>
        el
          .bg(colour(t, "selected", "#262A33"))
          .border_1()
          .border_color(colour(t, "border", "#3A4150"))
      )
      .hover((s: El) => s.bg(colour(t, "hover", "#23262D")))
      .on_click((_e: unknown, cx: AsyncContext) => this.act(cx, (c) => c.selectSlot(r.target)))
      .child(
        div()
          .w(22)
          .flex_none()
          .text_color(colour(t, "dim", "#8A909B"))
          .child(r.slot)
      )
      .child(chip(r.code, p.solid[r.tone], { bold: true, minW: 40 }))
      .child(div().w(44).flex_none().text_right().text_color(p.text[r.tone]).child(r.elapsed))
      .child(
        h_flex()
          .flex_none()
          .child(chip(r.model, p.solid.model, { bold: true }))
          .child(chip(r.provider, p.quiet.model))
      )
      .child(
        h_flex()
          .flex_none()
          .child(chip(tokensIn, p.tokensIn))
          .when(tokensOut !== null, (el: El) => el.child(chip(tokensOut ?? "", p.tokensOut)))
          .child(chip(r.tools, p.quiet.tools, { bold: true }))
          .child(chip(r.turns, p.quiet.loops, { bold: true }))
          .child(chip(r.billing, p.quiet.cost, { bold: true }))
      )
      .when(r.agent !== null, (el: El) =>
        el.child(
          div()
            .flex_none()
            .px(6)
            .border_1()
            .border_color(colour(t, "border", "#3A4150"))
            .text_color(colour(t, "muted", "#9AA0AB"))
            .child(r.agent ?? "")
        )
      )
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_color(r.error ? p.text.fail : colour(t, "muted", "#9AA0AB"))
          .child(r.note)
      );
  }

  /** The screen area: the transcript, the failure card, or where the screen is shown. */
  private screenArea(cx: AsyncContext, ctl: PanelController, row: PanelRow | null, t: Theme): El {
    void cx;
    const area = v_flex()
      .id("claudish-screen")
      .flex_1()
      .min_h(160)
      .px(16)
      .py(14)
      .bg(colour(t, "background", "#101114"))
      .text_color(colour(t, "foreground", "#CFD2D8"))
      .font_family("JetBrains Mono")
      .text_size(12)
      .overflow_y_scrollbar();
    const lines = (text: string[]): El[] =>
      text.map((l, i) =>
        div()
          .id(`line-${i}`)
          .whitespace_nowrap()
          .child(l === "" ? " " : l)
      );
    if (!row)
      return area.child(
        div()
          .text_color(colour(t, "muted", "#9AA0AB"))
          .child("no runs yet")
      );
    if (ctl.mode === "text") return area.children(lines(ctl.transcriptLines()));
    if (row.noScreen) return area.children(lines(failureCard(row, home())));
    if (row.recordOnly) return area.children(lines(recordCard(row, home())));
    const open = ctl.view?.target === row.target;
    const say = open
      ? row.finished
        ? "The replay of this session is open in the claudish window."
        : "The live screen of this session is open in the claudish window."
      : "This session's screen is not open.";
    return area
      .child(div().child(say))
      .child(div().child(" "))
      .child(
        div()
          .id("open-screen")
          .flex_none()
          .px(12)
          .py(5)
          .rounded(6)
          .border_1()
          .border_color(colour(t, "accent", "#6F9CE8"))
          .text_color(colour(t, "accent", "#6F9CE8"))
          .cursor_pointer()
          .on_click((_e: unknown, cx: AsyncContext) =>
            this.act(cx, (c) => c.selectSlot(row.target))
          )
          .child(
            open
              ? "Bring the window back"
              : row.finished
                ? "Open the replay"
                : "Open the live screen"
          )
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
