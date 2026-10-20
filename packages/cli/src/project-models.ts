/**
 * A project `.claudish.json` profile may not point a model tier at a raw URL.
 *
 * The project `.claudish.json` comes with the checkout, like its `.env`, and claudish reads
 * it with no trust step. A tier set to `https://host/v1/m` (or `custom-url@https://…`)
 * routes to the raw-URL `custom-url` provider, which needs no key, so the conversation —
 * and the code Claude Code reads — would go to a host the checkout chose. The check is
 * `modelSpecNamesRawUrl`, the same one a `.env` model pin gets (`dotenv-allowlist.ts`).
 *
 * The tier is dropped where tiers enter a run (`cli.ts`), so the next source fills it as if
 * the profile did not set it, with one stderr line naming the tiers, never the values. The
 * file is left as it is, so editing the profile keeps them. The user's own config is not
 * checked: a raw URL there is the user's choice.
 *
 * Its own module, not part of `profile-config.ts`: the parser imports the provider
 * definitions, which import `profile-config.ts`, so the config cannot import the parser
 * without an import cycle (measured: loading `provider-definitions.ts` first then throws
 * "Cannot access '_shortcutsCache' before initialization").
 */

import type { ModelMapping, RunModelMapping } from "./profile-config.js";
import { modelSpecNamesRawUrl } from "./providers/model-parser.js";

/** The tiers a run may take from `run`: a project profile's raw-URL tiers removed. */
export function usableProfileModels(run: RunModelMapping): ModelMapping {
  if (run.projectProfile === null) return run.models;
  const kept: ModelMapping = {};
  const refused: string[] = [];
  for (const [tier, spec] of Object.entries(run.models) as Array<
    [keyof ModelMapping, string | undefined]
  >) {
    if (typeof spec === "string" && modelSpecNamesRawUrl(spec)) refused.push(tier);
    else kept[tier] = spec;
  }
  if (refused.length > 0) console.error(rawUrlProfileNotice(run.projectProfile, refused));
  return kept;
}

/** The one stderr line for project-profile tiers refused as raw URLs. Names only. */
export function rawUrlProfileNotice(profileName: string, tiers: readonly string[]): string {
  const them = tiers.length === 1 ? "it" : "them";
  const models = tiers.length === 1 ? "model" : "models";
  return `[claudish] ignoring the ${tiers.join(", ")} ${models} of profile "${profileName}" in .claudish.json: a project's .claudish.json may not point a model at a raw http(s):// URL. Set ${them} in your shell, with a flag, or in your own claudish config.`;
}
