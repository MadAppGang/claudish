import { dirname } from "node:path";

import type { ObservationView, Scenario } from "./types.js";

const BUN_DIR = dirname(process.execPath);
const ENVIRONMENT_SKIPPED = /1Password environment skipped/;
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
    description:
      "Cold MCP credential resolution succeeds through the configured 1Password account [expect 1×1Password]",
    config: {
      onepasswordAccount: "inherit",
      onepasswordEnvironments: "inherit",
    },
    calls: [createSessionCall()],
    order: 10,
    // The zero macOS prompts are the payoff: a declared account skips `op`
    // entirely, leaving only the 1Password approval the resolution actually needs.
    expectedDialogs: {
      onepassword: 1,
      macos: 0,
      note: "the declared account skips op account enumeration; the parent needs one 1Password approval and prehydrates the child",
    },
    assert: (observations) =>
      assertSingle(observations, (observation, failures) => {
        assertSpanPresent(observation, failures, "op:client-handshake");
        assertSpanPresent(observation, failures, "op:environments.getVariables");

        const environmentSkipped = observation.grepStderr(ENVIRONMENT_SKIPPED);
        if (environmentSkipped.length > 0) {
          failures.push(
            `expected no 1Password environment-skipped marker, observed ${environmentSkipped.length} matching stderr line(s)`
          );
        }

        const createSessionText = observation.toolText.create_session;
        if (
          !/"session_id":\s*"[0-9a-f]{8}",\s*"state":\s*"STARTING"/.test(createSessionText ?? "")
        ) {
          failures.push(
            `expected create_session tool text containing an 8-hex session_id with state STARTING, observed: ${createSessionText ? JSON.stringify(createSessionText) : "none"}`
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

  // `op-cold`, with `onepasswordAccount: "inherit"`, now covers the success path
  // and depends on the machine having `onepasswordAccount` set. checkPreconditions
  // in env.ts enforces exactly that and refuses to run otherwise.
  {
    id: "op-no-account",
    group: "op",
    description: "A missing account pin is an error, not a guess [expect 2×macOS]",
    config: {
      onepasswordAccount: null,
      onepasswordEnvironments: "inherit",
    },
    calls: [createSessionCall()],
    cooldownSeconds: 45,
    order: 90,
    expectedDialogs: {
      onepassword: 0,
      macos: 2,
      note: "two macOS prompts are the price of enumerating accounts in the parent and child when none is declared; declaring one removes them",
    },
    assert: (observations) =>
      assertSingle(observations, (observation, failures) => {
        // op:resolve records attempted names, not successful resolution; absence
        // of later-stage spans proves that client and environment work never ran.
        if (observation.hasSpan("op:client-handshake")) {
          failures.push(
            `expected no op:client-handshake span without an account pin, observed spans: ${observedSpanNames(observation)}`
          );
        }

        if (observation.hasSpan("op:environments.getVariables")) {
          failures.push(
            `expected no op:environments.getVariables span without an account pin, observed spans: ${observedSpanNames(observation)}`
          );
        }

        const environmentSkipped = observation.grepStderr(ENVIRONMENT_SKIPPED);
        if (environmentSkipped.length === 0) {
          failures.push(
            "expected the 1Password environment-skipped stderr marker, observed 0 matching lines"
          );
        } else if (!environmentSkipped.some((line) => /none is configured/.test(line))) {
          failures.push(
            `expected the 1Password environment-skipped stderr line to say none is configured, observed: ${environmentSkipped.join(" | ")}`
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
    description:
      "Explicit provider keys win without consulting 1Password [expect NO dialogs — any popup here is a bug]",
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
    expectedDialogs: {
      onepassword: 0,
      macos: 0,
      note: "every chain key is already in env, so neither 1Password nor op account enumeration runs",
    },
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
    description:
      "CLAUDISH_DISABLE_OP prevents all 1Password work and SDK loading [expect NO dialogs — any popup here is a bug]",
    env: { CLAUDISH_DISABLE_OP: "1" },
    config: {
      onepasswordAccount: "inherit",
      onepasswordEnvironments: "inherit",
    },
    calls: [createSessionCall()],
    order: 30,
    // This arm claims to prevent all 1Password work, yet raised a 1Password window
    // and still passed in a real run: assertions read parent spans, not the child.
    // Until the child is asserted, an unexpected dialog is the only signal.
    expectedDialogs: {
      onepassword: 0,
      macos: 0,
      note: "CLAUDISH_DISABLE_OP=1 prevents 1Password work and op account enumeration in both parent and child",
    },
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

  // The goal is no `op` binary, not no PATH. Emptying or over-narrowing PATH hides
  // bun and tests the harness instead of the product, so retain Bun's directory.
  // This checks that `op` is not reachable; standard installs put it elsewhere
  // (bun in `~/.bun/bin`, op in a system or Homebrew prefix).
  {
    id: "op-no-op-binary",
    group: "op",
    description:
      "A missing op CLI reports that account selection is unavailable [expect NO dialogs — any popup here is a bug]",
    env: { PATH: BUN_DIR },
    config: {
      onepasswordAccount: null,
      onepasswordEnvironments: "inherit",
    },
    calls: [createSessionCall()],
    cooldownSeconds: 45,
    order: 92,
    expectedDialogs: {
      onepassword: 0,
      macos: 0,
      note: "no op binary is available on PATH, so no account lister or 1Password client can be spawned",
    },
    assert: (observations) =>
      assertSingle(observations, (observation, failures) => {
        // This is the honest remaining failure mode: with no account pin and no
        // op to ask, claudish genuinely cannot know which account to use, so it
        // says so instead of guessing.
        if (observation.hasSpan("op:client-handshake")) {
          failures.push(
            `expected no op:client-handshake span without an account pin or op CLI, observed spans: ${observedSpanNames(observation)}`
          );
        }

        const environmentSkipped = observation.grepStderr(ENVIRONMENT_SKIPPED);
        if (environmentSkipped.length === 0) {
          failures.push(
            "expected the 1Password environment-skipped stderr marker, observed 0 matching lines"
          );
        } else if (
          !environmentSkipped.some((line) =>
            /could not determine which 1Password account/i.test(line)
          )
        ) {
          failures.push(
            `expected the 1Password environment-skipped stderr line to say could not determine which 1Password account, observed: ${environmentSkipped.join(" | ")}`
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
    description:
      "A literal OP_ACCOUNT placeholder does not resolve the provider key [expect 2×macOS]",
    env: { OP_ACCOUNT: "${OP_ACCOUNT}" },
    config: {
      onepasswordAccount: null,
      onepasswordEnvironments: "inherit",
    },
    calls: [createSessionCall()],
    cooldownSeconds: 45,
    order: 95,
    expectedDialogs: {
      onepassword: 0,
      macos: 2,
      note: "two macOS prompts are the price of enumerating accounts in the parent and child when the placeholder leaves none declared; declaring one removes them",
    },
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
    description:
      "Concurrent MCP servers serialize the 1Password SDK handshake across processes [expect 6×1Password]",
    config: {
      onepasswordAccount: "inherit",
      onepasswordEnvironments: "inherit",
    },
    calls: [createSessionCall()],
    concurrency: 6,
    cooldownSeconds: 45,
    order: 99,
    // Six is BY DESIGN: this arm proves the cross-process handshake lock, so six
    // clients require six authorizations. OP_SERVICE_ACCOUNT_TOKEN skips both the
    // desktop handshake and the lock, which is what silences those dialogs.
    expectedDialogs: {
      onepassword: 6,
      macos: 0,
      note: "six independent processes need exactly six 1Password approvals; the declared account avoids op account enumeration",
    },
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
