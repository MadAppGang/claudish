/**
 * Configuration Manager
 *
 * Manages per-app model mapping configurations.
 */

import type { AppModelMapping, BridgeConfig } from "./types.js";

/**
 * Default configuration with Claude Desktop mappings
 */
function createDefaultConfig(): BridgeConfig {
  return {
    enabled: true,
    defaultModel: undefined, // Pass through to original model by default
    apps: {
      "Claude Desktop": {
        enabled: true,
        modelMap: {
          // Default mappings - can be customized via UI
          // 'claude-3-opus-20240229': 'openai/gpt-4o',
          // 'claude-3-sonnet-20240229': 'openai/gpt-4o-mini',
          // 'claude-3-haiku-20240307': 'mm/minimax-m2.1',
        },
        notes: "Default Claude Desktop configuration",
      },
    },
  };
}

/**
 * Configuration manager for per-app model mappings
 */
export class ConfigManager {
  private config: BridgeConfig;

  constructor() {
    this.config = createDefaultConfig();
  }

  /**
   * Get the current configuration
   */
  getConfig(): BridgeConfig {
    return this.config;
  }

  /**
   * Update configuration with partial updates
   */
  updateConfig(updates: Partial<BridgeConfig>): BridgeConfig {
    // Merge updates into current config
    if (updates.defaultModel !== undefined) {
      this.config.defaultModel = updates.defaultModel;
    }

    if (updates.enabled !== undefined) {
      this.config.enabled = updates.enabled;
    }

    if (updates.apps) {
      // Merge app configurations
      for (const [appName, appConfig] of Object.entries(updates.apps)) {
        if (this.config.apps[appName]) {
          // Merge with existing
          this.config.apps[appName] = {
            ...this.config.apps[appName],
            ...appConfig,
            modelMap: {
              ...this.config.apps[appName].modelMap,
              ...appConfig.modelMap,
            },
          };
        } else {
          // Add new app config
          this.config.apps[appName] = appConfig;
        }
      }
    }

    return this.config;
  }

  /**
   * Set full configuration (replaces existing)
   */
  setConfig(config: BridgeConfig): void {
    this.config = config;
  }

  /**
   * Get mapping for a specific app
   */
  getMappingForApp(appName: string): AppModelMapping | undefined {
    return this.config.apps[appName];
  }

  /**
   * Set mapping for a specific app
   */
  setMappingForApp(appName: string, mapping: AppModelMapping): void {
    this.config.apps[appName] = mapping;
  }

  /**
   * Remove mapping for a specific app
   */
  removeMappingForApp(appName: string): void {
    delete this.config.apps[appName];
  }

  /**
   * Get model mapping for a specific app and model
   * Returns the target model or undefined if no mapping exists
   */
  getModelMapping(appName: string, originalModel: string): string | undefined {
    const appConfig = this.config.apps[appName];
    if (!appConfig || !appConfig.enabled) {
      return undefined;
    }
    return appConfig.modelMap[originalModel];
  }

  /**
   * Set a specific model mapping for an app
   */
  setModelMapping(appName: string, originalModel: string, targetModel: string): void {
    if (!this.config.apps[appName]) {
      this.config.apps[appName] = {
        enabled: true,
        modelMap: {},
      };
    }
    this.config.apps[appName].modelMap[originalModel] = targetModel;
  }

  /**
   * Remove a specific model mapping for an app
   */
  removeModelMapping(appName: string, originalModel: string): void {
    if (this.config.apps[appName]) {
      delete this.config.apps[appName].modelMap[originalModel];
    }
  }

  /**
   * Check if proxy is enabled globally
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Enable or disable proxy globally
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  /**
   * Get list of configured apps
   */
  getConfiguredApps(): string[] {
    return Object.keys(this.config.apps);
  }

  /**
   * Export configuration as JSON string
   */
  exportConfig(): string {
    return JSON.stringify(this.config, null, 2);
  }

  /**
   * Import configuration from JSON string
   */
  importConfig(jsonString: string): void {
    const parsed = JSON.parse(jsonString) as BridgeConfig;
    this.config = parsed;
  }
}
