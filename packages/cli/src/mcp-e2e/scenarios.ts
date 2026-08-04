import type { ObservationView, Scenario } from "./types.js";

const AUTH_UNAVAILABLE = /\[claudish\] 1Password auth unavailable, skipping op:\/\/ keys:/;
const SDK_DENIED = /Denied authorization for SDK client/;

function createSessionCall() {
  return {
    name: "create_session",
    arguments: {
      model: "glm-4.6",
      prompt: "Reply with exactly: OK",
      timeout_seconds: 30,
    },
    settleMs: 20_000,
    cancelAfter: true,
  };
}

function assertSingle(
  observations: ObservationView[],
  check: (observation: ObservationView, failures: string[]) => void
): string[] {
  const failures: string[] = [];
  if (observations.length !== 1) {
    failures.push(`expected exactly 1 replica, observed ${observations.length}`);
  }

  const observation = observations[0];
  if (observation) check(observation, failures);
  return failures;
}

function observedSpanNames(observation: ObservationView): string {
  const names = observation.spans.map((span) => span.name);
  return names.length > 0 ? names.join(", ") : "none";
}

function assertSpanPresent(
  observation: ObservationView,
  failures: string[],
  spanName: string
): void {
  if (!observation.hasSpan(spanName)) {
    failures.push(
      `expected an ${spanName} span, observed spans: ${observedSpanNames(observation)}`
    );
  }
}

function observedResolveRequests(observation: ObservationView): string {
  const requests = observation.resolveRequests();
  return requests.length > 0 ? requests.join(", ") : "none";
}

export const SCENARIOS: Scenario[] = [
  // This is the end-to-end regression arm: a stripped MCP server must reach the
  // configured 1Password Environment, resolve the routed key, and remain a valid
  // JSON-RPC peer while doing so.
  {
    id: "op-cold",
    group: "op",
    description: "Cold MCP credential resolution succeeds through the configured 1Password account",
    config: {
      onepasswordAccount: "inherit",
      onepasswordEnvironments: "inherit",
    },
    calls: [createSessionCall()],
    order: 10,
    assert: (observations) =>
      assertSingle(observations, (observation, failures) => {
        assertSpanPresent(observation, failures, "op:client-handshake");
        assertSpanPresent(observation, failures, "op:environments.getVariables");

        const authUnavailable = observation.grepStderr(AUTH_UNAVAILABLE);
        if (authUnavailable.length > 0) {
          failures.push(
            `expected no 1Password auth-unavailable marker, observed ${authUnavailable.length} matching stderr line(s)`
          );
        }

        const createSessionText = observation.toolText.create_session;
        if (!/\{"session_id":"[0-9a-f]{8}","status":"starting"\}/.test(createSessionText ?? "")) {
          failures.push(
            `expected create_session tool text containing an 8-hex session_id with status starting, observed: ${createSessionText ? JSON.stringify(createSessionText) : "none"}`
          );
        }
        if (observation.timedOut) {
          failures.push(
            `expected the MCP server to finish before its timeout, observed timedOut=${observation.timedOut}`
          );
        }

        const initialized = observation.frames.some((frame) => frame.id === 1 && frame.result);
        if (!initialized) {
          const responseIds = observation.frames
            .filter((frame) => frame.id !== undefined)
            .map((frame) => String(frame.id));
          failures.push(
            `expected an initialize response frame with id 1 and a result, observed response ids: ${responseIds.length > 0 ? responseIds.join(", ") : "none"}`
          );
        }
      }),
  },

  // These values are deliberately fake: this arm asserts whether 1Password is
  // consulted, which is decided by key presence, never key validity. The upstream
  // call failing is therefore expected and irrelevant here.
  // All three names are required because claudish still opens an SDK client to chase
  // the PAYG names (GLM_API_KEY/ZHIPU_API_KEY) when the coding-plan key is present.
  // The zero-cost path engages only when the whole routing chain is satisfied; that
  // is a real property of the credential authority, not a test quirk.
  {
    id: "op-env-wins",
    group: "op",
    description: "Explicit provider keys win without consulting 1Password",
    env: {
      ZAI_CODING_API_KEY: "fake-e2e-value-not-a-secret",
      GLM_API_KEY: "fake-e2e-value-not-a-secret",
      ZHIPU_API_KEY: "fake-e2e-value-not-a-secret",
    },
    config: {
      onepasswordAccount: "inherit",
      onepasswordEnvironments: "inherit",
    },
    calls: [createSessionCall()],
    order: 20,
    assert: (observations) =>
      assertSingle(observations, (observation, failures) => {
        if (observation.hasSpan("op:")) {
          failures.push(
            `expected no op:* spans when the complete glm-4.6 credential chain is already in env, observed: ${observedSpanNames(observation)}`
          );
        }
        if (observation.timedOut) {
          failures.push(
            `expected the env-key arm to finish before its timeout, observed timedOut=${observation.timedOut}`
          );
        }
      }),
  },

  // Disabling 1Password is a hard boundary, not merely permission to ignore an
  // auth failure. This catches eager SDK/WASM loading as well as resolution work.
  {
    id: "op-disabled",
    group: "op",
    description: "CLAUDISH_DISABLE_OP prevents all 1Password work and SDK loading",
    env: { CLAUDISH_DISABLE_OP: "1" },
    config: {
      onepasswordAccount: "inherit",
      onepasswordEnvironments: "inherit",
    },
    calls: [createSessionCall()],
    order: 30,
    assert: (observations) =>
      assertSingle(observations, (observation, failures) => {
        if (observation.hasSpan("op:")) {
          failures.push(
            `expected no op:* spans while 1Password is disabled, observed: ${observedSpanNames(observation)}`
          );
        }
        if (observation.hasSpan("op:sdk-wasm-import")) {
          failures.push(
            `expected no op:sdk-wasm-import span while 1Password is disabled, observed: ${observedSpanNames(observation)}`
          );
        }
      }),
  },

  // With three accounts and no account pin, non-TTY selection must fail before
  // createClient. The absent client-handshake is precisely why no desktop dialog
  // can appear, so this pins the user-visible symptom rather than only an error.
  {
    id: "op-no-account",
    group: "op",
    description: "A missing account pin reproduces the non-TTY multi-account failure",
    config: {
      onepasswordAccount: null,
      onepasswordEnvironments: "inherit",
    },
    calls: [createSessionCall()],
    cooldownSeconds: 45,
    order: 90,
    assert: (observations) =>
      assertSingle(observations, (observation, failures) => {
        const authUnavailable = observation.grepStderr(AUTH_UNAVAILABLE);
        if (authUnavailable.length === 0) {
          failures.push(
            "expected the 1Password auth-unavailable stderr marker, observed 0 matching lines"
          );
        }
        if (!authUnavailable.some((line) => line.includes("Multiple"))) {
          failures.push(
            `expected the auth-unavailable marker to mention Multiple accounts, observed ${authUnavailable.length} marker line(s) without that diagnostic`
          );
        }
        if (observation.hasSpan("op:client-handshake")) {
          failures.push(
            `expected no op:client-handshake span after account selection failed, observed spans: ${observedSpanNames(observation)}`
          );
        }
        if (observation.hasSpan("op:sdk-wasm-import")) {
          failures.push(
            `expected no op:sdk-wasm-import span because account selection should fail before createClient, observed spans: ${observedSpanNames(observation)}`
          );
        }
      }),
  },

  // This arm currently documents rather than forbids the unexpanded placeholder
  // behaviour. Once OP_ACCOUNT gains an anchored `${...}` guard, tighten this to
  // require the specific invalid-account diagnostic.
  {
    id: "op-placeholder",
    group: "op",
    description: "A literal OP_ACCOUNT placeholder does not resolve the provider key",
    env: { OP_ACCOUNT: "${OP_ACCOUNT}" },
    config: {
      onepasswordAccount: null,
      onepasswordEnvironments: "inherit",
    },
    calls: [createSessionCall()],
    cooldownSeconds: 45,
    order: 95,
    assert: (observations) =>
      assertSingle(observations, (observation, failures) => {
        if (observation.hasSpan("op:environments.getVariables")) {
          failures.push(
            `expected no op:environments.getVariables span because the literal OP_ACCOUNT placeholder should resolve nothing, observed spans: ${observedSpanNames(observation)}; resolve requests: ${observedResolveRequests(observation)}`
          );
        }
      }),
  },

  // Six independent MCP servers reproduce the machine-wide DesktopAuth race.
  // The cross-process handshake lock must eliminate denials while still allowing
  // at least one real Environment resolution to complete.
  {
    id: "op-concurrent",
    group: "op",
    description: "Concurrent MCP servers serialize the 1Password SDK handshake across processes",
    config: {
      onepasswordAccount: "inherit",
      onepasswordEnvironments: "inherit",
    },
    calls: [createSessionCall()],
    concurrency: 6,
    cooldownSeconds: 45,
    order: 99,
    assert: (observations) => {
      const failures: string[] = [];
      if (observations.length !== 6) {
        failures.push(`expected exactly 6 concurrent replicas, observed ${observations.length}`);
      }

      const deniedReplicas = observations
        .filter((observation) => observation.grepStderr(SDK_DENIED).length > 0)
        .map((observation) => observation.replica);
      if (deniedReplicas.length > 0) {
        failures.push(
          `expected zero replicas with a Denied authorization for SDK client diagnostic, observed replicas: ${deniedReplicas.join(", ")}`
        );
      }

      const resolvedReplicas = observations
        .filter((observation) => observation.hasSpan("op:environments.getVariables"))
        .map((observation) => observation.replica);
      if (resolvedReplicas.length === 0) {
        const observed = observations
          .map((observation) => `replica ${observation.replica}: ${observedSpanNames(observation)}`)
          .join("; ");
        failures.push(
          `expected at least one replica with an op:environments.getVariables span, observed spans: ${observed || "no replicas"}`
        );
      }

      return failures;
    },
  },
];
