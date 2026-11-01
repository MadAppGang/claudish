/**
 * Seeds a TEMP home for one row: `config.json` (`subscriptionAccounts["openai-codex"]`),
 * one token file per account, and optionally the legacy `codex-oauth.json`.
 *
 * Token files are written through the production `FileTokenStore` and
 * `fingerprintOf`, so the seeded shape is the shape the binary reads, not a copy
 * that can drift. Every token is fake.
 */

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { join, resolve } from "node:path";
import {
  FileTokenStore,
  fingerprintOf,
} from "../../../packages/cli/src/auth/accounts/token-store.ts";

/** A full v3 cloud models catalog with its route registry (generation `g-20261012101007285-7770c36e`). */
export const CATALOG_FIXTURE = resolve(
  import.meta.dir,
  "../../../packages/cli/src/test-fixtures/catalog-v3/wire-g-20261012101007285-7770c36e.json"
);
export const CATALOG_GENERATION = "g-20261012101007285-7770c36e";
/** A model whose catalog entry carries a `codex-subscription` connection in that catalog. */
export const CODEX_MODEL = "cx@gpt-6.1-sol";

export interface SeedAccount {
  /** 12-character `[a-z0-9]` id; fixed defaults keep a row reproducible. */
  id: string;
  label: string;
  /** Epoch ms. Default: one hour ahead. 0 seeds an expired token. */
  expiresAt?: number;
  /** `enabled: false` row. */
  disabled?: boolean;
}

export const DEFAULT_ACCOUNTS: SeedAccount[] = [
  { id: "aaaaaaaaaaaa", label: "A" },
  { id: "bbbbbbbbbbbb", label: "B" },
];

export interface SeedOptions {
  home: string;
  /** `CLAUDISH_ACCOUNTS_DIR`. */
  accountsDir: string;
  accounts: SeedAccount[];
  /** Also write `codex-oauth.json` (legacy account). */
  legacy?: boolean;
  /** `expires_at` of the legacy file, epoch ms. Default: one hour ahead. */
  legacyExpiresAt?: number;
}

export const accessTokenOf = (label: string) => `access-${label}`;
export const refreshTokenOf = (label: string) => `refresh-${label}`;

export async function seedHome(opts: SeedOptions): Promise<void> {
  const claudishDir = join(opts.home, ".claudish");
  mkdirSync(claudishDir, { recursive: true });
  const env = { ...process.env, HOME: opts.home, CLAUDISH_ACCOUNTS_DIR: opts.accountsDir };
  const store = new FileTokenStore({ env });

  if (opts.accounts.length > 0) {
    const rows = opts.accounts.map((a, i) => ({
      id: a.id,
      label: a.label,
      store: "file",
      ...(a.disabled ? { enabled: false } : {}),
      addedAt: "2026-09-12T00:00:00.000Z",
      identity: { chatgptAccountId: `display-${i}` },
    }));
    writeFileSync(
      join(claudishDir, "config.json"),
      JSON.stringify({
        version: "1.0.0",
        defaultProfile: "default",
        profiles: {},
        subscriptionAccounts: { "openai-codex": { generation: 1, accounts: rows } },
      })
    );
    for (const a of opts.accounts) {
      await store.write(
        { provider: "openai-codex", id: a.id, label: a.label },
        {
          accessToken: accessTokenOf(a.label),
          refreshToken: refreshTokenOf(a.label),
          expiresAt: a.expiresAt ?? Date.now() + 3_600_000,
          accountId: `acct-${a.label}`,
          generation: 1,
          fingerprint: fingerprintOf(refreshTokenOf(a.label)),
          updatedAt: Date.now(),
        }
      );
    }
  } else {
    writeFileSync(
      join(claudishDir, "config.json"),
      JSON.stringify({ version: "1.0.0", defaultProfile: "default", profiles: {} })
    );
  }

  if (opts.legacy) {
    writeFileSync(
      join(claudishDir, "codex-oauth.json"),
      JSON.stringify({
        access_token: "access-legacy",
        refresh_token: "refresh-legacy",
        expires_at: opts.legacyExpiresAt ?? Date.now() + 3_600_000,
        account_id: "acct-legacy",
      }),
      { mode: 0o600 }
    );
  }

  // The cloud models catalog, pre-seeded from the repo's own test data so no run
  // fetches it from the network. `CLAUDISH_DISABLE_CATALOG_WARM=1` stops only
  // `warmCatalog()`: `warmRecommendedModels()` still makes its one `CONNECT`, which the
  // egress sink refuses (see `KNOWN_EGRESS` in row-env.ts).
  // Its generation id is recorded with the version pin.
  copyFileSync(CATALOG_FIXTURE, join(claudishDir, "cloud-models-catalog-v3.json"));

  // A fresh cache keeps the update check from fetching the npm registry.
  const cacheDir = join(opts.home, ".cache", "claudish");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, "update-check.json"),
    JSON.stringify({ lastCheck: Date.now(), latestVersion: null })
  );
}

export const accountIdOf = (label: string) =>
  DEFAULT_ACCOUNTS.find((a) => a.label === label)?.id ?? "";

/** The path of one account's token file (provider-namespaced, as `paths.ts` builds it). */
export const tokenPathOf = (accountsDir: string, id: string) =>
  join(accountsDir, "tokens", "openai-codex", `${id}.json`);
/** The path of one account's refresh gate. */
export const lockPathOf = (accountsDir: string, id: string) =>
  join(accountsDir, "locks", "openai-codex", `${id}.lock`);

/** Write a lock file in the format `file-lock.ts` `readHolder` parses (JSON, padded to 256 bytes). */
export function writeLockFile(
  path: string,
  holder: { pid: number; host: string; nonce: string; at: number }
): void {
  mkdirSync(dirname(path), { recursive: true });
  const json = JSON.stringify(holder);
  writeFileSync(path, `${json.padEnd(255, " ")}\n`, { mode: 0o600 });
}

/** State that the files cannot express by hand: written through the production `StateStore`. */
export type StateOp =
  | { op: "exhausted"; id: string; label: string; resetAtMs: number }
  | {
      op: "usage";
      id: string;
      label: string;
      fraction: number;
      observedAtMs: number;
      resetAtMs: number;
    };

/**
 * Apply `ops` in a CHILD process whose environment is the row's, so the
 * production `getStateStore()` resolves the row's `state.json` and account list
 * (never this process's). Returns the child's combined output; throws on failure.
 */
export function seedState(env: Record<string, string>, ops: StateOp[], scratch: string): string {
  const spec = join(scratch, "state-ops.json");
  writeFileSync(spec, JSON.stringify(ops));
  const proc = Bun.spawnSync(["bun", import.meta.path, "--state-child", spec], {
    env,
    cwd: scratch,
  });
  const out = `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
  if (proc.exitCode !== 0) throw new Error(`state seeding failed (${proc.exitCode}): ${out}`);
  return out;
}

if (import.meta.main && process.argv[2] === "--state-child") {
  const ops = JSON.parse(await Bun.file(process.argv[3] as string).text()) as StateOp[];
  const { getStateStore } = await import("../../../packages/cli/src/auth/accounts/state-store.ts");
  const store = getStateStore();
  for (const op of ops) {
    const ref = { provider: "openai-codex" as const, id: op.id, label: op.label };
    if (op.op === "exhausted") {
      await store.markExhausted(ref, op.resetAtMs);
    } else {
      await store.recordUsage(ref, {
        windows: [
          {
            slot: "primary",
            displayId: "5h",
            lengthMinutes: 300,
            usedFraction: op.fraction,
            resetAt: op.resetAtMs,
          },
        ],
        observedAt: op.observedAtMs,
      });
    }
  }
  await store.flush();
  console.log(`seeded ${ops.length} state op(s)`);
  process.exit(0);
}
