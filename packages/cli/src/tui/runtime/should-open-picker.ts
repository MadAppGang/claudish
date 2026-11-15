/**
 * should-open-picker.ts — the model picker's launch gate, as one pure predicate.
 *
 * THE DEFECT THIS CLOSES. Until now nothing asked whether a terminal was there.
 * `index.ts` opened the picker on `cliConfig.interactive` alone, and `cli.ts`
 * sets that flag true whenever there is no positional prompt, no `--stdin` and
 * no `-p`:
 *
 *     if (!config._hasPositionalPrompt && !config.stdin && !config._hasPrintFlag)
 *       config.interactive = true;
 *
 * So `claudish < /dev/null`, `claudish` on a CI runner, and `claudish` detached
 * all reached a prompt that drew into a stream nobody reads and then blocked on a
 * keypress that could never arrive. `-p` was already excluded — `_hasPrintFlag`
 * exists precisely to stop that default flipping on — and
 * `ai-docs/architecture/headless-vs-interactive.md` is why that matters: `-p
 * --input-format stream-json` is the mode where a wrong flag yields silence and
 * exit 0, so the picker must never appear in it. This predicate makes the piped
 * and detached cases fail the same way, by asking the one question that was
 * missing.
 *
 * WHY NOT A FALLBACK TO THE LINE-ORIENTED PROMPT. Inquirer in a non-TTY is the
 * bug, not the safety net: it draws into an unread stream and waits for a key
 * that cannot come. "Falling back" would be falling back to a hang. So
 * `requiresExplicitModel` routes the same cases to the existing non-interactive
 * error — four actionable lines naming `--model`, `CLAUDISH_MODEL`, `--profile`
 * and `claudish --models` — and exit 1.
 *
 * THE TTY ANSWER IS A PARAMETER, NOT AN IMPORT. Both functions here are total
 * over their inputs and read nothing from the process, which is what makes the
 * whole 2^5 grid table-testable without running `runCli`. `index.ts` supplies the
 * answer from `canDrawTui()`, the single isTTY oracle next door. For the same
 * reason as that file: THIS MODULE IMPORTS NOTHING, and keeps `index.ts`'s cold
 * static graph clean.
 */

/**
 * Everything the gate is allowed to look at, derived at the call site from
 * `ClaudishConfig`.
 *
 * `hasProfileTiers` is an input rather than four fields so the predicate's domain
 * stays small enough to enumerate: five booleans, which is the 32-cell grid its
 * test walks, plus `advisorNativeSession` and `hasModelListings`, each of which
 * behaves exactly like `monitor` rather than doubling the grid.
 */
export interface ModelPickerGate {
  /**
   * `cli.ts`'s interactive default: no positional prompt, no `--stdin`, no `-p`.
   * False means some other channel already carries the prompt, so there is no
   * point in the launch sequence at which a human is waiting to choose.
   */
  interactive?: boolean;
  /** `--monitor` proxies to the real Anthropic API and runs no model of ours. */
  monitor?: boolean;
  /**
   * `--advisor` with no main model: Claude Code runs natively and picks its own
   * model, so there is nothing to select and nothing to demand. A term of the
   * gate rather than a condition beside it — see `noModelConfigured`.
   */
  advisorNativeSession?: boolean;
  /**
   * The launch lists claudish providers in Claude Code's `/model` (`--model
   * devin@`): the user chose what to list, and a launch with no full spec
   * starts on Claude's default model, so there is nothing to select and
   * nothing to demand. A term of the gate beside `advisorNativeSession`, for
   * the same reason.
   */
  hasModelListings?: boolean;
  /** `--model` / `CLAUDISH_MODEL` / a profile's single spec — already chosen. */
  model?: string;
  /**
   * True when `--model-opus/-sonnet/-haiku/-subagent` (or a profile supplying
   * them) is present: Claude Code picks per tier internally, so claudish needs no
   * single model and must not ask for one.
   */
  hasProfileTiers?: boolean;
}

/**
 * True when no model configuration of any kind exists for this run, so SOMETHING
 * has to supply one before the proxy can start.
 *
 * Not exported: it is the shared left-hand side of the two gates below, and both
 * of them are what call sites should ask. Exporting a third name would invite a
 * third gate that drifts from these two.
 *
 * `advisorNativeSession` belongs HERE, beside `monitor`, and not AND-ed onto one
 * call site: it is a reason no model is needed, so it must suppress the picker
 * and the error together. A term carried by only one of the two gates is exactly
 * the drift this file exists to prevent — it would let a run skip the picker
 * silently and still be told to name a model, or the reverse.
 */
function noModelConfigured(gate: ModelPickerGate): boolean {
  return (
    !gate.monitor &&
    !gate.advisorNativeSession &&
    !gate.hasModelListings &&
    !gate.model &&
    !gate.hasProfileTiers
  );
}

/**
 * May the interactive model picker be opened for this run?
 *
 * @param gate - The run's model configuration and interactivity.
 * @param tty - `canDrawTui()` — both of our own streams are terminals.
 * @returns True only when a model is missing, a human is waiting, and there is a
 *   screen to paint on. `{interactive: true, tty: false}` is the case this whole
 *   file exists for, and it is false.
 */
export function shouldOpenPicker(gate: ModelPickerGate, tty: boolean): boolean {
  return noModelConfigured(gate) && Boolean(gate.interactive) && tty;
}

/**
 * Must this run be told to name a model on the command line instead?
 *
 * The exact complement of `shouldOpenPicker` over the runs that need a model:
 * when `noModelConfigured(gate)` holds, exactly one of the two is true, and when
 * it does not, both are false. That law is what makes the second call site safe
 * to widen — there is no input for which the picker is skipped silently AND the
 * error stays quiet.
 *
 * @param gate - The run's model configuration and interactivity.
 * @param tty - `canDrawTui()` — both of our own streams are terminals.
 * @returns True when a model is still needed and no picker can supply it, either
 *   because the run is non-interactive or because there is no terminal.
 */
export function requiresExplicitModel(gate: ModelPickerGate, tty: boolean): boolean {
  return noModelConfigured(gate) && !shouldOpenPicker(gate, tty);
}
