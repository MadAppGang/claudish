/**
 * prehydrate — resolve provider credentials in the PARENT before spawning
 * child `claudish` processes.
 *
 * WHY THIS EXISTS
 *
 * The 1Password SDK's DesktopAuth handshake is arbitrated by the desktop app
 * across the whole MACHINE, not per process: it authorizes ONE client and
 * instantly denies every concurrent peer with
 *
 *   "Denied authorization for SDK client"
 *
 * claudish already serializes SDK calls WITHIN a process (`runSdkExclusive` in
 * op-source.ts — the -4 IPC fix), but `team` and channel `create_session` spawn
 * N sibling PROCESSES, and no in-process queue can span those. Each child
 * constructs its own SDK client and they all race.
 *
 * Measured on a 7-model `team` run (session team-20260729-163623): all seven
 * children spawned within 6ms, five hit the denial, and only the models whose
 * key happened to be in the shell env survived. Reduced repro: 6 children in a
 * tight loop → 5 denied; the same 6 staggered 4s apart → 0 denied.
 *
 * The denial is swallowed by `onAuthFailure: "skip"` (correct — a bad op source
 * must never lock the user out), so the child dies with a bare
 * "X API Key is required", which reads as "claudish ignored my 1Password setup".
 *
 * THE FIX
 *
 * Do in the parent, ONCE, what each child would otherwise do N times in
 * parallel. `validateApiKeysForModels` runs every model through the credential
 * authority, and the authority write-throughs each resolved op:// key into
 * `process.env` (api-key-credential.ts). Spawned children inherit `process.env`,
 * so they find the key in step 1 of the resolution chain and never construct an
 * SDK client at all — exactly the state the surviving models were already in.
 *
 * The parent's own resolution is serialized by the existing op queue, and a
 * 1Password Environment is fetched once per process (single-flight), so this
 * costs ONE handshake regardless of how many models are being spawned.
 *
 * Pre-hydration is the cheap path, not the whole fix. It covers the keys
 * 1Password CAN supply, at every spawn site claudish owns. Two other gaps are
 * handled elsewhere:
 *
 *   · Keys 1Password does NOT hold still send each child to the SDK →
 *     `publishOpSkipList` below tells children not to bother.
 *   · Two INDEPENDENT claudish processes launched at the same instant by
 *     unrelated sessions cannot be reached by any parent/child protocol →
 *     `providers/onepassword-handshake-lock.ts` serializes the handshake
 *     across processes.
 *
 * WHY HYDRATION ALONE WAS NOT ENOUGH — the spawn PLAN
 *
 * Hydration resolves a CREDENTIAL. What it never resolved is the ROUTING
 * DECISION, and a bare model name is a chain, not a credential.
 * `validateApiKeysForModels` asks the authority about the ONE provider
 * `resolveModelProvider` picked and stops as soon as the answer is "available"
 * (`rescueRoutableResolutions` only runs on a "missing" verdict). The child,
 * handed that same bare name, re-walks the WHOLE chain and asks 1Password about
 * every candidate the parent short-circuited past — so it builds its own SDK
 * client after all. Measured: 17 channel children logged
 * "Denied authorization for SDK client" on runs where pre-hydration had already
 * succeeded (see baseline-evidence.md in this feature's session dir).
 *
 * So the parent now also RESOLVES THE ROUTE and returns a {@link SpawnPlan}
 * mapping each bare name to an explicit `prefix@model` spec. A child launched
 * with an explicit spec skips routing entirely, has exactly one provider, and
 * finds that provider's key in the inherited env at step 1 of the resolution
 * chain — `hasOpSources()` is never reached, so no SDK client is ever built.
 *
 * ORDERING IS LOAD-BEARING: phase A (hydrate) MUST complete before phase B
 * (route). `route()`'s credential filter reads the same env phase A writes;
 * run them the other way round and every candidate is a miss, so `route()`
 * itself re-enters the SDK for candidates hydration would have satisfied — the
 * same storm, relocated to the parent. That is the reason the pin lives in
 * here rather than at the two call sites.
 *
 * NOTHING SECRET GOES ON ARGV. The only thing added is a provider prefix; keys
 * still travel exclusively by inherited `process.env`. `team-orchestrator.ts`
 * persists the spawn command into `status.json`, and that string stays
 * secret-free under this design.
 */

import { loadConfig } from "../../profile-config.js";
import { PROVIDER_TO_PREFIX } from "../../providers/auto-route.js";
import { loadCustomEndpoints } from "../../providers/custom-endpoints-loader.js";
import { ensureCatalogReady } from "../../providers/model-catalog-resolver.js";
import { parseModelSpec } from "../../providers/model-parser.js";
import { getOpFailures } from "../../providers/onepassword.js";
import { validateApiKeysForModels } from "../../providers/provider-resolver.js";
import type { Route, RoutePlan } from "../../providers/routing-rules.js";
import { route } from "../../providers/routing-rules.js";
import { OP_UNAVAILABLE_ENV, getOpUnavailableVars } from "./op-source.js";

/** The routing oracle {@link prehydrateCredentialsForSpawn} consults (test seam). */
export type RouteOracle = (spec: string) => Promise<RoutePlan>;

/** Phase-A credential validator (test seam; production uses the real authority). */
export type CredentialValidator = typeof validateApiKeysForModels;

/** How long to wait for the OpenRouter catalog before pinning. Best-effort. */
const CATALOG_WARM_TIMEOUT_MS = 5000;

/**
 * The result of a pre-spawn resolve: which explicit spec to hand each child.
 */
export interface SpawnPlan {
  /**
   * The original `--model` value → the explicit `prefix@model` spec to spawn
   * with.
   *
   * ABSENT means "spawn with the original string" — it is NEVER an error
   * signal. Call sites degrade with `plan.pinned.get(m) ?? m`, which is exactly
   * today's behaviour, so every degradation case in the design doc (§4) is
   * handled by simply omitting the entry.
   */
  pinned: Map<string, string>;
}

export interface PrehydrateOptions {
  /**
   * Resolve routes and populate `plan.pinned` (default `true`).
   *
   * Pass `false` when the parent's routing view is not the child's — the only
   * current case is `create_session` with a `work_dir` outside the parent's
   * cwd, because `route()` reads project-local config relative to
   * `process.cwd()` and would decide with the wrong project's rules.
   * (`process.chdir()` is not an option: it is process-global and races
   * concurrent calls.) Phase A still runs.
   */
  pin?: boolean;
  /** Test seam — injectable router, mirroring `RouteOracle` in provider-resolver. */
  router?: RouteOracle;
  /** Test seam — proves phase A runs without replacing a shared Bun module. */
  validator?: CredentialValidator;
}

/**
 * Resolve credentials for `models` into `process.env` — and their routes into a
 * {@link SpawnPlan} — before spawning children.
 *
 * Cheap and safe to call unconditionally: with no 1Password source configured
 * the sync sniff (`hasOpSources`) short-circuits without importing the SDK, and
 * any provider whose key is already in env never reaches 1Password either.
 *
 * NEVER THROWS. Pre-hydration is an optimization of WHERE resolution happens,
 * not a gate on whether the spawn proceeds — a credential that cannot be
 * resolved here simply stays missing, and the child reports it exactly as
 * before. Failing the spawn on a pre-hydration error would turn a soft
 * "this one model has no key" into a hard "the whole team run died". The same
 * contract covers the plan: a model that cannot be routed is simply absent
 * from `plan.pinned` and spawns bare, exactly as it does today.
 */
export async function prehydrateCredentialsForSpawn(
  models: (string | undefined)[],
  opts?: PrehydrateOptions
): Promise<SpawnPlan> {
  const plan: SpawnPlan = { pinned: new Map() };
  const wanted = models.filter((m): m is string => !!m);
  if (wanted.length === 0) return plan;
  try {
    // Phase A — hydrate. Write-throughs land in process.env here, and phase B
    // depends on seeing them (see ORDERING IS LOAD-BEARING above).
    await (opts?.validator ?? validateApiKeysForModels)(wanted);

    // Phase B — route. Never throws; every failure omits an entry.
    if (opts?.pin !== false) {
      await pinRoutes(wanted, plan.pinned, opts?.router ?? route);
    }

    // Phase C — unchanged, and still LAST so it sees the fuller record that
    // phase B's whole-chain walk produces.
    publishOpSkipList();
  } catch {
    // Non-fatal by contract — see above.
  }
  return plan;
}

/**
 * Resolve an explicit spawn spec for each distinct model. Never throws.
 *
 * Deliberately SEQUENTIAL. The op queue (`runSdkExclusive`) serializes SDK work
 * anyway, and going one model at a time means the first model's resolution has
 * already write-throughed its keys into `process.env` before the second model's
 * chain is filtered — so shared candidates are answered from env instead of
 * being asked concurrently.
 */
async function pinRoutes(
  models: string[],
  into: Map<string, string>,
  router: RouteOracle
): Promise<void> {
  try {
    const routable = [...new Set(models)].filter(isRoutablyPinnable);
    if (routable.length === 0) return;

    await prepareParentRoutingContext();

    for (const model of routable) {
      const spec = await pinSpecFor(model, router);
      if (spec) into.set(model, spec);
    }
  } catch {
    // Belt-and-braces: `pinSpecFor` already swallows per-model failures, and a
    // pin that never happens just means a bare spawn. Contained HERE rather
    // than in the caller's catch so phase C (`publishOpSkipList`) keeps running
    // exactly as it did before pinning existed.
  }
}

/**
 * Would the CHILD route this name at all?
 *
 * This mirrors the child's own gate (`proxy-server.ts` step 2c) exactly. Pinning
 * a name the child would not have routed does not just waste a `route()` call —
 * it CHANGES the child's behaviour, which the pin must never do:
 *
 *   - **explicit spec** (`gc@glm-5`, `or@x/y`, `ollama@llama3.2:3`, a URL) —
 *     nothing to decide, the child already skips routing. Unconditional and
 *     first, and it is what protects concurrency suffixes: `parseModelSpec`
 *     STRIPS the `:3` off `ollama@llama3.2:3` (`model` comes back `"llama3.2"`),
 *     so a spec rebuilt from parsed parts would silently lose it. The early-out,
 *     NOT lossless round-tripping, is the guarantee.
 *   - **native-anthropic** (`opus`, `sonnet`, `claude-*`, and any unrecognised
 *     bare name with no `/`) — the child never routes these. `route()` would
 *     nonetheless answer `ok` for them, because `defaultProvider` is appended to
 *     EVERY bare-name chain, so an unguarded pin would spawn
 *     `--model or@opus` and send a native model through OpenRouter. `team`
 *     screens these out upstream in `setupSession`, but `create_session` does
 *     not.
 *   - **`poe:` models** — same gate, same reason (`isPoeModel` in
 *     proxy-server.ts is a local closure; the test is just the prefix).
 */
function isRoutablyPinnable(model: string): boolean {
  if (model.startsWith("poe:")) return false;
  const parsed = parseModelSpec(model);
  return !parsed.isExplicitProvider && parsed.provider !== "native-anthropic";
}

/**
 * Give the parent the same routing view the child would have.
 *
 * `loadCustomEndpoints` is normally called by `createProxyServer`, and the
 * parent starts no proxy for `team` / `create_session`. Without it a
 * custom-endpoint provider is unregistered here but registered in the child,
 * so the parent could pin a DIFFERENT provider than the child would pick.
 * Registration is sync, config-only and idempotent per name; the `once` guard
 * keeps it to a single config read per process.
 *
 * Warming the OpenRouter catalog mirrors what `proxy-server.ts` does before its
 * own `route()` call. Best-effort: on timeout the resolver falls back to the
 * on-disk cache, and an under-resolved OpenRouter id is re-resolved (and thus
 * repaired) by the child anyway.
 */
let parentRoutingContextReady = false;
async function prepareParentRoutingContext(): Promise<void> {
  if (!parentRoutingContextReady) {
    parentRoutingContextReady = true;
    try {
      loadCustomEndpoints(loadConfig());
    } catch {
      // Config read failure must not block the spawn — the parent just keeps
      // the builtin-only provider set, same as any other consumer of a broken
      // config. Validation errors are already surfaced by the proxy.
    }
  }
  try {
    await ensureCatalogReady("openrouter", CATALOG_WARM_TIMEOUT_MS);
  } catch {
    // ensureCatalogReady is documented not to throw; belt-and-braces.
  }
}

/**
 * The explicit `prefix@model` spec to spawn `model` with, or `null` when the
 * child should be handed the original string.
 *
 * `null` is returned for every degradation case, never an exception:
 *   - the child would not have routed this name ({@link isRoutablyPinnable}) —
 *     the router is not even called
 *   - `route()` found no credentialed provider (`kind: "no-route"`) — the child
 *     re-runs the same routing and produces the real error with its hint,
 *     which is a better message than the parent could guess at here
 *   - `route()` threw (catalog / disk / network hiccup)
 */
export async function pinSpecFor(
  model: string,
  router: RouteOracle = route
): Promise<string | null> {
  if (!isRoutablyPinnable(model)) return null;
  try {
    const plan = await router(model);
    if (plan.kind !== "ok") return null;
    return normalizePinnedSpec(plan.primary);
  } catch {
    return null;
  }
}

/**
 * Make a `Route` argv-safe.
 *
 * `buildRoutingChain` builds `modelSpec` two different ways: OpenRouter gets
 * the catalog-resolved id with NO prefix (`x-ai/grok-4.20`), everything else
 * gets a self-describing `prefix@model` (`gc@glm-5`). Inside the proxy that
 * asymmetry is harmless because the candidate's `provider` field picks the
 * handler. On argv the string must describe itself:
 *
 *   parseModelSpec("x-ai/grok-4.20") → provider "x-ai", isExplicitProvider FALSE
 *
 * i.e. handing that to `--model` produces a bare name again and the child
 * re-routes — the pin silently does nothing for every OpenRouter primary, which
 * is the most common primary in the default rules. Prefixing fixes it:
 * `or@x-ai/grok-4.20` parses as provider "openrouter", explicit.
 *
 * The `?? r.provider` branch covers runtime-registered custom endpoints, which
 * are absent from `PROVIDER_TO_PREFIX` (an IIFE over the builtin table) and
 * round-trip on their literal name (`my-vllm@model`).
 */
export function normalizePinnedSpec(r: Route): string | null {
  const spec = r.modelSpec?.trim();
  if (!spec) return null;
  // Already self-describing: a "provider@model" spec, or a custom URL (which
  // parseModelSpec treats as explicit on its own).
  if (spec.includes("@")) return spec;
  if (spec.startsWith("http://") || spec.startsWith("https://")) return spec;
  const prefix = PROVIDER_TO_PREFIX[r.provider] ?? r.provider;
  if (!prefix || prefix.includes("@")) return null;
  return `${prefix}@${spec}`;
}

/**
 * Tell children which env vars 1Password answered it does NOT hold, so they
 * skip the SDK for those entirely.
 *
 * Pre-hydration alone cannot silence the race. It hands children every key
 * 1Password CAN supply — but a bare model name filters a CHAIN, and each child
 * walks that chain from the top. The candidates 1Password has nothing for are
 * still a miss in env, so each child opens its own SDK client for them, all at
 * the same instant. Observed in ai-docs/sessions/opverify3: 3/3 models
 * succeeded on inherited keys, and two children still logged
 * "Denied authorization for SDK client" chasing a key that does not exist.
 *
 * ONLY published when the run recorded NO op failures. A denial also produces
 * an empty resolve, and publishing that would teach every child that a key the
 * user really does store in 1Password is permanently absent — turning one
 * transient denial into a run-wide outage. With failures present we publish
 * nothing and children behave exactly as before.
 */
function publishOpSkipList(): void {
  if (getOpFailures().length > 0) return;
  const unavailable = getOpUnavailableVars();
  if (unavailable.length === 0) return;
  process.env[OP_UNAVAILABLE_ENV] = unavailable.join(",");
}
