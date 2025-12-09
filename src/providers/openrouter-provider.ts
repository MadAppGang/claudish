import type { ModelProvider, UnifiedModel } from '../types.js';

export class OpenRouterProvider implements ModelProvider {
  name = 'openrouter';
  private readonly OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/models';

  async fetchModels(): Promise<UnifiedModel[]> {
    try {
      console.log(`🔍 Fetching OpenRouter models from ${this.OPENROUTER_API_URL}...`);

      const response = await fetch(this.OPENROUTER_API_URL, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`OpenRouter API request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      if (!data || !Array.isArray(data.data)) {
        throw new Error('Invalid response format from OpenRouter API');
      }

      console.log(`📊 Received ${data.data.length} models from OpenRouter API`);

      // Filter for top models and assign priorities
      const topModelIds = [
        'x-ai/grok-code-fast-1',
        'minimax/minimax-m2',
        'google/gemini-2.5-flash',
        'openai/gpt-5',
        'openai/gpt-5.1-codex',
        'qwen/qwen3-vl-235b-a22b-instruct',
        'openrouter/polaris-alpha',
      ];

      const models = data.data
        .filter((m: any) => {
          // Include top models and any model with reasonable pricing
          const isTopModel = topModelIds.includes(m.id);
          const hasPricing = m.pricing && (m.pricing.prompt || m.pricing.completion);
          return isTopModel || hasPricing;
        })
        .map((m: any) => ({
          id: m.id,
          name: m.name || m.id,
          description: m.description || `${m.id} model`,
          provider: 'openrouter' as const,
          context_length: m.context_length || 4096,
          pricing: {
            prompt: m.pricing?.prompt || '0',
            completion: m.pricing?.completion || '0'
          },
          priority: topModelIds.indexOf(m.id) >= 0 ? topModelIds.indexOf(m.id) + 1 : 999,
        }));

      // Sort by priority
      models.sort((a, b) => (a.priority || 999) - (b.priority || 999));

      // Add custom model option
      models.push({
        id: 'custom',
        name: 'Custom Model',
        description: 'Enter any OpenRouter model ID manually',
        provider: 'openrouter' as const,
        context_length: 4096,
        pricing: {
          prompt: '0',
          completion: '0'
        },
        priority: 1000,
      });

      console.log(`✅ Processed ${models.length} available OpenRouter models`);
      return models;

    } catch (error) {
      console.error('❌ Error fetching OpenRouter models:', error);
      throw error;
    }
  }

  transformModel(model: UnifiedModel): UnifiedModel {
    // No transformation needed for OpenRouter models
    return model;
  }
}