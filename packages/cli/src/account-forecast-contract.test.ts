import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_USAGE_LINE } from "./account-forecast-render.js";
import { allowanceReportSchema } from "./auth/accounts/allowance-report-schema.js";
import { buildResponseRow } from "./auth/accounts/ledger/ledger-row.js";

async function run(args: string[], recorded = false, command = "forecast", probeHelp = false) {
  const home = mkdtempSync(join(tmpdir(), "allowance-cli-contract-"));
  try {
    const configDir = join(home, ".claudish");
    const accountsDir = join(home, "accounts");
    mkdirSync(configDir, { recursive: true });
    const accounts = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"].map((id, i) => ({
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
        subscriptionAccounts: {
          "openai-codex": { generation: 1, strategy: "lookahead", accounts },
        },
      })
    );
    if (recorded) {
      const capture = readFileSync(
        join(import.meta.dir, "test-fixtures/sse-responses/codex-exec-turn2.sse"),
        "utf8"
      )
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => JSON.parse(l.slice(6)))
        .find((e) => e.type === "response.completed");
      const u = capture.response.usage;
      const at = Date.now();
      const day = new Date(at).toISOString().slice(0, 10);
      const raw = join(accountsDir, "usage/raw");
      mkdirSync(raw, { recursive: true });
      const rows = accounts.map((a, i) =>
        buildResponseRow({
          provider: "openai-codex",
          requestId: "capture-" + i,
          attempt: 0,
          at,
          accountId: a.id,
          label: a.label,
          planClass: "pro",
          session: "session-local-123456",
          model: "contract-model",
          reason: undefined,
          outcome: "ok",
          tokens: {
            input: u.input_tokens,
            cacheRead: u.input_tokens_details.cached_tokens,
            cacheWrite: u.input_tokens_details.cache_write_tokens,
            output: u.output_tokens,
          },
          finalInput: u.input_tokens,
          // Window metadata comes from the existing E19 loopback setup; it is not
          // a captured vendor header. Token totals above are an unmodified capture.
          usage: {
            observedAt: at,
            windows: [
              {
                slot: "primary",
                displayId: "5h",
                lengthMinutes: 300,
                usedFraction: 0.2,
                resetAt: at + 3600000,
              },
              {
                slot: "secondary",
                displayId: "7d",
                lengthMinutes: 10080,
                usedFraction: 0.2,
                resetAt: at + 100 * 3600000,
              },
            ],
          },
        })
      );
      writeFileSync(
        join(raw, day + ".jsonl"),
        rows.map((r) => JSON.stringify(r)).join("\n") + "\n"
      );
    }
    const helpProbe = `
      const { spyOn } = await import("bun:test");
      const reader = await import(${JSON.stringify(new URL("./auth/accounts/ledger/ledger-reader.ts", import.meta.url).href)});
      const service = await import(${JSON.stringify(new URL("./auth/accounts/allowance-service.ts", import.meta.url).href)});
      let reads = 0, reports = 0;
      spyOn(reader, "readLedger").mockImplementation(async () => { reads++; return {rows:[], skipped:0}; });
      spyOn(service.AllowanceService.prototype, "report").mockImplementation(async () => { reports++; throw new Error("help must not build a report"); });
      const { accountCommand } = await import(${JSON.stringify(new URL("./account-command.ts", import.meta.url).href)});
      await accountCommand(${JSON.stringify([command, ...args])});
      console.log("HELP_PROBE " + JSON.stringify({reads, reports}));
    `;
    const child = Bun.spawn(
      probeHelp
        ? [process.execPath, "--no-env-file", "-e", helpProbe]
        : [
            process.execPath,
            "--no-env-file",
            join(import.meta.dir, "index.ts"),
            "account",
            command,
            ...args,
          ],
      {
        env: {
          ...process.env,
          HOME: home,
          CLAUDISH_ACCOUNTS_DIR: accountsDir,
          CLAUDISH_CONFIG: "",
          CLAUDISH_PANE_CHILD: "",
          CLAUDISH_DISABLE_KEYCHAIN: "1",
          CLAUDISH_DISABLE_OP: "1",
          CLAUDISH_DISABLE_CATALOG_WARM: "1",
          CLAUDISH_SKIP_LIVE_E2E: "1",
          NO_COLOR: "1",
          TZ: "UTC",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const code = await child.exited;
    return {
      code,
      stdout: await stdout,
      stderr: await stderr,
      config: JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
describe("account forecast CLI contract", () => {
  test("32 removing a file-backed account preserves strategy in the rewritten config", async () => {
    const r = await run(["codex", "home", "--yes"], false, "remove");
    expect(r.code).toBe(0);
    expect(r.config.subscriptionAccounts["openai-codex"].strategy).toBe("lookahead");
    expect(
      r.config.subscriptionAccounts["openai-codex"].accounts.map((a: { id: string }) => a.id)
    ).toEqual(["aaaaaaaaaaaa"]);
  }, 30_000);
  test("35 recorded completion tokens produce schema-valid JSON with ISO times and short session ids", async () => {
    const r = await run(["--json", "--horizon", "36h"], true);
    expect(r.code).toBe(0);
    const report = allowanceReportSchema.parse(JSON.parse(r.stdout));
    expect(report).toMatchObject({
      schema: "claudish.allowance.v1",
      horizonHours: 36,
      evidence: "window-only",
      status: "ok",
      strategy: "lookahead",
      alertModel: "ebr",
      burn: { long: null, short: null },
    });
    expect(report.accounts).toHaveLength(2);
    expect(report.generatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    for (const session of report.sessions)
      expect(session.session === "unattributed" || session.session.length <= 8).toBe(true);
    expect(report.trajectory.spark48).toMatch(/^[▁▂▃▄▅▆▇█▒▓┊ ]*$/u);
  }, 30_000);
  test("35b no evidence produces valid JSON and exactly the no-usage human line", async () => {
    const json = await run(["--json"]);
    expect(json.code).toBe(0);
    expect(allowanceReportSchema.parse(JSON.parse(json.stdout))).toMatchObject({
      status: "insufficient-evidence",
      forecastAt: null,
      strategy: "lookahead",
      alertModel: "ebr",
      burn: { long: null, short: null, sustainable: null },
      alerts: [],
      sessions: [],
    });
    const text = await run([]);
    expect(text.code).toBe(0);
    expect(text.stdout.trim()).toBe(NO_USAGE_LINE);
  }, 30_000);
  for (const horizon of ["8d", "0h", "week"]) {
    test("35c rejects horizon " + horizon + " without printing prose to stdout", async () => {
      const r = await run(["--json", "--horizon", horizon]);
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("--horizon must be between 1h and 7d");
    }, 30_000);
  }
  for (const args of [["--help"], ["-h"], ["--json", "--provider", "codex", "--help"]]) {
    test("L3 forecast help exits zero: " + args.join(" "), async () => {
      const r = await run(args);
      expect(r.code).toBe(0);
      expect(r.stdout).toStartWith("Usage:");
      expect(r.stdout).toContain(
        "claudish account forecast [--json] [--horizon <h|d>] [--provider codex]"
      );
      expect(r.stderr).toBe("");
    }, 30_000);
  }
  test("L3 help reads no ledger and builds no allowance report", async () => {
    const r = await run(["--help"], false, "forecast", true);
    expect(r.code).toBe(0);
    expect(r.stdout).toStartWith("Usage:");
    expect(r.stdout).toContain('HELP_PROBE {"reads":0,"reports":0}');
    expect(r.stderr).toBe("");
  }, 30_000);
  test("L3 an unknown argument exits two with forecast-specific help", async () => {
    const r = await run(["--bogus"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Unknown account forecast argument: --bogus");
    expect(r.stderr).toContain("claudish account forecast [--json]");
  }, 30_000);
  for (const provider of ["codex", "openai-codex"]) {
    test("L4 accepts --provider " +
      provider +
      " and returns the canonical claudish provider", async () => {
      const r = await run(["--provider", provider, "--json"]);
      expect(r.code).toBe(0);
      expect(allowanceReportSchema.parse(JSON.parse(r.stdout)).provider).toBe("openai-codex");
    }, 30_000);
  }
  for (const [args, message] of [
    [["--provider", "gemini"], 'unknown provider "gemini"'],
    [["--provider", "claude"], "has no allowance model yet"],
    [["--provider", "anthropic"], "has no allowance model yet"],
    [["--provider"], "--provider needs a value"],
    [["--provider", "--json"], "--provider needs a value"],
  ] as const) {
    test("L4 rejects " + args.join(" ") + " with a clear provider error", async () => {
      const r = await run([...args]);
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain(message);
    }, 30_000);
  }
  test("35 lookahead human output discloses the ebr alert model", async () => {
    const r = await run([], true);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("alerts simulate ebr (lookahead alert model pending)");
  }, 30_000);
});
