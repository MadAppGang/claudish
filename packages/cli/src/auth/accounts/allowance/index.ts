/**
 * The allowance model's public API: the only import path the I/O shell uses
 * (architecture §1.2). Everything behind it is pure (§1.1).
 */

export {
  type AlertPayload,
  type AlertsOptions,
  type AlertsRun,
  alerts,
  alertsSliced,
  alertStep,
  episodeId,
  gaps,
  initialAlertMemory,
  paceInCuPerHour,
  remedy,
  remedyText,
} from "./alerts.js";
export { calibration, type AccountCalibration } from "./calibrate.js";
export { contributions } from "./contributions.js";
export { choose, planFor } from "./choose.js";
export {
  accountView,
  accountViews,
  combinedNow,
  deliverable,
  feasible,
  finishView,
  hardFull,
  isRead,
  overlayReadings,
  requestCostCu,
  usable,
  windowBlocks,
  windowRates,
  type Combined,
  type FreshReading,
} from "./capacity.js";
export {
  costPriorsFor,
  cuOf,
  alertModelConfig,
  alertStrategy,
  DEFAULT_ALLOWANCE_CONFIG,
  LOOKAHEAD_TRAJ_PATHS,
  PROVIDER_COST_PRIORS,
  trajPaths,
  USAGE_HOURS,
} from "./constants.js";
export {
  calendarDigest,
  cfgDigest,
  closedHourDemandDigest,
  evidenceInputs,
  forecastKey,
  planKey,
  seedKey,
  seedOf,
  viewsDigest,
} from "./digest.js";
export {
  fnv1a32,
  mulberry32,
  sampleBernoulli,
  sampleGamma,
  sampleLognormal,
  sampleNormal,
  type Rng,
} from "./prng.js";
export {
  type DemandModel,
  demandModel,
  forecast,
  forecastSliced,
  quantilesOf,
  sampleDemandPath,
} from "./forecast.js";
export {
  burnRates,
  closedHours,
  demandProfile,
  type HourPoint,
  HOURS_PER_WEEK,
  type LocalHour,
  localHourFn,
  offsetFn,
  profileFor,
} from "./profile.js";
export { readingsFromSnapshot, windowKey } from "./readings.js";
export {
  accountProviderOf,
  candidatesToChooseRequest,
  eligibleOfView,
  textOf,
  threadKeyOf,
  type ThreadHint,
  viewsToCandidates,
} from "./request.js";
export { classifySemantics, epochOf } from "./semantics.js";
export {
  gridBuckets,
  type SimDecision,
  type SimOpts,
  type SimResult,
  simulate,
} from "./simulate.js";
export { evidenceOf, initialState, ledgerDays, observe, observeAll } from "./state.js";
export {
  type BucketOutcome,
  capacityCu,
  createWorld,
  type DecideFn,
  type SimWorld,
  simBeta,
  stepBucket,
} from "./step.js";
export { byBindingReset, ebr } from "./strategies/ebr.js";
export {
  type Assessment,
  assess,
  branchPoints,
  lookahead,
  needsReplan,
  switchCostCu,
} from "./strategies/lookahead.js";
export {
  evaluateSequence,
  type SearchInput,
  type SearchResult,
  searchSequences,
  type SequenceResult,
} from "./strategies/search.js";
export { sticky } from "./strategies/sticky.js";
export { DEPLOYABLE, STRATEGIES } from "./strategies/strategy.js";
export { sparkline, trajectory } from "./trajectory.js";
export { usageByHour } from "./usage.js";
export type * from "./types.js";
