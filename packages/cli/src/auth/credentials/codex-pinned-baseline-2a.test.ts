import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../../../..");
const src = join(repo, "packages/cli/src");
const baseline = "6b572b7f3c52819134df06d4b4a5c84d7cabdf78";
// Dependency drift is measured from main; component parity keeps the pre-2a pin.
const dependencyBaseline = execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
  cwd: repo,
  encoding: "utf8",
}).trim();
const retained = [
  "auth/credentials/codex-credential.ts",
  "auth/credentials/composite-credential.ts",
  "auth/credentials/api-key-credential.ts",
  "auth/codex-oauth.ts",
  "providers/transport/openai-codex.ts",
];

function pinned(path: string, commit = baseline): string {
  return execFileSync("git", ["show", `${commit}:packages/cli/src/${path}`], {
    cwd: repo,
    encoding: "utf8",
  });
}

// Structural/component comparison, NOT separately built baseline CLI binaries.
// Copied pinned modules keep their source but resolve dependencies not retained
// above to the branch. The independent dependency guards bound that claim.
function copyPinned(root: string): void {
  for (const path of retained) {
    const destination = join(root, "pinned", path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(
      destination,
      pinned(path).replace(/(from\s+|import\s*)(["'])(\.[^"']+)\2/g, (_all, lead, quote, spec) => {
        const dependency = relative(src, resolve(src, dirname(path), spec)).replace(/\.js$/, ".ts");
        const target = retained.includes(dependency)
          ? join(root, "pinned", dependency)
          : resolve(src, dirname(path), spec).replace(/\.js$/, ".ts");
        return `${lead}${quote}${target}${quote}`;
      })
    );
  }
}

const program = String.raw`
import { Hono } from "hono";
const src = process.env.TEST_SRC;
const base = process.env.PINNED_SRC;
const { setConfigFileOverride } = await import(src + "/config-override.ts");
setConfigFileOverride(process.env.CLAUDISH_CONFIG);
const networkFetch = globalThis.fetch;
const contacts = [];
const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  contacts.push({ path: new URL(req.url).pathname, body: await req.text() });
  return Response.json({ error: "invalid_grant", error_description: "recorded simulated rejection" }, { status: 400 });
} });
const metered = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { contacts.push({ target: "metered" }); return new Response("unexpected inference"); } });
process.env.CLAUDISH_TEST_UPSTREAM = "default=" + listener.url.origin + ",api.openai.com=" + metered.url.origin;
globalThis.fetch = (input, init) => {
  if (new URL(String(input)).hostname !== "127.0.0.1") throw new Error("non-loopback request forbidden");
  return networkFetch(input, init);
};
try {
  const { makeCodexCredential } = await import(base + "/auth/credentials/codex-credential.ts");
  const { OpenAICodexTransport } = await import(base + "/providers/transport/openai-codex.ts");
  const { classifyAuthFailure, respondAuthFailure } = await import(src + "/handlers/shared/auth-failure.ts");
  const transport = new OpenAICodexTransport({ name: "openai-codex", baseUrl: "https://api.openai.com", apiPath: "/v1/responses", apiKeyEnvVar: "OPENAI_CODEX_API_KEY", prefixes: ["cx@"] }, "gpt-test", "api-test");
  const composite = makeCodexCredential();
  let auth, failure;
  try { auth = await composite.getRequestAuth({ model: "gpt-test", forceRefresh: process.env.CASE === "refresh-rejection" }); }
  catch (err) { failure = classifyAuthFailure(err); }
  if (auth && process.env.PARITY_MUTATION === "endpoint") auth.endpoint = "http://127.0.0.1/mutated";
  if (auth && process.env.PARITY_MUTATION === "header") auth.headers.Authorization = "Bearer mutated";
  if (auth && process.env.PARITY_MUTATION === "payload") auth.transformPayload = p => ({ ...p, store: true });
  const app = new Hono();
  app.get("/", c => respondAuthFailure(c, failure ?? { kind: "terminal", message: "recorded upstream rejection", upstreamStatus: 403 }, { isSubscription: true, providerDisplayName: "Codex" }));
  const response = await app.request("http://localhost/");
  if (process.env.PARITY_MUTATION === "remap") response.headers.set("x-claudish-auth-verdict", "transient");
  const payload = { model: "gpt-test", input: "simulated parity input", store: true, include: ["original"], prompt_cache_key: "stable-test-key" };
  // Rebase resolution: only the merged transport consumes AuthBinding; the pinned
  // pre-v14 transport still consumes the artifact. Keep the wire comparison intact.
  const binding = process.env.MERGED_API === "1" ? { auth } : auth;
  const endpoint = auth && transport.getEndpoint(undefined, binding);
  console.log("RESULT " + JSON.stringify({
    auth: auth && { arm: auth.arm, account: auth.account, endpoint, target: new URL(endpoint).origin === metered.url.origin ? "metered" : new URL(endpoint).origin === listener.url.origin ? "oauth" : "other", headers: await transport.getHeaders(undefined, binding), bytes: JSON.stringify(transport.transformPayload(payload, undefined, binding)) },
    failure, contacts, remap: { status: response.status, headers: Object.fromEntries(response.headers), bytes: await response.text() }
  }));
} finally { listener.stop(true); metered.stop(true); }
`;

for (const scenario of ["legacy", "api-key", "refresh-rejection"]) {
  test(`E20 pinned structural components preserve ${scenario} request/remap`, async () => {
    const root = mkdtempSync(join(tmpdir(), "claudish-2a-pinned-"));
    try {
      copyPinned(root);
      mkdirSync(join(root, ".claudish"));
      const config = join(root, "config.json");
      writeFileSync(config, "{}");
      if (scenario !== "api-key") {
        writeFileSync(
          join(root, ".claudish/codex-oauth.json"),
          JSON.stringify({
            access_token: "legacy-access",
            refresh_token: "legacy-refresh",
            expires_at: Date.now() + 3_600_000,
            account_id: "legacy-id",
          })
        );
      }
      const run = async (isPinned: boolean) => {
        const child = Bun.spawn([process.execPath, "-e", program], {
          cwd: join(repo, "packages/cli"),
          env: {
            ...process.env,
            HOME: root,
            TEST_SRC: src,
            PINNED_SRC: isPinned ? join(root, "pinned") : src,
            CASE: scenario,
            MERGED_API: isPinned ? "0" : "1",
            PARITY_MUTATION: isPinned ? "" : (process.env.ACCOUNTS_2A_PARITY_MUTATION ?? ""),
            CLAUDISH_CONFIG: config,
            CLAUDISH_ACCOUNTS_DIR: join(root, "accounts"),
            CLAUDISH_DISABLE_KEYCHAIN: "1",
            CLAUDISH_DISABLE_OP: "1",
            CLAUDISH_DISABLE_CATALOG_WARM: "1",
            CLAUDISH_TEST_UPSTREAM: "",
            CLAUDISH_ACCOUNTS_FAULT: "",
            OPENAI_CODEX_API_KEY: "api-test",
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
        return JSON.parse(line!.slice(7));
      };
      const old = await run(true);
      const current = await run(false);
      // Listener ports are the sole volatile value here; payload and headers are
      // compared without filtering. No request is sent to the inference endpoint.
      const normalizeEndpoint = (value: any) => {
        if (value.auth?.endpoint)
          value.auth.endpoint = value.auth.endpoint.replace(
            /http:\/\/127\.0\.0\.1:\d+/,
            "http://127.0.0.1:PORT"
          );
        return value;
      };
      expect(normalizeEndpoint(current)).toEqual(normalizeEndpoint(old));
      if (scenario === "refresh-rejection") {
        expect(current.failure).toMatchObject({ kind: "terminal", upstreamStatus: 401 });
        expect(current.remap.status).toBe(400);
        expect(current.contacts).toHaveLength(1);
      } else {
        expect(current.auth.arm).toBe(scenario === "legacy" ? "oauth" : "api-key");
        expect(current.auth.account).toBeUndefined();
        expect(current.contacts).toHaveLength(0);
        expect(current.auth.target).toBe(scenario === "legacy" ? "oauth" : "metered");
        expect(current.auth.headers.Authorization).toBe(
          scenario === "legacy" ? "Bearer legacy-access" : "Bearer api-test"
        );
        expect(current.auth.endpoint).toContain(
          scenario === "legacy" ? "/backend-api/codex/responses" : "/v1/responses"
        );
      }
      expect(readFileSync(config, "utf8")).toBe("{}");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

// Exact reviewed Phase 0 hunks, not a diff learned from the branch at test time.
// Reversing them must leave main's bytes, including its redaction/abort fixes.
const phase0DependencyChanges: Record<string, Array<readonly [string, string]>> = {
  "handlers/native-handler.ts": [
    [
      `import { resolveUpstreamUrl } from "../test-upstream.js";
`,
      "",
    ],
    [
      `/**
 * Response headers the native path must pass through to Claude Code.
 *
 * \`anthropic-ratelimit-unified-{5h,7d}-{utilization,reset}\` plus \`-status\` and
 * \`-representative-claim\` are the ONLY report of a claude.ai plan window that
 * exists — there is no free endpoint to poll for it — so dropping them makes
 * plan usage unobservable and makes a quota 429 indistinguishable from a
 * per-minute one. The prefix is matched rather than the exact names, because the
 * window set is the vendor's to change.
 */
function collectRateLimitHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (
      lower.startsWith("anthropic-ratelimit-") ||
      lower === "retry-after" ||
      lower === "request-id" ||
      lower === "x-request-id"
    ) {
      out[lower] = value;
    }
  });
  return out;
}

`,
      "",
    ],
    [
      `    // Always forward to the real Anthropic API (the origin the advisor's Claude
    // call uses too). \`resolveUpstreamUrl\` is a no-op unless
    // CLAUDISH_TEST_UPSTREAM names a LOOPBACK target, which is how the
    // mock-upstream e2e drives the real binary without a module mock.
    this.baseUrl = resolveUpstreamUrl(ANTHROPIC_API_ORIGIN);
`,
      `    // Always forward to real Anthropic API (the origin the advisor's Claude call uses too)
    this.baseUrl = ANTHROPIC_API_ORIGIN;
`,
    ],
    [
      `    // The body is serialized ONCE and reused byte-for-byte.
    //
    // Inline \`JSON.stringify(payload)\` at the fetch made a second attempt a
    // second serialization, and two stringifies of one object are byte-identical
    // only as long as nothing in the payload pipeline becomes non-idempotent. A
    // retry that differs by a byte is a different request to the prompt cache
    // and a different request to any signature the vendor computes over it.
    const body = JSON.stringify(payload);

`,
      "",
    ],
    [
      `        body,
`,
      `        body: JSON.stringify(payload),
`,
    ],
    [
      `      // Rate-limit and correlation headers, harvested ABOVE the branch split so
      // both branches carry them. Anthropic reports plan usage in
      // \`anthropic-ratelimit-unified-*\` (utilization, reset, status,
      // representative-claim); dropping them left a status line with nothing to
      // read and left a 429 with no reset time to report. \`request-id\` is what
      // support asks for, and \`retry-after\` is the only honest input to a
      // client's own backoff.
      const passthrough = collectRateLimitHeaders(anthropicResponse.headers);

`,
      "",
    ],
    [
      `              ...passthrough,
`,
      "",
    ],
    [
      `      const responseHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        ...passthrough,
      };
`,
      `      const responseHeaders: Record<string, string> = { "Content-Type": "application/json" };
`,
    ],
  ],
  "providers/transport/openai.ts": [
    [
      `import { resolveUpstreamUrl } from "../../test-upstream.js";
`,
      "",
    ],
    [
      `    // No-op unless CLAUDISH_TEST_UPSTREAM names a loopback target. This is the
    // METERED host for \`openai-codex\` (api.openai.com), which the e2e matrix
    // points at a recording canary listener so that "claudish contacted the
    // metered path" is an OBSERVED event rather than an absence.
    return resolveUpstreamUrl(\`\${this.provider.baseUrl}\${this.provider.apiPath}\`);
`,
      `    return \`\${this.provider.baseUrl}\${this.provider.apiPath}\`;
`,
    ],
  ],
};

function withoutPhase0Changes(path: string, source: string): string {
  let normalized = source;
  for (const [addition, original] of phase0DependencyChanges[path] ?? []) {
    expect(
      normalized.split(addition),
      `${path}: expected exactly one declared Phase 0 hunk`
    ).toHaveLength(2);
    normalized = normalized.replace(addition, original);
  }
  return normalized;
}

for (const path of [
  "handlers/native-handler.ts",
  "handlers/shared/auth-failure.ts",
  "handlers/shared/anthropic-error.ts",
  "providers/transport/openai.ts",
  "adapters/codex-api-format.ts",
]) {
  const property = phase0DependencyChanges[path]
    ? "differs from main only by declared Phase 0 hunks"
    : "unchanged from main";
  test(`E20 structural dependency ${property}: ${path}`, () => {
    expect(withoutPhase0Changes(path, readFileSync(join(src, path), "utf8"))).toBe(
      pinned(path, dependencyBaseline)
    );
  });
}
