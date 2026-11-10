import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Column,
  GENERATION,
  KEPT_BINDINGS,
  RECOMMENDED_IDS,
  ROUTING_SETUPS,
  type Setup,
  routingSetupCatalog,
} from "./test-data/routing-setups.js";

async function runSetup(row: Setup, column: Column): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "claudish-routing-setup-"));
  const childPath = new URL("./test-helpers/routing-setup-child.ts", import.meta.url).pathname;
  const networkScenario = !!row.refresh && row.refresh !== "skip";
  const child = Bun.spawn([process.execPath, "--no-env-file", childPath], {
    cwd: home,
    env: {
      HOME: home,
      PATH: process.env.PATH ?? "",
      TMPDIR: tmpdir(),
      ZDOTDIR: home,
      XDG_CONFIG_HOME: home,
      CLAUDE_CONFIG_DIR: join(home, "claude"),
      CLAUDISH_DISABLE_KEYCHAIN: "1",
      CLAUDISH_DISABLE_OP: "1",
      CLAUDISH_DISABLE_CATALOG_WARM: networkScenario || row.refresh === "skip" ? "0" : "1",
      CLAUDISH_DISABLE_BUNDLED_LIST: column === "B" ? "0" : "1",
      CLAUDISH_CATALOG_URL: "https://routing-catalog.invalid/queryModels?catalog=slim",
      CLAUDISH_DYNAMIC_CATALOG_DIR: join(home, "dynamic-models-catalog"),
      CLAUDISH_DYNAMIC_CATALOG_KEY: join(home, "dynamic-models-catalog.key"),
      SETUP_ID: row.id,
      SETUP_COLUMN: column,
      NO_COLOR: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  try {
    const exitCode = await Promise.race([
      child.exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${row.id}/${column} did not complete`)), 20_000);
      }),
    ]);
    const output = await stdout;
    const errors = await stderr;
    expect({ exitCode, errors: exitCode === 0 ? "" : errors, output }).toEqual({
      exitCode: 0,
      errors: "",
      output: expect.stringContaining(JSON.stringify({ setup: row.id, column, result: "passed" })),
    });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    await child.exited;
    await Promise.allSettled([stdout, stderr]);
    rmSync(home, { recursive: true, force: true });
  }
}

test("R4.1 RB-17: setup data changes only the two input modalities and keeps the named connections", () => {
  const data = routingSetupCatalog();
  try {
    const captured = JSON.parse(
      readFileSync(
        new URL(
          "../test-fixtures/catalog-v3/wire-g-20261012101007285-7770c36e.json",
          import.meta.url
        ),
        "utf8"
      )
    );
    const normalized = structuredClone(data.cache);
    for (const id of ["kimi-k3", "minimax-m3"]) {
      const original = captured.entries.find((entry: { modelId: string }) => entry.modelId === id);
      const changed = normalized.entries.find((entry) => entry.modelId === id)!;
      if (original.inputModalities === undefined) delete changed.inputModalities;
      else changed.inputModalities = original.inputModalities;
    }
    expect(normalized).toEqual(captured);
    expect(data.bundle.catalogGenerationId).toBe(GENERATION);
    expect(data.bundle.entries.map((entry) => entry.modelId).sort()).toEqual(
      [...RECOMMENDED_IDS].sort()
    );
    for (const entry of data.bundle.entries) {
      expect(entry.inputModalities).toContain("text");
      expect(entry.outputModalities).toContain("text");
      expect(
        (entry.aggregators ?? [])
          .map((connection) => `${connection.route!.routeId}/${connection.route!.routeProfileId}`)
          .sort()
      ).toEqual([...KEPT_BINDINGS[entry.modelId]!].sort());
    }
  } finally {
    data.cleanup();
  }
});

describe("R4.1: deterministic routing setups", () => {
  for (const row of ROUTING_SETUPS) {
    for (const column of ["C", "B", "disabled"] as const) {
      test(
        `${row.id} ${row.rb}: ${column === "disabled" ? "B negative control with the bundled list disabled" : `column ${column}`} returns the required chain and feature outcome`,
        () => runSetup(row, column),
        25_000
      );
    }
  }
});
