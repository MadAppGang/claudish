/**
 * Spawned by loader.test.ts and output-capture.test.ts: load hook modules
 * through the real loader in one host mode, run one event, and report.
 *
 * argv: <mode: "interactive" | "mcp-unbound"> <module path>...
 * cwd:  a temp dir — the debug log is written to <cwd>/logs/.
 * Output: one line `REPORT <json>` on STDERR, so stdout stays exactly what the
 * hooks left on it (the assertion is that they left nothing).
 */

import { initLogger } from "../../logger.js";
import { HookEngine } from "../engine.js";
import { loadUserHooks } from "../loader.js";
import { isolateProtocolStdout } from "../output-capture.js";
import { HookRegistry } from "../registry.js";

const [mode, ...modules] = process.argv.slice(2);
initLogger(true, "debug", true);

let isolation: { active: boolean; sameAsStdout: boolean } | null = null;
if (mode === "mcp-unbound") {
  const iso = isolateProtocolStdout({
    bind: () => {
      throw new Error("no ffi");
    },
  });
  isolation = { active: iso.active, sameAsStdout: iso.protocolOut === process.stdout };
}

const hostMode = mode === "interactive" ? "interactive" : "mcp";
const load = await loadUserHooks({ modules, configDir: process.cwd(), hostMode });
// A second load in the same process must not print the mcp refusal again.
if (hostMode === "mcp") await loadUserHooks({ modules, configDir: process.cwd(), hostMode });

const engine = new HookEngine({
  registry: new HookRegistry([], load.hooks, undefined),
  config: {},
  hostMode,
  journalSink: () => {},
  drainTelemetryOutbox: false,
});
const route = { modelId: "m", provider: "p", native: false };
const result = await engine.runChain(
  "request",
  engine.select("request", { route }),
  { context: (_a, base) => ({ ...base, event: "request", route }) },
  { model: "m", provider: "p" },
  { initial: undefined }
);

// Let timers the hooks scheduled fire, and the logger's interval flush run.
await Bun.sleep(300);
const report = {
  hooks: load.hooks.map((h) => h.id),
  errors: load.errors,
  statuses: result.runs.map((r) => r.status),
  isolation,
};
process.stderr.write(`REPORT ${JSON.stringify(report)}\n`);
process.exit(0);
