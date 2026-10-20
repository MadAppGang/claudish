#!/usr/bin/env bun
/**
 * Test-only: run INSIDE a magmux pane (ambient mode). Finds this process's own pane
 * through `MAGMUX_SOCK` with the production rule (`findOwnPane`) and writes the answer,
 * with the pane list it saw, as JSON to argv[2]. Then idles so the pane stays alive
 * until the test reads the file.
 */

import { writeFileSync } from "node:fs";
import { MagmuxClient } from "../../../pane/magmux-client.js";
import { findOwnPane } from "../../../pane/own-pane.js";

const out = process.argv[2] as string;
const sock = process.env.MAGMUX_SOCK;
if (!sock) {
  writeFileSync(out, JSON.stringify({ error: "no MAGMUX_SOCK" }));
  process.exit(0);
}
const client = await MagmuxClient.connect(sock, { timeoutMs: 5_000 });
let listed: unknown = null;
const pane = await findOwnPane(async () => {
  const r = await client.request({ type: "list" });
  listed = r.ok ? r.result : null;
  return listed;
});
writeFileSync(out, JSON.stringify({ pane, listed, pid: process.pid }));
client.close();
setTimeout(() => process.exit(0), 20_000);
