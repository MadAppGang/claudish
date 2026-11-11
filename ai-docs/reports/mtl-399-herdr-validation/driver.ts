// Phase 7 driver: starts the BUILT claudish MCP server over stdio and calls its tools from typed commands.
//   ls                          list_sessions (compact)
//   call <tool> <json-args>     any MCP tool, answer printed and logged
//   quit
// Every request and answer is appended to driver-log.jsonl next to this file.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const BIN = "/Users/jack/mag/claudish/.claude/worktrees/mtl-399-herdr-native-sessions/packages/cli/dist/index.js";
const LOG = join(import.meta.dir, "driver-log.jsonl");
const log = (kind: string, data: unknown) =>
  appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), kind, data })}\n`);

const server = Bun.spawn(["bun", BIN, "--mcp"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
let nextId = 1;
const pending = new Map<number, (v: any) => void>();

(async () => {
  let buf = "";
  const dec = new TextDecoder();
  for await (const chunk of server.stdout) {
    buf += dec.decode(chunk);
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      }
    }
  }
  console.log("[driver] server stdout closed");
})();

function rpc(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  server.stdin.flush();
  return new Promise((resolve) => pending.set(id, resolve));
}

async function call(name: string, args: unknown): Promise<string> {
  log("request", { name, args });
  const msg = await rpc("tools/call", { name, arguments: args });
  log("answer", { name, msg });
  const text = msg.result?.content?.map((c: any) => c.text).join("\n") ?? JSON.stringify(msg.error ?? msg);
  return text;
}

await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "phase7-driver", version: "1" },
});
server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
server.stdin.flush();
console.log(`[driver] MCP server up (pid ${server.pid}), HERDR_PANE_ID=${process.env.HERDR_PANE_ID ?? "-"}`);

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "p7> " });
rl.prompt();
for await (const line of rl) {
  const [cmd, tool, ...rest] = line.trim().split(" ");
  try {
    if (cmd === "quit") break;
    if (cmd === "ls") {
      const out = JSON.parse(await call("list_sessions", { include_completed: true }));
      for (const s of out.sessions)
        console.log(`${s.session_id ?? s.slot} ${s.model} ${s.state} ${s.activity ?? ""} view=${JSON.stringify(s.view)}`);
    } else if (cmd === "call" && tool) {
      const text = await call(tool, rest.length ? JSON.parse(rest.join(" ")) : {});
      console.log(text.length > 1500 ? `${text.slice(0, 1500)}…` : text);
    } else if (cmd) console.log("commands: ls | call <tool> <json> | quit");
  } catch (e) {
    console.log(`[driver] error: ${(e as Error).message}`);
  }
  rl.prompt();
}
server.stdin.end();
await server.exited;
process.exit(0);
