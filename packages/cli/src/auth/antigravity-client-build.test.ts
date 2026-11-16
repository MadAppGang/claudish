import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetAgyClientVersion,
  getAgyClientBuild,
  recordAgyClientVersionRead,
} from "./antigravity-client-version.js";
import { readAgyBuildFromBinary } from "./antigravity-token.js";
import { antigravityUserAgentFor, buildAntigravityUserAgent } from "./antigravity-user.js";

const dirs: string[] = [];
function binary(content: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "agy-build-"));
  dirs.push(dir);
  const path = join(dir, "agy");
  writeFileSync(path, content);
  return path;
}

afterEach(() => {
  _resetAgyClientVersion();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the build changelist of an agy binary", () => {
  test("is the number of its build stamp", () => {
    const path = binary(
      Buffer.concat([
        Buffer.alloc(4096, 1),
        Buffer.from("changelist clNumber %d\0"),
        Buffer.from("changelist 1021519450 with baseline 1021519450 in a mint client"),
        Buffer.alloc(4096, 2),
      ])
    );
    expect(readAgyBuildFromBinary(path)).toBe("1021519450");
  });

  test("is found when the stamp lies across two read steps", () => {
    const stamp = Buffer.from("changelist 77 with baseline 77");
    const before = Buffer.alloc((8 << 20) - 10, 1);
    const path = binary(Buffer.concat([before, stamp, Buffer.alloc(100, 2)]));
    expect(readAgyBuildFromBinary(path)).toBe("77");
  });

  test("is null for a binary with no stamp, and for a missing file", () => {
    expect(readAgyBuildFromBinary(binary(Buffer.alloc(5000, 1)))).toBeNull();
    expect(readAgyBuildFromBinary("/nonexistent/agy")).toBeNull();
  });
});

describe("the User-Agent names the build of the agy that reported the version", () => {
  const platform = `os_type=${process.platform}; arch=${process.arch}`;

  test("with a build, in the place agy puts it", () => {
    recordAgyClientVersionRead("1.5.9", "token-a", "1021519450");
    expect(buildAntigravityUserAgent()).toBe(
      `antigravity/cli/1.5.9 (aidev_client; ${platform}; cl=1021519450; auth_method=consumer)`
    );
  });

  test("without a build, no cl field", () => {
    recordAgyClientVersionRead("1.5.9", "token-a");
    expect(buildAntigravityUserAgent()).toBe(
      `antigravity/cli/1.5.9 (aidev_client; ${platform}; auth_method=consumer)`
    );
  });

  test("another version than the captured one gets no build", () => {
    recordAgyClientVersionRead("1.5.9", "token-a", "1021519450");
    expect(antigravityUserAgentFor("1.1.9")).toBe(
      `antigravity/cli/1.1.9 (aidev_client; ${platform}; auth_method=consumer)`
    );
  });

  test("a new version read replaces the build, and a failed read keeps it", () => {
    recordAgyClientVersionRead("1.5.9", "token-a", "1021519450");
    recordAgyClientVersionRead(null, "token-b");
    expect(getAgyClientBuild()).toBe("1021519450");
    recordAgyClientVersionRead("1.6.0", "token-c", null);
    expect(getAgyClientBuild()).toBeNull();
  });
});
