import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { allowanceReportSchema } from "./auth/accounts/allowance-report-schema.js";
import { buildResponseRow } from "./auth/accounts/ledger/ledger-row.js";
import { McpServer, type ToolResult, serverEnv } from "./test-helpers/contract-mcp.js";
import { type TempLayout, makeTempLayout } from "./test-helpers/contract-records.js";

const H = 3_600_000;
const T = Date.parse("2026-10-26T00:00:00Z");
const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const HEADERS = [
  "schema",
  "generatedAt",
  "forecastAt",
  "provider",
  "strategy",
  "evidence",
  "unit",
  "assumption",
  "horizonHours",
  "status",
  "blockedNow",
];
type Json = Record<string, unknown>;
type Answer = { allowance: Json; sections?: string[] };
let layout: TempLayout;
let server: McpServer | undefined;
let fetches: string;

function json(result: ToolResult): Answer {
  expect(result.isError).toBe(false);
  expect(result.text).not.toContain("\n");
  return JSON.parse(result.text) as Answer;
}
async function call(args: Json = {}) {
  return server!.callTool("allowance_status", args);
}
beforeEach(async () => {
  layout = makeTempLayout("allowance-sections");
  server = undefined;
  fetches = join(layout.root, "blocked-fetches.jsonl");
  const configDir = join(layout.home, ".claudish");
  const accountsDir = join(layout.home, "accounts");
  mkdirSync(configDir, { recursive: true });
  const accounts = [A, B].map((id, i) => ({
    id,
    label: i ? "home" : "work",
    store: "file",
    addedAt: "2026-10-20T00:00:00Z",
  }));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      subscriptionAccounts: { "openai-codex": { generation: 1, strategy: "sticky", accounts } },
    })
  );
  mkdirSync(accountsDir, { recursive: true });
  writeFileSync(
    join(accountsDir, "state.json"),
    JSON.stringify({
      version: 1,
      providers: { "openai-codex": { active: A, accounts: {} } },
    })
  );
  const days = new Map<string, unknown[]>();
  for (const [index, account] of accounts.entries())
    for (let i = 0; i <= 36; i++) {
      const at = T - (37 - i) * H;
      const row = buildResponseRow({
        provider: "openai-codex",
        requestId: `sections-${index}-${i}`,
        attempt: 0,
        at,
        accountId: account.id,
        label: account.label,
        planClass: "pro",
        session: index
          ? "22222222-bbbb-cccc-dddd-123456789abc"
          : "11111111-aaaa-bbbb-cccc-123456789abc",
        model: "contract-model",
        reason: undefined,
        outcome: "ok",
        tokens: { input: 10000, cacheRead: 0, cacheWrite: 0, output: 0 },
        finalInput: 10000,
        usage: {
          observedAt: at,
          windows: [
            {
              slot: "secondary",
              displayId: "7d",
              lengthMinutes: 10080,
              usedFraction: 0.1 + i * 0.002,
              resetAt: T + (72 + index * 24) * H,
            },
          ],
        },
      })!;
      const day = new Date(at).toISOString().slice(0, 10);
      days.set(day, [...(days.get(day) ?? []), row]);
    }
  const rawDir = join(accountsDir, "usage/raw");
  mkdirSync(rawDir, { recursive: true });
  for (const [day, rows] of days)
    writeFileSync(
      join(rawDir, day + ".jsonl"),
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      { mode: 0o600 }
    );

  // Same stdio server and startup interception as the existing MCP black-box tests.
  const source = `
    import { appendFileSync } from "node:fs";
    import { homedir } from "node:os";
    if (homedir() !== process.env.HOME) throw new Error("HOME is not isolated");
    Date.now = () => ${T};
    const originalFetch = globalThis.fetch;
    const blocked = (input) => {
      appendFileSync(${JSON.stringify(fetches)}, JSON.stringify(String(input)) + "\\n");
      throw new Error("Network blocked by allowance-sections test");
    };
    const intercepted = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url ?? input.href);
      if (url.protocol === "data:") return originalFetch(input, init);
      return blocked(url.href);
    };
    intercepted.preconnect = blocked;
    globalThis.fetch = intercepted;
    const { startMcpServer } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "mcp-server.ts")).href)});
    startMcpServer();
  `;
  server = await McpServer.start({
    env: serverEnv(layout, {
      CLAUDISH_ACCOUNTS_DIR: accountsDir,
      CLAUDISH_CONFIG: join(configDir, "config.json"),
      CLAUDISH_DISABLE_KEYCHAIN: "1",
      CLAUDISH_DISABLE_OP: "1",
      CLAUDISH_DISABLE_CATALOG_WARM: "1",
      CLAUDISH_MCP_TOOLS: "all",
    }),
    cwd: layout.cwd,
    command: [process.execPath, "--no-env-file", "-e", source],
  });
}, 30000);
afterEach(async () => {
  try {
    await server?.close();
    expect(existsSync(fetches) ? readFileSync(fetches, "utf8") : "").toBe("");
  } finally {
    layout.cleanup();
  }
}, 30000);

describe("MTL-296 allowance_status sections over MCP", () => {
  test("S1 answer text is compact parseable JSON", async () => {
    const result = await call();
    expect(result.isError).toBe(false);
    expect(result.text).not.toContain("\n");
    expect(() => JSON.parse(result.text)).not.toThrow();
  });
  test("S2 omitting sections returns every public report key and no top-level sections", async () => {
    const answer = json(await call());
    const report = allowanceReportSchema.parse(answer.allowance);
    expect(Object.keys(answer.allowance).sort()).toEqual(
      Object.keys(allowanceReportSchema.shape).sort()
    );
    expect(report.accounts.map((account) => account.id)).toEqual([A, B]);
    expect(report.evidence).not.toBe("none");
    expect(answer).not.toHaveProperty("sections");
  });
  test("S3 requested sections are sorted, retain headers, omit other sections, and fit under 4000 bytes", async () => {
    const result = await call({ sections: ["accounts", "burn", "alerts"] });
    const answer = json(result);
    expect(answer.sections).toEqual(["accounts", "alerts", "burn"]);
    for (const key of ["accounts", "burn", "alerts", ...HEADERS])
      expect(answer.allowance).toHaveProperty(key);
    for (const key of ["combined", "trajectory", "sessions"])
      expect(answer.allowance).not.toHaveProperty(key);
    expect((answer.allowance.accounts as unknown[]).length).toBe(2);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThan(4000);
  });
  test("S4 trajectory-only equals the full trajectory at the same clock and files", async () => {
    const full = json(await call());
    const report = allowanceReportSchema.parse(full.allowance);
    expect(report.generatedAt).toBe(new Date(T).toISOString());
    expect(report.trajectory.forecast.length).toBeGreaterThan(0);
    const filtered = json(await call({ sections: ["trajectory"] }));
    expect(filtered.allowance.generatedAt).toBe(full.allowance.generatedAt);
    expect(filtered.allowance.trajectory).toEqual(full.allowance.trajectory);
  });
  for (const sections of [["nope"], [], "burn"])
    test(`S5 invalid sections ${JSON.stringify(sections)} returns invalid_args`, async () => {
      const result = await call({ sections });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.text).error.code).toBe("invalid_args");
    });
  test("S6 duplicate sections are accepted and deduplicated", async () => {
    const answer = json(await call({ sections: ["burn", "burn"] }));
    expect(answer.sections).toEqual(["burn"]);
    expect(answer.allowance).toHaveProperty("burn");
  });
});
