/**
 * Builds the Herdr.app mod: `src/herdr/app-mod/main.ts` and what it imports (the shared state
 * map, the mod's model and controller) into one ES module at `herdr-app-mod/claudish/main.js`,
 * next to a copy of `mod.json`. The host's own modules stay imports: Herdr.app provides `herdr`,
 * `gpui-kit`, `gpui-base` and `crypto` to every mod.
 *
 *   bun run scripts/build-herdr-app-mod.ts [outdir]   default: herdr-app-mod/claudish
 */
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = join(import.meta.dir, "..");
const src = join(root, "src/herdr/app-mod");
const outdir = resolve(root, process.argv[2] ?? "herdr-app-mod/claudish");

const HOST_MODULES = ["herdr", "gpui-kit", "gpui-base", "crypto"];

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(src, "main.ts")],
  outdir,
  naming: "main.js",
  format: "esm",
  target: "browser",
  minify: false,
  sourcemap: "none",
  plugins: [
    {
      // `external` alone is not enough: the browser target swaps `crypto` for a bundled polyfill
      name: "herdr-host-modules",
      setup(build) {
        build.onResolve({ filter: /^(herdr|gpui-kit|gpui-base|crypto)$/ }, (args) => ({
          path: args.path,
          external: true,
        }));
      },
    },
  ],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
copyFileSync(join(src, "mod.json"), join(outdir, "mod.json"));

// the bundle may import nothing but the host's modules: anything else would not resolve in Herdr
const text = await Bun.file(join(outdir, "main.js")).text();
const imported = [...text.matchAll(/^import\s[^;]*?from\s*"([^"]+)"/gm)].map((m) => m[1]);
const foreign = imported.filter((m) => !HOST_MODULES.includes(m ?? ""));
if (foreign.length > 0) {
  console.error(`herdr app mod imports modules Herdr does not provide: ${foreign.join(", ")}`);
  process.exit(1);
}
console.log(`herdr app mod: ${join(outdir, "main.js")} (${text.length} bytes)`);
