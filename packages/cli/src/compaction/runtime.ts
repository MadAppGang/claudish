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

import {
  type CredentialPromptRole,
  credentialPromptRole,
} from "../auth/credentials/prompt-role.js";
import { log, logStderr } from "../logger.js";
import { acquireSigningLease } from "../redact.js";
import type { StatsEvent } from "../stats-otlp.js";
import { type CompactionSettings, resolveCompactionModel } from "./config.js";
import { CompactionClient } from "./haiku-client.js";
import { HistoryCompactor } from "./history.js";
import { CompactionStore, compactionRoot, purgeExpiredSessions } from "./store.js";
import { ToolOutputCompactor } from "./tool-outputs.js";

/**
 * How long startup waits for the cloud models catalog when a tier alias finds
 * no id in it (a first launch has no catalog file yet).
 */
export const COMPACTION_CATALOG_WAIT_MS = 5000;

/** The claudish provider whose key compaction signs with: the Claude API. */
export const COMPACTION_KEY_PROVIDER = "anthropic";

/**
 * Whether resolving the compaction key may open a 1Password prompt: only on
 * an interactive launch with a person at the terminal. A pane child started
 * by `team` or `create_session` runs with `-i` on a real PTY, so the
 * interactive flag and a TTY test both say yes there, and a prompt would wait
 * on a screen nobody watches.
 */
export function compactionMayPromptForKey(
  role: CredentialPromptRole = credentialPromptRole()
): boolean {
  return role === "interactive-launch";
}

/** Everything the proxy needs to compact requests. */
export interface CompactionRuntime {
  settings: CompactionSettings;
  /** The resolved Anthropic model id. */
  model: string;
  client: CompactionClient;
  store: CompactionStore;
  toolOutputs: ToolOutputCompactor;
  history: HistoryCompactor;
  /**
   * Abort the calls in flight (background summaries included), wait for
   * them, and release the key's signing lease. Called by the proxy's
   * `shutdown()`. Idempotent.
   */
  shutdown?: () => Promise<void>;
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
  /**
   * Wait for the cloud models catalog to be ready. Defaults to
   * `ensureCatalogReady(COMPACTION_CATALOG_WAIT_MS)`, which reads the disk
   * catalog for readiness and starts the refresh when none exists.
   */
  waitForCatalog?: () => Promise<void>;
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

  let model = resolveCompactionModel(settings.model);
  if (!model.ok && model.unresolvedAlias) {
    // A tier alias resolves through the catalog, and on a first launch no
    // catalog has been fetched yet: wait for it as other startup paths do.
    const wait =
      opts.waitForCatalog ??
      (async () => {
        const { ensureCatalogReady } = await import("../providers/catalog-client.js");
        await ensureCatalogReady(COMPACTION_CATALOG_WAIT_MS);
      });
    try {
      await wait();
    } catch (err) {
      log(
        `[compaction] waiting for the catalog failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    model = resolveCompactionModel(settings.model);
  }
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
  const runtime: CompactionRuntime = {
    settings,
    model: model.id,
    client,
    store,
    toolOutputs: new ToolOutputCompactor({ store, client, settings: settings.toolOutputs }),
    history: new HistoryCompactor({ store, client, settings: settings.history }),
  };
  runtime.shutdown = async () => {
    runtime.client.close();
    try {
      await runtime.history.whenIdle();
    } finally {
      // Released only once no call that signed with the key can still log.
      lease.release();
    }
  };
  return runtime;
}
