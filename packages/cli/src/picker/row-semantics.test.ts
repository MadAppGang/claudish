import { describe, expect, test } from "bun:test";
import type { ModelInfo, PickerDiscoveryOutcome } from "../model-selector.js";
/**
 * The pure semantics behind a row, a detail line and a discovery notice — the tier
 * that needs no renderer, and the tier where the honesty rules are actually
 * decidable.
 *
 * Three of these assertions exist because the alternative reading is silently
 * plausible: a fallback list must say it MAY NOT WORK and not merely that it came
 * from somewhere else; a capability the catalog is silent about must not be
 * rendered as absent; and no rendered notice may contain the substring `undefined`.
 */
import type { DiscoveryFailure } from "../providers/model-discovery.js";
import { resetThemeModeForTests, setThemeMode } from "../theme/theme-mode.js";
import { C } from "../tui/theme.js";
import { displayWidth, truncate } from "../tui/viz/text.js";
import { tokens } from "../tui/viz/tokens.js";
import {
  discoveryNoticeContent,
  mergeCredentialLines,
  noticeRows,
  wrapWords,
} from "./DiscoveryNotice.js";
import { capabilityWords, descriptionLines, detailText, providerFactsText } from "./detail.js";
import { type PickerRow, dedupeByModelId, dedupeByProviderModel } from "./hooks/usePickerModels.js";
import { deriveProviderRowLayout, deriveRowLayout, providerColumn } from "./layout.js";
import {
  CHIP_COLUMN_LABELS,
  CHIP_FILL_CELLS,
  billingLabel,
  priceChipBg,
  priceFg,
  priceLabel,
  priceVaries,
  providerCountText,
  readinessGlyph,
} from "./rows.js";

const model = (over: Partial<ModelInfo> = {}): ModelInfo => ({
  id: "m",
  name: "m",
  description: "",
  provider: "p",
  ...over,
});

describe("priceLabel", () => {
  test("the `/1M` suffix goes — the column header says it once for the whole list", () => {
    expect(priceLabel("$9.00/1M", "metered")).toBe("$9.00");
    expect(priceLabel("$0.15/1M", "metered")).toBe("$0.15");
  });

  test("a flat-rate plan keeps its word instead of a number it does not have", () => {
    expect(priceLabel("SUB", "sub")).toBe("SUB");
    expect(priceLabel("FREE", "metered")).toBe("FREE");
    // A local model costs nothing per token and says so in lower case: shouting is
    // reserved for the two labels that are about money.
    expect(priceLabel("$3.00/1M", "local")).toBe("local");
    expect(priceLabel("LOCAL", "metered")).toBe("local");
  });

  test("an absent price is `N/A`, and never an empty cell", () => {
    // An empty price column would read as "free", which is a claim about money.
    expect(priceLabel("N/A", "metered")).toBe("N/A");
    expect(priceLabel("", "metered")).toBe("N/A");
  });
});

describe("priceFg / priceChipBg", () => {
  test("`SUB` IS NEVER THE FAILURE HUE — in either form, in either theme", () => {
    // THE DEFECT THIS PINS SHIPPED. `SUB` was `tokens.warn`, which is `C.orange`:
    // `#ff8800` on dark and a rust `#c2410c` on light. Red-orange is what this app
    // spends on a failure, and `SUB` is the opposite of one — it is the route the
    // user already pays for, free at the point of use. Three reviewers read the old
    // colour as correct, so the rule is asserted rather than described.
    for (const mode of ["dark", "light"] as const) {
      setThemeMode(mode);
      expect(priceFg("SUB")).not.toBe(tokens.warn);
      expect(priceFg("SUB")).not.toBe(tokens.error);
      expect(priceChipBg("SUB")).not.toBe(tokens.warn);
      expect(priceChipBg("SUB")).not.toBe(tokens.error);
    }
    resetThemeModeForTests();
  });

  test("`FREE`, `SUB` and `local` share ONE POSITIVE tier, because they make one claim", () => {
    // All three say "running this costs you no per-token money"; the label says by
    // which mechanism. Three hues for one claim is rule 1 read backwards, and the
    // owner asked for them as one family in as many words.
    expect(priceFg("SUB")).toBe(priceFg("FREE"));
    expect(priceFg("SUB")).toBe(priceFg("local"));
    expect(priceFg("SUB")).toBe(tokens.success);
    expect(priceChipBg("SUB")).toBe(priceChipBg("FREE"));
    expect(priceChipBg("SUB")).toBe(priceChipBg("local"));
  });

  test("a chip FILL is a muted pill, never the neon foreground", () => {
    // `aesthetics-and-color.md`: a colour tuned to read as text is harsh as a solid
    // block. `C.pillKeyBg` is already the `FREE` chip on the session summary card,
    // so the picker borrows that object rather than inventing a second green.
    expect(priceChipBg("FREE")).toBe(C.pillKeyBg);
    expect(priceChipBg("FREE")).not.toBe(C.green);
  });

  test("A VALUE IS NOT A TOKEN, so a price numeral gets no chip at all", () => {
    // A chip is for a fixed, small vocabulary. Chipping `$0.75` would put a fill
    // behind every row of the column — the rectangle — and would claim the numeral
    // is one of a handful of states rather than a measured amount.
    expect(priceChipBg("$2.25")).toBeNull();
    expect(priceChipBg("$30.00")).toBeNull();
    // `N/A` is the ABSENCE of the fact, not a state of it.
    expect(priceChipBg("N/A")).toBeNull();
  });

  test("`N/A` is the ABSENCE of the fact, so it stays in the dim tier alone", () => {
    // `local` used to share this tier on the grounds that both mean "there is no
    // number here". They do not mean the same thing: `local` is a positive claim the
    // reader acts on — this route has no per-token charge — while `N/A`
    // is the catalog declining to answer. So `local` joined the positive family and
    // `N/A` kept the dim tier, which is where an unanswered question belongs.
    expect(priceFg("N/A")).toBe(tokens.dead);
    expect(priceFg("N/A")).not.toBe(priceFg("local"));
    expect(priceFg("N/A")).not.toBe(priceFg("$2.25"));
  });

  test("AN EXPENSIVE PRICE IS NOT PAINTED AS AN ALARM — one colour, one meaning", () => {
    // A prototype of this dialog bucketed metered prices and drew anything over
    // $10/1M in orange; the owner and the reviewer both read `$30.00` as an error,
    // because red-orange is what this app spends on a failure and on `SUB`. A
    // number is a number: the numeral is body ink at every magnitude, and the
    // comparison the reader is making is between the DIGITS.
    const prices = ["$0.15", "$2.25", "$12.50", "$15.00", "$30.00"].map(priceFg);
    expect(new Set(prices).size).toBe(1);
  });
});

describe("CHIP_FILL_CELLS — one fill width for the whole status column", () => {
  test("it fits the LONGEST label the column can print, and is never typed out", () => {
    // The owner asked for one width across the column and the obvious number is 5 —
    // `SUB` plus a space each side — which clips `FREE` by one cell and `local` by
    // two. Yoga does not report a clipped cell; it takes the columns out of a
    // NEIGHBOURING one and leaves a stub of background under its first letter, which
    // a character frame cannot see. So the width is derived, and a fifth state added
    // to the vocabulary widens the column instead of overflowing it.
    expect(CHIP_FILL_CELLS).toBe(7);
    for (const label of CHIP_COLUMN_LABELS) {
      expect({ label, fits: displayWidth(label) + 2 <= CHIP_FILL_CELLS }).toEqual({
        label,
        fits: true,
      });
    }
  });

  test("the VOCABULARY is exactly what the two chipped columns answer", () => {
    // A label outside this list would be sized by a constant that never saw it.
    const words = new Set<string>(CHIP_COLUMN_LABELS);
    for (const mode of ["sub", "local", "metered"] as const) {
      expect(words.has(billingLabel(mode).text)).toBe(true);
    }
    for (const price of ["FREE", "SUB", "local"]) {
      expect(priceChipBg(price)).not.toBeNull();
      expect(words.has(price)).toBe(true);
    }
  });

  test("BOTH columns that print a chip are at least that wide, at 80 and at 145", () => {
    // The fill is the one cell count a chip owns; the CELL it sits in is a budget in
    // `layout.ts`, and the two numbers drifting apart is how a chip comes to overflow
    // its column. 76 and 141 are the dialog's inner widths at 80x24 and 145x45.
    for (const inner of [76, 141]) {
      expect({
        inner,
        billing: deriveProviderRowLayout(inner).billing >= CHIP_FILL_CELLS,
        price: deriveRowLayout(inner).price >= CHIP_FILL_CELLS,
      }).toEqual({ inner, billing: true, price: true });
    }
  });
});

describe("providerCountText — the tail says what you GET, never how it is fetched", () => {
  test("a known count is a count, and one model is not `1 models`", () => {
    expect(providerCountText({ count: 42, hasDiscovery: true, billing: "metered" })).toBe(
      "42 models"
    );
    expect(providerCountText({ count: 1, hasDiscovery: false, billing: "sub" })).toBe("1 model");
    // `null` is "nobody has counted this yet" and prints NOTHING — not `0`, not a dash.
    expect(providerCountText({ count: null, hasDiscovery: true, billing: "sub" })).toBe("");
  });

  test("the rejected fetch-describing copy is gone — a subscription provider says `subscription models`", () => {
    // The owner read the shipped row on a live run: the old copy described
    // claudish's fetch, not the user's plan. His replacement, verbatim: *"subscription
    // models"*. This is the case he was looking at — Grok Build, Devin, Antigravity,
    // OpenCode Zen Go: flat-rate, no catalog entries, a dynamic models catalog of their own.
    expect(providerCountText({ count: 0, hasDiscovery: true, billing: "sub" })).toBe(
      "subscription models"
    );
    // Exact copy for the other two billing kinds too. Stronger than asserting the
    // old wording is absent, which any OTHER wrong wording would also pass.
    expect(providerCountText({ count: 0, hasDiscovery: true, billing: "metered" })).toBe(
      "lists its own models"
    );
    expect(providerCountText({ count: 0, hasDiscovery: true, billing: "local" })).toBe(
      "lists its own models"
    );
  });

  test("and a NON-subscription provider gets its own words, because the other would be false", () => {
    // `hasDiscovery` is a property of the provider DEFINITION, not of its billing, so
    // this branch is reachable by a metered or local provider with no catalog entries
    // — a self-hosted vLLM, an Ollama daemon. "Subscription models" there would be the
    // screen stating a plan the user does not have.
    expect(providerCountText({ count: 0, hasDiscovery: true, billing: "metered" })).toBe(
      "lists its own models"
    );
    expect(providerCountText({ count: 0, hasDiscovery: true, billing: "local" })).toBe(
      "lists its own models"
    );
    expect(providerCountText({ count: 0, hasDiscovery: true, billing: "metered" })).not.toContain(
      "subscription"
    );
  });

  test("a REAL zero from a provider that does not discover is still a zero", () => {
    // Without `hasDiscovery` there is nothing else to ask: the catalog is the answer
    // and the answer is none. Saying "lists its own models" there would be the
    // opposite lie to the one above.
    expect(providerCountText({ count: 0, hasDiscovery: false, billing: "metered" })).toBe(
      "0 models"
    );
  });

  test("every phrasing fits the tail cell at 80 columns, where it is narrowest", () => {
    // `deriveProviderRowLayout` gives the tail 25 cells at the narrowest supported
    // width and grows it from there. A phrase longer than that would be truncated with
    // an ellipsis and nothing would report it.
    const tail = deriveProviderRowLayout(76).tail;
    for (const billing of ["sub", "metered", "local"] as const) {
      const text = providerCountText({ count: 0, hasDiscovery: true, billing });
      expect({ billing, text, fits: displayWidth(text) <= tail }).toEqual({
        billing,
        text,
        fits: true,
      });
    }
  });
});

describe("priceVaries — which view earns chips", () => {
  test("a flat-rate or local provider FIXES the column, so it gets no chips", () => {
    // `resolveProviderDisplayPrice` answers `SUB` for every row of a subscription
    // dynamic models catalog. 49 identical fills stacked with no gap between rows is the failure the
    // skill MEASURED — chips fusing into one solid rectangle with the labels
    // floating in it — and no amount of correct padding prevents it, because the
    // padding is not what makes them identical.
    expect(priceVaries("sub")).toBe(false);
    expect(priceVaries("local")).toBe(false);
  });

  test("the cross-provider list and a METERED provider vary, so they do", () => {
    expect(priceVaries(null)).toBe(true);
    expect(priceVaries("metered")).toBe(true);
  });
});

describe("billingLabel / readinessGlyph", () => {
  test("each billing mode has its own WORD, and ALL THREE carry a fill", () => {
    const tags = (["sub", "local", "metered"] as const).map(billingLabel);
    expect(tags.map((t) => t.text)).toEqual(["SUB", "local", "$$$"]);
    // `$` USED TO BE `bg: null` — drawn as text, on the grounds that a fill on every
    // row of the column is the banding defect. The owner read the shipped screen and
    // asked for the opposite: "make $$$ the same width and badge as well", because a
    // filled `SUB` beside a bare `$` is a column with no edges. What stops the column
    // banding is now the DISTANCE between the two fills (ΔE76 44.9 light / 63.4 dark,
    // pinned in `theme-contrast.test.ts`) rather than the absence of one of them.
    //
    // THE LABEL IS `$$$`, WHICH IS THE OWNER'S NEXT INSTRUCTION AND NOT A TYPO FOR
    // THE PRICE. Real prices are numerals (`$2.25`) built by `priceLabel`, and this
    // chip is the provider's BILLING MODE. Three characters, the same as `SUB` — a
    // coincidence the column is glad of and does not depend on, because
    // `CHIP_FILL_CELLS` still derives from `local`.
    expect(tags.map((t) => t.bg)).toEqual([C.pillKeyBg, C.pillKeyBg, C.pillCostBg]);
    expect(C.pillCostBg).not.toBe(C.pillKeyBg);
  });

  test("METERED COSTS MONEY and SUB DOES NOT — but neither is a FAILURE", () => {
    // `$$$` states that the route bills per token, in the hue that says so. What it
    // must never become is the hue that says something BROKE: `tokens.error` is the
    // `HTTP 401` badge and the discovery banner, and a chip wearing it would put a
    // failure on 13 of 17 healthy rows. The register that keeps the two apart is
    // measured in `theme-contrast.test.ts`; that they are not the literal same token
    // is cheap to state here, and it is the check that fails first and reads clearest.
    expect(billingLabel("metered").fg).toBe(C.pillCostFg);
    expect(billingLabel("metered").bg).toBe(C.pillCostBg);
    for (const mode of ["sub", "local", "metered"] as const) {
      const tag = billingLabel(mode);
      for (const colour of [tag.bg, tag.fg]) {
        expect(colour).not.toBe(tokens.error);
        expect(colour).not.toBe(tokens.warn);
        expect(colour).not.toBe(C.red);
        expect(colour).not.toBe(C.bgError);
      }
    }
  });

  test("EVERY CHIP STATES ITS OWN INK, and the ink follows the palette", () => {
    // We choose the fill, so we own the ink: `pickInk` would answer white on the dark
    // palette and BLACK on the light one for the same chip — one chip with two inks,
    // and the worse ratio (4.02 vs 5.02) on the lighter page.
    //
    // AND THE INK IS NOT ONE COLOUR ANY MORE. The dark palette builds a chip as a
    // saturated fill with light ink; the light palette builds it as a pale TINT with
    // deep ink of the same hue, because a saturated block glares on a white page
    // (`theme.ts`). So "white on everything" is exactly the rule that had to go, and
    // what replaces it is: the ink is the fill's OWN declared partner, and the pair
    // moves together when the theme flips.
    for (const mode of ["dark", "light"] as const) {
      setThemeMode(mode);
      expect({
        mode,
        sub: billingLabel("sub").fg,
        local: billingLabel("local").fg,
        metered: billingLabel("metered").fg,
      }).toEqual({ mode, sub: C.pillKeyFg, local: C.pillKeyFg, metered: C.pillCostFg });
      // The two halves never share an ink — that would erase the distinction the
      // column exists to make.
      expect(C.pillKeyFg).not.toBe(C.pillCostFg);
    }
    // And the flip actually MOVED them: a light-palette `SUB` painted in the dark
    // palette's white ink is the module-level-const bug this repo has found six times.
    setThemeMode("dark");
    const darkInk = billingLabel("sub").fg;
    setThemeMode("light");
    expect(billingLabel("sub").fg).not.toBe(darkInk);
    resetThemeModeForTests();
  });

  test("readiness has three states, not two — pending is not missing", () => {
    const g = (["pending", "ready", "missing"] as const).map(readinessGlyph);
    expect(new Set(g.map((x) => x.glyph)).size).toBe(3);
    expect(new Set(g.map((x) => x.fg)).size).toBe(3);
  });

  test("A PROBE IN FLIGHT IS NOT A WARNING — `◌` is `running`, not `warn`", () => {
    // The same call `chrome.tsx` already made for the catalog shimmer. Spending the
    // failure hue on "still checking" teaches the reader to discount it everywhere.
    expect(readinessGlyph("pending").fg).toBe(tokens.running);
    expect(readinessGlyph("pending").fg).not.toBe(tokens.warn);
  });
});

describe("capabilityWords", () => {
  test("a capability the catalog is SILENT about is not rendered as absent", () => {
    // `undefined` is not `false`. The slim catalog carries `supportsTools` for most
    // models and nothing for some, and printing an absence would be claiming a fact
    // nobody has.
    expect(capabilityWords(model({ supportsTools: true }))).toEqual(["tools"]);
    expect(capabilityWords(model({}))).toEqual([]);
    expect(capabilityWords(model({ supportsTools: false }))).toEqual([]);
  });

  test("all three are listed in a fixed order when all three are known", () => {
    expect(
      capabilityWords(model({ supportsTools: true, supportsReasoning: true, supportsVision: true }))
    ).toEqual(["tools", "reasoning", "vision"]);
  });
});

describe("detailText", () => {
  test("the exact spec leads, so the picker never hides its own return value", () => {
    const { text } = detailText("google@gemini-3.8-flash", model({ releaseDate: "2026-09-14" }));
    expect(text.startsWith("google@gemini-3.8-flash")).toBe(true);
    expect(text).toContain("2026-09");
  });

  test("`supportsTools: false` is DISQUALIFYING and says so in words", () => {
    // A model that cannot take tool definitions cannot drive Claude Code at all,
    // which is a different claim from "it is a bit less capable".
    expect(detailText("x@y", model({ supportsTools: false })).warn).toContain("no tool support");
    expect(detailText("x@y", model({ supportsTools: true })).warn).toBe("");
    expect(detailText("x@y", model({})).warn).toBe("");
  });
});

describe("providerFactsText", () => {
  test("billing is a SENTENCE, not a symbol — a flat rate says it costs nothing per token", () => {
    const sub = providerFactsText({
      label: "Kimi Coding",
      shortcut: "kc@",
      billing: "sub",
      envVar: "KIMI_CODING_API_KEY",
    });
    expect(sub.billing).toContain("flat-rate");
    expect(sub.billing).toContain("no per-token");
    // The short form makes the SAME claim in fewer words, for a row that cannot
    // afford the sentence — never a different claim, and never silence.
    expect(sub.billingShort).toContain("flat-rate");
    expect(sub.billingShort.length).toBeLessThan(sub.billing.length);
    expect(
      providerFactsText({ label: "", shortcut: "", billing: "metered", envVar: "" }).billing
    ).toContain("per token");
  });

  // REGRESSION: LM Studio picker hides models the cloud models catalog does not list
  test("local billing makes no claim about where the model runs", () => {
    // `local` comes from the claudish provider (ollama, lmstudio, vllm, mlx), not
    // from where its server is: LMSTUDIO_BASE_URL or OLLAMA_HOST may name another
    // host, and LM Studio LM Link runs a model on a linked device. The one claim
    // true in every case is the one that changes a decision.
    const local = providerFactsText({ label: "", shortcut: "", billing: "local", envVar: "" });
    expect(local.billing).toBe("self-hosted — no per-token charge");
    expect(local.billing).not.toContain("this machine");
    expect(local.billing).not.toContain("no network");
    expect(local.billingShort).toBe("local");
  });

  test("the credential is NAMED, and a sign-in provider says so instead of naming nothing", () => {
    // A truncated or absent variable name sends the reader hunting for a variable
    // that does not exist — a defect this dialog has already shipped once.
    expect(
      providerFactsText({
        label: "OpenRouter",
        shortcut: "or@",
        billing: "metered",
        envVar: "OPENROUTER_API_KEY",
      }).auth
    ).toBe("OPENROUTER_API_KEY");
    expect(
      providerFactsText({ label: "Devin", shortcut: "dv@", billing: "sub", envVar: "" }).auth
    ).toContain("signs in");
  });
});

describe("descriptionLines", () => {
  test("a short sentence is one row and is not padded into two", () => {
    expect(descriptionLines("A fast model.", 40, 2)).toEqual(["A fast model."]);
  });

  test("no row exceeds the width, and an over-long blurb ends in an ellipsis", () => {
    const long =
      "Kimi's most capable model to date, with 2.8 trillion parameters, native visual reasoning, " +
      "and a context window measured in millions of tokens across every supported modality.";
    const rows = descriptionLines(long, 40, 2);
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(40);
    expect(rows[1]?.endsWith("…")).toBe(true);
  });

  test("an absent description is NO rows — the block draws its own blanks", () => {
    // Returning `[""]` would be indistinguishable from a one-row description at the
    // call site, and the block's fixed height is what keeps the footer still.
    expect(descriptionLines("   ", 40, 2)).toEqual([]);
  });
});

describe("row identity depends on the VIEW", () => {
  const row = (provider: string, id: string, spec: string): PickerRow =>
    ({ provider, shortcut: "", spec, price: "", model: model({ id }) }) as PickerRow;

  test("ALL MODELS: one model on N providers is N rows, with N distinct specs", () => {
    // The owner's rule, verbatim: "if model has more than one provider that going
    // to be two lines in 'all models' list". `gpt-6-astra` at $30.00 on OpenRouter
    // beside the same model as SUB on Codex is the single most useful thing this
    // list does, and keying on the model id alone would delete two of the three.
    const kept = dedupeByProviderModel([
      row("openrouter", "gpt-6-astra", "openrouter@openai/gpt-6-astra"),
      row("openai", "gpt-6-astra", "oai@gpt-6-astra"),
      row("openai-codex", "gpt-6-astra", "cx@gpt-6-astra"),
    ]);
    expect(kept.length).toBe(3);
    expect(new Set(kept.map((r) => r.spec)).size).toBe(3);
  });

  test("ALL MODELS: the same model TWICE under ONE provider is still one row", () => {
    // A provider's dynamic models catalog and its catalog entries overlap, and that overlap
    // is not two routes — it is one route described twice.
    const kept = dedupeByProviderModel([
      row("kimi", "kimi-k3", "kimi@kimi-k3"),
      row("kimi", "kimi-k3", "kimi@kimi-k3"),
      row("kimi", "kimi-k2.6", "kimi@kimi-k2.6"),
    ]);
    expect(kept.map((r) => r.model.id)).toEqual(["kimi-k3", "kimi-k2.6"]);
  });

  test("PROVIDER CATALOG: one row per model id, dynamic models catalog and catalog collapsed", () => {
    // "and if we enter to provider catalog, not all models - then the model will
    // be just one". One route is in scope, so a second row would mean nothing —
    // even when the two sources spell the spec differently.
    const kept = dedupeByModelId([
      row("kimi", "kimi-k3", "kimi@kimi-k3"),
      row("kimi", "kimi-k3", "kimi@moonshot/kimi-k3"),
      row("kimi", "kimi-k2.6", "kimi@kimi-k2.6"),
    ]);
    expect(kept.length).toBe(2);
    // The FIRST wins, and the caller puts the dynamic models catalog first — what the
    // endpoint answered for THESE credentials beats what the catalog says.
    expect(kept[0]?.spec).toBe("kimi@kimi-k3");
  });
});

describe("providerColumn", () => {
  const entry = (value: string, label: string, shortcut: string) => ({ value, label, shortcut });

  test("NO TWO PROVIDERS EVER RENDER THE SAME STRING — the rejected rail's defect", () => {
    // `OpenCode Zen` and `OpenCode Zen Go` share a twelve-character prefix, which is
    // exactly the collision that rendered two different providers as `opencod…`.
    const { cells, text } = providerColumn(
      [
        entry("opencode-zen", "OpenCode Zen", "zen@"),
        entry("opencode-zen-go", "OpenCode Zen Go", "zengo@"),
        entry("sakana", "Sakana Fugu", "fugu@"),
        entry("sakana-subscription", "Sakana Fugu Subscription", "sc@"),
        entry("openrouter", "OpenRouter", "or@"),
      ],
      truncate
    );
    const drawn = [...text.values()];
    expect(new Set(drawn).size).toBe(drawn.length);
    for (const s of drawn) expect(s.length).toBeLessThanOrEqual(cells);
  });

  test("a name that FITS is printed whole — truncation is the exception, not the rule", () => {
    const { text } = providerColumn(
      [entry("openrouter", "OpenRouter", "or@"), entry("openai", "OpenAI", "oai@")],
      truncate
    );
    expect(text.get("openrouter")).toBe("OpenRouter");
    expect(text.get("openai")).toBe("OpenAI");
  });

  test("names that cannot be separated at ANY width fall back to the unique shortcut", () => {
    // Two custom endpoints with the same long name is a real configuration; the
    // shortcut is unique by construction because it is the shortest prefix that
    // parses back to exactly one provider.
    const same = "A Very Long Custom Endpoint Name";
    const { text } = providerColumn([entry("a", same, "aa@"), entry("b", same, "bb@")], truncate);
    const drawn = [...text.values()];
    expect(new Set(drawn).size).toBe(2);
    expect(drawn.some((s) => s.includes("bb@"))).toBe(true);
  });
});

const failure = (over: Partial<DiscoveryFailure> = {}): DiscoveryFailure => ({
  kind: "unauthorized",
  provider: "kimi",
  ...over,
});

describe("discoveryNoticeContent", () => {
  test("`failed` is the ERROR tier; the three empty states are the NOTICE tier", () => {
    const rows: PickerDiscoveryOutcome[] = [
      { kind: "failed", failure: failure(), notice: ["⚠ x failed"], fallbackRows: [] },
      {
        kind: "empty-models-catalog",
        failure: failure({ kind: "empty-models-catalog" }),
        fallbackRows: [],
      },
      { kind: "all-filtered", servedCount: 3, sampleIds: ["e"], fallbackRows: [] },
      { kind: "collapsed-empty", servedCount: 3, chatCount: 3, fallbackRows: [] },
    ];
    expect(rows.map((o) => discoveryNoticeContent(o, "Kimi")?.severity)).toEqual([
      "error",
      "notice",
      "notice",
      "notice",
    ]);
  });

  test("`rows` and `unsupported` render nothing at all", () => {
    expect(
      discoveryNoticeContent(
        { kind: "rows", rows: [model()], servedCount: 1, chatCount: 1 },
        "Kimi"
      )
    ).toBeNull();
    expect(
      discoveryNoticeContent({ kind: "unsupported", reason: "no-descriptor" }, "Kimi")
    ).toBeNull();
  });

  test("`empty-models-catalog` and `all-filtered` say DIFFERENT things", () => {
    const empty = discoveryNoticeContent(
      {
        kind: "empty-models-catalog",
        failure: failure({ kind: "empty-models-catalog" }),
        fallbackRows: [],
      },
      "Kimi"
    );
    const filtered = discoveryNoticeContent(
      {
        kind: "all-filtered",
        servedCount: 7,
        sampleIds: ["text-embedding-3-large"],
        fallbackRows: [],
      },
      "Kimi"
    );
    expect(empty?.lines[0]).toContain("empty");
    expect(filtered?.lines[0]).toContain("none of them chat-capable");
    expect(filtered?.lines.join(" ")).toContain("text-embedding-3-large");
    expect(empty?.lines[0]).not.toBe(filtered?.lines[0]);
  });

  test("A FALLBACK LIST SAYS IT MAY NOT WORK, not merely where it came from", () => {
    // The single most useful sentence in this state, and the one the shipped stderr
    // wording never carried: discovery failed because the credential was rejected,
    // so nothing has confirmed the account can call any of these models. A reader
    // told only "catalog entries" concludes the list is differently-sourced, picks
    // one, and finds out at launch.
    const c = discoveryNoticeContent(
      {
        kind: "failed",
        failure: failure({ status: 401 }),
        notice: [
          "\n⚠ Kimi could not list its models: the API key was rejected (HTTP 401)\n",
          "  Showing Kimi's cloud-catalog entries below — not its live model list.\n\n",
        ],
        fallbackRows: [model(), model({ id: "b" }), model({ id: "c" }), model({ id: "d" })],
      },
      "Kimi"
    );
    const joined = c?.lines.join(" ") ?? "";
    expect(joined).toContain("The 4 rows below");
    expect(joined).toContain("not Kimi's live model list");
    expect(joined).toContain("may still fail");
    // The formatter's own shorter sentence is REPLACED, not printed beside it.
    expect(joined).not.toContain("Showing Kimi's cloud-catalog entries");
  });

  test("no fallback list gets a next step instead of a provenance sentence", () => {
    const without = discoveryNoticeContent(
      {
        kind: "empty-models-catalog",
        failure: failure({ kind: "empty-models-catalog" }),
        fallbackRows: [],
      },
      "Kimi"
    );
    expect(without?.lines.join(" ")).toContain("Press c");
    expect(without?.lines.join(" ")).not.toContain("may still fail");
  });

  test("the dialog status for a failure says UNAVAILABLE, not broken", () => {
    const c = discoveryNoticeContent(
      { kind: "failed", failure: failure(), notice: ["⚠ x"], fallbackRows: [model()] },
      "Kimi"
    );
    expect(c?.title).toBe("live model list unavailable");
  });

  test("the HTTP status becomes a badge and leaves the headline once", () => {
    const c = discoveryNoticeContent(
      {
        kind: "failed",
        failure: failure({ status: 401 }),
        notice: ["\n⚠ Kimi could not list its models: the API key was rejected (HTTP 401)\n"],
        fallbackRows: [model()],
      },
      "Kimi"
    );
    expect(c?.badge).toBe("HTTP 401");
    expect(c?.lines[0]).not.toContain("(HTTP 401)");
    expect(c?.lines[0]).toContain("the API key was rejected");
  });

  test("NO rendered notice ever contains the substring `undefined`", () => {
    // Every variant × endpoint present/absent × status present/absent. `endpoint` and
    // `status` are both optional and a registered fetcher may report neither.
    const variants: PickerDiscoveryOutcome[] = [];
    for (const endpoint of [undefined, "https://api.test/v1/models"]) {
      for (const status of [undefined, 500]) {
        const f = failure({
          ...(endpoint === undefined ? {} : { endpoint }),
          ...(status === undefined ? {} : { status }),
        });
        variants.push({ kind: "failed", failure: f, notice: ["⚠ x"], fallbackRows: [] });
        variants.push({
          kind: "empty-models-catalog",
          failure: { ...f, kind: "empty-models-catalog" },
          fallbackRows: [],
        });
      }
    }
    variants.push({ kind: "all-filtered", servedCount: 1, sampleIds: [], fallbackRows: [] });
    variants.push({ kind: "collapsed-empty", servedCount: 1, chatCount: 1, fallbackRows: [] });
    for (const v of variants) {
      const c = discoveryNoticeContent(v, "Kimi");
      expect([v.kind, c?.lines.join(" ").includes("undefined") ?? false]).toEqual([v.kind, false]);
    }
  });
});

describe("wrapWords / noticeRows", () => {
  test("a line that fits is returned untouched", () => {
    expect(wrapWords("short enough", 40)).toEqual(["short enough"]);
  });

  test("no wrapped row exceeds the width", () => {
    const long =
      "The 4 rows below are catalog entries, not Kimi / Moonshot's live model list — they do not confirm access, so launching one may still fail.";
    for (const w of [30, 48, 70]) {
      for (const line of wrapWords(long, w)) expect(line.length).toBeLessThanOrEqual(w);
    }
  });

  test("THE `may still fail` CLAUSE SURVIVES AT 80 COLUMNS", () => {
    // It is the tail of the sentence, so a truncating banner would take it first —
    // which is exactly the failure this whole state exists to prevent.
    const content = discoveryNoticeContent(
      {
        kind: "failed",
        failure: failure({ status: 401 }),
        notice: [
          "\n⚠ Kimi could not list its models: the API key was rejected (HTTP 401)\n",
          "  Check MOONSHOT_API_KEY (a value in your shell overrides stored credentials).\n",
          "  Get a key: https://platform.moonshot.cn/\n",
        ],
        fallbackRows: [model(), model({ id: "b" }), model({ id: "c" }), model({ id: "d" })],
      },
      "Kimi"
    );
    // 76-column dialog: 2 border, 2 padding, 2 for the banner's own rule + gutter.
    const rows = noticeRows(content!, 70, 5);
    expect(rows.lines.join(" ")).toContain("may still fail");
    expect(rows.lines.length).toBeLessThanOrEqual(5);
    expect(rows.badge).toBe("HTTP 401");
  });

  test("the row count is knowable BEFORE render — the inline row budget depends on it", () => {
    const content = discoveryNoticeContent(
      { kind: "failed", failure: failure(), notice: ["⚠ x"], fallbackRows: [] },
      "Kimi"
    );
    const rows = noticeRows(content!, 70, 5);
    expect(rows.lines.length).toBeGreaterThan(0);
    expect(rows.lines.length).toBeLessThanOrEqual(5);
  });
});

describe("mergeCredentialLines", () => {
  test("merges the env-var and key-URL rows when they fit, dropping the parenthetical", () => {
    const lines = [
      "⚠ Kimi could not list its models: the API key was rejected",
      "Check MOONSHOT_API_KEY (a value in your shell overrides stored credentials).",
      "Get a key: https://platform.moonshot.cn/",
      "Showing Kimi's cloud-catalog entries below — not its live model list.",
    ];
    const merged = mergeCredentialLines(lines, 78);
    expect(merged.length).toBe(3);
    expect(merged[1]).toBe("Check MOONSHOT_API_KEY · Get a key: https://platform.moonshot.cn/");
  });

  test("leaves them apart when the merge would not fit", () => {
    const lines = [
      "head",
      "Check A_VERY_LONG_ENVIRONMENT_VARIABLE_NAME_INDEED (advice).",
      "Get a key: https://example.test/an/extremely/long/path/to/the/api/keys/page",
      "tail",
    ];
    expect(mergeCredentialLines(lines, 40)).toEqual(lines);
  });
});
