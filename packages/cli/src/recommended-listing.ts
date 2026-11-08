/**
 * The two renderings of the recommended-models list: the `claudish --models-top`
 * text and the MCP `list_models` markdown, plus the recommended-effort table
 * `list_models` appends.
 *
 * Pure: each function returns text and prints nothing. Section order, headings and
 * descriptions come from `RECOMMENDATION_SECTIONS` through `groupRecommendedModels`;
 * no heading string lives here. Quick picks see only `quickPickCandidates`, so a
 * model in a section that is not quick-pick eligible (luxury) is never one.
 */

import {
  type RecommendedModelGroup,
  type RecommendedModelsDoc,
  type RecommendedSection,
  collectRoutingPrefixes,
  computeQuickPicks,
  formatListingPrice,
  groupRecommendedModels,
  normalizePricingDisplay,
  quickPickCandidates,
} from "./model-loader.js";
import type { ModelEffortRecommendations } from "./providers/effort-recommendations.js";
import { BUILTIN_PROVIDERS } from "./providers/provider-definitions.js";
import { nativeProviderForVendor } from "./providers/route-candidates.js";

/**
 * Vendor slug (lower-case catalog `provider`) → its native claudish provider's
 * first provider shortcut. null when the vendor has no native provider, the
 * provider has no shortcuts, or the first shortcut is the empty string.
 */
export function nativeShortcutForVendor(vendorSlug: string): string | null {
  const canonical = nativeProviderForVendor(vendorSlug);
  if (!canonical) return null;
  const def = BUILTIN_PROVIDERS.find((provider) => provider.name === canonical);
  const shortcut = def?.shortcuts?.[0];
  return shortcut ? shortcut : null;
}

type NativePrefixLookup = (vendorSlug: string) => string | null;

/** The text heading line of a section: its title, plus ` — <description>` when it has one. */
function textHeading(section: RecommendedSection): string {
  return section.description ? `${section.title} — ${section.description}` : section.title;
}

function textRow(group: RecommendedModelGroup, getNativePrefix: NativePrefixLookup): string[] {
  const m = group.primary;
  const rawId = m.id;
  const modelId = rawId.length > 28 ? `${rawId.substring(0, 25)}...` : rawId;
  const modelIdPadded = modelId.padEnd(28);

  const pricing = formatListingPrice(m, { compact: true });
  const pricingPadded = pricing.padEnd(10);

  const context = m.context || "N/A";
  const contextPadded = context.padEnd(6);

  // Capability glyphs — omit (not blank) when false so the caps column
  // naturally narrows for models without reasoning/vision.
  const caps: string[] = [];
  if (m.supportsTools) caps.push("🔧");
  if (m.supportsReasoning) caps.push("🧠");
  if (m.supportsVision) caps.push("👁️");
  const capabilities = caps.join(" ");

  const lines = [`  ${modelIdPadded} ${pricingPadded} ${contextPadded} ${capabilities}`];

  const prefixes = collectRoutingPrefixes(group, getNativePrefix);
  if (prefixes.length > 0) {
    const viaLine = prefixes.map((p) => `${p}@`).join(" · ");
    lines.push(`      via: ${viaLine}`);
  }
  return lines;
}

/** The full `claudish --models-top` text, lines joined with "\n". Prints nothing. */
export function renderRecommendedText(
  doc: RecommendedModelsDoc,
  getNativePrefix: NativePrefixLookup
): string {
  const lastUpdated = doc.lastUpdated || "unknown";
  const sections = groupRecommendedModels(doc.models);
  const lines: string[] = ["", `Recommended Models (last updated: ${lastUpdated}):`, ""];

  sections.forEach((section, sectionIndex) => {
    if (sectionIndex > 0) lines.push("");
    lines.push(textHeading(section));
    lines.push(`  ${"─".repeat(70)}`);
    section.groups.forEach((group, groupIndex) => {
      lines.push(...textRow(group, getNativePrefix));
      if (groupIndex < section.groups.length - 1) lines.push("");
    });
  });

  lines.push("");
  lines.push("  Capabilities: 🔧 Tools  🧠 Reasoning  👁️  Vision");

  const picks = computeQuickPicks(quickPickCandidates(sections));
  const pickLines: string[] = [];
  if (picks.budget)
    pickLines.push(
      `    Budget       → ${picks.budget.id} (${normalizePricingDisplay(
        picks.budget.pricing?.average
      )})`
    );
  if (picks.largeContext)
    pickLines.push(
      `    Large ctx    → ${picks.largeContext.id} (${picks.largeContext.context || "N/A"})`
    );
  if (picks.mostCapable) pickLines.push(`    Most capable → ${picks.mostCapable.id}`);
  if (picks.visionCoding) pickLines.push(`    Vision+code  → ${picks.visionCoding.id}`);
  if (picks.agentic) pickLines.push(`    Agentic      → ${picks.agentic.id}`);

  if (pickLines.length > 0) {
    lines.push("");
    lines.push("  Quick picks:");
    lines.push(...pickLines);
  }

  lines.push("");
  lines.push("  Set default:  export CLAUDISH_MODEL=<model>");
  lines.push("                 or:  claudish --model <model> ...");
  lines.push("");
  lines.push("  For more: claudish --models                     (browse full catalog)");
  lines.push("            claudish --providers                   (list all providers + counts)");
  lines.push("            claudish -s <query>                    (search by keyword)");
  lines.push("            claudish --models-top --models-refresh (refresh from Firebase)");
  lines.push("");
  return lines.join("\n");
}

// No provider on any line: the MCP caller passes the bare heading id and claudish
// routing picks the provider from the user's setup. An Access line listing the
// catalog's `provider@` specs was copied into tool calls and bypassed that routing.
function markdownRow(group: RecommendedModelGroup): string {
  const m = group.primary;
  const pricing = formatListingPrice(m);
  const ctx = m.context || "N/A";
  const caps: string[] = [];
  if (m.supportsTools) caps.push("tools");
  if (m.supportsReasoning) caps.push("reasoning");
  if (m.supportsVision) caps.push("vision");
  const capsLine = caps.length > 0 ? caps.join(", ") : "none";

  return [
    `### ${m.id}`,
    `- **Pricing**: ${pricing} avg · ${ctx} context`,
    `- **Capabilities**: ${capsLine}`,
    "",
  ].join("\n");
}

/** The full MCP `list_models` markdown. Prints nothing. */
export function renderRecommendedMarkdown(doc: RecommendedModelsDoc): string {
  const sections = groupRecommendedModels(doc.models);

  let output = "# Recommended Models\n\n";
  output += `_Last updated: ${doc.lastUpdated || "unknown"}_\n\n`;
  output +=
    "Pass each model by its bare id (the heading); claudish routing picks the provider.\n\n";

  for (const section of sections) {
    output += `## ${section.title}\n\n`;
    if (section.description) output += `_${section.description}_\n\n`;
    for (const group of section.groups) output += markdownRow(group);
  }

  const picks = computeQuickPicks(quickPickCandidates(sections));
  const pickLines: string[] = [];
  if (picks.budget)
    pickLines.push(
      `- **Budget**: \`${picks.budget.id}\` (${normalizePricingDisplay(
        picks.budget.pricing?.average
      )})`
    );
  if (picks.largeContext)
    pickLines.push(
      `- **Large context**: \`${picks.largeContext.id}\` (${picks.largeContext.context || "N/A"})`
    );
  if (picks.mostCapable) pickLines.push(`- **Most capable**: \`${picks.mostCapable.id}\``);
  if (picks.visionCoding) pickLines.push(`- **Vision + coding**: \`${picks.visionCoding.id}\``);
  if (picks.agentic) pickLines.push(`- **Agentic**: \`${picks.agentic.id}\``);

  if (pickLines.length > 0) {
    output += "## Quick picks\n\n";
    output += `${pickLines.join("\n")}\n`;
  }

  return output;
}

/**
 * The catalog's recommended effort as one markdown table: a row per canonical
 * model id, a column per task type, `-` where the catalog has no cell. The
 * calling agent maps its own task to a column and passes the cell to `team`
 * (`efforts`), `create_session` or `run_prompt` (`effort`). Empty string when
 * there is nothing to show.
 */
export function renderEffortTableMarkdown(
  efforts: Readonly<Record<string, ModelEffortRecommendations>>
): string {
  const models = Object.keys(efforts).sort();
  if (models.length === 0) return "";
  const taskTypes = [...new Set(models.flatMap((m) => Object.keys(efforts[m])))].sort();
  const lines = [
    "## Recommended effort by task type",
    "",
    "Map your task to a column, take the cell for each model you run, and pass it: " +
      '`team` `efforts: {"<model>": "<level>"}` (keys exactly as in `models`), ' +
      "`create_session` / `run_prompt` `effort`. A model with no cell keeps Claude Code's " +
      "own effort.",
    "",
    `| model | ${taskTypes.join(" | ")} |`,
    `|---|${taskTypes.map(() => "---").join("|")}|`,
    ...models.map(
      (m) => `| ${m} | ${taskTypes.map((t) => efforts[m][t]?.effort ?? "-").join(" | ")} |`
    ),
  ];
  return lines.join("\n");
}
