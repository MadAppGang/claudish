/**
 * S1 probe: can a claudish build load a user hook module from outside its own
 * bundle?
 *
 * This is the loading mechanism `hooks/loader.ts` will use (architecture §9),
 * reduced to what S1 measures. Before importing anything it registers a
 * `Bun.plugin` runtime plugin that answers the bare specifier `claudish/hooks`
 * with the HOST's own exports, so a hook author needs nothing installed. Then it
 * `import()`s each file by absolute `file://` URL, as the loader will.
 *
 * `s1-loading.test.ts` runs this entry from source, as a `--target bun` bundle
 * (the `dist/` route the npm install takes) and as a `--compile` binary (the
 * release asset route). It imports nothing from claudish, so it builds and runs
 * anywhere Bun does.
 *
 * Input:  S1_HOOK_FILES — JSON array of absolute paths
 *         S1_NO_PLUGIN=1 — skip the plugin (control: the value import must fail)
 * Output: one JSON line on stdout, `ProbeReport`.
 */

import { pathToFileURL } from "node:url";

/** Stamped by the host's `defineHook`, so a hook proves which module it got. */
const HOST_MARKER = "claudish-s1-host";

export interface ProbeResult {
  file: string;
  ok: boolean;
  /** `default.id` of the loaded module. */
  id?: string;
  /** True when the module's `claudish/hooks` value import resolved to the host. */
  viaHost?: boolean;
  error?: string;
}

export interface ProbeReport {
  bun: string;
  platform: string;
  arch: string;
  pluginRegistered: boolean;
  results: ProbeResult[];
}

const hostExports = {
  HOOK_API_VERSION: 1,
  defineHook: <T extends object>(definition: T) => ({ ...definition, host: HOST_MARKER }),
  act: {},
};

async function main(): Promise<void> {
  const files = JSON.parse(process.env.S1_HOOK_FILES ?? "[]") as string[];
  const pluginRegistered = process.env.S1_NO_PLUGIN !== "1";

  if (pluginRegistered) {
    Bun.plugin({
      name: "claudish-hooks-virtual-module",
      setup(build) {
        build.module("claudish/hooks", () => ({ exports: hostExports, loader: "object" }));
      },
    });
  }

  const results: ProbeResult[] = [];
  for (const file of files) {
    try {
      const mod = await import(pathToFileURL(file).href);
      const definition = mod.default as { id?: string; host?: string } | undefined;
      results.push({
        file,
        ok: true,
        id: definition?.id,
        viaHost: definition?.host === HOST_MARKER,
      });
    } catch (err) {
      results.push({ file, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const report: ProbeReport = {
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    pluginRegistered,
    results,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

// Unconditional: an entry point only. The test imports its types, never its values.
await main();
