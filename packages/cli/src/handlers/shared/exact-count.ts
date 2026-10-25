/**
 * #674 — exact prompt counting at the wall.
 *
 * The generated `/4` estimate cannot decide admission: over 1 111 served swift
 * responses (25/10, req→resp paired) `real/est` spans **0.57 → 3.18** (p50
 * ×1.068, p95 ×1.118, p99 ×1.196). Every consequence of that spread was
 * measured on the same lane:
 *
 *   - a cap learned from one refusal short-circuited prompts whose real count
 *     was 209k–262k, i.e. UNDER the 262 144 window (the [cap, window) band);
 *   - the derived-window short-circuit (`est ≥ window`) therefore almost never
 *     fired on real over-window prompts — their estimate tops out near 242k —
 *     so each doomed prompt still paid one round-trip before #431 skipped it.
 *
 * No fixed factor repairs that in both directions: one large enough to catch
 * the tail refuses prompts that fit. So the estimate keeps only ONE job here —
 * nominating a request for the uncertain band — and the engine's own tokenizer
 * decides. Measured 25/10 on the shipping vLLM (`swift-1.5-27b`), from inside
 * the hub container: `POST {root}/tokenize` → 200 `{count, max_model_len}`;
 * `{model, messages}` is accepted and the chat template is applied server-side
 * (12 tokens for `hello world`, against 2 for the raw prompt — so the `prompt`
 * shape would under-count every real request), and `/v1/tokenize` is a 404.
 *
 * The band is one-sided by design (`est ≥ window / band`), because that is the
 * only region where a wrong answer changes anything: below it, even the worst
 * measured over-count does not reach the window; above it, the old gate refused
 * on the estimate alone. Inside, `est` never refuses — the exact count does.
 *
 * Everything here is inert without a transport that exposes a tokenizer
 * (`countPromptTokens`), and `CLAUDISH_EXACT_COUNT=0` disarms it outright.
 */

/** Fraction of the window at which the estimate starts nominating (#674). */
export const EXACT_COUNT_DEFAULT_BAND = 1.15;

/** A band below 1 would probe on every request; above 2 the tail is unreachable. */
const EXACT_COUNT_MIN_BAND = 1.0;
const EXACT_COUNT_MAX_BAND = 2.0;

/**
 * `CLAUDISH_EXACT_COUNT=0` disarms the whole feature: no probe, no band, the
 * derived-window short-circuit behaves exactly as it did before #674. Only an
 * explicit "0" disarms — the house convention for every kill switch.
 */
export function exactCountDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CLAUDISH_EXACT_COUNT || "").trim() === "0";
}

/**
 * `CLAUDISH_EXACT_COUNT_BAND` — how far below the window the probe starts.
 * Strict decimal parse: a unit-suffixed or non-numeric value falls back to the
 * default rather than to `NaN` (a NaN band would silently disarm the probe —
 * `est >= window / NaN` is false for every request).
 */
export function readExactCountBand(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.CLAUDISH_EXACT_COUNT_BAND || "").trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) return EXACT_COUNT_DEFAULT_BAND;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return EXACT_COUNT_DEFAULT_BAND;
  return Math.min(Math.max(parsed, EXACT_COUNT_MIN_BAND), EXACT_COUNT_MAX_BAND);
}

/**
 * Does this request belong in the band where only an exact count may decide?
 *
 * `window / band`, ceiled: at the default 1.15 a 262 144 window nominates from
 * 227 952 — the region the measured spread actually covers. A non-finite
 * estimate or a non-positive window nominates nothing (no probe on a value we
 * cannot reason about).
 */
export function inExactCountBand(
  est: number,
  window: number,
  band: number = EXACT_COUNT_DEFAULT_BAND
): boolean {
  if (!Number.isFinite(est) || !Number.isFinite(window) || window <= 0) return false;
  if (!Number.isFinite(band) || band <= 0) return false;
  return est >= Math.ceil(window / band);
}
