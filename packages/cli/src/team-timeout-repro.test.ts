/**
 * Reproduction test for Bug #1: TIMEOUT reported despite successful completion
 *
 * The race condition: when the timeout handler fires, it checks `!proc.killed`
 * to decide which processes to mark as TIMEOUT. But Node.js's `proc.killed` is
 * only `true` when the PARENT sent a signal via `.kill()`. A process that exited
 * naturally has `proc.killed === false`, so the timeout handler incorrectly
 * marks already-completed processes as TIMEOUT.
 *
 * Strategy: We create a tiny shell script "fake-claudish" that outputs a response
 * and exits in ~100ms. We set the team timeout to 1 second. The process finishes
 * well within the timeout, but if there's a race between the exit handler and
 * the timeout handler (or if the timeout fires after completion but before
 * cleanup), the bug manifests.
 *
 * To force the race: we set a very tight timeout so the completion and timeout
 * fire in close succession.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupSession, runModels } from "./team-orchestrator.js";
import { envDescribe } from "./test-support/env-gate";

// ─── Helpers ────────────────────────────────────────────────────────────────

let tempDir: string;
let fakeClaudishDir: string;

function makeFakeClaudish(delayMs: number = 50): string {
  // Create a fake claudish that:
  // 1. Reads stdin (the input prompt)
  // 2. Waits a bit (simulating model thinking)
  // 3. Writes a response to stdout
  // 4. Exits 0
  const dir = mkdtempSync(join(tmpdir(), "fake-claudish-"));
  const script = join(dir, "claudish");
  writeFileSync(
    script,
    `#!/bin/bash
# Read stdin (discard)
cat > /dev/null
# Simulate model thinking
sleep ${(delayMs / 1000).toFixed(3)}
# Write response
echo "This is a complete model response with analysis and recommendations."
echo "The model has finished its work successfully."
exit 0
`,
    "utf-8"
  );
  chmodSync(script, 0o755);
  return dir;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "team-timeout-repro-"));
  fakeClaudishDir = makeFakeClaudish(50); // 50ms delay
});

afterEach(() => {
  for (const dir of [tempDir, fakeClaudishDir]) {
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ─── Tests ──────────────────────────────────────────────────────────────────

envDescribe(
  {
    id: "posix-path-shim",
    active: process.platform !== "win32",
    reason: "makeFakeClaudish writes a #!/bin/bash script and joins PATH with `:` — neither executes on win32, so every REPRO in this block fails at spawn",
    activation: "run on a POSIX host, or port the fake to a claudish.cmd wrapper",
  },
  "Bug #1: TIMEOUT despite successful completion"
)((it) => {
  it("REPRO: process that completes before timeout should be COMPLETED, not TIMEOUT", async () => {
    // Setup session with 2 "models"
    setupSession(tempDir, ["fast-model-a", "fast-model-b"], "Say hello");

    // Run with a generous 5s timeout — processes complete in ~50ms
    // Prepend fake claudish to PATH so it's found instead of real one
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeClaudishDir}:${originalPath}`;

    try {
      const status = await runModels(tempDir, { timeout: 5 });

      // Both models should be COMPLETED since they finish well before the 5s timeout
      for (const [, model] of Object.entries(status.models)) {
        expect(model.state).toBe("COMPLETED");
        expect(model.exitCode).toBe(0);
        expect(model.outputSize).toBeGreaterThan(0);
      }
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("REPRO: process that completes just before timeout fires should be COMPLETED", async () => {
    // This is the tighter race: process completes in ~200ms, timeout at 1s
    // On a fast machine this should never timeout, but the bug is in how
    // the timeout handler checks proc.killed
    if (fakeClaudishDir) {
      rmSync(fakeClaudishDir, { recursive: true, force: true });
    }
    fakeClaudishDir = makeFakeClaudish(200); // 200ms delay

    setupSession(tempDir, ["model-a"], "Say hello");

    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeClaudishDir}:${originalPath}`;

    try {
      const status = await runModels(tempDir, { timeout: 1 });

      const model = Object.values(status.models)[0];
      expect(model.state).toBe("COMPLETED");
      expect(model.exitCode).toBe(0);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("REPRO: actual timeout should still produce TIMEOUT state", async () => {
    // Create a slow fake claudish that takes 5 seconds
    if (fakeClaudishDir) {
      rmSync(fakeClaudishDir, { recursive: true, force: true });
    }
    fakeClaudishDir = makeFakeClaudish(5000); // 5 second delay

    setupSession(tempDir, ["slow-model"], "Say hello");

    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeClaudishDir}:${originalPath}`;

    try {
      const status = await runModels(tempDir, { timeout: 1 });

      const model = Object.values(status.models)[0];
      expect(model.state).toBe("TIMEOUT");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("REPRO: mixed fast/slow models — fast ones COMPLETED, slow one TIMEOUT", async () => {
    // Two fast models and one slow model
    // The fast ones should be COMPLETED, the slow one TIMEOUT
    if (fakeClaudishDir) {
      rmSync(fakeClaudishDir, { recursive: true, force: true });
    }

    // Create a "claudish" that takes different times based on model name
    const dir = mkdtempSync(join(tmpdir(), "fake-claudish-mixed-"));
    const script = join(dir, "claudish");
    writeFileSync(
      script,
      `#!/bin/bash
# Read stdin
cat > /dev/null
# Parse the model name from args
MODEL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="$2"; shift 2 ;;
    *) shift ;;
  esac
done
# Slow model takes 10 seconds, fast models take 50ms
if [[ "$MODEL" == "slow-model" ]]; then
  sleep 10
else
  sleep 0.05
fi
echo "Response from $MODEL — complete analysis."
exit 0
`,
      "utf-8"
    );
    chmodSync(script, 0o755);
    fakeClaudishDir = dir;

    setupSession(tempDir, ["fast-a", "fast-b", "slow-model"], "Analyze code");

    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeClaudishDir}:${originalPath}`;

    try {
      const status = await runModels(tempDir, { timeout: 2 });

      // Read manifest to find which anon ID maps to which model
      const manifest = JSON.parse(readFileSync(join(tempDir, "manifest.json"), "utf-8"));

      for (const [anonId, entry] of Object.entries(manifest.models) as [string, { model: string }][]) {
        const modelStatus = status.models[anonId];
        if (entry.model === "slow-model") {
          expect(modelStatus.state).toBe("TIMEOUT");
        } else {
          // THIS IS THE BUG: fast models that completed should be COMPLETED
          // but the current code may mark them as TIMEOUT because proc.killed === false
          expect(modelStatus.state).toBe("COMPLETED");
          expect(modelStatus.exitCode).toBe(0);
        }
      }
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("REPRO: Bug #2 — byte counter tracks stdout accurately independent of filesystem", async () => {
    // The original bug: statSync reads file size before stream flush completes,
    // reporting fewer bytes than actually written. With small output (~80 bytes),
    // flush completes before finish() runs, so statSync would also pass.
    //
    // Fix: use a LARGE output (64KB, well above Node's 16KB highWaterMark) so
    // the pipe buffer can't flush instantly. The byte counter must track data
    // events on stdout, not the filesystem state.

    // Create a fake claudish that writes exactly 65536 bytes (64KB)
    const largeFakeDir = mkdtempSync(join(tmpdir(), "fake-claudish-large-"));
    const script = join(largeFakeDir, "claudish");
    writeFileSync(
      script,
      `#!/bin/bash
cat > /dev/null
# Generate exactly 65536 bytes (64KB) — exceeds default highWaterMark
dd if=/dev/zero bs=1024 count=64 2>/dev/null | tr '\\0' 'A'
exit 0
`,
      "utf-8"
    );
    chmodSync(script, 0o755);

    setupSession(tempDir, ["model-a"], "Say hello");

    const originalPath = process.env.PATH;
    process.env.PATH = `${largeFakeDir}:${originalPath}`;

    try {
      const status = await runModels(tempDir, { timeout: 10 });

      const model = Object.values(status.models)[0];
      expect(model.state).toBe("COMPLETED");
      // The byte counter must report exactly 65536 bytes — the known amount
      // written to stdout. A statSync-based approach would under-report this
      // when the write stream hasn't flushed yet.
      expect(model.outputSize).toBe(65536);
    } finally {
      process.env.PATH = originalPath;
      rmSync(largeFakeDir, { recursive: true, force: true });
    }
  });
});

describe("Bug #3: Session directory overwrite protection", () => {
  it("REPRO: setupSession rejects existing session directory", () => {
    // First setup succeeds
    setupSession(tempDir, ["model-a"], "First run input");

    // Second setup on same dir should throw — manifest.json already exists
    expect(() => setupSession(tempDir, ["model-b"], "Second run input")).toThrow(
      /Session already exists/
    );
  });

  it("REPRO: session artifacts are preserved when re-run is rejected", () => {
    setupSession(tempDir, ["model-a"], "First run input");

    // Capture original file contents that setupSession actually writes
    const originalManifest = readFileSync(join(tempDir, "manifest.json"), "utf-8");
    const originalInput = readFileSync(join(tempDir, "input.md"), "utf-8");
    const originalStatus = readFileSync(join(tempDir, "status.json"), "utf-8");

    // Re-run attempt should fail
    expect(() => setupSession(tempDir, ["model-b"], "DIFFERENT input")).toThrow();

    // All session artifacts must be byte-for-byte unchanged
    expect(readFileSync(join(tempDir, "manifest.json"), "utf-8")).toBe(originalManifest);
    expect(readFileSync(join(tempDir, "input.md"), "utf-8")).toBe(originalInput);
    expect(readFileSync(join(tempDir, "status.json"), "utf-8")).toBe(originalStatus);
  });

  it("REPRO: fresh directory works fine", () => {
    // First call on a fresh dir should not throw
    expect(() => setupSession(tempDir, ["model-a", "model-b"], "Task")).not.toThrow();
  });
});
