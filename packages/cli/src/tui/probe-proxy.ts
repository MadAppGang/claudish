/**
 * Shared lazy probe-proxy for the TUI's test buttons.
 *
 * Both the Providers tab (`t` / `T`) and the Routing tab (`p`) need to send
 * a real "ping" request through claudish's full proxy stack to verify that a
 * provider's credentials work. The proxy resolves env vars, config keys, and
 * OAuth tokens identically to runtime — so a probe result is a true
 * "will this work when I `claudish --model X`?" answer.
 *
 * The proxy is started on demand (first test press) and cached for the rest
 * of the TUI session. `shutdownProbeProxy()` should be called by the renderer
 * cleanup on exit so the port doesn't leak across re-entries.
 *
 * Lifecycle is intentionally non-React: the proxy lives outside the
 * component tree because it must survive renderer.destroy() / restartConfigTui
 * cycles (e.g. when the user logs in via OAuth, the wrapper destroys the
 * renderer and re-creates it — we don't want to spin up a new proxy each
 * time). Callers reset on TUI process exit by importing and invoking
 * `shutdownProbeProxy()` directly.
 */

interface LiveProxy {
  url: string;
  shutdown: () => Promise<void>;
  invalidateHandlerCache: (providerSlug?: string) => void;
}

let probeProxy: LiveProxy | null = null;
let probeProxyStarting: Promise<string> | null = null;

/**
 * Return the proxy URL, starting the proxy on first call. Subsequent calls
 * (even concurrent) reuse the cached promise / URL.
 *
 * Throws if proxy startup fails — callers should catch and surface a status
 * message instead of crashing the TUI.
 */
export async function ensureProbeProxy(): Promise<string> {
  if (probeProxy) return probeProxy.url;
  if (probeProxyStarting) return probeProxyStarting;

  probeProxyStarting = (async () => {
    const { findAvailablePort } = await import("../port-manager.js");
    const { createProxyServer } = await import("../proxy-server.js");
    const port = await findAvailablePort(47600);
    const proxy = await createProxyServer(
      port,
      process.env.OPENROUTER_API_KEY,
      undefined,
      false,
      process.env.ANTHROPIC_API_KEY,
      undefined,
      // Hooks never see --probe traffic.
      { quiet: true, hooks: false }
    );
    probeProxy = proxy;
    return proxy.url;
  })().catch((err) => {
    // Reset starting promise so a later call can retry.
    probeProxyStarting = null;
    throw err;
  });

  return probeProxyStarting;
}

/**
 * Shut down the proxy if it was started. Safe to call multiple times or when
 * the proxy was never created.
 */
export async function shutdownProbeProxy(): Promise<void> {
  const p = probeProxy;
  probeProxy = null;
  probeProxyStarting = null;
  if (p) {
    try {
      await p.shutdown();
    } catch {
      /* ignore */
    }
  }
}

/** True when the probe proxy is already up (no startup latency on next call). */
export function isProbeProxyReady(): boolean {
  return probeProxy !== null;
}

/**
 * Drop the proxy's per-provider handler cache so the next probe rebuilds
 * the transport from current config. No-op if the proxy hasn't been started
 * yet — there's nothing to invalidate.
 */
export function invalidateProbeProxyHandlers(providerSlug?: string): void {
  probeProxy?.invalidateHandlerCache(providerSlug);
}
