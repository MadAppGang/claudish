import { useCallback, useState } from "react";
import type { ClaudishProfileConfig } from "../../profile-config.js";
import { nativeRouteFor } from "../../providers/native-route.js";

/**
 * Why a native row is never probed here: the native handler authenticates with
 * the inbound Claude Code header, which this probe cannot supply, so a request
 * would fail for a healthy model and a typo alike (see providers/native-route.ts).
 */
const REASON_NATIVE =
  "Native Claude Code auth — not probed — served on Claude Code's own auth, which this process cannot forward";
import { describeProbeState } from "../../providers/probe-live.js";
import { INTERACTIVE_PROBE_TIMEOUT_MS, probeProviderRoute } from "../../providers/probe-runner.js";
import { type Route, type RoutePlan, route } from "../../providers/routing-rules.js";
import { ensureProbeProxy } from "../probe-proxy.js";
import { getProviderDefs, providerIsReady } from "../providers.js";
import type { ProbeEntry, ProbeMode } from "../types.js";

/**
 * `route()`, with its one throwing case folded into the plan it already renders.
 *
 * A bare name makes `route()` THROW when the catalog contract is one this build
 * cannot read (providers/routing-rules.ts) — deliberately, so no caller mistakes
 * "claudish cannot look" for "claudish looked and found nothing". The probe is
 * the caller that wants exactly that flattening, though: it is a diagnostic
 * panel, its whole job is to display why a model will not route, and an
 * unhandled rejection inside an Ink render tree would take the config UI down
 * instead of answering the question. The message survives verbatim into the
 * panel's error column via `plan.reason`.
 */
async function routeForProbe(model: string): Promise<RoutePlan> {
  try {
    return await route(model);
  } catch (err) {
    return { kind: "no-route", reason: err instanceof Error ? err.message : String(err) };
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
  /** Per-provider probe results (empty when idle/input). */
  probeResults: ProbeEntry[];
  /** Switch to input mode with a blank model + cleared results. */
  startInput: () => void;
  /** Append a single character to the input. No-op outside input. */
  typeChar: (ch: string) => void;
  /** Trim one character. No-op outside input. */
  backspace: () => void;
  /**
   * Submit the current input. Empty input → idle; unroutable model → done with
   * single failed entry; otherwise → running, kicks off the async test loop.
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

export function useRouteProbe(config: ClaudishProfileConfig): UseRouteProbeReturn {
  const [probeMode, setProbeMode] = useState<ProbeMode>("idle");
  const [probeModel, setProbeModel] = useState("");
  const [probeResults, setProbeResults] = useState<ProbeEntry[]>([]);

  const startInput = useCallback(() => {
    setProbeModel("");
    setProbeResults([]);
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
    setProbeMode("idle");
  }, []);

  const enterFromDone = useCallback(() => {
    setProbeModel("");
    setProbeResults([]);
    setProbeMode("input");
  }, []);

  const submit = useCallback(() => {
    const model = probeModel.trim();
    if (!model) {
      setProbeModel("");
      setProbeMode("idle");
      return;
    }
    // route() is async (credential resolution may pull from 1Password); the rest
    // of submit is already async, so the whole flow runs in one IIFE.
    (async () => {
      // Same guard the proxy applies before routing: a bare Claude name is native
      // passthrough, and route() would misreport it (see providers/native-route.ts).
      // The native link joins the chain so the panel shows it, but it is skipped
      // in the loop below: this probe cannot supply the Claude Code auth the
      // native handler forwards, so any request would fail regardless of model.
      const native = nativeRouteFor(model);
      let chain: Route[];
      if (native) {
        chain = [native];
      } else {
        const plan = await routeForProbe(model);
        if (plan.kind !== "ok") {
          setProbeResults([
            {
              provider: "none",
              displayName: "No routes found",
              status: "failed",
              error: plan.hint ?? plan.reason,
            },
          ]);
          setProbeMode("done");
          return;
        }
        chain = [plan.primary, ...plan.fallbacks];
      }
      // Check which routing rule matched. Case-INSENSITIVE — must mirror the
      // matching logic in matchRoutingRule (routing-rules.ts) so the probe panel
      // doesn't lie about which rule the engine actually picked.
      const ruleEntries = Object.entries(config.routing ?? {});
      const modelLower = model.toLowerCase();
      const matchedRule = ruleEntries.find(([pat]) => {
        if (pat.toLowerCase() === modelLower) return true;
        if (pat.includes("*")) {
          const regex = new RegExp(`^${pat.replace(/\*/g, ".*")}$`, "i");
          return regex.test(model);
        }
        return false;
      });

      const initial: ProbeEntry[] = chain.map((r) => {
        return {
          provider: r.provider,
          displayName: r.displayName,
          status: "pending",
          hasKey: true,
          reason: native
            ? "Native Claude Code auth — served by the proxy, never routed"
            : matchedRule
              ? `Custom rule: ${matchedRule[0]}`
              : "Default fallback chain",
        };
      });
      setProbeResults(initial);
      setProbeMode("running");

      // Run tests sequentially — skip providers without credentials.
      // INTENTIONAL: the loop is NOT abort-aware. Even after the user presses
      // Esc to cancel and the state flips to idle, this loop keeps running and
      // can transition the state back to "done" via setProbeMode("done").
      // This preserves the baseline behavior — DO NOT add an AbortController.
      //
      // Each probe runs through the same lazy proxy the Providers tab uses, so
      // OAuth providers (e.g. antigravity after `claudish login antigravity`)
      // are tested for real instead of being misreported as missing.
      (async () => {
        // A native chain has nothing to probe — settle it BEFORE the proxy is
        // touched. Proxy startup failure below repaints every row `failed`,
        // which would turn the native row back into a red "no route".
        if (native) {
          setProbeResults((prev) =>
            prev.map((e) => ({ ...e, status: "unverified" as const, reason: REASON_NATIVE }))
          );
          setProbeMode("done");
          return;
        }
        // Best-effort proxy startup. If it fails we mark everything as failed
        // with a clear error.
        let proxyUrl: string;
        try {
          proxyUrl = await ensureProbeProxy();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setProbeResults((prev) =>
            prev.map((e) => ({ ...e, status: "failed", error: `probe proxy: ${msg}` }))
          );
          setProbeMode("done");
          return;
        }

        for (let i = 0; i < chain.length; i++) {
          const link = chain[i]!;
          // Mirror the static credential check from hasCredentialsForProvider —
          // covers env, config, OAuth files. Local providers are always ready.
          const provDef = getProviderDefs().find((p) => p.catalogName === link.provider);
          const ready = provDef ? providerIsReady(provDef, config) : true;
          if (!ready) {
            setProbeResults((prev) =>
              prev.map((e, idx) => (idx === i ? { ...e, status: "no_key" } : e))
            );
            continue;
          }
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
              // Let the proxy do the real credential resolution. The static
              // ready-check above just gates the noisy "no key" rows.
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
              // After success: remaining providers with keys become "not reached",
              // without keys stay "no_key"
              if (idx > i && ok && e.status !== "no_key")
                return { ...e, status: "skipped" as const };
              return e;
            })
          );
          if (ok) break;
        }
        setProbeMode("done");
      })();
    })();
  }, [config, probeModel]);

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
    startInput,
    typeChar,
    backspace,
    submit,
    cancel,
    enterFromDone,
  };
}
