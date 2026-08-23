# Three-layer adapter architecture

**Version**: v5.14.0+
**Last updated**: 2026-03-22

Claudish proxies Claude Code requests to any LLM provider. That single job
requires translating three independent things: the API wire format (OpenAI vs
Gemini vs Anthropic), the model's parameter dialect (how each model family
spells "thinking mode"), and the provider's HTTP transport (auth, endpoint
URL, rate limits). Before v5.14.0, each provider got its own monolithic
handler that mixed all three concerns. The three-layer design pulls them apart
so you can change any one without touching the others.

---

## Name mapping

The architecture uses conceptual names that embed the layer. The source code
uses older class names. This table is your Rosetta Stone:

### Interfaces

| Source name (exists in the code) | Conceptual name (docs only) | File |
|-----------------|-----------------|------|
| `APIFormat` | `FormatConverter` | `adapters/api-format.ts` |
| `ModelDialect` | `ModelTranslator` | `adapters/model-dialect.ts` |
| `ProviderTransport` | `ProviderTransport` | `providers/transport/types.ts` |
| `DialectManager` | `AdapterManager` | `adapters/dialect-manager.ts` |

Grep the **left** column; the right column matches nothing in
`packages/cli/src/`. Only `ProviderTransport` carries the same name on both sides.

### Layer 1: APIFormat implementations

| Conceptual name | Source class | What it handles |
|-----------------|-------------|-----------------|
| `OpenAIAPIFormat` | `OpenAIAdapter` (as FormatConverter) | OpenAI Chat Completions wire format |
| `GeminiAPIFormat` | `GeminiAdapter` (as FormatConverter) | Google Gemini `generateContent` format |
| `AnthropicAPIFormat` | `AnthropicPassthroughAdapter` | Anthropic Messages format (MiniMax, Kimi direct) |
| `OllamaAPIFormat` | `OllamaCloudAdapter` | OllamaCloud chat format |
| `CodexAPIFormat` | `CodexAdapter` (as FormatConverter) | OpenAI Responses API format |
| `LiteLLMAPIFormat` | `LiteLLMAdapter` | LiteLLM OpenAI-compatible format |
| `DefaultAPIFormat` | `DefaultAdapter` (as FormatConverter) | No-op fallback (delegates to OpenAI format) |

### Layer 2: ModelDialect implementations

| Conceptual name | Source class | What it handles |
|-----------------|-------------|-----------------|
| `OpenAIModelDialect` | `OpenAIAdapter` (as ModelTranslator) | `thinking` → `reasoning_effort`, `max_completion_tokens` |
| `GrokModelDialect` | `GrokAdapter` | XML tool calls embedded in text |
| `GLMModelDialect` | `GLMAdapter` | Strips unsupported thinking mode |
| `MiniMaxModelDialect` | `MiniMaxAdapter` | `thinking` → `reasoning_split` |
| `DeepSeekModelDialect` | `DeepSeekAdapter` | `reasoning_content` field handling |
| `QwenModelDialect` | `QwenAdapter` | Context windows, vision rules |
| `CodexModelDialect` | `CodexAdapter` (as ModelTranslator) | Responses API-specific parameters |
| `XiaomiModelDialect` | `XiaomiAdapter` | Xiaomi-specific quirks |
| `DefaultModelDialect` | `DefaultAdapter` (as ModelTranslator) | No-op fallback |

### Layer 3: ProviderTransport implementations

| Conceptual name | Source class | What it handles |
|-----------------|-------------|-----------------|
| `OpenAIProviderTransport` | `OpenAIProvider` | OpenAI direct API (auth, endpoints) |
| `GeminiProviderTransport` | `GeminiApiKeyProvider` | Google Gemini with API key |
| `GeminiCodeAssistProviderTransport` | `GeminiCodeAssistProvider` | Google Code Assist with OAuth |
| `AnthropicProviderTransport` | `AnthropicCompatProvider` | Anthropic-compatible APIs (MiniMax, Kimi, Z.AI) |
| `OllamaProviderTransport` | `OllamaCloudProvider` | OllamaCloud endpoints |
| `LiteLLMProviderTransport` | `LiteLLMProvider` | LiteLLM proxy |
| `VertexProviderTransport` | `VertexOAuthProvider` | Google Vertex AI with OAuth |

---

## The three layers

### Layer 1: APIFormat — wire format translation

`APIFormat` converts Claude's internal request format into the target API's
wire format. Every provider family speaks a different schema: OpenAI uses
`messages[]` with `role`/`content`, Gemini uses `contents[]` with `parts`,
Anthropic uses its own Messages API. `APIFormat` owns that translation.

**Interface** (`adapters/api-format.ts`):

```typescript
export interface FormatConverter {
  /** Convert Claude-format messages to the target API format */
  convertMessages(claudeRequest: any, filterIdentityFn?: (s: string) => string): any[];

  /** Convert Claude tools to the target API format */
  convertTools(claudeRequest: any, summarize?: boolean): any[];

  /** Build the full request payload for the target API */
  buildPayload(claudeRequest: any, messages: any[], tools: any[]): any;

  /**
   * The stream format this converter's target API returns.
   * Used by ComposedHandler to select the correct stream parser.
   */
  getStreamFormat(): StreamFormat;

  /** Process text content from the model response */
  processTextContent(
    textContent: string,
    accumulatedText: string
  ): AdapterResult;
}
```

**Concrete example — `GeminiAPIFormat`:**

Claude sends:
```json
{
  "messages": [{ "role": "user", "content": "Hello" }],
  "model": "gemini-3.1-pro"
}
```

After `GeminiAPIFormat.convertMessages()`:
```json
{
  "contents": [{ "role": "user", "parts": [{ "text": "Hello" }] }],
  "generationConfig": { "maxOutputTokens": 8192 }
}
```

`getStreamFormat()` returns `"gemini-sse"`, so the Gemini SSE parser handles
the response.

---

### Layer 2: ModelDialect — model parameter translation

Within a single wire format, different model families have incompatible
parameter names. OpenAI models accept `reasoning_effort`, but GLM ignores
thinking entirely. DeepSeek returns reasoning in a separate
`reasoning_content` field. `ModelDialect` handles these per-family quirks
without touching message or tool shape.

**Interface** (`adapters/model-dialect.ts`):

```typescript
export interface ModelTranslator {
  /** Context window size for this model (tokens) */
  getContextWindow(): number;

  /** Whether this model supports vision/image input */
  supportsVision(): boolean;

  /**
   * Translate model-specific request parameters.
   * E.g., thinking.budget_tokens → reasoning_effort for OpenAI,
   * thinking → reasoning_split for MiniMax, strip thinking for GLM.
   */
  prepareRequest(request: any, originalRequest: any): any;

  /** Maximum tool name length, or null if unlimited */
  getToolNameLimit(): number | null;

  /** Check if this translator handles the given model ID */
  shouldHandle(modelId: string): boolean;

  /** Translator name for logging */
  getName(): string;
}
```

**Concrete example — `DeepSeekModelDialect`:**

Claude sends `thinking: { budget_tokens: 1024 }`. DeepSeek calls that field
`enable_thinking`. After `prepareRequest()`:

```json
{
  "model": "deepseek-r1",
  "enable_thinking": true,
  "thinking_budget": 1024
}
```

On the response side, DeepSeek returns reasoning in `reasoning_content`
rather than a standard thinking block. The dialect extracts it and maps it
back to Claude's `thinking` format.

**Dialect selection — `AdapterManager`** (`adapters/dialect-manager.ts`):

`AdapterManager` picks the dialect automatically from the model ID:

```typescript
// Registered in priority order
this.adapters = [
  new GrokAdapter(modelId),
  new GeminiAdapter(modelId),
  new CodexAdapter(modelId), // Must precede OpenAIAdapter
  new OpenAIAdapter(modelId),
  new QwenAdapter(modelId),
  new MiniMaxAdapter(modelId),
  new DeepSeekAdapter(modelId),
  new GLMAdapter(modelId),
  new XiaomiAdapter(modelId),
];
```

Each adapter's `shouldHandle(modelId)` returns `true` when the model ID
matches its family. The first match wins. Models with no special dialect get
`DefaultModelDialect` (a no-op).

---

### Layer 3: ProviderTransport — HTTP transport

`ProviderTransport` owns everything about making the HTTP request: the
endpoint URL, authorization headers, rate-limiting queue, and OAuth token
refresh. It knows nothing about the request body — that's entirely `APIFormat`
and `ModelDialect`'s concern.

**Interface** (`providers/transport/types.ts`):

```typescript
export interface ProviderTransport {
  readonly name: string;
  readonly displayName: string;
  readonly streamFormat: StreamFormat;

  /** Full API endpoint URL */
  getEndpoint(model?: string): string;

  /** HTTP headers, including auth (may be async for OAuth) */
  getHeaders(): Promise<Record<string, string>>;

  /**
   * Aggregator override: forces a specific stream parser regardless of model.
   * OpenRouter and LiteLLM normalize SSE server-side, so they override to "openai-sse".
   */
  overrideStreamFormat?(): StreamFormat;

  /** Provider-specific payload fields (e.g., extra_headers for LiteLLM) */
  getExtraPayloadFields?(): Record<string, any>;

  /** Rate-limiting queue — wraps the fetch call */
  enqueueRequest?(fetchFn: () => Promise<Response>): Promise<Response>;

  /** OAuth token rotation before each request */
  refreshAuth?(): Promise<void>;

  /** Force refresh after 401; ComposedHandler retries automatically */
  forceRefreshAuth?(): Promise<void>;

  /** Payload envelope wrapping (e.g., CodeAssist) */
  transformPayload?(payload: any): any;

  /** Dynamic context window from local model API */
  getContextWindow?(): number;
}
```

**Concrete example — `OpenAIProviderTransport`:**

```typescript
getEndpoint(model: string): string {
  return "https://api.openai.com/v1/chat/completions";
}

async getHeaders(): Promise<Record<string, string>> {
  return {
    "Authorization": `Bearer ${this.apiKey}`,
    "Content-Type": "application/json",
  };
}
```

**New providers via `PROVIDER_PROFILES`** (`providers/provider-profiles.ts`):

Most transports don't need a new class. Adding a single entry to
`PROVIDER_PROFILES` creates a fully functional transport:

```typescript
// One entry = one new provider
"my-provider": {
  createHandler(ctx: ProfileContext): ModelHandler {
    const transport = new AnthropicCompatProvider(
      ctx.apiKey,
      "https://api.my-provider.com"
    );
    return new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, ctx.sharedOpts);
  }
}
```

---

## How they compose

`ComposedHandler` wires the three layers together for every request:

```typescript
ComposedHandler = APIFormat (explicit) + ModelDialect (auto-selected) + ProviderTransport
```

**Request flow** (numbered steps match the source comment in `composed-handler.ts`):

```
Incoming OpenAI-format request from Claude Code
        │
        ▼
1.  transformOpenAIToClaude(payload)
        │   Normalize to Claude internal format
        ▼
2.  APIFormat.convertMessages(claudeRequest)
        │   Reshape messages for target API
        ▼
3.  APIFormat.convertTools(claudeRequest)
        │   Convert tool schemas
        ▼
4.  APIFormat.buildPayload(messages, tools)
        │   Assemble full request body
        ▼
5.  ModelDialect.prepareRequest(payload)
        │   Apply per-model parameter quirks
        ▼
6.  ProviderTransport.getHeaders()
        │   Add auth headers
        ▼
7.  ProviderTransport.getEndpoint()
        │   Determine URL
        ▼
8.  HTTP fetch (via enqueueRequest if rate limiting is active)
        │
        ▼
9.  Stream parser → Claude SSE output
```

**Stream parser selection** (3-tier priority):

```typescript
const format =
  transport.overrideStreamFormat?.() ??   // Tier 1: aggregator override
  modelAdapter.getStreamFormat?.() ??     // Tier 2: dialect declaration
  providerAdapter.getStreamFormat();      // Tier 3: APIFormat declaration
```

Aggregators (OpenRouter, LiteLLM) normalize all SSE to OpenAI format
server-side, so they set tier 1. Most models let their `APIFormat`'s
`getStreamFormat()` decide at tier 3.

**Available stream parsers:**

| Parser file | Stream format key | Used by |
|-------------|-------------------|---------|
| `openai-sse.ts` | `"openai-sse"` | OpenAI, OpenRouter, LiteLLM, most models |
| `anthropic-sse.ts` | `"anthropic-sse"` | MiniMax direct, Kimi direct |
| `gemini-sse.ts` | `"gemini-sse"` | Google Gemini, Vertex |
| `ollama-jsonl.ts` | `"ollama-jsonl"` | Ollama local, OllamaCloud |
| `openai-responses-sse.ts` | `"openai-responses-sse"` | Codex (OpenAI Responses API) |

---

## Real-world request traces

These four traces show which implementation fills each slot and why.

### gpt-5.4 via OpenAI Direct

| Layer | Implementation | Why |
|-------|---------------|-----|
| L1 APIFormat | `OpenAIAPIFormat` | OpenAI API speaks Chat Completions |
| L2 ModelDialect | `OpenAIModelDialect` | gpt-* models map `thinking` → `reasoning_effort` |
| L3 ProviderTransport | `OpenAIProviderTransport` | Direct OpenAI endpoint, Bearer token auth |

Stream parser: `OpenAIAPIFormat.getStreamFormat()` → `"openai-sse"`

```
gpt-5.4 via OpenAI Direct:
  OpenAIAPIFormat + OpenAIModelDialect + OpenAIProviderTransport
```

---

### gemini-3.1-pro via Google

| Layer | Implementation | Why |
|-------|---------------|-----|
| L1 APIFormat | `GeminiAPIFormat` | Gemini uses `generateContent` with `contents[]/parts[]` |
| L2 ModelDialect | `DefaultModelDialect` | No special parameter quirks for vanilla Gemini |
| L3 ProviderTransport | `GeminiProviderTransport` | Google API key auth, Gemini endpoint |

Stream parser: `GeminiAPIFormat.getStreamFormat()` → `"gemini-sse"`

```
gemini-3.1-pro via Google:
  GeminiAPIFormat + DefaultModelDialect + GeminiProviderTransport
```

---

### deepseek-r1 via OpenRouter

| Layer | Implementation | Why |
|-------|---------------|-----|
| L1 APIFormat | `OpenAIAPIFormat` | OpenRouter presents all models via OpenAI Chat Completions |
| L2 ModelDialect | `DeepSeekModelDialect` | deepseek-r1 uses `reasoning_content`, non-standard thinking params |
| L3 ProviderTransport | `OpenRouterProviderTransport` | OpenRouter endpoint, vendor prefix resolution |

Stream parser: `OpenRouterProviderTransport.overrideStreamFormat()` → `"openai-sse"` (tier 1 wins — OpenRouter normalizes SSE regardless of model)

```
deepseek-r1 via OpenRouter:
  OpenAIAPIFormat + DeepSeekModelDialect + OpenRouterProviderTransport
```

---

### kimi-k2.5: same model, two routes

This trace shows why the three layers exist as separate axes.

| | kimi-k2.5 via OpenRouter | kimi-k2.5 via Moonshot BYOK |
|---|---|---|
| L1 APIFormat | `OpenAIAPIFormat` | `AnthropicAPIFormat` |
| L2 ModelDialect | `DefaultModelDialect` | `DefaultModelDialect` |
| L3 ProviderTransport | `OpenRouterProviderTransport` | `AnthropicProviderTransport` |
| Stream parser | `"openai-sse"` (transport override) | `"anthropic-sse"` (APIFormat declares it) |

The model (L2) is identical on both routes. Moonshot's BYOK endpoint speaks
Anthropic Messages format, so L1 switches to `AnthropicAPIFormat`. OpenRouter
wraps Kimi in its OpenAI-compatible envelope, so L1 stays `OpenAIAPIFormat`.
You change two layers, leave one untouched, and get correct output from both
endpoints.

---

## Adding new support

### Adding a new API format (new Layer 1)

Use this when a provider speaks a wire format not already covered — not just a
different endpoint, but a structurally different request/response schema.

**1. Implement `FormatConverter`:**

```typescript
// adapters/my-format-adapter.ts
import type { FormatConverter } from "./format-converter.js";
import type { StreamFormat } from "../providers/transport/types.js";

export class MyFormatAPIFormat implements FormatConverter {
  convertMessages(claudeRequest: any): any[] {
    // Reshape claude messages → your format
    return claudeRequest.messages.map((m: any) => ({
      role: m.role,
      text: m.content, // example: different field name
    }));
  }

  convertTools(claudeRequest: any): any[] {
    return []; // implement tool schema conversion
  }

  buildPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    return {
      model: claudeRequest.model,
      inputs: messages,
      functions: tools,
    };
  }

  getStreamFormat(): StreamFormat {
    return "openai-sse"; // or write a new parser and add it to StreamFormat
  }

  processTextContent(text: string, accumulated: string) {
    return { text, accumulated };
  }
}
```

**2. Register it in a `ProviderProfile`:**

```typescript
// providers/provider-profiles.ts
"my-provider": {
  createHandler(ctx: ProfileContext): ModelHandler {
    const transport = new OpenAIProvider(ctx.apiKey, "https://api.my-provider.com/v1");
    return new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, {
      ...ctx.sharedOpts,
      adapter: new MyFormatAPIFormat(),
    });
  }
}
```

---

### Adding a new model family (new Layer 2)

Use this when a model speaks an existing wire format (e.g., OpenAI Chat
Completions) but has quirks: renamed parameters, unsupported fields, or a
non-standard context window.

**1. Implement `ModelTranslator`:**

```typescript
// adapters/acme-adapter.ts
import type { ModelTranslator } from "./model-translator.js";

export class AcmeModelDialect implements ModelTranslator {
  constructor(private modelId: string) {}

  shouldHandle(modelId: string): boolean {
    return modelId.startsWith("acme-");
  }

  prepareRequest(request: any, _originalRequest: any): any {
    // acme models don't support thinking mode
    const { thinking, ...rest } = request;
    return rest;
  }

  getContextWindow(): number { return 131072; }
  supportsVision(): boolean { return true; }
  getToolNameLimit(): number | null { return 64; }
  getName(): string { return "AcmeAdapter"; }
}
```

**2. Register in `AdapterManager`:**

```typescript
// adapters/dialect-manager.ts
import { AcmeAdapter } from "./acme-adapter.js";

this.adapters = [
  new GrokAdapter(modelId),
  // ...existing adapters...
  new AcmeAdapter(modelId), // add before DefaultAdapter fallback
];
```

Registration order matters only when two adapters could match the same model
ID. `shouldHandle()` must be specific enough to avoid false positives.

---

### Adding a new provider (new Layer 3)

Most new providers need only a `PROVIDER_PROFILES` entry — no new class
required. Use an existing transport if the provider speaks an existing
protocol.

**Option A — reuse `AnthropicCompatProvider`** (for Anthropic-protocol endpoints):

```typescript
// providers/provider-profiles.ts
"new-byok-provider": {
  createHandler(ctx: ProfileContext): ModelHandler {
    const transport = new AnthropicCompatProvider(
      ctx.apiKey,
      "https://api.new-provider.com/v1"
    );
    return new ComposedHandler(transport, ctx.targetModel, ctx.modelName, ctx.port, ctx.sharedOpts);
  }
}
```

**Option B — new `ProviderTransport` class** (for providers with custom auth or rate limits):

```typescript
// providers/transport/new-provider.ts
import type { ProviderTransport, StreamFormat } from "./types.js";

export class NewProviderTransport implements ProviderTransport {
  readonly name = "new-provider";
  readonly displayName = "New Provider";
  readonly streamFormat: StreamFormat = "openai-sse";

  constructor(private apiKey: string) {}

  getEndpoint(model: string): string {
    return `https://api.new-provider.com/v1/chat/${model}`;
  }

  async getHeaders(): Promise<Record<string, string>> {
    return {
      "X-API-Key": this.apiKey,
      "Content-Type": "application/json",
    };
  }
}
```

Then register it in `PROVIDER_PROFILES` the same way as Option A.

**Verify the wiring** after adding any layer:

```bash
claudish --probe new-provider@my-model
# Output: transport, format adapter, model translator, stream format, overrides
```

---

## Why three layers?

A single-layer "provider adapter" worked when every provider had one model
family and one API format. That assumption broke in practice.

**The kimi problem:**

Kimi (kimi-k2.5) is available two ways:
- Via OpenRouter: OpenAI Chat Completions wire format, OpenRouter transport
- Via Moonshot BYOK: Anthropic Messages wire format, Anthropic-compat transport

A single adapter can't handle both routes. The model's behavior (L2) is
identical on both paths, but L1 (wire format) and L3 (transport) differ.

**The deepseek problem:**

DeepSeek models appear on OpenRouter, LiteLLM, and direct BYOK endpoints.
The wire format on all three is OpenAI Chat Completions (L1 = `OpenAIAPIFormat`
on all three). The transport differs (L3). But the model's `reasoning_content`
parameter quirk is identical regardless of which endpoint you hit. That quirk
belongs in L2 (`DeepSeekModelDialect`), written once, applied everywhere.

**The aggregator problem:**

OpenRouter and LiteLLM serve dozens of model families. Each family has its own
dialect (L2). But both aggregators normalize their SSE streams to OpenAI
format server-side. Without L3's `overrideStreamFormat()`, the
stream parser would be selected by the model's L2 dialect — wrong for every
model routed through an aggregator. Keeping transport concerns in L3 gives
aggregators a clean place to declare this override.

**The result:**

Each axis of variation maps to exactly one layer. The three layers compose
freely. Adding a new model that happens to work through an existing provider
requires only a Layer 2 adapter — no changes to transport or wire format code.

| If you're adding... | Write a new... | Touch |
|---------------------|----------------|-------|
| A model with parameter quirks | `ModelDialect` (L2) | `dialect-manager.ts` registration |
| A provider with a new wire format | `APIFormat` (L1) | `provider-profiles.ts` entry |
| A new HTTP endpoint for existing models | `ProviderTransport` (L3) | `provider-profiles.ts` entry |
| A new API aggregator | `ProviderTransport` (L3) + `overrideStreamFormat()` | `provider-profiles.ts` entry |
