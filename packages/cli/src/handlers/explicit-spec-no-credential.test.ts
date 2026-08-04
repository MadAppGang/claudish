/**
 * Regression: an EXPLICIT provider@model spec whose credential is missing must
 * FAIL LOUDLY (terminal 400 with an actionable hint), NOT silently fall through
 * to OpenRouter / defaultProvider.
 *
 * The reported bug: `claudish --model sc@fugu-ultra` with no Sakana key, and a
 * config of `defaultProvider: "openrouter"`, silently routed to OpenRouter,
 * which catalog-resolved "fugu-ultra" to an xAI model. The status line showed
 * "Xai" and the user got an endless "API error · Retrying" — the real cause
 * (no Sakana credential) was hidden. The documented contract is that
 * defaultProvider applies to BARE names only; explicit specs must not be
 * silently redirected.
 *
 * Black-box: drives the real proxy in-process via createProxyServer(), exactly
 * like default-provider-e2e.test.ts. No network call happens — resolution fails
 * (no credential) before any upstream fetch — so this runs on every CI machine.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigFileOverride } from "../config-override.js";
import { createProxyServer } from "../proxy-server.js";
import type { ProxyServer } from "../types.js";

const PORT_BASE = 19700;
let portCounter = 0;
const nextPort = () => PORT_BASE + (portCounter++ % 200);

let activeProxy: ProxyServer | null = null;

// setConfigFileOverride keeps fixtures isolated so a crashed run cannot damage the developer's real config.
let configFileCounter = 0;
let tempConfigPath: string | null = null;

// Sakana keys must be ABSENT for the missing-credential path. Snapshot + delete
// any that happen to be set in the runner's env, restore in afterEach.
const SAKANA_ENV_KEYS = ["SAKANA_API_KEY", "SAKANA_SUBSCRIPTION_API_KEY", "SAKANA_CODING_API_KEY"];
const savedEnv: Record<string, string | undefined> = {};

function sandbox(config: Record<string, unknown>): void {
  tempConfigPath = join(
    tmpdir(),
    `explicit-spec-no-credential.test-${process.pid}-${configFileCounter++}.json`
  );
  writeFileSync(tempConfigPath, JSON.stringify(config, null, 2), "utf8");
  setConfigFileOverride(tempConfigPath);

  for (const k of SAKANA_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
}

function restore(): void {
  setConfigFileOverride(null);
  if (tempConfigPath !== null) {
    rmSync(tempConfigPath, { force: true });
    tempConfigPath = null;
  }
  for (const k of SAKANA_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

async function spin(): Promise<number> {
  const port = nextPort();
  activeProxy = await createProxyServer(
    port,
    process.env.OPENROUTER_API_KEY,
    undefined,
    false,
    process.env.ANTHROPIC_API_KEY,
    undefined,
    { quiet: true }
  );
  return port;
}

async function ask(port: number, model: string): Promise<{ status: number; raw: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  let raw: any;
  try {
    raw = await res.json();
  } catch {
    raw = await res.text();
  }
  return { status: res.status, raw };
}

afterEach(async () => {
  if (activeProxy) {
    try {
      await activeProxy.shutdown();
    } catch {}
    activeProxy = null;
  }
  restore();
});

describe("explicit provider@model with missing credential — fail loud, no silent fallthrough", () => {
  beforeEach(() => {
    // Reproduce the user's exact config: defaultProvider=openrouter is the
    // last-resort for BARE names; it must NOT capture explicit specs.
    sandbox({ version: "1.0.0", defaultProvider: "openrouter" });
  });

  test("sc@fugu-ultra (no Sakana key) returns a terminal 400, not a retryable 500/200", async () => {
    const port = await spin();
    const { status, raw } = await ask(port, "sc@fugu-ultra");

    // Terminal: 400 so Claude Code surfaces it verbatim and does NOT retry.
    // (A 500 would loop "API error · Retrying"; a 2xx would mean it silently
    // routed to xAI/OpenRouter — the exact bug.)
    expect(status).toBe(400);
    expect(raw?.type).toBe("error");
    expect(raw?.error?.type).toBe("invalid_request_error");
  });

  test("the 400 message names the missing Sakana credential (actionable)", async () => {
    const port = await spin();
    const { raw } = await ask(port, "sc@fugu-ultra");
    const msg: string = raw?.error?.message ?? "";

    // Must mention the provider and the env var to set — the real cause, not
    // a generic xAI "API error".
    expect(msg.toLowerCase()).toContain("sakana-subscription");
    expect(msg).toContain("SAKANA_SUBSCRIPTION_API_KEY");
    // Must NOT have masqueraded as an xAI / OpenRouter failure.
    expect(msg.toLowerCase()).not.toContain("xai");
  });

  test("fugu@fugu-ultra (sakana token plan, no key) also fails loud with SAKANA_API_KEY hint", async () => {
    const port = await spin();
    const { status, raw } = await ask(port, "fugu@fugu-ultra");
    expect(status).toBe(400);
    expect(raw?.error?.message ?? "").toContain("SAKANA_API_KEY");
  });
});
