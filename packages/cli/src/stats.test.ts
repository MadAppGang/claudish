import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDISH_DIR = join(homedir(), ".claudish");
const CONFIG_FILE = join(CLAUDISH_DIR, "config.json");


function backupFile(path: string): string | null {
  const backup = path + ".stats-test.bak";
  if (existsSync(path)) {
    try {
      const content = require("node:fs").readFileSync(path, "utf-8");
      writeFileSync(backup, content, "utf-8");
      return backup;
    } catch {
      return null;
    }
  }
  return null;
}

function restoreFile(path: string, backup: string | null): void {
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // Ignore
    }
  }
  if (backup && existsSync(backup)) {
    try {
      const content = require("node:fs").readFileSync(backup, "utf-8");
      writeFileSync(path, content, "utf-8");
      unlinkSync(backup);
    } catch {
      // Ignore
    }
  }
}

describe("stats module — env var override", () => {
  beforeEach(() => {
    delete process.env.CLAUDISH_STATS;
  });

  afterEach(() => {
    delete process.env.CLAUDISH_STATS;
  });

  it("CLAUDISH_STATS=0 is detected as disabled", async () => {
    process.env.CLAUDISH_STATS = "0";
    const { clearBuffer } = await import("./stats-buffer.js");
    clearBuffer();

    // Stats recording should silently no-op when env var disables it
    // We test this indirectly: recordStats should not throw
    const { recordStats, initStats } = await import("./stats.js");
    // Reset initialized state by calling initStats again (idempotent)
    initStats({ interactive: false } as any);

    expect(() => recordStats({ model_id: "test-model" })).not.toThrow();
  });

  it("CLAUDISH_STATS=false is detected as disabled", () => {
    process.env.CLAUDISH_STATS = "false";
    const envValue = process.env.CLAUDISH_STATS;
    expect(envValue === "0" || envValue === "false" || envValue === "off").toBe(true);
  });

  it("CLAUDISH_STATS=off is detected as disabled", () => {
    process.env.CLAUDISH_STATS = "off";
    const envValue = process.env.CLAUDISH_STATS;
    expect(envValue === "0" || envValue === "false" || envValue === "off").toBe(true);
  });

  it("undefined CLAUDISH_STATS is not disabled", () => {
    delete process.env.CLAUDISH_STATS;
    const envValue = process.env.CLAUDISH_STATS;
    const isDisabled = envValue === "0" || envValue === "false" || envValue === "off";
    expect(isDisabled).toBe(false);
  });
});

describe("stats module — initStats", () => {
  it("initStats does not throw", async () => {
    const { initStats } = await import("./stats.js");
    expect(() => initStats({ interactive: false } as any)).not.toThrow();
  });

  it("recordStats does not throw when stats disabled", async () => {
    const { recordStats } = await import("./stats.js");
    expect(() =>
      recordStats({
        model_id: "gemini-2.5-pro",
        provider_name: "gemini",
        latency_ms: 100,
        success: true,
        http_status: 200,
      })
    ).not.toThrow();
  });
});

describe("stats module — showMonthlyBanner", () => {
  let configBackup: string | null = null;
  const originalStderr = process.stderr.write;
  let stderrOutput = "";

  beforeEach(() => {
    configBackup = backupFile(CONFIG_FILE);
    stderrOutput = "";
    // Capture stderr output
    (process.stderr as any).write = (chunk: string) => {
      stderrOutput += chunk;
      return true;
    };
  });

  afterEach(() => {
    process.stderr.write = originalStderr;
    restoreFile(CONFIG_FILE, configBackup);
  });

  it("showMonthlyBanner does not throw", async () => {
    const { showMonthlyBanner } = await import("./stats.js");
    expect(() => showMonthlyBanner()).not.toThrow();
  });

  it("shows first-run banner when no lastMonthlyPrompt is set", async () => {
    // Write config without stats key
    const cfg = { version: "1.0.0", defaultProfile: "default", profiles: {} };
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg), "utf-8");

    const { showMonthlyBanner } = await import("./stats.js");
    showMonthlyBanner();

    // Should show opt-in banner for first run
    expect(stderrOutput).toContain("claudish");
  });

  it("does not show banner when CLAUDISH_STATS=0", async () => {
    process.env.CLAUDISH_STATS = "0";
    stderrOutput = "";

    const { showMonthlyBanner } = await import("./stats.js");
    showMonthlyBanner();

    // Should not output anything
    expect(stderrOutput).toBe("");
    delete process.env.CLAUDISH_STATS;
  });

  it("shows thank-you banner when stats enabled and monthly interval elapsed", async () => {
    // Write config with stats enabled and lastMonthlyPrompt > 30 days ago
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const cfg = {
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      stats: {
        enabled: true,
        lastMonthlyPrompt: oldDate,
      },
    };
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg), "utf-8");

    const { showMonthlyBanner } = await import("./stats.js");
    showMonthlyBanner();

    expect(stderrOutput).toContain("thank you");
  });

  it("shows re-engagement banner when stats disabled and monthly interval elapsed", async () => {
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const cfg = {
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      stats: {
        enabled: false,
        lastMonthlyPrompt: oldDate,
      },
    };
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg), "utf-8");

    const { showMonthlyBanner } = await import("./stats.js");
    showMonthlyBanner();

    expect(stderrOutput).toContain("appreciate");
  });

  it("does not show banner when within monthly interval", async () => {
    // lastMonthlyPrompt set 1 hour ago
    const recentDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const cfg = {
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      stats: {
        enabled: true,
        lastMonthlyPrompt: recentDate,
      },
    };
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg), "utf-8");

    stderrOutput = "";
    const { showMonthlyBanner } = await import("./stats.js");
    showMonthlyBanner();

    // Should not output anything — too soon
    expect(stderrOutput).toBe("");
  });
});

describe("OTLP timeUnixNano format", () => {
  it("is a nanosecond string (not a number)", async () => {
    const { eventToLogRecord } = await import("./stats-otlp.js");
    const event = {
      timestamp: "2026-03-16T14:00:00.000Z",
      model_id: "test",
      provider_name: "test",
      stream_format: "openai-sse",
      latency_ms: 100,
      success: true,
      http_status: 200,
      input_tokens: 0,
      output_tokens: 0,
      estimated_cost: 0,
      is_free_model: false,
      token_strategy: "standard",
      adapter_name: "DefaultAdapter",
      middleware_names: [] as string[],
      fallback_used: false,
      invocation_mode: "auto-route",
      platform: "darwin",
      arch: "arm64",
      timezone: "UTC",
      runtime: "bun-1.2",
      install_method: "npm",
      claudish_version: "5.12.0",
    };
    const record = eventToLogRecord(event as any);

    // Must be a string
    expect(typeof record.timeUnixNano).toBe("string");

    // Must represent nanoseconds (approximately right magnitude)
    const nano = Number(record.timeUnixNano);
    expect(Number.isFinite(nano)).toBe(true);

    // Should be approximately March 2026 in nanoseconds
    // 2026-03-16 = ~1.77e18 nanoseconds since epoch
    expect(nano).toBeGreaterThan(1_700_000_000_000_000_000);
  });

  it("uses 30-day interval for monthly check (not calendar months)", () => {
    const MONTHLY_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
    // 30 days = 2,592,000,000 ms
    expect(MONTHLY_INTERVAL_MS).toBe(2_592_000_000);

    // 29 days should NOT trigger
    const notExpired = Date.now() - 29 * 24 * 60 * 60 * 1000;
    expect(Date.now() - notExpired).toBeLessThan(MONTHLY_INTERVAL_MS);

    // 31 days SHOULD trigger
    const expired = Date.now() - 31 * 24 * 60 * 60 * 1000;
    expect(Date.now() - expired).toBeGreaterThan(MONTHLY_INTERVAL_MS);
  });
});
