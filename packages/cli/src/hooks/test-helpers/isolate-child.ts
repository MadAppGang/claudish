/**
 * Spawned by output-capture.test.ts (X-12): isolate protocol stdout for real,
 * then write one large frame through `protocolOut` while every other stdout
 * route is exercised. The parent pipes stdout and starts reading late.
 *
 * argv: <frame bytes>
 * cwd:  a temp dir — the debug log is written to <cwd>/logs/.
 */

import { writeSync } from "node:fs";
import { initLogger } from "../../logger.js";
import { isolateProtocolStdout, runInHookScope } from "../output-capture.js";

initLogger(true, "debug", true);
const iso = isolateProtocolStdout();
process.stderr.write(`ACTIVE ${iso.active}\n`);

// Every route but the protocol writer must miss stdout.
console.log("NOISE-CONSOLE");
console.info("NOISE-INFO");
process.stdout.write("NOISE-WRITE\n");
writeSync(1, "NOISE-FD\n");
await Bun.write(Bun.stdout, "NOISE-BUNWRITE\n");
runInHookScope("hook:x/y", () => console.log("SCOPED-CONSOLE"));

const size = Number(process.argv[2] ?? 4 * 1024 * 1024);
const frame = Buffer.alloc(size, "x");
frame.write("{", 0);
frame.write("}", size - 2);
frame.write("\n", size - 1);

await new Promise<void>((resolve, reject) => {
  iso.protocolOut.write(frame, (err) => (err ? reject(err) : resolve()));
});
process.stderr.write("CALLBACK\n");
await Bun.sleep(200);
process.exit(0);
