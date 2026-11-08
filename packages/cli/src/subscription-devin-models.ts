/**
 * `claudish subscription models devin --raw --json`
 *
 * Prints Devin's dynamic models catalog inputs, decoded, inside the
 * `claudish.subscription-model-list.v1` envelope on ONE stdout line: every
 * `GetCliModelConfigs` row UNFILTERED (the `adaptive` ctx-0 row and rows this
 * account is not entitled to included; the consumer intersects) and the
 * `allowed_model_uids` of `GetCliTeamSettings`. Same two rpcs, same bare
 * protobuf and metadata as `dv@` discovery (`postDevinUnaryRaw`), but with the
 * HTTP status kept instead of collapsed into an empty list.
 *
 * The body is decoded JSON, not the protobuf as base64: the secret guard's
 * scope is literal text plus JSON escaping, and base64 would carry a
 * credential past it. `GetCliTeamSettings` is reduced to the allowed uids, so
 * no team or user field of that answer reaches stdout.
 *
 * Contract: ai-docs/architecture/providers/devin.md, "Raw model list for
 * models-index". The envelope, the run wrapper, the exit codes and the guard
 * are the Antigravity command's (`subscription-models-command.ts`).
 */

import { readDevinApiKey } from "./providers/devin/devin-credentials.js";
import {
  type DevinUnaryRaw,
  MODEL_CONFIGS_PATH,
  TEAM_SETTINGS_PATH,
  decodeAllowedUids,
  decodeModelConfigs,
  postDevinUnaryRaw,
} from "./providers/devin/devin-models.js";
import { DEVIN_CLI_VERSION } from "./providers/devin/devin-request.js";
import {
  type Secrets,
  addSecret,
  newSecrets,
  stripUserinfo,
} from "./subscription-antigravity-session.js";
import {
  EXIT,
  type ModelListFacts,
  type ModelListRunResult,
  type SubscriptionModelsDeps,
  buildModelListEnvelope,
  modelListFail,
  modelListFailureOf,
  runModelListWith,
} from "./subscription-models-command.js";

/** The prefix the Devin CLI stores in front of the session JWT. */
const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";

/**
 * The Devin api key, with every form of it registered as a secret: the key
 * itself, and the JWT after the `devin-session-token$` prefix when present,
 * so a vendor echo of the bare JWT still trips the guard. `undefined` when no
 * credential exists.
 */
export function readDevinSecrets(secrets: Secrets): string | undefined {
  const apiKey = readDevinApiKey();
  if (!apiKey) return undefined;
  addSecret(secrets, apiKey);
  if (apiKey.startsWith(DEVIN_SESSION_TOKEN_PREFIX)) {
    addSecret(secrets, apiKey.slice(DEVIN_SESSION_TOKEN_PREFIX.length));
  }
  return apiKey;
}

/** What the Devin model list uses from the shared deps. */
export type DevinModelsDeps = Pick<
  SubscriptionModelsDeps,
  "now" | "httpTimeoutMs" | "writeStdout" | "writeStderr"
>;

/** One unary rpc bounded by `timeoutMs` (fetch and body read), and whether the bound fired. */
async function postBounded(
  path: string,
  apiKey: string,
  timeoutMs: number
): Promise<{ raw: DevinUnaryRaw; timedOut: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const raw = await postDevinUnaryRaw(path, apiKey, { signal: controller.signal });
    return { raw, timedOut: controller.signal.aborted };
  } finally {
    clearTimeout(timer);
  }
}

async function determineDevin(
  deps: DevinModelsDeps,
  secrets: Secrets,
  facts: ModelListFacts
): Promise<ModelListRunResult> {
  // The Devin CLI's file exists on every platform: no platform check.
  const apiKey = readDevinSecrets(secrets);
  if (!apiKey) {
    return modelListFail(
      facts,
      modelListFailureOf("credential_missing", "devin_credential_absent")
    );
  }

  // Capability: every config the backend knows.
  const configsCall = await postBounded(MODEL_CONFIGS_PATH, apiKey, deps.httpTimeoutMs);
  facts.sourceUrl = stripUserinfo(configsCall.raw.url);
  facts.clientVersion = DEVIN_CLI_VERSION;
  const configsNetwork = configsCall.timedOut
    ? "model_configs_timeout"
    : "model_configs_network_error";
  if (configsCall.raw.kind === "unreachable") {
    return modelListFail(facts, modelListFailureOf("network", configsNetwork));
  }
  facts.fetchedAt = new Date(deps.now()).toISOString();
  facts.httpStatus = configsCall.raw.status;
  if (configsCall.raw.status < 200 || configsCall.raw.status >= 300) {
    // Not a failure: the backend answered, and its status is the answer.
    return { envelope: buildModelListEnvelope(facts), exitCode: EXIT.ok };
  }
  if (configsCall.raw.body.kind !== "bytes") {
    return modelListFail(
      facts,
      modelListFailureOf("network", configsNetwork, configsCall.raw.status)
    );
  }
  const configs = decodeModelConfigs(configsCall.raw.body.bytes);
  if (configs.length === 0) {
    return modelListFail(
      facts,
      modelListFailureOf("list_incomplete", "configs_empty", configsCall.raw.status)
    );
  }

  // Entitlement: the uids this account may call.
  const teamCall = await postBounded(TEAM_SETTINGS_PATH, apiKey, deps.httpTimeoutMs);
  facts.teamSettingsUrl = stripUserinfo(teamCall.raw.url);
  const teamNetwork = teamCall.timedOut ? "team_settings_timeout" : "team_settings_network_error";
  if (teamCall.raw.kind === "unreachable") {
    return modelListFail(facts, modelListFailureOf("network", teamNetwork));
  }
  facts.teamSettingsHttpStatus = teamCall.raw.status;
  if (teamCall.raw.status < 200 || teamCall.raw.status >= 300) {
    // Without entitlement the list is half an answer.
    return modelListFail(
      facts,
      modelListFailureOf("list_incomplete", "team_settings_http_error", teamCall.raw.status)
    );
  }
  if (teamCall.raw.body.kind !== "bytes") {
    return modelListFail(facts, modelListFailureOf("network", teamNetwork, teamCall.raw.status));
  }
  const allowedModelUids = decodeAllowedUids(teamCall.raw.body.bytes);
  if (allowedModelUids.length === 0) {
    return modelListFail(
      facts,
      modelListFailureOf("list_incomplete", "allowed_uids_empty", teamCall.raw.status)
    );
  }

  const body = JSON.stringify({ configs, allowedModelUids });
  return {
    envelope: buildModelListEnvelope(facts, undefined, body),
    exitCode: EXIT.ok,
    bodyText: body,
  };
}

/** The Devin model list. Never throws. */
export async function runDevinRawModelList(deps: DevinModelsDeps): Promise<number> {
  const secrets = newSecrets();
  const facts: ModelListFacts = { provider: "devin", tokenRefreshed: false };
  return runModelListWith(deps, facts, secrets, () => determineDevin(deps, secrets, facts));
}
