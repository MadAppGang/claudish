import { describe, expect, test } from "bun:test";
import { BUILTIN_PROVIDERS } from "./provider-definitions";
import { buildCredentialHint } from "./routing-hints";

// #499 CR: adopting upstream's routing-hints.ts wholesale renamed the fork's
// canonical provider keys (zai→"z-ai", xai→"x-ai", gemini-codeassist→
// "antigravity"), so a missing-key error for those providers silently lost
// its remedy line — nothing failed and no test noticed. Structural pin: every
// provider definition that declares an apiKeyEnvVar must get a hint naming
// that env var, or appear in HINT_EXEMPTIONS with a reason. Renaming a key in
// PROVIDER_HINT_MAP without updating provider-definitions.ts (or vice versa)
// turns this red.
const HINT_EXEMPTIONS: Record<string, string> = {
  // provider name → why buildCredentialHint may omit it.
  // The four below are pre-existing coverage gaps on main, measured 2026-10-17
  // when this pin landed — listed so the pin is green on main while staying
  // red for any NEW silent loss (the #499 CR case: upstream's map renamed
  // zai/xai and dropped gemini-codeassist). Closing a gap = move the provider
  // out of this map, never delete the pin.
  "opencode-zen-go": "map covers the sibling `opencode-zen` (same OPENCODE_API_KEY); the -go subscription tier itself is keyless",
  vertex: "VERTEX_PROJECT is a GCP project id consumed via OAuth/ADC, not an exportable key",
  litellm: "aggregator — credential semantics belong to the backing deployment",
  poe: "pre-existing gap, no entry in PROVIDER_HINT_MAP",
};

describe("routing-hints structural pin (#499 CR)", () => {
  test("every provider with an apiKeyEnvVar gets a hint naming it (or is exempted)", () => {
    const gaps: string[] = [];
    for (const p of BUILTIN_PROVIDERS) {
      if (!p.apiKeyEnvVar) continue;
      const exempt = HINT_EXEMPTIONS[p.name];
      if (exempt) continue;
      const hint = buildCredentialHint(`probe@${p.name}`, [p.name]);
      if (!hint || !hint.includes(p.apiKeyEnvVar)) {
        gaps.push(
          `${p.name} (${p.apiKeyEnvVar}): ${hint ? "hint present without the env var" : "no hint at all"}`
        );
      }
    }
    expect(gaps).toEqual([]);
  });

  test("gemini-codeassist keeps its OAuth login hint under the fork's canonical name", () => {
    const hint = buildCredentialHint("probe@gemini-codeassist", ["gemini-codeassist"]);
    expect(hint).toContain("login gemini");
  });
});
