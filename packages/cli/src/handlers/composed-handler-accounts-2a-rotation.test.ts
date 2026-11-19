/**
 * Codex pool request path: quota rotation between accounts. Interleaved turns (E18), usage
 * capture (E19), quota and non-quota refusals (E5, E1 to E4, E7), forced re-signs that keep the
 * selected account (E14, E15, R2), stream quota (S1) and code mode (R1). Each test runs one
 * scenario of the child program in `test-helpers/composed-handler-accounts-2a.ts`.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertFlagship, run, src } from "./test-helpers/composed-handler-accounts-2a.js";

test("E18 one transport keeps interleaved A/B artifacts, pins, contexts and forced-sign budgets separate", async () => {
  const { result, stderr } = await run("E18-interleaved");
  expect(result.statuses, result.texts.join("\n") + stderr).toEqual([200, 200]);
  expect(result.contacts).toHaveLength(4);
  for (const [turn, account] of [
    ["first", "A"],
    ["second", "B"],
  ]) {
    const contacts = result.contacts.filter((contact: any) =>
      contact.body.includes(`${turn}-interleaved`)
    );
    expect(contacts.map((contact: any) => contact.bearer)).toEqual([
      `Bearer access-${account}`,
      `Bearer access-${account}-fresh`,
    ]);
    expect(contacts.map((contact: any) => contact.account)).toEqual([
      `leased-${account}`,
      `leased-${account}`,
    ]);
    expect(contacts[0].hash).toBe(contacts[1].hash);
  }
  expect(result.exchangeAccounts.sort()).toEqual(["A", "B"]);
  const initial = result.signContexts.filter((context: any) => !context.forceRefresh);
  const forced = result.signContexts.filter((context: any) => context.forceRefresh);
  expect(new Set(initial.map((context: any) => context.contextId)).size).toBe(2);
  expect(forced).toHaveLength(2);
  for (const context of forced) {
    expect(context.requireOAuth).toBe(true);
    expect(context.pin.id).toBe(context.accountId);
    expect(context.contextId).toBe(
      initial.find((first: any) => first.accountId === context.accountId).contextId
    );
    expect(context.rejectedBearer).toBe(
      context.accountId === "aaaaaaaaaaaa" ? "Bearer access-A" : "Bearer access-B"
    );
  }
  expect(result.canary).toBe(0);
  expect(result.enqueues).toBe(4);
  expect(result.inits).toBe(4);
});

test("E19 inactive A persists usage without replacing active B publication", async () => {
  const { result, stderr } = await run("E19-inactive");
  expect(result.status, result.text + stderr).toBe(200);
  expect(result.canary).toBe(0);
  expect(result.contacts).toHaveLength(2);
  expect(result.publications.length).toBeGreaterThan(0);
  expect(result.publications.every((plan: any) => plan.windows[0].used_pct === 20)).toBe(true);
  expect(
    result.state.providers["openai-codex"].accounts.aaaaaaaaaaaa.usage.windows[0].usedFraction
  ).toBe(1);
  expect(
    result.state.providers["openai-codex"].accounts.bbbbbbbbbbbb.usage.windows[0].usedFraction
  ).toBe(0.2);
  expect(result.state.providers["openai-codex"].active).toBe("bbbbbbbbbbbb");
  expect(result.captures.every((capture: any) => capture.synchronous)).toBe(true);
});

test("E19 capture is synchronous at pre-error, auth-retry settlement and final post-settle sites", async () => {
  const normal = await run("E1");
  const retry = await run("E19-auth-settlement");
  expect(normal.result.status).toBe(200);
  expect(retry.result.status).toBe(400);
  expect(retry.result.exchangeAccounts).toEqual(["A"]);
  const captures = [...normal.result.captures, ...retry.result.captures];
  expect(captures.every((capture: any) => capture.synchronous)).toBe(true);
  const sites = readFileSync(join(src, "handlers/composed-handler.ts"), "utf8")
    .split("\n")
    .flatMap((line, index) => (line.includes("this.capturePlanUsage(") ? [index + 1] : []));
  expect(sites).toHaveLength(4); // Original three sites plus the unified attempt observer.
  for (const line of sites)
    expect(
      captures.some((capture: any) => capture.caller?.includes(`composed-handler.ts:${line}:`)),
      JSON.stringify(captures)
    ).toBe(true);
  expect(retry.result.canary).toBe(0);
});

test("E5 pooled HTTP 403 quota rotates before credential rejection", async () => {
  const { result, stderr } = await run("E5-quota-403");
  assertFlagship(result, stderr);
});

for (const scenario of ["E5-rpm", "E5-forbidden", "E5-model", "E5-region"]) {
  test(`${scenario} does not select B or mark subscription exhaustion`, async () => {
    const { result } = await run(scenario);
    expect(result.status).not.toBe(200);
    // RPM may use the existing bounded same-account retry; it must not rotate.
    expect(result.contacts.length).toBeGreaterThan(0);
    expect(result.contacts.every((contact: any) => contact.bearer === "Bearer access-A")).toBe(
      true
    );
    expect(result.signContexts).toHaveLength(1);
    expect(result.reads).not.toContain("bbbbbbbbbbbb");
    expect(result.exchanges).toBe(0);
    expect(result.canary).toBe(0);
    expect(
      result.state.providers["openai-codex"].accounts.aaaaaaaaaaaa?.exhaustedUntil
    ).toBeUndefined();
  });
}

test("E5 API-key insufficient_quota neither reads pool tokens nor rotates", async () => {
  const { result } = await run("E5-api-key");
  expect(result.status).toBe(400);
  expect(result.contacts).toHaveLength(0);
  expect(result.canary).toBe(1); // The intended metered API, not a routing continuation.
  expect(result.meteredContacts).toHaveLength(1);
  expect(result.meteredContacts[0].bearer).toBe("Bearer metered-test");
  expect(result.reads).toEqual([]);
  expect(result.signContexts).toHaveLength(1);
  expect(result.exchanges).toBe(0);
  expect(result.queries).toEqual([]);
});

test("E1 production factory rotates A quota to B with identical bytes and fresh queued attempts", async () => {
  const { result, stderr } = await run();
  assertFlagship(result, stderr);
}, 30_000);

for (const [scenario, contacts, total] of [
  ["E2", 0, 2],
  ["E3", 1, 2],
  ["E4-disabled", 2, 3],
] as const) {
  test(`${scenario} true exhaustion preserves pinned reset lines without an auth verdict`, async () => {
    const { result, stderr } = await run(scenario);
    expect(result.status, result.text + stderr).toBe(400);
    expect(JSON.parse(result.text).error.upstream_status).toBe(429);
    expect(result.text).toContain(
      `Codex subscription usage limit reached on every account (${total} of ${total}).`
    );
    expect(result.text).toContain("A");
    expect(result.text).toContain("B");
    const reset = new Date(result.reset * 1000);
    const clock = `${String(reset.getHours()).padStart(2, "0")}:${String(reset.getMinutes()).padStart(2, "0")}`;
    expect(result.text).toContain(`A — resets ${clock}`);
    expect(result.text).toContain(`B — resets ${clock}`);
    if (total === 3) expect(result.text).toMatch(/C.*disabled/);
    expect(result.verdict).toBeNull();
    expect(result.contacts).toHaveLength(contacts);
    expect(result.canary).toBe(0);
    expect(stderr).not.toMatch(/Check API key|Auth.*failed/);
  }, 30_000);
}

for (const [scenario, bearers, exchange] of [
  ["E14-quota-401", ["access-A", "access-B", "access-B-fresh"], "B"],
  ["E14-401-quota", ["access-A", "access-A-fresh", "access-B"], "A"],
  ["E14-budget", ["access-A", "access-A-fresh", "access-B"], "A"],
  ["E15-replacement", ["access-A", "access-B", "access-B"], undefined],
  ["E15-forced", ["access-A", "access-A-fresh", "access-A-fresh"], "A"],
] as const) {
  test(`${scenario} shares forced-sign budgets and keeps the selected artifact through recovery`, async () => {
    const { result, stderr } = await run(scenario);
    expect(result.status, result.text + stderr).toBe(scenario === "E14-budget" ? 400 : 200);
    expect(result.contacts.map((contact: any) => contact.bearer)).toEqual(
      bearers.map((bearer) => `Bearer ${bearer}`)
    );
    expect(result.exchangeAccounts).toEqual(exchange ? [exchange] : []);
    expect(result.canary).toBe(0);
    expect(result.enqueues).toBe(bearers.length);
    expect(result.inits).toBe(bearers.length);
    if (exchange) {
      const forced = result.signContexts.filter((ctx: any) => ctx.forceRefresh);
      expect(forced).toHaveLength(1);
      expect(forced[0].pin.id).toBe(exchange === "A" ? "aaaaaaaaaaaa" : "bbbbbbbbbbbb");
      expect(forced[0].requireOAuth).toBe(true);
      expect(forced[0].rejectedBearer).toBe(`Bearer access-${exchange}`);
    }
    if (scenario === "E15-replacement") expect(result.signContexts).toHaveLength(2);
    if (scenario === "E15-forced") expect(result.signContexts).toHaveLength(2);
  }, 30_000);
}

for (const scenario of ["S1-one", "S1-eligible", "S1-after-http"]) {
  test(`${scenario} false-mode stream quota marks without rotating or leasing capacity`, async () => {
    const { result, stderr } = await run(scenario);
    expect(result.status, result.text + stderr).toBe(scenario === "S1-one" ? 400 : 429);
    expect(JSON.parse(result.text).error.upstream_status).toBe(429);
    expect(result.contacts).toHaveLength(scenario === "S1-after-http" ? 2 : 1);
    const active = scenario === "S1-after-http" ? "bbbbbbbbbbbb" : "aaaaaaaaaaaa";
    expect(result.state.providers["openai-codex"].accounts[active].exhaustedUntil).toBe(
      result.reset * 1000
    );
    expect(result.state.providers["openai-codex"].active).toBe(active);
    expect(result.exchanges).toBe(0);
    expect(result.canary).toBe(0);
    if (scenario === "S1-one") {
      expect(result.verdict).toBeNull();
      expect(result.text).toContain(
        "Codex subscription usage limit reached on every account (1 of 1)."
      );
    } else {
      expect(result.verdict).toBe("transient");
      expect(JSON.parse(result.text).error.message).toBe(
        "Codex account retry deferred; retry this request."
      );
      expect(result.queries).toEqual([{ before: active, after: active, reads: 0 }]);
    }
  }, 30_000);
}

test("E7 bare-name exhaustion reaches the metered socket with its cost warning; explicit cx stops", async () => {
  const bare = await run("E7-bare");
  expect(bare.result.status, bare.result.text + bare.stderr).toBe(200);
  expect(bare.result.text).toBe("CANARY SUCCESS");
  expect(bare.result.canary).toBe(1);
  expect(bare.result.contacts).toHaveLength(0);
  expect(bare.stderr).toContain("billed per token");
  const explicit = await run("E7-explicit");
  expect(explicit.result.status).toBe(400);
  expect(explicit.result.text).toContain(
    "Codex subscription usage limit reached on every account (2 of 2)."
  );
  expect(explicit.result.verdict).toBeNull();
  expect(explicit.result.canary).toBe(0);
  expect(explicit.stderr).not.toContain("billed per token");
}, 30_000);

// Rebase resolution "Decisions for the owner", decision 1: the code-mode
// body belongs to A. The next inbound request may select B, never this request.
test("R1 code-mode pooled quota returns transient 429 without contacting a second account", async () => {
  const { result, stderr } = await run("R1-code-mode");
  expect(result.status, result.text + stderr).toBe(429);
  expect(result.verdict).toBe("transient");
  expect(JSON.parse(result.text).error).toMatchObject({
    type: "rate_limit_error",
    upstream_status: 429,
    message: "Codex account retry deferred; retry this request.",
  });
  expect(result.contacts).toHaveLength(1);
  expect(result.contacts[0].account).toBe("leased-A");
  const body = JSON.parse(result.contacts[0].body);
  expect(body.tools).toHaveLength(1);
  expect(body.tools[0].name).toBe("exec");
  expect(body.parallel_tool_calls).toBe(false);
  expect(result.signContexts).toHaveLength(1);
  expect(result.reads).not.toContain("bbbbbbbbbbbb");
  expect(result.exchanges).toBe(0);
  expect(result.queries).toEqual([{ before: "aaaaaaaaaaaa", after: "aaaaaaaaaaaa", reads: 0 }]);
  expect(result.state.providers["openai-codex"].accounts.aaaaaaaaaaaa.exhaustedUntil).toBe(
    result.reset * 1000
  );
  expect(result.canary).toBe(0);
  expect(stderr).not.toContain("billed per token");
}, 30_000);

// Decision 2: legs use the same request-owned forced-sign budget as the primary,
// and every normal or forced leg sign remains pinned to the turn's account.
for (const scenario of ["R2-leg-first", "R2-primary-first", "R2-two-legs"]) {
  test(`${scenario} Responses leg 401 shares the single pinned forced re-sign`, async () => {
    const { result, stderr } = await run(scenario);
    expect(result.status, result.text + stderr).toBe(200);
    // implementation-log.md § v14 merge fixes / M4: no resend after the forced sign.
    if (scenario === "R2-leg-first") {
      expect(result.text).not.toContain("event: error");
      expect(result.text).toContain('"name":"Read"');
    } else {
      expect(result.text).toContain("event: error");
      expect(result.text).toContain("HTTP 401");
    }
    expect(result.canary).toBe(0);
    expect(result.exchanges).toBe(1);
    expect(result.exchangeAccounts).toEqual(["A"]);
    expect(result.contacts).toHaveLength(scenario === "R2-two-legs" ? 4 : 3);
    expect(new Set(result.contacts.map((contact: any) => contact.hash)).size).toBe(1);
    expect(new Set(result.contacts.map((contact: any) => contact.account))).toEqual(
      new Set(["leased-A"])
    );
    const forced = result.signContexts.filter((ctx: any) => ctx.forceRefresh);
    expect(forced).toHaveLength(1);
    expect(forced[0]).toMatchObject({
      requireOAuth: true,
      pin: { provider: "openai-codex", id: "aaaaaaaaaaaa" },
      rejectedBearer: "Bearer access-A",
      contextId: result.signContexts[0].contextId,
    });
    for (const ctx of result.signContexts.slice(1)) {
      expect(ctx.requireOAuth).toBe(true);
      expect(ctx.pin.id).toBe("aaaaaaaaaaaa");
      expect(ctx.contextId).toBe(result.signContexts[0].contextId);
    }
    expect(result.contacts.map((contact: any) => contact.bearer)).toEqual([
      "Bearer access-A",
      ...(scenario === "R2-primary-first" ? [] : ["Bearer access-A"]),
      ...Array(scenario === "R2-leg-first" ? 1 : 2).fill("Bearer access-A-fresh"),
    ]);
    expect(result.reads).not.toContain("bbbbbbbbbbbb");
    expect(result.enqueues).toBe(result.contacts.length);
    expect(result.inits).toBe(result.contacts.length);
  }, 30_000);
}

test("E4 spent rotation with expired eligible C answers transient 429 without leasing C", async () => {
  const { result, stderr } = await run("E4");
  expect(result.status, result.text + stderr).toBe(429);
  const error = JSON.parse(result.text).error;
  expect(error.type).toBe("rate_limit_error");
  expect(error.upstream_status).toBe(429);
  expect(error.message).toBe("Codex account retry deferred; retry this request.");
  expect(result.verdict).toBe("transient");
  expect(result.contacts).toHaveLength(2);
  expect(result.reads).not.toContain("cccccccccccc");
  expect(result.exchanges).toBe(0);
  expect(result.queries).toEqual([{ before: "bbbbbbbbbbbb", after: "bbbbbbbbbbbb", reads: 0 }]);
  expect(result.canary).toBe(0);
  expect(stderr).not.toContain("billed per token");
}, 30_000);
