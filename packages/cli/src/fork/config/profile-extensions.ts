/**
 * Profile config extension (fork extension).
 *
 * Adds proxyKey to the ClaudishProfileConfig type.
 * This is the fork-specific schema extension — profile-config.ts re-exports it.
 */

/** Proxy authentication key — clients must send x-proxy-key matching this value */
export type ProxyKey = string;
