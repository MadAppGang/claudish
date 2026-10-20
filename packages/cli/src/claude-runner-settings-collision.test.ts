import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "claudish-settings-collision-"));
const pinnedNow = 1_720_000_000_000;

interface ChildResult {
  pid: number;
  now: number;
  settings: {
    path: string;
    tokenFilePath: string;
  };
}

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

test("keeps settings paths and contents separate across processes in the same millisecond", async () => {
  const preloadPath = join(home, "pin-time.ts");
  const workerPath = join(home, "create-settings.ts");
  const modulePath = join(import.meta.dir, "claude-runner.ts");
  writeFileSync(
    preloadPath,
    `Date.now = () => ${pinnedNow};
    globalThis.fetch = () => { throw new Error("Network is forbidden in the settings collision test"); };
    `
  );
  writeFileSync(
    workerPath,
    `import { createTempSettingsFile } from ${JSON.stringify(modulePath)};
    const settings = createTempSettingsFile("settings collision", process.argv[2], true);
    console.log(JSON.stringify({ pid: process.pid, now: Date.now(), settings }));
    `
  );

  const ports = ["41001", "41002"];
  const children = ports.map((port) =>
    Bun.spawn([process.execPath, "--preload", preloadPath, workerPath, port], {
      env: {
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        XDG_CONFIG_HOME: join(home, ".config"),
        CLAUDISH_DISABLE_KEYCHAIN: "1",
        CLAUDISH_DISABLE_OP: "1",
        CLAUDISH_DISABLE_CATALOG_WARM: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
  );
  const timeout = setTimeout(() => {
    for (const child of children) child.kill();
  }, 15_000);

  const outputs = await (async () => {
    try {
      return await Promise.all(
        children.map(async (child) => {
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          return { stdout, stderr, exitCode };
        })
      );
    } finally {
      clearTimeout(timeout);
      for (const child of children) {
        if (child.exitCode === null) child.kill();
      }
      await Promise.all(children.map((child) => child.exited));
    }
  })();

  const results = outputs.map(({ stdout, stderr, exitCode }) => {
    expect(exitCode, stderr).toBe(0);
    return JSON.parse(stdout) as ChildResult;
  });
  const [first, second] = results;
  expect(first.pid).not.toBe(second.pid);
  expect(first.now).toBe(pinnedNow);
  expect(second.now).toBe(pinnedNow);
  expect(first.settings.path).not.toBe(second.settings.path);

  for (const [index, { settings }] of results.entries()) {
    const otherIndex = 1 - index;
    expect(existsSync(settings.path)).toBe(true);
    const content = readFileSync(settings.path, "utf8");
    expect(content.includes(ports[index]) || content.includes(settings.tokenFilePath)).toBe(true);
    expect(content).not.toContain(ports[otherIndex]);
    expect(content).not.toContain(results[otherIndex].settings.tokenFilePath);
  }
}, 20_000);
