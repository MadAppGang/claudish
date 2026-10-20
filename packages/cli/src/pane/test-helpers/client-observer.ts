/**
 * Observe every MagmuxClient a pane creates, from the moment it exists.
 *
 * A pane's first gated send can leave from inside `attach()`, before `startPaneSession`
 * returns: wrapping `s.client` afterwards misses it. So `MagmuxClient.connect` and
 * `MagmuxClient.dial` are wrapped once, and each client they return is handed to the
 * observer registered for the socket root its `sockPath` sits under.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { MagmuxClient, type MagmuxReply } from "../magmux-client.js";

export type ObservedRequest = (
  message: Record<string, unknown>,
  timeout?: number
) => Promise<MagmuxReply>;
export interface ObservedClient {
  request: ObservedRequest;
  close(): void;
}

/** Socket root (with a trailing slash) -> the observer of the pane started under it. */
const routes = new Map<string, (client: ObservedClient) => void>();
let creationHooked = false;

/** Wrap the two client-creation statics once. With no matching route they pass through. */
function hookClientCreation(): void {
  if (creationHooked) return;
  creationHooked = true;
  const statics = MagmuxClient as unknown as Record<
    "connect" | "dial",
    (sockPath: string, ...rest: unknown[]) => Promise<ObservedClient>
  >;
  for (const name of ["connect", "dial"] as const) {
    const real = statics[name].bind(MagmuxClient);
    statics[name] = async (sockPath, ...rest) => {
      const client = await real(sockPath, ...rest);
      for (const [root, observe] of routes) if (sockPath.startsWith(root)) observe(client);
      return client;
    };
  }
}

/** The raw root and its realpath form (`/tmp` is `/private/tmp` on macOS); the root may not exist yet. */
function routeKeys(sockRoot: string): string[] {
  const keys = new Set([`${sockRoot}/`]);
  try {
    keys.add(`${join(realpathSync(dirname(sockRoot)), basename(sockRoot))}/`);
  } catch {
    // parent missing: only the raw key can match
  }
  return [...keys];
}

/**
 * Hand every client created under `sockRoot` to `observe`. Register BEFORE starting the
 * pane. Returns the unregister function; calling it twice is harmless.
 */
export function observeClients(
  sockRoot: string,
  observe: (client: ObservedClient) => void
): () => void {
  hookClientCreation();
  const keys = routeKeys(sockRoot);
  for (const key of keys) routes.set(key, observe);
  return () => {
    for (const key of keys) if (routes.get(key) === observe) routes.delete(key);
  };
}
