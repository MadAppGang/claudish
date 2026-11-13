/**
 * Writes `src/providers/bundled-recommended-list.json` from one generation of the
 * models-index backend. Run during a version bump, never as part of a build: a
 * build must not need the network.
 *
 * Any failure writes nothing and exits 1. The file on disk therefore always came
 * whole from one generation, and a broken read cannot ship as an empty list.
 * A warning (a gap the list carries as published, such as a recommended model
 * with effort levels and no effort row) is printed to stderr; the list is still
 * written and the exit code is 0.
 *
 *   bun run scripts/generate-bundled-list.ts [--base-url URL] [--allow-nonproduction]
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { writeFileAtomic } from "../src/fs-atomic.js";
import { readAllModelsCache } from "../src/providers/all-models-cache.js";
import {
  type BundledListSummary,
  buildBundledListWithSummary,
  serializeBundledList,
} from "../src/providers/bundled-list-build.js";
import {
  type FetchFailure,
  fetchAllModelPages,
  fetchEnvelope,
  fetchRouteRegistry,
  fetchSubscriptionPlans,
} from "../src/providers/catalog-client.js";
import { DEFAULT_HOST } from "../src/providers/catalog-endpoints.js";

const OUTPUT_PATH = join(import.meta.dir, "../src/providers/bundled-recommended-list.json");
const REQUEST_TIMEOUT_MS = 30_000;
const SLIM_PAGE_LIMIT = 2000;

function describeFailure(read: string, failure: FetchFailure | { reason: string }): string {
  const contract =
    failure.reason === "incompatible" && "serverContractVersion" in failure
      ? ` (server contract ${failure.serverContractVersion ?? "unknown"})`
      : "";
  return `${read}: ${failure.reason}${contract}`;
}

/** The base URL to read from. A host other than production must be asked for explicitly. */
export function resolveBaseUrl(requested: string | undefined, allowNonProduction: boolean): string {
  const baseUrl = (requested ?? DEFAULT_HOST).replace(/\/+$/, "");
  if (baseUrl !== DEFAULT_HOST && !allowNonProduction) {
    throw new Error(`--base-url ${baseUrl} is not ${DEFAULT_HOST}; add --allow-nonproduction`);
  }
  return baseUrl;
}

async function readInputs(baseUrl: string) {
  const modelsUrl = `${baseUrl}/queryModels`;
  const recommended = await fetchEnvelope<{ recommendations?: unknown }>(
    `${modelsUrl}?catalog=recommended`,
    REQUEST_TIMEOUT_MS
  );
  if (!recommended.ok) throw new Error(describeFailure("recommended list", recommended));
  const { generationId, generatedAt, contractVersion, data } = recommended.envelope;

  const routes = await fetchRouteRegistry(REQUEST_TIMEOUT_MS, generationId, modelsUrl);
  if (!routes.ok) throw new Error(describeFailure("route registry", routes));

  const plans = await fetchSubscriptionPlans(
    REQUEST_TIMEOUT_MS,
    generationId,
    `${baseUrl}/queryPlans`
  );
  if (!plans.ok) throw new Error(describeFailure("subscription plans", plans));

  const slim = await fetchAllModelPages(
    `${modelsUrl}?catalog=slim`,
    SLIM_PAGE_LIMIT,
    REQUEST_TIMEOUT_MS,
    generationId
  );
  if (!slim.ok) throw new Error(describeFailure("slim models", slim));

  return {
    source: baseUrl,
    fetchedAt: new Date().toISOString(),
    recommended: {
      contractVersion,
      generationId,
      generatedAt,
      recommendations: data.recommendations,
    },
    routes: { generationId, registry: routes.registry },
    plans: { generationId, plans: plans.plans },
    slim: { generationId: slim.generationId, models: slim.entries },
  };
}

/** Re-reads the text through the runtime cache reader, so a list it would refuse is never shipped. */
function assertReadableByRuntime(text: string, summary: BundledListSummary): void {
  const directory = mkdtempSync(join(tmpdir(), "claudish-bundled-list-"));
  try {
    const path = join(directory, "bundled-recommended-list.json");
    writeFileSync(path, text, "utf-8");
    const cache = readAllModelsCache(path);
    if (!cache) throw new Error("self-check: the runtime cache reader refused the list");
    if (summary.entries === 0 || cache.entries.length === 0) {
      throw new Error("self-check: the list has no model entry");
    }
    if (cache.entries.length !== summary.entries) {
      throw new Error(
        `self-check: the reader returned ${cache.entries.length} entries, expected ${summary.entries}`
      );
    }
    for (const entry of cache.entries) {
      const held = (entry.aggregators?.length ?? 0) + (entry.optInConnections?.length ?? 0);
      if (held !== summary.keptConnectionsPerEntry[entry.modelId]) {
        throw new Error(
          `self-check: ${entry.modelId} has ${held} connection(s) after the read, expected ${summary.keptConnectionsPerEntry[entry.modelId]}`
        );
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function formatCounts(counts: Record<string, number>): string {
  const pairs = Object.entries(counts).map(([key, count]) => `${key}=${count}`);
  return pairs.length > 0 ? pairs.join(" ") : "none";
}

function printSummary(summary: BundledListSummary, byteSize: number): void {
  const lines = [
    `generation ${summary.generationId}`,
    `entries ${summary.entries}`,
    `recommendation rows per tier: ${formatCounts(summary.rowsPerTier)}`,
    `skipped tiers: ${formatCounts(summary.skippedTiers)}`,
    `kept connections by profile kind: ${formatCounts(summary.keptConnectionsByKind)}`,
    `dropped connections by profile kind: ${formatCounts(summary.droppedConnectionsByKind)}`,
    `unmapped connections: ${summary.unmappedConnections}`,
    `effort rows ${summary.effortRows}, outside the list ${summary.effortRowsOutsideBundle}`,
    `recommended with no effort row: ${summary.modelsWithNoEffortRow.join(", ") || "none"}`,
    `dropped sendableOn entries: ${summary.droppedSendableOn}`,
    `bytes ${byteSize}`,
  ];
  for (const line of lines) console.log(`[generate-bundled-list] ${line}`);
  for (const warning of summary.warnings) {
    console.error(`[generate-bundled-list] WARNING: ${warning}`);
  }
}

/** Reads, builds, self-checks and writes the list; throws with nothing written on any failure. */
export async function generateBundledList(options: {
  baseUrl: string;
  outputPath: string;
}): Promise<{ summary: BundledListSummary; byteSize: number }> {
  const inputs = await readInputs(options.baseUrl);
  const { file, summary } = buildBundledListWithSummary(inputs);
  const text = serializeBundledList(file);
  assertReadableByRuntime(text, summary);
  writeFileAtomic(options.outputPath, text);
  return { summary, byteSize: Buffer.byteLength(text, "utf-8") };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "base-url": { type: "string" },
      "allow-nonproduction": { type: "boolean", default: false },
    },
  });
  const baseUrl = resolveBaseUrl(values["base-url"], values["allow-nonproduction"] === true);
  const { summary, byteSize } = await generateBundledList({ baseUrl, outputPath: OUTPUT_PATH });
  printSummary(summary, byteSize);
  console.log(`[generate-bundled-list] wrote ${OUTPUT_PATH}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[generate-bundled-list] FAILED, nothing written: ${message}`);
    process.exit(1);
  });
}
