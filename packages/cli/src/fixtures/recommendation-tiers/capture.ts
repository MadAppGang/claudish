/**
 * Records the recommendation-tier fixtures from REAL backend output. Dev-only:
 * nothing in the shipped CLI imports this file.
 *
 *   bun packages/cli/src/fixtures/recommendation-tiers/capture.ts live
 *   bun packages/cli/src/fixtures/recommendation-tiers/capture.ts dryrun <dry-run-dir>
 *
 * The script only SELECTS whole records. No field is typed, edited or
 * recombined: every kept record is the backend's record, re-serialised as JSON
 * (value-identical). A fixture the backend cannot supply is not written; the
 * script aborts instead.
 *
 * `live` writes `live/`: one generation G of the production API.
 *   recommended.json  the whole `?catalog=recommended` envelope
 *   slim.json         { generationId, models }: the `?catalog=slim` records (all pages,
 *                     pinned to G) whose modelId is a recommended modelId
 *   plans.json        { generationId, plans }: the `queryPlans` records whose id is a
 *                     planId of a recommendation entry; [] (no request) when none has one
 *   top100.json       { generationId, models }: the `?catalog=top100` records (pinned to G)
 *                     whose modelId is a recommended modelId
 *   meta.json         { generationId, capturedAt, requests }
 * Aborts without writing when a response's generation differs from G (a publish
 * landed mid-capture: re-run), or when CLAUDISH_CATALOG_URL / CLAUDISH_PLANS_URL is
 * set (the fixtures must come from the production endpoints).
 *
 * `dryrun <dir>` writes `dryrun-subscription/` from a models-index dry-run output
 * directory (local files only, no network):
 *   recommendations.json  generation.json's `recommendations` object
 *   models.json           { generationId, models }: generation.json's `models` records
 *                         whose modelId is a modelId of an entry
 *   plans.json            { generationId, plans }: generation.json's `plans` records
 *                         whose id is a planId of an entry
 *   meta.json             { generationId, generatedAt, source, recommendationsSha256 }
 * Aborts unless generation.json's `recommendations.entries` deep-equal
 * recommendations.json's `candidate.entries`, and every referenced modelId and
 * planId is found.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildCatalogPageUrl } from "../../providers/catalog-client.js";
import { CATALOG_V3_ACCEPT, parseCatalogV3Envelope } from "../../providers/catalog-v3.js";

const QUERY_MODELS = "https://us-central1-claudish-6da10.cloudfunctions.net/queryModels";
const QUERY_PLANS = "https://us-central1-claudish-6da10.cloudfunctions.net/queryPlans";
const MAX_PAGES = 40;

type JsonRecord = Record<string, unknown>;

function fail(message: string): never {
  console.error(`capture: ${message}`);
  process.exit(1);
}

function writeJson(dir: string, file: string, value: unknown): void {
  writeFileSync(join(dir, file), `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function entriesOf(recommendations: unknown): JsonRecord[] {
  const entries = (recommendations as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) fail("recommendations.entries is not an array");
  return entries as JsonRecord[];
}

function referencedIds(entries: JsonRecord[]): { modelIds: Set<string>; planIds: Set<string> } {
  const modelIds = new Set<string>();
  const planIds = new Set<string>();
  for (const entry of entries) {
    if (typeof entry?.modelId === "string") modelIds.add(entry.modelId);
    if (typeof entry?.planId === "string") planIds.add(entry.planId);
  }
  return { modelIds, planIds };
}

// ─── live ────────────────────────────────────────────────────────────────────

async function getEnvelope(url: string, requests: string[]) {
  requests.push(url);
  const response = await fetch(url, { headers: { Accept: CATALOG_V3_ACCEPT } });
  if (!response.ok) fail(`HTTP ${response.status} from ${url}`);
  const raw = await response.json();
  const envelope = parseCatalogV3Envelope<JsonRecord>(raw);
  if (!envelope) fail(`not a v3 envelope: ${url}`);
  return { raw, envelope };
}

/** Every record of one cursor-paged read pinned to `generationId`. */
async function getAllPages(
  base: string,
  limit: number,
  key: "models" | "plans",
  generationId: string,
  requests: string[]
): Promise<JsonRecord[]> {
  const records: JsonRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = buildCatalogPageUrl(base, cursor, limit, generationId);
    const { envelope } = await getEnvelope(url, requests);
    if (envelope.generationId !== generationId) {
      fail(`generation changed mid-capture (${envelope.generationId} != ${generationId}); re-run`);
    }
    const batch = envelope.data[key];
    if (!Array.isArray(batch)) fail(`${url}: data.${key} is not an array`);
    records.push(...(batch as JsonRecord[]));
    const next = envelope.data.nextCursor;
    if (typeof next !== "string" || next.length === 0) return records;
    cursor = next;
  }
  fail(`${base}: more than ${MAX_PAGES} pages`);
}

async function captureLive(outDir: string): Promise<void> {
  if (process.env.CLAUDISH_CATALOG_URL || process.env.CLAUDISH_PLANS_URL) {
    fail("CLAUDISH_CATALOG_URL / CLAUDISH_PLANS_URL is set; unset it to capture production");
  }
  const requests: string[] = [];
  const capturedAt = new Date().toISOString();

  const recommended = await getEnvelope(`${QUERY_MODELS}?catalog=recommended`, requests);
  const generationId = recommended.envelope.generationId;
  const recommendations = recommended.envelope.data.recommendations as JsonRecord | undefined;
  if (!recommendations) fail("?catalog=recommended has no data.recommendations");
  if (recommendations.generationId !== generationId) {
    fail("data.recommendations.generationId differs from the envelope's");
  }
  const { modelIds, planIds } = referencedIds(entriesOf(recommendations));

  const slimAll = await getAllPages(
    `${QUERY_MODELS}?catalog=slim`,
    1000,
    "models",
    generationId,
    requests
  );
  const slim = slimAll.filter((record) => modelIds.has(record.modelId as string));

  let plans: JsonRecord[] = [];
  if (planIds.size > 0) {
    const plansAll = await getAllPages(QUERY_PLANS, 100, "plans", generationId, requests);
    plans = plansAll.filter((record) => planIds.has(record.id as string));
    for (const planId of planIds) {
      if (!plans.some((plan) => plan.id === planId)) fail(`planId ${planId} not in queryPlans`);
    }
  }

  const top100Url = new URL(`${QUERY_MODELS}?catalog=top100`);
  top100Url.searchParams.set("generationId", generationId);
  const top100 = await getEnvelope(top100Url.toString(), requests);
  if (top100.envelope.generationId !== generationId) {
    fail(`generation changed mid-capture (top100 ${top100.envelope.generationId}); re-run`);
  }
  const top100Models = top100.envelope.data.models;
  if (!Array.isArray(top100Models)) fail("?catalog=top100 has no data.models array");
  const top100Kept = (top100Models as JsonRecord[]).filter((record) =>
    modelIds.has(record.modelId as string)
  );

  mkdirSync(outDir, { recursive: true });
  writeJson(outDir, "recommended.json", recommended.raw);
  writeJson(outDir, "slim.json", { generationId, models: slim });
  writeJson(outDir, "plans.json", { generationId, plans });
  writeJson(outDir, "top100.json", { generationId, models: top100Kept });
  writeJson(outDir, "meta.json", { generationId, capturedAt, requests });
  console.log(
    `live: generation ${generationId}; ${modelIds.size} recommended ids, ${slim.length} slim records, ${plans.length} plans, ${top100Kept.length} top100 records → ${outDir}`
  );
}

// ─── dryrun ──────────────────────────────────────────────────────────────────

function captureDryRun(sourceDir: string, outDir: string): void {
  const generation = JSON.parse(readFileSync(join(sourceDir, "generation.json"), "utf-8"));
  const candidateFile = JSON.parse(readFileSync(join(sourceDir, "recommendations.json"), "utf-8"));
  const recommendations = generation.recommendations as JsonRecord | undefined;
  if (!recommendations) fail("generation.json has no recommendations");
  const entries = entriesOf(recommendations);
  if (!Bun.deepEquals(entries, candidateFile?.candidate?.entries, true)) {
    fail("generation.json recommendations.entries != recommendations.json candidate.entries");
  }
  if (recommendations.generationId !== generation.generationId) {
    fail("recommendations.generationId differs from generation.json's generationId");
  }
  const { modelIds, planIds } = referencedIds(entries);
  const models = (generation.models as JsonRecord[]).filter((record) =>
    modelIds.has(record.modelId as string)
  );
  const plans = (generation.plans as JsonRecord[]).filter((record) =>
    planIds.has(record.id as string)
  );
  for (const modelId of modelIds) {
    if (!models.some((model) => model.modelId === modelId)) fail(`modelId ${modelId} not found`);
  }
  for (const planId of planIds) {
    if (!plans.some((plan) => plan.id === planId)) fail(`planId ${planId} not found`);
  }

  mkdirSync(outDir, { recursive: true });
  writeJson(outDir, "recommendations.json", recommendations);
  writeJson(outDir, "models.json", { generationId: generation.generationId, models });
  writeJson(outDir, "plans.json", { generationId: generation.generationId, plans });
  writeJson(outDir, "meta.json", {
    generationId: generation.generationId,
    generatedAt: generation.generatedAt,
    source: sourceDir,
    recommendationsSha256: candidateFile.sha256,
  });
  console.log(
    `dryrun: generation ${generation.generationId}; ${entries.length} entries, ${models.length} models, ${plans.length} plans → ${outDir}`
  );
}

// ─── main ────────────────────────────────────────────────────────────────────

const [mode, source] = process.argv.slice(2);
if (mode === "live") {
  await captureLive(join(import.meta.dir, "live"));
} else if (mode === "dryrun" && source) {
  captureDryRun(resolve(source), join(import.meta.dir, "dryrun-subscription"));
} else {
  fail("usage: capture.ts live | capture.ts dryrun <dry-run-dir>");
}
