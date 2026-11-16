import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedFile } from "../test-helpers/claude-behaviour.js";
import {
  fakeClaude,
  json,
  put,
  runProgram,
  useSandbox,
} from "../test-helpers/model-lineup-blind.js";

interface ChildRecord {
  args: string[];
  settings: Record<string, unknown>;
  env: Record<string, string>;
}

await isolatedFile(import.meta, async () => {
  const sandbox = useSandbox();
  const { MODEL_RESTORE_PROMISE } = await import("./model-lineup.js");
  const cli = fileURLToPath(new URL("../index.ts", import.meta.url));

  function upstream() {
    const requests: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests.push(new URL(request.url).pathname);
        return Response.json({
          object: "list",
          data: [
            { id: "start", object: "model" },
            { id: "other", object: "model" },
          ],
        });
      },
    });
    return { server, requests };
  }

  function endpoint(port: number, declared = true) {
    const { home, configFile } = sandbox();
    const config = {
      customEndpoints: {
        "blind-gw": {
          kind: "simple",
          url: "http://127.0.0.1:" + port + "/v1",
          format: "openai",
          authScheme: "none",
          ...(declared ? { models: ["start", "other"] } : {}),
        },
      },
    };
    put(configFile, config);
    put(join(home, ".claudish", "config.json"), config);
  }

  // REQ-39. A bad symlink target triggers stat's ENOTDIR/EACCES while leaving the
  // unrelated temp-settings directory writable, so this isolates the ledger failure.
  for (const code of ["ENOTDIR", "EACCES"] as const) {
    test.skipIf(code === "EACCES" && (process.platform === "win32" || process.getuid?.() === 0))(
      "TEST-62 interactive ledger " +
        code +
        " still spawns Claude and leaves its proxy closed at exit",
      async () => {
        const { home, ledgerPath } = sandbox();
        const { server } = upstream();
        endpoint(server.port!);
        const targetParent = join(home, "ledger-target-parent");
        if (code === "ENOTDIR") put(targetParent, "regular file");
        else {
          mkdirSync(targetParent);
          put(join(targetParent, "restore.json"), "{}");
          chmodSync(targetParent, 0o000);
        }
        symlinkSync(join(targetParent, "restore.json"), ledgerPath);
        const fake = fakeClaude(home);
        try {
          const result = await runProgram(
            home,
            [cli, "--no-auto-approve", "--model", "blind-gw@start"],
            fake
          );
          expect(existsSync(fake.T_CHILD_RECORD!), result.stdout + result.stderr).toBe(true);
          expect(result.code, result.stdout + result.stderr).toBe(0);
          const record = json<ChildRecord>(fake.T_CHILD_RECORD!);
          const proxyUrl = record.env.ANTHROPIC_BASE_URL;
          expect(["127.0.0.1", "localhost", "[::1]", "::1"]).toContain(new URL(proxyUrl).hostname);
          await expect(
            fetch(proxyUrl + "/v1/models", { signal: AbortSignal.timeout(1000) })
          ).rejects.toThrow();
        } finally {
          if (code === "EACCES") chmodSync(targetParent, 0o700);
          await server.stop(true);
        }
      },
      30_000
    );
  }

  // REQ-36, REQ-38
  test.each([true, false])(
    "TEST-63 interactive restore promise is printed only for registered=%s",
    async (registered) => {
      const { home, ledgerPath } = sandbox();
      const { server } = upstream();
      endpoint(server.port!);
      if (!registered) put(ledgerPath, '{"version":2,"entries":{}}');
      const fake = fakeClaude(home);
      try {
        const result = await runProgram(
          home,
          [cli, "--no-auto-approve", "--model", "blind-gw@start", "--model", "blind-gw@"],
          fake
        );
        expect(result.code, result.stdout + result.stderr).toBe(0);
        expect(existsSync(fake.T_CHILD_RECORD!), result.stdout + result.stderr).toBe(true);
        const text = result.stdout + result.stderr;
        if (registered) {
          expect(text.split(MODEL_RESTORE_PROMISE)).toHaveLength(2);
        } else {
          expect(text).not.toContain(MODEL_RESTORE_PROMISE);
          expect(text).toContain(ledgerPath);
          expect(text).toContain("delete that file");
          expect(readFileSync(ledgerPath, "utf8")).toBe('{"version":2,"entries":{}}');
        }
        const record = json<ChildRecord>(fake.T_CHILD_RECORD!);
        expect(record.args.filter((arg) => arg === "--settings")).toHaveLength(1);
        expect(record.settings.modelPicker).not.toHaveProperty("replaceBuiltInOptions");
      } finally {
        await server.stop(true);
      }
    },
    30_000
  );

  // REQ-23
  test("TEST-64 print launch fetches no lineup and leaves an actionable restore ledger untouched", async () => {
    const { home, settingsFile, ledgerPath, configFile } = sandbox();
    const { server } = upstream();
    const listing = upstream();
    endpoint(server.port!, false);
    // Separate lineup discovery from the start model's ordinary /models request.
    const config = json<{ customEndpoints: Record<string, unknown> }>(configFile);
    config.customEndpoints["blind-listing-gw"] = {
      kind: "simple",
      url: "http://127.0.0.1:" + listing.server.port + "/v1",
      format: "openai",
      authScheme: "none",
    };
    put(configFile, config);
    put(join(home, ".claudish", "config.json"), config);
    put(settingsFile, { model: "or@pending", keep: true });
    const bytes = JSON.stringify({
      version: 1,
      entries: {
        [realpathSync.native(settingsFile)]: {
          original: { present: true, value: "opus" },
          listed: ["or@pending"],
          sessions: [],
        },
      },
    });
    put(ledgerPath, bytes);
    const fake = fakeClaude(home);
    try {
      const result = await runProgram(
        home,
        [cli, "--model", "blind-gw@start", "--model", "blind-listing-gw@*", "-p", "hello"],
        fake
      );
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(existsSync(fake.T_CHILD_RECORD!), result.stdout + result.stderr).toBe(true);
      expect(listing.requests).toEqual([]);
      expect(readFileSync(ledgerPath, "utf8")).toBe(bytes);
      expect(json<{ model: string; keep: boolean }>(settingsFile)).toEqual({
        model: "or@pending",
        keep: true,
      });
      expect(result.stdout + result.stderr).not.toContain(MODEL_RESTORE_PROMISE);
      const record = json<ChildRecord>(fake.T_CHILD_RECORD!);
      expect(record.settings).not.toHaveProperty("modelPicker");
    } finally {
      await Promise.all([server.stop(true), listing.server.stop(true)]);
    }
  }, 30_000);
});
