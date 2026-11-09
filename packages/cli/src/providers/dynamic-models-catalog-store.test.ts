import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredModel } from "./model-discovery.js";

const T = 1_800_000_000_000;
const K = "a".repeat(64);
const K2 = "b".repeat(64);
const models: DiscoveredModel[] = [
  {
    id: "swe-1-7-medium",
    displayName: "SWE-1.7",
    contextWindow: 200000,
    family: "swe-1-7",
    isFamilyDefault: true,
    reported: "chat",
  },
  { id: "second-model", contextWindow: 128000, reported: "chat" },
];
let home: string;
let dir: string;
let keyPath: string;
const loadStore = () => import("./dynamic-models-catalog-store.js");
const options = (now = T) => ({ dir, keyPath, now: () => now });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "claudish-dynamic-store-"));
  dir = join(home, "lists");
  keyPath = join(home, "secret-home", "dynamic-models-catalog.key");
});
afterEach(() => {
  if (existsSync(dir)) chmodSync(dir, 0o700);
  rmSync(home, { recursive: true, force: true });
});

describe("dynamic models catalog store", () => {
  test("1. classifyListAge boundaries", async () => {
    const { classifyListAge, LIVE_MS, FRESH_MS, MAX_AGE_MS } = await loadStore();
    const ages = [0, LIVE_MS, LIVE_MS + 1, FRESH_MS, FRESH_MS + 1, MAX_AGE_MS, MAX_AGE_MS + 1];
    expect(ages.map((age) => classifyListAge(T - age, T))).toEqual([
      "live",
      "live",
      "fresh",
      "fresh",
      "stale",
      "stale",
      "expired",
    ]);
  });

  test("2. key is deterministic and keyed", async () => {
    const { deriveAccountKey } = await loadStore();
    const first = deriveAccountKey("devin", "A", options());
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.reason);
    expect(first.accountKey).toMatch(/^[a-f0-9]{64}$/);
    expect(deriveAccountKey("devin", "A", options())).toEqual(first);
    const otherKeyPath = join(home, "other.key");
    writeFileSync(otherKeyPath, "2".repeat(64), { mode: 0o600 });
    expect(deriveAccountKey("antigravity", "A", options())).not.toEqual(first);
    expect(deriveAccountKey("devin", "B", options())).not.toEqual(first);
    expect(deriveAccountKey("devin", "A", { ...options(), keyPath: otherKeyPath })).not.toEqual(
      first
    );
  });

  test("3. key reveals neither material nor its plain hash", async () => {
    const { deriveAccountKey } = await loadStore();
    const result = deriveAccountKey("devin", "sk-abc", options());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.accountKey).not.toBe(createHash("sha256").update("sk-abc").digest("hex"));
    expect(result.accountKey).not.toContain("sk-abc");
  });

  test("4. secret created safely", async () => {
    const { deriveAccountKey } = await loadStore();
    expect(deriveAccountKey("devin", "A", options()).ok).toBe(true);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(keyPath, "..")).mode & 0o777).toBe(0o700);
    const bytes = readFileSync(keyPath);
    expect(bytes.toString()).toMatch(/^[a-f0-9]{64}$/);
    deriveAccountKey("devin", "A", options());
    expect(readFileSync(keyPath)).toEqual(bytes);
  });

  test("5. secret with a broad mode is refused", async () => {
    const { deriveAccountKey } = await loadStore();
    mkdirSync(join(keyPath, ".."), { mode: 0o700 });
    const bytes = "1".repeat(64);
    writeFileSync(keyPath, bytes, { mode: 0o644 });
    chmodSync(keyPath, 0o644);
    expect(deriveAccountKey("devin", "A", options())).toEqual({
      ok: false,
      reason: "secret-unavailable",
    });
    expect(readFileSync(keyPath, "utf8")).toBe(bytes);
    expect(statSync(keyPath).mode & 0o777).toBe(0o644);
  });

  test("6. no material, no key", async () => {
    const { deriveAccountKey } = await loadStore();
    for (const material of [undefined, ""]) {
      expect(deriveAccountKey("devin", material, options())).toEqual({
        ok: false,
        reason: "no-identity",
      });
      expect(existsSync(keyPath)).toBe(false);
    }
  });

  test("7. round trip", async () => {
    const { writeStoredModelsList, readStoredModelsList } = await loadStore();
    expect(writeStoredModelsList("devin", K, models, options())).toBe(true);
    expect(readStoredModelsList("devin", K, options(T + 3600000))).toMatchObject({
      provider: "devin",
      accountKey: K,
      models,
      fetchedAt: T,
      age: "fresh",
    });
    expect(statSync(join(dir, "devin.json")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test("8. no credential bytes on disk", async () => {
    const { deriveAccountKey, writeStoredModelsList } = await loadStore();
    const result = deriveAccountKey("devin", "sk-LEAK-7f3a", options());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(writeStoredModelsList("devin", result.accountKey, models, options())).toBe(true);
    const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) =>
      entry.isFile()
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(join(file.parentPath, file.name), "utf8")).not.toContain("sk-LEAK-7f3a");
    }
  });

  test("9. expiry", async () => {
    const { writeStoredModelsList, readStoredModelsList, MAX_AGE_MS } = await loadStore();
    expect(writeStoredModelsList("devin", K, models, options(T - MAX_AGE_MS))).toBe(true);
    expect(readStoredModelsList("devin", K, options())?.age).toBe("stale");
    expect(readStoredModelsList("devin", K, options(T + 1))).toBeNull();
  });

  test("10. future-dated entry", async () => {
    const { writeStoredModelsList, readStoredModelsList, MAX_FUTURE_SKEW_MS } = await loadStore();
    expect(writeStoredModelsList("devin", K, models, options(T + MAX_FUTURE_SKEW_MS + 1))).toBe(
      true
    );
    expect(readStoredModelsList("devin", K, options())).toBeNull();
  });

  test("11. malformed input never throws", async () => {
    const { readStoredModelsList } = await loadStore();
    mkdirSync(dir, { mode: 0o700 });
    const document = (schema: number, rows: unknown[]) =>
      JSON.stringify({
        schema,
        provider: "devin",
        accounts: { [K]: { fetchedAt: T, models: rows } },
      });
    for (const bytes of ["{", document(2, models), document(1, [models[0], { id: 42 }])]) {
      writeFileSync(join(dir, "devin.json"), bytes);
      expect(() => readStoredModelsList("devin", K, options())).not.toThrow();
      expect(readStoredModelsList("devin", K, options())).toBeNull();
    }
  });

  test("12. account cap", async () => {
    const { writeStoredModelsList, readStoredModelsList, MAX_ACCOUNTS_PER_PROVIDER } =
      await loadStore();
    const keys = Array.from({ length: 5 }, (_, i) => String(i + 1).repeat(64));
    for (const [i, key] of keys.entries()) {
      expect(writeStoredModelsList("devin", key, models, options(T + i))).toBe(true);
    }
    expect(MAX_ACCOUNTS_PER_PROVIDER).toBe(4);
    const document = JSON.parse(readFileSync(join(dir, "devin.json"), "utf8"));
    expect(Object.keys(document.accounts)).toHaveLength(4);
    expect(readStoredModelsList("devin", keys[0], options(T + 5))).toBeNull();
    for (const key of keys.slice(1))
      expect(readStoredModelsList("devin", key, options(T + 5))).not.toBeNull();
  });

  test("13. empty list rejected", async () => {
    const { writeStoredModelsList, readStoredModelsList } = await loadStore();
    expect(writeStoredModelsList("devin", K, models, options())).toBe(true);
    const before = readFileSync(join(dir, "devin.json"));
    expect(writeStoredModelsList("devin", K, [], options(T + 1))).toBe(false);
    expect(readFileSync(join(dir, "devin.json"))).toEqual(before);
    expect(readStoredModelsList("devin", K, options())?.models).toEqual(models);
  });

  test("14. delete", async () => {
    const { writeStoredModelsList, readStoredModelsList, deleteStoredModelsList } =
      await loadStore();
    expect(writeStoredModelsList("devin", K, models, options())).toBe(true);
    expect(writeStoredModelsList("devin", K2, models, options())).toBe(true);
    deleteStoredModelsList("devin", K, options());
    expect(readStoredModelsList("devin", K, options())).toBeNull();
    expect(readStoredModelsList("devin", K2, options())?.models).toEqual(models);
    deleteStoredModelsList("devin", undefined, options());
    expect(existsSync(join(dir, "devin.json"))).toBe(false);
  });

  test("15. unwritable dir", async () => {
    const { writeStoredModelsList } = await loadStore();
    mkdirSync(dir, { mode: 0o500 });
    chmodSync(dir, 0o500);
    let result: boolean | undefined;
    expect(() => {
      result = writeStoredModelsList("devin", K, models, options());
    }).not.toThrow();
    expect(result).toBe(false);
  });
});
