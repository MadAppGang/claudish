/** @jsxImportSource @opentui/react */
import { A, C } from "../theme.js";
import { DETAIL_H } from "../constants.js";
import type { OpEntry, OpTestResultsMap } from "../types.js";

/**
 * The fixed bottom detail panel for the 1Password tab — BROWSE MODE ONLY.
 *
 * The add-wizard's input + pickers now render in OnepasswordModal (a centered
 * overlay), NOT here. This panel only shows details of the selected entry (or a
 * help line when the list is empty), mirroring ProviderDetail's browse view.
 */

interface OnepasswordDetailProps {
  /** The currently-selected entry (browse-mode detail), if any. */
  selectedEntry: OpEntry | undefined;
  /** Per-entry test results, keyed `${scope}:${kind}:${value}`. */
  testResults: OpTestResultsMap;
}

/** Stable key for an entry's test result (must match App + Content keying). */
function entryKey(e: OpEntry): string {
  return `${e.scope}:${e.kind}:${e.value}`;
}

/** User-facing kind label (no "ref"/"glob" jargon): key / set / env / account. */
function kindLabel(kind: OpEntry["kind"]): string {
  switch (kind) {
    case "ref":
      return "key";
    case "glob":
      return "set (many keys)";
    case "environment":
      return "environment";
    case "account":
      return "account";
  }
}

export function OnepasswordDetail({ selectedEntry, testResults }: OnepasswordDetailProps) {
  // Empty list → guidance.
  if (!selectedEntry) {
    return (
      <box
        height={DETAIL_H}
        border
        borderStyle="single"
        borderColor={C.dim}
        title=" 1Password "
        backgroundColor={C.bgAlt}
        flexDirection="column"
        paddingX={1}
      >
        <text>
          <span fg={C.fgMuted}>
            {"Press [a] to add a key / set / environment, [o] to set the account."}
          </span>
        </text>
        <text>
          <span fg={C.dim}>
            {"A key → one env var; a set → many keys at once; an environment → a whole var set."}
          </span>
        </text>
      </box>
    );
  }

  const tr = testResults[entryKey(selectedEntry)];

  return (
    <box
      height={DETAIL_H}
      border
      borderStyle="single"
      borderColor={C.dim}
      title={` ${kindLabel(selectedEntry.kind)} `}
      backgroundColor={C.bgAlt}
      flexDirection="column"
      paddingX={1}
    >
      <text>
        <span fg={C.blue} attributes={A.bold}>
          {"Scope: "}
        </span>
        <span
          fg={
            selectedEntry.scope === "project"
              ? C.cyan
              : selectedEntry.scope === "global"
                ? C.green
                : C.dim
          }
          attributes={A.bold}
        >
          {selectedEntry.scope}
        </span>
        <span fg={C.dim}>{"   "}</span>
        <span fg={C.blue} attributes={A.bold}>
          {"Kind: "}
        </span>
        <span fg={C.white}>{kindLabel(selectedEntry.kind)}</span>
      </text>
      <text>
        <span fg={C.blue} attributes={A.bold}>
          {"Value: "}
        </span>
        <span fg={C.white}>{selectedEntry.value}</span>
      </text>
      {selectedEntry.kind === "ref" && selectedEntry.envName && (
        <text>
          <span fg={C.blue} attributes={A.bold}>
            {"Env var: "}
          </span>
          <span fg={C.green}>{selectedEntry.envName}</span>
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
              {tr.note && <span fg={C.fgMuted}>{`  ${tr.note}`}</span>}
            </>
          )}
          {tr.status === "failed" && (
            <>
              <span fg={C.red} attributes={A.bold}>
                {"✗ failed"}
              </span>
              {tr.error && (
                <span fg={C.red}>{`  ${tr.error.replace(/\s+/g, " ").trim()}`}</span>
              )}
            </>
          )}
        </text>
      )}
    </box>
  );
}
