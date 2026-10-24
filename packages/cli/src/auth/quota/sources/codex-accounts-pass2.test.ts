import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const src = resolve(import.meta.dir, "../../..");
const program = String.raw`
import * as fs from "node:fs";
import { spyOn } from "bun:test";
const src = process.env.TEST_SRC;
const root = process.env.HOME;
const scenario = process.env.SCENARIO;
fs.mkdirSync(root + "/.claudish", { recursive: true });
fs.mkdirSync(root + "/.codex", { recursive: true });
const legacy = root + "/.claudish/codex-oauth.json";
fs.writeFileSync(legacy, JSON.stringify({ access_token: "legacy-test-access", refresh_token: "legacy-test-refresh", expires_at: Date.now() + 3600000, account_id: "legacy-test-id" }));
fs.writeFileSync(root + "/.codex/models_cache.json", JSON.stringify({ models: [{ slug: "simulated-discovered-model" }] }));
const config = root + "/config.json";
const count = scenario === "single" ? 1 : scenario === "multi" ? 2 : 0;
fs.writeFileSync(config, JSON.stringify(scenario === "legacy" || scenario === "unknown" ? {} : { subscriptionAccounts: { "openai-codex": { generation: 1, accounts: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"].slice(0, count).map((id, i) => ({ id, label: "account-" + i, store: "file", addedAt: "2026-09-12T00:00:00Z" })), ...(scenario === "suppressed" ? { legacyCodexSuppressed: true } : {}) } } }));
const { AccountRegistry, setAccountRegistryForTests } = await import(src + "/auth/accounts/registry.ts");
const registry = new AccountRegistry({ configPath: () => config, legacyCodexPath: () => legacy, ...(scenario === "unknown" ? { readFile: path => { if (path === config) throw Object.assign(new Error("simulated config EIO"), { code: "EIO" }); return fs.readFileSync(path, "utf8"); } } : {}) });
setAccountRegistryForTests(registry);
try { registry.isSynthesizedLegacyOnly(); } catch {}
if (process.env.MUTATION === "remove-reader-guard") registry.isSynthesizedLegacyOnly = () => true;
const { codexQuotaAdapter } = await import(src + "/auth/quota/sources/codex.ts");
let legacyReads = 0, contacts = 0;
const readFile = fs.readFileSync;
const spy = spyOn(fs, "readFileSync").mockImplementation((path, ...args) => {
  if (String(path) === legacy) legacyReads++;
  return readFile(path, ...args);
});
// Prove this spy is connected to the builtin before trusting zero counts.
fs.readFileSync(legacy, "utf8");
const calibration = legacyReads;
legacyReads = 0;
const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
  contacts++;
  if (req.headers.get("authorization") !== "Bearer legacy-test-access") return new Response("wrong credential", { status: 400 });
  return new Response("simulated explicit response", { headers: { "x-codex-primary-used-percent": "25", "x-codex-primary-window-minutes": "300" } });
} });
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(String(input));
  if (url.href !== "https://chatgpt.com/backend-api/codex/responses") throw new Error("unexpected probe target");
  return realFetch(new URL(url.pathname, listener.url), init);
};
try {
  const result = await codexQuotaAdapter.fetchExplicit();
  console.log("RESULT " + JSON.stringify({ calibration, legacyReads, contacts, result }));
} finally { spy.mockRestore(); listener.stop(true); }
`;

for (const scenario of ["single", "multi", "suppressed", "unknown", "legacy"]) {
  test(`E19 actual fetchExplicit ${scenario} guards legacy credential read before probe`, async () => {
    const root = mkdtempSync(join(tmpdir(), "claudish-2a-reader-"));
    try {
      const child = Bun.spawn([process.execPath, "-e", program], {
        cwd: resolve(src, ".."),
        env: {
          ...process.env,
          HOME: root,
          TEST_SRC: src,
          SCENARIO: scenario,
          MUTATION: process.env.ACCOUNTS_2A_READER_MUTATION ?? "",
          CLAUDISH_CONFIG: join(root, "config.json"),
          CLAUDISH_ACCOUNTS_DIR: join(root, "accounts"),
          CLAUDISH_DISABLE_KEYCHAIN: "1",
          CLAUDISH_DISABLE_OP: "1",
          CLAUDISH_DISABLE_CATALOG_WARM: "1",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exit, stderr).toBe(0);
      const line = stdout.split("\n").find((line) => line.startsWith("RESULT "));
      expect(line, stdout + stderr).toBeDefined();
      const result = JSON.parse(line!.slice(7));
      expect(result.calibration).toBe(1);
      expect(result.legacyReads).toBe(scenario === "legacy" ? 1 : 0);
      expect(result.contacts).toBe(scenario === "legacy" ? 1 : 0);
      if (scenario === "legacy") expect(result.result.windows[0].used_pct).toBe(25);
      else expect(result.result).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
