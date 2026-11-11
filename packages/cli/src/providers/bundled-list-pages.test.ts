import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// R1 / architecture §3 uses these same public pinned-pagination helpers; the
// builder itself accepts complete inputs and has no cursor/total fields.
const cases = [
  ["valid pages", "ok"],
  ["bad envelope", "incompatible"],
  ["generation changes", "generation_mismatch"],
  ["total changes", "incomplete"],
  ["too few rows", "incomplete"],
  ["duplicate model id", "incomplete"],
  ["repeated cursor", "incomplete"],
] as const;

for (const [scenario, expected] of cases) {
  test(`R1: generation-pinned fetch returns ${expected} for ${scenario}`, async () => {
    const home = mkdtempSync(join(tmpdir(), "bundled-list-pages-"));
    const script = `
      import assert from "node:assert/strict";
      import { readFileSync } from "node:fs";
      const cache = JSON.parse(readFileSync(${JSON.stringify(new URL("../test-fixtures/catalog-v3/wire-g-20261012101007285-7770c36e.json", import.meta.url).pathname)}, "utf8"));
      const scenario = process.env.PAGE_SCENARIO;
      const expected = process.env.PAGE_EXPECTED;
      let calls = 0;
      globalThis.fetch = async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        assert.equal(url.hostname, "pagination.invalid");
        assert.equal(url.searchParams.get("generationId"), cache.catalogGenerationId);
        calls++;
        assert.ok(calls < 5, "pagination failed to reject a cursor loop");
        const second = url.searchParams.has("cursor");
        const data = {
          mode: "slim",
          models: [cache.entries[second ? 1 : 0]],
          total: 2,
          ...(!second ? { nextCursor: "second" } : {}),
        };
        let generationId = cache.catalogGenerationId;
        if (scenario === "generation changes" && second) generationId = "another-generation";
        if (scenario === "total changes" && second) data.total = 3;
        if (scenario === "too few rows") delete data.nextCursor;
        if (scenario === "duplicate model id" && second) data.models = [cache.entries[0]];
        if (scenario === "repeated cursor") {
          data.models = [cache.entries[calls - 1]];
          data.nextCursor = "second";
          data.total = cache.entries.length;
        }
        return Response.json({
          contractVersion: scenario === "bad envelope" ? 2 : 3,
          generationId, generatedAt: cache.lastUpdated, data,
        });
      };
      const { fetchAllModelPages } = await import(${JSON.stringify(new URL("./catalog-client.ts", import.meta.url).href)});
      const result = await fetchAllModelPages(
        "https://pagination.invalid/queryModels?catalog=slim", 1, 1000, cache.catalogGenerationId
      );
      if (expected === "ok") {
        assert.equal(result.ok, true);
        assert.deepEqual(result.entries.map((entry) => entry.modelId), cache.entries.slice(0,2).map((entry) => entry.modelId));
        assert.equal(result.generationId, cache.catalogGenerationId);
        assert.equal(calls, 2);
      } else {
        assert.equal(result.ok, false);
        assert.equal(result.reason, expected);
      }
      process.stdout.write("pagination passed");
      process.exit(0);
    `;
    try {
      const result = Bun.spawnSync([process.execPath, "--no-env-file", "-e", script], {
        cwd: home,
        env: {
          HOME: home,
          PATH: process.env.PATH ?? "",
          CLAUDISH_DISABLE_KEYCHAIN: "1",
          CLAUDISH_DISABLE_OP: "1",
          CLAUDISH_DISABLE_CATALOG_WARM: "1",
          CLAUDISH_DISABLE_BUNDLED_LIST: "1",
          PAGE_SCENARIO: scenario,
          PAGE_EXPECTED: expected,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      });
      expect({
        exitCode: result.exitCode,
        output: result.stdout.toString(),
        error: result.exitCode === 0 ? "" : result.stderr.toString(),
      }).toEqual({ exitCode: 0, output: "pagination passed", error: "" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}
