import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endpointNameOf } from "./endpoints.js";
import { ViewClient } from "./view-client.js";

// the waits below are upper bounds; a loaded CI runner needs more than bun's 5 s per test
setDefaultTimeout(30_000);

let server: Server | null = null;
let dir: string | null = null;
afterEach(() => {
  server?.close();
  server = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** A raw endpoint: `onLine` answers each request line the client sends. */
async function rawServer(
  onLine: (sock: Socket, m: { id: number; op: string }) => void
): Promise<{ path: string; closed: () => number }> {
  dir = mkdtempSync(join(tmpdir(), "vc-"));
  const path = join(dir, "e.sock");
  let closed = 0;
  server = createServer((sock) => {
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        onLine(sock, JSON.parse(line));
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      closed += 1;
    });
  });
  await new Promise<void>((resolve) => server?.listen(path, resolve));
  return { path, closed: () => closed };
}

describe("ViewClient", () => {
  test("a refused hello closes the socket it dialed", async () => {
    const s = await rawServer((sock, m) =>
      sock.write(
        `${JSON.stringify({ id: m.id, ok: false, error: { code: "invalid_args", message: "no" } })}\n`
      )
    );
    await expect(
      ViewClient.connect(s.path, { hello: { name: "t", kind: "viewer" } })
    ).rejects.toThrow("no");
    const deadline = Date.now() + 1_000;
    while (s.closed() === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(s.closed()).toBe(1);
  });

  test("an unterminated line over the cap drops the connection instead of growing", async () => {
    const s = await rawServer((sock) => {
      sock.write("x".repeat(17 * 1024 * 1024));
    });
    const client = await ViewClient.connect(s.path);
    let why = "open";
    client.on("closed", (reason) => {
      why = reason;
    });
    await expect(client.request("list")).rejects.toThrow();
    // a 17 MB write to a dropped socket can take seconds to fail on a loaded machine
    const deadline = Date.now() + 10_000;
    while (s.closed() === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(s.closed()).toBe(1);
    expect(why).toBe("server_gone");
  });

  test("a server at its connection cap gets one reconnect loop, and close() ends every socket", async () => {
    dir = mkdtempSync(join(tmpdir(), "vc-"));
    // named for this process, so the reconnect loop judges the owner alive
    const path = join(dir, endpointNameOf());
    let capped = false;
    let refusedDials = 0;
    const open = new Set<Socket>();
    server = createServer((sock) => {
      sock.setEncoding("utf8");
      sock.on("error", () => {});
      if (capped) {
        refusedDials += 1;
        sock.end(
          `${JSON.stringify({ id: 0, ok: false, error: { code: "too_many_connections", message: "full" } })}\n`
        );
        return;
      }
      open.add(sock);
      sock.on("close", () => open.delete(sock));
      let buf = "";
      sock.on("data", (chunk: string) => {
        buf += chunk;
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const m = JSON.parse(buf.slice(0, nl)) as { id: number };
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
          sock.write(`${JSON.stringify({ id: m.id, ok: true, result: {} })}\n`);
        }
      });
    });
    await new Promise<void>((resolve) => server?.listen(path, resolve));
    const client = await ViewClient.connect(path, {
      reconnect: true,
      hello: { name: "t", kind: "viewer" },
    });
    let reconnected = 0;
    client.on("reconnected", () => {
      reconnected += 1;
    });
    capped = true;
    for (const sock of open) sock.destroy();
    await Bun.sleep(2_500);
    // one loop backs off 200, 400, 800 ms: three dials, a fourth if `ps` is fast
    expect(refusedDials).toBeLessThanOrEqual(5);
    capped = false;
    const deadline = Date.now() + 8_000;
    while (reconnected === 0 && Date.now() < deadline) await Bun.sleep(20);
    await Bun.sleep(300);
    expect(reconnected).toBe(1);
    expect(open.size).toBe(1);
    client.close();
    const closedBy = Date.now() + 1_000;
    while (open.size > 0 && Date.now() < closedBy) await Bun.sleep(10);
    expect(open.size).toBe(0);
  }, 20_000);
});
