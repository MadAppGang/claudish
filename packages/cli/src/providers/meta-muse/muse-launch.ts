/**
 * Prepare the Muse Code login BEFORE Claude Code starts.
 *
 * Two reasons it cannot wait for the first request:
 *
 * - The served context window. `claude-runner` asks discovery for the model's
 *   window before it spawns Claude Code (`CLAUDE_CODE_MAX_CONTEXT_TOKENS`), and
 *   discovery needs a signed key. In a process that may not prompt (a `team`
 *   slot, a piped launch) the key comes from claudish's own files, which is
 *   exactly what this resolves.
 * - The dialog. In an interactive launch the Keychain access dialog belongs
 *   here, in front of the user who typed the command, not in the middle of
 *   Claude Code's first turn.
 *
 * Runs in EVERY launch role. Which slots need it: an explicit `muse@…` spec,
 * and a bare name whose catalog-gathered candidates include `meta-muse-code`
 * (read from the catalog alone — no credential is touched to decide).
 *
 * Outcomes: an explicit `muse@` slot whose login is terminally unusable stops
 * the launch (exit 1, the message names its fix); a bare-name slot only warns,
 * since its routing chain continues past `meta-muse-code`. A network or
 * transient fault warns and continues — the request path retries.
 */

import { credentialPromptRole } from "../../auth/credentials/prompt-role.js";
import { classifyAuthFailure } from "../../handlers/shared/auth-failure.js";
import { parseModelSpec } from "../model-parser.js";
import { gatherRouteCandidates } from "../route-candidates.js";
import { ensureMuseCredentialReady } from "./muse-credentials.js";

export type MuseLaunchOutcome =
  | { kind: "not-needed" }
  | { kind: "ready" }
  | { kind: "warn"; message: string }
  | { kind: "fatal"; message: string };

/** Which slots need the Muse login: explicit muse@ specs and bare names that gather it. */
export function museSlots(models: readonly unknown[]): { explicit: boolean; bare: boolean } {
  let explicit = false;
  let bare = false;
  for (const model of models) {
    if (typeof model !== "string" || model.length === 0) continue;
    const parsed = parseModelSpec(model);
    if (parsed.isExplicitProvider) {
      if (parsed.provider === "meta-muse-code") explicit = true;
      continue;
    }
    if (
      gatherRouteCandidates(parsed.model).candidates.some((c) => c.provider === "meta-muse-code")
    ) {
      bare = true;
    }
  }
  return { explicit, bare };
}

/** Resolve the Muse login for the launch's slots; see the module comment for outcomes. */
export async function prepareMuseLoginForLaunch(
  models: readonly unknown[]
): Promise<MuseLaunchOutcome> {
  const { explicit, bare } = museSlots(models);
  if (!explicit && !bare) return { kind: "not-needed" };
  try {
    await ensureMuseCredentialReady({ prompt: credentialPromptRole() === "interactive-launch" });
    return { kind: "ready" };
  } catch (err) {
    const failure = classifyAuthFailure(err);
    const message = (err as Error)?.message ?? String(err);
    if (failure.kind === "connection" || failure.kind === "transient") {
      return {
        kind: "warn",
        message: `Muse Code login not confirmed yet (${message}); continuing`,
      };
    }
    return explicit ? { kind: "fatal", message } : { kind: "warn", message };
  }
}
