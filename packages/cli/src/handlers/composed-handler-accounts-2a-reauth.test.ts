/**
 * Codex pool request path: credential rejection and the token host. Terminal rejections (E9),
 * disabled accounts (E11), refused metered signing (E17), an unreachable or failing token host
 * (E12, E13) and a parameter rewrite (E16). Each test runs one scenario of the child program in
 * `test-helpers/composed-handler-accounts-2a.ts`.
 */
import { expect, test } from "bun:test";
import { run } from "./test-helpers/composed-handler-accounts-2a.js";

for (const name of ["NeedsReauthError", "NoUsableAccountError", "MeteredEscapeError"]) {
  test(`E9 ${name} on explicit cx@ still stops after terminal rejection`, async () => {
    const { result, stderr } = await run(`E9:${name}:explicit`);
    expect(result.status).toBe(400);
    expect(result.verdict).toBe("terminal");
    expect(result.text).toContain("original E9 credential stop");
    expect(result.contacts).toHaveLength(1);
    expect(result.canary).toBe(0);
    expect(result.subscriptionContacts).toEqual([]);
    expect(stderr).not.toContain("billed per token");
  });
  for (const order of ["sub-first", "meter-first", "fail-then-success", "all-fail", "meter-only"]) {
    // A terminal credential rejection advances in chain order, including metered
    // hops, with a notice. The explicit cx@ case below still stops.
    test(`E9 ${name} after OAuth advances past terminal rejection: ${order}`, async () => {
      const { result, stderr } = await run(`E9:${name}:${order}`);
      const metered = order !== "sub-first";
      expect(result.status).toBe(200);
      expect(result.canary).toBe(metered ? 1 : 0);
      expect(result.contacts).toHaveLength(1);
      expect(result.originalStop).toMatchObject({ status: 400, verdict: "terminal" });
      expect(result.originalStop.text).toContain("original E9 credential stop");
      expect(result.subscriptionContacts).toEqual(
        order === "sub-first"
          ? ["success"]
          : order === "fail-then-success" || order === "all-fail"
            ? ["failure"]
            : []
      );
      expect(result.text).toBe(metered ? "CANARY SUCCESS" : "SUBSCRIPTION SUCCESS");
      expect(stderr).toContain("rejected its credential");
      // The notice names the immediate next hop, before any later 404 advances.
      expect(stderr).toContain(
        order === "meter-first" || order === "meter-only"
          ? "metered, billed per token"
          : "moving to Metered-looking display (subscription)"
      );
      expect(stderr).not.toContain("metered providers were skipped");
    });
  }
}

test("E9 marked transient behind an earlier 404 survives verbatim without metered continuation", async () => {
  const { result, stderr } = await run("E9:RefreshUnavailableError:earlier-404");
  expect(result.status).toBe(503);
  expect(result.verdict).toBe("transient");
  expect({ status: result.status, verdict: result.verdict, text: result.text }).toEqual(
    result.originalStop
  );
  expect(result.subscriptionContacts).toEqual(["failure"]);
  expect(result.canary).toBe(0);
  expect(result.contacts).toEqual([]);
  expect(stderr).not.toContain("billed per token");
});

for (const scenario of ["E11-disabled", "E11-pool-disabled"]) {
  test(`${scenario} final disabled account still reserves OAuth without reading tokens`, async () => {
    const { result, stderr } = await run(scenario);
    expect(result.status, result.text + stderr).toBe(400);
    expect(result.verdict).toBe("terminal");
    expect(result.text).toContain("No Codex subscription account can serve this request");
    expect(result.text).not.toContain("usage limit");
    expect(result.projection).toBe(true);
    expect(result.safety).toBe(true);
    expect(result.contacts).toHaveLength(0);
    expect(result.reads).toHaveLength(0);
    expect(result.canary).toBe(0);
  }, 30_000);
}

for (const scenario of [
  "E17-initial",
  "E17-replacement",
  "E17-forced",
  "E17-remove-quota",
  "E17-remove-401",
]) {
  test(`${scenario} rejects metered signing without poisoning accepted-arm evidence`, async () => {
    const { result, stderr } = await run(scenario);
    expect(result.canary, JSON.stringify(result)).toBe(0);
    expect(result.status, result.text + stderr).toBe(400);
    expect(result.verdict).toBe("terminal");
    expect(result.contacts).toHaveLength(scenario === "E17-initial" ? 0 : 1);
    expect(result.signedProjection).toBe(scenario !== "E17-initial");
    if (scenario !== "E17-remove-401")
      expect(JSON.parse(result.text).error.upstream_status).toBeUndefined();
    if (scenario.includes("remove") || scenario === "E17-forced" || scenario === "E17-replacement")
      expect(result.signContexts[1].requireOAuth).toBe(true);
    if (scenario === "E17-remove-401") {
      expect(result.signContexts[1].pin.id).toBe("aaaaaaaaaaaa");
      expect(result.signContexts[1].rejectedBearer).toBe("Bearer access-A");
    }
  }, 30_000);
}

// The backstop refuses a metered signing on the Codex hop: that request never
// reaches Codex signed with the API key. The refusal is a terminal credential
// verdict, which advances on every tier, so the chain moves to its next hop
// and says so.
test("E17-backstop refuses metered signing on the Codex hop and the chain moves on", async () => {
  const { result, stderr } = await run("E17-backstop");
  expect(result.contacts, JSON.stringify(result)).toHaveLength(0);
  expect(result.signedProjection).toBe(false);
  expect(result.status, result.text + stderr).toBe(200);
  expect(result.text).toBe("CANARY SUCCESS");
  expect(result.canary).toBe(1);
  expect(stderr).toContain("Codex subscription rejected its credential");
  expect(stderr).toContain("moving to Subscription next (subscription)");
}, 30_000);

for (const scenario of ["E12-refused", "E12-reset", "E12-slow"]) {
  test(`${scenario} preserves token endpoint and unknown journal without leasing around an outage`, async () => {
    const { result } = await run(scenario);
    expect(result.connection, JSON.stringify(result)).toBeTruthy();
    expect(result.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/token$/);
    expect(result.records[0].journal.state).toBe("unknown");
    expect(result.records[1].journal).toBeUndefined();
    expect(result.contacts).toHaveLength(0);
    expect(result.canary).toBe(0);
    expect(
      Object.values(result.state.providers["openai-codex"]?.accounts ?? {}).some(
        (state: any) => state.exhaustedUntil || state.needsReauth
      )
    ).toBe(false);
    if (scenario === "E12-slow") {
      expect(result.elapsed).toBeGreaterThanOrEqual(9_000);
      expect(result.elapsed).toBeLessThan(15_000);
    }
  }, 30_000);
}

for (const scenario of ["E13-429", "E13-503", "E13-invalid-grant", "E13-invalid-2xx"]) {
  test(`${scenario} retains token-host classification through real pool aggregation`, async () => {
    const { result, stderr } = await run(scenario);
    const grant = scenario === "E13-invalid-grant";
    const status = scenario === "E13-429" ? 429 : grant ? 400 : 503;
    expect(result.status, result.text + stderr).toBe(status);
    expect(result.verdict).toBe(grant ? "terminal" : "transient");
    expect(JSON.parse(result.text).error.upstream_status).toBe(grant ? 401 : status);
    expect(result.exchanges).toBe(2);
    expect(result.contacts).toHaveLength(0);
    expect(result.canary).toBe(0);
    if (scenario === "E13-invalid-2xx") {
      expect(result.records.map((record: any) => record.journal.state)).toEqual([
        "unknown",
        "unknown",
      ]);
      expect(result.records.map((record: any) => record.accessToken)).toEqual([
        "access-A",
        "access-B",
      ]);
    }
    if (grant)
      expect(
        Object.values(result.state.providers["openai-codex"].accounts).every(
          (state: any) => state.needsReauth
        )
      ).toBe(true);
  }, 30_000);
}

test("E16 parameter rewrite quota rotates using only the corrected payload version", async () => {
  const { result, stderr } = await run("E16-param");
  expect(result.status, result.text + stderr).toBe(200);
  expect(result.contacts).toHaveLength(3);
  expect(result.contacts[0].hash).not.toBe(result.contacts[1].hash);
  expect(result.contacts[1].hash).toBe(result.contacts[2].hash);
  expect(result.contacts.map((contact: any) => contact.bearer)).toEqual([
    "Bearer access-A",
    "Bearer access-A",
    "Bearer access-B",
  ]);
  expect(result.enqueues).toBe(3);
  expect(result.inits).toBe(3);
  expect(result.canary).toBe(0);
}, 30_000);
