/**
 * Codex pool request path: failures at the auth sites. An account-list read failure (E10) and
 * a refresh, account-list or persist failure at each of the five sites (E8) are classified
 * without billing. Each test runs one scenario of the child program in
 * `test-helpers/composed-handler-accounts-2a.ts`.
 */
import { expect, test } from "bun:test";
import { run } from "./test-helpers/composed-handler-accounts-2a.js";

for (const source of ["config", "legacy"]) {
  for (const code of ["EACCES", "EMFILE", "EIO"]) {
    for (const mode of ["cold", "last-good"]) {
      test(`E10 ${source} ${code} ${mode} reserves OAuth and recovers on the next readable request`, async () => {
        const { result } = await run(`E10-io:${source}:${code}:${mode}`);
        expect(result.status).toBe(mode === "cold" ? 503 : 200);
        if (mode === "cold") {
          expect(result.verdict).toBe("transient");
          expect(JSON.parse(result.text).error.upstream_status).toBe(503);
        }
        expect(result.firstContacts).toBe(mode === "cold" ? 0 : 1);
        expect(result.canary).toBe(0);
        expect(result.projection).toBe(true);
        expect(result.safety).toBe(true);
        expect(result.routing.primary.provider).toBe("openai-codex");
        expect(result.failedSources[source]).toMatchObject({
          state: "failed",
          servingLastKnownGood: mode === "last-good",
          failure: { type: "io" },
        });
        expect(result.failedSources[source].error).toContain(code);
        expect(result.recovery.status).toBe(200);
        expect(result.recovery.sources[source].state).toBe("present");
        expect(
          result.contacts.every((contact: any) => contact.bearer !== "Bearer metered-test")
        ).toBe(true);
      });
    }
  }
}

test("E8 reporter failure preserves successful rotation and pending exhaustion", async () => {
  const { result } = await run("E8-report-failure");
  expect(result.status).toBe(200);
  expect(result.contacts).toHaveLength(2);
  expect(result.canary).toBe(0);
  expect(result.pending.exhaustedUntil).toBe(result.reset * 1000);
}, 30_000);

for (const site of ["initial", "rotation", "forced", "headers", "query"]) {
  for (const name of [
    "RefreshUnavailableError",
    "AccountListUnavailableError",
    "PersistOutcomeUnknownError",
  ]) {
    for (const upstream of [503, 429, 502]) {
      test(`E8 ${site} ${name} upstream ${upstream} is classified without billing`, async () => {
        const { result, stderr } = await run(
          `E8:${site}:${name}${upstream === 503 ? "" : `:${upstream}`}`
        );
        expect(result.status, result.text + stderr).toBe(upstream === 429 ? 429 : 503);
        expect(JSON.parse(result.text).error.upstream_status).toBe(upstream);
        expect(result.verdict).toBe("transient");
        expect(result.probeCalls).toBe(0);
        expect(result.canary).toBe(0);
        expect(stderr).not.toMatch(/Check API key|Auth.*failed/);
      }, 30_000);
    }
  }
  for (const [name, upstream] of [
    ["NeedsReauthError", 401],
    ["NoUsableAccountError", 401],
    ["AccountListInvalidError", 400],
    ["MeteredEscapeError", undefined],
  ] as const) {
    test(`E8 ${site} ${name} is terminal without billing`, async () => {
      const { result, stderr } = await run(`E8:${site}:${name}`);
      expect(result.status, result.text + stderr).toBe(400);
      expect(JSON.parse(result.text).error.upstream_status).toBe(upstream);
      expect(result.verdict).toBe("terminal");
      expect(result.probeCalls).toBe(0);
      expect(result.canary).toBe(0);
      expect(stderr).not.toMatch(/Check API key|Auth.*failed/);
    }, 30_000);
  }
}

for (const scenario of [
  "E10-config-io",
  "E10-config-invalid",
  "E10-config-schema",
  "E10-legacy-io",
  "E10-legacy-invalid",
]) {
  test(`${scenario} cold failure retains real bare-name Codex routing and reserves OAuth`, async () => {
    const { result, stderr } = await run(scenario);
    const invalid = scenario === "E10-config-invalid" || scenario === "E10-config-schema";
    // Only the bare chain advances; the retained Codex failure is still
    // terminal for invalid config and transient for I/O/legacy failure.
    const stop = result.originalStop;
    expect(stop.status, stop.text + stderr).toBe(invalid ? 400 : 503);
    expect(stop.verdict).toBe(invalid ? "terminal" : "transient");
    expect(JSON.parse(stop.text).error.upstream_status).toBe(invalid ? 400 : 503);
    expect(stop.text).toContain(scenario.includes("legacy") ? "codex-oauth.json" : "config.json");
    expect(stop.text).not.toContain("secret-marker");
    expect(result.status).toBe(invalid ? 200 : 503);
    expect(result.verdict).toBe(invalid ? null : "transient");
    if (invalid) {
      expect(result.text).toBe("CANARY SUCCESS");
      expect(stderr).toContain("rejected its credential");
      expect(stderr).toContain("metered, billed per token");
    }
    expect(result.projection).toBe(true);
    expect(result.safety).toBe(true);
    expect(result.routing.kind).toBe("ok");
    expect(result.routing.primary.provider).toBe("openai-codex");
    expect(result.contacts).toHaveLength(0);
    expect(result.canary).toBe(invalid ? 1 : 0);
  }, 30_000);
}
