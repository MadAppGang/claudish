/**
 * The two renderings of the recommended-models list: the `claudish --models-top`
 * text and the MCP `list_models` markdown.
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

function markdownRow(group: RecommendedModelGroup, getNativePrefix: NativePrefixLookup): string {
  const m = group.primary;
  const pricing = formatListingPrice(m);
  const ctx = m.context || "N/A";
  const caps: string[] = [];
  if (m.supportsTools) caps.push("tools");
  if (m.supportsReasoning) caps.push("reasoning");
  if (m.supportsVision) caps.push("vision");
  const capsLine = caps.length > 0 ? caps.join(", ") : "none";

  const prefixes = collectRoutingPrefixes(group, getNativePrefix);
  const accessLine =
    prefixes.length > 0 ? prefixes.map((p) => `\`${p}@${m.id}\``).join(" · ") : `\`${m.id}\``;

  return [
    `### ${m.id}`,
    `- **Pricing**: ${pricing} avg · ${ctx} context`,
    `- **Capabilities**: ${capsLine}`,
    `- **Access**: ${accessLine}`,
    "",
  ].join("\n");
}

/** The full MCP `list_models` markdown. Prints nothing. */
export function renderRecommendedMarkdown(
  doc: RecommendedModelsDoc,
  getNativePrefix: NativePrefixLookup
): string {
  const sections = groupRecommendedModels(doc.models);

  let output = "# Recommended Models\n\n";
  output += `_Last updated: ${doc.lastUpdated || "unknown"}_\n\n`;

  for (const section of sections) {
    output += `## ${section.title}\n\n`;
    if (section.description) output += `_${section.description}_\n\n`;
    for (const group of section.groups) output += markdownRow(group, getNativePrefix);
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
