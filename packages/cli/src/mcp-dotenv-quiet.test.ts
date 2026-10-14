import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// dotenv must stay quiet in the MCP server (upstream 3086261d, half 2)
//
// mcp-server.ts speaks MCP JSON-RPC over STDOUT. Our pinned dotenv@17.2.3
// prints "[dotenv@17.2.3] injecting env (0) from .env -- tip: …" on STDOUT
// the moment a .env exists in the cwd — measured 2026-10-15 by isolating the
// streams (stdout carries the banner, stderr stays clean). One non-JSON line
// before the handshake and the host fails to initialize the server: the user
// silently gets no claudish tools. The fix is config({ quiet: true }).
//
// Importing mcp-server.ts in-process to test this is not viable (top-level
// side effects start the stdio server), so this is a structural pin in the
// compose-env-coverage style: the source must pass the flag. If this test
// blocks a deliberate revert, the measurement above is what the revert has
// to re-refute — on the pinned dotenv version, with separated streams.
// ---------------------------------------------------------------------------

describe("mcp-server dotenv quiet pin", () => {
  test("the MCP server loads dotenv with quiet: true (stdout is the protocol)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "mcp-server.ts"), "utf8");

    // The load-bearing call. Anchored so a comment-only mention cannot satisfy it.
    expect(source).toContain("config({ quiet: true });");

    // And no second, bare config() sneaking back in anywhere (the pre-fix form).
    expect(source).not.toMatch(/(^|\n)\s*config\(\);/);
  });
});
