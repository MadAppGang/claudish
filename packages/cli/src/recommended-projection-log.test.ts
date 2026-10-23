import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const loaderUrl = pathToFileURL(join(import.meta.dir, "model-loader.ts")).href;
const loggerUrl = pathToFileURL(join(import.meta.dir, "logger.ts")).href;
const dataDir = join(import.meta.dir, "fixtures", "recommendation-tiers", "live");
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "claudish-projection-log-"));
  mkdirSync(join(home, ".claudish"), { recursive: true });
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

async function readCache(mutation: string): Promise<{
  count: number | null;
  path: string;
  version: number;
  log: string;
}> {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `
        import { readFileSync, writeFileSync } from "node:fs";
        import { homedir } from "node:os";
        import { join } from "node:path";
        if (homedir() !== process.env.HOME) throw new Error("HOME isolation failed");
        const blocked = () => { throw new Error("Network blocked by projection log test"); };
        globalThis.fetch = Object.assign(async () => blocked(), { preconnect: blocked });
        const { initLogger } = await import(${JSON.stringify(loggerUrl)});
        const loader = await import(${JSON.stringify(loaderUrl)});
        initLogger(false, "minimal", false, "claudish-mcp");
        const dataDir = ${JSON.stringify(dataDir)};
        const read = (name) => JSON.parse(readFileSync(join(dataDir, name), "utf8"));
        const slim = read("slim.json");
        const doc = loader.projectRecommendations(
          read("recommended.json").data.recommendations,
          { catalogGenerationId: slim.generationId, entries: slim.models, plans: read("plans.json").plans },
          [],
          new Date(read("meta.json").capturedAt)
        );
        if (!doc.models.length) throw new Error("Captured recommendations projected no models");
        let disk = doc;
        ${mutation}
        writeFileSync(loader.RECOMMENDED_MODELS_CACHE_PATH, JSON.stringify(disk));
        const result = loader.readLastRecommendedModels();
        process.stdout.write(JSON.stringify({
          count: result?.models.length ?? null,
          path: loader.RECOMMENDED_MODELS_CACHE_PATH,
          version: loader.RECOMMENDED_PROJECTION_VERSION
        }));
        process.exit(0);
      `,
    ],
    {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        USERPROFILE: home,
        ZDOTDIR: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        CLAUDISH_DISABLE_KEYCHAIN: "1",
        CLAUDISH_DISABLE_OP: "1",
        CLAUDISH_DISABLE_CATALOG_WARM: "1",
        CLAUDISH_NO_PREDEFINED_ENDPOINTS: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ stderr, exit }).toEqual({ stderr: "", exit: 0 });
    const result = JSON.parse(stdout) as { count: number | null; path: string; version: number };
    expect(result.path.startsWith(join(home, ".claudish") + "/")).toBe(true);
    const logsDir = join(home, ".claudish", "logs");
    const names = readdirSync(logsDir);
    expect(names).toHaveLength(1);
    expect(names[0]).toStartWith("claudish-mcp_");
    return { ...result, log: readFileSync(join(logsDir, names[0]!), "utf8") };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

describe("recommended cache projection-version logging", () => {
  test.each([
    { name: "older", delta: -1 },
    { name: "newer", delta: 1 },
  ])(
    "rejects a $name projection and logs the path, found version and reader version",
    async ({ delta }) => {
      const result = await readCache(`disk.projectionVersion += ${delta};`);
      expect(result.count).toBeNull();
      expect(result.log).toContain(
        `[recommended] ${result.path} has projection version ${result.version + delta}; this build reads ${result.version}`
      );
    }
  );

  test("reports undefined when a captured projection has no version", async () => {
    const result = await readCache("delete disk.projectionVersion;");
    expect(result.count).toBeNull();
    expect(result.log).toContain(
      `[recommended] ${result.path} has projection version undefined; this build reads ${result.version}`
    );
  });

  test("reports none for a non-record disk value", async () => {
    const result = await readCache("disk = null;");
    expect(result.count).toBeNull();
    expect(result.log).toContain(
      `[recommended] ${result.path} has projection version none; this build reads ${result.version}`
    );
  });

  test("reads a current projection without a version-rejection log", async () => {
    const result = await readCache("");
    expect(result.count).not.toBeNull();
    expect(result.count!).toBeGreaterThan(0);
    expect(result.log).not.toContain("has projection version");
  });
});
