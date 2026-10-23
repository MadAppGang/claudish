import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let root: string;
let logsDir: string;
const loggerUrl = pathToFileURL(join(import.meta.dir, "logger.ts")).href;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claudish-mcp-logger-"));
  logsDir = join(root, ".claudish", "logs");
  mkdirSync(logsDir, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

async function runLogger(body: string): Promise<void> {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `
    import { homedir } from "node:os";
    if (homedir() !== process.env.HOME) throw new Error("HOME isolation failed");
    const { initLogger, log } = await import(${JSON.stringify(loggerUrl)});
    ${body}
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
    expect({ stdout, stderr, exit }).toEqual({ stdout: "", stderr: "", exit: 0 });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

describe("MCP always-on file logging", () => {
  test("keeps the new structural prefixes in a named log without writing stdout", async () => {
    const messages = ["[mcp]", "[recommended]", "[catalog]", "[effort]", "[team]"].map(
      (prefix) => prefix + " diagnostic entry"
    );
    await runLogger(`
      initLogger(false, "minimal", false, "claudish-mcp");
      for (const message of ${JSON.stringify(messages)}) log(message);
      log("[unrelated] verbose content");
    `);
    const names = readdirSync(logsDir);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^claudish-mcp_.*_\d+\.log$/);
    const text = readFileSync(join(logsDir, names[0]), "utf8");
    for (const message of messages) expect(text).toContain(message);
    expect(text).not.toContain("[unrelated]");
  });

  test("keeps 20 files per name without rotating another name's logs", async () => {
    const sessionNames: string[] = [];
    const mcpNames: string[] = [];
    for (let i = 0; i < 25; i++) {
      const session = `claudish_2000-01-${String(i + 1).padStart(2, "0")}_00-00-00_1.log`;
      const mcp = session.replace("claudish_", "claudish-mcp_");
      sessionNames.push(session);
      mcpNames.push(mcp);
      writeFileSync(join(logsDir, session), "session");
      writeFileSync(join(logsDir, mcp), "mcp");
    }
    await runLogger('initLogger(false, "info", false, "claudish-mcp");');
    const names = readdirSync(logsDir);
    expect(names.filter((name) => name.startsWith("claudish_")).sort()).toEqual(sessionNames);
    const mcpFiles = names.filter((name) => name.startsWith("claudish-mcp_")).sort();
    expect(mcpFiles).toHaveLength(20);
    expect(mcpFiles.slice(0, -1)).toEqual(mcpNames.slice(6));
    expect(mcpFiles.at(-1)).not.toBe(mcpNames.at(-1));
  });

  test("a custom keep retains exactly three newest files only for that name", async () => {
    const originals = Array.from(
      { length: 6 },
      (_, i) => `claudish-mcp_2000-01-${String(i + 1).padStart(2, "0")}_00-00-00_1.log`
    );
    for (const name of originals) writeFileSync(join(logsDir, name), "mcp");
    const other = "claudish_2000-01-01_00-00-00_1.log";
    writeFileSync(join(logsDir, other), "session");
    await runLogger('initLogger(false, "info", false, "claudish-mcp", 3);');
    const names = readdirSync(logsDir).sort();
    const mcp = names.filter((name) => name.startsWith("claudish-mcp_"));
    expect(mcp).toHaveLength(3);
    expect(mcp.slice(0, 2)).toEqual(originals.slice(-2));
    expect(mcp[2]).not.toBe(originals.at(-1));
    expect(readFileSync(join(logsDir, other), "utf8")).toBe("session");
    expect(names).toHaveLength(4);
  });

  test("noLogs suppresses creation of the always-on file on a fresh logger", async () => {
    await runLogger(
      'initLogger(false, "info", true, "claudish-mcp"); log("[mcp] diagnostic entry");'
    );
    expect(readdirSync(logsDir)).toEqual([]);
  });
});
