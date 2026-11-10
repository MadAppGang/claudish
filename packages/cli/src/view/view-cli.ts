/**
 * `claudish view`: read-only access to the sessions of every claudish MCP server on this machine.
 * It discovers servers by listing `<root>/endpoints/`, so it needs no knowledge of which Claude
 * Code started them.
 */

import { sockRootFor } from "../pane/pane-launch.js";
import { readProcessTableAsync } from "../pane/process-identity.js";
import type { ViewItem, ViewListResult } from "../pane/view-contract.js";
import { endpointOwnerAlive, endpointPathOf, listEndpoints } from "./endpoints.js";
import { ViewClient } from "./view-client.js";

const USAGE = "usage: claudish view --list [--json]\n";

export interface ViewListing {
  servers: Array<{ endpoint: string; pid: number; version: string }>;
  items: ViewItem[];
}

/** Every live server's items. A server that refuses or does not answer is left out. */
export async function collectListing(root: string = sockRootFor()): Promise<ViewListing> {
  const table = await readProcessTableAsync();
  const names = listEndpoints(root).filter((n) => endpointOwnerAlive(n, table));
  const results = await Promise.allSettled(names.map((n) => listOne(root, n)));
  const listing: ViewListing = { servers: [], items: [] };
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    listing.servers.push(r.value.server);
    listing.items.push(...r.value.items);
  }
  return listing;
}

async function listOne(
  root: string,
  name: string
): Promise<{ server: ViewListing["servers"][number]; items: ViewItem[] }> {
  const client = await ViewClient.connect(endpointPathOf(root, name), {
    hello: { name: "claudish view --list", kind: "viewer" },
  });
  try {
    const { items } = await client.request<ViewListResult>("list");
    const hello = client.helloResult;
    return {
      server: { endpoint: name, pid: hello?.server.pid ?? 0, version: hello?.server.version ?? "" },
      items,
    };
  } finally {
    client.close();
  }
}

function stateOf(item: ViewItem): string {
  return item.kind === "replay" ? (item.final ? "FINISHED" : "REPLAY") : item.state;
}

function formatListing(listing: ViewListing): string {
  if (listing.items.length === 0)
    return listing.servers.length === 0
      ? "no claudish MCP server is running\n"
      : "no running sessions\n";
  const rows = listing.items.map((item) => [
    item.target,
    stateOf(item),
    item.model ?? "",
    item.view ? item.view.label : "",
  ]);
  const header = ["TARGET", "STATE", "MODEL", "VIEWED IN"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const line = (cols: string[]): string =>
    `${cols
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd()}\n`;
  return line(header) + rows.map(line).join("");
}

export async function viewCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const known = new Set(["--list", "--json"]);
  if (!args.includes("--list") || args.some((a) => !known.has(a))) {
    process.stderr.write(USAGE);
    return 2;
  }
  const listing = await collectListing();
  process.stdout.write(
    args.includes("--json") ? `${JSON.stringify(listing)}\n` : formatListing(listing)
  );
  return 0;
}
