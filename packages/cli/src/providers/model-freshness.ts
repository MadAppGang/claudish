import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { searchModels, type ModelDoc } from "../model-loader.js";
import { compareModelVersions, normalizeModelId } from "../model-version.js";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CACHE_PATH = join(homedir(), ".claudish", "model-freshness-check.json");

export type WatchedFamily = "fable" | "astra";

export interface FreshnessResult {
  family: WatchedFamily;
  current: string;
  latest: string | null;
  releaseDate?: string;
  status: "up-to-date" | "newer-candidate" | "unknown";
}

interface FreshnessCache {
  checkedAt: number;
  currentFable: string;
  currentAstra: string;
  results: FreshnessResult[];
}

function stripProvider(model: string): string {
  return normalizeModelId(model);
}

function isBaseStableCandidate(family: WatchedFamily, model: ModelDoc): boolean {
  const id = model.modelId.toLowerCase();
  const provider = model.provider.toLowerCase();
  if (model.status && model.status !== "active") return false;
  if (/preview|beta|pro(?:-|$)/i.test(id)) return false;

  if (family === "fable") {
    return provider === "anthropic" && id.startsWith("claude-fable-");
  }
  return provider === "openai" && /^gpt-\d+(?:[.-]\d+)*-astra$/i.test(id);
}

function compareCandidates(a: ModelDoc, b: ModelDoc): number {
  const aDate = a.releaseDate ? Date.parse(a.releaseDate) : 0;
  const bDate = b.releaseDate ? Date.parse(b.releaseDate) : 0;
  const safeA = Number.isNaN(aDate) ? 0 : aDate;
  const safeB = Number.isNaN(bDate) ? 0 : bDate;
  if (safeA !== safeB) return safeB - safeA;
  const version = compareModelVersions(b.modelId, a.modelId);
  return version || a.modelId.localeCompare(b.modelId);
}

export function detectFamilyFreshness(
  family: WatchedFamily,
  currentModel: string,
  models: ModelDoc[]
): FreshnessResult {
  const current = stripProvider(currentModel);
  const latest = models.filter((model) => isBaseStableCandidate(family, model)).sort(compareCandidates)[0];
  if (!latest) return { family, current, latest: null, status: "unknown" };

  const latestId = stripProvider(latest.modelId);
  const currentDoc = models.find((model) => stripProvider(model.modelId) === current);
  const latestDate = latest.releaseDate ? Date.parse(latest.releaseDate) : 0;
  const currentDate = currentDoc?.releaseDate ? Date.parse(currentDoc.releaseDate) : 0;
  const newerByDate = !Number.isNaN(latestDate) && !Number.isNaN(currentDate) && latestDate > currentDate;
  const newerByVersion = compareModelVersions(latestId, current) > 0;
  const status = latestId !== current && (newerByDate || newerByVersion)
    ? "newer-candidate"
    : latestId === current
      ? "up-to-date"
      : "unknown";

  return {
    family,
    current,
    latest: latestId,
    releaseDate: latest.releaseDate,
    status,
  };
}

async function fetchFreshness(currentFable: string, currentAstra: string): Promise<FreshnessResult[]> {
  const [fableModels, astraModels] = await Promise.all([
    searchModels("fable", 20),
    searchModels("astra", 20),
  ]);
  return [
    detectFamilyFreshness("fable", currentFable, fableModels),
    detectFamilyFreshness("astra", currentAstra, astraModels),
  ];
}

function readCache(): FreshnessCache | null {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as FreshnessCache;
  } catch {
    return null;
  }
}

function writeCache(currentFable: string, currentAstra: string, results: FreshnessResult[]): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(
      CACHE_PATH,
      JSON.stringify({ checkedAt: Date.now(), currentFable, currentAstra, results }),
      "utf8"
    );
  } catch {
    // Notification caching is optional and must never block startup.
  }
}

export async function checkModelFreshness(options: {
  currentFable?: string;
  currentAstra?: string;
  force?: boolean;
  quiet?: boolean;
}): Promise<FreshnessResult[]> {
  const currentFable = options.currentFable;
  const currentAstra = options.currentAstra;
  if (!currentFable || !currentAstra) return [];

  let results: FreshnessResult[];
  const cache = readCache();
  if (
    !options.force &&
    cache &&
    cache.currentFable === currentFable &&
    cache.currentAstra === currentAstra &&
    Date.now() - cache.checkedAt < CHECK_INTERVAL_MS
  ) {
    results = cache.results;
  } else {
    try {
      results = await fetchFreshness(currentFable, currentAstra);
      writeCache(currentFable, currentAstra, results);
    } catch {
      return [];
    }
  }

  if (!options.quiet) {
    for (const result of results) {
      if (result.status === "newer-candidate") {
        console.error(
          `[claudish] New ${result.family} model available: ${result.current} -> ${result.latest}. ` +
            "Review with --model-freshness before changing configuration."
        );
      }
    }
  }
  return results;
}
