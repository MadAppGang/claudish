import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturedLines,
  startLogCapture,
  stopLogCapture,
} from "../../recovery/test-helpers/capture-log";
import {
  DEVIN_API_KEY_ENV,
  hasDevinCredentials,
  readDevinApiKey,
  setDevinCredentialsPathForTesting,
} from "./devin-credentials";

const first = "OPAQUE_TEST_TOKEN_abc";
const newer = "OPAQUE_TEST_TOKEN_new_login";
let root: string;
let path: string;
let originalKey: string | undefined;

function toml(key: string) {
  return `windsurf_api_key = "${key}"\n`;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "w1-devin-reload-"));
  path = join(root, "credentials.toml");
  originalKey = process.env[DEVIN_API_KEY_ENV];
  delete process.env[DEVIN_API_KEY_ENV];
  setDevinCredentialsPathForTesting(path);
  startLogCapture();
});

afterEach(async () => {
  try {
    const lines = (await capturedLines()).join("\n");
    expect(lines).not.toContain(first);
    expect(lines).not.toContain(newer);
  } finally {
    stopLogCapture();
    setDevinCredentialsPathForTesting(null);
    if (originalKey === undefined) delete process.env[DEVIN_API_KEY_ENV];
    else process.env[DEVIN_API_KEY_ENV] = originalKey;
    rmSync(root, { recursive: true, force: true });
  }
});

describe("W1 Devin file-backed key reload behavior", () => {
  test("G1 1.13 an in-place CLI rewrite is visible to the next key read", () => {
    writeFileSync(path, toml(first));
    expect(readDevinApiKey()).toBe(first);
    const ino = statSync(path).ino;
    writeFileSync(path, toml(newer));
    expect(statSync(path).ino).toBe(ino);
    expect(readDevinApiKey()).toBe(newer);
  }, 5_000);

  test("G1 1.13 a renamed credentials.toml replaces the cached key", () => {
    writeFileSync(path, toml(first));
    expect(readDevinApiKey()).toBe(first);
    const next = join(root, "next.toml");
    writeFileSync(next, toml(newer));
    renameSync(next, path);
    expect(readDevinApiKey()).toBe(newer);
    expect(hasDevinCredentials()).toBe(true);
  }, 5_000);

  for (const torn of ["", 'windsurf_api_key = "OPAQUE_TEST_TOKEN_abc']) {
    test(`G3 unreadable TOML (${torn.length} bytes) keeps the key and retries on the next call`, () => {
      writeFileSync(path, toml(first));
      expect(readDevinApiKey()).toBe(first);
      writeFileSync(path, torn);
      expect(readDevinApiKey()).toBe(first);
      expect(hasDevinCredentials()).toBe(true);
      writeFileSync(path, toml(newer));
      expect(readDevinApiKey()).toBe(newer);
    }, 5_000);
  }

  test("G1 deleting the file removes the cached credential", () => {
    writeFileSync(path, toml(first));
    expect(readDevinApiKey()).toBe(first);
    unlinkSync(path);
    expect(readDevinApiKey()).toBeUndefined();
    expect(hasDevinCredentials()).toBe(false);
  }, 5_000);

  test("G3 an unreadable first use has no cached credential, but is retried", () => {
    writeFileSync(path, "");
    expect(readDevinApiKey()).toBeUndefined();
    writeFileSync(path, toml(newer));
    expect(readDevinApiKey()).toBe(newer);
  }, 5_000);

  test("G4 the reload log is credential-free and unchanged reads produce no reload logs", async () => {
    writeFileSync(path, toml(first));
    expect(readDevinApiKey()).toBe(first);
    writeFileSync(path, toml(newer));
    expect(readDevinApiKey()).toBe(newer);
    const before = (await capturedLines()).filter((line) =>
      line.includes("[Devin] credentials file changed on disk; reloaded")
    );
    expect(before.length).toBeGreaterThan(0);
    expect(readDevinApiKey()).toBe(newer);
    expect(readDevinApiKey()).toBe(newer);
    const after = (await capturedLines()).filter((line) =>
      line.includes("[Devin] credentials file changed on disk; reloaded")
    );
    expect(after).toEqual(before);
  }, 5_000);
});
