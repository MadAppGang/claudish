import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import runtime modules only inside the child, after its HOME has been isolated.
export async function runRoutingContractChild(path: string, scenario: string): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "routing-contract-"));
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    child = Bun.spawn([process.execPath, "--no-env-file", path], {
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
        CLAUDISH_DISABLE_CATALOG_WARM: "1",
        CLAUDISH_DISABLE_BUNDLED_LIST: "0",
        CLAUDISH_DYNAMIC_CATALOG_DIR: join(home, "dynamic-models-catalog"),
        CLAUDISH_DYNAMIC_CATALOG_KEY: join(home, "dynamic-models-catalog.key"),
        SCENARIO: scenario,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    timer = setTimeout(() => child?.kill(), 15_000);
    const [exitCode, output, errors] = await Promise.all([child.exited, stdout, stderr]);
    expect({ exitCode, output, errors: exitCode === 0 ? "" : errors }).toEqual({
      exitCode: 0,
      output: JSON.stringify({ scenario, result: "passed" }) + "\n",
      errors: "",
    });
  } finally {
    clearTimeout(timer);
    if (child?.exitCode === null) child.kill();
    await child?.exited;
    rmSync(home, { recursive: true, force: true });
  }
}
