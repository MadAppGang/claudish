import chalk from "chalk";
import { RecommendedModel } from "../types.js";

/**
 * Print models grouped by provider with enhanced formatting
 */
export function printProviderSections(sections: {openrouter: RecommendedModel[], poe: RecommendedModel[]}): void {
  const providers = [
    { name: 'OpenRouter', models: sections.openrouter, color: 'blue' },
    { name: 'Poe', models: sections.poe, color: 'magenta' }
  ];

  for (const provider of providers) {
    if (provider.models.length === 0) continue;

    console.log(chalk.bold(`\n${provider.name} Models:`));
    console.log('─'.repeat(80));

    provider.models.forEach((model, index) => {
      const capabilities = [];
      if (model.supportsTools) capabilities.push('🔧');
      if (model.supportsReasoning) capabilities.push('🧠');
      if (model.supportsVision) capabilities.push('👁️');

      console.log(`${index + 1}. ${chalk.bold(model.name)}`);
      console.log(`   ID: ${model.id}`);
      console.log(`   Context: ${formatContextWindow(model.context_length)} | Price: ${formatPrice(model.pricing?.prompt)}`);
      console.log(`   Capabilities: ${capabilities.join(' ') || '💬'}`);
      console.log();
    });
  }
}

/**
 * Print a hybrid view with best overall models first, then provider sections
 */
export function printHybridRecommendations(sections: {openrouter: RecommendedModel[], poe: RecommendedModel[]}): void {
  const allModels = [...sections.openrouter, ...sections.poe];
  const topModels = allModels
    .sort((a, b) => (a.globalPriority || 999) - (b.globalPriority || 999))
    .slice(0, 6);

  console.log(chalk.bold('\n🏆 Best Overall Models\n'));
  printModelTable(topModels);
}

/**
 * Print models in table format (existing functionality)
 */
export function printModelTable(models: RecommendedModel[]): void {
  if (models.length === 0) {
    console.log(chalk.gray("No models found."));
    return;
  }

  // Calculate column widths
  const idWidth = Math.max(...models.map(m => m.id.length), 20);
  const providerWidth = 12;
  const pricingWidth = 12;
  const contextWidth = 10;

  // Print header
  const header = `${"Model".padEnd(idWidth)}  ${"Provider".padEnd(providerWidth)}  ${"Pricing".padEnd(pricingWidth)}  ${"Context".padEnd(contextWidth)}  Capabilities`;
  console.log(header);
  console.log('─'.repeat(header.length + 20));

  // Print models
  models.forEach(model => {
    const capabilities = [];
    if (model.supportsTools) capabilities.push('🔧');
    if (model.supportsReasoning) capabilities.push('🧠');
    if (model.supportsVision) capabilities.push('👁️');

    const row = [
      model.id.padEnd(idWidth),
      (model.provider.charAt(0).toUpperCase() + model.provider.slice(1)).padEnd(providerWidth),
      formatPrice(model.pricing?.prompt).padEnd(pricingWidth),
      formatContextWindow(model.context_length).padEnd(contextWidth),
      capabilities.join(' ') || '💬'
    ];

    console.log(row.join('  '));
  });
}

/**
 * Format context window for display
 */
function formatContextWindow(contextLength: number): string {
  if (contextLength >= 1000000) {
    return `${(contextLength / 1000000).toFixed(1)}M`;
  } else if (contextLength >= 1000) {
    return `${(contextLength / 1000).toFixed(0)}K`;
  }
  return contextLength.toString();
}

/**
 * Format pricing for display
 */
function formatPrice(price?: string): string {
  if (!price) return 'N/A';

  // Extract numeric value and format
  const match = price.match(/[\d.]+/);
  if (!match) return price;

  const value = parseFloat(match[0]);
  if (value === 0) return 'Free';
  if (value < 0.01) return '$$$'; // Very cheap
  if (value < 0.5) return '$$';   // Cheap
  if (value < 2) return '$';      // Medium
  return '$$$$';                  // Expensive
}