import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ViewClient } from "./view-client.js";

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
    const deadline = Date.now() + 2_000;
    while (s.closed() === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(s.closed()).toBe(1);
    expect(why).toBe("server_gone");
  });
});
