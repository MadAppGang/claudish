/** @jsxImportSource @opentui/react */
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  loadConfig,
  loadLocalConfig,
  disableLocalProvider,
  enableLocalProvider,
  isLocalProviderEnabled,
  removeApiKey,
  removeEndpoint,
  saveConfig,
  saveLocalConfig,
  setApiKey,
  setEndpoint,
} from "../profile-config.js";
import { DEFAULT_ROUTING_RULES } from "../providers/default-routing-rules.js";
import { getProviderByName } from "../providers/provider-definitions.js";
import {
  discoverProbeModelFromEndpoint,
  ensureProbeModelsCached,
  forceRefreshProbeModels,
  getProbeModel,
} from "../providers/probe-catalog.js";
import { invalidateProbeDiscovery } from "../providers/transport/probe-discovery.js";
import { describeProbeState } from "../providers/probe-live.js";
import { probeProviderRoute } from "../providers/probe-runner.js";
import {
  localBaseUrl,
  pingLocalProvider,
  pingLocalProviders,
  type LocalLiveness,
} from "../providers/local-liveness.js";
import { clearBuffer, getBufferStats } from "../stats-buffer.js";
import {
  ensureProbeProxy,
  invalidateProbeProxyHandlers,
  isProbeProxyReady,
} from "./probe-proxy.js";
import {
  PROVIDERS,
  maskKey,
  providerAuthCapabilities,
  providerIsReady,
  providerIsReadyForDisplay,
  type ProviderDef,
} from "./providers.js";
import { A, C } from "./theme.js";
import {
  CHAIN_PROVIDERS,
  HEADER_H,
  TABS_H,
  FOOTER_H,
  DETAIL_H,
} from "./constants.js";
// Real package version (auto-generated at build), not the stale hardcoded
// constant that used to live in constants.ts.
import { VERSION as PKG_VERSION } from "../version.js";
import type {
  MergedRule,
  Mode,
  OpEntry,
  OpKind,
  OpScope,
  OpTestResultsMap,
  RoutingScope,
  Tab,
  TestResultsMap,
} from "./types.js";
// 1Password CONFIG persistence (sync, no SDK). Reads/writes the global +
// project config files for the account / imports / environments fields.
import {
  readOnepasswordAccount,
  readOnepasswordAccountForScope,
  saveOnepasswordAccount,
  clearOnepasswordAccount,
  listOnepasswordImports,
  addOnepasswordImport,
  removeOnepasswordImport,
  listOnepasswordEnvironments,
  addOnepasswordEnvironment,
  removeOnepasswordEnvironment,
} from "../providers/onepassword-config.js";
// 1Password SDK engine (async; the WASM is dynamically imported INSIDE these
// functions only when auth + a secret are actually needed). Importing the
// module here is cheap — no SDK is touched at import time.
import {
  resolveSdkAuth,
  detectSdkAuth,
  resolveDesktopAccount,
  discoverItemFields,
  discoverItemFieldsById,
  withSdkRetry,
  filterGlobFields,
  parseGlobImport,
  isGlobImport,
  resolveSecrets,
  readEnvironment,
  listVaults,
  listItems,
  maskSecret,
  envNameFromOpRef,
  resolveGlobImport,
  isOpHydratedVar,
  type AccountInfo,
  type DiscoveredField,
} from "../providers/onepassword.js";
import { useRouteProbe } from "./hooks/useRouteProbe.js";
import { useProfileWizard } from "./hooks/useProfileWizard.js";
import { TabBar } from "./components/TabBar.js";
import { Footer } from "./components/Footer.js";
import { ProvidersContent } from "./components/ProvidersContent.js";
import { ProviderDetail } from "./components/ProviderDetail.js";
import { ProfilesContent } from "./components/ProfilesContent.js";
import { ProfileDetail } from "./components/ProfileDetail.js";
import { RoutingContent } from "./components/RoutingContent.js";
import { RoutingDetail } from "./components/RoutingDetail.js";
import { PrivacyContent } from "./components/PrivacyContent.js";
import { PrivacyDetail } from "./components/PrivacyDetail.js";
import { OnepasswordContent, type OpExpansion } from "./components/OnepasswordContent.js";
import { OnepasswordDetail } from "./components/OnepasswordDetail.js";
import {
  OnepasswordModal,
  isOpModalMode,
  buildFieldOptions,
  fuzzyMatch,
  fuzzyFilterByTitle,
} from "./components/OnepasswordModal.js";

interface AppProps {
  /**
   * Called from the Providers tab `l` handler. The wrapper in
   * tui/index.tsx records the requested slug, then after the renderer
   * is destroyed it spawns `claudish login {slug}` as a child process
   * and re-enters startConfigTui when the child exits. App.tsx just
   * signals intent; lifecycle is the wrapper's responsibility.
   */
  requestLogin?: (slug: "gemini" | "codex" | "kimi") => void;
}

export function App({ requestLogin }: AppProps = {}) {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();

  const [config, setConfig] = useState(() => loadConfig());
  const [bufStats, setBufStats] = useState(() => getBufferStats());
  const [providerIndex, setProviderIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<Tab>("providers");
  const [mode, setMode] = useState<Mode>("browse");
  const [inputValue, setInputValue] = useState("");
  const [routingPattern, setRoutingPattern] = useState("");
  const [chainSelected, setChainSelected] = useState<Set<string>>(new Set());
  const [chainOrder, setChainOrder] = useState<string[]>([]);
  const [chainCursor, setChainCursor] = useState(0);
  // Routing scope wizard state. `routingScope` carries the user's `g`/`p`
  // choice from `pick_routing_scope` into `add_routing_chain`'s save logic.
  // `routingScopeReturnsToEdit=true` when entering the chain builder via
  // `e` (edit existing rule), so the picker is skipped and the rule's own
  // scope is used (edit-in-place semantics, matching Profiles wizard).
  const [routingScope, setRoutingScope] = useState<RoutingScope>("global");
  // Cursor for the scope picker menu. 0 = global, 1 = project. Mirrors the
  // chain-selector navigation pattern (↑↓ + Enter) instead of g/p shortcuts.
  const [routingScopeCursor, setRoutingScopeCursor] = useState<0 | 1>(0);
  const [routingScopeReturnsToEdit, setRoutingScopeReturnsToEdit] = useState(false);
  // When `e` is pressed on an existing user/project rule, these track WHICH
  // rule we're editing. If the user picks a DIFFERENT scope in the picker,
  // the save path also deletes the old rule (effectively a move). For new
  // rules (a) and overrides of defaults (e on default), both are null.
  const [editingExistingScope, setEditingExistingScope] = useState<RoutingScope | null>(null);
  const [editingExistingPattern, setEditingExistingPattern] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<TestResultsMap>({});
  // Liveness of local servers (ollama/lmstudio/vllm/mlx), keyed by catalogName.
  // Populated by a periodic background ping so the Providers tab can show
  // "running" vs "down" — config-enabled is NOT the same as actually-running.
  const [localLiveness, setLocalLiveness] = useState<Record<string, LocalLiveness>>({});
  const [animTick, setAnimTick] = useState(0);
  const anyTesting = useMemo(
    () => Object.values(testResults).some((r) => r?.status === "testing"),
    [testResults]
  );

  useEffect(() => {
    if (!anyTesting) return;
    const id = setInterval(() => setAnimTick((tick) => (tick + 1) % 1_000_000), 90);
    return () => clearInterval(id);
  }, [anyTesting]);

  // Background liveness ping for local servers. Only runs while the Providers
  // tab is visible. Pings every local provider's health endpoint (short
  // timeout) on entry and every 10s, so the list reflects what's ACTUALLY
  // running — a started Ollama lights up even if not yet config-enabled, and an
  // enabled-but-stopped LM Studio shows "down" instead of a misleading green.
  useEffect(() => {
    if (activeTab !== "providers") return;
    let cancelled = false;
    const localNames = PROVIDERS.filter((p) => p.isLocal).map((p) => p.catalogName);
    if (localNames.length === 0) return;
    const sweep = async () => {
      const map = await pingLocalProviders(localNames);
      if (!cancelled) setLocalLiveness(map);
    };
    void sweep();
    const id = setInterval(() => void sweep(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activeTab]);

  // Profile tab state — only the cursor is owned by App. The rest of the
  // profile-edit wizard state lives in useProfileWizard.
  const [profileIndex, setProfileIndex] = useState(0);

  // ── 1Password tab state ─────────────────────────────────────────────────────
  // opIndex      — cursor into the merged entries list.
  // opScopeCursor/KindCursor/AccountCursor — <select> cursors for the pickers.
  // opAccounts   — accounts surfaced when resolveSdkAuth needs a picker.
  // opTestResults — per-entry test results, keyed `${scope}:${kind}:${value}`.
  // opPendingKind/Scope/Value — the in-flight add-wizard's selections, carried
  //   across the kind→input→scope steps until the add action runs.
  // opTick       — bumped after a write so the opEntries memo re-derives even
  //   though the foundation helpers read files directly (config object identity
  //   alone doesn't capture op:// fields, which we read via the scope helpers).
  // opBusy       — true while an async add-validate / test is running; gates the
  //   keyboard branch (Esc still works) so concurrent ops can't interleave.
  const [opIndex, setOpIndex] = useState(0);
  const [opScopeCursor, setOpScopeCursor] = useState<0 | 1>(0);
  const [opKindCursor, setOpKindCursor] = useState(0);
  const [opAccountCursor, setOpAccountCursor] = useState(0);
  const [opAccounts, setOpAccounts] = useState<AccountInfo[]>([]);
  const [opTestResults, setOpTestResults] = useState<OpTestResultsMap>({});
  const [opPendingKind, setOpPendingKind] = useState<OpKind>("ref");
  const [opPendingValue, setOpPendingValue] = useState("");
  // Scope chosen in step 1; carried through the wizard until the add action runs.
  const [opPendingScope, setOpPendingScope] = useState<OpScope>("global");
  const [opTick, setOpTick] = useState(0);
  const [opBusy, setOpBusy] = useState(false);
  // ── op:// browse-don't-type pickers (vault → item → field) ───────────────────
  // The lists are loaded async (listVaults / listItems / discoverItemFields) and
  // the cursors track each <select>. opPickedVault/opPickedItem hold the chosen
  // TITLES (used to build the literal op:// path and as breadcrumb context).
  // opEnvPreview holds the previewed Environment variable NAMES (null = no
  // preview yet) for the two-Enter env flow.
  const [opVaults, setOpVaults] = useState<{ id: string; title: string }[]>([]);
  const [opItems, setOpItems] = useState<{ id: string; title: string }[]>([]);
  const [opFields, setOpFields] = useState<DiscoveredField[]>([]);
  const [opVaultCursor, setOpVaultCursor] = useState(0);
  const [opItemCursor, setOpItemCursor] = useState(0);
  const [opFieldCursor, setOpFieldCursor] = useState(0);
  const [opPickedVault, setOpPickedVault] = useState<string | null>(null);
  const [opPickedVaultId, setOpPickedVaultId] = useState<string | null>(null);
  const [opPickedItem, setOpPickedItem] = useState<string | null>(null);
  // Cache of discovered fields per `${vaultId}:${itemId}` so re-entering an item
  // is INSTANT (no SDK round-trip). The SDK item-fetch is the slow part (desktop
  // IPC + decrypt), so caching is the biggest perceived-speed win.
  const opFieldsCache = useRef<Map<string, DiscoveredField[]>>(new Map());
  const [opEnvPreview, setOpEnvPreview] = useState<string[] | null>(null);
  // Inline fuzzy filter for the vault/item/field/account list pickers. The user
  // types to narrow a long list; ↑↓/Enter operate on the FILTERED set. Cleared
  // whenever a picker is (re)entered. One shared string — only one picker is
  // visible at a time.
  const [opFilter, setOpFilter] = useState("");
  // Per-set (glob) expansion cache: glob op:// value → its resolved key NAMES
  // (no values) / loading / error. Populated lazily by an effect so the main
  // list can show each set's keys as nested sub-rows. Keyed by the glob value so
  // it survives re-renders and isn't re-fetched.
  const [opExpansions, setOpExpansions] = useState<Record<string, OpExpansion>>({});
  // Deferred-promise resolver for the in-TUI account picker. resolveSdkAuth's
  // onNeedsPicker flips mode to pick_op_account, stashes accounts, and returns
  // a promise whose resolve is stored here; the pick_op_account key handler
  // calls it with the chosen url (or undefined on Esc).
  const opPickerResolver = useRef<((url: string | undefined) => void) | null>(null);

  const quit = useCallback(() => renderer.destroy(), [renderer]);

  // Sort: configured/ready providers first (env/cfg key, OAuth, public-key, or a
  // RUNNING local server), then unconfigured. Original order preserved within
  // each group. Liveness is included so a running-but-not-enabled local (e.g. a
  // freshly-started Ollama) sorts above the "not configured" divider, matching
  // its "running" status.
  const displayProviders = useMemo(() => {
    return [...PROVIDERS].sort((a, b) => {
      const aReady = providerIsReadyForDisplay(a, config, localLiveness);
      const bReady = providerIsReadyForDisplay(b, config, localLiveness);
      if (aReady === bReady) return PROVIDERS.indexOf(a) - PROVIDERS.indexOf(b);
      return aReady ? -1 : 1;
    });
  }, [config, localLiveness]);

  const selectedProvider = displayProviders[providerIndex]!;
  const selectedProviderDef = getProviderByName(selectedProvider.catalogName);
  const selectedProviderIsLocal = !!(selectedProvider.isLocal || selectedProviderDef?.isLocal);
  const selectedLocalEnabled =
    selectedProviderIsLocal && isLocalProviderEnabled(selectedProvider.catalogName, config);
  const refreshConfig = useCallback(() => {
    setConfig(loadConfig());
    setBufStats(getBufferStats());
    // Bump the 1Password derivation tick too: the op:// fields are read from
    // disk by the scope-aware helpers (not carried on the loadConfig object),
    // so the opEntries memo needs an explicit signal to re-run after a save.
    setOpTick((t) => t + 1);
  }, []);

  // Drop the cached test badge for one provider (keyed by TUI name, as
  // runProbeTest stores it). Call on any credential change — save/remove key or
  // URL, OAuth login — so a stale FAIL / "ready Xms" doesn't outlive the
  // credential that produced it.
  const clearTestResult = useCallback((provName: string) => {
    setTestResults((prev) => {
      if (!(provName in prev)) return prev;
      const next = { ...prev };
      delete next[provName];
      return next;
    });
  }, []);

  // Route probe wizard — owns probeMode/probeModel/probeResults internally.
  // The keyboard handler delegates to verb methods (startInput, submit, etc.).
  const probe = useRouteProbe(config);
  const { probeMode, probeModel, probeResults } = probe;

  // Profile editor wizard — owns editProfileName/Value, profileScope,
  // suggestions/suggestionIndex, providerPickerIndex, and the
  // (intentionally hook-internal) providerPickerReturnMode. The keyboard
  // handler dispatches verb methods; the hook flips parent `mode` for its
  // visible sub-states.
  const wizard = useProfileWizard({ mode, setMode, refreshConfig, setStatusMsg });
  const {
    editProfileValue,
    profileScope,
    suggestions,
    suggestionIndex,
    providerPickerIndex,
  } = wizard;

  const hasCfgKey = !!config.apiKeys?.[selectedProvider.apiKeyEnvVar];
  const hasEnvKey = !!process.env[selectedProvider.apiKeyEnvVar];
  // Keyless/free provider (publicKeyFallback, e.g. OpenCode Zen): usable with no
  // user key. Counts as "has key" so the detail pane shows it Ready, consistent
  // with providerIsReady / the Providers list (no more "ready" under
  // "not configured").
  const selectedPublicKey = !!selectedProvider.publicKeyFallback && !hasCfgKey && !hasEnvKey;
  const hasKey = hasCfgKey || hasEnvKey || selectedLocalEnabled || selectedPublicKey;
  // True when the env-var value was hydrated from 1Password at startup (not a
  // genuine shell env var) — so the detail pane shows "From: 1Password", not "env".
  const isOpKey = hasEnvKey && isOpHydratedVar(selectedProvider.apiKeyEnvVar);
  const cfgKeyMask = maskKey(config.apiKeys?.[selectedProvider.apiKeyEnvVar]);
  const envKeyMask = maskKey(process.env[selectedProvider.apiKeyEnvVar]);
  const activeEndpointEnvVar = selectedProvider.endpointEnvVar;
  const activeEndpointFromConfig = activeEndpointEnvVar
    ? config.endpoints?.[activeEndpointEnvVar]
    : undefined;
  const activeEndpointFromEnv = selectedProvider.endpointEnvVars
    ?.map((envVar) => process.env[envVar])
    .find((value): value is string => !!value);
  const activeEndpoint =
    activeEndpointFromConfig ||
    activeEndpointFromEnv ||
    selectedProvider.defaultEndpoint ||
    "";

  const telemetryEnabled =
    process.env.CLAUDISH_TELEMETRY !== "0" &&
    process.env.CLAUDISH_TELEMETRY !== "false" &&
    config.telemetry?.enabled === true;

  const statsDisabledByEnv =
    process.env.CLAUDISH_STATS === "0" || process.env.CLAUDISH_STATS === "false";
  const statsEnabled = !statsDisabledByEnv && config.stats?.enabled === true;

  // Merged routing rules: built-in defaults + global config + project-local
  // config rendered as a flat list with NO shadowing. If a pattern exists at
  // multiple layers (e.g. a global override AND a project rule for `gpt-*`),
  // BOTH rows are visible — the user can edit/delete each independently.
  //
  // The runtime routing engine (loadRoutingRules + matchRoutingRule) still
  // applies precedence (project beats global beats default), but the TUI
  // shows the data as it exists on disk, not the runtime resolution.
  //
  // Catch-all `*` is rendered separately above the table and excluded here.
  //
  // Sort order: defaults first (alphabetical), then global, then project.
  // `loadLocalConfig()` is called inside the memo so a `refreshConfig()`
  // after a project save triggers re-derivation.
  const mergedRules: MergedRule[] = useMemo(() => {
    const out: MergedRule[] = [];
    const localCfg = loadLocalConfig();

    for (const [pat, chain] of Object.entries(DEFAULT_ROUTING_RULES)) {
      if (pat === "*") continue;
      out.push({ kind: "default", pattern: pat, chain, overridesDefault: false });
    }
    for (const [pat, chain] of Object.entries(config.routing ?? {})) {
      if (pat === "*") continue;
      out.push({
        kind: "global",
        pattern: pat,
        chain,
        overridesDefault: pat in DEFAULT_ROUTING_RULES,
      });
    }
    if (localCfg?.routing) {
      for (const [pat, chain] of Object.entries(localCfg.routing)) {
        if (pat === "*") continue;
        out.push({
          kind: "project",
          pattern: pat,
          chain,
          overridesDefault: pat in DEFAULT_ROUTING_RULES,
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.routing, JSON.stringify(loadLocalConfig()?.routing ?? {})]);

  // Active routing profile, shown in the header as `profile: [name]`.
  const profileName = config.defaultProfile || "default";

  // ── 1Password derived state ─────────────────────────────────────────────────
  // Merged entries list, grouped by kind, project-then-global within each kind
  // so the most-specific scope reads first. The op:// fields are read straight
  // from disk via the scope-aware helpers, so the memo depends on `opTick`
  // (bumped by refreshConfig after every save) rather than the config object.
  const opEntries: OpEntry[] = useMemo(() => {
    const out: OpEntry[] = [];
    const scopes: OpScope[] = ["project", "global"];

    // Refs + globs (onepassword[]).
    for (const scope of scopes) {
      for (const v of listOnepasswordImports(scope)) {
        const kind: OpKind = isGlobImport(v) ? "glob" : "ref";
        out.push({
          kind,
          value: v,
          scope,
          envName: kind === "ref" ? envNameFromOpRef(v) ?? undefined : undefined,
        });
      }
    }
    // Environments (onepasswordEnvironments[]).
    for (const scope of scopes) {
      for (const id of listOnepasswordEnvironments(scope)) {
        out.push({ kind: "environment", value: id, scope });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opTick]);

  // Lazily resolve each SET (glob) entry's key NAMES (no values) so the main
  // list can show them as nested sub-rows. Best-effort + cached per glob value:
  // marks "loading" then resolves to "ready"/"error". Only runs on the
  // onepassword tab, and only for globs not already cached. Never blocks the UI.
  useEffect(() => {
    if (activeTab !== "onepassword") return;
    const globs = opEntries.filter((e) => e.kind === "glob");
    for (const g of globs) {
      if (opExpansions[g.value]) continue; // already loading/ready/error
      setOpExpansions((prev) => ({ ...prev, [g.value]: { status: "loading" } }));
      void (async () => {
        try {
          const auth = await acquireOpAuth();
          const parsed = parseGlobImport(g.value);
          // withSdkRetry: a transient desktop-IPC failure (errno -4) rebuilds the
          // client + retries once instead of surfacing a one-off error.
          const fields = await withSdkRetry(() =>
            discoverItemFields(parsed.vault, parsed.item, { auth }),
          );
          const keys = filterGlobFields(fields, parsed)
            .filter((m) => m.valid)
            .map((m) => ({ name: m.envName, tail: m.field.valueTail }));
          setOpExpansions((prev) => ({ ...prev, [g.value]: { status: "ready", keys } }));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          setOpExpansions((prev) => ({ ...prev, [g.value]: { status: "error", message } }));
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, opEntries]);

  // Account display by source. env/token first (read-only, can't be edited
  // here), then the two config scopes shown independently.
  const opAccountDisplay = useMemo(() => {
    const envAuth = detectSdkAuth();
    let env: string | undefined;
    if (envAuth) {
      env =
        envAuth.kind === "token"
          ? "OP_SERVICE_ACCOUNT_TOKEN"
          : envAuth.accountName;
    }
    return {
      global: readOnepasswordAccountForScope("global"),
      project: readOnepasswordAccountForScope("project"),
      env,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opTick]);

  // True when op auth is available from env/token OR a configured account.
  const opAuthConfigured = useMemo(
    () => !!detectSdkAuth() || !!readOnepasswordAccount(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [opTick],
  );

  // The selected op entry (clamped) for the Detail panel's browse view.
  const selectedOpEntry =
    opEntries.length > 0
      ? opEntries[Math.min(opIndex, opEntries.length - 1)]
      : undefined;

  // ── Fuzzy-filtered picker lists ──────────────────────────────────────────────
  // The vault/item/field/account list pickers narrow by `opFilter` as the user
  // types. The keyboard handler AND the modal both read these so ↑↓/Enter and the
  // rendered list agree. Cursors are clamped against the filtered length below.
  const opVaultsFiltered = useMemo(
    () => fuzzyFilterByTitle(opVaults, opFilter),
    [opVaults, opFilter]
  );
  const opItemsFiltered = useMemo(
    () => fuzzyFilterByTitle(opItems, opFilter),
    [opItems, opFilter]
  );
  const opAccountsFiltered = useMemo(
    () => (opFilter.trim() === "" ? opAccounts : opAccounts.filter((a) => fuzzyMatch(opFilter, `${a.url} ${a.email}`))),
    [opAccounts, opFilter]
  );
  // Field options are built (glob + section + concrete) then filtered by name.
  const opFieldOptionsAll = useMemo(
    () => buildFieldOptions(opPickedVault ?? "", opPickedItem ?? "", opFields),
    [opPickedVault, opPickedItem, opFields]
  );
  const opFieldOptionsFiltered = useMemo(
    () => (opFilter.trim() === "" ? opFieldOptionsAll : opFieldOptionsAll.filter((o) => fuzzyMatch(opFilter, o.name))),
    [opFieldOptionsAll, opFilter]
  );
  // Keep the field cursor on a SELECTABLE row: the grouped list has header rows
  // (selectable:false) the cursor must never rest on. Whenever the filtered list
  // changes (load or filter edit), snap the cursor to the nearest selectable row
  // at/after the current index, else the first selectable, else 0.
  useEffect(() => {
    if (mode !== "pick_op_field") return;
    const opts = opFieldOptionsFiltered;
    if (opts.length === 0) return;
    const cur = opts[opFieldCursor];
    if (cur?.selectable) return; // already valid
    let idx = opts.findIndex((o, i) => i >= opFieldCursor && o.selectable);
    if (idx < 0) idx = opts.findIndex((o) => o.selectable);
    setOpFieldCursor(idx < 0 ? 0 : idx);
  }, [opFieldOptionsFiltered, opFieldCursor, mode]);

  /**
   * Resolve SDK auth for a 1Password operation, surfacing the multi-account
   * picker IN the TUI when needed. Returns the resolved auth, or throws (the
   * caller catches and shows err.message). The picker hook flips mode to
   * pick_op_account, stashes the accounts, and awaits a deferred promise that
   * the pick_op_account key handler resolves with the chosen url.
   */
  const acquireOpAuth = useCallback(async () => {
    return resolveSdkAuth({
      interactive: true,
      configAccount: readOnepasswordAccount(),
      onNeedsPicker: (accounts) =>
        new Promise<string | undefined>((resolve) => {
          setOpAccounts(accounts);
          setOpAccountCursor(0);
          opPickerResolver.current = (url) => {
            // Persist the chosen account globally so the next run reuses it
            // without re-prompting (resolveSdkAuth itself doesn't write).
            if (url && url.trim()) saveOnepasswordAccount(url.trim(), "global");
            opPickerResolver.current = null;
            resolve(url);
          };
          setMode("pick_op_account");
        }),
    });
  }, []);

  /**
   * Test a single 1Password entry (read-only). Mirrors the add-validate flow
   * but never persists. Writes status/note/error into opTestResults keyed by
   * `${scope}:${kind}:${value}`.
   */
  const testOpEntry = useCallback(
    async (entry: OpEntry): Promise<void> => {
      const key = `${entry.scope}:${entry.kind}:${entry.value}`;
      setOpBusy(true);
      setOpTestResults((prev) => ({ ...prev, [key]: { status: "testing" } }));
      setStatusMsg("1Password: testing…");
      try {
        const auth = await acquireOpAuth();
        let note = "";
        if (entry.kind === "account") {
          // Auth resolution already proved the account works.
          note = "account ok";
        } else if (entry.kind === "environment") {
          const vars = await withSdkRetry(() => readEnvironment(entry.value, { auth }));
          note = `${Object.keys(vars).length} vars`;
        } else if (entry.kind === "glob" || isGlobImport(entry.value)) {
          const g = parseGlobImport(entry.value);
          const fields = await withSdkRetry(() => discoverItemFields(g.vault, g.item, { auth }));
          const matches = filterGlobFields(fields, g).filter((m) => m.valid);
          note = `${matches.length} fields`;
        } else {
          const r = await withSdkRetry(() => resolveSecrets({ T: entry.value }, { auth }));
          note = maskSecret(r.T);
        }
        setOpTestResults((prev) => ({
          ...prev,
          [key]: { status: "valid", note },
        }));
        setStatusMsg(`1Password test ok → ${note}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setOpTestResults((prev) => ({
          ...prev,
          [key]: { status: "failed", error: msg },
        }));
        setStatusMsg(msg);
      } finally {
        setOpBusy(false);
      }
    },
    [acquireOpAuth],
  );

  /**
   * Reset every add-wizard scratch field. Called whenever the wizard returns to
   * browse (commit, cancel, or error) so a later `a` starts clean.
   */
  const resetOpWizard = useCallback(() => {
    setInputValue("");
    setOpPendingValue("");
    setOpPendingKind("ref");
    setOpKindCursor(0);
    setOpScopeCursor(0);
    setOpVaults([]);
    setOpItems([]);
    setOpFields([]);
    setOpVaultCursor(0);
    setOpItemCursor(0);
    setOpFieldCursor(0);
    setOpPickedVault(null);
    setOpPickedVaultId(null);
    setOpPickedItem(null);
    setOpEnvPreview(null);
    setOpFilter("");
  }, [setInputValue]);

  /**
   * The ADD action. Runs after the user commits the final wizard step, with the
   * kind/value/scope known.
   *
   * PERSIST-FIRST: the value is written to config IMMEDIATELY (the refs/globs
   * the user picked from a real, SDK-discovered list are valid by construction —
   * a second SDK round-trip here would be a needless extra failure point that
   * could silently lose the save). A best-effort "test" then runs as a NON-FATAL
   * confirmation: success → a masked/count note; failure → a warning that the
   * entry was saved but the live check couldn't confirm it (the import still
   * persists; startup resolution will surface a genuinely-bad ref). The account
   * write needs no test (auth resolution already proved the account).
   */
  const runOpAdd = useCallback(
    async (kind: OpKind, value: string, scope: OpScope): Promise<void> => {
      setOpBusy(true);
      try {
        // 1) PERSIST FIRST (synchronous, can't fail on a flaky SDK).
        if (kind === "account") {
          saveOnepasswordAccount(value, scope);
        } else if (kind === "environment") {
          addOnepasswordEnvironment(value, scope);
        } else {
          addOnepasswordImport(value, scope);
        }
        refreshConfig();

        // 2) Reflect the save in the UI right away.
        const isGlob = kind === "glob" || isGlobImport(value);
        const kindWord =
          kind === "account" ? "account" : kind === "environment" ? "environment" : isGlob ? "glob" : "ref";
        setStatusMsg(`1Password ${kindWord} saved (${scope}). Confirming…`);
        setMode("browse");
        resetOpWizard();

        // 3) RESOLVE + HYDRATE process.env so the new keys take effect in THIS
        //    running session immediately — the Providers tab reads process.env,
        //    so without this the keys only appear after a restart. Gap-fill:
        //    never overwrite an env var that's already set (env wins, as at
        //    startup). Also a non-fatal confirmation — a flaky SDK can't undo the
        //    already-persisted entry. (account needs no resolve — auth already ran.)
        if (kind === "account") {
          setStatusMsg(`1Password account saved (${scope}).`);
          return;
        }
        try {
          const auth = await acquireOpAuth();
          let hydrated = 0;
          const apply = (vars: Record<string, string>): void => {
            for (const [name, val] of Object.entries(vars)) {
              if (!process.env[name]) {
                process.env[name] = val;
                hydrated++;
              }
            }
          };
          if (kind === "environment") {
            const vars = await withSdkRetry(() => readEnvironment(value, { auth }));
            apply(vars);
            setStatusMsg(
              `1Password environment saved (${scope}) → ${Object.keys(vars).length} vars, ${hydrated} applied.`,
            );
          } else if (isGlob) {
            // resolveGlobImport returns the {envVar: value} map directly — use it
            // to BOTH confirm and hydrate (one resolution, not a separate test).
            const resolved = await withSdkRetry(() => resolveGlobImport(value, { auth }));
            apply(resolved);
            const names = Object.keys(resolved).slice(0, 3).join(", ");
            const n = Object.keys(resolved).length;
            setStatusMsg(
              n > 0
                ? `1Password set saved (${scope}) → ${n} key${n === 1 ? "" : "s"} applied (${names})`
                : `1Password set saved (${scope}) — but it matched no importable fields right now.`,
            );
          } else {
            const r = await withSdkRetry(() => resolveSecrets({ T: value }, { auth }));
            const name = envNameFromOpRef(value);
            if (name) apply({ [name]: r.T });
            setStatusMsg(
              `1Password key saved (${scope}) → ${name ?? "?"} = ${maskSecret(r.T)}${hydrated ? " (applied)" : ""}`,
            );
          }
          // Drop ALL cached probe handlers so the next probe rebuilds transports
          // from the newly-hydrated env, then refresh config-derived state so the
          // Providers tab re-evaluates readiness immediately.
          invalidateProbeProxyHandlers();
          refreshConfig();
        } catch (testErr: unknown) {
          // The entry IS saved; the live resolve just couldn't run. Surface a
          // warning (and log the detail to stderr) without rolling back.
          const msg = testErr instanceof Error ? testErr.message : String(testErr);
          console.error(`[claudish] 1Password add: saved but live resolve failed: ${msg}`);
          setStatusMsg(`1Password ${kindWord} saved (${scope}) — live resolve failed: ${msg}`);
        }
      } catch (err: unknown) {
        // A genuine PERSIST failure (config write) — the rare real error.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[claudish] 1Password add failed to persist: ${msg}`);
        setStatusMsg(`1Password add failed: ${msg}`);
        setMode("browse");
        resetOpWizard();
      } finally {
        setOpBusy(false);
      }
    },
    [acquireOpAuth, refreshConfig, resetOpWizard, setMode],
  );

  /**
   * Load the vault list and open the vault picker. Kicked off when the user
   * commits the "API key from an item" kind. Sets opBusy during the load so the
   * modal shows "Loading…" while the (empty) list fills.
   */
  const loadOpVaults = useCallback(async (): Promise<void> => {
    setOpBusy(true);
    setOpVaults([]);
    setOpVaultCursor(0);
    setOpFilter("");
    setStatusMsg("1Password: loading vaults…");
    setMode("pick_op_vault");
    try {
      const auth = await acquireOpAuth();
      const vaults = await withSdkRetry(() => listVaults({ auth }));
      setOpVaults(vaults);
      setStatusMsg(`1Password: ${vaults.length} vault${vaults.length === 1 ? "" : "s"}.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMsg(msg);
      setMode("browse");
    } finally {
      setOpBusy(false);
    }
  }, [acquireOpAuth]);

  /**
   * Load the items of the chosen vault and open the item picker. Called when the
   * user commits a vault in pick_op_vault.
   */
  const loadOpItems = useCallback(
    async (vaultId: string, vaultTitle: string): Promise<void> => {
      setOpBusy(true);
      setOpItems([]);
      setOpItemCursor(0);
      setOpFilter("");
      setOpPickedVault(vaultTitle);
      setOpPickedVaultId(vaultId);
      setStatusMsg("1Password: loading items…");
      setMode("pick_op_item");
      try {
        const auth = await acquireOpAuth();
        const items = await withSdkRetry(() => listItems(vaultId, { auth }));
        setOpItems(items);
        setStatusMsg(`1Password: ${items.length} item${items.length === 1 ? "" : "s"}.`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatusMsg(msg);
        setMode("browse");
      } finally {
        setOpBusy(false);
      }
    },
    [acquireOpAuth],
  );

  /**
   * Load the fields of the chosen item and open the field picker. Uses the IDs
   * the pickers already have (`discoverItemFieldsById` → ONE SDK call, not three)
   * and a per-item cache so re-entering is instant. Falls back gracefully if a
   * cache hit is available (no spinner at all).
   */
  const loadOpFields = useCallback(
    async (
      vaultId: string,
      vaultTitle: string,
      itemId: string,
      itemTitle: string,
    ): Promise<void> => {
      setOpPickedItem(itemTitle);
      setOpFieldCursor(0);
      setOpFilter("");
      setMode("pick_op_field");

      // Cache hit → instant, no SDK call, no spinner.
      const cacheKey = `${vaultId}:${itemId}`;
      const cached = opFieldsCache.current.get(cacheKey);
      if (cached) {
        setOpFields(cached);
        setStatusMsg(`1Password: ${cached.length} field${cached.length === 1 ? "" : "s"} (cached).`);
        return;
      }

      setOpBusy(true);
      setOpFields([]);
      setStatusMsg(`1Password: loading fields for '${itemTitle}'…`);
      try {
        const auth = await acquireOpAuth();
        const fields = await withSdkRetry(() =>
          discoverItemFieldsById(vaultId, itemId, vaultTitle, itemTitle, { auth }),
        );
        opFieldsCache.current.set(cacheKey, fields);
        setOpFields(fields);
        setStatusMsg(`1Password: ${fields.length} field${fields.length === 1 ? "" : "s"}.`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatusMsg(msg);
        setMode("browse");
      } finally {
        setOpBusy(false);
      }
    },
    [acquireOpAuth],
  );

  /**
   * Preview a 1Password Environment's variable NAMES (no values) — the first
   * Enter of the two-Enter env flow. Reads the Environment by ID and stashes the
   * key names in opEnvPreview; the modal renders them. A second Enter (handled in
   * the keyboard branch) persists via runOpAdd.
   */
  const previewOpEnvironment = useCallback(
    async (id: string): Promise<void> => {
      setOpBusy(true);
      setStatusMsg("1Password: reading environment…");
      try {
        const auth = await acquireOpAuth();
        const vars = await withSdkRetry(() => readEnvironment(id, { auth }));
        const names = Object.keys(vars);
        setOpEnvPreview(names);
        setStatusMsg(
          `1Password environment → ${names.length} var${names.length === 1 ? "" : "s"}. Enter to save.`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setOpEnvPreview(null);
        setStatusMsg(msg);
      } finally {
        setOpBusy(false);
      }
    },
    [acquireOpAuth],
  );

  /**
   * Run a single provider's connectivity test via the shared probe proxy.
   *
   * Flips testResults[prov.name] to "testing", lazily ensures the proxy is
   * running, then sends a 1-token probe through the same stack
   * `claudish --probe` uses. The proxy resolves credentials uniformly across
   * env / config / OAuth — so this is a true "will it work?" answer for any
   * auth method.
   *
   * Returns silently after writing the final TestResult, so callers can fire
   * a batch of these in parallel without awaiting.
   */
  const runProbeTest = useCallback(async (prov: ProviderDef): Promise<void> => {
    const provName = prov.name;

    setTestResults((prev) => ({ ...prev, [provName]: { status: "testing" } }));

    // Local providers: ping the server first (short timeout). If it's not
    // running, fast-fail with a clear "not running" message instead of letting
    // endpoint discovery + probe eat the full 15s timeout (the LM-Studio
    // "operation timed out" footgun).
    if (prov.isLocal) {
      const live = await pingLocalProvider(prov.catalogName);
      if (live === "down") {
        const base = localBaseUrl(prov.catalogName);
        setTestResults((prev) => ({
          ...prev,
          [provName]: {
            status: "failed",
            error: `not running${base ? ` (${base} unreachable)` : ""}`,
          },
        }));
        return;
      }
    }

    const outcome = await ensureProbeModelsCached();
    if (outcome.kind !== "ok") {
      setTestResults((prev) => ({
        ...prev,
        [provName]: {
          status: "failed",
          error: `could not reach model catalog (${outcome.kind})`,
        },
      }));
      return;
    }

    const startMs = Date.now();
    try {
      const proxyUrl = await ensureProbeProxy();
      const catalogModel = getProbeModel(prov.catalogName);
      // Models that already failed this round — passed to discovery so we
      // get the NEXT candidate, not the same one again.
      const tried = new Set<string>();
      const MAX_ATTEMPTS = 3;
      let lastResult: import("../providers/probe-live.js").ProbeResult | null = null;
      let lastDiscoveryReason: string | undefined;
      // Self-heal: the cloud catalog's pick is what the (possibly stale) cache
      // returned. If it 404s, the catalog may have been corrected server-side
      // while our cache is still "fresh" by its generatedAt clock — force ONE
      // TTL-bypassing re-fetch and try the fresh pick before falling to
      // endpoint discovery. Guarded so we refresh at most once per probe.
      let catalogPick: string | null = catalogModel;
      let catalogRefreshed = false;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        let testModel: string | null = null;
        // The cloud catalog's pick wins while it has an untried candidate (the
        // initial pick, or a fresh one after a forced refresh). Otherwise walk
        // the endpoint's own list via discovery.
        if (catalogPick && !tried.has(catalogPick)) {
          testModel = catalogPick;
        } else {
          const discovery = await discoverProbeModelFromEndpoint(
            proxyUrl,
            prov.catalogName,
            tried
          );
          testModel = discovery.model;
          lastDiscoveryReason = discovery.reason;
        }
        if (!testModel) break;

        tried.add(testModel);
        const result = await probeProviderRoute(
          proxyUrl,
          {
            provider: prov.catalogName,
            modelSpec: testModel,
            // Let the shared probe path and proxy resolve credentials (env,
            // cfg, OAuth). The live request is the source of truth.
            hasCredentials: true,
          },
          15000
        );
        lastResult = result;

        if (result.state === "live" || result.state === "rate-limited") break;

        // On a model-not-found for the CATALOG pick, force-refresh the catalog
        // once and adopt a fresh, untried pick for the next attempt (self-heal
        // after a server-side fix). If the refresh yields nothing new, the loop
        // falls through to endpoint discovery as before.
        if (
          result.state === "model-not-found" &&
          testModel === catalogPick &&
          !catalogRefreshed
        ) {
          catalogRefreshed = true;
          const refresh = await forceRefreshProbeModels();
          if (refresh.kind === "ok") {
            const fresh = getProbeModel(prov.catalogName);
            catalogPick = fresh && !tried.has(fresh) ? fresh : null;
          } else {
            catalogPick = null;
          }
          continue;
        }

        // Retry on per-model failures (the next candidate might work).
        // Don't retry on transport-level failures (auth/network/timeout) —
        // those won't get better by changing model.
        const retryable =
          result.state === "model-not-found" || result.state === "error";
        if (!retryable) break;
      }

      const ms = Date.now() - startMs;
      if (!lastResult) {
        // Discovery never produced even one model.
        setTestResults((prev) => ({
          ...prev,
          [provName]: {
            status: "failed",
            error: lastDiscoveryReason
              ? `no probe model: ${lastDiscoveryReason}`
              : "no probe model available",
            ms,
          },
        }));
        return;
      }
      const result = lastResult;
      if (result.state === "live") {
        setTestResults((prev) => ({ ...prev, [provName]: { status: "valid", ms } }));
      } else if (result.state === "rate-limited") {
        // 429 proves auth+endpoint+model are all reachable — the only thing
        // wrong is the user's current request rate. Treat as healthy, just
        // annotate so the user knows why latency is high right now.
        setTestResults((prev) => ({
          ...prev,
          [provName]: { status: "valid", ms, note: "throttled" },
        }));
      } else {
        const baseError = describeProbeState(result);
        const error =
          tried.size > 1
            ? `${baseError} (tried ${tried.size} models)`
            : baseError;
        setTestResults((prev) => ({
          ...prev,
          [provName]: { status: "failed", error, ms },
        }));
      }
    } catch (err: unknown) {
      const ms = Date.now() - startMs;
      const msg = err instanceof Error ? err.message : String(err);
      setTestResults((prev) => ({
        ...prev,
        [provName]: { status: "failed", error: `proxy: ${msg}`, ms },
      }));
    }
  }, []);

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") return quit();

    // Probe input mode — handled independently of main mode (non-blocking).
    // Delegates to useRouteProbe verb methods. Note: probe.submit() kicks off
    // an async test loop that does NOT abort on cancel — see the hook comment.
    if (probeMode === "input") {
      if (key.name === "return" || key.name === "enter") {
        probe.submit();
      } else if (key.name === "escape") {
        probe.cancel();
      } else if (key.name === "backspace" || key.name === "delete") {
        probe.backspace();
      } else if (key.raw && key.raw.length === 1 && !key.ctrl && !key.meta) {
        probe.typeChar(key.raw);
      }
      return;
    }

    // Probe running/done — handle keys before normal routing handlers
    if (probeMode === "running" && activeTab === "routing") {
      if (key.name === "escape") {
        probe.cancel();
      }
      // Block all other keys while running
      return;
    }

    if (probeMode === "done" && activeTab === "routing") {
      if (key.name === "q") {
        return quit();
      } else if (key.name === "escape" || key.name === "p") {
        // Return to normal routing view
        probe.cancel();
      } else if (key.name === "return" || key.name === "enter") {
        // Start a new probe
        probe.enterFromDone();
      }
      return;
    }

    // Input modes
    if (mode === "input_key" || mode === "input_endpoint") {
      if (key.name === "return" || key.name === "enter") {
        const val = inputValue.trim();
        if (!val) {
          setStatusMsg("Aborted (empty).");
          setMode("browse");
          return;
        }
        if (mode === "input_key") {
          if (!selectedProvider.apiKeyEnvVar) {
            setStatusMsg(
              `${selectedProvider.displayName} has no apiKeyEnvVar — cannot save key.`
            );
          } else {
            setApiKey(selectedProvider.apiKeyEnvVar, val);
            process.env[selectedProvider.apiKeyEnvVar] = val;
            setStatusMsg(
              `Key saved for ${selectedProvider.displayName} (${selectedProvider.apiKeyEnvVar}).`
            );
          }
        } else {
          if (!selectedProvider.endpointEnvVar) {
            setStatusMsg(
              `${selectedProvider.displayName} has no endpointEnvVar — cannot save URL.`
            );
          } else {
            setEndpoint(selectedProvider.endpointEnvVar, val);
            process.env[selectedProvider.endpointEnvVar] = val;
            setStatusMsg(
              `URL saved for ${selectedProvider.displayName} (${selectedProvider.endpointEnvVar}=${val}).`
            );
          }
        }
        // Drop stale caches so the next probe picks up the new URL/key.
        // Without this the probe-proxy keeps using a pre-built transport
        // pointing at the old endpoint, and discovery returns the cached
        // model lookup keyed by the old URL.
        invalidateProbeProxyHandlers(selectedProvider.catalogName);
        invalidateProbeDiscovery(selectedProvider.catalogName);
        // Clear the stale test badge: a previous FAIL/valid result reflects the
        // OLD credential, not the one just saved. Leaving it would show a red
        // FAIL even after the user pastes a working key (testResults is separate
        // state that refreshConfig doesn't touch).
        clearTestResult(selectedProvider.name);
        refreshConfig();
        setInputValue("");
        setMode("browse");
      } else if (key.name === "escape") {
        setInputValue("");
        setMode("browse");
      }
      return;
    }

    if (mode === "add_routing_pattern") {
      if (key.name === "return" || key.name === "enter") {
        if (routingPattern.trim()) {
          setChainSelected(new Set());
          setChainCursor(0);
          setChainOrder([]);
          // For NEW rules (a from browse) advance to scope picker. For
          // overrides invoked from `e` on a default, the picker is also
          // needed (the user is creating a fresh user rule). The flag
          // routingScopeReturnsToEdit=true is set ONLY on `e` of an
          // existing user rule (global or project) — those already know
          // their scope and skip the picker entirely.
          if (routingScopeReturnsToEdit) {
            setMode("add_routing_chain");
          } else {
            setRoutingScopeCursor(0);
            setMode("pick_routing_scope");
          }
        }
      } else if (key.name === "escape") {
        setRoutingPattern("");
        setMode("browse");
      } else if (key.name === "backspace" || key.name === "delete") {
        setRoutingPattern((p) => p.slice(0, -1));
      } else if (key.raw && key.raw.length === 1 && !key.ctrl && !key.meta) {
        setRoutingPattern((p) => p + key.raw);
      }
      return;
    }

    // Routing scope picker — menu-style navigation (↑↓ + Enter), matching the
    // chain selector and Providers tab. Letter shortcuts (g/p) still work as
    // silent accelerators for users who learned the prior version, but the
    // primary interaction is the menu and the footer advertises that.
    if (mode === "pick_routing_scope") {
      if (key.name === "up" || key.name === "k") {
        setRoutingScopeCursor((i) => (i === 0 ? 0 : 0));
      } else if (key.name === "down" || key.name === "j") {
        setRoutingScopeCursor((i) => (i === 0 ? 1 : 1));
      } else if (key.name === "return" || key.name === "enter") {
        setRoutingScope(routingScopeCursor === 0 ? "global" : "project");
        setMode("add_routing_chain");
      } else if (key.raw === "g" || key.raw === "G") {
        // Silent accelerator — picks AND commits in one keystroke.
        setRoutingScope("global");
        setMode("add_routing_chain");
      } else if (key.raw === "p" || key.raw === "P") {
        setRoutingScope("project");
        setMode("add_routing_chain");
      } else if (key.name === "escape") {
        setRoutingPattern("");
        setChainSelected(new Set());
        setChainOrder([]);
        setRoutingScopeCursor(0);
        setRoutingScopeReturnsToEdit(false);
        setEditingExistingScope(null);
        setEditingExistingPattern(null);
        setMode("browse");
      }
      return;
    }

    if (mode === "add_routing_chain") {
      if (key.name === "up" || key.name === "k") {
        setChainCursor((i) => Math.max(0, i - 1));
      } else if (key.name === "down" || key.name === "j") {
        setChainCursor((i) => Math.min(CHAIN_PROVIDERS.length - 1, i + 1));
      } else if (key.name === "space" || key.raw === " ") {
        // Toggle: add to end or remove
        const prov = CHAIN_PROVIDERS[chainCursor];
        if (prov.isLocal && !providerIsReady(prov, config)) {
          setStatusMsg(`${prov.displayName} is disabled. Enable it in Providers first.`);
          return;
        }
        const provName = prov.name;
        setChainSelected((prev) => {
          const next = new Set(prev);
          if (next.has(provName)) {
            next.delete(provName);
            setChainOrder((o) => o.filter((p) => p !== provName));
          } else {
            next.add(provName);
            setChainOrder((o) => [...o, provName]);
          }
          return next;
        });
      } else if (key.raw && key.raw >= "1" && key.raw <= "9") {
        // Number key: move current provider to that position in chain
        const prov = CHAIN_PROVIDERS[chainCursor];
        if (prov.isLocal && !providerIsReady(prov, config)) {
          setStatusMsg(`${prov.displayName} is disabled. Enable it in Providers first.`);
          return;
        }
        const provName = prov.name;
        const targetPos = parseInt(key.raw, 10) - 1; // 0-indexed
        setChainSelected((prev) => {
          const next = new Set(prev);
          next.add(provName);
          return next;
        });
        setChainOrder((prev) => {
          const without = prev.filter((p) => p !== provName);
          const insertAt = Math.min(targetPos, without.length);
          without.splice(insertAt, 0, provName);
          return without;
        });
      } else if (key.name === "return" || key.name === "enter") {
        const pat = routingPattern.trim();
        if (pat && chainOrder.length) {
          // Move detection: if `e` was used on an existing rule AND the user
          // picked a different scope in the picker, write to the new scope
          // and delete from the old one. Otherwise this is a plain update
          // or a fresh add — just write.
          const isMove =
            editingExistingScope !== null &&
            editingExistingScope !== routingScope &&
            editingExistingPattern === pat;

          if (routingScope === "project") {
            const local = loadLocalConfig() ?? {
              version: "1.0.0",
              defaultProfile: "",
              profiles: {},
            };
            if (!local.routing) local.routing = {};
            local.routing[pat] = chainOrder;
            saveLocalConfig(local);
          } else {
            const cfg = loadConfig();
            if (!cfg.routing) cfg.routing = {};
            cfg.routing[pat] = chainOrder;
            saveConfig(cfg);
          }
          if (isMove && editingExistingScope === "global") {
            const cfg = loadConfig();
            if (cfg.routing && cfg.routing[pat] !== undefined) {
              delete cfg.routing[pat];
              saveConfig(cfg);
            }
            setStatusMsg(`Rule moved global → project: ${pat}`);
          } else if (isMove && editingExistingScope === "project") {
            const local = loadLocalConfig();
            if (local?.routing && local.routing[pat] !== undefined) {
              delete local.routing[pat];
              saveLocalConfig(local);
            }
            setStatusMsg(`Rule moved project → global: ${pat}`);
          } else if (routingScope === "project") {
            setStatusMsg(`Project rule saved: ${pat} → ${chainOrder.join(", ")}`);
          } else {
            setStatusMsg(`Global rule saved: ${pat} → ${chainOrder.join(", ")}`);
          }
          refreshConfig();
        }
        setRoutingPattern("");
        setChainSelected(new Set());
        setChainOrder([]);
        setChainCursor(0);
        // Reset scope state for the next add cycle.
        setRoutingScope("global");
        setRoutingScopeReturnsToEdit(false);
        setEditingExistingScope(null);
        setEditingExistingPattern(null);
        setMode("browse");
      } else if (key.name === "escape") {
        setChainSelected(new Set());
        setChainOrder([]);
        setChainCursor(0);
        // If we entered the chain builder via `e` on an existing rule, the
        // pattern is fixed — go straight to browse. For fresh adds, fall
        // back to pattern input so the user can fix the pattern.
        if (routingScopeReturnsToEdit) {
          setRoutingPattern("");
          setRoutingScope("global");
          setRoutingScopeReturnsToEdit(false);
          setEditingExistingScope(null);
          setEditingExistingPattern(null);
          setMode("browse");
        } else {
          setMode("add_routing_pattern");
        }
      }
      return;
    }

    // Profile wizard: scope picker. The bordered modal's <select> owns
    // up/down navigation (focused, fires onChange → wizard.setScopeCursor).
    // The global handler owns only Enter (commit the highlighted row) and
    // Esc — divide responsibilities so neither double-acts on a key. This is
    // the same coexistence model as the Providers tab <input>.
    if (mode === "pick_profile_scope") {
      if (key.name === "return" || key.name === "enter") {
        wizard.pickScopeAtCursor();
      } else if (key.name === "escape") {
        wizard.cancelPickScope();
      }
      return;
    }

    // Profile wizard: new profile name input
    if (mode === "new_profile") {
      if (key.name === "return" || key.name === "enter") {
        wizard.newProfileSubmit();
      } else if (key.name === "escape") {
        wizard.newProfileEscape();
      } else if (key.name === "backspace" || key.name === "delete") {
        wizard.newProfileBackspace();
      } else if (key.raw && key.raw.length === 1 && !key.ctrl && !key.meta) {
        wizard.newProfileTypeChar(key.raw);
      }
      return;
    }

    // Profile wizard: provider prefix picker (side-trip from edit fields).
    // The bordered modal's <select> owns up/down navigation (focused, fires
    // onChange → wizard.setProviderPickerIndex). The global handler owns only
    // Enter (commit highlighted prefix) and Esc (back). The manual
    // prefixPickerUp/Down nav is dead now that the native <select> drives the
    // cursor — see useProfileWizard.
    if (mode === "pick_provider_prefix") {
      if (key.name === "return" || key.name === "enter") {
        wizard.prefixPickerSubmit();
      } else if (key.name === "escape") {
        wizard.prefixPickerCancel();
      }
      return;
    }

    // Profile wizard: edit model role fields (opus → sonnet → haiku → subagent)
    if (
      mode === "edit_profile_opus" ||
      mode === "edit_profile_sonnet" ||
      mode === "edit_profile_haiku" ||
      mode === "edit_profile_subagent"
    ) {
      if (key.name === "return" || key.name === "enter") {
        wizard.editFieldSubmit();
      } else if (key.name === "tab") {
        wizard.editFieldTab();
      } else if (key.name === "up" || key.name === "k") {
        wizard.editFieldUp();
      } else if (key.name === "down" || key.name === "j") {
        wizard.editFieldDown();
      } else if (key.name === "escape") {
        wizard.editFieldEscape();
      } else if (key.name === "backspace" || key.name === "delete") {
        wizard.editFieldBackspace();
      } else if (key.raw && key.raw.length === 1 && !key.ctrl && !key.meta) {
        wizard.editFieldTypeChar(key.raw);
      }
      return;
    }

    // ── 1Password account input (the `o` shortcut: set the DesktopAuth URL) ────
    // Separate from the add-wizard. The <input> owns character entry; we own
    // Enter (stash the typed value + advance to scope) and Esc. opPendingKind is
    // "account" here (set by the `o` handler).
    if (mode === "input_op_account") {
      if (key.name === "return" || key.name === "enter") {
        const val = inputValue.trim();
        if (!val) {
          setStatusMsg("Aborted (empty).");
          setMode("browse");
          resetOpWizard();
          return;
        }
        // Stash the typed account and ask for scope; runOpAdd persists.
        setOpPendingValue(val);
        setOpScopeCursor(0);
        setMode("pick_op_scope");
      } else if (key.name === "escape") {
        setMode("browse");
        resetOpWizard();
      }
      return;
    }

    // ── 1Password Environment input (two-Enter NAME preview) ───────────────────
    // SDK can't enumerate Environments, so the ID is typed. First Enter previews
    // the variable NAMES (no values); second Enter persists via runOpAdd. The
    // <input> owns character entry; if the user edits the ID after a preview, the
    // preview is invalidated so the next Enter re-previews.
    if (mode === "input_op_env") {
      if (key.name === "return" || key.name === "enter") {
        const val = inputValue.trim();
        if (!val) {
          setStatusMsg("Aborted (empty).");
          setMode("browse");
          resetOpWizard();
          return;
        }
        if (opEnvPreview === null) {
          // Enter #1 → fetch + show variable names.
          void previewOpEnvironment(val);
        } else {
          // Enter #2 → persist at the scope chosen in step 1.
          setOpPendingValue(val);
          void runOpAdd("environment", val, opPendingScope);
        }
      } else if (key.name === "escape") {
        setMode("browse");
        resetOpWizard();
      } else if (
        opEnvPreview !== null &&
        (key.name === "backspace" ||
          key.name === "delete" ||
          (key.raw && key.raw.length === 1 && !key.ctrl && !key.meta))
      ) {
        // The ID is being edited after a preview — drop the stale preview so the
        // next Enter re-fetches. (The <input> still applies the edit itself.)
        setOpEnvPreview(null);
      }
      return;
    }

    // ── 1Password scope picker (STEP 1 — global / project) ─────────────────────
    // The scope is now the FIRST step. Enter commits the scope and advances to
    // the account step (or auto-skips it) → then the kind picker.
    if (mode === "pick_op_scope") {
      if (key.name === "return" || key.name === "enter") {
        const scope: OpScope = opScopeCursor === 0 ? "global" : "project";
        // The `o` account shortcut reuses pick_op_scope as its FINAL step, so if
        // a value is already pending (kind=account), persist directly.
        if (opPendingKind === "account" && opPendingValue) {
          void runOpAdd("account", opPendingValue, scope);
          return;
        }
        setOpPendingScope(scope);
        // Step 2: show the account picker ONLY when there's genuine ambiguity
        // (not env/token-authed AND multiple accounts). Otherwise auto-skip to
        // the kind picker; auth (and any error) is resolved later in runOpAdd.
        let needsAccountStep = false;
        if (!detectSdkAuth()) {
          const res = resolveDesktopAccount({ interactive: true });
          if ("needsPicker" in res) {
            setOpAccounts(res.needsPicker);
            setOpAccountCursor(0);
            needsAccountStep = true;
          }
        }
        if (needsAccountStep) {
          setMode("pick_op_account");
        } else {
          setOpKindCursor(0);
          setMode("pick_op_kind");
        }
      } else if (key.name === "escape") {
        setMode("browse");
        resetOpWizard();
      }
      return;
    }

    // ── 1Password kind picker (STEP 3 — API key from an item / Environment) ─────
    // The <select> owns ↑↓; we own Enter (commit kind → value step) and Esc.
    // Cursor index → kind: 0 = ref (API key from an item), 1 = environment.
    // "account" is NO LONGER a kind (it's the `o` shortcut + the step-2 picker).
    if (mode === "pick_op_kind") {
      // The kind step is rendered MANUALLY (bold title + multi-line muted
      // description per option), not via <select>, so the keyboard handler owns
      // ↑↓ here (clamped to the 2 options: 0 = API key, 1 = Environment).
      if (key.name === "up" || key.name === "k") {
        setOpKindCursor((i) => Math.max(0, i - 1));
      } else if (key.name === "down" || key.name === "j") {
        setOpKindCursor((i) => Math.min(1, i + 1));
      } else if (key.name === "return" || key.name === "enter") {
        const kind: OpKind = opKindCursor === 1 ? "environment" : "ref";
        setOpPendingKind(kind);
        setInputValue("");
        setOpEnvPreview(null);
        if (kind === "environment") {
          setMode("input_op_env");
        } else {
          // API key from an item → kick off the vault picker (browse, don't type).
          void loadOpVaults();
        }
      } else if (key.name === "escape") {
        // Back to the scope step (step 1).
        setOpScopeCursor(opPendingScope === "global" ? 0 : 1);
        setMode("pick_op_scope");
      }
      return;
    }

    // Helper: is this keystroke a typeable character (for inline filtering)?
    // `*` is excluded: the filter is a fuzzy SUBSEQUENCE match where `*` would be
    // matched literally — a footgun (it only matches glob-named rows and excludes
    // every concrete field), so it's never a useful filter char in any picker.
    const isFilterChar = (): boolean =>
      !!key.raw &&
      key.raw.length === 1 &&
      !key.ctrl &&
      !key.meta &&
      key.raw >= " " &&
      key.raw !== "*";

    // ── 1Password vault picker (API-key step a) ────────────────────────────────
    // ↑↓ navigate the FUZZY-FILTERED list; typing narrows it; Enter commits the
    // highlighted vault → loads items; Esc → kind picker. The list (not <select>)
    // owns nothing now — App drives cursor + filter so they stay in sync.
    if (mode === "pick_op_vault") {
      if (key.name === "up" || (key.name === "k" && !isFilterChar())) {
        setOpVaultCursor((i) => Math.max(0, i - 1));
      } else if (key.name === "down") {
        setOpVaultCursor((i) => Math.min(Math.max(0, opVaultsFiltered.length - 1), i + 1));
      } else if (key.name === "return" || key.name === "enter") {
        const v = opVaultsFiltered[opVaultCursor];
        if (v) void loadOpItems(v.id, v.title);
      } else if (key.name === "escape") {
        setOpFilter("");
        setOpKindCursor(0);
        setMode("pick_op_kind");
      } else if (key.name === "backspace" || key.name === "delete") {
        setOpFilter((f) => f.slice(0, -1));
        setOpVaultCursor(0);
      } else if (isFilterChar()) {
        setOpFilter((f) => f + key.raw);
        setOpVaultCursor(0);
      }
      return;
    }

    // ── 1Password item picker (API-key step b) ─────────────────────────────────
    // Same fuzzy-filter model. Enter commits the item → loads fields. Esc goes
    // back one level to the vault picker.
    if (mode === "pick_op_item") {
      if (key.name === "up") {
        setOpItemCursor((i) => Math.max(0, i - 1));
      } else if (key.name === "down") {
        setOpItemCursor((i) => Math.min(Math.max(0, opItemsFiltered.length - 1), i + 1));
      } else if (key.name === "return" || key.name === "enter") {
        const it = opItemsFiltered[opItemCursor];
        if (it && opPickedVault && opPickedVaultId)
          void loadOpFields(opPickedVaultId, opPickedVault, it.id, it.title);
      } else if (key.name === "escape") {
        setOpFilter("");
        setOpVaultCursor(0);
        setMode("pick_op_vault");
      } else if (key.name === "backspace" || key.name === "delete") {
        setOpFilter((f) => f.slice(0, -1));
        setOpItemCursor(0);
      } else if (isFilterChar()) {
        setOpFilter((f) => f + key.raw);
        setOpItemCursor(0);
      }
      return;
    }

    // ── 1Password field picker (API-key step c) ────────────────────────────────
    // GROUPED list: section HEADER rows (selectable:false) are visual anchors the
    // cursor skips. ↑↓ find the next/prev selectable row; Enter builds the op://
    // path from the highlighted option; Esc → item picker. After a filter change
    // the cursor snaps to the first selectable row (index 0 may be a header).
    if (mode === "pick_op_field") {
      const opts = opFieldOptionsFiltered;
      // Find the next selectable index from `from` moving in `dir`; if none in
      // that direction, stay put (returns `from`).
      const nextSelectable = (from: number, dir: 1 | -1): number => {
        let i = from;
        while (i >= 0 && i < opts.length) {
          if (opts[i]?.selectable) return i;
          i += dir;
        }
        return from;
      };
      const firstSelectable = (): number => {
        const idx = opts.findIndex((o) => o.selectable);
        return idx < 0 ? 0 : idx;
      };
      if (key.name === "up") {
        setOpFieldCursor((i) => nextSelectable(i - 1, -1));
      } else if (key.name === "down") {
        setOpFieldCursor((i) => nextSelectable(i + 1, 1));
      } else if (key.name === "return" || key.name === "enter") {
        const chosen = opts[opFieldCursor];
        if (chosen && chosen.selectable) {
          const isGlob = isGlobImport(chosen.value);
          setOpPendingValue(chosen.value);
          void runOpAdd(isGlob ? "glob" : "ref", chosen.value, opPendingScope);
        }
      } else if (key.name === "escape") {
        setOpFilter("");
        setOpItemCursor(0);
        setMode("pick_op_item");
      } else if (key.name === "backspace" || key.name === "delete") {
        setOpFilter((f) => f.slice(0, -1));
        // Defer cursor snap to the next render's filtered list via firstSelectable
        // computed against the CURRENT opts (the new filter applies next tick, but
        // snapping to the current first-selectable is a safe approximation; the
        // render clamps anyway). Use 0 → first selectable.
        setOpFieldCursor(firstSelectable());
      } else if (isFilterChar()) {
        setOpFilter((f) => f + key.raw);
        setOpFieldCursor(firstSelectable());
      }
      return;
    }

    // ── 1Password account picker ──────────────────────────────────────────────
    // TWO uses share this mode, distinguished by opPickerResolver.current:
    //  (A) Deferred-promise picker — surfaced mid-operation by resolveSdkAuth's
    //      onNeedsPicker. Enter resolves the promise with the chosen url; Esc
    //      resolves undefined (abort). The in-flight op continues.
    //  (B) Wizard STEP 2 — multi-account disambiguation up front. No resolver is
    //      pending: save the chosen account globally and advance to the kind
    //      picker (step 3). Esc goes back to the scope step (step 1).
    // Both support inline fuzzy filtering of the account list.
    if (mode === "pick_op_account") {
      const resolver = opPickerResolver.current;
      if (key.name === "up") {
        setOpAccountCursor((i) => Math.max(0, i - 1));
      } else if (key.name === "down") {
        setOpAccountCursor((i) => Math.min(Math.max(0, opAccountsFiltered.length - 1), i + 1));
      } else if (key.name === "return" || key.name === "enter") {
        const chosen = opAccountsFiltered[opAccountCursor]?.url;
        setOpFilter("");
        if (resolver) {
          // (A) deferred-promise picker.
          setMode("browse");
          resolver(chosen);
        } else {
          // (B) wizard step 2 → save + advance to the kind picker.
          if (chosen && chosen.trim()) saveOnepasswordAccount(chosen.trim(), "global");
          setOpKindCursor(0);
          setMode("pick_op_kind");
        }
      } else if (key.name === "escape") {
        setOpFilter("");
        if (resolver) {
          setMode("browse");
          resolver(undefined);
        } else {
          // (B) wizard step 2 → back to the scope step.
          setOpScopeCursor(opPendingScope === "global" ? 0 : 1);
          setMode("pick_op_scope");
        }
      } else if (key.name === "backspace" || key.name === "delete") {
        setOpFilter((f) => f.slice(0, -1));
        setOpAccountCursor(0);
      } else if (isFilterChar()) {
        setOpFilter((f) => f + key.raw);
        setOpAccountCursor(0);
      }
      return;
    }

    // Browse mode
    if (key.name === "q") return quit();

    if (key.name === "tab") {
      const tabs: Tab[] = ["providers", "profiles", "routing", "privacy", "onepassword"];
      const idx = tabs.indexOf(activeTab);
      setActiveTab(tabs[(idx + 1) % tabs.length]!);
      setStatusMsg(null);
      return;
    }

    // Number keys switch tabs directly
    if (key.name === "1") {
      setActiveTab("providers");
      setStatusMsg(null);
      return;
    }
    if (key.name === "2") {
      setActiveTab("profiles");
      setStatusMsg(null);
      return;
    }
    if (key.name === "3") {
      setActiveTab("routing");
      setStatusMsg(null);
      return;
    }
    if (key.name === "4") {
      setActiveTab("privacy");
      setStatusMsg(null);
      return;
    }
    if (key.name === "5") {
      setActiveTab("onepassword");
      setStatusMsg(null);
      return;
    }

    if (activeTab === "providers") {
      if (key.name === "up" || key.name === "k") {
        setProviderIndex((i) => Math.max(0, i - 1));
        setStatusMsg(null);
      } else if (key.name === "down" || key.name === "j") {
        setProviderIndex((i) => Math.min(displayProviders.length - 1, i + 1));
        setStatusMsg(null);
      } else if (key.name === "s") {
        if (selectedProvider.apiKeyEnvVar) {
          setInputValue("");
          setStatusMsg(null);
          setMode("input_key");
        } else if (selectedProvider.endpointEnvVar) {
          setInputValue(activeEndpoint);
          setStatusMsg(null);
          setMode("input_endpoint");
        } else {
          setStatusMsg(`${selectedProvider.displayName} has no API-key setup.`);
        }
      } else if (key.name === "e") {
        if (selectedProviderIsLocal) {
          if (selectedLocalEnabled) {
            disableLocalProvider(selectedProvider.catalogName);
            setStatusMsg(`${selectedProvider.displayName} disabled in global config.`);
          } else {
            enableLocalProvider(selectedProvider.catalogName);
            setStatusMsg(`${selectedProvider.displayName} enabled in global config.`);
          }
          refreshConfig();
        } else if (selectedProvider.endpointEnvVar) {
          setInputValue(activeEndpoint);
          setStatusMsg(null);
          setMode("input_endpoint");
        } else {
          setStatusMsg("This provider has no custom endpoint.");
        }
      } else if (key.name === "u") {
        // Edit URL for any provider that has a configurable endpoint.
        // For local providers `e` is taken by the enable/disable toggle, so
        // `u` is the consistent way to edit the URL across all provider types.
        if (selectedProvider.endpointEnvVar) {
          setInputValue(activeEndpoint);
          setStatusMsg(null);
          setMode("input_endpoint");
        } else {
          setStatusMsg("This provider has no editable URL.");
        }
      } else if (key.name === "x") {
        let changed = false;
        if (hasCfgKey) {
          removeApiKey(selectedProvider.apiKeyEnvVar);
          changed = true;
        }
        if (activeEndpointEnvVar && config.endpoints?.[activeEndpointEnvVar]) {
          removeEndpoint(activeEndpointEnvVar);
          delete process.env[activeEndpointEnvVar];
          changed = true;
        }
        if (changed) {
          invalidateProbeProxyHandlers(selectedProvider.catalogName);
          invalidateProbeDiscovery(selectedProvider.catalogName);
          // The prior test badge reflected the now-removed credential.
          clearTestResult(selectedProvider.name);
          refreshConfig();
          setStatusMsg(`Stored config removed for ${selectedProvider.displayName}.`);
        } else {
          setStatusMsg("No stored config to remove.");
        }
      } else if (key.name === "l") {
        // OAuth login for the selected provider. Signal the wrapper
        // (tui/index.tsx) which slug to log into, then destroy the
        // renderer. The wrapper spawns `claudish login {slug}` as a
        // child process so the OAuth callback server and inquirer
        // prompts run in a clean stdio environment. When the child
        // exits, the wrapper re-enters startConfigTui and we're back
        // on a fresh Providers tab.
        //
        // Child-process isolation avoids the ERR_CONNECTION_REFUSED
        // issue that an earlier in-process attempt hit — the child
        // gets a fresh Node runtime with no OpenTUI residue.
        const slug = selectedProvider.oauthSlug;
        if (!slug) {
          setStatusMsg(
            `${selectedProvider.displayName} doesn't support OAuth login. Press s to set an API key.`
          );
        } else if (!requestLogin) {
          // Fallback: wrapper didn't provide the login bridge. Tell the
          // user the command to run manually.
          setStatusMsg(`Run: claudish login ${slug}`);
        } else {
          setStatusMsg(`Launching: claudish login ${slug}…`);
          // Defer destroy so React commits the status message first.
          setTimeout(() => {
            requestLogin(slug);
            renderer.destroy();
          }, 50);
        }
      } else if (key.raw === "T") {
        // Test ALL credentialed providers in parallel. Each call goes through
        // the shared probe proxy (same stack as `claudish --probe`), so
        // credentials are resolved uniformly from env / config / OAuth.
        //
        // Providers without ANY credentials are SKIPPED — they keep their
        // default "not set" / "not configured" badge. Marking them as FAIL
        // would be misleading: "no key, no oauth" isn't a test failure, it's
        // just an unused row.
        //
        // The probe model for each provider is picked from the cached
        // /probeModels catalog inside runProbeTest. Providers with no entry
        // surface as "no probe model in catalog" rather than being skipped
        // silently — that's a more useful signal than an absent row.
        const fired: string[] = [];
        for (const prov of PROVIDERS) {
          // A local server that is RUNNING right now is worth testing even if
          // the user hasn't config-enabled it yet (e.g. a freshly-started
          // Ollama) — otherwise it's invisible to Test All. Non-local providers
          // and not-running locals keep the credential gate.
          const localRunning = prov.isLocal && localLiveness[prov.catalogName] === "running";
          if (!providerIsReady(prov, config) && !localRunning) continue;
          fired.push(prov.displayName);
          // Fire-and-forget — errors are written into testResults inside
          // runProbeTest, no need to await.
          void runProbeTest(prov);
        }
        if (fired.length === 0) {
          setStatusMsg("No credentialed providers to test.");
        } else {
          const startupHint = !isProbeProxyReady()
            ? " (starting probe proxy…)"
            : "";
          setStatusMsg(
            `Testing ${fired.length} provider${fired.length === 1 ? "" : "s"} in parallel…${startupHint}`
          );
        }
      } else if (key.name === "t") {
        // Single-provider test. No-op if there's no credential of any kind —
        // we don't want to flip the badge to FAIL just because nothing is
        // configured. Use the right hint based on provider capabilities.
        const caps = providerAuthCapabilities(selectedProvider, config);
        // A running local server is testable even when not config-enabled.
        const localRunning =
          selectedProviderIsLocal &&
          localLiveness[selectedProvider.catalogName] === "running";
        const ready = providerIsReady(selectedProvider, config) || localRunning;
        if (!ready) {
          if (selectedProviderIsLocal) {
            setStatusMsg(
              `${selectedProvider.displayName}: not running / disabled. Start the server, or press e to enable.`
            );
          } else if (caps.apiKey.supported && caps.oauth.supported) {
            setStatusMsg(
              `${selectedProvider.displayName}: no credentials. Press s to set a key or l to login.`
            );
          } else if (caps.oauth.supported) {
            setStatusMsg(
              `${selectedProvider.displayName}: no credentials. Press l to login.`
            );
          } else if (caps.apiKey.supported) {
            setStatusMsg(
              `${selectedProvider.displayName}: no key set. Press s to set an API key.`
            );
          } else {
            setStatusMsg(
              `${selectedProvider.displayName} doesn't support auth from the TUI.`
            );
          }
          return;
        }
        if (!isProbeProxyReady()) {
          setStatusMsg("Starting probe proxy…");
        }
        // Probe model is picked from the cached /probeModels catalog inside
        // runProbeTest. A missing entry surfaces as a failure row, not a
        // status-line message, so the user sees it on the provider row itself.
        void runProbeTest(selectedProvider);
      }
    } else if (activeTab === "profiles") {
      // Build profile list for navigation
      const globalCfg = loadConfig();
      const localCfg = loadLocalConfig();
      const localNames = localCfg ? Object.keys(localCfg.profiles) : [];
      const globalNames = Object.keys(globalCfg.profiles);
      const allNames = [...new Set([...localNames, ...globalNames])];

      if (key.name === "up" || key.name === "k") {
        setProfileIndex((i) => Math.max(0, i - 1));
        setStatusMsg(null);
      } else if (key.name === "down" || key.name === "j") {
        setProfileIndex((i) => Math.min(Math.max(0, allNames.length - 1), i + 1));
        setStatusMsg(null);
      } else if (key.name === "return" || key.name === "enter" || key.name === "a") {
        // Activate selected profile
        const selectedName = allNames[profileIndex];
        if (selectedName) {
          const cfg = loadConfig();
          cfg.defaultProfile = selectedName;
          saveConfig(cfg);
          refreshConfig();
          setStatusMsg(`Profile "${selectedName}" activated.`);
        }
      } else if (key.name === "n") {
        // New profile — first pick scope (delegates to wizard)
        wizard.startNewProfile();
      } else if (key.name === "e") {
        // Edit selected profile's model mappings (delegates to wizard)
        const selectedName = allNames[profileIndex];
        if (selectedName) {
          const isLocal = localCfg ? !!localCfg.profiles[selectedName] : false;
          wizard.startEditExisting(selectedName, isLocal);
        }
      } else if (key.name === "d") {
        // Delete selected profile (can't delete active one)
        const selectedName = allNames[profileIndex];
        const cfg = loadConfig();
        if (!selectedName) {
          setStatusMsg("No profile selected.");
        } else if (selectedName === cfg.defaultProfile) {
          setStatusMsg("Cannot delete the active profile.");
        } else {
          // Check if it's a local profile
          const localCfgCheck = loadLocalConfig();
          if (localCfgCheck?.profiles[selectedName]) {
            delete localCfgCheck.profiles[selectedName];
            saveLocalConfig(localCfgCheck);
            refreshConfig();
            setProfileIndex((i) => Math.max(0, i - 1));
            setStatusMsg(`Project profile "${selectedName}" deleted.`);
          } else if (Object.keys(cfg.profiles).length <= 1) {
            setStatusMsg("Cannot delete the last global profile.");
          } else if (cfg.profiles[selectedName]) {
            delete cfg.profiles[selectedName];
            saveConfig(cfg);
            refreshConfig();
            setProfileIndex((i) => Math.max(0, i - 1));
            setStatusMsg(`Profile "${selectedName}" deleted.`);
          } else {
            setStatusMsg("Profile not found.");
          }
        }
      }
    } else if (activeTab === "routing") {
      if (key.name === "a") {
        setRoutingPattern("");
        setChainSelected(new Set());
        setChainOrder([]);
        setStatusMsg(null);
        setMode("add_routing_pattern");
      } else if (key.name === "e") {
        // Edit selected rule. ALWAYS opens the scope picker so the user can
        // either confirm the current scope (and proceed to chain edit) or
        // move the rule to the other scope (effectively a single-keystroke
        // promote/demote). The picker is prefilled with the rule's current
        // scope as the suggested choice.
        //
        // For `default` rows, there's no current scope — the picker just
        // asks the user to choose where to write the new override.
        if (mergedRules.length === 0) {
          setStatusMsg("No rules to edit.");
        } else {
          const idx = Math.min(providerIndex, mergedRules.length - 1);
          const rule = mergedRules[idx]!;
          setRoutingPattern(rule.pattern);
          setChainSelected(new Set(rule.chain));
          setChainOrder([...rule.chain]);
          setChainCursor(0);
          setStatusMsg(null);
          // Default scope to the rule's current scope (or "global" for defaults
          // — matches the typical case where users write personal overrides).
          const initialScope: RoutingScope = rule.kind === "project" ? "project" : "global";
          setRoutingScope(initialScope);
          setRoutingScopeCursor(initialScope === "global" ? 0 : 1);
          setEditingExistingScope(rule.kind === "default" ? null : rule.kind);
          setEditingExistingPattern(rule.pattern);
          setRoutingScopeReturnsToEdit(true);
          setMode("pick_routing_scope");
        }
      } else if (key.name === "d") {
        // No more peel: each row owns its scope. Delete from that scope only.
        if (mergedRules.length === 0) {
          setStatusMsg("No rules to delete.");
        } else {
          const idx = Math.min(providerIndex, mergedRules.length - 1);
          const rule = mergedRules[idx]!;
          if (rule.kind === "default") {
            setStatusMsg(
              `Built-in default '${rule.pattern}' cannot be deleted. Press e to override.`
            );
          } else if (rule.kind === "project") {
            const local = loadLocalConfig();
            if (local?.routing && local.routing[rule.pattern] !== undefined) {
              delete local.routing[rule.pattern];
              saveLocalConfig(local);
              refreshConfig();
              setStatusMsg(`Project rule deleted: '${rule.pattern}'.`);
            }
          } else {
            // rule.kind === "global"
            const cfg = loadConfig();
            if (cfg.routing && cfg.routing[rule.pattern] !== undefined) {
              delete cfg.routing[rule.pattern];
              saveConfig(cfg);
              refreshConfig();
              setStatusMsg(`Global rule deleted: '${rule.pattern}'.`);
            }
          }
        }
      } else if (key.name === "up" || key.name === "k") {
        setProviderIndex((i) => Math.max(0, i - 1));
      } else if (key.name === "down" || key.name === "j") {
        setProviderIndex((i) => Math.min(Math.max(0, mergedRules.length - 1), i + 1));
      } else if (key.name === "p") {
        setStatusMsg(null);
        probe.startInput();
      }
    } else if (activeTab === "privacy") {
      if (key.name === "t") {
        const cfg = loadConfig();
        const next = !telemetryEnabled;
        cfg.telemetry = {
          ...(cfg.telemetry ?? {}),
          enabled: next,
          askedAt: cfg.telemetry?.askedAt ?? new Date().toISOString(),
        };
        saveConfig(cfg);
        refreshConfig();
        setStatusMsg(`Telemetry ${next ? "enabled" : "disabled"}.`);
      } else if (key.name === "u") {
        const cfg = loadConfig();
        const next = !statsEnabled;
        cfg.stats = {
          ...(cfg.stats ?? {}),
          enabled: next,
          enabledAt: next ? (cfg.stats?.enabledAt ?? new Date().toISOString()) : cfg.stats?.enabledAt,
        };
        saveConfig(cfg);
        refreshConfig();
        setStatusMsg(`Usage stats ${next ? "enabled" : "disabled"}.`);
      } else if (key.name === "c") {
        clearBuffer();
        setBufStats(getBufferStats());
        setStatusMsg("Stats buffer cleared.");
      }
    } else if (activeTab === "onepassword") {
      // While an async add-validate / test runs, gate everything except a quick
      // status note so two ops can't interleave (mirrors the probe gating).
      if (opBusy) {
        setStatusMsg("1Password: busy, please wait…");
        return;
      }
      if (key.name === "up" || key.name === "k") {
        setOpIndex((i) => Math.max(0, i - 1));
        setStatusMsg(null);
      } else if (key.name === "down" || key.name === "j") {
        setOpIndex((i) => Math.min(Math.max(0, opEntries.length - 1), i + 1));
        setStatusMsg(null);
      } else if (key.name === "a") {
        // Start the add wizard at the SCOPE picker (step 1). The rest of the
        // wizard (account → kind → value) is driven from there.
        resetOpWizard();
        setOpScopeCursor(0);
        setStatusMsg(null);
        setMode("pick_op_scope");
      } else if (key.name === "o") {
        // Shortcut: set the DesktopAuth account directly (its own little flow:
        // input_op_account → pick_op_scope → save). opPendingKind="account"
        // makes pick_op_scope persist instead of advancing the add-wizard.
        resetOpWizard();
        setOpPendingKind("account");
        setInputValue(readOnepasswordAccount() ?? "");
        setStatusMsg(null);
        setMode("input_op_account");
      } else if (key.name === "t") {
        if (opEntries.length === 0) {
          setStatusMsg("No 1Password entries to test.");
        } else if (selectedOpEntry) {
          void testOpEntry(selectedOpEntry);
        }
      } else if (key.name === "x") {
        if (opEntries.length === 0 || !selectedOpEntry) {
          setStatusMsg("No 1Password entry to remove.");
        } else if (selectedOpEntry.scope === "env") {
          // The env/token account is read-only here — can't remove from config.
          setStatusMsg(
            "Account comes from OP_ACCOUNT / token — unset the env var to remove.",
          );
        } else {
          const e = selectedOpEntry;
          // The "env" case was handled above; re-derive a concrete OpScope so
          // the config helpers (which take OpConfigScope) type-check. The alias
          // loses the prior narrowing, so map explicitly.
          const scope: OpScope = e.scope === "project" ? "project" : "global";
          if (e.kind === "account") {
            clearOnepasswordAccount(scope);
          } else if (e.kind === "environment") {
            removeOnepasswordEnvironment(e.value, scope);
          } else {
            removeOnepasswordImport(e.value, scope);
          }
          refreshConfig();
          setOpIndex((i) => Math.max(0, i - 1));
          setStatusMsg("1Password entry removed.");
        }
      }
    }
  });

  if (height < 15 || width < 60) {
    return (
      <box width="100%" height="100%" padding={1} backgroundColor={C.bg}>
        <text>
          <span fg={C.red} attributes={A.bold}>
            Terminal too small ({width}x{height}). Resize to at least 60x15.
          </span>
        </text>
      </box>
    );
  }

  const isInputMode = mode === "input_key" || mode === "input_endpoint";
  const isRoutingInput =
    mode === "add_routing_pattern" ||
    mode === "add_routing_chain" ||
    mode === "pick_routing_scope";

  // ── Layout math ───────────────────────────────────────────────────────────
  // header(1) + tab-bar(3) + content(flex) + detail(fixed) + footer(1)
  const contentH = Math.max(4, height - HEADER_H - TABS_H - DETAIL_H - FOOTER_H - 1);

  // ── Main render ───────────────────────────────────────────────────────────
  return (
    <box width={width} height={height} flexDirection="column" backgroundColor={C.bg}>
      {/* Header */}
      <box height={HEADER_H} flexDirection="column" backgroundColor={C.bgAlt} paddingX={1}>
        {/* Row 1: title / version / attribution / active profile. */}
        <box height={1} flexDirection="row">
          <text>
            <span fg={C.white} attributes={A.bold}>
              claudish
            </span>
            <span fg={C.dim}> ─ </span>
            <span fg={C.blue} attributes={A.bold}>
              {`v${PKG_VERSION}`}
            </span>
            <span fg={C.dim}> ─ </span>
            <span fg={C.fgMuted}>by MadAppGang</span>
            <span fg={C.dim}> ─ </span>
            <span fg={C.fgMuted}>profile: </span>
            <span fg={C.orange} attributes={A.bold}>
              {`[${profileName}]`}
            </span>
          </text>
        </box>
        {/* Row 2: full-width rule. A flex-grow box with a bottom border
            lets Yoga size the line — no manual width math. */}
        <box flexGrow={1} border={["bottom"]} borderStyle="single" borderColor={C.dim} />
      </box>

      {/* Tab bar */}
      <TabBar activeTab={activeTab} statusMsg={statusMsg} />

      {/* Content + detail */}
      {activeTab === "providers" && (
        <>
          <ProvidersContent
            config={config}
            displayProviders={displayProviders}
            providerIndex={providerIndex}
            testResults={testResults}
            localLiveness={localLiveness}
            contentH={contentH}
            isInputMode={isInputMode}
            animTick={animTick}
          />
          <ProviderDetail
            selectedProvider={selectedProvider}
            mode={mode}
            inputValue={inputValue}
            setInputValue={setInputValue}
            width={width}
            hasCfgKey={hasCfgKey}
            hasEnvKey={hasEnvKey}
            hasKey={hasKey}
            isOpKey={isOpKey}
            isPublicKey={selectedPublicKey}
            cfgKeyMask={cfgKeyMask}
            envKeyMask={envKeyMask}
            activeEndpoint={activeEndpoint}
            testResults={testResults}
            isInputMode={isInputMode}
          />
        </>
      )}
      {activeTab === "profiles" && (
        <>
          <ProfilesContent
            config={config}
            activeTab={activeTab}
            mode={mode}
            profileScope={profileScope}
            profileIndex={profileIndex}
            editProfileValue={editProfileValue}
            suggestions={suggestions}
            suggestionIndex={suggestionIndex}
            providerPickerIndex={providerPickerIndex}
            width={width}
            contentH={contentH}
            onScopeChange={wizard.setScopeCursor}
            onPrefixChange={wizard.setProviderPickerIndex}
          />
          <ProfileDetail config={config} profileIndex={profileIndex} />
        </>
      )}
      {activeTab === "routing" && (
        <>
          <RoutingContent
            config={config}
            probeMode={probeMode}
            probeModel={probeModel}
            probeResults={probeResults}
            mode={mode}
            routingPattern={routingPattern}
            chainSelected={chainSelected}
            chainOrder={chainOrder}
            chainCursor={chainCursor}
            // NOTE: `providerIndex` is shared with the Providers tab here. See
            // "Known wart" in ai-docs/app-tsx-split/walkthrough.md — switching
            // tabs preserves the cursor across two unrelated lists.
            providerIndex={providerIndex}
            mergedRules={mergedRules}
            width={width}
            contentH={contentH}
            isRoutingInput={isRoutingInput}
            editingExistingScope={editingExistingScope}
            routingScopeCursor={routingScopeCursor}
          />
          <RoutingDetail probeMode={probeMode} mergedRules={mergedRules} />
        </>
      )}
      {activeTab === "privacy" && (
        <>
          <PrivacyContent
            activeTab={activeTab}
            telemetryEnabled={telemetryEnabled}
            statsEnabled={statsEnabled}
            bufStats={bufStats}
            width={width}
            contentH={contentH}
          />
          <PrivacyDetail />
        </>
      )}
      {activeTab === "onepassword" && (
        <>
          <OnepasswordContent
            activeTab={activeTab}
            entries={opEntries}
            opIndex={opIndex}
            account={opAccountDisplay}
            authConfigured={opAuthConfigured}
            testResults={opTestResults}
            expansions={opExpansions}
            contentH={contentH}
          />
          <OnepasswordDetail selectedEntry={selectedOpEntry} testResults={opTestResults} />
        </>
      )}

      {/* Footer */}
      <Footer
        activeTab={activeTab}
        mode={mode}
        probeMode={probeMode}
        // Per-row capabilities so the Providers tab footer hides chips
        // (s set key / l login / e endpoint / x remove) on rows that
        // don't support the corresponding method.
        providerCaps={
          activeTab === "providers" && selectedProvider
            ? {
                apiKey: !!selectedProvider.apiKeyEnvVar,
                oauth: !!selectedProvider.oauthSlug,
                endpoint: !!selectedProvider.endpointEnvVar,
                local: selectedProviderIsLocal,
                localEnabled: selectedLocalEnabled,
              }
            : undefined
        }
      />

      {/* 1Password add-wizard modal — a centered absolute overlay painted ON
          TOP of the content (zIndex), so the kind/input/scope/account steps are
          a real popup dialog rather than crammed into the bottom detail strip.
          Rendered last so it's the topmost sibling of the root box. */}
      {activeTab === "onepassword" && isOpModalMode(mode) && (
        <OnepasswordModal
          mode={mode}
          inputValue={inputValue}
          setInputValue={setInputValue}
          scopeCursor={opScopeCursor}
          kindCursor={opKindCursor}
          accountCursor={opAccountCursor}
          // Filtered lists — App owns ↑↓ + the inline fuzzy filter, so the modal
          // renders exactly what the keyboard navigates.
          accounts={opAccountsFiltered}
          vaults={opVaultsFiltered}
          items={opItemsFiltered}
          fieldOptions={opFieldOptionsFiltered}
          filter={opFilter}
          vaultCursor={opVaultCursor}
          itemCursor={opItemCursor}
          fieldCursor={opFieldCursor}
          pickedVault={opPickedVault}
          pickedItem={opPickedItem}
          busy={opBusy}
          envPreview={opEnvPreview}
          onScopeChange={(i) => setOpScopeCursor(i === 0 ? 0 : 1)}
          width={width}
          height={height}
        />
      )}
    </box>
  );
}
