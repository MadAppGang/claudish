/** @jsxImportSource @opentui/react */
import { A, C } from "../theme.js";
import { FOOTER_H } from "../constants.js";
import type { Mode, ProbeMode, Tab } from "../types.js";

interface FooterProps {
  activeTab: Tab;
  mode: Mode;
  probeMode: ProbeMode;
  /**
   * When on the Providers tab in browse mode, the cursor row's auth
   * capabilities. Used to hide `s set key` / `l login` / `e endpoint`
   * chips on rows that don't support the corresponding method. Omitting
   * the object means "show every chip" (back-compat).
   */
  providerCaps?: {
    apiKey: boolean;
    oauth: boolean;
    endpoint: boolean;
    local: boolean;
    localEnabled: boolean;
  };
}

export function Footer({ activeTab, mode, probeMode, providerCaps }: FooterProps) {
  // Recompute isProfileEditMode from the `mode` prop — pure on `mode`, kept
  // self-contained so the parent doesn't have to pass a derived bool.
  const isProfileEditMode =
    mode === "new_profile" ||
    mode === "pick_profile_scope" ||
    mode === "pick_provider_prefix" ||
    mode === "edit_profile_opus" ||
    mode === "edit_profile_sonnet" ||
    mode === "edit_profile_haiku" ||
    mode === "edit_profile_subagent";

  let keys: Array<[string, string, string]>;
  if (activeTab === "routing" && probeMode === "input") {
    keys = [
      [C.green, "Enter", "probe"],
      [C.red, "Esc", "cancel"],
    ];
  } else if (activeTab === "routing" && probeMode === "running") {
    keys = [
      [C.yellow, "◌", "probing..."],
      [C.red, "Esc", "cancel"],
    ];
  } else if (activeTab === "routing" && probeMode === "done") {
    keys = [
      [C.cyan, "p", "back to routes"],
      [C.green, "Enter", "probe another"],
      [C.red, "Esc", "back to routes"],
      [C.dim, "q", "quit"],
    ];
  } else if (activeTab === "providers") {
    // Hotkey row is computed per-cursor-row: chips that don't apply to the
    // selected provider are hidden. e.g. Gemini Code Assist has no API-key
    // path so `s set key` and `e endpoint` are omitted; bare Gemini has no
    // OAuth path so `l login` is omitted.
    //
    // When providerCaps is omitted (e.g. legacy callers, empty list), all
    // chips are shown — back-compat.
    const showKey = providerCaps ? providerCaps.apiKey : true;
    const showEndpoint = providerCaps ? providerCaps.endpoint || providerCaps.local : true;
    const showLogin = providerCaps ? providerCaps.oauth : true;
    const showRemove = providerCaps ? !providerCaps.local && (providerCaps.apiKey || providerCaps.endpoint) : true;
    // `u` is shown whenever the provider has an editable endpoint URL.
    // For local providers it's the ONLY way to change the URL because `e`
    // is taken by the enable/disable toggle. For remote providers it's a
    // shortcut equivalent to `e endpoint`.
    const showUrl = providerCaps ? providerCaps.endpoint : true;
    keys = [[C.blue, "↑↓", "navigate"]];
    if (showKey) keys.push([C.green, "s", "set key"]);
    if (showEndpoint) keys.push([C.green, "e", providerCaps?.local ? (providerCaps.localEnabled ? "disable" : "enable") : "endpoint"]);
    if (showUrl) keys.push([C.green, "u", "url"]);
    if (showLogin) keys.push([C.green, "l", "login"]);
    keys.push([C.cyan, "t", "test"]);
    keys.push([C.cyan, "T", "test all"]);
    if (showRemove) keys.push([C.red, "x", "remove"]);
    keys.push([C.dim, "q", "quit"]);
  } else if (activeTab === "profiles" && isProfileEditMode) {
    // The bordered "New Profile" wizard modal owns its own inline hint line
    // for every step (scope, name, model fields, provider picker). Showing
    // hotkey chips down here too would be a redundant double hint, so the
    // footer just carries a single context label while the modal is open.
    keys = [[C.dim, "wizard", "follow the panel above"]];
  } else if (activeTab === "profiles") {
    keys = [
      [C.blue, "↑↓", "navigate"],
      [C.green, "Enter", "activate"],
      [C.cyan, "n", "new"],
      [C.green, "e", "edit"],
      [C.red, "d", "delete"],
      [C.blue, "Tab", "section"],
      [C.dim, "q", "quit"],
    ];
  } else if (activeTab === "routing" && mode === "pick_routing_scope") {
    // Routing scope picker — menu navigation. Letters g/p still work as
    // accelerators but the visible affordance is arrows + Enter.
    keys = [
      [C.blue, "↑↓", "navigate"],
      [C.green, "Enter", "select"],
      [C.red, "Esc", "cancel"],
    ];
  } else if (activeTab === "routing") {
    keys = [
      [C.blue, "↑↓", "navigate"],
      [C.green, "a", "add rule"],
      [C.green, "e", "edit"],
      [C.red, "d", "delete"],
      [C.cyan, "p", "probe"],
      [C.blue, "Tab", "section"],
      [C.dim, "q", "quit"],
    ];
  } else if (activeTab === "onepassword" && mode === "input_op_env") {
    // Env input — two-Enter NAME preview (preview, then save). The dialog's own
    // hint carries the preview/save distinction; the footer stays generic.
    keys = [
      [C.green, "Enter", "preview / save"],
      [C.red, "Esc", "cancel"],
    ];
  } else if (activeTab === "onepassword" && mode === "input_op_account") {
    // Account URL input — Enter advances to the scope picker.
    keys = [
      [C.green, "Enter", "save"],
      [C.red, "Esc", "cancel"],
    ];
  } else if (
    activeTab === "onepassword" &&
    (mode === "pick_op_kind" ||
      mode === "pick_op_scope" ||
      mode === "pick_op_account" ||
      mode === "pick_op_vault" ||
      mode === "pick_op_item" ||
      mode === "pick_op_field")
  ) {
    // 1Password picker modes — Enter selects the highlighted option; Esc steps
    // back one level (or cancels at the first step).
    keys = [
      [C.blue, "↑↓", "move"],
      [C.green, "Enter", "select"],
      [C.red, "Esc", "back"],
    ];
  } else if (activeTab === "onepassword") {
    keys = [
      [C.blue, "↑↓", "navigate"],
      [C.green, "a", "add"],
      [C.cyan, "t", "test"],
      [C.green, "o", "account"],
      [C.red, "x", "remove"],
      [C.blue, "Tab", "section"],
      [C.dim, "q", "quit"],
    ];
  } else {
    keys = [
      [C.green, "t", "telemetry"],
      [C.green, "u", "stats"],
      [C.red, "c", "clear"],
      [C.blue, "Tab", "section"],
      [C.dim, "q", "quit"],
    ];
  }

  return (
    <box height={FOOTER_H} flexDirection="row" paddingX={1} backgroundColor={C.bgAlt}>
      <text>
        {/* Monochrome two-tone chips: per-hotkey color is intentionally ignored
            (the `_color` slot). Each chip is ONE connected pill — a lighter-gray
            key segment abutting a darker-gray label segment, with NO gap between
            them. Emphasis is by text brightness (bright bold key vs. muted
            label), not hue. Gaps BETWEEN chips have no background. */}
        {keys.map(([_color, key, label], i) => (
          <span key={i}>
            {i > 0 && <span>{"  "}</span>}
            {/* Key segment — lighter fill, bright bold text. */}
            <span fg={C.fg} bg={C.chipKeyBg} attributes={A.bold}>
              {` ${key} `}
            </span>
            {/* Label segment — darker fill, muted text. Abuts the key segment
                (no space between spans) so the two read as one pill. */}
            <span fg={C.fgMuted} bg={C.chipLabelBg}>
              {`${label} `}
            </span>
          </span>
        ))}
      </text>
    </box>
  );
}
