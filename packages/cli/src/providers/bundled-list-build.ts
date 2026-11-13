/**
 * Builds the bundled recommended list from four reads of one catalog generation.
 *
 * Pure: reads no file and no network, so every rejection can be exercised on
 * data alone. `scripts/generate-bundled-list.ts` does the reading and writing.
 * Nothing on a request path imports this module.
 *
 * The result is a `DiskCacheV3` that the ordinary cache reader accepts, plus a
 * `bundle` key with the recommended rows and their efforts. It keeps only the
 * vendor's own catalog connections: a gateway or cross-vendor connection is
 * dropped, and the roles are decided by data equality, never a name pattern.
 * Anything the file could not honestly describe throws {@link BundleShapeError}
 * instead of shipping a partial list. A gap in one model's publication that the
 * file can carry as published (a model with effort levels and no effort row) is
 * bundled as is and reported in the summary's `warnings`.
 */
import type { AggregatorEntry } from "../model-loader.js";
import { type RecommendationTier, isRecommendationTier } from "../model-loader.js";
import {
  type CachedPlanInclusion,
  type CachedSubscriptionPlan,
  type DiskCacheV3,
  type SlimModelEntry,
  isCachedSubscriptionPlan,
  isSlimModelEntry,
  reconcileWires,
} from "./all-models-cache.js";
import {
  type CachedRouteRegistry,
  type RouteRegistry,
  WIRE_REGISTRY_VERSION,
  isConnectionWire,
  isRouteRegistry,
  registryVersionAtLeast,
  routeProfile,
  sanitizeRouteRegistry,
} from "./connection-wire.js";
import {
  type EffortRecommendation,
  type ModelEffortRecommendations,
  parseEffortRecommendations,
} from "./effort-recommendations.js";
import { isVendorOwnRoute } from "./route-candidates.js";

/** A value the bundled recommended list cannot be built from; `path` locates it in the input. */
export class BundleShapeError extends Error {
  constructor(
    readonly path: string,
    message: string
  ) {
    super(`${path}: ${message}`);
    this.name = "BundleShapeError";
  }
}

/** One row of `bundle.recommendations.entries`. Array order is the backend's rank. */
export interface BundledRecommendationRow {
  modelId: string;
  tier: RecommendationTier;
  route?: { routeId: string; routeProfileId: string };
  planId?: string;
}

export interface BundledListMetadata {
  format: 1;
  source: string;
  fetchedAt: string;
  recommendations: {
    contractVersion: 3;
    generationId: string;
    entries: BundledRecommendationRow[];
  };
  efforts: Record<string, ModelEffortRecommendations>;
}

export interface BundledListFile extends DiskCacheV3 {
  routeRegistry: CachedRouteRegistry;
  bundle: BundledListMetadata;
}

/** The four reads, each carrying the generation the backend said it answered from. */
export interface BundledListInputs {
  source: string;
  fetchedAt: string;
  /** The `?catalog=recommended` envelope. Its generation pins the other three reads. */
  recommended: {
    contractVersion: number;
    generationId: string;
    generatedAt: string;
    recommendations: unknown;
  };
  routes: { generationId: string; registry: unknown };
  plans: { generationId: string; plans: unknown[] };
  slim: { generationId: string; models: unknown[] };
}

/** What the build kept and dropped, for the generator's printout. */
export interface BundledListSummary {
  generationId: string;
  entries: number;
  rowsPerTier: Record<string, number>;
  skippedTiers: Record<string, number>;
  keptConnectionsByKind: Record<string, number>;
  droppedConnectionsByKind: Record<string, number>;
  unmappedConnections: number;
  effortRows: number;
  effortRowsOutsideBundle: number;
  /** Every recommended model bundled with no effort row, sorted, whether or not it publishes effort levels. */
  modelsWithNoEffortRow: string[];
  /**
   * Gaps in the publication that are bundled as published and do not fail the
   * build. The generator prints each one; an empty list means none.
   */
  warnings: string[];
  droppedSendableOn: number;
  /** Per model id, how many connections were kept: the self-check compares a re-read against it. */
  keptConnectionsPerEntry: Record<string, number>;
}

/** Profile kinds this build understands. Any other kind means the role rule below is out of date. */
const PROFILE_KINDS = new Set(["direct", "subscription", "gateway"]);

/** Evidence fields, which only say how the backend learned a fact, removed at every depth. */
const EVIDENCE_FIELDS = new Set([
  "evidence",
  "evidenceSourceUrl",
  "sourceUrl",
  "sourceCollectorId",
  "confidence",
]);

const ENTRY_FIELDS = {
  contractVersion: true,
  modelId: true,
  displayName: true,
  provider: true,
  aliases: true,
  status: true,
  releaseDate: true,
  contextWindow: true,
  maxOutputTokens: true,
  reasoningStatus: true,
  reasoning: true,
  supportsVision: true,
  supportsTools: true,
  supportsThinking: true,
  videoInput: true,
  videoOutput: true,
  inputModalities: true,
  outputModalities: true,
  aggregators: true,
  subscriptionPlanIds: true,
  tokenParam: true,
  routeVariant: true,
  endpoints: true,
  // `optInConnections` is memory-only: the raw rows hold every connection in `aggregators`.
} satisfies Record<keyof Omit<SlimModelEntry, "optInConnections">, true>;

const CONNECTION_FIELDS = {
  sourceProviderId: true,
  routeStatus: true,
  route: true,
  externalModelId: true,
  pricing: true,
  contextWindow: true,
  reasoning: true,
  wire: true,
  modelIdEffort: true,
  // Published on the connection and read through `in` checks, not declared on the interface.
  limits: true,
  contentUse: true,
  fixedEffort: true,
} satisfies Record<
  | keyof Omit<AggregatorEntry, "sourceCollectorId" | "confidence">
  | "limits"
  | "contentUse"
  | "fixedEffort",
  true
>;

const PLAN_FIELDS = {
  contractVersion: true,
  id: true,
  provider: true,
  modelDiscovery: true,
  routeStatus: true,
  route: true,
  routeReason: true,
  inclusions: true,
} satisfies Record<keyof CachedSubscriptionPlan, true>;

const INCLUSION_FIELDS = {
  kind: true,
  sourceText: true,
  provider: true,
  externalModelId: true,
  resolution: true,
} satisfies Record<keyof CachedPlanInclusion, true>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pickFields(value: object, fields: Record<string, true>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => fields[key] === true));
}

function withoutEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutEvidence);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !EVIDENCE_FIELDS.has(key))
      .map(([key, field]) => [key, withoutEvidence(field)])
  );
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function connectionPath(connection: AggregatorEntry, model: SlimModelEntry): string {
  const route = connection.route;
  return `models.${model.modelId}.aggregators.${route?.routeId}/${route?.routeProfileId}`;
}

/**
 * Whether a connection is served by the model's own vendor, on its native API or
 * its own subscription, and is therefore kept in the bundled recommended list.
 * A connection that is not mapped names no endpoint, so it is `dropped`.
 *
 * Throws on a mapped connection whose profile is missing or of an unknown kind,
 * and when the registry and the routing gatherer disagree on who the vendor is:
 * either way the role cannot be trusted.
 */
export function vendorRoleOf(
  connection: AggregatorEntry,
  model: SlimModelEntry,
  registry: RouteRegistry
): "vendor-own" | "dropped" {
  if (connection.routeStatus !== "mapped") return "dropped";
  const path = connectionPath(connection, model);
  const profile = connection.route ? routeProfile(registry, connection.route) : undefined;
  if (!profile) throw new BundleShapeError(path, "the route profile is not in the registry");
  if (!PROFILE_KINDS.has(profile.kind)) {
    throw new BundleShapeError(path, `unknown route profile kind "${profile.kind}"`);
  }
  if (profile.kind === "gateway" || model.provider === undefined) return "dropped";
  if (!(profile.nativeModelProviders ?? []).includes(model.provider)) return "dropped";
  if (!isVendorOwnRoute(connection.route, model)) {
    throw new BundleShapeError(
      path,
      `the registry names "${model.provider}" a native vendor of this profile, but the route id is not that vendor`
    );
  }
  return "vendor-own";
}

function assertSameGeneration(generationId: string, read: string, expected: string): void {
  if (generationId !== expected) {
    throw new BundleShapeError(read, `generation ${generationId} is not ${expected}`);
  }
}

function readRegistry(raw: unknown): RouteRegistry {
  if (!isRouteRegistry(raw)) {
    throw new BundleShapeError("routes.registry", "not a route registry");
  }
  if (!registryVersionAtLeast(raw.registryVersion, WIRE_REGISTRY_VERSION)) {
    throw new BundleShapeError(
      "routes.registry.registryVersion",
      `${raw.registryVersion} is older than ${WIRE_REGISTRY_VERSION}`
    );
  }
  for (const [routeId, route] of Object.entries(raw.routes)) {
    for (const [profileId, profile] of Object.entries(route.profiles)) {
      if (!PROFILE_KINDS.has(profile.kind)) {
        throw new BundleShapeError(
          `routes.registry.routes.${routeId}.profiles.${profileId}.kind`,
          `unknown route profile kind "${profile.kind}"`
        );
      }
    }
  }
  return raw;
}

function readModels(raw: unknown[]): SlimModelEntry[] {
  const seen = new Set<string>();
  return raw.map((value, index) => {
    if (!isSlimModelEntry(value)) {
      throw new BundleShapeError(`slim.models[${index}]`, "not a slim model entry");
    }
    if (seen.has(value.modelId)) {
      throw new BundleShapeError(`slim.models[${index}]`, `duplicate model id ${value.modelId}`);
    }
    seen.add(value.modelId);
    return value;
  });
}

function readPlans(raw: unknown[]): CachedSubscriptionPlan[] {
  return raw.map((value, index) => {
    if (!isCachedSubscriptionPlan(value)) {
      throw new BundleShapeError(`plans.plans[${index}]`, "not a subscription plan");
    }
    return value;
  });
}

function readRoute(value: unknown): { routeId: string; routeProfileId: string } | undefined {
  if (!isRecord(value)) return undefined;
  const { routeId, routeProfileId } = value;
  return typeof routeId === "string" && typeof routeProfileId === "string"
    ? { routeId, routeProfileId }
    : undefined;
}

/** The rows of the tiers this build knows, in API order, and how many rows each other tier had. */
function readRecommendationRows(rawEntries: unknown[]): {
  rows: BundledRecommendationRow[];
  skippedTiers: Record<string, number>;
} {
  const rows: BundledRecommendationRow[] = [];
  const skippedTiers: Record<string, number> = {};
  rawEntries.forEach((value, index) => {
    if (!isRecord(value) || typeof value.modelId !== "string" || typeof value.tier !== "string") {
      throw new BundleShapeError(
        `recommendations.entries[${index}]`,
        "needs a string modelId and a string tier"
      );
    }
    if (!isRecommendationTier(value.tier)) {
      skippedTiers[value.tier] = (skippedTiers[value.tier] ?? 0) + 1;
      return;
    }
    const route = readRoute(value.route);
    rows.push({
      modelId: value.modelId,
      tier: value.tier,
      ...(route ? { route } : {}),
      ...(typeof value.planId === "string" ? { planId: value.planId } : {}),
    });
  });
  return { rows, skippedTiers };
}

/**
 * Parses the efforts as published, failing on anything the runtime parser would
 * silently lose: an absent field, a dropped cell, or a published row with no
 * cell (`{}`), which the parser drops whole. It reads the raw cells, so
 * the later narrowing of `sendableOn` to the kept connections cannot trip it.
 */
function readEfforts(raw: unknown): Record<string, ModelEffortRecommendations> {
  if (!isRecord(raw)) {
    throw new BundleShapeError("recommendations.efforts", "absent or not an object");
  }
  const parsed = parseEffortRecommendations(raw);
  const lostCells: string[] = [];
  for (const [modelId, byTask] of Object.entries(raw)) {
    // A row that is not an object, or an object with no cell, is dropped whole.
    const cellKeys = isRecord(byTask) ? Object.keys(byTask) : [];
    const taskTypes = cellKeys.length > 0 ? cellKeys : ["(row)"];
    for (const taskType of taskTypes) {
      if (!parsed[modelId]?.[taskType]) lostCells.push(`${modelId}.${taskType}`);
    }
  }
  if (lostCells.length > 0) {
    throw new BundleShapeError(
      "recommendations.efforts",
      `the runtime parser drops ${lostCells.length} cell(s): ${lostCells.join(", ")}`
    );
  }
  return parsed;
}

/**
 * The recommended models with no effort row, sorted, and the warnings they raise.
 *
 * A model with no effort levels (`control: "toggle"`, or no reasoning block) has
 * no task slots to recommend for, so its missing row is expected and silent. A
 * model that publishes effort levels and has no row is a gap in the cloud models
 * catalog: it is still bundled exactly as published, with no row, and one
 * warning names every such model so a single run reports the whole gap. One
 * model's gap never blocks the rest of the list.
 */
function modelsWithNoEffortRow(
  recommended: readonly SlimModelEntry[],
  efforts: Record<string, ModelEffortRecommendations>
): { modelIds: string[]; warnings: string[] } {
  const withNoRow = recommended.filter((model) => !efforts[model.modelId]);
  const uncovered = withNoRow
    .filter((model) => (model.reasoning?.efforts?.length ?? 0) > 0)
    .map((model) => model.modelId)
    .sort(compareCodeUnits);
  const warnings =
    uncovered.length > 0
      ? [
          `recommendations.efforts: ${uncovered.length} recommended model(s) publish effort levels and have no effort row, bundled without one: ${uncovered.join(", ")}`,
        ]
      : [];
  return { modelIds: withNoRow.map((model) => model.modelId).sort(compareCodeUnits), warnings };
}

function connectionKey(routeId: string, routeProfileId: string, wireId: string): string {
  return JSON.stringify([routeId, routeProfileId, wireId]);
}

function compareConnections(a: AggregatorEntry, b: AggregatorEntry): number {
  return (
    compareCodeUnits(a.route?.routeId ?? "", b.route?.routeId ?? "") ||
    compareCodeUnits(a.route?.routeProfileId ?? "", b.route?.routeProfileId ?? "") ||
    compareCodeUnits(a.externalModelId ?? "", b.externalModelId ?? "")
  );
}

function bumpCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function projectConnection(connection: AggregatorEntry): AggregatorEntry {
  const projected = withoutEvidence(pickFields(connection, CONNECTION_FIELDS)) as AggregatorEntry;
  if (connection.wire === undefined) return projected;
  return { ...projected, wire: { ...projected.wire, evidence: [] } } as AggregatorEntry;
}

/** The kept connections of one model, sorted, counting every dropped one by profile kind. */
function keptConnectionsOf(
  model: SlimModelEntry,
  registry: RouteRegistry,
  summary: BundledListSummary
): AggregatorEntry[] {
  const kept: AggregatorEntry[] = [];
  for (const connection of model.aggregators ?? []) {
    if (connection.routeStatus !== "mapped") {
      summary.unmappedConnections++;
      continue;
    }
    const role = vendorRoleOf(connection, model, registry);
    const kind = connection.route
      ? (routeProfile(registry, connection.route)?.kind ?? "unknown")
      : "unknown";
    if (role === "dropped") {
      bumpCount(summary.droppedConnectionsByKind, kind);
      continue;
    }
    if (!isConnectionWire(connection.wire)) {
      throw new BundleShapeError(
        `${connectionPath(connection, model)}.wire`,
        "not a connection wire"
      );
    }
    bumpCount(summary.keptConnectionsByKind, kind);
    kept.push(projectConnection(connection));
  }
  return kept.sort(compareConnections);
}

function projectEntry(
  model: SlimModelEntry,
  registry: RouteRegistry,
  summary: BundledListSummary
): SlimModelEntry {
  const aggregators = keptConnectionsOf(model, registry, summary);
  summary.keptConnectionsPerEntry[model.modelId] = aggregators.length;
  return {
    ...(withoutEvidence(pickFields(model, ENTRY_FIELDS)) as SlimModelEntry),
    aggregators,
  };
}

function projectPlan(
  plan: CachedSubscriptionPlan,
  bundledIds: ReadonlySet<string>
): CachedSubscriptionPlan {
  const projected = withoutEvidence(pickFields(plan, PLAN_FIELDS)) as CachedSubscriptionPlan;
  if (!plan.inclusions) return projected;
  const inclusions = plan.inclusions
    .filter(
      (inclusion) =>
        inclusion.resolution?.status === "mapped" && bundledIds.has(inclusion.resolution.modelId)
    )
    .map((inclusion) => pickFields(inclusion, INCLUSION_FIELDS) as unknown as CachedPlanInclusion);
  return { ...projected, inclusions };
}

/** Removes `sendableOn` elements naming a connection the list dropped. */
function keepSendableConnections(
  efforts: Record<string, ModelEffortRecommendations>,
  entries: SlimModelEntry[],
  summary: BundledListSummary
): Record<string, ModelEffortRecommendations> {
  const entryById = new Map(entries.map((entry) => [entry.modelId, entry]));
  const result: Record<string, ModelEffortRecommendations> = {};
  for (const [modelId, byTask] of Object.entries(efforts)) {
    const entry = entryById.get(modelId);
    if (!entry) {
      summary.effortRowsOutsideBundle++;
      continue;
    }
    const keptKeys = new Set(
      (entry.aggregators ?? []).map((connection) =>
        connectionKey(
          connection.route?.routeId ?? "",
          connection.route?.routeProfileId ?? "",
          connection.externalModelId ?? ""
        )
      )
    );
    const cells: Record<string, EffortRecommendation> = {};
    for (const [taskType, cell] of Object.entries(byTask)) {
      const sendableOn = cell.sendableOn.filter((item) =>
        keptKeys.has(connectionKey(item.routeId, item.routeProfileId, item.externalModelId))
      );
      summary.droppedSendableOn += cell.sendableOn.length - sendableOn.length;
      cells[taskType] = { ...cell, sendableOn };
    }
    result[modelId] = cells;
    summary.effortRows++;
  }
  return result;
}

function emptySummary(generationId: string): BundledListSummary {
  return {
    generationId,
    entries: 0,
    rowsPerTier: {},
    skippedTiers: {},
    keptConnectionsByKind: {},
    droppedConnectionsByKind: {},
    unmappedConnections: 0,
    effortRows: 0,
    effortRowsOutsideBundle: 0,
    modelsWithNoEffortRow: [],
    warnings: [],
    droppedSendableOn: 0,
    keptConnectionsPerEntry: {},
  };
}

function assertReconciled(
  entries: SlimModelEntry[],
  routeRegistry: CachedRouteRegistry,
  generationId: string
): void {
  const reconciled = reconcileWires(entries, routeRegistry, generationId);
  if (!reconciled) {
    throw new BundleShapeError("routes", "the registry does not fit this generation");
  }
  const lost = [...reconciled.dropped, ...reconciled.demoted].map(
    (item) => `${item.modelId}@${item.routeId}/${item.routeProfileId} (${item.reason})`
  );
  if (lost.length > 0) {
    throw new BundleShapeError(
      "entries",
      `${lost.length} vendor-own connection(s) cannot be built: ${lost.join(", ")}`
    );
  }
}

/** The file and what it kept and dropped. {@link buildBundledList} is the file alone. */
export function buildBundledListWithSummary(inputs: BundledListInputs): {
  file: BundledListFile;
  summary: BundledListSummary;
} {
  const { recommended } = inputs;
  const generationId = recommended.generationId;
  if (recommended.contractVersion !== 3) {
    throw new BundleShapeError("recommended.contractVersion", "not contract 3");
  }
  assertSameGeneration(inputs.routes.generationId, "routes", generationId);
  assertSameGeneration(inputs.plans.generationId, "plans", generationId);
  assertSameGeneration(inputs.slim.generationId, "slim", generationId);

  const wire = recommended.recommendations;
  if (!isRecord(wire) || !Array.isArray(wire.entries) || wire.contractVersion !== 3) {
    throw new BundleShapeError("recommendations", "not a contract 3 recommendations object");
  }
  if (typeof wire.generationId === "string") {
    assertSameGeneration(wire.generationId, "recommendations", generationId);
  }

  const registry = readRegistry(inputs.routes.registry);
  const models = readModels(inputs.slim.models);
  const plans = readPlans(inputs.plans.plans);
  const { rows, skippedTiers } = readRecommendationRows(wire.entries);
  // Every later check holds vacuously for no rows, so an empty answer would ship
  // a list that reads as fresh and routes nothing. One empty tier is fine.
  if (rows.length === 0) {
    throw new BundleShapeError(
      "recommendations.entries",
      "no row in a recommendation tier this build knows"
    );
  }
  const recommendedIds = new Set(rows.map((row) => row.modelId));

  const knownIds = new Set(models.map((model) => model.modelId));
  const unknownIds = [...recommendedIds].filter((id) => !knownIds.has(id)).sort(compareCodeUnits);
  if (unknownIds.length > 0) {
    throw new BundleShapeError(
      "slim.models",
      `recommended id(s) missing: ${unknownIds.join(", ")}`
    );
  }
  const efforts = readEfforts(wire.efforts);

  const summary = emptySummary(generationId);
  summary.skippedTiers = skippedTiers;
  const noEffortRow = modelsWithNoEffortRow(
    models.filter((model) => recommendedIds.has(model.modelId)),
    efforts
  );
  summary.modelsWithNoEffortRow = noEffortRow.modelIds;
  summary.warnings.push(...noEffortRow.warnings);
  for (const row of rows) bumpCount(summary.rowsPerTier, row.tier);

  const entries = models
    .filter(
      (model) =>
        recommendedIds.has(model.modelId) ||
        (model.routeVariant?.baseModelId !== undefined &&
          recommendedIds.has(model.routeVariant.baseModelId))
    )
    .map((model) => projectEntry(model, registry, summary))
    .sort((a, b) => compareCodeUnits(a.modelId, b.modelId));
  summary.entries = entries.length;
  if (entries.length === 0) {
    throw new BundleShapeError("entries", "no model entry for the recommended ids");
  }

  const routeRegistry: CachedRouteRegistry = {
    generationId,
    registry: sanitizeRouteRegistry(registry),
  };
  assertReconciled(entries, routeRegistry, generationId);

  const bundledIds = new Set(entries.map((entry) => entry.modelId));
  const file: BundledListFile = {
    version: 3,
    catalogGenerationId: generationId,
    lastUpdated: recommended.generatedAt,
    entries,
    models: [],
    plans: plans
      .map((plan) => projectPlan(plan, bundledIds))
      .sort((a, b) => compareCodeUnits(a.id, b.id)),
    routeRegistry,
    bundle: {
      format: 1,
      source: inputs.source,
      fetchedAt: inputs.fetchedAt,
      recommendations: { contractVersion: 3, generationId, entries: rows },
      efforts: keepSendableConnections(efforts, entries, summary),
    },
  };
  return { file, summary };
}

/** Builds the list from four reads of one generation. Throws {@link BundleShapeError}. */
export function buildBundledList(inputs: BundledListInputs): BundledListFile {
  return buildBundledListWithSummary(inputs).file;
}

function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withSortedKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareCodeUnits)
      .map((key) => [key, withSortedKeys(value[key])])
  );
}

/** Keys sorted recursively, two-space indent, trailing newline: one generation, one byte stream. */
export function serializeBundledList(file: BundledListFile): string {
  return `${JSON.stringify(withSortedKeys(file), null, 2)}\n`;
}
