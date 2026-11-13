/**
 * `claudish serve` — standalone inference gateway for Claude Desktop redirect.
 *
 * The `claude-desktop-profiles` macOS app points Claude Desktop's "third-party
 * inference" mode at this gateway. Claude Desktop:
 *   - calls GET /v1/models to populate its picker (only Claude-recognized
 *     SLOT ids survive), and
 *   - sends POST /v1/messages with body.model = the slot id.
 *
 * This command starts the proxy via createProxyServer and PARKS it — no Claude
 * Code child spawn, no `finally` shutdown. The profiles app owns the lifecycle:
 * it spawns `serve` as a normal shell process (inheriting env/keys) and
 * SIGTERMs it on profile stop. We trap SIGINT/SIGTERM for a clean exit.
 *
 * Usage:
 *   claudish serve --port <n> --models <path-to-json>
 *
 * models.json shape (written by the profiles app):
 *   [
 *     { "slot": "claude-sonnet-4-6", "model": "grok-4.20-beta", "provider": "x-ai" },
 *     { "slot": "claude-opus-4-1",   "model": "gemini-3.1-pro-preview", "provider": null }
 *   ]
 *
 *   slot     = the Claude-recognized id Claude Desktop sends as body.model.
 *   model    = the real model id to route to.
 *   provider = a pinned provider slug (canonical BUILTIN_PROVIDERS name), or
 *              null / omitted = autoroute (let claudish's auto-chain pick).
 */

import { existsSync, readFileSync } from "node:fs";
import { setCredentialPromptRole } from "./auth/credentials/prompt-role.js";
import { wantsAnthropicApiBilling } from "./claude-runner.js";
import { realValueFor } from "./env-placeholder.js";
import { ensureEndpointsRegistered } from "./providers/endpoint-registration.js";
import { parseModelSpec } from "./providers/model-parser.js";
import { nativeRouteFor } from "./providers/native-route.js";
import { type SlotRoute, createProxyServer } from "./proxy-server.js";

interface ServeArgs {
  port?: number;
  modelsPath?: string;
}

interface ModelMapEntry {
  slot: string;
  model: string;
  provider?: string | null;
}

/**
 * Parse `serve`-specific flags from the raw argv tail. We do NOT reuse the
 * full CLI parser — serve has a tiny, fixed flag surface and must not pull in
 * Claude-Code-launch semantics.
 */
function parseServeArgs(args: string[]): ServeArgs {
  const out: ServeArgs = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port" || a === "-p") {
      const v = args[++i];
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0 || n > 65535) {
        throw new Error(`--port must be an integer 1-65535 (got ${v ?? "nothing"})`);
      }
      out.port = n;
    } else if (a === "--models" || a === "-m") {
      out.modelsPath = args[++i];
    }
  }
  return out;
}

/**
 * Load and validate the slot→real-model map from the JSON file. Returns both
 * the exact-id lookup (for routing) and the ordered list of slot ids (for the
 * /v1/models picker). Throws on malformed input so the operator sees the
 * problem immediately rather than getting an empty picker at runtime.
 */
function loadModelMap(path: string): { slotMap: Map<string, SlotRoute>; slotIds: string[] } {
  if (!existsSync(path)) {
    throw new Error(`--models file not found: ${path}`);
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    throw new Error(
      `failed to read --models file ${path}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `--models file is not valid JSON: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("--models file must contain a JSON array of { slot, model, provider } entries");
  }

  const slotMap = new Map<string, SlotRoute>();
  const slotIds: string[] = [];
  for (const [idx, entry] of (parsed as ModelMapEntry[]).entries()) {
    if (!entry || typeof entry.slot !== "string" || entry.slot.length === 0) {
      throw new Error(`--models entry #${idx} is missing a non-empty "slot" string`);
    }
    if (typeof entry.model !== "string" || entry.model.length === 0) {
      throw new Error(
        `--models entry #${idx} (slot "${entry.slot}") is missing a non-empty "model" string`
      );
    }
    if (entry.provider != null && typeof entry.provider !== "string") {
      throw new Error(`--models entry #${idx} (slot "${entry.slot}") has a non-string "provider"`);
    }
    if (slotMap.has(entry.slot)) {
      throw new Error(`--models has duplicate slot "${entry.slot}"`);
    }
    slotMap.set(entry.slot, { model: entry.model, provider: entry.provider ?? null });
    slotIds.push(entry.slot);
  }
  return { slotMap, slotIds };
}

/**
 * The startup refusal for slots that name the Claude subscription, or null.
 *
 * Claude Desktop sends no Claude Code login, so a slot on the subscription
 * could only ever answer 401. A bare Claude name (`"model": "claude-opus-5"`,
 * no provider) is served on the Anthropic API key only when the user opted
 * into API billing, as on the CLI; `claude@` (`"provider": "claude"`) names the
 * subscription itself, which no opt-in moves onto the key.
 */
export function serveSubscriptionSlotRefusal(
  slotMap: ReadonlyMap<string, SlotRoute>,
  apiBillingOptIn: boolean
): string | null {
  const refused: string[] = [];
  for (const [slot, route] of slotMap) {
    const spec = route.provider ? `${route.provider}@${route.model}` : route.model;
    if (nativeRouteFor(spec) === null) continue;
    const explicit = parseModelSpec(spec).isExplicitProvider;
    if (explicit || !apiBillingOptIn) refused.push(`"${slot}" → ${spec}`);
  }
  if (refused.length === 0) return null;
  return (
    `slot ${refused.join(", ")} names the Claude subscription, which needs Claude Code's own ` +
    `login, and Claude Desktop sends none. Use "provider": "anthropic" for the Claude API on ` +
    "your ANTHROPIC_API_KEY, or, for a bare Claude model name, opt into API billing " +
    "(CLAUDISH_ANTHROPIC_API_BILLING=1 or anthropicApiBilling: true in ~/.claudish/config.json)."
  );
}

export async function serveCommand(args: string[]): Promise<void> {
  // A gateway for Claude Desktop answers requests nobody at a terminal made:
  // it never opens a credential dialog (`auth/credentials/prompt-role.ts`).
  setCredentialPromptRole("never");
  let serveArgs: ServeArgs;
  try {
    serveArgs = parseServeArgs(args);
  } catch (e) {
    console.error(`[claudish serve] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  if (serveArgs.port == null) {
    console.error("[claudish serve] --port <n> is required");
    process.exit(1);
  }
  if (!serveArgs.modelsPath) {
    console.error("[claudish serve] --models <path> is required");
    process.exit(1);
  }

  // Before the slot map is read, so a slot naming a bundled endpoint resolves
  // against a provider list that already contains it. `createProxyServer` registers
  // too and this is idempotent — the call is here so the guarantee belongs to
  // `serve` rather than to an implementation detail of the proxy it happens to
  // start.
  ensureEndpointsRegistered();

  let slotMap: Map<string, SlotRoute>;
  let slotIds: string[];
  try {
    ({ slotMap, slotIds } = loadModelMap(serveArgs.modelsPath));
  } catch (e) {
    console.error(`[claudish serve] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  // A slot on the Claude subscription could only answer 401 to Claude Desktop.
  const apiBillingOptIn = wantsAnthropicApiBilling({});
  const subscriptionRefusal = serveSubscriptionSlotRefusal(slotMap, apiBillingOptIn);
  if (subscriptionRefusal) {
    console.error(`[claudish serve] ${subscriptionRefusal}`);
    process.exit(1);
  }

  // API keys come from the environment here. Config-only / op:// keys are now
  // resolved lazily by the credential authority when a model is actually routed
  // (the old loadStoredApiKeys env-push at module load was removed in the
  // async-credential-layer refactor), so this reads env-set keys directly.
  // serve bypasses parseArgs (which the normal CLI uses to fill these), so we
  // must read them explicitly or null-provider→OpenRouter slots would have no
  // credentials. A bare claude-* slot (native passthrough) is served on the
  // Anthropic API key only under the API-billing opt-in; without it the slot is
  // refused above.
  const openrouterApiKey = process.env.OPENROUTER_API_KEY;
  const anthropicApiKey = realValueFor("ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY);

  const proxy = await createProxyServer(
    serveArgs.port,
    openrouterApiKey,
    undefined, // no default --model: routing is driven entirely by the slot map
    false, // monitorMode off
    anthropicApiKey,
    undefined, // no tier modelMap — slot collisions (two "opus" slots) are why we use the exact slotMap instead
    {
      slotMap,
      servedSlotIds: slotIds,
      hostMode: "serve",
      apiBillingOptIn,
    }
  );

  console.log(`[claudish serve] listening on ${proxy.url}`);
  console.log(`[claudish serve] serving ${slotIds.length} slot(s): ${slotIds.join(", ")}`);
  console.log(`[claudish serve] GET ${proxy.url}/v1/models  ·  POST ${proxy.url}/v1/messages`);

  // Park the process. We deliberately do NOT register SIGINT/SIGTERM handlers
  // here: stats-buffer.ts already installs process-level handlers for both
  // that flush and `process.exit(0)`. Those are registered first (on import)
  // and run first, so any handler we added would be preempted — and there's
  // nothing to drain anyway (the proxy holds only in-memory caches, and
  // process.exit tears down the listening socket). The profiles app's
  // contract — terminate promptly and cleanly on SIGTERM — is therefore
  // already satisfied upstream. No `finally`/shutdown and no Claude spawn,
  // by design: the profiles app owns this process's lifecycle.
  await new Promise<void>(() => {});
}
