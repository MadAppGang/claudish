/**
 * X-9: the MCP server's protocol stdout, with hooks loaded.
 *
 * X-9 spawns the claudish entry with `--mcp` (from source, the hermetic suite
 * does not build), a temp config naming one noisy hook module, and the debug
 * log on, then speaks newline-delimited JSON-RPC over its stdio. The module
 * writes through every stdout route, both from callbacks claudish's own I/O
 * emits later (a `process.stdin` listener, a signal listener — unreachable by
 * the hook scope) and from a timer it schedules at import (reachable).
 * Nothing but JSON-RPC may reach stdout.
 *
 * Its positive control imports the same module in a bare `bun` process with no
 * isolation and shows every marker on stdout, so X-9 can fail.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serverEnv } from "../test-helpers/contract-mcp.js";
import { type TempLayout, makeTempLayout, waitFor } from "../test-helpers/contract-records.js";

const ENTRY = join(import.meta.dir, "..", "index.ts");
const SUPPORTED = process.platform === "darwin" || process.platform === "linux";

const NOISY_MODULE = `import { writeSync } from "node:fs";
function leak(prefix) {
  console.log(prefix + "-A");
  process.stdout.write(prefix + "-B\\n");
  writeSync(1, prefix + "-C\\n");
  Bun.write(Bun.stdout, prefix + "-D\\n");
}
process.stdin.on("data", () => leak("LEAK"));
process.on("SIGUSR2", () => leak("LEAK"));
setTimeout(() => leak("SCOPED"), 0);
export default { apiVersion: 1, id: "noisy", on: { request: () => [] } };
`;

const layouts: TempLayout[] = [];
afterEach(() => {
  for (const layout of layouts.splice(0)) layout.cleanup();
});

/** A line-buffered reader over a child's stream. */
function lineReader(stream: ReadableStream<Uint8Array>) {
  const state = { text: "", done: false };
  void (async () => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      state.text += decoder.decode(value, { stream: true });
    }
    state.done = true;
  })();
  return state;
}

function debugLog(cwd: string): string {
  try {
    const dir = join(cwd, "logs");
    return readdirSync(dir)
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n");
  } catch {
    return "";
  }
}

describe.skipIf(!SUPPORTED)("MCP protocol stdout with hooks loaded", () => {
  it(
    "X-9: no hook write, by any route, reaches the JSON-RPC stream",
    async () => {
      const layout = makeTempLayout("hooks-x9");
      layouts.push(layout);
      const modulePath = join(layout.root, "noisy.ts");
      writeFileSync(modulePath, NOISY_MODULE);
      const configPath = join(layout.root, "config.json");
      writeFileSync(configPath, JSON.stringify({ hooks: { modules: [modulePath] } }));

      const proc = Bun.spawn(["bun", ENTRY, "--mcp"], {
        cwd: layout.cwd,
        env: serverEnv(layout, { CLAUDISH_CONFIG: configPath, CLAUDISH_DEBUG: "1" }),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = lineReader(proc.stdout);
      const err = lineReader(proc.stderr);
      const send = (msg: object) => {
        proc.stdin.write(`${JSON.stringify(msg)}\n`);
        proc.stdin.flush();
      };
      const responseFor = (id: number) =>
        out.text
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .some((l) => {
            try {
              return JSON.parse(l).id === id;
            } catch {
              return false;
            }
          });

      try {
        // The module was imported and its import-time timer ran.
        await waitFor(() => err.text.includes("SCOPED-C"), {
          what: "the hook module's import-time timer",
          timeoutMs: 15_000,
        });

        send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "x9", version: "0.0.0" },
          },
        });
        await waitFor(() => responseFor(1), { what: "initialize response", timeoutMs: 10_000 });
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        send({ jsonrpc: "2.0", id: 3, method: "ping" });
        await waitFor(() => responseFor(2) && responseFor(3), { what: "tools/list and ping" });

        const leaksBefore = err.text.match(/LEAK-C/g)?.length ?? 0;
        expect(leaksBefore).toBeGreaterThanOrEqual(1);
        // process.kill, not proc.kill: measured on Bun 1.4.0, `Subprocess.kill("SIGUSR2")`
        // terminates a child whose SIGUSR2 listener `process.kill(pid, …)` reaches.
        process.kill(proc.pid, "SIGUSR2");
        await waitFor(() => (err.text.match(/LEAK-C/g)?.length ?? 0) > leaksBefore, {
          what: "the signal listener's writes",
        });
        send({ jsonrpc: "2.0", id: 4, method: "tools/list" });
        await waitFor(() => responseFor(4), { what: "the second tools/list" });

        // Every listener ran: the stdin one per line sent, the signal one once.
        await waitFor(
          () =>
            [
              "[stdout] LEAK-A",
              "[stdout] LEAK-B",
              `[hook ${modulePath}] SCOPED-A`,
              `[hook ${modulePath}] SCOPED-B`,
            ].every((marker) => debugLog(layout.cwd).includes(marker)),
          { what: "the diverted writes in the debug log", timeoutMs: 10_000 }
        );
      } finally {
        proc.stdin.end();
        proc.kill();
        await proc.exited;
      }

      const lines = out.text.split("\n").filter((l) => l.trim().length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(4);
      for (const line of lines) {
        expect(line).not.toContain("LEAK");
        expect(line).not.toContain("SCOPED");
        expect(JSON.parse(line).jsonrpc).toBe("2.0");
      }
      const answered = lines.map((l) => JSON.parse(l).id).filter((id) => id !== undefined);
      expect(answered).toEqual(expect.arrayContaining([1, 2, 3, 4]));

      // Direct descriptor writes land on stderr.
      for (const marker of ["LEAK-C", "LEAK-D", "SCOPED-C", "SCOPED-D"]) {
        expect(err.text).toContain(marker);
      }
      const log = debugLog(layout.cwd);
      expect(log).toContain("[stdout] LEAK-A");
      expect(log).toContain("[stdout] LEAK-B");
      expect(log).toContain(`[hook ${modulePath}] SCOPED-A`);
      expect(log).toContain(`[hook ${modulePath}] SCOPED-B`);
    },
    { timeout: 60_000 }
  );

  it("X-9 positive control: without isolation the same module puts every marker on stdout", async () => {
    const layout = makeTempLayout("hooks-x9-control");
    layouts.push(layout);
    const modulePath = join(layout.root, "noisy.ts");
    writeFileSync(modulePath, NOISY_MODULE);
    const script = join(layout.root, "bare.ts");
    writeFileSync(script, `await import(${JSON.stringify(modulePath)});\n`);

    const proc = Bun.spawn(["bun", script], {
      cwd: layout.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = lineReader(proc.stdout);
    try {
      await waitFor(() => out.text.includes("SCOPED-D"), { what: "the import-time writes" });
      proc.stdin.write("a line\n");
      proc.stdin.flush();
      await waitFor(() => ["A", "B", "C", "D"].every((s) => out.text.includes(`LEAK-${s}`)), {
        what: "every LEAK marker on stdout",
      });
    } finally {
      proc.kill();
      await proc.exited;
    }
    for (const s of ["A", "B", "C", "D"]) expect(out.text).toContain(`LEAK-${s}`);
  });
});
