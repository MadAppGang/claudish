import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  OUTPUT_CAPTURE,
  Workspace,
  hook,
  rpc,
  rpcLines,
  startProxy,
  textOf,
  until,
} from "./support.ts";

const escapeModule = `import {writeSync} from "node:fs";
function write(prefix){
  console.log(prefix+"-A");
  process.stdout.write(prefix+"-B\\n");
  writeSync(1,prefix+"-C\\n");
  void Bun.write(Bun.stdout,prefix+"-D\\n");
}
process.stdin.on("data",()=>write("LEAK"));
process.on("SIGUSR2",()=>write("LEAK"));
setTimeout(()=>write("SCOPED"),20);
export default {apiVersion:1,id:"escape",on:{sessionStart(){}}};`;

describe("FR-7 / FR-8 / FR-9 protocol output isolation (§4.2, §4.10, §11.5)", () => {
  test("O-1 import, handler and inherited timer output reach debug, never the child screen", async () => {
    const code = `console.log("IMPORT-OUTPUT");
      ${hook('request(ctx){console.log("CALL-LOG");console.info("CALL-INFO");console.debug("CALL-DEBUG");console.warn("CALL-WARN");console.error("CALL-ERROR");process.stdout.write("CALL-STDOUT\\n");process.stderr.write("CALL-STDERR\\n");ctx.log("CTX-LOG");setTimeout(()=>console.log("TIMER-OUTPUT"),20);return []}')} `;
    const f = await startProxy({ modules: [{ name: "chatty.ts", code }] });
    try {
      expect(textOf(await f.read())).toBe("original");
      const markers = [
        "IMPORT-OUTPUT",
        "CALL-LOG",
        "CALL-INFO",
        "CALL-DEBUG",
        "CALL-WARN",
        "CALL-ERROR",
        "CALL-STDOUT",
        "CALL-STDERR",
        "CTX-LOG",
        "TIMER-OUTPUT",
      ];
      await until(
        () => markers.every((marker) => f.ws.debug().includes(marker)),
        "all captured hook output"
      );
      const debug = f.ws.debug();
      for (const marker of markers) {
        expect(f.process.stdout).not.toContain(marker);
        expect(f.process.stderr).not.toContain(marker);
        expect(debug).toContain(marker);
      }
      expect(debug).toMatch(/\[hook hook:chatty\/test\][^\n]*TIMER-OUTPUT/);
      expect(debug).toMatch(/\[hook hook:chatty\/test\][^\n]*CTX-LOG/);
    } finally {
      await f.close();
    }
  }, 20000);
  test("X-9 stdin/signal/timer escape routes stay off MCP stdout while four requests answer", async () => {
    const ws = new Workspace();
    try {
      const mod = ws.module("escape.ts", escapeModule);
      ws.save({ hooks: { modules: [mod] } });
      const p = ws.spawn(["--config", ws.configFile, "--mcp", "--debug-claudish"]);
      rpc(p, 1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "blind-hook-test", version: "1" },
      });
      await until(
        () => p.stdout.includes('"id":1') || p.stdout.includes('"id": 1'),
        "MCP initialization response"
      );
      p.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      rpc(p, 2, "tools/list", {});
      rpc(p, 3, "ping", {});
      await until(() => ws.debug().includes("SCOPED-A"), "import-timer output in debug log");
      expect(p.child.kill("SIGUSR2")).toBe(true);
      rpc(p, 4, "tools/list", {});
      await until(() => {
        try {
          return [1, 2, 3, 4].every((id) => rpcLines(p.stdout).some((row) => row.id === id));
        } catch {
          return false;
        }
      }, "all four MCP responses");
      await until(
        () =>
          ["LEAK-C", "LEAK-D", "SCOPED-C", "SCOPED-D"].every((marker) => p.stderr.includes(marker)),
        "descriptor writes on stderr"
      );
      await until(
        () =>
          ws.debug().includes("LEAK-A") &&
          ws.debug().includes("LEAK-B") &&
          ws.debug().includes("SCOPED-B"),
        "captured scoped and unscoped debug writes"
      );

      const lines = rpcLines(p.stdout);
      expect(lines.length).toBeGreaterThanOrEqual(4);
      for (const line of lines) expect(line.jsonrpc).toBe("2.0");
      for (const id of [1, 2, 3, 4]) {
        const answer = lines.filter((row) => row.id === id);
        expect(answer).toHaveLength(1);
        expect(answer[0]).toHaveProperty("result");
        expect(answer[0]).not.toHaveProperty("error");
      }
      expect(p.stdout).not.toMatch(/LEAK|SCOPED/);
      const debug = ws.debug();
      expect(debug).toMatch(/\[stdout\][^\n]*LEAK-A/);
      expect(debug).toMatch(/\[stdout\][^\n]*LEAK-B/);
      expect(debug).toMatch(/\[hook [^\]\n]*escape[^\]\n]*\][^\n]*SCOPED-A/);
      expect(debug).toMatch(/\[hook [^\]\n]*escape[^\]\n]*\][^\n]*SCOPED-B/);
    } finally {
      await ws.close();
    }
  }, 30000);

  test("X-9 positive control: bare Bun import really emits all four LEAK routes to stdout", async () => {
    const ws = new Workspace();
    try {
      const mod = ws.module("escape.ts", escapeModule);
      const entry = ws.file(
        "bare.ts",
        `await import(${JSON.stringify(mod)});process.stderr.write("READY\\n");setTimeout(()=>process.exit(0),2000);`
      );
      const p = ws.track([process.execPath, "--no-env-file", entry]);
      await until(() => p.stderr.includes("READY"), "bare module registration");
      p.write("trigger\n");
      await until(
        () => ["LEAK-A", "LEAK-B", "LEAK-C", "LEAK-D"].every((marker) => p.stdout.includes(marker)),
        "all four bare stdout leaks"
      );
      for (const marker of ["LEAK-A", "LEAK-B", "LEAK-C", "LEAK-D"])
        expect(p.stdout).toContain(marker);
      expect(() => rpcLines(p.stdout)).toThrow();
    } finally {
      await ws.close();
    }
  }, 15000);

  test("X-11 seam: failed libc binding reports inactive without redirecting stdout", async () => {
    const ws = new Workspace();
    try {
      const entry = ws.file(
        "inactive.ts",
        `import {isolateProtocolStdout} from ${JSON.stringify(OUTPUT_CAPTURE)};
        const out=isolateProtocolStdout({bind(){throw new Error("no ffi")}});
        process.stdout.write(JSON.stringify({active:out.active,same:out.protocolOut===process.stdout})+"\\n");
        console.log("STDOUT-UNTOUCHED");`
      );
      const p = ws.track([process.execPath, "--no-env-file", entry]);
      expect(await p.finish()).toBe(0);
      expect(p.stdout).toBe('{"active":false,"same":true}\nSTDOUT-UNTOUCHED\n');
    } finally {
      await ws.close();
    }
  }, 15000);

  test("X-12 4 MiB protocol frame survives a reader starting one second late and callback fires", async () => {
    const ws = new Workspace();
    const size = 4 * 1024 * 1024;
    const makeFrame = (n: number) => {
      const head = '{"jsonrpc":"2.0","id":1,"result":{"text":"';
      const tail = '"}}\n';
      return head + "x".repeat(n - Buffer.byteLength(head + tail)) + tail;
    };
    const expected = Buffer.from(makeFrame(size));
    const script = ws.file(
      "backpressure.ts",
      `import {isolateProtocolStdout} from ${JSON.stringify(OUTPUT_CAPTURE)};
      const out=isolateProtocolStdout();
      if(!out.active){process.stderr.write("ISOLATION-INACTIVE\\n");process.exit(2)}
      const head='{"jsonrpc":"2.0","id":1,"result":{"text":"';const tail='"}}\\n';
      const frame=head+"x".repeat(${size}-Buffer.byteLength(head+tail))+tail;
      out.protocolOut.write(frame,err=>{if(err){process.stderr.write(String(err));process.exit(1)}process.stderr.write("WRITE-CALLBACK\\n");process.exit(0)});`
    );
    const child = spawn(process.execPath, ["--no-env-file", script], {
      cwd: ws.layout.cwd,
      env: ws.layout.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let closed = false;
    let stderr = "";
    const received: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exit = new Promise<number>((yes, no) => {
      child.once("error", no);
      child.once("close", (code) => {
        closed = true;
        yes(code ?? -1);
      });
    });
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 12000);
    try {
      child.stdout.pause();
      await Bun.sleep(1000); // This delay is the X-12 input, not an eventual-consistency guess.
      child.stdout.on("data", (chunk: Buffer) => received.push(Buffer.from(chunk)));
      child.stdout.resume();
      expect(await exit).toBe(0);
      expect(Buffer.concat(received)).toEqual(expected);
      expect(stderr.split("\n").filter((line) => line === "WRITE-CALLBACK")).toEqual([
        "WRITE-CALLBACK",
      ]);
      expect(JSON.parse(Buffer.concat(received).toString()).id).toBe(1);
    } finally {
      clearTimeout(watchdog);
      if (!closed) {
        child.kill("SIGKILL");
        await exit;
      }
      await ws.close();
    }
  }, 20000);
});
