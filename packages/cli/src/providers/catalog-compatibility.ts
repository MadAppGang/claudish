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
 * ## Why the record is RE-JUDGED on every read, never merely read back
 *
 * What is persisted is not a fact about the world. It is a RELATIONSHIP between
 * two versions — what the server was serving, and what the build that met it
 * could read — and persisting a relationship only freezes one half of it. The
 * other half, {@link SUPPORTED_CONTRACT_VERSION}, changes underneath the file
 * the moment `claudish update` runs.
 *
 * Keyed on presence alone, a record written by a v2 build against a v3 server
 * still fires on the v3 build shipped to end it, and
 * {@link catalogIncompatibilityMessage} then reads "the catalog serves contract
 * version 3; this build reads version 3 ... run `claudish update`" — naming the
 * remedy the user has just applied. That is a permanent brick delivered by the
 * release meant to fix the problem, and it needs no network to happen. So every
 * read re-evaluates the record against the CURRENT constant
 * ({@link isSentinelStale}) and drops it once this build has caught up.
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
  /**
   * The {@link SUPPORTED_CONTRACT_VERSION} of the build that WROTE this record.
   *
   * Stamped by {@link markCatalogIncompatible} like `detectedAt`, never supplied
   * by a caller. It exists for the one case the server-side fields cannot
   * decide: a 426 with no body records `serverContractVersion: null`, so the
   * record says nothing about what the server wanted, and only the writer's own
   * version can tell a later build whether the finding is about a build that no
   * longer exists.
   *
   * Optional because a record written before this field existed is still a valid
   * finding. Absent, it means "written by a build older than this scheme", which
   * licenses no conclusion in either direction — see {@link isSentinelStale}.
   */
  clientContractVersion?: number;
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
 * `detectedAt` and `clientContractVersion` are stamped here rather than passed
 * in: both describe the act of recording, not the response, and a caller that
 * could set `clientContractVersion` could write a record that outlives its own
 * staleness test.
 *
 * @param info What the RESPONSE said. Everything else is stamped here.
 * @param path Override the sentinel path. Only tests should pass this.
 */
export function markCatalogIncompatible(
  info: Omit<CatalogIncompatibility, "detectedAt" | "clientContractVersion">,
  path: string = CATALOG_INCOMPATIBLE_PATH
): void {
  const record: CatalogIncompatibility = {
    detectedAt: new Date().toISOString(),
    serverContractVersion: info.serverContractVersion,
    clientContractVersion: SUPPORTED_CONTRACT_VERSION,
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
 * Presence is not the whole answer, though: a record this build has outgrown is
 * dropped and deleted here, before any caller sees it ({@link isSentinelStale}).
 * That judgement applies to the FILE only. `_memFlag` was set by a response this
 * very process read off the wire — a live observation, not persisted state — and
 * a 426 outranks any version arithmetic we could do against it.
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

  if (value !== null && isSentinelStale(value)) {
    // Delete as well as ignore, so the next process does no work at all and the
    // user never trips over a file describing a problem they no longer have.
    // Best-effort, like every other fs call here; the read-time test is what
    // actually protects them, the removal is housekeeping. This also parks the
    // `null` in `_fileMemo`, so the whole check runs at most once per process.
    clearCatalogIncompatibility(path);
    return null;
  }

  _fileMemo = { path, value };
  return value;
}

/**
 * Has this build caught up with what the record describes?
 *
 * The trap, stated once: persisted state that describes a RELATIONSHIP between
 * two versions must be re-evaluated against the current version, never merely
 * read back. Only the server's half of this record is frozen on disk; ours moves
 * every time the user updates. See the header section on re-judging.
 *
 * Three questions, ordered by how much each one actually knows:
 *
 *  1. **Did the server name a floor we are still below?** Then no amount of
 *     other evidence matters — the server has said in as many words that it will
 *     not serve this build. Decisive, and it cannot brick: a build at or above
 *     the floor never reaches this branch.
 *
 *  2. **Did the server name the version it was serving?** Then judge by that
 *     alone: `<=` ours means we now read what it was serving, so the finding is
 *     spent. `>` ours means we still cannot, and the message stays true and
 *     actionable ("publishes 4, this build reads 3"). Note this deliberately
 *     answers the question WITHOUT consulting the writer's version — a record
 *     saying "server 4" written by a v2 build still applies to this v3 build,
 *     and clearing it on the writer's age alone would hand a stale v2 cache to
 *     bare-name routing, which is the mis-billing this module exists to stop.
 *
 *  3. **Nothing on the wire to judge** (a body-less 426 records `null` for both
 *     server fields). Then judge the WRITER: a record from a build that read an
 *     OLDER contract than we do describes a client that no longer exists, and
 *     nothing else will ever clear it — the updated user who is offline, or whom
 *     the server has since started answering, would carry it forever. Strictly
 *     less than, so the ordinary "same build, still too old" record keeps firing.
 *
 * An absent `clientContractVersion` (a record from before that field existed)
 * falls out of question 3 as "not stale": unknown, so assume nothing. Question 2
 * is then the only thing that can clear it, which is exactly the pre-existing
 * behaviour for those records.
 */
function isSentinelStale(record: CatalogIncompatibility): boolean {
  if (
    typeof record.minimumContractVersion === "number" &&
    record.minimumContractVersion > SUPPORTED_CONTRACT_VERSION
  ) {
    return false;
  }

  if (record.serverContractVersion !== null) {
    return record.serverContractVersion <= SUPPORTED_CONTRACT_VERSION;
  }

  if (typeof record.clientContractVersion === "number") {
    return record.clientContractVersion < SUPPORTED_CONTRACT_VERSION;
  }

  return false;
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
    // Carried through only when the file really has it. Defaulting it to
    // anything would be a lie about which build wrote the record, and
    // `isSentinelStale` reads a missing field as "unknown" on purpose.
    ...(typeof data.clientContractVersion === "number"
      ? { clientContractVersion: data.clientContractVersion }
      : {}),
  };
}

/**
 * Forget the finding — the server answered in a contract this build reads.
 *
 * Called on every fully successful refresh, which is one of the two ways the
 * sentinel heals: `claudish update` installs a build with a higher
 * {@link SUPPORTED_CONTRACT_VERSION}, its first refresh parses cleanly, and the
 * file is gone before the user notices it existed. That route needs a network
 * round trip, which is why it is not the only one — {@link readCatalogIncompatibility}
 * also clears through here the moment the RECORD shows this build has caught up,
 * offline or not. Never throws.
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
