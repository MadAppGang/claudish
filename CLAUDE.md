# Claudish - Development Notes

## Release Process

**Releases are handled by CI/CD** - do NOT manually run `npm publish`.

1. Bump version in `package.json`
2. Commit with conventional commit message (e.g., `feat!: v3.0.0 - description`)
3. Create annotated tag: `git tag -a v3.0.0 -m "message"`
4. Push with tags: `git push origin main --tags`
5. CI/CD will automatically publish to npm

## Build Commands

- `bun run build` - Full build (extracts models + bundles)
- `bun run build:ci` - CI build (bundles only, no model extraction)
- `bun run dev` - Development mode

## Model Routing (v4.0+)

### New Syntax: `provider@model[:concurrency]`

```bash
# Explicit provider routing
claudish --model google@gemini-2.0-flash "task"
claudish --model openrouter@deepseek/deepseek-r1 "task"

# Native auto-detection (no prefix needed)
claudish --model gpt-4o "task"          # → OpenAI
claudish --model gemini-2.0-flash "task" # → Google
claudish --model llama-3.1-70b "task"   # → OllamaCloud

# Local models with concurrency
claudish --model ollama@llama3.2:3 "task"  # 3 concurrent requests
```

### Provider Shortcuts
- `g@`, `google@` → Google Gemini
- `oai@` → OpenAI Direct
- `or@`, `openrouter@` → OpenRouter
- `mm@`, `mmax@` → MiniMax
- `mmc@` → MiniMax Coding Plan
- `kimi@`, `moon@` → Kimi
- `glm@`, `zhipu@` → GLM
- `gc@` → GLM Coding Plan
- `llama@`, `oc@` → OllamaCloud
- `litellm@`, `ll@` → LiteLLM (requires LITELLM_BASE_URL)
- `ollama@` → Ollama (local)
- `lmstudio@` → LM Studio (local)

### Vendor Prefix Auto-Resolution (ModelCatalogResolver)

API aggregators (OpenRouter, LiteLLM) require vendor-prefixed model names that users shouldn't need to know. The `ModelCatalogResolver` interface searches each aggregator's dynamic model catalog to find the correct prefix automatically.

**How it works**: User types bare model name → resolver searches the provider's already-fetched model list → finds the exact match with vendor prefix → sends the prefixed name to the API.

**Current resolvers**:
- **OpenRouter**: `or@qwen3-coder-next` → searches catalog → sends `qwen/qwen3-coder-next`
- **LiteLLM**: `ll@gpt-4o` → searches model groups → finds `openai/gpt-4o` (prefix-strip match)
- **Static fallback**: `OPENROUTER_VENDOR_MAP` for cold starts when catalog isn't loaded yet

**Key design rules**:
- Exact match only — no fuzzy/normalized matching. Find the right prefix, don't guess the model.
- Dynamic catalogs (from provider APIs) are PRIMARY. Static map is cold-start fallback only.
- Resolution happens BEFORE handler construction (in `proxy-server.ts`), not inside adapters.
- Sync entry point (`resolveModelNameSync()`) — uses in-memory caches + `readFileSync`, no async propagation.

**Adding a new aggregator resolver**: Implement `ModelCatalogResolver` interface in `providers/catalog-resolvers/`, register in `model-catalog-resolver.ts`. No changes to proxy-server or provider-resolver needed.

**Architecture doc**: `ai-docs/sessions/dev-arch-20260305-104836-a48a463d/architecture.md`

## Local Model Support

Claudish supports local models via:
- **Ollama**: `claudish --model ollama@llama3.2` (or `ollama@llama3.2:3` for concurrency)
- **LM Studio**: `claudish --model lmstudio@model-name`
- **Custom URLs**: `claudish --model http://localhost:11434/model`

### Context Tracking for Local Models

Local model APIs (LM Studio, Ollama) report `prompt_tokens` as the **full conversation context** each request, not incremental tokens. The `writeTokenFile` function uses assignment (`=`) not accumulation (`+=`) for input tokens to handle this correctly.

## Three-Layer Provider Architecture

All provider-specific logic lives in `providers/provider-profiles.ts`. Four resolvers and one effective-definition resolver. `createHandlerForProvider(def, modelName, apiKey, targetModel, port, opts)` composes them into a ComposedHandler.

### Layer 1: APIFormat — wire format
- **Base**: `BaseAPIFormat` (`adapters/base-api-format.ts`)
- **Classes**: OpenAIAPIFormat, AnthropicAPIFormat, GeminiAPIFormat, CodexAPIFormat, OllamaAPIFormat, LiteLLMAPIFormat, OpenRouterAPIFormat
- **Resolver**: `resolveAPIFormat(def, modelName)` switches on `def.transport`
- **Key methods**: `convertMessages()`, `convertTools()`, `buildPayload()`, `getStreamFormat()`, `parseResponse()`

### Layer 2: ModelDialect — model quirks
- **Base**: `BaseModelDialect` (`adapters/base-model-dialect.ts`)
- **Classes**: GrokModelDialect, GeminiModelDialect, DeepSeekModelDialect, QwenModelDialect, MiniMaxModelDialect, GLMModelDialect, XiaomiModelDialect
- **Resolver**: `resolveModelDialect(modelId)` matches model family patterns
- **Key methods**: `processTextContent()`, `getContextWindow()`, `supportsVision()`, `prepareRequest()`

### Layer 3: ProviderTransport — HTTP transport
- **Base**: `BaseTransport` (`providers/transport/base.ts`) owns a `RequestQueue`
- **Subclasses**: `ApiKeyTransport` (Bearer auth), `OAuthTransport` (token refresh)
- **Classes**: OpenAI, Gemini, CodeAssist, Anthropic, OpenRouter, OllamaCloud, LiteLLM, Vertex, Poe, Local, Zen, KimiCoding
- **Resolver**: `resolveTransport(def, modelName, apiKey)` switches on `def.transport`
- **Rate limiting**: `onResponse()`, `shouldRetry()`, `calculateDelay()` as overridable methods (Gemini parses quotaResetDelay, OpenRouter tracks X-RateLimit headers)

### How to add a provider
1. Add entry to `BUILTIN_PROVIDERS` in `provider-definitions.ts` with `transport` type
2. Add case to `resolveTransport` and `resolveAPIFormat` in `provider-profiles.ts`
3. If model has quirks, add case to `resolveModelDialect` and create a ModelDialect class
4. If transport needs custom auth/queue behavior, create a transport subclass extending `BaseTransport`

### Additional resolvers
- `resolveMiddlewares(modelId)`: selects middleware instances (e.g., GeminiThoughtSignatureMiddleware for Gemini models)
- `resolveEffective(def, modelName, apiKey)`: handles definition swaps (zen + minimax) and publicKeyFallback
- `resolveModelDialect(modelId)`: returns `BaseModelDialect | null` (null = no dialect quirks)

### Stream parser selection
```typescript
transport.overrideStreamFormat() ?? modelAdapter.getStreamFormat() ?? adapter.getStreamFormat()
```

**Verifying wiring**: `claudish --probe <model>` shows the full composition.

### Stream Parsers
Located in `handlers/shared/stream-parsers/`:
- `openai-sse.ts` — OpenAI SSE → Claude SSE (used by most providers)
- `anthropic-sse.ts` — Anthropic SSE passthrough (MiniMax, Kimi direct)
- `gemini-sse.ts` — Gemini SSE → Claude SSE
- `ollama-jsonl.ts` — Ollama JSONL → Claude SSE
- `openai-responses-sse.ts` — OpenAI Responses API → Claude SSE (Codex)

## Debug Logging

Debug logging is behind the `--debug` flag and outputs to `logs/` directory. It's disabled by default.
Keep full debug logging (including empty chunks, raw deltas) in log files — needed to understand real model streaming behavior. Suppress noise at the registration/initialization level (e.g., conditional middleware), not at the streaming data level.

### Raw SSE Capture (v5.14.0+)

When `--debug` is active, both stream parsers log raw SSE events:
- `[SSE:openai] {...}` — every OpenAI SSE data line
- `[SSE:anthropic] {...}` — every Anthropic SSE data line

These are greppable and extractable into test fixtures for regression testing.

## Debugging Failed Model Translations

When a model produces wrong output (0 bytes, garbled, wrong format), use this workflow:

### 1. Reproduce with --debug
```bash
claudish --model minimax-m2.5 --debug "say hello"
# Debug log written to logs/claudish_YYYY-MM-DD_HH-MM-SS.log
```

### 2. Verify wiring with --probe
```bash
claudish --probe minimax-m2.5
# Shows: transport, format adapter, model translator, stream format, overrides
```

### 3. Analyze the debug log
Use the `/debug-logs` slash command in Claude Code:
```
/debug-logs logs/claudish_2026-03-17_09-41-32.log
```

This command:
1. Reads the log and counts text chunks, tool calls, HTTP errors, fallback chains
2. Diagnoses the failure mode (no SSE content, text but 0 stdout, wrong parser, etc.)
3. Extracts SSE fixtures from `[SSE:*]` lines using `test-fixtures/extract-sse-from-log.ts`
4. Adds a regression test to `format-translation.test.ts`
5. Runs tests to confirm the regression is captured

### 4. Extract fixtures manually (alternative)
```bash
bun run packages/cli/src/test-fixtures/extract-sse-from-log.ts logs/claudish_*.log
# Creates: test-fixtures/sse-responses/<model>-<format>-turn<N>.sse
```

### 5. Run format translation tests
```bash
bun test packages/cli/src/format-translation.test.ts
```

## Test Infrastructure

### Format Translation Test Harness
`packages/cli/src/format-translation.test.ts` — SSE replay tests for the full translation pipeline.

**Fixture-based**: Each `.sse` file in `test-fixtures/sse-responses/` is a captured SSE stream from a real provider response. Tests replay fixtures through the stream parser and assert correct Claude SSE output.

**Helpers**: `parseClaudeSseStream()`, `extractText()`, `extractToolNames()`, `extractStopReason()`, `fixtureToResponse()`

**Adding regression tests**: After extracting fixtures from a debug log, add a `describe("Regression: <model>")` block. Template is at the bottom of the test file.

## Version Bumping Checklist

When releasing a new version, update ALL of these locations:
1. `package.json` (root monorepo version)
2. `packages/cli/package.json` (npm-published package - **CI/CD publishes from here**)
3. `packages/cli/src/cli.ts` (fallback VERSION constant, line ~27)

The fallback VERSION in cli.ts ensures compiled binaries (Homebrew, standalone) display the correct version when package.json isn't available. The `packages/cli/package.json` version is what npm publishes - if it's not updated, npm publish will fail.
