import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_NO_ISOLATION_LINE } from "./loader.js";
import { currentHookLabel, runInHookScope, setCaptureSinkForTests } from "./output-capture.js";

const HELPERS = join(import.meta.dir, "test-helpers");
const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "claudish-hooks-capture-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("runInHookScope (in process)", () => {
  it("attributes console and stream writes inside the scope, and nothing outside it", async () => {
    const lines: string[] = [];
    const previous = setCaptureSinkForTests((l) => lines.push(l));
    try {
      expect(currentHookLabel()).toBeNull();
      runInHookScope("hook:m/a", () => {
        console.log("in %s", "scope");
        process.stderr.write("err-write\n");
        expect(currentHookLabel()).toBe("hook:m/a");
      });
      await runInHookScope("hook:m/b", async () => {
        await Bun.sleep(1);
        await new Promise<void>((r) =>
          setTimeout(() => {
            console.warn("after timer");
            r();
          }, 1)
        );
      });
      expect(currentHookLabel()).toBeNull();
      expect(lines).toEqual([
        "[hook hook:m/a] in scope",
        "[hook hook:m/a] err-write",
        "[hook hook:m/b] after timer",
      ]);
    } finally {
      setCaptureSinkForTests(previous);
    }
  });

  it("captures again after other code replaced process.stderr.write", () => {
    const lines: string[] = [];
    const previous = setCaptureSinkForTests((l) => lines.push(l));
    const saved = process.stderr.write;
    let leaked = "";
    try {
      runInHookScope("hook:m/x", () => {});
      // A writer installed after the capture, e.g. a spy restoring one it saved earlier.
      process.stderr.write = ((chunk: unknown) => {
        leaked += String(chunk);
        return true;
      }) as typeof process.stderr.write;
      runInHookScope("hook:m/x", () => process.stderr.write("scoped\n"));
      process.stderr.write("unscoped\n");
      expect(lines).toEqual(["[hook hook:m/x] scoped"]);
      expect(leaked).toBe("unscoped\n");
    } finally {
      process.stderr.write = saved;
      setCaptureSinkForTests(previous);
    }
  });
});

describe("isolateProtocolStdout (spawned process)", () => {
  it("X-11: an unbindable libc leaves stdout untouched and the MCP server loads no user module", async () => {
    const dir = tempDir();
    const mod = join(dir, "user.ts");
    writeFileSync(mod, `export default { apiVersion: 1, id: "u", on: { request: () => [] } };`);
    const proc = Bun.spawn(["bun", join(HELPERS, "capture-child.ts"), "mcp-unbound", mod], {
      env: { ...process.env },
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(await proc.exited).toBe(0);
    expect(stdout).toBe("");
    const report = JSON.parse(stderr.slice(stderr.indexOf("REPORT ") + 7).split("\n")[0] ?? "{}");
    expect(report.isolation).toEqual({ active: false, sameAsStdout: true });
    expect(report.hooks).toEqual([]);
    const refusals = stderr.split("\n").filter((l) => l === `[claudish] ${MCP_NO_ISOLATION_LINE}`);
    expect(refusals.length).toBe(1);
  });

  it(
    "X-12: the protocol writer is the only thing on stdout, and a 4 MiB frame survives a late reader",
    async () => {
      const dir = tempDir();
      const size = 4 * 1024 * 1024;
      const proc = Bun.spawn(["bun", join(HELPERS, "isolate-child.ts"), String(size)], {
        env: { ...process.env },
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderrText = new Response(proc.stderr).text();
      await Bun.sleep(1_000); // the reader starts late, so the pipe fills
      const stdout = Buffer.from(await new Response(proc.stdout).arrayBuffer());
      expect(await proc.exited).toBe(0);
      const stderr = await stderrText;

      expect(stderr).toContain("ACTIVE true");
      expect(stderr).toContain("CALLBACK");
      expect(stdout.length).toBe(size);
      expect(stdout[0]).toBe("{".charCodeAt(0));
      expect(stdout.subarray(size - 2).toString()).toBe("}\n");
      expect(stdout.includes("NOISE")).toBe(false);
      // Direct descriptor writes land on stderr.
      expect(stderr).toContain("NOISE-FD");
      expect(stderr).toContain("NOISE-BUNWRITE");

      // Stdout-bound console calls and process.stdout.write go to the debug log.
      const logs = readdirSync(join(dir, "logs"));
      const log = readFileSync(join(dir, "logs", logs[0] as string), "utf8");
      expect(log).toContain("[stdout] NOISE-CONSOLE");
      expect(log).toContain("[stdout] NOISE-INFO");
      expect(log).toContain("[stdout] NOISE-WRITE");
      expect(log).toContain("[hook hook:x/y] SCOPED-CONSOLE");
    },
    { timeout: 20_000 }
  );
});
