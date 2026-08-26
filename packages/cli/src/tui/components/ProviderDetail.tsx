import { DETAIL_H } from "../constants.js";
import type { AuthSource, ProviderDef } from "../providers.js";
/** @jsxImportSource @opentui/react */
import { A, C } from "../theme.js";
import type { Mode, TestResultsMap } from "../types.js";

/**
 * Break an error into at most `maxLines` lines that fit `maxWidth`, on word
 * boundaries, with an ellipsis if it still does not fit.
 *
 * One line was not enough for the thing the user actually needs. A surfaced
 * error is `"<Provider> error (HTTP <status>): <claudish hint> — <the
 * provider's own sentence>"` (see `buildSurfacedErrorMessage`), so claudish's
 * attribution and advice eat the first ~120 characters and the provider's
 * sentence — the only part naming the plan and the way out — fell off the end.
 * MiniMax Coding rendered as "… Out of quota - check your plan & bil…" with
 * "Token Plan usage limit reached: Upgrade your Token Plan…" never shown.
 *
 * Bounded on purpose rather than free-wrapping: the detail box is a fixed
 * DETAIL_H, and a wrap that overflows bleeds into the provider rows above,
 * which the renderer cannot invalidate.
 */
function wrapToLines(text: string, maxWidth: number, maxLines: number): string[] {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const limit = Math.max(20, maxWidth);
  if (collapsed.length <= limit) return [collapsed];

  const lines: string[] = [];
  let rest = collapsed;
  while (rest.length > 0 && lines.length < maxLines) {
    if (rest.length <= limit) {
      lines.push(rest);
      break;
    }
    // Break at the last space inside the budget; fall back to a hard cut for a
    // single token longer than the line (a URL, a base64 blob).
    const slice = rest.slice(0, limit);
    const cut = slice.lastIndexOf(" ");
    const at = cut > limit * 0.5 ? cut : limit;
    lines.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  // Anything still left is dropped, so say so on the last line rather than
  // ending mid-sentence as if that were the whole message.
  if (rest.length > 0 && lines.length === maxLines) {
    const last = lines[maxLines - 1] ?? "";
    lines[maxLines - 1] = `${last.slice(0, Math.max(1, limit - 1))}…`;
  }
  return lines;
}

interface ProviderDetailProps {
  selectedProvider: ProviderDef;
  mode: Mode;
  inputValue: string;
  setInputValue: (v: string) => void;
  width: number;
  hasCfgKey: boolean;
  hasEnvKey: boolean;
  hasKey: boolean;
  /** Unified source used by the provider list and readiness classifier. */
  authSource: AuthSource;
  /** True when the env-var key was hydrated from 1Password (not a shell env var). */
  isOpKey: boolean;
  /** True when the env-var key was hydrated from the macOS Keychain. */
  isKcKey: boolean;
  /** True when a keychain item exists for this variable, whether or not it is the value in use. */
  hasKcKey: boolean;
  /**
   * Where a key typed here will be written. Named in the input box title so the
   * store is never a surprise — this used to be plaintext config.json
   * unconditionally, and a silent change of destination for secrets is exactly
   * the kind of thing a user is entitled to see before pressing Enter.
   */
  keySaveTarget: string;
  cfgKeyMask: string;
  envKeyMask: string;
  activeEndpoint: string;
  testResults: TestResultsMap;
  isInputMode: boolean;
}

export function resolveProviderDetailKeyDisplay(input: {
  isLocal: boolean;
  isReady: boolean;
  authSource: AuthSource;
  hasEnvKey: boolean;
  hasCfgKey: boolean;
  envKeyMask: string;
  cfgKeyMask: string;
}): string {
  if (input.isLocal) return input.isReady ? "enabled" : "disabled";
  if (input.authSource === "oauth") return "oauth";
  if (input.hasEnvKey) return input.envKeyMask;
  if (input.hasCfgKey) return input.cfgKeyMask;
  return "────────";
}

export function ProviderDetail({
  selectedProvider,
  mode,
  inputValue,
  setInputValue,
  width,
  hasCfgKey,
  hasEnvKey,
  hasKey,
  authSource,
  isOpKey,
  isKcKey,
  hasKcKey,
  keySaveTarget,
  cfgKeyMask,
  envKeyMask,
  activeEndpoint,
  testResults,
  isInputMode,
}: ProviderDetailProps) {
  // Show the mask of the key that's ACTUALLY being used at runtime.
  // process.env wins over config in the resolver, so env is shown first when both exist.
  const isOAuth = authSource === "oauth";
  const displayKey = resolveProviderDetailKeyDisplay({
    isLocal: !!selectedProvider.isLocal,
    isReady: hasKey,
    authSource,
    hasEnvKey,
    hasCfgKey,
    envKeyMask,
    cfgKeyMask,
  });

  if (isInputMode) {
    return (
      <box
        height={DETAIL_H}
        border
        borderStyle="single"
        borderColor={C.focusBorder}
        title={
          mode === "input_key"
            ? ` Set API Key — ${selectedProvider.displayName} → ${keySaveTarget} `
            : ` Set Endpoint — ${selectedProvider.displayName} `
        }
        backgroundColor={C.bg}
        flexDirection="column"
        paddingX={1}
      >
        <text>
          <span fg={C.green} attributes={A.bold}>
            Enter{" "}
          </span>
          <span fg={C.fgMuted}>to save · </span>
          <span fg={C.red} attributes={A.bold}>
            Esc{" "}
          </span>
          <span fg={C.fgMuted}>to cancel</span>
        </text>
        <box flexDirection="row">
          <text>
            <span fg={C.green} attributes={A.bold}>
              &gt;{" "}
            </span>
          </text>
          <input
            value={inputValue}
            // onInput fires on every keystroke; onChange only fires on blur
            // or the input's own submit (which doesn't happen here because
            // our useKeyboard handler intercepts Enter first). Without this
            // the parent's inputValue stays at the prefilled value and the
            // user's edits are lost when they press Enter.
            onInput={setInputValue}
            onChange={setInputValue}
            focused={true}
            width={width - 8}
            backgroundColor={C.bgHighlight}
            textColor={C.strong}
          />
        </box>
      </box>
    );
  }

  const tr = testResults[selectedProvider.name];

  // The provider's OWN sentence, given lines of its own below.
  //
  // It used to share the "Test:" line, clipped to `width - 16`, which is where
  // the part that names the cause went missing: MiniMax Coding's `429 "Token
  // Plan usage limit reached: Upgrade your Token Plan or purchase Credits for
  // more usage. (2056)"` reached the user as "out of credit · 429 · 2371ms —
  // MiniMax". The status is a bucket; this sentence is the diagnosis, and it is
  // the only place the plan and the way out are named.
  //
  // `providerMessage` rather than `error` because the row directly above
  // already prints the `<state> · <status> · <ms>` prefix that `error` repeats.
  // `error` remains the fallback for states with no upstream message to quote
  // (a local server that is not running, a proxy that never answered), where
  // the rendered line IS the explanation.
  //
  // `Desc:` and `Get Key:` yield their lines to make room (see below). Nothing
  // is lost: both appear elsewhere, and this text appears nowhere else.
  const failureText =
    tr && (tr.status === "failed" || tr.status === "unavailable")
      ? (tr.providerMessage ?? tr.error)
      : undefined;

  return (
    <box
      height={DETAIL_H}
      border
      borderStyle="single"
      borderColor={C.dim}
      title={` ${selectedProvider.displayName} `}
      backgroundColor={C.bgAlt}
      flexDirection="column"
      paddingX={1}
    >
      {/*
        Single-row line: Status + Key + source breakdown.
        Source labels enumerate every place this key is found (env, config),
        in runtime precedence order. The runtime-active source is tagged
        `(used)`; a shadowed source is tagged `(shadowed)` so the user
        knows their `s`-saved config key isn't taking effect.

        Packed into ONE <text> row to fit inside DETAIL_H=7 (5 content
        rows: this + URL + Desc + Get Key + Test). All literal whitespace
        goes inside `{...}` to avoid JSX whitespace trimming.
      */}
      <text>
        <span fg={C.blue} attributes={A.bold}>
          {"Status: "}
        </span>
        {hasKey ? (
          <span fg={C.green} attributes={A.bold}>
            {"● Ready"}
          </span>
        ) : (
          <span fg={C.fgMuted}>{"○ Not configured"}</span>
        )}
        <span fg={C.dim}>{"   "}</span>
        <span fg={C.blue} attributes={A.bold}>
          {"Key: "}
        </span>
        <span fg={C.green}>{displayKey}</span>
        {/* Unconfigured keyed provider: name the exact env var(s) claudish
            expects, so "Not configured" is actionable without leaving the TUI.
            Fits here because the "From:" segment only renders when a key IS
            set — the two never share the row. */}
        {!hasKey && !selectedProvider.isLocal && selectedProvider.apiKeyEnvVar && (
          <>
            <span fg={C.dim}>{"   "}</span>
            <span fg={C.blue} attributes={A.bold}>
              {"Env: "}
            </span>
            <span fg={C.yellow}>
              {[selectedProvider.apiKeyEnvVar, ...(selectedProvider.aliases ?? [])].join(" | ")}
            </span>
          </>
        )}
        {hasKey && selectedProvider.isLocal && (
          <>
            <span fg={C.dim}>{"   "}</span>
            <span fg={C.blue} attributes={A.bold}>
              {"From: "}
            </span>
            <span fg={C.green} attributes={A.bold}>
              {"global config"}
            </span>
          </>
        )}
        {/* OAuth branch FIRST among the non-local sources. Without it an
            OAuth-only provider reaches the env/cfg block below, where both
            flags are false and "From: " renders with nothing after it. */}
        {hasKey && !selectedProvider.isLocal && isOAuth && (
          <>
            <span fg={C.dim}>{"   "}</span>
            <span fg={C.blue} attributes={A.bold}>
              {"From: "}
            </span>
            <span fg={C.cyan} attributes={A.bold}>
              {"oauth"}
            </span>
            <span fg={C.fgMuted}>{" (used)"}</span>
          </>
        )}
        {hasKey && !selectedProvider.isLocal && isOAuth && (
          <>
            <span fg={C.dim}>{"   "}</span>
            <span fg={C.blue} attributes={A.bold}>
              {"From: "}
            </span>
            <span fg={C.green} attributes={A.bold}>
              {"OAuth"}
            </span>
          </>
        )}
        {hasKey && !selectedProvider.isLocal && !isOAuth && (
          <>
            <span fg={C.dim}>{"   "}</span>
            <span fg={C.blue} attributes={A.bold}>
              {"From: "}
            </span>
            {/* Origin of the runtime value. `isKcKey` is tested BEFORE `isOpKey`
                because the keychain is resolved first, so when both vaults could
                supply this variable the keychain is the one that did. */}
            {hasEnvKey && (
              <span fg={C.green} attributes={A.bold}>
                {isKcKey ? "keychain" : isOpKey ? "1Password" : "env"}
              </span>
            )}
            {hasEnvKey && hasCfgKey && <span fg={C.fgMuted}>{" (used) + "}</span>}
            {hasEnvKey && !hasCfgKey && <span fg={C.fgMuted}>{" (used)"}</span>}
            {hasCfgKey && (
              <span fg={hasEnvKey ? C.fgMuted : C.green} attributes={A.boldIf(!hasEnvKey)}>
                {"config"}
              </span>
            )}
            {hasCfgKey && <span fg={C.fgMuted}>{hasEnvKey ? " (shadowed)" : " (used)"}</span>}
            {/* A keychain item that exists but is NOT the runtime value — the
                backend is off, or a higher-priority source shadows it. Worth
                naming explicitly: otherwise `x` reporting "removed from macOS
                Keychain" would come as a surprise on a row that never mentioned
                one. */}
            {hasKcKey && !isKcKey && (
              <>
                <span fg={C.fgMuted}>{" + "}</span>
                <span fg={C.fgMuted}>{"keychain (shadowed)"}</span>
              </>
            )}
          </>
        )}
      </text>
      {selectedProvider.endpointEnvVar && (
        <text>
          <span fg={C.blue} attributes={A.bold}>
            URL:{" "}
          </span>
          <span fg={C.cyan}>{activeEndpoint || selectedProvider.defaultEndpoint || "default"}</span>
        </text>
      )}
      {!failureText && (
        <text>
          <span fg={C.blue} attributes={A.bold}>
            Desc:{" "}
          </span>
          <span fg={C.strong}>{selectedProvider.description}</span>
        </text>
      )}
      {/* `Desc:` and `Get Key:` both yield their line while a failure is on
          screen, which is what buys the message two lines inside a fixed
          DETAIL_H. Neither is lost: the description is in the row's
          DESCRIPTION column, and the key URL is one keypress away once the
          error has been read. The provider's sentence has nowhere else to go. */}
      {selectedProvider.keyUrl && !failureText && (
        <text>
          <span fg={C.blue} attributes={A.bold}>
            Get Key:{" "}
          </span>
          <span fg={C.cyan}>{selectedProvider.keyUrl}</span>
        </text>
      )}
      {tr && (
        <text>
          <span fg={C.blue} attributes={A.bold}>
            {"Test:  "}
          </span>
          {tr.status === "testing" && (
            <span fg={C.yellow} attributes={A.bold}>
              {"◌ testing..."}
            </span>
          )}
          {tr.status === "valid" && (
            <>
              <span fg={C.green} attributes={A.bold}>
                {"● valid"}
              </span>
              {tr.ms !== undefined && <span fg={C.dim}>{`  ${tr.ms}ms`}</span>}
              <span fg={C.fgMuted}>
                {selectedProvider.isLocal
                  ? "  Local provider responded through the shared probe path."
                  : "  API key is valid and endpoint is reachable."}
              </span>
            </>
          )}
          {/* The message itself is NOT here any more — it gets its own
              full-width line below, where the provider's sentence survives
              instead of being clipped to `width - 16`. */}
          {tr.status === "failed" && (
            <span fg={C.red} attributes={A.bold}>
              {"✗ failed"}
            </span>
          )}
          {tr.status === "unavailable" && (
            /* Not a failure — the server is off or has no chat model to probe.
               Neutral yellow, not red. */
            <span fg={C.yellow} attributes={A.bold}>
              {"○ unavailable"}
            </span>
          )}
        </text>
      )}
      {failureText &&
        wrapToLines(failureText, width - 4, 2).map((line, i) => (
          // Index key: these are positional slices of one string, not a
          // reorderable list, so the index IS the stable identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: positional slices of one string
          <text key={i}>
            <span fg={tr?.status === "unavailable" ? C.yellow : C.red}>{line}</span>
          </text>
        ))}
    </box>
  );
}
