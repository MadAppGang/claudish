import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claudish-warm-retry-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const catalogUrl = pathToFileURL(join(import.meta.dir, "catalog-client.ts")).href;
const loggerUrl = pathToFileURL(join(import.meta.dir, "..", "logger.ts")).href;

async function runWarm(url: string): Promise<{ fetches: number; log: string }> {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `
    import { homedir } from "node:os";
    if (homedir() !== process.env.HOME) throw new Error("HOME isolation failed");
    let fetches = 0;
    const rejectFetch = async () => { fetches++; throw new Error("Network blocked by test"); };
    rejectFetch.preconnect = () => { throw new Error("Network preconnect forbidden"); };
    globalThis.fetch = rejectFetch;
    const { initLogger } = await import(${JSON.stringify(loggerUrl)});
    initLogger(false, "info", false, "claudish-mcp");
    const { warmCatalog } = await import(${JSON.stringify(catalogUrl)});
    await warmCatalog();
    await warmCatalog();
    console.log(JSON.stringify({ fetches }));
    process.exit(0);
  `,
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        USERPROFILE: root,
        ZDOTDIR: root,
        XDG_CONFIG_HOME: join(root, ".config"),
        CLAUDE_CONFIG_DIR: join(root, ".claude"),
        CLAUDISH_CATALOG_URL: url,
        CLAUDISH_DISABLE_KEYCHAIN: "1",
        CLAUDISH_DISABLE_OP: "1",
        CLAUDISH_NO_PREDEFINED_ENDPOINTS: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const logDir = join(root, ".claudish", "logs");
    const files = readdirSync(logDir);
    expect(files).toHaveLength(1);
    return {
      fetches: (JSON.parse(stdout) as { fetches: number }).fetches,
      log: readFileSync(join(logDir, files[0]), "utf8"),
    };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

describe("startCatalogWarm failures via public warmCatalog", () => {
  test("logs failed refresh reasons and retries rather than caching failure", async () => {
    const result = await runWarm("https://catalog.test/queryModels?catalog=slim");
    expect(result.fetches).toBe(2);
    expect(result.log.match(/\[catalog\] refresh failed: network/g)).toHaveLength(2);
  });

  test("logs a thrown refresh and the next call tries again", async () => {
    const result = await runWarm("not a valid URL");
    expect(result.fetches).toBe(0);
    expect(result.log.match(/\[catalog\] refresh threw:/g)).toHaveLength(2);
    expect(result.log).toContain("Invalid URL");
  });
});
