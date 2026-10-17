# API Key Validation Architecture

This document describes the centralized API key validation system implemented in Claudish v3.10+.

## Overview

All API key validation flows through a single source of truth: the `ProviderResolver` module located at:

- `packages/cli/src/providers/provider-resolver.ts` (cli package — the only package since the monorepo collapse)

## Provider Categories

| Category | Examples | Required Key | Notes |
|----------|----------|--------------|-------|
| `local` | `ollama/llama3`, `lmstudio/qwen`, `http://localhost:8000` | None | Runs on local machine |
| `direct-api` | `g/gemini-2.0`, `oai/gpt-4o`, `mmax/M2.1`, `zen/grok-code` | Provider-specific | Uses provider's native API |
| `openrouter` | `google/gemini-3-pro`, `openai/gpt-5.3`, `or/model` | `OPENROUTER_API_KEY` | Routed through OpenRouter |
| `native-anthropic` | `claude-3-opus-20240229` (no "/") | None | Uses Claude Code's native auth |

## Resolution Priority

When a model ID is provided, it's resolved in this order:

1. **Local prefixes**: `ollama/`, `lmstudio/`, `vllm/`, `mlx/`, `http://`, `https://localhost`
2. **Direct API prefixes**: `g/`, `gemini/`, `go/`, `v/`, `vertex/`, `oai/`, `mmax/`, `mm/`, `kimi/`, `moonshot/`, `glm/`, `zhipu/`, `oc/`, `zen/`, `or/`
3. **Native Anthropic**: Model ID contains no "/" character
4. **OpenRouter default**: Any model with "/" that doesn't match above prefixes

## Direct API Prefixes

| Prefix | Provider | API Key Env Var | Notes |
|--------|----------|-----------------|-------|
| `g/`, `gemini/` | Google Gemini | `GEMINI_API_KEY` | Direct Gemini API |
| `go/` | Gemini Code Assist | OAuth | Requires `claudish --gemini-login` |
| `v/`, `vertex/` | Vertex AI | `VERTEX_API_KEY` or `VERTEX_PROJECT` (OAuth) | Google Cloud |
| `oai/` | OpenAI | `OPENAI_API_KEY` | Direct OpenAI API |
| `mmax/`, `mm/` | MiniMax | `MINIMAX_API_KEY` | Anthropic-compatible |
| `kimi/`, `moonshot/` | Kimi/Moonshot | `MOONSHOT_API_KEY` or `KIMI_API_KEY` | Anthropic-compatible |
| `glm/`, `zhipu/` | GLM/Zhipu | `ZHIPU_API_KEY` or `GLM_API_KEY` | OpenAI-compatible |
| `oc/` | OllamaCloud | `OLLAMA_API_KEY` | Cloud-hosted Ollama |
| `zen/` | OpenCode Zen | None (free models) | Free tier available |
| `or/` | OpenRouter | `OPENROUTER_API_KEY` | Explicit OpenRouter prefix |

## Execution Order

The correct execution order ensures API keys are validated AFTER model selection:

```
parseArgs()           → Collects config, NO key validation
      ↓
selectModel()         → Interactive model picker (if needed)
      ↓
resolveModelProvider() → For all models (main + opus/sonnet/haiku/subagent)
      ↓
IF key missing AND interactive → Prompt for OpenRouter key
IF key missing AND non-interactive → Error with clear message
      ↓
Start proxy
```

## Core Functions

### `resolveModelProvider(modelId: string | undefined): ProviderResolution`

The main resolution function. Returns complete information about:
- Provider category
- Provider name
- Required API key env var
- Whether the key is available
- URL to obtain the key

### `validateApiKeysForModels(models: (string | undefined)[]): ProviderResolution[]`

Validates multiple models at once (useful for checking main model + role mappings).

### `getMissingKeyResolutions(resolutions: ProviderResolution[]): ProviderResolution[]`

Filters resolutions to only those with missing keys.

### `getMissingKeyError(resolution: ProviderResolution): string`

Generates a user-friendly error message for a single missing key.

### `getMissingKeysError(resolutions: ProviderResolution[]): string`

Generates a combined error message for multiple missing keys.

## Common Confusion: OpenRouter vs Direct API

A common source of confusion is the difference between OpenRouter model IDs and direct API prefixes:

| Model ID | Provider | Key Needed |
|----------|----------|------------|
| `google/gemini-3-pro` | OpenRouter | `OPENROUTER_API_KEY` |
| `g/gemini-2.0-flash` | Direct Gemini | `GEMINI_API_KEY` |
| `openai/gpt-5.3` | OpenRouter | `OPENROUTER_API_KEY` |
| `oai/gpt-4o` | Direct OpenAI | `OPENAI_API_KEY` |

**Why the difference?**

- `google/`, `openai/`, etc. are OpenRouter's provider prefixes (they route through OpenRouter)
- `g/`, `oai/`, etc. are Claudish's direct API prefixes (they call the provider's API directly)

## Adding a New Provider

To add a new direct API provider:

1. **Add to remote-provider-registry.ts**:
   ```typescript
   {
     name: "newprovider",
     baseUrl: process.env.NEWPROVIDER_BASE_URL || "https://api.newprovider.com",
     apiPath: "/v1/chat/completions",
     apiKeyEnvVar: "NEWPROVIDER_API_KEY",
     prefixes: ["new/", "np/"],
     capabilities: { ... },
   }
   ```

2. **Add to provider-resolver.ts API_KEY_INFO**:
   ```typescript
   newprovider: {
     envVar: "NEWPROVIDER_API_KEY",
     description: "NewProvider API Key",
     url: "https://newprovider.com/api-keys",
   },
   ```

3. **Create a handler** in `handlers/` if the provider uses a non-standard API format.

4. **Update proxy-server.ts** to route to the new handler.

## Troubleshooting

### "OPENROUTER_API_KEY required" for a model you expected to use direct API

**Problem**: You're using an OpenRouter model ID instead of a direct API prefix.

**Solution**: Use the correct prefix:
- Instead of `google/gemini-3-pro`, use `g/gemini-2.0-flash`
- Instead of `openai/gpt-4o`, use `oai/gpt-4o`

### "GEMINI_API_KEY required" but you want to use OpenRouter

**Problem**: You're using a direct API prefix when you want OpenRouter.

**Solution**: Remove the prefix or use the full OpenRouter model ID:
- Instead of `g/gemini-2.0-flash`, use `google/gemini-2.0-flash` or just the model name

### API key is set but not detected

**Check**:
1. Environment variable is exported: `echo $GEMINI_API_KEY`
2. No typos in the variable name
3. The key doesn't contain trailing whitespace
4. For some providers, check aliases (e.g., `KIMI_API_KEY` is an alias for `MOONSHOT_API_KEY`)

## Architecture Diagram

```
┌─────────────────┐
│   User Input    │
│  --model X/Y    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ ProviderResolver│  ← Single source of truth
│                 │
│ resolveModel()  │
└────────┬────────┘
         │
    ┌────┴────┬────────────┬─────────────┐
    ▼         ▼            ▼             ▼
┌───────┐ ┌────────┐ ┌───────────┐ ┌──────────┐
│ local │ │direct- │ │openrouter │ │ native-  │
│       │ │api     │ │           │ │anthropic │
└───────┘ └────────┘ └───────────┘ └──────────┘
    │         │            │             │
    ▼         ▼            ▼             ▼
 No key   Provider    OPENROUTER_   Claude Code
 needed   specific    API_KEY      native auth
          key
```
