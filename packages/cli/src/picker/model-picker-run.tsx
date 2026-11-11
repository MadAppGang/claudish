/** @jsxImportSource @opentui/react */
/**
 * picker/model-picker-run.tsx — bootstrap, teardown, and the ONE stderr write.
 *
 * This is the only place `@opentui/core` and `@opentui/react` meet, and it is reached
 * from `model-selector.ts` through a DYNAMIC `await import()` — which is what keeps a
 * renderer out of the cold-start graph and, more importantly, out of the MCP stdio
 * path, whose stdout is a protocol. `providers/model-ordering.ts:10-18` records why
 * that constraint exists; it applies with more force to OpenTUI than to inquirer.
 *
 * THREE DEPARTURES FROM THE SKILL'S STOCK BOOTSTRAP, each forced by a fact:
 *
 * 1. `screenMode: "main-screen"` — INLINE, and never `useAlternateScreen`. Two
 *    separate facts are packed into that one line.
 *
 *    The KEY: `@opentui/core@0.1.107` renamed `useAlternateScreen` to `screenMode`,
 *    and the old key is an unknown key — silently ignored, no warning, no type
 *    error.
 *
 *    The VALUE: the picker is a one-shot command, which is the row the guidance's
 *    own `screenMode` table assigns to `main-screen`. The first build chose the
 *    alternate screen and was rejected. Inline is not cosmetic here — it is what
 *    makes the dialog read as a program ASKING something rather than a program that
 *    has taken the terminal, it keeps the shell prompt and the claudish banner
 *    (`printLogo`, already written above) on screen so the dialog needs no branding
 *    of its own, and it means the failure notice is still in the scrollback after
 *    the picker closes instead of being discarded with the alternate buffer.
 *
 * 2. `installShutdown` is not used. Its contract ends in `process.exit(code)`, which is
 *    right for an app whose quit key means quit and wrong for a picker, whose entire job
 *    is to hand a model spec back to a caller that then launches Claude Code. What it
 *    guarantees — never leave the terminal wedged in raw mode inside the alternate
 *    screen — is provided by the `finally` below, which always unmounts React and then
 *    destroys the renderer, in that order. Same reasoning, same order, as
 *    `resume-picker-run.tsx:20-29`.
 *
 * 3. `setStderrQuiet(true)` before the renderer and `false` after. Anything written to
 *    the terminal behind a live renderer leaves cells OpenTUI cannot invalidate — ghost
 *    characters, not an exception, which is why no test catches it.
 *
 * AND ONE WRITE THAT IS DELIBERATE, WHICH INLINE MODE MAKES SMALLER BUT NOT
 * UNNECESSARY. Inline rendering leaves the last frame in the scrollback, so the
 * in-dialog failure notice survives `destroy()` — that is one of the reasons for
 * choosing it. What it does NOT survive is truncation: the dialog shows five rows of
 * a notice that may carry an upstream JSON body, and a user piping stderr to a file
 * gets nothing from a rendered frame at all. So every failure seen during the session
 * is buffered and written once, after teardown, at the same point
 * `resume-picker-run.tsx:115` restores stderr. Every failure, in order, not just the
 * one the user landed on: today each failed selection prints immediately, so a session
 * that tried two failing providers leaves two diagnostics, and writing one would be a
 * quiet narrowing.
 */

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { setStderrQuiet } from "../logger.js";
import type { ModelSelectorOptions } from "../model-selector.js";
import { ensureEndpointsRegistered } from "../providers/endpoint-registration.js";
import { applyRendererThemeMode } from "../theme/renderer-theme.js";
import { ModelPicker } from "./ModelPicker.js";
import { type PickerDataSource, createPickerDataSource } from "./PickerDataSource.js";

/** What the picker hands back. `null` ⟺ the user declined to choose. */
export interface ModelPickerOutcome {
  model: string | null;
  contextWindow?: number;
}

/**
 * A scriptable data source, selected by `CLAUDISH_PICKER_FIXTURE=<name>`.
 *
 * DEV-ONLY, AND REACHED BY DYNAMIC IMPORT BEHIND THE ENV CHECK, so
 * `bun build --compile` never walks into `picker/fixtures/` and the shipped binary
 * carries no fixture data. The states it forces — a timeout, an empty dynamic models catalog, a dynamic models catalog
 * where nothing is chat-capable, and the in-flight frames themselves — are not
 * reachable against a live provider, and they are the states this feature exists to
 * render. A capture of the happy path alone would validate nothing.
 */
async function resolveDataSource(): Promise<PickerDataSource> {
  const name = process.env.CLAUDISH_PICKER_FIXTURE;
  if (!name) return createPickerDataSource();
  const { createFixtureDataSource } = await import("./fixtures/fixture-source.js");
  return createFixtureDataSource(name);
}

export async function runModelPicker(
  options: ModelSelectorOptions = {}
): Promise<ModelPickerOutcome> {
  // Before the first render, exactly as `tui/index.tsx:38` does it: the rail is built
  // from `getAllProviders()`, so a custom or predefined endpoint must already be in the
  // provider list or it is simply not there to pick. Re-entry calls this again — idempotent by
  // design. It is synchronous, and it runs before `createCliRenderer`, so it costs no
  // frame. (`claudish profile edit` reaches `selectModel` WITHOUT passing through
  // `index.ts:590`, so without this line that path enumerates a provider list missing them.)
  ensureEndpointsRegistered();

  const source = await resolveDataSource();

  /** Buffered diagnostics: provider → the lines, in the order the failures occurred. */
  const deferred: Array<{ provider: string; lines: readonly string[] }> = [];

  setStderrQuiet(true);

  const renderer = await createCliRenderer({
    screenMode: "main-screen",
    // MEASURED: without this, `destroy()` WIPES the region and inline mode buys
    // nothing over the alternate screen — a tmux capture taken one second after Esc
    // held nothing but the shell's own `EXIT=0`, with the dialog and the claudish
    // banner both gone. Leaving the last frame is the whole point of rendering
    // inline: what the user chose, and any discovery failure they were shown, stay
    // in the scrollback where they can be read after Claude Code has started.
    clearOnShutdown: false,
    exitOnCtrlC: false, // the picker maps Ctrl+C to "cancel", which RETURNS a value
  });

  // Light/dark palette selection BEFORE first paint. Unanswered → null → dark, which
  // is the status quo. This is what makes every `C.*`/`tokens.*` read in the tree
  // below resolve to the right palette — and why none of them may be a module-level
  // `const`, which would have snapshotted dark before this line ran.
  await applyRendererThemeMode(renderer);

  const root = createRoot(renderer);

  let chosen: string | null = null;
  let chosenContextWindow: number | undefined;
  try {
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (spec: string | null, contextWindow?: number): void => {
        // Enter and Ctrl+C can both land before the tree stops rendering, and resolving
        // twice would leave the second teardown racing the first.
        if (settled) return;
        settled = true;
        chosen = spec;
        chosenContextWindow = contextWindow;
        resolve();
      };
      root.render(
        <ModelPicker
          source={source}
          askContextWindow={options.onContextWindow !== undefined}
          onDone={done}
          onDiscoveryFailure={(provider, lines) => deferred.push({ provider, lines })}
        />
      );
    });
  } finally {
    // Order is load-bearing, and the reason this is a `finally`: unmount React first so
    // nothing can paint into a destroyed renderer, then destroy, which is what actually
    // restores the terminal out of raw mode and off the alternate screen. Each step is
    // guarded on its own — a throwing unmount must not be able to skip the destroy.
    // In-flight fetches are abandoned, not awaited; nothing writes to a dead renderer
    // because the tree is already gone.
    try {
      root.unmount();
    } catch {
      /* the tree is already gone; the destroy below is what matters */
    }
    try {
      renderer.destroy();
    } catch {
      /* nothing left to restore */
    }
    setStderrQuiet(false);

    // THE ONE ALLOWED WRITE. `picker/**` and `tui/**` are forbidden from touching
    // stdout/stderr — the renderer owns the terminal — and this block is the explicit
    // exception, asserted as such by `no-terminal-writes.test.ts`. It runs AFTER the
    // renderer is destroyed, so there is no buffer left to corrupt. The lines carry
    // their own newlines, so the bytes match what `warnDiscoveryFailure` has always
    // written.
    for (const entry of deferred) {
      for (const line of entry.lines) process.stderr.write(line);
    }
  }

  return { model: chosen, contextWindow: chosenContextWindow };
}
