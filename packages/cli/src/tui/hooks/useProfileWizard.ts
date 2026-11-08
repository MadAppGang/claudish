import { useCallback, useState } from "react";
import { loadConfig, loadLocalConfig, saveConfig, saveLocalConfig } from "../../profile-config.js";
import { configSaveFailure } from "../config-save.js";
import { COMMON_MODELS, getProviderPrefixes } from "../constants.js";
import type { Mode } from "../types.js";

type Scope = "global" | "project";
type EditField = "opus" | "sonnet" | "haiku" | "subagent";

const FIELDS: EditField[] = ["opus", "sonnet", "haiku", "subagent"];
const FIELD_TO_MODE: Record<EditField, Mode> = {
  opus: "edit_profile_opus",
  sonnet: "edit_profile_sonnet",
  haiku: "edit_profile_haiku",
  subagent: "edit_profile_subagent",
};
const MODE_TO_FIELD: Record<string, EditField | undefined> = {
  edit_profile_opus: "opus",
  edit_profile_sonnet: "sonnet",
  edit_profile_haiku: "haiku",
  edit_profile_subagent: "subagent",
};

/**
 * Discriminated-union view of the profile editor wizard.
 *
 * NOTE: `pick_prefix` carries `returnTo` as an internal kind field — it is
 * NOT exposed as a flat hook field, per the constraint in the refactor task
 * description ("providerPickerReturnMode is wizard-internal"). The prefix
 * picker is a side-trip that returns to one of four edit modes.
 */
export type WizardState =
  | { kind: "idle" }
  | { kind: "pick_scope" }
  | { kind: "new_profile"; scope: Scope; value: string }
  | {
      kind: "edit_field";
      scope: Scope;
      profileName: string;
      field: EditField;
      value: string;
      suggestions: string[];
      suggestionIndex: number;
    }
  | {
      kind: "pick_prefix";
      scope: Scope;
      profileName: string;
      returnTo: EditField;
      pickerIndex: number;
    };

interface UseProfileWizardArgs {
  mode: Mode;
  setMode: (m: Mode) => void;
  refreshConfig: () => void;
  setStatusMsg: (m: string | null) => void;
}

export interface UseProfileWizardReturn {
  // DU view of the wizard
  state: WizardState;
  // Legacy flat state atoms — used by render components. Mirrors WizardState
  // but kept stable so the existing prop wiring keeps working.
  editProfileName: string;
  editProfileValue: string;
  profileScope: Scope;
  suggestions: string[];
  suggestionIndex: number;
  providerPickerIndex: number;
  // Cursor for the scope <select> in the bordered wizard modal. 0 = global,
  // 1 = project. The native <select> renders its own highlight; onChange
  // syncs this so the global keyboard handler's Enter commits the right row.
  scopeCursor: 0 | 1;
  // Verbs invoked from the parent's keyboard handler
  startNewProfile: () => void;
  pickScope: (scope: Scope) => void;
  pickScopeAtCursor: () => void;
  setScopeCursor: (index: number) => void;
  setProviderPickerIndex: (index: number) => void;
  cancelPickScope: () => void;
  startEditExisting: (selectedName: string, isLocal: boolean) => void;
  newProfileSubmit: () => void;
  newProfileEscape: () => void;
  newProfileBackspace: () => void;
  newProfileTypeChar: (ch: string) => void;
  prefixPickerUp: () => void;
  prefixPickerDown: () => void;
  prefixPickerSubmit: () => void;
  prefixPickerCancel: () => void;
  editFieldSubmit: () => void;
  editFieldTab: () => void;
  editFieldUp: () => void;
  editFieldDown: () => void;
  editFieldEscape: () => void;
  editFieldBackspace: () => void;
  editFieldTypeChar: (ch: string) => void;
}

function computeSuggestions(input: string): string[] {
  if (!input) return COMMON_MODELS.slice(0, 8);
  const lower = input.toLowerCase();
  return COMMON_MODELS.filter((m) => m.toLowerCase().includes(lower)).slice(0, 8);
}

export function useProfileWizard(args: UseProfileWizardArgs): UseProfileWizardReturn {
  const { mode, setMode, refreshConfig, setStatusMsg } = args;

  const [editProfileName, setEditProfileName] = useState("");
  const [editProfileValue, setEditProfileValue] = useState("");
  const [profileScope, setProfileScope] = useState<Scope>("global");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  const [providerPickerIndex, setProviderPickerIndex] = useState(0);
  // Scope picker cursor for the bordered wizard modal's <select>. 0 = global,
  // 1 = project.
  const [scopeCursor, setScopeCursor] = useState<0 | 1>(0);
  // INTERNAL: the prefix picker is a side-trip that returns to one of four
  // edit modes. NEVER expose this as a flat hook field — see WizardState
  // type comment.
  const [providerPickerReturnMode, setProviderPickerReturnMode] =
    useState<Mode>("edit_profile_opus");

  // ── Helpers (config persistence) ────────────────────────────────────────
  const persistModelField = useCallback(
    (currentMode: Mode, val: string | undefined) => {
      if (profileScope === "project") {
        const localCfg = loadLocalConfig() ?? {
          version: "1.0.0",
          defaultProfile: "",
          profiles: {},
        };
        const prof = localCfg.profiles[editProfileName];
        if (prof) {
          if (currentMode === "edit_profile_opus") prof.models.opus = val || undefined;
          else if (currentMode === "edit_profile_sonnet") prof.models.sonnet = val || undefined;
          else if (currentMode === "edit_profile_haiku") prof.models.haiku = val || undefined;
          else if (currentMode === "edit_profile_subagent") prof.models.subagent = val || undefined;
          prof.updatedAt = new Date().toISOString();
          saveLocalConfig(localCfg);
        }
      } else {
        const cfg = loadConfig();
        const prof = cfg.profiles[editProfileName];
        if (prof) {
          if (currentMode === "edit_profile_opus") prof.models.opus = val || undefined;
          else if (currentMode === "edit_profile_sonnet") prof.models.sonnet = val || undefined;
          else if (currentMode === "edit_profile_haiku") prof.models.haiku = val || undefined;
          else if (currentMode === "edit_profile_subagent") prof.models.subagent = val || undefined;
          prof.updatedAt = new Date().toISOString();
          saveConfig(cfg);
        }
      }
    },
    [editProfileName, profileScope]
  );

  /** False when the save was refused; the status line already says why. */
  const saveModelField = useCallback(
    (currentMode: Mode, fieldVal: string): boolean => {
      const val = fieldVal.trim() === "auto" ? undefined : fieldVal.trim();
      try {
        persistModelField(currentMode, val);
      } catch (err) {
        setStatusMsg(configSaveFailure(err));
        return false;
      }
      refreshConfig();
      return true;
    },
    [persistModelField, refreshConfig, setStatusMsg]
  );

  const getNextFieldValue = useCallback(
    (nextMode: Mode): string => {
      if (profileScope === "project") {
        const localCfg = loadLocalConfig();
        const prof = localCfg?.profiles[editProfileName];
        if (nextMode === "edit_profile_sonnet") return prof?.models?.sonnet ?? "";
        if (nextMode === "edit_profile_haiku") return prof?.models?.haiku ?? "";
        if (nextMode === "edit_profile_subagent") return prof?.models?.subagent ?? "";
      } else {
        const cfg = loadConfig();
        const prof = cfg.profiles[editProfileName];
        if (nextMode === "edit_profile_sonnet") return prof?.models?.sonnet ?? "";
        if (nextMode === "edit_profile_haiku") return prof?.models?.haiku ?? "";
        if (nextMode === "edit_profile_subagent") return prof?.models?.subagent ?? "";
      }
      return "";
    },
    [editProfileName, profileScope]
  );

  // ── Profiles tab → wizard entry ─────────────────────────────────────────
  const startNewProfile = useCallback(() => {
    setEditProfileValue("");
    setProfileScope("global");
    setScopeCursor(0);
    setMode("pick_profile_scope");
    setStatusMsg(null);
  }, [setMode, setStatusMsg]);

  const startEditExisting = useCallback(
    (selectedName: string, isLocal: boolean) => {
      const scope: Scope = isLocal ? "project" : "global";
      setProfileScope(scope);
      const localCfg = loadLocalConfig();
      const prof = isLocal ? localCfg?.profiles[selectedName] : loadConfig().profiles[selectedName];
      setEditProfileName(selectedName);
      const opusVal = prof?.models?.opus ?? "";
      setEditProfileValue(opusVal);
      setSuggestions(computeSuggestions(opusVal));
      setSuggestionIndex(-1);
      setMode("edit_profile_opus");
      setStatusMsg(null);
    },
    [setMode, setStatusMsg]
  );

  // ── pick_profile_scope ──────────────────────────────────────────────────
  const pickScope = useCallback(
    (scope: Scope) => {
      setProfileScope(scope);
      setScopeCursor(scope === "global" ? 0 : 1);
      setEditProfileValue("");
      setMode("new_profile");
    },
    [setMode]
  );

  // Commit the scope highlighted by the <select> cursor. Called from the
  // global keyboard handler on Enter (the proven pick_routing_scope pattern).
  const pickScopeAtCursor = useCallback(() => {
    pickScope(scopeCursor === 0 ? "global" : "project");
  }, [pickScope, scopeCursor]);

  // Sync the <select>'s highlighted row into hook state. Wired to the scope
  // select's onChange so Enter commits the row the user is looking at.
  const setScopeCursorVerb = useCallback((index: number) => {
    setScopeCursor(index === 0 ? 0 : 1);
  }, []);

  // Sync the prefix <select>'s highlighted row into hook state. Wired to the
  // prefix select's onChange so prefixPickerSubmit() commits the right prefix.
  const setProviderPickerIndexVerb = useCallback((index: number) => {
    setProviderPickerIndex(index < 0 ? 0 : index);
  }, []);

  const cancelPickScope = useCallback(() => {
    setMode("browse");
  }, [setMode]);

  // ── new_profile (text input for profile name) ──────────────────────────
  const newProfileSubmit = useCallback(() => {
    const name = editProfileValue.trim();
    if (!name) {
      setMode("browse");
      setEditProfileValue("");
      return;
    }
    const now = new Date().toISOString();
    try {
      if (profileScope === "project") {
        const localCfg = loadLocalConfig() ?? {
          version: "1.0.0",
          defaultProfile: "",
          profiles: {},
        };
        localCfg.profiles[name] = { name, models: {}, createdAt: now, updatedAt: now };
        saveLocalConfig(localCfg);
      } else {
        const cfg = loadConfig();
        cfg.profiles[name] = { name, models: {}, createdAt: now, updatedAt: now };
        saveConfig(cfg);
      }
    } catch (err) {
      // The typed name stays in the input; Enter retries.
      setStatusMsg(configSaveFailure(err));
      return;
    }
    refreshConfig();
    setEditProfileName(name);
    setEditProfileValue("");
    setSuggestions(computeSuggestions(""));
    setSuggestionIndex(-1);
    setMode("edit_profile_opus");
  }, [editProfileValue, profileScope, refreshConfig, setMode, setStatusMsg]);

  const newProfileEscape = useCallback(() => {
    setEditProfileValue("");
    setMode("browse");
  }, [setMode]);

  const newProfileBackspace = useCallback(() => {
    setEditProfileValue((p) => p.slice(0, -1));
  }, []);

  const newProfileTypeChar = useCallback((ch: string) => {
    setEditProfileValue((p) => p + ch);
  }, []);

  // ── pick_provider_prefix ────────────────────────────────────────────────
  const prefixPickerUp = useCallback(() => {
    setProviderPickerIndex((i) => Math.max(0, i - 1));
  }, []);

  const prefixPickerDown = useCallback(() => {
    setProviderPickerIndex((i) => Math.min(getProviderPrefixes().length - 1, i + 1));
  }, []);

  const prefixPickerSubmit = useCallback(() => {
    const prefix = getProviderPrefixes()[providerPickerIndex]?.prefix ?? "";
    setEditProfileValue(prefix);
    setSuggestions(computeSuggestions(prefix));
    setSuggestionIndex(-1);
    setProviderPickerIndex(0);
    setMode(providerPickerReturnMode);
  }, [providerPickerIndex, providerPickerReturnMode, setMode]);

  const prefixPickerCancel = useCallback(() => {
    setProviderPickerIndex(0);
    setMode(providerPickerReturnMode);
  }, [providerPickerReturnMode, setMode]);

  // ── edit_profile_* ──────────────────────────────────────────────────────
  const editFieldSubmit = useCallback(() => {
    // Accept highlighted suggestion or typed value
    let val = editProfileValue;
    if (suggestionIndex >= 0 && suggestions[suggestionIndex]) {
      val = suggestions[suggestionIndex];
    }
    // A refused save keeps this field, its value and the wizard open.
    if (!saveModelField(mode, val)) return;
    setSuggestions([]);
    setSuggestionIndex(-1);
    // Advance to next field or finish
    if (mode === "edit_profile_opus") {
      const nextVal = getNextFieldValue("edit_profile_sonnet");
      setEditProfileValue(nextVal);
      setSuggestions(computeSuggestions(nextVal));
      setSuggestionIndex(-1);
      setMode("edit_profile_sonnet");
    } else if (mode === "edit_profile_sonnet") {
      const nextVal = getNextFieldValue("edit_profile_haiku");
      setEditProfileValue(nextVal);
      setSuggestions(computeSuggestions(nextVal));
      setSuggestionIndex(-1);
      setMode("edit_profile_haiku");
    } else if (mode === "edit_profile_haiku") {
      const nextVal = getNextFieldValue("edit_profile_subagent");
      setEditProfileValue(nextVal);
      setSuggestions(computeSuggestions(nextVal));
      setSuggestionIndex(-1);
      setMode("edit_profile_subagent");
    } else {
      // subagent — done
      const savedName = editProfileName;
      setEditProfileValue("");
      setEditProfileName("");
      setSuggestions([]);
      setSuggestionIndex(-1);
      setMode("browse");
      setStatusMsg(`Profile "${savedName}" saved.`);
    }
  }, [
    editProfileName,
    editProfileValue,
    getNextFieldValue,
    mode,
    saveModelField,
    setMode,
    setStatusMsg,
    suggestionIndex,
    suggestions,
  ]);

  const editFieldTab = useCallback(() => {
    if (editProfileValue === "") {
      // Empty input + Tab → enter provider prefix picker.
      // INTERNAL: stash the current edit mode so prefixPickerSubmit/Cancel
      // can return to it.
      setProviderPickerReturnMode(mode);
      setProviderPickerIndex(0);
      setMode("pick_provider_prefix");
    } else if (suggestionIndex >= 0 && suggestions[suggestionIndex]) {
      // Tab with suggestion highlighted → autocomplete into input, keep editing
      setEditProfileValue(suggestions[suggestionIndex]!);
      setSuggestions(computeSuggestions(suggestions[suggestionIndex]!));
      setSuggestionIndex(-1);
    }
  }, [editProfileValue, mode, setMode, suggestionIndex, suggestions]);

  const editFieldUp = useCallback(() => {
    if (suggestions.length > 0) {
      setSuggestionIndex((i) => Math.max(0, i - 1));
    }
  }, [suggestions]);

  const editFieldDown = useCallback(() => {
    if (suggestions.length > 0) {
      setSuggestionIndex((i) => Math.min(suggestions.length - 1, i + 1));
    }
  }, [suggestions]);

  const editFieldEscape = useCallback(() => {
    if (suggestionIndex >= 0) {
      // Esc dismisses suggestion selection first
      setSuggestionIndex(-1);
    } else {
      // No suggestion highlighted → full cancel back to browse
      setEditProfileValue("");
      setEditProfileName("");
      setSuggestions([]);
      setSuggestionIndex(-1);
      setMode("browse");
    }
  }, [setMode, suggestionIndex]);

  const editFieldBackspace = useCallback(() => {
    setEditProfileValue((p) => {
      const next = p.slice(0, -1);
      setSuggestions(computeSuggestions(next));
      setSuggestionIndex(-1);
      return next;
    });
  }, []);

  const editFieldTypeChar = useCallback((ch: string) => {
    setEditProfileValue((p) => {
      const next = p + ch;
      // Handle 'auto' shortcut with empty input + 'a'
      if (p === "" && ch === "a") {
        setSuggestions([]);
        setSuggestionIndex(-1);
        return "auto";
      }
      setSuggestions(computeSuggestions(next));
      setSuggestionIndex(-1);
      return next;
    });
  }, []);

  // ── DU view (derived from atoms + parent mode) ──────────────────────────
  let state: WizardState;
  if (mode === "pick_profile_scope") {
    state = { kind: "pick_scope" };
  } else if (mode === "new_profile") {
    state = { kind: "new_profile", scope: profileScope, value: editProfileValue };
  } else if (mode === "pick_provider_prefix") {
    const returnTo = MODE_TO_FIELD[providerPickerReturnMode] ?? "opus";
    state = {
      kind: "pick_prefix",
      scope: profileScope,
      profileName: editProfileName,
      returnTo,
      pickerIndex: providerPickerIndex,
    };
  } else if (
    mode === "edit_profile_opus" ||
    mode === "edit_profile_sonnet" ||
    mode === "edit_profile_haiku" ||
    mode === "edit_profile_subagent"
  ) {
    const field = MODE_TO_FIELD[mode] ?? "opus";
    state = {
      kind: "edit_field",
      scope: profileScope,
      profileName: editProfileName,
      field,
      value: editProfileValue,
      suggestions,
      suggestionIndex,
    };
  } else {
    state = { kind: "idle" };
  }

  // Suppress unused warnings for FIELDS / FIELD_TO_MODE — kept for future use.
  void FIELDS;
  void FIELD_TO_MODE;

  return {
    state,
    editProfileName,
    editProfileValue,
    profileScope,
    suggestions,
    suggestionIndex,
    providerPickerIndex,
    scopeCursor,
    startNewProfile,
    pickScope,
    pickScopeAtCursor,
    setScopeCursor: setScopeCursorVerb,
    setProviderPickerIndex: setProviderPickerIndexVerb,
    cancelPickScope,
    startEditExisting,
    newProfileSubmit,
    newProfileEscape,
    newProfileBackspace,
    newProfileTypeChar,
    prefixPickerUp,
    prefixPickerDown,
    prefixPickerSubmit,
    prefixPickerCancel,
    editFieldSubmit,
    editFieldTab,
    editFieldUp,
    editFieldDown,
    editFieldEscape,
    editFieldBackspace,
    editFieldTypeChar,
  };
}
