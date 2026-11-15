/**
 * Compaction's launch-wide state, built once at startup before the proxy
 * binds its port.
 *
 * The key is the user's Anthropic API key, resolved with
 * `credentials.resolveForUse("anthropic")` (environment, config, Keychain,
 * then 1Password), which never writes `process.env`. It is held only in this
 * process's memory, registered on a launch-wide signing lease so every log
 * sink and client body redacts it by value, and never put into Claude Code's
 * environment. Claude Code's own credentials and the Claude login are never
 * read.
 *
 * Any reason compaction cannot run (no key, a key that could not be read, a
 * model that does not resolve) turns it off for the launch with one warning;
 * the launch itself goes ahead.
 */

import { log, logStderr } from "../logger.js";
import { acquireSigningLease } from "../redact.js";
import type { StatsEvent } from "../stats-otlp.js";
import { type CompactionSettings, resolveCompactionModel } from "./config.js";
import { CompactionClient } from "./haiku-client.js";
import { CompactionStore, compactionRoot, purgeExpiredSessions } from "./store.js";
import { ToolOutputCompactor } from "./tool-outputs.js";

/** The claudish provider whose key compaction signs with: the Claude API. */
export const COMPACTION_KEY_PROVIDER = "anthropic";

/** Everything the proxy needs to compact requests. */
export interface CompactionRuntime {
  settings: CompactionSettings;
  /** The resolved Anthropic model id. */
  model: string;
  client: CompactionClient;
  store: CompactionStore;
  toolOutputs: ToolOutputCompactor;
}

/** The slice of the credential authority startup uses. */
export interface CompactionCredentialSource {
  resolveForUse(
    name: string,
    opts?: { allowOpPrompt?: boolean }
  ): Promise<
    | { state: "present"; key: string; source: string }
    | { state: "absent"; searched: string[] }
    | { state: "failed"; reason: string }
  >;
}

export interface PrepareCompactionOptions {
  settings: CompactionSettings;
  /** Allow a 1Password prompt while resolving the key (an interactive launch). */
  allowOpPrompt?: boolean;
  /** Session ids whose folders the startup purge keeps (a resumed session). */
  keepSessionIds?: Iterable<string>;
  /** Defaults to the process credential authority. */
  credentials?: CompactionCredentialSource;
  /** Defaults to `~/.claudish/compaction`. */
  storeRoot?: string;
  /** Where the one warning goes. Defaults to `logStderr`. */
  warn?: (message: string) => void;
  /** Test seams for the client. */
  fetchImpl?: typeof fetch;
  record?: (event: Partial<StatsEvent>) => void;
}

/**
 * Build the runtime, or return null with one warning when compaction cannot
 * run. Returns null without a warning when `settings.enabled` is false.
 */
export async function prepareCompaction(
  opts: PrepareCompactionOptions
): Promise<CompactionRuntime | null> {
  const { settings } = opts;
  if (!settings.enabled) return null;
  const warn = opts.warn ?? logStderr;

  const model = resolveCompactionModel(settings.model);
  if (!model.ok) {
    warn(`[compaction] off for this session: compaction.model does not resolve: ${model.reason}`);
    return null;
  }

  const credentials =
    opts.credentials ?? (await import("../auth/credentials/authority.js")).credentials;
  let resolution: Awaited<ReturnType<CompactionCredentialSource["resolveForUse"]>>;
  try {
    resolution = await credentials.resolveForUse(COMPACTION_KEY_PROVIDER, {
      allowOpPrompt: opts.allowOpPrompt === true,
    });
  } catch (err) {
    resolution = { state: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
  if (resolution.state === "absent") {
    warn(
      `[compaction] off for this session: no Anthropic API key (looked in ${resolution.searched.join(", ")}). Store one with claudish keychain set ANTHROPIC_API_KEY, or export it.`
    );
    return null;
  }
  if (resolution.state === "failed") {
    warn(
      `[compaction] off for this session: the Anthropic API key could not be read: ${resolution.reason}`
    );
    return null;
  }

  // Held for the life of the launch: every compaction call signs with it.
  const lease = acquireSigningLease();
  lease.add([resolution.key]);

  const store = new CompactionStore(opts.storeRoot ?? compactionRoot());
  const purged = purgeExpiredSessions(store.root, { keep: opts.keepSessionIds });
  if (purged.length > 0) {
    log(`[compaction] removed ${purged.length} session folder(s) unused for 7 days`);
  }

  const client = new CompactionClient({
    apiKey: resolution.key,
    model: model.id,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.record ? { record: opts.record } : {}),
    warn,
  });
  log(
    `[compaction] on: model ${model.id} (from "${settings.model}"), key from ${resolution.source}, store ${store.root}`
  );
  return {
    settings,
    model: model.id,
    client,
    store,
    toolOutputs: new ToolOutputCompactor({ store, client, settings: settings.toolOutputs }),
  };
}
