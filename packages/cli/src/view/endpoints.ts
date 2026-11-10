/**
 * Where a claudish MCP server listens for local view clients: one socket per server at
 * `<root>/endpoints/c<pid>-<start36>.sock`, owner-only, found by listing the directory.
 *
 * A name carries the owner's pid and start, so a stale file left by a killed server is told apart
 * from a live one without a dial. A refused connection never unlinks anything: only the sweep does,
 * and only for an owner the process table proves gone.
 */

import { chmodSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { join } from "node:path";
import { log } from "../logger.js";
import { OWNER_START36, ensurePrivateSubdir, ensureSockRoot } from "../pane/pane-launch.js";
import { type ProcessTable, pidMayBeAlive, startedAt } from "../pane/process-identity.js";

/** `sun_path` holds 104 bytes on macOS, the shorter of the platforms claudish runs on. */
export const MAX_SOCKET_PATH_BYTES = 104;

const ENDPOINT_NAME_RE = /^c(\d+)-([0-9a-z]+)\.sock$/;

export const ENDPOINTS_DIR = "endpoints";

export function endpointNameOf(pid: number = process.pid, start36: string = OWNER_START36): string {
  return `c${pid}-${start36}.sock`;
}

export function endpointsDirOf(root: string): string {
  return join(root, ENDPOINTS_DIR);
}

export function endpointPathOf(root: string, name: string): string {
  return join(endpointsDirOf(root), name);
}

export function ownerOfEndpointName(name: string): { pid: number; startMs: number } | null {
  const m = ENDPOINT_NAME_RE.exec(name);
  if (!m) return null;
  const startMs = Number.parseInt(m[2] ?? "", 36);
  return Number.isSafeInteger(startMs) ? { pid: Number(m[1]), startMs } : null;
}

/**
 * Whether the server that bound `name` may still run. Without a trusted table only `kill(pid, 0)`
 * can answer, and it cannot tell a reused pid apart.
 */
export function endpointOwnerAlive(name: string, table: ProcessTable): boolean {
  const owner = ownerOfEndpointName(name);
  if (!owner) return false;
  if (!table) return pidMayBeAlive(owner.pid);
  const row = table.find((r) => r.pid === owner.pid);
  return row !== undefined && startedAt(row, owner.startMs);
}

/** Every file in `<root>/endpoints/` named like an endpoint; other names are ignored. */
export function listEndpoints(root: string): string[] {
  try {
    return readdirSync(endpointsDirOf(root)).filter((n) => ownerOfEndpointName(n) !== null);
  } catch {
    return [];
  }
}

export interface BoundEndpoint {
  name: string;
  path: string;
  server: Server;
  /** Stop listening and remove the socket, then the directory if nothing else is in it. */
  close(): void;
}

function removeEndpointsDirIfEmpty(root: string): void {
  try {
    rmdirSync(endpointsDirOf(root));
  } catch {
    // another server's endpoint keeps it, or it is already gone
  }
}

function listenOn(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error): void => reject(e);
    server.once("error", onError);
    server.listen(path, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

/**
 * Bind this server's endpoint under a verified 0700 root. A failure here switches the transport
 * off for this process: one log line, null, and sessions are unaffected.
 */
export async function bindEndpoint(
  root: string,
  onConnection: (socket: Socket) => void
): Promise<BoundEndpoint | null> {
  const name = endpointNameOf();
  const path = endpointPathOf(root, name);
  if (Buffer.byteLength(path) >= MAX_SOCKET_PATH_BYTES) {
    log(`[view] transport off: endpoint path is ${Buffer.byteLength(path)} bytes`);
    return null;
  }
  const server = createServer(onConnection);
  try {
    await listenPrivately(server, root, path);
    chmodSync(path, 0o600);
  } catch (e) {
    log(`[view] transport off: ${e instanceof Error ? e.message : String(e)}`);
    server.close();
    return null;
  }
  return {
    name,
    path,
    server,
    close: () => {
      try {
        server.close();
      } catch {
        // already closed
      }
      rmSync(path, { force: true });
      removeEndpointsDirIfEmpty(root);
    },
  };
}

/** A concurrent shutdown can remove the empty directory between the check and the bind. */
async function listenPrivately(server: Server, root: string, path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    ensureSockRoot(root);
    ensurePrivateSubdir(root, ENDPOINTS_DIR);
    rmSync(path, { force: true });
    try {
      await listenOn(server, path);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" || attempt > 0) throw e;
    }
  }
}

/** Endpoint files whose owner the table proves gone. Returns the names removed. */
export function sweepEndpoints(root: string, table: NonNullable<ProcessTable>): string[] {
  const removed: string[] = [];
  for (const name of listEndpoints(root)) {
    if (endpointOwnerAlive(name, table)) continue;
    rmSync(endpointPathOf(root, name), { force: true });
    removed.push(name);
  }
  return removed;
}
