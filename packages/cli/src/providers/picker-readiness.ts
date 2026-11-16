/**
 * One readiness rule for every picker: the OpenTUI picker, the classic picker
 * (`CLAUDISH_PICKER=classic`) and the profile picker (`claudish init`,
 * `profile add`, `profile edit`).
 *
 * The Claude subscription (`native-anthropic`, picked as `claude@<id>`) is ready
 * when Claude Code holds a login: it is never signed with an API key, so an
 * Anthropic key does not make it ready, and asking the credential authority
 * about it would. Every other provider is ready when the credential authority
 * says so; for the Claude API (`anthropic`) that is a key PRESENT in the
 * environment, the config, the Keychain (by enumeration, never read) or
 * 1Password.
 */

import { hasClaudeCodeLogin } from "../auth/claude-code-login.js";
import { credentials } from "../auth/credentials/authority.js";
import type { NativeRoute } from "./native-route.js";

/** The Claude subscription's claudish provider. */
export const CLAUDE_SUBSCRIPTION_PROVIDER: NativeRoute["provider"] = "native-anthropic";

export interface PickerReadinessDeps {
  /** Default `hasClaudeCodeLogin()`. */
  hasLogin?: () => boolean;
  /** Default the credential authority's `isAvailable`. */
  isAvailable?: (name: string) => Promise<boolean>;
}

/** Is `name` usable from a picker on this machine? Never throws. */
export async function pickerProviderReady(
  name: string,
  deps: PickerReadinessDeps = {}
): Promise<boolean> {
  if (name === CLAUDE_SUBSCRIPTION_PROVIDER) {
    try {
      return (deps.hasLogin ?? (() => hasClaudeCodeLogin()))();
    } catch {
      return false;
    }
  }
  const isAvailable = deps.isAvailable ?? ((n: string) => credentials.isAvailable(n));
  return isAvailable(name).catch(() => false);
}
