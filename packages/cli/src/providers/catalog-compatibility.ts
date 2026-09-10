/**
 * Catalog contract compatibility — a PERSISTENT sentinel, not a detector.
 *
 * models-index publishes the model catalog under a contract version. This build
 * reads {@link SUPPORTED_CONTRACT_VERSION}. When the server moves past it, an
 * un-updated claudish does not crash — which is the problem. It reads a body
 * whose shape it does not recognise, finds no `entries`, no `plans`, no
 * `subscriptionPlans`, and concludes with complete confidence that it knows of
 * no subscription covering the model in hand. Routing then does what it does for
 * any model no plan covers: it picks a metered provider. A flat-rate user is
 * billed per token and nothing anywhere says so. That silence — not a crash — is
 * the defect this file exists to prevent.
 *
 * ## Why the finding has to outlive the process that made it
 *
 * Detection alone cannot help. `getCatalogEntries()` reads the memory cache,
 * then `~/.claudish/all-models.json`, and only fetches when both come back
 * empty. A client with a warm disk cache therefore never contacts the server at
 * all and never learns the contract moved. Worse, the one process that DOES see
 * the new contract is often a `claudish --models-refresh` that exits a second
 * later; if the finding died with it, the next launch would route off the stale
 * v2 file and mis-bill exactly as before.
 *
 * So the finding is written to `~/.claudish/catalog-incompatible.json` and read
 * back on every subsequent start, until a compatible response is seen again and
 * {@link clearCatalogIncompatibility} removes it.
 *
 * ## Why the disk write is best-effort but the flag is not
 *
 * A read-only home, a full disk or a sandboxed test must never turn a billing
 * guard into a crash, so every fs call here is wrapped. But swallowing a failed
 * write and returning nothing would leave the RUNNING process routing off a
 * catalog it has just proved it cannot read. The in-memory flag is therefore set
 * first and independently of the write: the file buys protection for the NEXT
 * process, the memory flag protects this one.
 *
 * ## Zero dependencies, on purpose
 *
 * Node builtins only. The catalog client, the disk cache and the routing engine
 * all import this module, and those three already import one another; a single
 * non-builtin import here would thread a cycle through the middle of routing.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The catalog contract version THIS build knows how to read.
 *
 * Bumped only alongside the code that reads the new shape. It is a claim about
 * this binary's parser, never a preference — a server publishing anything higher
 * is not "newer than we like", it is unreadable.
 */
export const SUPPORTED_CONTRACT_VERSION = 2;

/** A recorded finding that the catalog server has moved past this build. */
export interface CatalogIncompatibility {
  /** ISO timestamp of the response that proved it. */
  detectedAt: string;
  /** The contract version the server published, when it said one. */
  serverContractVersion: number | null;
  /** The lowest version the server will serve, when it said one. */
  minimumContractVersion?: number;
}

/** Where the sentinel lives. Sibling of `~/.claudish/all-models.json`. */
export const CATALOG_INCOMPATIBLE_PATH = join(homedir(), ".claudish", "catalog-incompatible.json");

/**
 * The running process's own copy. Set by {@link markCatalogIncompatible} before
 * the write is attempted, so a failed write still protects this process.
 */
let _memFlag: CatalogIncompatibility | null = null;

/**
 * Memoized file read, keyed by path.
 *
 * {@link readCatalogIncompatibility} sits on hot paths — every bare-name route,
 * every catalog entry lookup — while the answer changes at most twice in a
 * process's life (a mark, or a clear), both of which write this memo directly.
 * Keying by path stops a test that passes an override from poisoning the
 * production path's memo, and vice versa.
 */
let _fileMemo: { path: string; value: CatalogIncompatibility | null } | null = null;

/**
 * Thrown by the routing engine when the catalog is unreadable.
 *
 * A dedicated class rather than a bare `Error` because the message's whole job
 * is to reach the user INLINE. `proxy-server.ts` maps routing-class failures to
 * HTTP 400 and everything else to 500, and a 500 is retryable: Claude Code would
 * loop on "API error · Retrying · attempt N/10" with this text buried, which is
 * the same silence wearing a different costume. It lives here rather than in
 * `routing-rules.ts` so the proxy can name it without importing the routing
 * engine.
 */
export class CatalogIncompatibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogIncompatibleError";
  }
}

// ---------------------------------------------------------------------------
// Wire-body parsing
// ---------------------------------------------------------------------------

/** What a models-index response body says about its own contract. */
export interface ContractEnvelope {
  /** Top-level `contractVersion`, or null when the body did not carry one. */
  contractVersion: number | null;
  /** `error.minimumContractVersion`, when the server named a floor. */
  minimumContractVersion?: number;
}

/**
 * Read the contract envelope off any models-index body. Never throws.
 *
 * The two fields sit at DIFFERENT depths, and that asymmetry is the whole reason
 * this is one shared function rather than two inline reads. The frozen v3 error
 * shape is:
 *
 * ```json
 * { "contractVersion": 3,
 *   "error": { "code": "catalog_client_upgrade_required",
 *              "message": "...",
 *              "minimumContractVersion": 3 } }
 * ```
 *
 * `contractVersion` is top-level on EVERY error body (426, 410, 503 alike);
 * `minimumContractVersion` is nested under `error`. Reading the latter from the
 * top level returns `undefined` without failing, which would record a sentinel
 * that protects the user but cannot tell them which version to expect — a
 * degradation invisible in every test that only asserts "was it blocked?".
 *
 * Everything is optional because a 426 may carry no body at all.
 */
export function parseContractEnvelope(body: unknown): ContractEnvelope {
  if (!body || typeof body !== "object") return { contractVersion: null };

  const data = body as Record<string, unknown>;
  const contractVersion = typeof data.contractVersion === "number" ? data.contractVersion : null;

  const err = data.error;
  const minimum =
    err && typeof err === "object"
      ? (err as Record<string, unknown>).minimumContractVersion
      : undefined;

  return {
    contractVersion,
    ...(typeof minimum === "number" ? { minimumContractVersion: minimum } : {}),
  };
}

/**
 * Whether a version this build read off the wire is one it cannot serve.
 *
 * Null (no version in the body) is NOT incompatible. An absent field is absent
 * evidence — the same asymmetry `providerServesModel` keeps between `not-served`
 * and `unknown`, and for the same reason: a rule that treated silence as denial
 * would trip on every unrelated proxy error page and 404, blocking routing for
 * users whose catalog is perfectly readable.
 */
export function isIncompatibleContractVersion(version: number | null): version is number {
  return typeof version === "number" && version > SUPPORTED_CONTRACT_VERSION;
}

// ---------------------------------------------------------------------------
// The sentinel
// ---------------------------------------------------------------------------

/**
 * Record that the catalog server speaks a contract this build cannot read.
 *
 * Never throws. Sets the in-memory flag FIRST (see the header note on why a
 * best-effort write must not make the guard best-effort), then attempts the
 * file.
 *
 * @param info Everything but `detectedAt`, which is stamped here.
 * @param path Override the sentinel path. Only tests should pass this.
 */
export function markCatalogIncompatible(
  info: Omit<CatalogIncompatibility, "detectedAt">,
  path: string = CATALOG_INCOMPATIBLE_PATH
): void {
  const record: CatalogIncompatibility = {
    detectedAt: new Date().toISOString(),
    serverContractVersion: info.serverContractVersion,
    ...(info.minimumContractVersion !== undefined
      ? { minimumContractVersion: info.minimumContractVersion }
      : {}),
  };

  _memFlag = record;
  _fileMemo = { path, value: record };

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(record), "utf-8");
  } catch {
    // Best-effort. The memory flag above already covers this process, and the
    // next one re-detects on its first fetch — strictly no worse than where it
    // would have been with no sentinel at all.
  }
}

/**
 * The recorded incompatibility, or null when this build can read the catalog.
 *
 * In-memory flag first, then the file. Never throws.
 *
 * A file that exists but does not parse is still treated as a finding. This
 * module is the file's only writer, so its PRESENCE is the signal and the
 * contents are only detail for the message. Reading a truncated write as
 * "compatible" would put the user back on the silent-mis-billing path, which is
 * the one outcome the whole mechanism exists to rule out.
 *
 * @param path Override the sentinel path. Only tests should pass this.
 */
export function readCatalogIncompatibility(
  path: string = CATALOG_INCOMPATIBLE_PATH
): CatalogIncompatibility | null {
  if (_memFlag) return _memFlag;
  if (_fileMemo && _fileMemo.path === path) return _fileMemo.value;

  let value: CatalogIncompatibility | null = null;
  try {
    if (existsSync(path)) value = parseSentinelFile(readFileSync(path, "utf-8"));
  } catch {
    // Unreadable is not evidence of compatibility, but it is also nothing this
    // process can act on beyond what the next fetch rediscovers.
  }

  _fileMemo = { path, value };
  return value;
}

/** Coerce whatever is on disk into a finding. Never throws. */
function parseSentinelFile(raw: string): CatalogIncompatibility {
  const unspecific: CatalogIncompatibility = {
    detectedAt: new Date(0).toISOString(),
    serverContractVersion: null,
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unspecific;
  }
  if (!parsed || typeof parsed !== "object") return unspecific;

  const data = parsed as Record<string, unknown>;
  return {
    detectedAt: typeof data.detectedAt === "string" ? data.detectedAt : unspecific.detectedAt,
    serverContractVersion:
      typeof data.serverContractVersion === "number" ? data.serverContractVersion : null,
    ...(typeof data.minimumContractVersion === "number"
      ? { minimumContractVersion: data.minimumContractVersion }
      : {}),
  };
}

/**
 * Forget the finding — the server answered in a contract this build reads.
 *
 * Called on every fully successful refresh, which is what makes the sentinel
 * self-healing: `claudish update` installs a build with a higher
 * {@link SUPPORTED_CONTRACT_VERSION}, its first refresh parses cleanly, and the
 * file is gone before the user notices it existed. Never throws.
 *
 * @param path Override the sentinel path. Only tests should pass this.
 */
export function clearCatalogIncompatibility(path: string = CATALOG_INCOMPATIBLE_PATH): void {
  _memFlag = null;
  _fileMemo = { path, value: null };

  try {
    rmSync(path, { force: true });
  } catch {
    // Best-effort, same as the write. A sentinel that survives its own deletion
    // costs the user one `claudish update` they have already run; it never costs
    // them money.
  }
}

/**
 * The user-facing text for an unreadable catalog.
 *
 * Three facts in the order the user needs them: what is broken, what continuing
 * anyway would cost, and the one command that fixes it. The cost sentence is the
 * point — "cannot read the catalog" on its own reads like a cosmetic warning,
 * and this failure is a billing one.
 */
export function catalogIncompatibilityMessage(i: CatalogIncompatibility): string {
  const serverSays =
    typeof i.serverContractVersion === "number"
      ? `catalog contract version ${i.serverContractVersion}`
      : typeof i.minimumContractVersion === "number"
        ? `catalog contract version ${i.minimumContractVersion} or newer`
        : "a newer catalog contract";

  return [
    `This claudish build cannot read the model catalog. The catalog server publishes ${serverSays}; this build reads version ${SUPPORTED_CONTRACT_VERSION}.`,
    "",
    "Routing cannot tell which models your subscriptions cover, so continuing would send this request to a provider that bills per token without saying so.",
    "",
    "Run `claudish update` to get a build that reads the current catalog.",
  ].join("\n");
}

/** Test seam: drop the memory flag AND the memoized file read. @internal */
export function _resetCatalogCompatibilityForTest(): void {
  _memFlag = null;
  _fileMemo = null;
}
