import { useCallback, useState } from "react";
import { prepareMuseLoginForTuiAction } from "../../providers/meta-muse/muse-credentials.js";
import { NATIVE_NOT_PROBED } from "../../providers/native-route.js";
import { describeProbeState } from "../../providers/probe-live.js";
import { INTERACTIVE_PROBE_TIMEOUT_MS, probeProviderRoute } from "../../providers/probe-runner.js";
import {
  type FallbackWithheld,
  type RouteExplanation,
  describeRouteExplanation,
  explainRoute,
} from "../../providers/routing-rules.js";
import { ensureProbeProxy } from "../probe-proxy.js";
import type { ProbeEntry, ProbeMode, ProbeSummary } from "../types.js";

/**
 * Why a catalog-gathered chain has no fallback hop, when the catalog HAS the
 * model. (When it does not, `describeRouteExplanation` already says so.)
 */
const FALLBACK_WITHHELD_NOTE: Record<FallbackWithheld, string> = {
  disabled: 'No fallback hop: the default provider is set to "".',
  "catalog-unreadable": "No fallback hop: there is no cloud models catalog to check it against.",
  "already-gathered": "No separate fallback hop: that provider is already a catalog candidate.",
  "catalog-denies": "No fallback hop: the catalog maps that provider no connection to this model.",
};

/** The probe panel's content for one decision: its summary and its rows. */
export interface ProbeView {
  summary: ProbeSummary;
  rows: ProbeEntry[];
}

/**
 * The probe panel for one `explainRoute` decision. Pure, so the panel's content
 * is testable without a renderer, a proxy or a network.
 *
 * - The summary line is `describeRouteExplanation`, so a user rule reads with its
 *   scope and the key `route()` actually matched (project over global, the
 *   longest glob), and the panel words every decision exactly as `--probe` does.
 * - One row per candidate, in chain order. A kept candidate is `pending`: the
 *   probe tests it. A dropped one is `dropped`, carrying the outcome that removed
 *   it, and is never tested.
 * - A native target has no candidates; its one row is the native passthrough,
 *   `unverified`, because this process cannot supply the auth it forwards.
 */
export function probeRowsFrom(explanation: RouteExplanation): ProbeView {
  const summary: ProbeSummary = {
    line: describeRouteExplanation(explanation),
    warnings: explanation.warnings.map((warning) => warning.message),
    notes: [],
  };

  if (explanation.source === "native") {
    // Why a native row is never probed, in the words `--probe` and the MCP
    // preflight use (native-route.ts).
    summary.notes.push(NATIVE_NOT_PROBED);
    const native = explanation.native;
    const rows: ProbeEntry[] = native
      ? [
          {
            provider: native.provider,
            displayName: native.displayName,
            modelSpec: native.modelSpec,
            status: "unverified",
          },
        ]
      : [];
    return { summary, rows };
  }

  if (explanation.catalog === "found" && explanation.fallbackWithheld) {
    summary.notes.push(FALLBACK_WITHHELD_NOTE[explanation.fallbackWithheld]);
  }
  if (explanation.outcome.kind === "no-route") {
    const { reason, hint } = explanation.outcome;
    summary.noRoute = hint !== undefined ? { reason, hint } : { reason };
  }

  const rows = explanation.candidates.map((candidate): ProbeEntry => {
    const row: ProbeEntry = {
      provider: candidate.provider,
      displayName: candidate.displayName,
      modelSpec: candidate.modelSpec,
      position: candidate.position,
      ...(candidate.tier !== undefined ? { tier: candidate.tier } : {}),
      status: "pending",
    };
    if (candidate.outcome !== "kept") {
      row.status = "dropped";
      row.outcome = candidate.outcome;
    }
    return row;
  });
  return { summary, rows };
}

/** One hop the probe tests: its row, and the spec a request would send. */
export interface ProbeQueueItem {
  index: number;
  provider: string;
  modelSpec: string;
}

/**
 * The hops the probe tests, in chain order: the kept ones, and nothing else. A
 * dropped candidate or the native passthrough never enters `testing`.
 */
export function probeQueue(rows: ProbeEntry[]): ProbeQueueItem[] {
  return rows.flatMap((row, index) =>
    row.status === "pending" && row.modelSpec !== undefined
      ? [{ index, provider: row.provider, modelSpec: row.modelSpec }]
      : []
  );
}

/**
 * `explainRoute`, with its one throwing case folded into a view it can render.
 *
 * A bare name makes routing THROW when the catalog contract is one this build
 * cannot read (providers/routing-rules.ts) — deliberately, so no caller mistakes
 * "claudish cannot look" for "claudish looked and found nothing". The probe is
 * the caller that wants exactly that flattening, though: it is a diagnostic
 * panel, its whole job is to display why a model will not route, and an
 * unhandled rejection inside the render tree would take the config UI down
 * instead of answering the question. The message survives verbatim as the
 * no-route reason.
 */
async function probeViewFor(model: string): Promise<ProbeView> {
  try {
    return probeRowsFrom(await explainRoute(model));
  } catch (err) {
    return {
      summary: {
        line: "the route could not be calculated",
        warnings: [],
        notes: [],
        noRoute: { reason: err instanceof Error ? err.message : String(err) },
      },
      rows: [],
    };
  }
}

/**
 * Discriminated-union state for the route probe wizard.
 *
 * NOTE: this hook intentionally does NOT abort the in-flight test loop on
 * `cancel()`. The IIFE in `submit()` keeps running and continues calling
 * `setProbeResults` / `setProbeMode` even after `cancel()` flips the state to
 * idle. This preserves baseline behavior — see "Probe cancel does NOT abort
 * the in-flight loop" constraint in the refactor task description.
 */
export type ProbeState =
  | { kind: "idle" }
  | { kind: "input"; model: string }
  | { kind: "running"; model: string; results: ProbeEntry[] }
  | { kind: "done"; model: string; results: ProbeEntry[] };

export interface UseRouteProbeReturn {
  /** Discriminated-union view of the probe wizard state. */
  state: ProbeState;
  /** Legacy probe-mode tag (for prop drilling into render components). */
  probeMode: ProbeMode;
  /** Current input or submitted model name (empty string when idle). */
  probeModel: string;
  /** Per-candidate probe rows (empty when idle/input). */
  probeResults: ProbeEntry[];
  /** The decision as a whole: its explanation line, warnings and no-route reason. */
  probeSummary: ProbeSummary | null;
  /** Switch to input mode with a blank model + cleared results. */
  startInput: () => void;
  /** Append a single character to the input. No-op outside input. */
  typeChar: (ch: string) => void;
  /** Trim one character. No-op outside input. */
  backspace: () => void;
  /**
   * Submit the current input. Empty input → idle; a decision with nothing to
   * test (no route, every candidate dropped, native) → done; otherwise →
   * running, kicks off the async test loop over the kept hops.
   *
   * The async loop is INTENTIONALLY not abort-aware. See the type comment.
   */
  submit: () => void;
  /**
   * Cancel from running/done — clear results, set state to idle.
   * Does NOT abort an in-flight test loop (preserves baseline wart).
   */
  cancel: () => void;
  /** From done state, start a new probe (blank input). */
  enterFromDone: () => void;
}

export function useRouteProbe(): UseRouteProbeReturn {
  const [probeMode, setProbeMode] = useState<ProbeMode>("idle");
  const [probeModel, setProbeModel] = useState("");
  const [probeResults, setProbeResults] = useState<ProbeEntry[]>([]);
  const [probeSummary, setProbeSummary] = useState<ProbeSummary | null>(null);

  const startInput = useCallback(() => {
    setProbeModel("");
    setProbeResults([]);
    setProbeSummary(null);
    setProbeMode("input");
  }, []);

  const typeChar = useCallback((ch: string) => {
    setProbeModel((p) => p + ch);
  }, []);

  const backspace = useCallback(() => {
    setProbeModel((p) => p.slice(0, -1));
  }, []);

  const cancel = useCallback(() => {
    // NOTE: does NOT abort the in-flight async loop in submit() — see
    // type comment. Preserves baseline behavior.
    setProbeModel("");
    setProbeResults([]);
    setProbeSummary(null);
    setProbeMode("idle");
  }, []);

  const enterFromDone = useCallback(() => {
    setProbeModel("");
    setProbeResults([]);
    setProbeSummary(null);
    setProbeMode("input");
  }, []);

  const submit = useCallback(() => {
    const model = probeModel.trim();
    if (!model) {
      setProbeModel("");
      setProbeMode("idle");
      return;
    }
    // explainRoute is async (credential resolution may pull from 1Password); the
    // rest of submit is already async, so the whole flow runs in one IIFE.
    (async () => {
      // The decision a request for this name would get, made by the function the
      // proxy's routing runs: the native gate, the user's rules (both scopes), the
      // catalog, the fallback hop, and the credential and availability filters.
      const { summary, rows } = await probeViewFor(model);
      setProbeSummary(summary);
      setProbeResults(rows);

      // Only kept hops are tested. With none — a no-route, every candidate
      // dropped, or the native passthrough — there is nothing to probe, and the
      // proxy is never started: its startup failure would repaint rows `failed`.
      const queue = probeQueue(rows);
      if (queue.length === 0) {
        setProbeMode("done");
        return;
      }
      setProbeMode("running");

      // Run tests sequentially over the kept hops, in chain order.
      // INTENTIONAL: the loop is NOT abort-aware. Even after the user presses
      // Esc to cancel and the state flips to idle, this loop keeps running and
      // can transition the state back to "done" via setProbeMode("done").
      // This preserves the baseline behavior — DO NOT add an AbortController.
      //
      // Each probe runs through the same lazy proxy the Providers tab uses, so
      // OAuth providers (e.g. antigravity after `claudish login antigravity`)
      // are tested for real instead of being misreported as missing.
      (async () => {
        // Best-effort proxy startup. If it fails we mark every hop we would have
        // tested as failed, with a clear error. Dropped rows keep their outcome.
        let proxyUrl: string;
        try {
          // A Muse Code hop: resolve its login in-process first, the one TUI
          // path that may read the Muse Code CLI's Keychain item.
          if (queue.some((item) => item.provider === "meta-muse-code")) {
            await prepareMuseLoginForTuiAction();
          }
          proxyUrl = await ensureProbeProxy();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const queued = new Set(queue.map((item) => item.index));
          setProbeResults((prev) =>
            prev.map((e, idx) =>
              queued.has(idx) ? { ...e, status: "failed", error: `probe proxy: ${msg}` } : e
            )
          );
          setProbeMode("done");
          return;
        }

        for (const link of queue) {
          const i = link.index;
          // Mark current as testing
          setProbeResults((prev) =>
            prev.map((e, idx) => (idx === i ? { ...e, status: "testing" } : e))
          );
          const startMs = Date.now();
          const result = await probeProviderRoute(
            proxyUrl,
            {
              provider: link.provider,
              modelSpec: link.modelSpec,
              // A kept hop passed explainRoute's credential filter, the only
              // credential check; the proxy resolves the key itself.
              hasCredentials: true,
            },
            INTERACTIVE_PROBE_TIMEOUT_MS
          ).catch((e) => ({
            state: "error" as const,
            latencyMs: Date.now() - startMs,
            errorMessage: String(e instanceof Error ? e.message : e),
          }));
          const ms = Date.now() - startMs;
          const ok = result.state === "live";
          setProbeResults((prev) =>
            prev.map((e, idx) => {
              if (idx === i)
                return {
                  ...e,
                  status: ok ? ("success" as const) : ("failed" as const),
                  error: ok ? undefined : describeProbeState(result),
                  ms,
                };
              // After a success, every later kept hop is "not reached". Dropped
              // rows keep their outcome.
              if (idx > i && ok && e.status === "pending")
                return { ...e, status: "skipped" as const };
              return e;
            })
          );
          if (ok) break;
        }
        setProbeMode("done");
      })();
    })();
  }, [probeModel]);

  // Build the DU view from the underlying state atoms.
  let state: ProbeState;
  if (probeMode === "idle") state = { kind: "idle" };
  else if (probeMode === "input") state = { kind: "input", model: probeModel };
  else if (probeMode === "running")
    state = { kind: "running", model: probeModel, results: probeResults };
  else state = { kind: "done", model: probeModel, results: probeResults };

  return {
    state,
    probeMode,
    probeModel,
    probeResults,
    probeSummary,
    startInput,
    typeChar,
    backspace,
    submit,
    cancel,
    enterFromDone,
  };
}
