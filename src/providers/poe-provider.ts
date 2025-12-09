import type { ModelProvider, UnifiedModel } from '../types.js';

export class PoeProvider implements ModelProvider {
  name = 'poe';
  private readonly POE_API_URL = 'https://api.poe.com/v1/models';

  async fetchModels(): Promise<UnifiedModel[]> {
    try {
      console.log(`🔍 Fetching Poe models from ${this.POE_API_URL}...`);

      const response = await fetch(this.POE_API_URL, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Poe API request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      if (!data || !Array.isArray(data.data)) {
        throw new Error('Invalid response format from Poe API');
      }

      console.log(`📊 Received ${data.data.length} models from Poe API`);

      const models = data.data
        .filter((m: any) => m.is_available !== false)
        .map((m: any, index: number) => ({
          id: `poe:${m.id}`,
          name: m.metadata?.display_name || m.id,
          description: m.description || `${m.owned_by} model`,
          provider: 'poe' as const,
          context_length: m.context_window?.context_length ||
                          m.premium_context_limit ||
                          m.context_length ||
                          4096,
          pricing: {
            prompt: m.pricing?.prompt || '0',
            completion: m.pricing?.completion || '0'
          },
          priority: 100 + index, // Start Poe models with priority 100+
        }));

      console.log(`✅ Processed ${models.length} available Poe models`);
      return models;

    } catch (error) {
      console.error('❌ Error fetching Poe models:', error);
      throw error;
    }
  }

  transformModel(model: UnifiedModel): UnifiedModel {
    // No transformation needed for Poe models - they're already in the right format
    return model;
  }
}

/**
 * Select top Poe models using intelligent patterns
 */
export function selectTopPoeModels(allModels: UnifiedModel[], limit: number = 10): UnifiedModel[] {
  const selected: UnifiedModel[] = [];
  const addedIds = new Set<string>();

  // Priority patterns for model selection
  const patterns = [
    {
      pattern: /o[13]-mini|o1-2024|o3/,
      priority: 1,
      description: "Latest OpenAI reasoning models"
    },
    {
      pattern: /claude-3-(opus|sonnet|haiku)/,
      priority: 2,
      description: "Claude models"
    },
    {
      pattern: /codex|gpt-5/,
      priority: 3,
      description: "Code models"
    },
    {
      pattern: /grok/,
      priority: 4,
      description: "Grok models"
    },
    {
      pattern: /gemini/,
      priority: 5,
      description: "Gemini models"
    },
    {
      pattern: /llama-3/,
      priority: 6,
      description: "Latest Llama"
    },
    {
      pattern: /qwen/,
      priority: 7,
      description: "Qwen models"
    },
    {
      pattern: /deepseek/,
      priority: 8,
      description: "DeepSeek models"
    }
  ];

  // Select models matching patterns in priority order
  for (const { pattern, priority, description } of patterns) {
    if (selected.length >= limit) break;

    const matches = allModels.filter(m => {
      const modelId = m.id.replace('poe:', '');
      return pattern.test(modelId) &&
             m.is_available !== false &&
             !addedIds.has(modelId);
    });

    if (matches.length > 0) {
      // Sort by preference (prefer models with more capabilities)
      const bestMatch = matches.sort((a, b) => {
        const aCaps = getModelCapabilityScore(a);
        const bCaps = getModelCapabilityScore(b);
        return bCaps - aCaps;
      })[0];

      selected.push(bestMatch);
      addedIds.add(bestMatch.id.replace('poe:', ''));
    }
  }

  // Fill remaining slots with available models sorted by capabilities
  if (selected.length < limit) {
    const remaining = allModels
      .filter(m => !addedIds.has(m.id.replace('poe:', '')) && m.is_available !== false)
      .sort((a, b) => getModelCapabilityScore(b) - getModelCapabilityScore(a))
      .slice(0, limit - selected.length);

    selected.push(...remaining);
  }

  return selected.slice(0, limit);
}

/**
 * Calculate capability score for model sorting
 */
function getModelCapabilityScore(model: UnifiedModel): number {
  let score = 0;

  // Context window bonus (0-30 points)
  if (model.context_length >= 200000) score += 30;
  else if (model.context_length >= 100000) score += 20;
  else if (model.context_length >= 32000) score += 10;

  // Capability bonuses
  if (model.supportsTools) score += 20;
  if (model.supportsReasoning) score += 25;
  if (model.supportsVision) score += 15;

  // Provider-specific bonuses
  if (model.id.includes('openai') || model.id.includes('claude')) score += 10;
  if (model.id.includes('gemini')) score += 8;
  if (model.id.includes('grok')) score += 7;

  return score;
}