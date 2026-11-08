/**
 * Egress sink: a loopback TCP listener used as `HTTP_PROXY` / `HTTPS_PROXY` for a
 * row, with `NO_PROXY=127.0.0.1,localhost`. Loopback traffic (the fake, the
 * canary) bypasses it; anything a process tries to send to a non-loopback host
 * lands here, is recorded (host and port from `CONNECT` or the absolute request
 * URI) and is refused with 502. An empty list is the evidence "no proxy-honouring
 * client left the machine". It does not see a client that ignores proxy
 * variables; `egress-sink` is paired with `lsof` sampling in the driver.
 */

import { appendFileSync } from "node:fs";
import net from "node:net";

export interface EgressAttempt {
  at: number;
  method: string;
  target: string;
}

export interface EgressSink {
  port: number;
  attempts: EgressAttempt[];
  stop(): void;
}

export async function startEgressSink(logPath: string): Promise<EgressSink> {
  const attempts: EgressAttempt[] = [];
  const server = net.createServer((socket) => {
    let seen = false;
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      if (seen) return;
      seen = true;
      const line = chunk.toString("latin1").split("\r\n")[0] ?? "";
      const [method = "?", target = "?"] = line.split(" ");
      const attempt = { at: Date.now(), method, target };
      attempts.push(attempt);
      appendFileSync(logPath, `${JSON.stringify(attempt)}\n`);
      socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return { port, attempts, stop: () => server.close() };
}
