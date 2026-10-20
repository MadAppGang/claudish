import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MuseBorrowedCopy, MuseStoreKind } from "./muse-store.js";

// ASCII durable-token placeholder with the prefix from wire-capture.md §7.
// Wrapper fields are the exported
// claudish store contract, not a claim about a Meta endpoint response.
const TOKEN = "dca:TESTTOKEN0001";
const TIER = "Muse Code Power Usage";
let store: typeof import("./muse-store.js");
let home: string;
// Every store operation receives dir explicitly; HOME is not an isolation seam.
let dir: string;
let priorGuard: string | undefined;

beforeEach(async () => {
  priorGuard = process.env.CLAUDISH_DISABLE_KEYCHAIN;
  home = await mkdtemp(join(tmpdir(), "muse-store-test-"));
  dir = join(home, ".claudish");
  process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
  await mkdir(dir);
  store = await import("./muse-store.js");
});

afterEach(async () => {
  if (priorGuard === undefined) delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
  else process.env.CLAUDISH_DISABLE_KEYCHAIN = priorGuard;
  await rm(home, { recursive: true, force: true });
});

describe("S1 — durable token validity and complete private stores", () => {
  test("uses the two documented claudish filenames inside the supplied directory", () => {
    expect(store.museStorePath("own-login", dir)).toBe(join(dir, "meta-muse-oauth.json"));
    expect(store.museStorePath("borrowed-copy", dir)).toBe(join(dir, "meta-muse-borrowed.json"));
  });

  test("accepts a nonempty access token without requiring obsolete refresh/expiry fields", () => {
    expect(store.isValidMuseStore({ access_token: TOKEN })).toBe(true);
    expect(store.isValidMuseStore({ access_token: TOKEN, subs_tier_name: TIER })).toBe(true);
  });

  const invalid: unknown[] = [
    null,
    undefined,
    {},
    [],
    "corrupt",
    { access_token: "" },
    { access_token: null },
    { access_token: 1 },
    { api_key: "LLM|TESTKEY0001" },
  ];
  for (const [index, value] of invalid.entries()) {
    test(`rejects invalid store value ${index}: ${JSON.stringify(value)}`, () => {
      expect(store.isValidMuseStore(value)).toBe(false);
    });
  }

  for (const kind of ["own-login", "borrowed-copy"] as const) {
    test(`${kind}: missing, malformed and empty-token files are unreadable`, async () => {
      expect(await store.readMuseStore(kind, dir)).toBeFalsy();
      const path = store.museStorePath(kind, dir);
      for (const raw of [
        '{"access_token":',
        "null",
        "{}",
        '{"access_token":""}',
        '{"api_key":"LLM|TESTKEY0001"}',
      ]) {
        await writeFile(path, raw, { mode: 0o600 });
        expect(await store.readMuseStore(kind, dir)).toBeFalsy();
      }
    });

    test(`${kind}: replaces the complete document and leaves only a 0600 final file`, async () => {
      const path = store.museStorePath(kind, dir);
      await writeFile(path, JSON.stringify({ access_token: TOKEN, obsolete: true }), {
        mode: 0o600,
      });
      const replacement = { access_token: TOKEN, subs_tier_name: TIER };
      await store.writeMuseStore(kind, replacement, dir);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(replacement);
      expect(await store.readMuseStore(kind, dir)).toEqual(replacement);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readdir(dir)).toEqual([
        kind === "own-login" ? "meta-muse-oauth.json" : "meta-muse-borrowed.json",
      ]);
      // Replacing with a shorter document must not retain bytes or old fields.
      await store.writeMuseStore(kind, { access_token: TOKEN }, dir);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ access_token: TOKEN });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    });

    test(`${kind}: creates a new complete file with mode 0600`, async () => {
      const record = { access_token: TOKEN, subs_tier_name: TIER };
      await store.writeMuseStore(kind, record, dir);
      const path = store.museStorePath(kind, dir);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(record);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    });
  }

  test("borrowed copy retains schema, confirming tier and a valid copy timestamp on disk and read", async () => {
    const copiedAt = new Date("2026-10-16T03:33:37.000Z");
    store.writeBorrowedCopy(TOKEN, TIER, dir, () => copiedAt);
    const path = store.museStorePath("borrowed-copy", dir);
    const raw: MuseBorrowedCopy = JSON.parse(await readFile(path, "utf8"));
    expect(raw.schema).toBe(1);
    expect(raw.access_token).toBe(TOKEN);
    expect(raw.subs_tier_name).toBe(TIER);
    expect(typeof raw.copied_at).toBe("string");
    expect(new Date(raw.copied_at).toISOString()).toBe(raw.copied_at);
    expect(raw.copied_at).toBe(copiedAt.toISOString());
    expect(await store.readMuseStore("borrowed-copy", dir)).toEqual({ ...raw });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["meta-muse-borrowed.json"]);
  });

  test("reads the exported borrowed wrapper without discarding its timestamp or tier", async () => {
    const record: MuseBorrowedCopy = {
      schema: 1,
      access_token: TOKEN,
      copied_at: "2026-10-16T03:33:37.000Z",
      subs_tier_name: TIER,
    };
    await writeFile(store.museStorePath("borrowed-copy", dir), JSON.stringify(record), {
      mode: 0o600,
    });
    expect(await store.readMuseStore("borrowed-copy", dir)).toEqual({ ...record });
  });
});

describe("S2 — delete only claudish's own two stores", () => {
  test("deletes both stores, preserves unrelated files, and is repeatable", async () => {
    await store.writeMuseStore("own-login", { access_token: TOKEN }, dir);
    await store.writeBorrowedCopy(TOKEN, TIER, dir);
    const sentinel = join(dir, "config.json");
    const museDir = join(home, ".config", "muse");
    await mkdir(museDir, { recursive: true });
    const museSentinel = join(museDir, "auth.json");
    await writeFile(sentinel, "unrelated claudish configuration");
    await writeFile(museSentinel, "unrelated Muse CLI configuration");
    await store.deleteMuseStores(dir);
    for (const kind of ["own-login", "borrowed-copy"] satisfies MuseStoreKind[]) {
      expect(await store.readMuseStore(kind, dir)).toBeFalsy();
      expect(await Bun.file(store.museStorePath(kind, dir)).exists()).toBe(false);
    }
    expect(await readdir(dir)).toEqual(["config.json"]);
    expect(await readFile(sentinel, "utf8")).toBe("unrelated claudish configuration");
    expect(await readFile(museSentinel, "utf8")).toBe("unrelated Muse CLI configuration");
    await store.deleteMuseStores(dir);
    expect(await readFile(sentinel, "utf8")).toBe("unrelated claudish configuration");
  });
});
