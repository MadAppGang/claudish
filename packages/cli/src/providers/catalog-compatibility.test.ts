import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CatalogIncompatibility,
  SUPPORTED_CONTRACT_VERSION,
  _resetCatalogCompatibilityForTest,
  clearCatalogIncompatibility,
  markCatalogIncompatible,
  parseContractEnvelope,
  readCatalogIncompatibility,
} from "./catalog-compatibility.js";

let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "claudish-catalog-compatibility-"));
  _resetCatalogCompatibilityForTest();
});

afterEach(() => {
  _resetCatalogCompatibilityForTest();
  rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

describe("parseContractEnvelope", () => {
  test("reads the frozen backend envelope with a top-level version and nested minimum", () => {
    expect(
      parseContractEnvelope({
        contractVersion: SUPPORTED_CONTRACT_VERSION + 1,
        error: {
          code: "catalog_client_upgrade_required",
          message: "Upgrade required",
          minimumContractVersion: SUPPORTED_CONTRACT_VERSION + 1,
        },
      })
    ).toEqual({
      contractVersion: SUPPORTED_CONTRACT_VERSION + 1,
      minimumContractVersion: SUPPORTED_CONTRACT_VERSION + 1,
    });
  });

  test("returns an unknown version when the body declares neither envelope field", () => {
    expect(parseContractEnvelope({ models: [] })).toEqual({ contractVersion: null });
  });

  test("returns an unknown version for null and non-object bodies", () => {
    for (const body of [null, undefined, "not-json", 3, true]) {
      expect(parseContractEnvelope(body)).toEqual({ contractVersion: null });
    }
  });
});

describe("catalog incompatibility sentinel", () => {
  test("keeps the process blocked in memory when the disk write fails", () => {
    const fileWhereDirectoryIsRequired = join(tempDir, "not-a-directory");
    writeFileSync(fileWhereDirectoryIsRequired, "blocks mkdir", "utf8");
    const unwritableSentinel = join(fileWhereDirectoryIsRequired, "catalog-incompatible.json");
    const unrelatedMissingPath = join(tempDir, "missing", "catalog-incompatible.json");

    markCatalogIncompatible(
      {
        serverContractVersion: SUPPORTED_CONTRACT_VERSION + 1,
        minimumContractVersion: SUPPORTED_CONTRACT_VERSION + 1,
      },
      unwritableSentinel
    );

    expect(existsSync(unwritableSentinel)).toBe(false);
    expect(readCatalogIncompatibility(unrelatedMissingPath)).toMatchObject({
      serverContractVersion: SUPPORTED_CONTRACT_VERSION + 1,
      minimumContractVersion: SUPPORTED_CONTRACT_VERSION + 1,
    });
  });

  test("memoizes the first disk read for the supplied path", () => {
    const sentinelPath = join(tempDir, "catalog-incompatible.json");
    const firstRecord: CatalogIncompatibility = {
      detectedAt: "2026-09-10T00:00:00.000Z",
      serverContractVersion: 3,
      minimumContractVersion: 3,
    };
    const replacementRecord: CatalogIncompatibility = {
      detectedAt: "2026-09-10T01:00:00.000Z",
      serverContractVersion: 4,
      minimumContractVersion: 4,
    };
    writeFileSync(sentinelPath, JSON.stringify(firstRecord), "utf8");

    expect(readCatalogIncompatibility(sentinelPath)).toEqual(firstRecord);
    writeFileSync(sentinelPath, JSON.stringify(replacementRecord), "utf8");
    expect(readCatalogIncompatibility(sentinelPath)).toEqual(firstRecord);
  });

  test("reset clears both the in-memory flag and the memoized disk read", () => {
    const blocker = join(tempDir, "reset-blocker");
    writeFileSync(blocker, "blocks mkdir", "utf8");
    const unwritableSentinel = join(blocker, "catalog-incompatible.json");
    const missingPath = join(tempDir, "missing-after-reset.json");
    markCatalogIncompatible({ serverContractVersion: 3 }, unwritableSentinel);

    _resetCatalogCompatibilityForTest();
    expect(readCatalogIncompatibility(missingPath)).toBeNull();

    const memoPath = join(tempDir, "memoized-before-reset.json");
    const record: CatalogIncompatibility = {
      detectedAt: "2026-09-10T02:00:00.000Z",
      serverContractVersion: 3,
    };
    writeFileSync(memoPath, JSON.stringify(record), "utf8");
    expect(readCatalogIncompatibility(memoPath)).toEqual(record);
    rmSync(memoPath);

    _resetCatalogCompatibilityForTest();
    expect(readCatalogIncompatibility(memoPath)).toBeNull();
  });

  test("clear removes the supplied sentinel path and clears its cached value", () => {
    const sentinelPath = join(tempDir, "custom", "catalog-incompatible.json");
    markCatalogIncompatible({ serverContractVersion: 3 }, sentinelPath);
    expect(existsSync(sentinelPath)).toBe(true);
    expect(readCatalogIncompatibility(sentinelPath)).not.toBeNull();

    clearCatalogIncompatibility(sentinelPath);

    expect(existsSync(sentinelPath)).toBe(false);
    expect(readCatalogIncompatibility(sentinelPath)).toBeNull();
  });
});
