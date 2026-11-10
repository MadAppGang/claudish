import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/** @jsxImportSource @opentui/react */
/**
 * Tier 2 — `testRender` over the real component tree, with the loaders injected.
 *
 * `renderOnce()` IS MANDATORY before every capture, or every cell comes back as
 * unpainted filler and the assertion measures nothing.
 *
 * TWO CAPTURES, TWO BLINDNESSES. `captureCharFrame()` sees text and layout and is
 * BLIND to a wash of coloured spaces and to a one-column stub of background left
 * behind by a squeezed widget — a whole character-level suite once passed over a
 * mangled row. `captureSpans()` sees colour, which is where the severity tiers and
 * the selection wash live. Both are used here, for the things each can decide.
 *
 * THE ASSERTIONS THAT MATTER MOST ARE THE ONES ABOUT THE REJECTED BUILD. The owner's
 * report was "super unclear what is happening"; the diagnosis was two panes each
 * holding a cursor, and a meter on every row carrying a value that was identical on
 * 19 of 32 rows. So: exactly ONE cursor glyph on screen, and NO block-fill glyph in
 * any list row. Both are decidable from a frame, and both would have failed the
 * build that shipped.
 *
 * AND THE ONES ABOUT THE ROUND-TWO CORRECTION, which are about what the picker does
 * NOT do. `calls` counts every loader the fake is asked for, so "nothing is fetched
 * before the user asks for it" is an assertion rather than a claim in a comment —
 * and it is the one that would have caught the build the owner rejected, which
 * looked correct and simply did too much.
 *
 * THE DATA SOURCE IS A PARAMETER, NEVER `mock.module()`: mocking shared
 * infrastructure bleeds across Bun's module registry and breaks sibling e2e files.
 */
import type { CapturedFrame } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import type { ReactNode } from "react";
import { credentials } from "../auth/credentials/authority.js";
import type { ModelInfo, PickerDiscoveryOutcome } from "../model-selector.js";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "../providers/catalog-client.js";
import {
  LIVE_MS,
  deriveAccountKey,
  writeStoredModelsList,
} from "../providers/dynamic-models-catalog-store.js";
import * as accountModels from "../providers/dynamic-models-catalog.js";
import type { DescriptionIndex } from "../providers/model-descriptions.js";
import { C } from "../tui/theme.js";
import { ModelPicker } from "./ModelPicker.js";
import {
  type PickerDataSource,
  type PickerProviderChoice,
  createPickerDataSource,
} from "./PickerDataSource.js";
import { type Hint, hintsWidth } from "./chrome.js";
import { MAX_DIALOG_ROWS, deriveDialogLayout } from "./layout.js";
import { CHIP_FILL_CELLS } from "./rows.js";

// ── a scriptable source ──────────────────────────────────────────────────────────

const provider = (over: Partial<PickerProviderChoice> = {}): PickerProviderChoice => ({
  value: "kimi",
  label: "Kimi / Moonshot",
  shortcut: "kimi@",
  description: "Direct API",
  billing: "metered",
  envVar: "MOONSHOT_API_KEY",
  hasDiscovery: true,
  discoveryShape: "deadline",
  ...over,
});

const model = (over: Partial<ModelInfo> = {}): ModelInfo => ({
  id: "kimi-k3",
  name: "kimi-k3",
  description: "a model",
  provider: "Kimi",
  contextLength: 1_000_000,
  context: "1M",
  supportsTools: true,
  pricing: { input: "$1", output: "$2", average: "$9.00/1M" },
  ...over,
});

interface FakeOpts {
  providerList?: PickerProviderChoice[];
  ready?: Record<string, boolean>;
  outcome?: PickerDiscoveryOutcome;
  /** Per-provider discovery outcomes. Falls back to `outcome`. */
  outcomes?: Record<string, PickerDiscoveryOutcome>;
  /** Per-provider served lists; falls back to `served`. */
  byProvider?: Record<string, ModelInfo[]>;
  served?: ModelInfo[];
  /** `modelId` → prose sentence, as the description index answers. */
  descriptions?: Record<string, string>;
  /** Built-in local providers the profile config has not opted into. */
  notEnabledLocal?: string[];
  /** Delay the catalog and description loads without leaving them pending forever. */
  loadDelayMs?: number;
  /** Never settles — the in-flight states. */
  hang?: boolean;
}

/** Every loader the picker may reach for, counted. See the file header. */
interface Calls {
  catalog: number;
  descriptions: number;
  discover: string[];
}

function fakeSource(opts: FakeOpts = {}): PickerDataSource & { calls: Calls } {
  const providerList = opts.providerList ?? [provider()];
  const never = new Promise<never>(() => {});
  const descriptions = opts.descriptions ?? {};
  const calls: Calls = { catalog: 0, descriptions: 0, discover: [] };
  return {
    calls,
    providerList: () => providerList,
    notEnabledLocalProviders: () => opts.notEnabledLocal ?? [],
    displayName: (p) => providerList.find((r) => r.value === p)?.label ?? p,
    async *probeCredentials(names) {
      if (opts.hang) await never;
      for (const n of names) yield [n, opts.ready?.[n] ?? true] as [string, boolean];
    },
    ensureCatalog: (): Promise<void> => {
      calls.catalog++;
      return opts.hang
        ? never
        : opts.loadDelayMs === undefined
          ? Promise.resolve()
          : new Promise((resolve) => setTimeout(resolve, opts.loadDelayMs));
    },
    servedModels: (p) => opts.byProvider?.[p] ?? opts.served ?? [model()],
    discoverModelsCatalog: (p): Promise<PickerDiscoveryOutcome> => {
      calls.discover.push(p);
      return opts.hang
        ? never
        : Promise.resolve(
            opts.outcomes?.[p] ??
              opts.outcome ?? { kind: "rows", rows: [model()], servedCount: 1, chatCount: 1 }
          );
    },
    descriptions: (): Promise<DescriptionIndex> => {
      calls.descriptions++;
      const index = {
        get: (id: string) => descriptions[id],
        size: Object.keys(descriptions).length,
      };
      return opts.hang
        ? never
        : opts.loadDelayMs === undefined
          ? Promise.resolve(index)
          : new Promise((resolve) => setTimeout(() => resolve(index), opts.loadDelayMs));
    },
  };
}

interface Drawn {
  text: string[];
  frame: CapturedFrame;
  press: (keys: string[]) => Promise<void>;
  /** Re-render until the frame satisfies `pred`, or give up and let the assert speak. */
  until: (pred: (text: string[]) => boolean) => Promise<void>;
  recapture: () => { text: string[]; frame: CapturedFrame };
  destroy: () => void;
}

/** Always destroy in `finally`: a leaked renderer keeps native threads alive and hangs `bun test`. */
async function draw(node: ReactNode, width = 80, height = 24, settleMs = 30): Promise<Drawn> {
  const { renderOnce, captureCharFrame, captureSpans, renderer, mockInput } = await testRender(
    node,
    { width, height }
  );
  await renderOnce();
  if (settleMs > 0) {
    await new Promise((r) => setTimeout(r, settleMs));
    await renderOnce();
  }
  const recapture = (): { text: string[]; frame: CapturedFrame } => ({
    text: captureCharFrame().split("\n"),
    frame: captureSpans(),
  });
  return {
    ...recapture(),
    press: async (keys) => {
      await mockInput.pressKeys(keys as never);
      await new Promise((r) => setTimeout(r, 20));
      await renderOnce();
    },
    /**
     * A FIXED SLEEP AFTER A KEYSTROKE IS A FLAKE, and this suite proved it: the
     * keystroke that opens a list starts an effect, and on a loaded machine the
     * 20 ms after it is not always enough for the effect, the state update and the
     * next paint. Under `bun test` with 212 files in flight it failed once and
     * passed alone, which is the worst signal there is. Polling for the CONDITION
     * the test is about takes the load out of the assertion; the deadline is short
     * enough that a genuine regression still fails in well under a second.
     */
    until: async (pred) => {
      for (let i = 0; i < 40; i++) {
        if (pred(captureCharFrame().split("\n"))) return;
        await new Promise((r) => setTimeout(r, 25));
        await renderOnce();
      }
    },
    recapture,
    destroy: () => renderer.destroy(),
  };
}

const joined = (text: string[]): string => text.join("\n");
const bgs = (f: CapturedFrame): Set<string> =>
  new Set(f.lines.flatMap((l) => l.spans.map((s) => s.bg.toInts().slice(0, 3).join())));
const rgb = (hex: string): string =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join();
/** Every span in the frame, flattened — chips are spans, not rows. */
const spansOf = (f: CapturedFrame): CapturedFrame["lines"][number]["spans"] =>
  f.lines.flatMap((l) => l.spans);
/** The spans whose LABEL is `label`, whatever fill they carry. */
const labelled = (f: CapturedFrame, label: string): CapturedFrame["lines"][number]["spans"] =>
  spansOf(f).filter((sp) => sp.text.trim() === label);
const bgOf = (sp: CapturedFrame["lines"][number]["spans"][number]): string =>
  sp.bg.toInts().slice(0, 3).join();
/** Wait for a padded model id cell, not a header that also appears while loading. */
const modelRowPainted =
  (id: string) =>
  (text: string[]): boolean =>
    text.some((line) => line.includes(`${id}  `));
const providerListPainted = (t: string[]): boolean => t.join("").includes("choose a provider");
/** Rows that carry painted content — the dialog's actual footprint. */
const painted = (text: string[]): string[] => text.filter((l) => l.trim() !== "");
/**
 * The frame with its border glyphs and line breaks flattened away.
 *
 * A wrapped sentence is still ONE sentence to the reader, and an assertion that
 * cannot see across a wrap would pass a build that had truncated the half that
 * matters.
 */
const flat = (text: string[]): string =>
  text
    .join(" ")
    .replace(/[│┃▌╭╮╰╯─]/g, " ")
    .replace(/\s+/g, " ");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// ── the shape of the thing ───────────────────────────────────────────────────────

describe("the dialog", () => {
  test("is COMPACT and INLINE — it does not fill a 45-row terminal", async () => {
    // The whole correction, in one assertion. The rejected build was
    // `height={terminalHeight}` on the alternate screen; this one is a box that
    // leaves the user's shell on screen around it.
    const d = await draw(<ModelPicker source={fakeSource()} onDone={() => {}} />, 145, 45);
    try {
      expect(painted(d.text).length).toBeLessThanOrEqual(20);
      // …and it is horizontally bounded too, not a full-width strip.
      expect(Math.max(...painted(d.text).map((l) => l.trimEnd().length))).toBeLessThan(145);
    } finally {
      d.destroy();
    }
  });

  test("has EXACTLY ONE cursor — the direct answer to “unclear what is happening”", async () => {
    // Two panes each held a cursor and only a border colour said which one the arrow
    // keys drove. One list, one `▶` — on the landing screen and inside a list alike.
    const providerList = ["openrouter", "kimi", "google"].map((v) =>
      provider({ value: v, label: v, shortcut: `${v}@`, hasDiscovery: false })
    );
    const d = await draw(
      <ModelPicker
        source={fakeSource({ providerList, served: [model({ id: "a" }), model({ id: "b" })] })}
        onDone={() => {}}
      />
    );
    try {
      expect(joined(d.text).split("▶").length - 1).toBe(1);
      await d.press(["a"]);
      await d.until(modelRowPainted("a"));
      expect(joined(d.recapture().text).split("▶").length - 1).toBe(1);
    } finally {
      d.destroy();
    }
  });

  test("NO list row carries a bar, a gradient or a block fill", async () => {
    // The rejected build put a context meter and a price meter on every row because a
    // whole-frame graphics-density gate counted a row with a bar as a graphics row.
    // Of 32 visible rows, 19 read `1M` and their bars were indistinguishable.
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          providerList: [provider({ hasDiscovery: false })],
          served: [
            model({ id: "a", contextLength: 1_000_000, context: "1M" }),
            model({ id: "b", contextLength: 8_000, context: "8K" }),
          ],
        })}
        onDone={() => {}}
      />
    );
    try {
      await d.press(["a"]);
      await d.until(modelRowPainted("a"));
      const rows = d.recapture().text.filter((l) => /\ba\b|\bb\b/.test(l));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).not.toMatch(/[█▓▒░╌]/);
    } finally {
      d.destroy();
    }
  });

  test("no rendered row exceeds the frame width, at 80 and at 145", async () => {
    for (const [width, height] of [
      [80, 24],
      [145, 45],
    ] as const) {
      const d = await draw(<ModelPicker source={fakeSource()} onDone={() => {}} />, width, height);
      try {
        expect({ width, over: d.text.filter((l) => l.length > width) }).toEqual({
          width,
          over: [],
        });
        await d.press(["a"]);
        await d.until(modelRowPainted("kimi-k3"));
        expect({
          width,
          over: d.recapture().text.filter((l) => l.length > width),
        }).toEqual({ width, over: [] });
      } finally {
        d.destroy();
      }
    }
  });

  test("the key hints are present and unclipped at 80×24, in BOTH lists", async () => {
    const d = await draw(
      <ModelPicker
        source={fakeSource({ providerList: [provider({ hasDiscovery: false })] })}
        onDone={() => {}}
      />
    );
    try {
      // The hints row is the last PAINTED row above the bottom border.
      const footer = (): string => painted(d.recapture().text).at(-2) ?? "";
      // THE PROVIDER ROW DOES NOT SAY `move`, AND THAT IS THE ONE DELIBERATE
      // DIFFERENCE BETWEEN THE TWO FOOTERS. Announcing `/ filter` cost 11 cells on a
      // row that was already 70 against 72, and the arrows are the hint that repeats
      // what every list in this program does. The budget half of that claim is the
      // test below; this half is that the row still names every OTHER action.
      for (const hint of ["open", "filter", "all models", "show", "custom", "quit"]) {
        expect(footer()).toContain(hint);
      }
      expect(footer()).not.toContain("move");
      await d.press(["a"]);
      await d.until(modelRowPainted("kimi-k3"));
      for (const hint of ["move", "select", "filter", "custom", "back"]) {
        expect(footer()).toContain(hint);
      }
    } finally {
      d.destroy();
    }
  });

  test("THE SIX-PILL FOOTER — the widest row any screen builds — is unclipped at 80", async () => {
    // THE TEST ABOVE CANNOT CATCH THIS. It renders `hasDiscovery: false`, so `r
    // retry` is absent and the row is FIVE pills. The row that actually overflowed is
    // the six-pill one a DISCOVERY provider draws: it rendered `esc provider` at 80
    // columns and nothing reported it, because `Hints` sets `overflow="hidden"` and a
    // dropped cell is not an error. A screenshot found it, which is the wrong place
    // to find arithmetic.
    //
    // The pill construction is what made the row expensive — each hint went from
    // `key + label + 3` cells to `key + label + 4`, six of them — and the next hint
    // anyone adds will cost the same.
    const d = await draw(
      <ModelPicker
        source={fakeSource({ providerList: [provider({ hasDiscovery: true })], served: [model()] })}
        onDone={() => {}}
      />
    );
    try {
      await d.until(providerListPainted);
      await d.press(["RETURN"]);
      await d.until(modelRowPainted("kimi-k3"));
      const footer = painted(d.recapture().text).at(-2) ?? "";
      // `r retry` proves this really is the six-pill row and not the five-pill one.
      for (const hint of ["move", "select", "filter", "retry", "custom", "back"]) {
        expect({ hint, footer, present: footer.includes(hint) }).toEqual({
          hint,
          footer,
          present: true,
        });
      }
    } finally {
      d.destroy();
    }

    // AND THE BUDGET IS GENUINELY TIGHT — the half that stops the fit above from
    // being a coincidence. These are the two labels the rows gave up to pay for the
    // pills; each one, put back, overflows the dialog's inner width on its own.
    const inner = deriveDialogLayout(80, 24).inner;
    const withLabel = (hints: Hint[], key: string, label: string): Hint[] =>
      hints.map((h) => (h.key === key ? { ...h, label } : h));
    const providerList: Hint[] = [
      { key: "⏎", label: "open" },
      { key: "/", label: "filter" },
      { key: "a", label: "all models" },
      { key: "k", label: "show" },
      { key: "c", label: "custom" },
      { key: "esc", label: "quit" },
    ];
    const scopedList: Hint[] = [
      { key: "↑↓", label: "move" },
      { key: "⏎", label: "select" },
      { key: "/", label: "filter" },
      { key: "r", label: "retry" },
      { key: "c", label: "custom" },
      { key: "esc", label: "back" },
    ];
    expect({
      providerRowFits: hintsWidth(providerList) <= inner,
      // …in BOTH of its states: `esc` says `clear` while a filter is on, which is one
      // cell more than `quit` and lands exactly on the budget.
      providerRowFitsWhileFiltering: hintsWidth(withLabel(providerList, "esc", "clear")) <= inner,
      scopedRowFits: hintsWidth(scopedList) <= inner,
      needsKeyWouldNotFit: hintsWidth(withLabel(providerList, "k", "needs key")) > inner,
      providersWouldNotFit: hintsWidth(withLabel(scopedList, "esc", "providers")) > inner,
      // AND THE HINT THE PROVIDER ROW GAVE UP TO CARRY `/ filter` REALLY DOES NOT
      // FIT. `↑↓ move` is on the model list's footer and not on this one; that asymmetry
      // is a measurement, and this is the measurement.
      arrowsWouldNotFit:
        hintsWidth([{ key: "↑↓", label: "move" }, ...providerList]) > inner &&
        hintsWidth([{ key: "↑↓", label: "move" }, ...withLabel(providerList, "esc", "clear")]) >
          inner,
    }).toEqual({
      providerRowFits: true,
      providerRowFitsWhileFiltering: true,
      scopedRowFits: true,
      needsKeyWouldNotFit: true,
      providersWouldNotFit: true,
      arrowsWouldNotFit: true,
    });
  });
});

// ── the chips: a fill is invisible to a character frame ──────────────────────────

describe("the billing and prefix CHIPS", () => {
  const providerList = [
    provider({ value: "cx", label: "OpenAI Codex", shortcut: "cx@", billing: "sub" }),
    provider({ value: "or", label: "OpenRouter", shortcut: "or@", billing: "metered" }),
  ];

  test("THE PREFIX COLUMN IS NOT A BAND: a routing identifier carries no fill", async () => {
    // THE REJECTED PASS CHIPPED IT, and `captureCharFrame` was blind to the result:
    // every one of the 17 provider rows had a fill in the prefix cell, with no blank
    // row between them, so the column fused into a solid grey vertical band with the
    // labels floating inside. The owner's verdict was "that is super ugly". A fill
    // marks a STATE; a prefix is an identifier with no states, so there is nothing
    // in that column for a fill to mark. (The billing cell beside it is the opposite
    // case and is chipped — see the two tests below.)
    const d = await draw(<ModelPicker source={fakeSource({ providerList })} onDone={() => {}} />);
    try {
      await d.until(providerListPainted);
      const f = d.recapture().frame;
      for (const token of ["cx@", "or@"]) {
        const spans = spansOf(f).filter((sp) => sp.text.includes(token));
        expect({ token, found: spans.length > 0 }).toEqual({ token, found: true });
        for (const sp of spans) {
          // The row's own background — the panel, or the selection wash on the row
          // under the cursor — and never a fill of the cell's own.
          expect({ token, bg: bgOf(sp) }).toEqual({
            token,
            bg: bgOf(sp) === rgb(C.bgHighlight) ? rgb(C.bgHighlight) : rgb(C.bgAlt),
          });
        }
      }
    } finally {
      d.destroy();
    }
  });

  test("`$$$` IS A CHIP TOO, ON THE COST FILL — and it is not the failure red", async () => {
    // The owner's instruction, verbatim: "instead of $ it should be '$$$' with light
    // reddish colour". The LABEL is the half a character frame can see; the FILL is
    // the half it cannot, and the fill is where this goes wrong expensively —
    // reddish is the hue the `HTTP 401` badge and the discovery banner already own,
    // so a cost chip that picked one of those up would paint a failure on every
    // healthy metered row. Hence both assertions, on the spans.
    const d = await draw(<ModelPicker source={fakeSource({ providerList })} onDone={() => {}} />);
    try {
      await d.until(providerListPainted);
      const f = d.recapture().frame;
      const dollars = labelled(f, "$$$");
      expect(dollars.length).toBeGreaterThan(0);
      // And the label it REPLACED is gone from the column rather than merely joined
      // by the new one: a lone `$` chip surviving here is the half-applied edit.
      expect(labelled(f, "$")).toEqual([]);
      for (const chip of dollars) {
        expect(bgOf(chip)).toBe(rgb(C.pillCostBg));
        // Never the no-charge family's fill, and never a row background: a `$$$` that
        // picked up `pillKeyBg` would claim the route costs nothing.
        expect(bgOf(chip)).not.toBe(rgb(C.pillKeyBg));
        expect(bgOf(chip)).not.toBe(rgb(C.bgAlt));
        // NEVER THE FAILURE FILLS. `theme-contrast.test.ts` measures how far apart
        // they have to be; this pins that they are not literally the same object,
        // which is the version of the mistake a hurried edit actually makes.
        expect(bgOf(chip)).not.toBe(rgb(C.red));
        expect(bgOf(chip)).not.toBe(rgb(C.bgError));
        expect(chip.fg.toInts().slice(0, 3).join()).toBe(rgb(C.pillCostFg));
      }
      expect(rgb(C.pillCostBg)).not.toBe(rgb(C.pillKeyBg));
    } finally {
      d.destroy();
    }
  });

  test("`SUB` IS PAINTED ON THE POSITIVE FILL, AND NEVER ON THE FAILURE ONE", async () => {
    // THE DEFECT THIS PINS SHIPPED, AND `captureCharFrame` IS BLIND TO IT. The frame
    // reads `SUB` either way; only the FILL says whether the user is being told
    // "you already pay for this" or "something went wrong". It was `tokens.warn` —
    // `C.orange`, the hue this dialog spends on a failure — under a label that means
    // the opposite of a failure.
    const d = await draw(<ModelPicker source={fakeSource({ providerList })} onDone={() => {}} />);
    try {
      await d.until(providerListPainted);
      const chips = labelled(d.recapture().frame, "SUB");
      expect(chips.length).toBeGreaterThan(0);
      for (const chip of chips) {
        expect(bgOf(chip)).toBe(rgb(C.pillKeyBg));
        expect(bgOf(chip)).not.toBe(rgb(C.red));
        expect(bgOf(chip)).not.toBe(rgb(C.orange));
      }
    } finally {
      d.destroy();
    }
  });

  test("EVERY STATUS CHIP IS THE SAME WIDTH, and the cell's surplus stays unfilled", async () => {
    // ONE COLUMN, ONE FILL WIDTH — the owner asked for `$$$` and `SUB` at the same
    // width, and a 1-cell fill beside a 5-cell one is what he was looking at. The
    // label is centred INSIDE the fill, which is the one sanctioned place for that
    // (`rows.tsx` header): a column wants straight edges, and the rule it bends was
    // measured on a ROW of 24 identical chips.
    //
    // WHAT IS STILL FORBIDDEN, AND WHAT THIS STILL GUARDS: padding the fill out to
    // the CELL. `label={padTo("SUB", 9)}` looks like the same thing and is not — the
    // price cell is 9 columns and the billing cell 7, so a fill sized to the cell
    // would paint two different widths and, in a column of one repeated word, one
    // unbroken rectangle. The surplus is a plain filler span outside `bg`.
    const d = await draw(<ModelPicker source={fakeSource({ providerList })} onDone={() => {}} />);
    try {
      await d.until(providerListPainted);
      const f = d.recapture().frame;
      const status = spansOf(f).filter(
        (sp) => bgOf(sp) === rgb(C.pillKeyBg) || bgOf(sp) === rgb(C.pillCostBg)
      );
      expect(status.length).toBeGreaterThan(0);
      // Every fill in the column is CHIP_FILL_CELLS wide, whatever its label…
      expect([...new Set(status.map((sp) => sp.text.length))]).toEqual([CHIP_FILL_CELLS]);
      // …and the label is centred in it rather than padded to one side.
      for (const sp of status) {
        const label = sp.text.trim();
        const slack = CHIP_FILL_CELLS - 2 - label.length;
        const left = Math.floor(slack / 2);
        expect({ text: sp.text }).toEqual({
          text: `${" ".repeat(left + 1)}${label}${" ".repeat(slack - left + 1)}`,
        });
      }
      // A footer keycap is a DIFFERENT object with the original contract: each of the
      // pill's two segments is exactly `text + 2`, because a row of keys is not a
      // column of states — nothing there has to line up with anything below it.
      const caps = spansOf(f).filter(
        (sp) => bgOf(sp) === rgb(C.keycapKeyBg) || bgOf(sp) === rgb(C.keycapLabelBg)
      );
      expect(caps.length).toBeGreaterThan(0);
      for (const sp of caps) {
        expect({ text: sp.text }).toEqual({ text: ` ${sp.text.trim()} ` });
      }
    } finally {
      d.destroy();
    }
  });

  test("A FOOTER KEYCAP IS A TWO-SEGMENT PILL — key filled, label filled, no gap", async () => {
    // The owner asked for chips, twice. First the key was a grey word (1.50:1 on a
    // dark page, 2.38:1 on a light one — invisible on whichever terminal it was not
    // tuned for), then a lone purple block beside bare text. What he asked for is one
    // pill of two halves: *"the key itself brighter colour and label has backdrop but
    // not as bright"*.
    //
    // `captureCharFrame` reads ` esc  quit ` under every one of those builds. Only
    // the FILLS say whether it is a pill, and only their ADJACENCY says whether it is
    // one object or two — which is why this asserts the two segments touch.
    const d = await draw(<ModelPicker source={fakeSource({ providerList })} onDone={() => {}} />);
    try {
      await d.until(providerListPainted);
      const f = d.recapture().frame;
      const caps = labelled(f, "esc");
      expect(caps.length).toBeGreaterThan(0);
      for (const cap of caps) {
        expect(bgOf(cap)).toBe(rgb(C.keycapKeyBg));
        expect(bgOf(cap)).not.toBe(rgb(C.chipKeyBg));
        expect(cap.fg.toInts().slice(0, 3).join()).toBe(rgb(C.keycapKeyFg));
      }
      // THE SEAM. The label segment is the NEXT span after the key segment, with no
      // unfilled span between them — a single space on the panel background there is
      // what splits the pill into two objects, and it is invisible in a char frame.
      const line = f.lines.find((l) => l.spans.some((sp) => sp.text.trim() === "esc"));
      expect(line).toBeDefined();
      const at = line!.spans.findIndex((sp) => sp.text.trim() === "esc");
      const next = line!.spans[at + 1];
      expect({ text: next?.text, bg: next === undefined ? null : bgOf(next) }).toEqual({
        text: " quit ",
        bg: rgb(C.keycapLabelBg),
      });
    } finally {
      d.destroy();
    }
  });

  test("NO CHIP COLUMN FUSES: a flat-rate provider's models print words, not a green slab", async () => {
    // A scoped subscription provider answers `SUB` for EVERY row, so a chipped price
    // column there is the rectangle by construction — and no amount of correct
    // padding prevents it, because the padding is not what makes the fills identical.
    // `kimi-coding` is a real `SUBSCRIPTION_PROVIDERS` uid, so the price resolver
    // answers `SUB` here exactly as it does on the live screen the owner was reading.
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          providerList: [
            provider({
              value: "kimi-coding",
              label: "Kimi Coding",
              shortcut: "kc@",
              billing: "sub",
              hasDiscovery: false,
            }),
          ],
          served: Array.from({ length: 8 }, (_, i) => model({ id: `m-${i}` })),
          byProvider: {
            "kimi-coding": Array.from({ length: 8 }, (_, i) => model({ id: `m-${i}` })),
          },
        })}
        onDone={() => {}}
      />,
      145,
      45
    );
    try {
      await d.press(["RETURN"]);
      await d.until(modelRowPainted("m-7"));
      const shot = d.recapture();
      // Every row says SUB in words…
      expect(shot.text.filter((l) => /\bm-\d\b/.test(l) && l.includes("SUB")).length).toBe(8);
      // …and not one of them carries a FILL, so there is no column to fuse.
      expect(spansOf(shot.frame).filter((sp) => bgOf(sp) === rgb(C.pillKeyBg))).toEqual([]);
    } finally {
      d.destroy();
    }
  });

  test("INSIDE A PROVIDER THE PROVIDER COLUMN IS GONE, and the id takes its cells", async () => {
    // `OpenAI Codex` printed 49 times under a dialog titled `OpenAI Codex`. The header
    // must lose the label with the cells, or it points at a column that is not there.
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          providerList: [
            provider({ value: "openrouter", label: "OpenRouter", hasDiscovery: false }),
          ],
          byProvider: { openrouter: [model({ id: "gpt-6-astra" })] },
        })}
        onDone={() => {}}
      />,
      145,
      45
    );
    try {
      await d.press(["RETURN"]);
      await d.until(modelRowPainted("gpt-6-astra"));
      const scoped = d.recapture().text;
      const header = scoped.find((l) => l.includes("ctx") && l.includes("$/1M")) ?? "";
      expect(header).not.toContain("provider");
      expect(scoped.filter((l) => /gpt-6-astra\s{2,}/.test(l) && l.includes("OpenRouter"))).toEqual(
        []
      );
      // It is still the whole point of the CROSS-PROVIDER list, so it stays there.
      await d.press(["ESCAPE"]);
      await d.until(providerListPainted);
      await d.press(["a"]);
      await d.until(modelRowPainted("kimi-k3"));
      const flat = d.recapture().text;
      expect(flat.find((l) => l.includes("ctx") && l.includes("$/1M")) ?? "").toContain("provider");
    } finally {
      d.destroy();
    }
  });
});

// ── the landing screen, and everything it does NOT do ────────────────────────────

describe("the picker opens on the PROVIDER list", () => {
  const providerList = [
    provider({
      value: "openrouter",
      label: "OpenRouter",
      shortcut: "or@",
      envVar: "OPENROUTER_API_KEY",
      hasDiscovery: false,
    }),
    provider({ value: "kimi-coding", label: "Kimi Coding", shortcut: "kc@", hasDiscovery: true }),
  ];

  test("lands on providers — not on a 574-row list of every model", async () => {
    // The owner, verbatim: "we should not show the full list of models, we should
    // show a list of providers by default and only when we go inside we load and
    // resolve all models".
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          providerList,
          byProvider: { openrouter: [model({ id: "glm-5.3" })] },
        })}
        onDone={() => {}}
      />
    );
    try {
      const all = joined(d.text);
      expect(all).toContain("choose a provider");
      expect(all).toContain("OpenRouter");
      // Not one model id, because nothing has been asked for one.
      expect(all).not.toContain("glm-5.3");
    } finally {
      d.destroy();
    }
  });

  test("FETCHES NOTHING before the user asks — no catalog, no dynamic models catalog, no descriptions", async () => {
    // "why we prefetching? we should not, as we show on demand". The build this
    // replaces warmed the cloud catalog AND fanned out one dynamic models catalog request per
    // credentialled provider, on a screen that could show neither.
    const source = fakeSource({ providerList });
    const d = await draw(<ModelPicker source={source} onDone={() => {}} />);
    try {
      expect(source.calls).toEqual({ catalog: 0, descriptions: 0, discover: [] });
      // …and the screen does not claim to be doing any of it.
      expect(joined(d.text)).not.toContain("cloud catalog");
      // No per-provider discovery meter — the rejected `0/11 providers` fan-out.
      expect(joined(d.text)).not.toMatch(/\d+\/\d+ providers/);
    } finally {
      d.destroy();
    }
  });

  test("a provider with NO credential is off the list, and `k` reveals it WITH its reason", async () => {
    // "we should not show unsetted providers, just active". Not deleted — reachable,
    // because an unexplained absence is the defect class this feature exists to
    // remove.
    //
    // THE SUMMARY LINE THAT USED TO COUNT THEM IS GONE, on the owner's instruction
    // ("remove this, 5 lines which has no value"), and this test is where that has to
    // be paid for: the whole explanation now lives on the REVEALED ROW, so `k` must
    // still reach it and the row must still say why. A build that hid the count and
    // also dropped the reason would have looked fine on a screenshot of the default
    // state, which is the only state a screenshot was ever taken of.
    const d = await draw(
      <ModelPicker
        source={fakeSource({ providerList, ready: { openrouter: true, "kimi-coding": false } })}
        onDone={() => {}}
      />
    );
    try {
      const before = joined(d.text);
      expect(before).toContain("OpenRouter");
      expect(before).not.toContain("Kimi Coding");
      expect(before).not.toContain("MOONSHOT_API_KEY");
      // And the deleted line is really deleted, in the state that used to print it.
      expect(before).not.toContain("more need a key");

      await d.press(["k"]);
      const after = joined(d.recapture().text);
      expect(after).toContain("Kimi Coding");
      // Revealed WITH the exact variable to inspect, which is the whole value of
      // showing them at all — and now the ONLY place that fact appears.
      expect(after).toContain("MOONSHOT_API_KEY");
    } finally {
      d.destroy();
    }
  });

  test("NO model count is printed for a provider nothing has counted yet", async () => {
    // "we could not show number of models for some of them". A `0`, a `—` or a guess
    // in that column is a claim; silence is not.
    const d = await draw(<ModelPicker source={fakeSource({ providerList })} onDone={() => {}} />);
    try {
      const row = d.text.find((l) => l.includes("OpenRouter")) ?? "";
      expect(row).toContain("OpenRouter");
      expect(row).not.toMatch(/\bmodels?\b/);
      expect(row).not.toContain("—");
    } finally {
      d.destroy();
    }
  });

  test("Escape on the landing screen CANCELS by returning null — never `process.exit`", async () => {
    let got: string | null | undefined;
    const d = await draw(
      <ModelPicker
        source={fakeSource({ providerList })}
        onDone={(spec) => {
          got = spec;
        }}
      />
    );
    try {
      await d.press(["ESCAPE"]);
      expect(got).toBeNull();
    } finally {
      d.destroy();
    }
  });
});

// ── the two summary lines are gone, and their content moved onto the rows ───────

describe("`k` reveals BOTH kinds of unavailable provider, each with its own reason", () => {
  // The owner deleted the two lines under the list — *"remove this, 5 lines which has
  // no value"* — and they were the only place the screen distinguished a provider
  // missing a CREDENTIAL from a local one that is merely not ENABLED. The distinction
  // is real (one sends you to find an API key, the other to a config flag), so it had
  // to land somewhere: it is now each row's own tail.
  const providerList = [
    provider({ value: "openrouter", label: "OpenRouter", shortcut: "or@", hasDiscovery: false }),
    provider({ value: "kimi-coding", label: "Kimi Coding", shortcut: "kc@", hasDiscovery: false }),
    provider({
      value: "ollama",
      label: "Ollama (local)",
      shortcut: "ollama@",
      billing: "local",
      envVar: "",
      hasDiscovery: true,
    }),
  ];

  test("neither summary line is on the screen any more", async () => {
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          providerList,
          ready: { openrouter: true, "kimi-coding": false, ollama: false },
          notEnabledLocal: ["ollama"],
        })}
        onDone={() => {}}
      />
    );
    try {
      await d.until(providerListPainted);
      const before = joined(d.recapture().text);
      expect(before).not.toContain("more need a key");
      expect(before).not.toContain("not enabled in your config");
      // And the rows themselves are still hidden, which is what the lines described.
      expect(before).not.toContain("Kimi Coding");
      expect(before).not.toContain("Ollama");
    } finally {
      d.destroy();
    }
  });

  test("and `k` brings both back, each saying WHY it cannot be used", async () => {
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          providerList,
          ready: { openrouter: true, "kimi-coding": false, ollama: false },
          notEnabledLocal: ["ollama"],
        })}
        onDone={() => {}}
      />
    );
    try {
      await d.until(providerListPainted);
      await d.press(["k"]);
      await d.until((t) => t.join("").includes("Ollama"));
      const after = joined(d.recapture().text);
      // A cloud provider names the credential — the actionable fact.
      expect(after).toContain("Kimi Coding");
      expect(after).toContain("MOONSHOT_API_KEY");
      // A local one names the config, because nothing is missing: it is opt-in and
      // has not been opted into. Sending this user to look for an API key would send
      // him after something that does not exist.
      expect(after).toContain("Ollama");
      expect(after).toContain("not enabled in config");
      expect(after).not.toContain("needs sign-in");
    } finally {
      d.destroy();
    }
  });
});

// ── the provider list filters, in the model list's own idiom ────────────────────

describe("the PROVIDER list filters as you type", () => {
  // The owner: *"we need inline search in list of providers as well"*. It was a
  // deliberate omission — 17 named rows do not need narrowing — and the point of this
  // block is that what was added is the SAME interaction as the model list, not a
  // second one to learn.
  const providerList = [
    provider({ value: "openrouter", label: "OpenRouter", shortcut: "or@", hasDiscovery: false }),
    provider({ value: "kimi-coding", label: "Kimi Coding", shortcut: "kc@", hasDiscovery: false }),
    provider({ value: "google", label: "Google Gemini", shortcut: "go@", hasDiscovery: false }),
  ];

  test("typing NARROWS the list, and the count on the right follows it", async () => {
    const d = await draw(<ModelPicker source={fakeSource({ providerList })} onDone={() => {}} />);
    try {
      await d.until(providerListPainted);
      expect(joined(d.recapture().text)).toContain("OpenRouter");

      // `im`, not `kimi`: `k` is a COMMAND while the filter is empty (see the test
      // below), so a bare `k` would toggle the hidden providers instead of typing.
      await d.press(["i", "m"]);
      const after = joined(d.recapture().text);
      expect(after).toContain("Kimi Coding");
      expect(after).not.toContain("OpenRouter");
      expect(after).not.toContain("Google Gemini");
      // The same `matches of total` the model list prints, from the same component.
      expect(after).toContain("1 of 3");
    } finally {
      d.destroy();
    }
  });

  test("the SHORTCUT matches too, because `kc@` is what the row shows beside the name", async () => {
    // Two vocabularies reach the same row — what it is called and how it is routed —
    // and a user who knows the prefix should not have to remember the display name.
    const d = await draw(<ModelPicker source={fakeSource({ providerList })} onDone={() => {}} />);
    try {
      await d.until(providerListPainted);
      // `/` first, because `kc@` starts with one of the three command letters — which
      // is precisely the case the escape hatch exists for.
      await d.press(["/"]);
      await d.press(["k", "c"]);
      const after = joined(d.recapture().text);
      expect(after).toContain("Kimi Coding");
      expect(after).not.toContain("OpenRouter");
    } finally {
      d.destroy();
    }
  });

  test("`k` TYPES once the filter is live — it does not toggle the hidden providers", async () => {
    // THE RULE THE MODEL LIST ALREADY HAD, AND THE REASON IT EXISTS. A letter that is
    // a command while the filter is empty must become a letter once it is not, or
    // narrowing to `kimi` fires `k` (reveal), `i`, `m`, `i` and the user watches the
    // screen do something else entirely. `k` is the sharpest case here because its
    // command is a VISIBLE toggle.
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          providerList,
          ready: { openrouter: true, "kimi-coding": true, google: false },
        })}
        onDone={() => {}}
      />
    );
    try {
      await d.until(providerListPainted);
      // First `k` is the command: the credential-less provider appears.
      await d.press(["k"]);
      expect(joined(d.recapture().text)).toContain("Google Gemini");
      await d.press(["ESCAPE"]);
      // `/` focuses the filter, so the NEXT `k` is a letter even though the filter is
      // still empty — which is the whole point of the escape hatch.
      await d.press(["/"]);
      await d.press(["k"]);
      const after = joined(d.recapture().text);
      expect(after).toContain("Kimi Coding");
      expect(after).not.toContain("OpenRouter");
    } finally {
      d.destroy();
    }
  });

  test("`esc` CLEARS the filter first and only then quits — the model list's rule", async () => {
    let got: string | null | undefined;
    const d = await draw(
      <ModelPicker
        source={fakeSource({ providerList })}
        onDone={(spec) => {
          got = spec;
        }}
      />
    );
    try {
      await d.until(providerListPainted);
      await d.press(["i", "m"]);
      expect(joined(d.recapture().text)).not.toContain("OpenRouter");

      await d.press(["ESCAPE"]);
      await d.until((t) => t.join("").includes("OpenRouter"));
      // Cleared, NOT cancelled: the whole list is back and the picker is still open.
      expect(got).toBeUndefined();
      const cleared = joined(d.recapture().text);
      expect(cleared).toContain("OpenRouter");
      expect(cleared).toContain("Google Gemini");

      // And the second `esc`, with nothing to clear, is the landing view's cancel.
      await d.press(["ESCAPE"]);
      expect(got).toBeNull();
    } finally {
      d.destroy();
    }
  });

  test("a filter that matches nothing SAYS SO, and says how to get out", async () => {
    const d = await draw(<ModelPicker source={fakeSource({ providerList })} onDone={() => {}} />);
    try {
      await d.until(providerListPainted);
      await d.press(["z", "z"]);
      const after = joined(d.recapture().text);
      expect(after).toContain("no provider matches");
      expect(after).toContain("esc clears the filter");
    } finally {
      d.destroy();
    }
  });

  test("entering a provider does not carry the filter into its model list", async () => {
    // One `filter` state serves both views, which is what keeps the two screens
    // behaving identically — and it is only safe because every transition clears it.
    // A leaked filter would open a provider onto `no model matches “kimi”`.
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          providerList,
          byProvider: { "kimi-coding": [model({ id: "kimi-k3" })] },
        })}
        onDone={() => {}}
      />
    );
    try {
      await d.until(providerListPainted);
      await d.press(["i", "m"]);
      await d.press(["RETURN"]);
      await d.until(modelRowPainted("kimi-k3"));
      const after = joined(d.recapture().text);
      expect(after).toContain("kimi-k3");
      expect(after).not.toContain("no model matches");
      // `newest first` is the model list's idle caption — it is only drawn when the
      // filter is empty, so its presence IS the assertion that nothing leaked.
      expect(after).toContain("newest first");
    } finally {
      d.destroy();
    }
  });
});

// ── entering a provider is what fetches it ───────────────────────────────────────

describe("entering a provider loads THAT provider, on demand", () => {
  const providerList = [
    provider({ value: "openrouter", label: "OpenRouter", shortcut: "or@", hasDiscovery: false }),
    provider({ value: "devin", label: "Devin", shortcut: "dv@", hasDiscovery: true }),
  ];

  test("`⏎` asks the provider under the cursor, and ONLY that one", async () => {
    const source = fakeSource({
      providerList,
      byProvider: { openrouter: [model({ id: "glm-5.3" })], devin: [] },
      outcomes: {
        devin: { kind: "rows", rows: [model({ id: "devin-1" })], servedCount: 1, chatCount: 1 },
      },
    });
    const d = await draw(<ModelPicker source={source} onDone={() => {}} />);
    try {
      await d.press(["ARROW_DOWN"]);
      await d.press(["RETURN"]);
      await d.until(modelRowPainted("devin-1"));
      expect(source.calls.discover).toEqual(["devin"]);
      const all = joined(d.recapture().text);
      expect(all).toContain("Devin");
      expect(all).toContain("devin-1");
    } finally {
      d.destroy();
    }
  });

  test("inside one provider a model appears exactly ONCE", async () => {
    // The owner's rule: "if we enter to provider catalog, not all models — then the
    // model will be just one".
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          providerList: [
            provider({ value: "openrouter", label: "OpenRouter", hasDiscovery: false }),
          ],
          byProvider: {
            openrouter: [model({ id: "gpt-6-astra" }), model({ id: "gpt-6-astra" })],
          },
        })}
        onDone={() => {}}
      />,
      145,
      45
    );
    try {
      await d.press(["RETURN"]);
      await d.until(modelRowPainted("gpt-6-astra"));
      // ONE LIST ROW. The provider column is no longer drawn inside a provider — it
      // said `OpenRouter` 49 times under a dialog titled `OpenRouter` — so the row is
      // identified by its padded id cell instead: the id followed by the gap before
      // `ctx`. The detail line below prints `openrouter@gpt-6-astra · tools`, one
      // space and a `·`, and is not counted by that shape.
      const rows = d.recapture().text.filter((l) => /gpt-6-astra\s{2,}/.test(l));
      expect(rows.length).toBe(1);
    } finally {
      d.destroy();
    }
  });

  test("`esc` comes back to the provider list rather than quitting", async () => {
    let got: string | null | undefined = undefined;
    const d = await draw(
      <ModelPicker
        source={fakeSource({ providerList })}
        onDone={(spec) => {
          got = spec;
        }}
      />
    );
    try {
      await d.press(["RETURN"]);
      await d.until(modelRowPainted("kimi-k3"));
      await d.press(["ESCAPE"]);
      // A LONE `\x1B` IS AMBIGUOUS UNTIL THE NEXT BYTE OR A TIMEOUT: the parser has
      // to wait to see whether it is the head of `\x1B[B`. One more render pass
      // after that timeout is what makes a bare Escape observable in a test — a
      // real keyboard gets the same delay and nobody notices.
      await d.press([]);
      await d.until(providerListPainted);
      expect(joined(d.recapture().text)).toContain("choose a provider");
      expect(got).toBeUndefined();
    } finally {
      d.destroy();
    }
  });

  test("Enter returns the provider-scoped spec, never a bare model id", async () => {
    // A bare Claude-shaped name reaching `route()` degrades to OpenRouter, so the
    // picker must never emit one.
    let got: string | null | undefined;
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          providerList: [
            provider({ value: "openrouter", label: "OpenRouter", hasDiscovery: false }),
          ],
          byProvider: { openrouter: [model({ id: "gpt-6" })] },
        })}
        onDone={(spec) => {
          got = spec;
        }}
      />
    );
    try {
      await d.press(["RETURN"]);
      await d.until(modelRowPainted("gpt-6"));
      await d.press(["RETURN"]);
      // `openrouter@`, not the column's `or@`: `buildExplicitModelSpec` applies the
      // readability OVERRIDES because this is the string the user copies off their
      // screen, while a fixed-width column wants the short form. Both parse back to
      // the same provider — `providerShortcut` records why they differ.
      expect(got).toBe("openrouter@gpt-6");
    } finally {
      d.destroy();
    }
  });

  test("typing filters immediately — there is no search mode to enter", async () => {
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          providerList: [
            provider({ value: "openrouter", label: "OpenRouter", hasDiscovery: false }),
          ],
          byProvider: {
            openrouter: [model({ id: "glm-5.3-flash" }), model({ id: "kimi-k3" })],
          },
        })}
        onDone={() => {}}
      />
    );
    try {
      await d.press(["RETURN"]);
      await d.until(modelRowPainted("glm-5.3-flash"));
      await d.press(["g", "l", "m"]);
      const all = joined(d.recapture().text);
      expect(all).toContain("glm-5.3-flash");
      expect(all).not.toContain("kimi-k3");
    } finally {
      d.destroy();
    }
  });

  test("`/` makes the letter commands typeable — `codex` is a real model name", async () => {
    // The one collision filter-first creates: `c` opens the custom-spec dialog, so
    // the first keystroke of `codex` would navigate instead of filter. `/` is the
    // escape hatch, and without a test it is the kind of thing that quietly stops
    // working.
    const source = (): PickerDataSource =>
      fakeSource({
        providerList: [provider({ value: "openrouter", label: "OpenRouter", hasDiscovery: false })],
        byProvider: { openrouter: [model({ id: "codex-2" }), model({ id: "kimi-k3" })] },
      });
    const d = await draw(<ModelPicker source={source()} onDone={() => {}} />);
    try {
      await d.press(["RETURN"]);
      await d.until(modelRowPainted("codex-2"));
      // Bare `c` NAVIGATES — that is the collision, asserted so the escape hatch has
      // something to be an escape from.
      await d.press(["c"]);
      expect(joined(d.recapture().text)).toContain("type a model spec");
      d.destroy();
    } finally {
      /* destroyed above; the second half needs a fresh tree */
    }
    const e = await draw(<ModelPicker source={source()} onDone={() => {}} />);
    try {
      await e.press(["RETURN"]);
      await e.until(modelRowPainted("codex-2"));
      await e.press(["/"]);
      await e.press(["c"]);
      await e.press(["o"]);
      const all = joined(e.recapture().text);
      expect(all).toContain("codex-2");
      expect(all).not.toContain("kimi-k3");
    } finally {
      e.destroy();
    }
  });

  test("`/` takes effect for the keys that arrive with it, before the next render", async () => {
    // A paste, or fast typing on a loaded machine, delivers `/co` before React
    // re-renders. The `c` must still filter, not open the custom-spec dialog.
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          providerList: [
            provider({ value: "openrouter", label: "OpenRouter", hasDiscovery: false }),
          ],
          byProvider: { openrouter: [model({ id: "codex-2" }), model({ id: "kimi-k3" })] },
        })}
        onDone={() => {}}
      />
    );
    try {
      await d.press(["RETURN"]);
      await d.until(modelRowPainted("codex-2"));
      await d.press(["/", "c", "o"]);
      await d.until((t) => !joined(t).includes("kimi-k3"));
      const all = joined(d.recapture().text);
      expect(all).not.toContain("type a model spec");
      expect(all).toContain("codex-2");
      expect(all).not.toContain("kimi-k3");
    } finally {
      d.destroy();
    }
  });
});

// ── the cross-provider list, which is no longer the default ──────────────────────

describe("`a` opens the cross-provider list", () => {
  const providerList = [
    provider({ value: "openrouter", label: "OpenRouter", shortcut: "or@", hasDiscovery: false }),
    provider({ value: "kimi-coding", label: "Kimi Coding", shortcut: "kc@", hasDiscovery: false }),
  ];

  test("it is ONE cached catalog fetch, not a fan-out across providers", async () => {
    const source = fakeSource({
      providerList,
      byProvider: {
        openrouter: [model({ id: "glm-5.3-flash" })],
        "kimi-coding": [model({ id: "kimi-k3" })],
      },
    });
    const d = await draw(<ModelPicker source={source} onDone={() => {}} />);
    try {
      await d.press(["a"]);
      await d.until((t) => modelRowPainted("glm-5.3-flash")(t) && modelRowPainted("kimi-k3")(t));
      const all = joined(d.recapture().text);
      expect(all).toContain("all models");
      expect(all).toContain("glm-5.3-flash");
      expect(all).toContain("kimi-k3");
      // ONE warm. And not a single dynamic models catalog request: no provider was opened.
      expect(source.calls.catalog).toBe(1);
      expect(source.calls.discover).toEqual([]);
    } finally {
      d.destroy();
    }
  });

  test("one model on two providers is TWO rows, and the title counts both honestly", async () => {
    // The owner's rule for this list, and the count that goes with it: the rows are
    // ROUTES, so labelling their number "models" would be off by exactly the amount
    // that makes the list useful.
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          providerList,
          byProvider: {
            openrouter: [model({ id: "gpt-6-astra" })],
            "kimi-coding": [model({ id: "gpt-6-astra" })],
          },
        })}
        onDone={() => {}}
      />,
      145,
      45
    );
    try {
      await d.press(["a"]);
      await d.until((t) => t.filter((line) => line.includes("gpt-6-astra  ")).length === 2);
      const all = joined(d.recapture().text);
      expect(all).toContain("1 models · 2 routes");
      expect(all).toContain("OpenRouter");
      expect(all).toContain("Kimi Coding");
    } finally {
      d.destroy();
    }
  });

  test("a provider with no credential contributes NO rows, and the count says so", async () => {
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          providerList,
          ready: { openrouter: true, "kimi-coding": false },
          byProvider: {
            openrouter: [model({ id: "glm-5.3-flash" })],
            "kimi-coding": [model({ id: "kimi-k3" })],
          },
        })}
        onDone={() => {}}
      />
    );
    try {
      await d.press(["a"]);
      await d.until(modelRowPainted("glm-5.3-flash"));
      const all = joined(d.recapture().text);
      expect(all).toContain("glm-5.3-flash");
      expect(all).not.toContain("kimi-k3");
      // The absence is EXPLAINED, in the title, rather than silent.
      expect(all).toContain("1/2 providers");
    } finally {
      d.destroy();
    }
  });

  test("A DYNAMIC MODELS CATALOG ALREADY OPENED IS MERGED IN — and one not opened costs no request", async () => {
    // The `gemini` report — "why i search gemini i see only open router models, no
    // models from antigravity and devin and subscriptions" — was first answered by
    // fetching every dynamic models catalog at startup, which the owner then rejected as
    // prefetching. This is the answer that survives both: a dynamic models catalog fetched because
    // he OPENED that provider improves this list for free, and a provider he never
    // opened is simply not represented here.
    const withDiscovery = [
      provider({ value: "openrouter", label: "OpenRouter", shortcut: "or@", hasDiscovery: false }),
      provider({
        value: "antigravity",
        label: "Antigravity",
        shortcut: "ag@",
        billing: "sub",
        envVar: "",
        hasDiscovery: true,
      }),
    ];
    const source = fakeSource({
      providerList: withDiscovery,
      byProvider: {
        openrouter: [model({ id: "gemini-3.8-flash" })],
        // No catalog entries whatsoever — the real Antigravity's situation.
        antigravity: [],
      },
      outcomes: {
        antigravity: {
          kind: "rows",
          rows: [model({ id: "gemini-3.8-flash-tiered", context: "1M" })],
          servedCount: 1,
          chatCount: 1,
        },
      },
    });
    const d = await draw(<ModelPicker source={source} onDone={() => {}} />, 145, 45);
    try {
      // Open Antigravity, look at it, come back out, then ask for all models.
      await d.press(["ARROW_DOWN"]);
      await d.press(["RETURN"]);
      await d.until(modelRowPainted("gemini-3.8-flash-tiered"));
      await d.press(["ESCAPE"]);
      // The bare-Escape flush — see the `esc comes back` test. Without it the
      // NEXT key is read as `\x1B` + `a`, which is alt-a and not two keystrokes.
      await d.press([]);
      await d.until(providerListPainted);
      await d.press(["a"]);
      await d.until(
        (t) =>
          modelRowPainted("gemini-3.8-flash")(t) && modelRowPainted("gemini-3.8-flash-tiered")(t)
      );
      await d.press(["g", "e", "m", "i", "n", "i"]);
      const all = joined(d.recapture().text);
      // BOTH routes, from two different sources, in one filtered list.
      expect(all).toContain("gemini-3.8-flash");
      expect(all).toContain("gemini-3.8-flash-tiered");
      expect(all).toContain("OpenRouter");
      expect(all).toContain("Antigravity");
      // Exactly one dynamic models catalog request, and it was the one he opened.
      expect(source.calls.discover).toEqual(["antigravity"]);
    } finally {
      d.destroy();
    }
  });
});

// ── provenance: the user's actual complaint ──────────────────────────────────────

describe("a fallback list says it is a fallback — and that it may not work", () => {
  const failed: PickerDiscoveryOutcome = {
    kind: "failed",
    failure: {
      kind: "unauthorized",
      provider: "kimi",
      status: 401,
      endpoint: "https://api.moonshot.ai/v1/models",
    },
    notice: [
      "\n⚠ Kimi / Moonshot could not list its models: the API key was rejected (HTTP 401)\n",
      "  Check MOONSHOT_API_KEY (a value in your shell overrides stored credentials).\n",
      "  Get a key: https://platform.moonshot.cn/\n",
      "  Showing Kimi / Moonshot's cloud-catalog entries below — not its live model list.\n\n",
    ],
    fallbackRows: [model(), model({ id: "kimi-k2.6" })],
  };

  /**
   * Reach the scoped view: Enter on the first provider.
   *
   * ONE PRESS, and the failure it renders is now a failure the user ASKED for —
   * which is the round-two improvement that came free with on-demand loading. The
   * red panel, the `catalog` rows and `r retry` are unchanged; only the moment
   * they appear is.
   */
  async function scoped(outcome: PickerDiscoveryOutcome, width = 80, height = 24): Promise<Drawn> {
    const d = await draw(
      <ModelPicker source={fakeSource({ outcome })} onDone={() => {}} />,
      width,
      height
    );
    await d.press(["RETURN"]);
    await d.until(modelRowPainted("kimi-k3"));
    return { ...d, ...d.recapture() };
  }

  test("the title, the per-row mark and the banner all say it", async () => {
    const d = await scoped(failed);
    try {
      const all = joined(d.text);
      expect(all).toContain("live model list unavailable");
      expect(all).toContain("catalog");
      // The sentence WRAPS across two rows, so it is matched against the frame with
      // its border glyphs and line breaks flattened away. A substring test over raw
      // rows would fail on the wrap and say nothing about whether a reader can read
      // it.
      expect(flat(d.text)).toContain("not Kimi / Moonshot's live model list");
    } finally {
      d.destroy();
    }
  });

  test("THE HONESTY LINE IS ON SCREEN AT 80 COLUMNS", async () => {
    // Neither the shipped build nor the rejected one said this. Catalog rows are not
    // merely differently-sourced: discovery failed on the credential, so nothing has
    // confirmed the account can call any of them.
    const d = await scoped(failed);
    try {
      expect(joined(d.text)).toContain("may still fail");
    } finally {
      d.destroy();
    }
  });

  test("the banner names the provider, the cause, the env var and the key URL", async () => {
    const d = await scoped(failed, 145, 45);
    try {
      const all = joined(d.text);
      expect(all).toContain("Kimi / Moonshot");
      expect(all).toContain("the API key was rejected");
      expect(all).toContain("MOONSHOT_API_KEY");
      expect(all).toContain("platform.moonshot.cn");
    } finally {
      d.destroy();
    }
  });

  test("`r retry` is offered — the rejected build had no way back from a failure", async () => {
    const d = await scoped(failed);
    try {
      expect(joined(d.text)).toContain("retry");
    } finally {
      d.destroy();
    }
  });

  test("a dynamic models catalog carries no mark — which is what makes the mark a signal", async () => {
    const d = await scoped({
      kind: "rows",
      rows: [model()],
      servedCount: 1,
      chatCount: 1,
    });
    try {
      expect(joined(d.text)).not.toContain("catalog");
    } finally {
      d.destroy();
    }
  });

  test("a banner NEVER makes the dialog taller — its rows come out of the list's", async () => {
    // The inline-mode bound. `main-screen` reserves rows by scrolling the user's
    // terminal, so the dialog is allowed to shrink below its cap (a four-row
    // fallback list should look like four rows) but never to exceed it.
    const withBanner = await scoped(failed);
    try {
      expect(painted(withBanner.text).length).toBeLessThanOrEqual(MAX_DIALOG_ROWS);
    } finally {
      withBanner.destroy();
    }
  });

  test("`empty-models-catalog` renders in the NOTICE tier, without the error wash", async () => {
    // `captureCharFrame` is blind to this: the two tiers differ in COLOUR as well as in
    // words, and the colour is the half a reader sees first.
    const failedFrame = await scoped(failed);
    const failedBgs = bgs(failedFrame.frame);
    failedFrame.destroy();
    const emptyFrame = await scoped({
      kind: "empty-models-catalog",
      failure: {
        kind: "empty-models-catalog",
        provider: "kimi",
        endpoint: "https://api.test/v1/models",
      },
      fallbackRows: [model()],
    });
    try {
      expect(failedBgs.has(rgb(C.bgError))).toBe(true);
      expect(bgs(emptyFrame.frame).has(rgb(C.bgError))).toBe(false);
      expect(joined(emptyFrame.text)).toContain("empty");
    } finally {
      emptyFrame.destroy();
    }
  });
});

// ── what the screen says while it is waiting ─────────────────────────────────────

describe("the loading states", () => {
  test("leaving the model view mid-load does not strand it — `a`, `esc`, `a` reaches the list", async () => {
    // Both one-shot loads used to discard their result when Escape disabled the model
    // view, leaving the second visit stuck on `fetching` with no request left to make.
    const source = fakeSource({
      loadDelayMs: 300,
      served: [model({ id: "a" })],
      descriptions: { a: "A sentence about model a." },
    });
    const d = await draw(<ModelPicker source={source} onDone={() => {}} />);
    try {
      await d.press(["a"]);
      await d.press(["ESCAPE"]);
      await new Promise((resolve) => setTimeout(resolve, 600));
      await d.press(["a"]);
      await d.until((t) => flat(t).includes("A sentence about model a."));
      const frame = d.recapture().text;
      expect(joined(frame)).not.toContain("fetching");
      expect(source.calls.catalog).toBe(1);
      expect(flat(frame)).toContain("A sentence about model a.");
    } finally {
      d.destroy();
    }
  });

  test("startup names the ONE thing it is doing, and claims no other", async () => {
    // The screen the owner rejected said `cloud catalog fetching…` beside a `0/11 providers`
    // discovery meter, before he had asked for either. Startup now probes credentials
    // and nothing else, and the screen says so.
    const d = await draw(
      <ModelPicker source={fakeSource({ hang: true })} onDone={() => {}} />,
      80,
      24,
      0
    );
    try {
      const all = joined(d.text);
      expect(all).toContain("credentials");
      expect(all).toContain("checking");
      expect(all).not.toContain("cloud catalog");
      // No per-provider discovery meter — the rejected `0/11 providers` fan-out.
      expect(all).not.toMatch(/\d+\/\d+ providers/);
    } finally {
      d.destroy();
    }
  });

  test("a provider still being listed says which provider, and for how long", async () => {
    // The per-provider in-flight state, which is now reachable because the fetch
    // happens in response to a keystroke.
    const d = await draw(
      <ModelPicker
        source={{
          ...fakeSource({ providerList: [provider({ label: "Kimi / Moonshot" })] }),
          discoverModelsCatalog: () => new Promise<never>(() => {}),
        }}
        onDone={() => {}}
      />
    );
    try {
      await d.press(["RETURN"]);
      const all = joined(d.recapture().text);
      expect(all).toContain("Kimi / Moonshot");
      expect(all).toContain("deadline");
    } finally {
      d.destroy();
    }
  });
});

describe("stored dynamic models catalogs", () => {
  const devin = provider({
    value: "devin",
    label: "Devin",
    shortcut: "dv@",
    billing: "sub",
    envVar: "",
    discoveryShape: "elapsed",
  });
  const grok = provider({
    value: "grok-subscription",
    label: "SuperGrok",
    shortcut: "gk@",
    billing: "sub",
    envVar: "",
    discoveryShape: "deadline",
  });
  const cachedRow = model({
    id: "swe-1-7-medium",
    name: "swe-1-7-medium",
    provider: "Devin",
    contextLength: 200000,
    context: "200K",
  });
  const cached: PickerDiscoveryOutcome = {
    kind: "rows",
    rows: [cachedRow],
    servedCount: 1,
    chatCount: 1,
  };
  let home: string;
  let previous: { dir?: string; key?: string };
  const restores: Array<() => void> = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "claudish-picker-lists-"));
    previous = {
      dir: process.env.CLAUDISH_DYNAMIC_CATALOG_DIR,
      key: process.env.CLAUDISH_DYNAMIC_CATALOG_KEY,
    };
    process.env.CLAUDISH_DYNAMIC_CATALOG_DIR = join(home, "lists");
    process.env.CLAUDISH_DYNAMIC_CATALOG_KEY = join(home, "secret");
    _setCatalogEntriesForTest([]);
    accountModels._resetAccountModelsListsForTest();
    const identity = spyOn(credentials, "accountIdentity").mockImplementation(async (p) =>
      p === "devin" ? "picker-account" : undefined
    );
    const available = spyOn(credentials, "isAvailable").mockImplementation(
      async (p) => p === "devin" || p === "grok-subscription"
    );
    const readiness = spyOn(credentials, "describeReadiness").mockImplementation(async (p) => ({
      readiness: p === "devin" || p === "grok-subscription" ? "present" : "absent",
    }));
    const network = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
    restores.push(
      () => identity.mockRestore(),
      () => available.mockRestore(),
      () => readiness.mockRestore(),
      () => network.mockRestore()
    );
  });

  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) restore();
    accountModels._resetAccountModelsListsForTest();
    _resetCatalogClient();
    for (const [name, value] of [
      ["CLAUDISH_DYNAMIC_CATALOG_DIR", previous.dir],
      ["CLAUDISH_DYNAMIC_CATALOG_KEY", previous.key],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  function storedSource(choices: PickerProviderChoice[]): PickerDataSource {
    const source = createPickerDataSource();
    return {
      ...source,
      providerList: () => choices,
      notEnabledLocalProviders: () => [],
      ensureCatalog: async () => {},
      descriptions: async () => ({ get: () => undefined, size: 0 }),
    };
  }

  function holdRefreshes() {
    const pending = deferred<accountModels.RefreshResult>();
    const refresh = spyOn(accountModels, "refreshAccountModelsList").mockImplementation(
      () => pending.promise
    );
    restores.push(() => {
      pending.resolve({ kind: "skipped", reason: "no-credential" });
      refresh.mockRestore();
    });
    return { pending, refresh };
  }

  test("53. cached first, then live", async () => {
    const live = deferred<PickerDiscoveryOutcome>();
    const source = {
      ...fakeSource({ providerList: [devin] }),
      cachedModelsCatalog: (p: string) => (p === "devin" ? cached : null),
      discoverModelsCatalog: () => live.promise,
    };
    const d = await draw(<ModelPicker source={source} onDone={() => {}} />);
    try {
      await d.press(["RETURN"]);
      expect(joined(d.recapture().text)).toContain("swe-1-7-medium");
      expect(joined(d.recapture().text)).not.toContain("swe-live");
      live.resolve({
        kind: "rows",
        rows: [model({ id: "swe-live", name: "swe-live", provider: "Devin" })],
        servedCount: 1,
        chatCount: 1,
      });
      await d.until((t) => joined(t).includes("swe-live"));
      expect(joined(d.recapture().text)).toContain("swe-live");
      expect(joined(d.recapture().text)).not.toContain("swe-1-7-medium");
    } finally {
      live.resolve(cached);
      d.destroy();
    }
  });

  test("54. a live failure keeps the cached rows", async () => {
    const live = deferred<PickerDiscoveryOutcome>();
    const source = {
      ...fakeSource({ providerList: [devin] }),
      cachedModelsCatalog: (p: string) => (p === "devin" ? cached : null),
      discoverModelsCatalog: () => live.promise,
    };
    const d = await draw(<ModelPicker source={source} onDone={() => {}} />);
    try {
      await d.press(["RETURN"]);
      live.resolve({
        kind: "failed",
        failure: { kind: "unreachable", provider: "devin", detail: "offline" },
        notice: ["Devin could not list its models: unreachable (offline)"],
        fallbackRows: [],
      });
      await d.until((t) => joined(t).includes("unreachable"));
      const frame = joined(d.recapture().text);
      expect(frame).toContain("unreachable");
      expect(frame).toContain("swe-1-7-medium");
    } finally {
      live.resolve(cached);
      d.destroy();
    }
  });

  test("55. all models include stored lists", async () => {
    const key = deriveAccountKey("devin", "picker-account");
    expect(key.ok).toBe(true);
    if (!key.ok) throw new Error(key.reason);
    expect(
      writeStoredModelsList("devin", key.accountKey, [
        {
          id: "swe-1-7-medium",
          displayName: "SWE-1.7",
          contextWindow: 200000,
          reported: "chat",
        },
      ])
    ).toBe(true);
    const lists = await accountModels.loadAccountModelsLists();
    expect(lists.get("devin")?.models[0]?.id).toBe("swe-1-7-medium");
    holdRefreshes();
    const source = storedSource([devin]);
    let selected: string | null | undefined;
    const d = await draw(
      <ModelPicker
        source={source}
        onDone={(spec) => {
          selected = spec;
        }}
      />
    );
    try {
      await d.press(["a"]);
      await d.until(modelRowPainted("swe-1-7-medium"));
      const frame = joined(d.recapture().text);
      expect(frame).toContain("swe-1-7-medium");
      expect(frame).toContain("dv@");
      await d.press(["RETURN"]);
      expect(selected).toBe("dv@swe-1-7-medium");
    } finally {
      d.destroy();
    }
  });

  test("56. open triggers background refreshes, never blocking", async () => {
    const { pending, refresh } = holdRefreshes();
    const source = storedSource([devin, grok, provider()]);
    const d = await draw(<ModelPicker source={source} onDone={() => {}} />);
    try {
      expect(joined(d.text)).toContain("choose a provider");
      expect(joined(d.text)).toContain("Devin");
      expect(joined(d.text)).toContain("SuperGrok");
      const opened = () => refresh.mock.calls.filter(([, trigger]) => trigger === "picker-open");
      expect(
        opened()
          .map(([p]) => p)
          .sort()
      ).toEqual(["devin", "grok-subscription"]);
      for (const [, , opts] of opened()) expect(opts).toMatchObject({ minAgeMs: LIVE_MS });
      await d.press(["k"]);
      await d.press(["k"]);
      expect(opened()).toHaveLength(2);
    } finally {
      pending.resolve({ kind: "skipped", reason: "no-credential" });
      d.destroy();
    }
  });

  test("all-models typing sweeps once per picker open without waiting", async () => {
    const pending = deferred<void>();
    // Returning the held promise also detects a caller that incorrectly awaits this void API.
    const sweep = spyOn(accountModels, "sweepAccountModelsLists").mockImplementation(
      () => pending.promise
    );
    restores.push(() => {
      pending.resolve();
      sweep.mockRestore();
    });
    for (let open = 1; open <= 2; open++) {
      const source = fakeSource({
        providerList: [devin],
        served: [cachedRow, model({ id: "other-model", name: "other-model" })],
      });
      const d = await draw(<ModelPicker source={source} onDone={() => {}} />);
      try {
        expect(joined(d.text)).toContain("choose a provider");
        expect(sweep).toHaveBeenCalledTimes(open - 1);
        await d.press(["a"]);
        await d.until(modelRowPainted("swe-1-7-medium"));
        expect(joined(d.recapture().text)).toContain("swe-1-7-medium");
        await d.press(["s"]);
        expect(joined(d.recapture().text)).toContain("swe-1-7-medium");
        expect(joined(d.recapture().text)).not.toContain("other-model");
        expect(sweep).toHaveBeenCalledTimes(open);
        expect(sweep).toHaveBeenLastCalledWith("search-all", { minAgeMs: LIVE_MS });
        await d.press(["w", "e"]);
        await d.press(["ESCAPE"]);
        await d.press(["s"]);
        expect(sweep).toHaveBeenCalledTimes(open);
      } finally {
        d.destroy();
      }
    }
    pending.resolve();
  });
});

describe("the context window dialog", () => {
  const sized = model({ maxContextLength: 262_144 });

  async function open(
    row: ModelInfo,
    ask = true
  ): Promise<{ d: Drawn; picks: Array<[string | null, number | undefined]> }> {
    const picks: Array<[string | null, number | undefined]> = [];
    const d = await draw(
      <ModelPicker
        source={fakeSource({
          outcome: { kind: "rows", rows: [row], servedCount: 1, chatCount: 1 },
        })}
        askContextWindow={ask}
        onDone={(spec, size) => picks.push([spec, size])}
      />
    );
    await d.press(["RETURN"]);
    await d.until(modelRowPainted("kimi-k3"));
    return { d, picks };
  }

  test("a model with a known maximum asks for the size and shows the maximum", async () => {
    const { d, picks } = await open(sized);
    try {
      await d.press(["RETURN"]);
      await d.until((text) => joined(text).includes("context window"));
      const all = joined(d.recapture().text);
      expect(all).toContain("262K (model maximum)");
      expect(all).toContain("128K");
      expect(picks).toEqual([]);
    } finally {
      d.destroy();
    }
  });

  test("enter launches with the default size", async () => {
    const { d, picks } = await open(sized);
    try {
      await d.press(["RETURN"]);
      await d.until((text) => joined(text).includes("context window"));
      await d.press(["RETURN"]);
      expect(picks).toEqual([["kimi@kimi-k3", 128_000]]);
    } finally {
      d.destroy();
    }
  });

  test("the arrow keys choose another size", async () => {
    const { d, picks } = await open(sized);
    try {
      await d.press(["RETURN"]);
      await d.until((text) => joined(text).includes("context window"));
      await d.press(["ARROW_DOWN"]);
      await d.press(["RETURN"]);
      expect(picks).toEqual([["kimi@kimi-k3", 262_144]]);
    } finally {
      d.destroy();
    }
  });

  test("escape goes back to the model list", async () => {
    const { d, picks } = await open(sized);
    try {
      await d.press(["RETURN"]);
      await d.until((text) => joined(text).includes("context window"));
      await d.press(["ESCAPE"]);
      await d.until(modelRowPainted("kimi-k3"));
      expect(joined(d.recapture().text)).not.toContain("model maximum");
      expect(picks).toEqual([]);
    } finally {
      d.destroy();
    }
  });

  test("a model with no known maximum launches at once", async () => {
    const { d, picks } = await open(model());
    try {
      await d.press(["RETURN"]);
      expect(picks).toEqual([["kimi@kimi-k3", undefined]]);
    } finally {
      d.destroy();
    }
  });

  test("a caller that does not ask gets no dialog", async () => {
    const { d, picks } = await open(sized, false);
    try {
      await d.press(["RETURN"]);
      expect(picks).toEqual([["kimi@kimi-k3", undefined]]);
    } finally {
      d.destroy();
    }
  });
});
