/**
 * Hostname binding (fork extension).
 *
 * Configures the proxy to bind to a specific hostname (default: 127.0.0.1).
 * For Docker deployments, use "0.0.0.0" to accept connections from all interfaces.
 * Tracks direct remote addresses via WeakMap since Hono middleware can't access sockets.
 */

export interface HostnameConfig {
  hostname: string;
  remoteAddrMap: WeakMap<Request, string>;
}

export function createHostnameConfig(hostname?: string): HostnameConfig {
  return {
    hostname: hostname ?? "127.0.0.1",
    remoteAddrMap: new WeakMap<Request, string>(),
  };
}
