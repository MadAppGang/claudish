/**
 * Mutants: textual edits applied to a COPY of the built bundle, never to a
 * production file. A mutant is evidence only if every `find` occurs exactly once
 * in `packages/cli/dist/index.js` (checked here) and the row it belongs to turns
 * red when run against the copy (checked by the driver, stage 4b).
 *
 *   bun ai-docs/benches/account-pool-validation/mutants.ts --check
 *   bun ai-docs/benches/account-pool-validation/mutants.ts --emit <id> <outDir>
 *
 * `--emit` lays out `<outDir>/bin` (the launcher), `<outDir>/dist` (the mutated
 * bundle plus hooks.js) and links `node_modules`, so the launcher resolves the
 * copy through its own `../dist/index.js`. `<outDir>` must be outside the repo.
 *
 * The anchors name SITES in the bundle as built on 2026-11-01 (v14.10.1); the
 * line numbers in the doc have drifted, so a `find` is the multi-line text itself.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { BUNDLE, REPO } from "./row-env.ts";

export interface Edit {
  find: string;
  replace: string;
}

export interface Mutant {
  id: string;
  rows: string[];
  /** What the row must show against this mutant (red), in the row's own terms. */
  expect: string;
  edits: Edit[];
}

const NET_TRANSPORT: Edit = {
  find: 'if ((ctx.requireOAuth || this.poolConfigured() || signed.account !== undefined) && (auth.arm !== "oauth" ||',
  replace: 'if (false && (auth.arm !== "oauth" ||',
};

const NET_HANDLER: Edit = {
  find: 'if ((state2.requireOAuth || this.provider.poolConfigured?.()) && binding?.auth?.arm !== "oauth") {',
  replace: "if (false) {",
};

export const MUTANTS: Mutant[] = [
  {
    // Stands for the doc's "remove the try/catch around the :695 swap". The 2a code
    // has TWO layers there: the rotation catch (`answerAuthFailure`) and, behind it,
    // the dispatch loop's own `isAccountsError` net. Removing only the inner one is
    // dead (measured, see V1-no-rotation-catch-inner-only-DEAD): the outer net
    // answers the same 400. The mutant that turns the row red removes both.
    id: "V1-no-rotation-catch",
    rows: ["V1"],
    expect:
      "the rotation sign's AllAccountsExhaustedError ends as a 500 instead of the 400 with upstream_status 429",
    edits: [
      {
        find: `            if (!conn) {
              const answered = this.answerAuthFailure(c, err, "rethrow");
              if (answered)
                return answered;
              throw err;
            }
            const recovered = await this.recoverAtAuthSite(c, err, conn, this.connectionEndpointFor(err, activeEndpoint), rotateAndSend,`,
        replace: `            if (!conn) {
              throw err;
            }
            const recovered = await this.recoverAtAuthSite(c, err, conn, this.connectionEndpointFor(err, activeEndpoint), rotateAndSend,`,
      },
      {
        find: `            site: "response-dispatch"
          });
        if (isAccountsError(err)) {
          const answered = this.answerAuthFailure(c, err, "rethrow");
          if (answered)
            return answered;
        }
        throw err;`,
        replace: `            site: "response-dispatch"
          });
        throw err;`,
      },
    ],
  },
  {
    // The doc's single-edit form (inner catch only). A NEGATIVE control: the
    // dispatch loop's outer net answers the same 400, so the row stays green.
    id: "V1-no-rotation-catch-inner-only-DEAD",
    rows: ["V1"],
    expect: "DEAD: the outer dispatch net answers the 400 anyway",
    edits: [
      {
        find: `            if (!conn) {
              const answered = this.answerAuthFailure(c, err, "rethrow");
              if (answered)
                return answered;
              throw err;
            }
            const recovered = await this.recoverAtAuthSite(c, err, conn, this.connectionEndpointFor(err, activeEndpoint), rotateAndSend,`,
        replace: `            if (!conn) {
              throw err;
            }
            const recovered = await this.recoverAtAuthSite(c, err, conn, this.connectionEndpointFor(err, activeEndpoint), rotateAndSend,`,
      },
    ],
  },
  {
    id: "V1c-swallow-initial-sign",
    rows: ["V1c"],
    expect: "the already-exhausted pool signs with the api key: canary records exactly one request",
    edits: [
      {
        find: `      const signed = await credentials.getRequestAuth("openai-codex", {
        model: "",
        ...ctx
      });`,
        replace: `      let signed;
      try {
        signed = await credentials.getRequestAuth("openai-codex", {
          model: "",
          ...ctx
        });
      } catch {
        signed = { arm: "api-key", endpoint: super.getEndpoint(), headers: { Authorization: \`Bearer \${process.env.OPENAI_CODEX_API_KEY}\` } };
      }`,
      },
      // 2a added two redundant nets behind this site; the swallow reaches the
      // canary only with both removed (the doc's single-edit V1c mutant is stale).
      NET_TRANSPORT,
      NET_HANDLER,
    ],
  },
  {
    // The doc's single-edit V1c mutant. Kept as a NEGATIVE control: it is dead on
    // the built code because the two nets behind it throw MeteredEscapeError.
    id: "V1c-swallow-only-DEAD",
    rows: ["V1c"],
    expect:
      "DEAD: canary stays 0 and the turn ends in the transport net's 400 (proves the nets are live)",
    edits: [
      {
        find: `      const signed = await credentials.getRequestAuth("openai-codex", {
        model: "",
        ...ctx
      });`,
        replace: `      let signed;
      try {
        signed = await credentials.getRequestAuth("openai-codex", {
          model: "",
          ...ctx
        });
      } catch {
        signed = { arm: "api-key", endpoint: super.getEndpoint(), headers: { Authorization: \`Bearer \${process.env.OPENAI_CODEX_API_KEY}\` } };
      }`,
      },
    ],
  },
  {
    id: "V1b-no-transport-net",
    rows: ["V1b"],
    expect:
      "the 400 carries the handler backstop's message, not the transport's 'non-OAuth artifact' one; canary 0",
    edits: [NET_TRANSPORT],
  },
  {
    id: "V1b-no-nets",
    rows: ["V1b"],
    expect: "the substituted api-key artifact is sent: canary records exactly one request",
    edits: [NET_TRANSPORT, NET_HANDLER],
  },
  {
    id: "V8-no-record-retry",
    rows: ["V8"],
    expect:
      "the second account is not marked: a transient 429 'retry deferred' replaces the pinned all-accounts message",
    edits: [
      {
        find: "await reportQuota(quota, response.headers);",
        replace: "if (state2.quotaRotations < 1) await reportQuota(quota, response.headers);",
      },
    ],
  },
  {
    id: "V11-no-rotation",
    rows: ["V11"],
    expect:
      "one main attempt, no switch record, the transcript shows the transient 429 instead of the answer",
    edits: [
      {
        find: "if (state2.quotaRotations >= 1 || !this.provider.signRequest || codeModeShape !== undefined) {",
        replace: "if (true) {",
      },
    ],
  },
  {
    id: "V11-quota-to-terminal",
    rows: ["V11"],
    expect:
      "the quota 429 reaches the terminal block: stderr carries 'Error [Codex]: HTTP 429' (proves the line is observable)",
    edits: [
      {
        find: `        const quota = await pooledHttpQuota(response);
        if (quota) {`,
        replace: `        const quota = null;
        if (quota) {`,
      },
    ],
  },
  {
    id: "V10-no-material-moved",
    rows: ["V10"],
    expect:
      "(a) and (b) stay blocked for the retry interval: the main turn is refused with zero exchanges",
    edits: [
      {
        find: "function reauthMaterialMoved(mark, stored) {",
        replace: "function reauthMaterialMoved(mark, stored) {\n  return false;",
      },
    ],
  },
  {
    id: "V10-no-baseline-in-mark",
    rows: ["V10"],
    expect:
      "the production-written mark has no baseline: (a) and (b) never heal, the re-login stays blocked until the retry is due",
    edits: [
      {
        find: `        lastReason: reason,
        failedGeneration: record4.generation,
        failedFingerprint: record4.fingerprint
      });`,
        replace: `        lastReason: reason
      });`,
      },
    ],
  },
  {
    id: "V10-no-heal-in-acquire",
    rows: ["V10"],
    expect: "(a) waits for the retry: the healed mark is still in state.json after the turn",
    edits: [{ find: "await this.healReauthMarks(context, opts.pin);", replace: "" }],
  },
  {
    id: "V16b-registry-failed-as-absent",
    rows: ["V16b"],
    expect:
      "pool half: an unreadable legacy file reads as absent, the predicate is false, canary records exactly 1",
    edits: [
      {
        find: `    const failed = (detail, type) => {
      this.legacyStatus = {
        state: "failed",`,
        replace: `    const failed = (detail, type) => {
      this.lastGoodLegacy = null;
      this.legacyStatus = { state: "absent", path };
      return;
      this.legacyStatus = {
        state: "failed",`,
      },
    ],
  },
  {
    // Doc V16b live-half mutant 1. Probed on the built bundle: see rows-contract V16b.
    id: "V16b-hascredentials-revert-DEAD",
    rows: ["V16b"],
    expect:
      "doc: failed file reads as absent on the live half. Measured DEAD: the pool pre-empts the singleton",
    edits: [
      {
        find: "return this.credentials !== null && !!this.credentials.refresh_token || this.credentialFileFailure !== null;",
        replace: "return this.credentials !== null && !!this.credentials.refresh_token;",
      },
    ],
  },
  {
    // Doc V16b live-half mutant 2.
    id: "V16b-existssync-absence-DEAD",
    rows: ["V16b"],
    expect:
      "doc: chmod 000 ~/.claudish reads as absent on the live half. Measured DEAD: the pool pre-empts the singleton",
    edits: [
      {
        find: `      if (isAbsenceError(e))
        return null;
      throw credentialFileUnreadable(credPath, errorMessage(e));`,
        replace: `      if (!existsSync18(credPath))
        return null;
      throw credentialFileUnreadable(credPath, errorMessage(e));`,
      },
    ],
  },
  {
    id: "V17-pool-available-when-empty",
    rows: ["V17"],
    expect:
      "a pooled path is attempted for an api-key-only user: canary stays 0 and the turn fails instead of reaching the metered host",
    edits: [
      {
        find: `  async isAvailable() {
    return this.registry.hasConfiguredAccounts("openai-codex");`,
        replace: `  async isAvailable() {
    return true;`,
      },
    ],
  },
  {
    id: "V2-no-exclusive-create",
    rows: ["V2"],
    expect: "four processes exchange: exchange count 4, three invalid_grant",
    edits: [
      { find: 'fd = openSync2(path, "wx", 384);', replace: 'fd = openSync2(path, "w", 384);' },
    ],
  },
  {
    // Doc V2e: "route KeychainTokenStore's token reads through the memoizing helper". The
    // refresh path passes `uncached`; dropping it lets the second process's post-acquire
    // re-read hit the 3 s memo filled by its first read, so it sees the pre-rotation record.
    id: "V2e-keychain-reads-memoized",
    rows: ["V2e"],
    expect: "the second process exchanges the revoked refresh token (invalid_grant)",
    edits: [
      {
        find: "...opts.uncached ? { uncached: true } : {}",
        replace: "...{}",
      },
    ],
  },
  {
    id: "V2b-no-dead-holder-detection",
    rows: ["V2b"],
    expect: "the steal waits the full 20 s and fails with RefreshUnavailableError",
    edits: [
      {
        find: "const dead = !deps.isProcessAlive(seen.holder.pid);",
        replace: "const dead = false;",
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // Stage 4b: the mutants the contract marked "planned". Each states the doc
  // mutation it stands for; each anchor is checked once by `--check`.
  // ---------------------------------------------------------------------------
  {
    // Doc V1d: "put the swallow inside CodexPoolHalf.isAvailable() — try { read
    // material } catch { return false }". Reading material = one `pool.acquire`,
    // which is what throws under `store-read-throws`. Like V1c, the swallow reaches
    // the canary only with the two redundant nets removed (2a added them).
    id: "V1d-swallow-in-isavailable",
    rows: ["V1d"],
    expect:
      "an unreadable token store reads as 'pool unavailable': the api key signs and the canary records exactly one request",
    edits: [
      {
        find: `  async isAvailable() {
    return this.registry.hasConfiguredAccounts("openai-codex");`,
        replace: `  async isAvailable() {
    try {
      await this.pool.acquire({});
    } catch {
      return false;
    }
    return this.registry.hasConfiguredAccounts("openai-codex");`,
      },
      NET_TRANSPORT,
      NET_HANDLER,
    ],
  },
  {
    // The single-edit form, kept as a NEGATIVE control exactly like V1c's: the two
    // nets behind the swallow catch it (canary stays 0, the turn ends 400 terminal).
    id: "V1d-swallow-only-DEAD",
    rows: ["V1d"],
    expect:
      "DEAD: the transport and handler nets turn the escape into a 400 terminal; canary stays 0",
    edits: [
      {
        find: `  async isAvailable() {
    return this.registry.hasConfiguredAccounts("openai-codex");`,
        replace: `  async isAvailable() {
    try {
      await this.pool.acquire({});
    } catch {
      return false;
    }
    return this.registry.hasConfiguredAccounts("openai-codex");`,
      },
    ],
  },
  {
    // Doc V1e: "have registry.ts read through loadConfig()" whose catch returns
    // DEFAULT_CONFIG: a failed config read becomes an ABSENT (empty) account list.
    id: "V1e-config-failed-as-absent",
    rows: ["V1e"],
    expect:
      "a truncated or unreadable config.json reads as an empty account list: the predicate goes false and the canary records a request",
    edits: [
      {
        find: `    const failed = (detail, type) => {
      this.configStatus = {
        state: "failed",`,
        replace: `    const failed = (detail, type) => {
      this.lastGoodSettings = {};
      this.configStatus = { state: "absent", path };
      return;
      this.configStatus = {
        state: "failed",`,
      },
    ],
  },
  {
    // Doc V2c: "let a timeout fall through to an unlocked refresh". A rewrite of
    // the token manager's gate-unavailable branch (withGate), not a deletion.
    id: "V2c-timeout-unlocked-refresh",
    rows: ["V2c"],
    expect:
      "the waiter refreshes without the gate after its acquire timeout: a token exchange appears at the fake",
    edits: [
      {
        find: `      if (!isGateUnavailable(err))
        throw err;
      const latest = await this.readOrThrow(ref, { uncached: true });`,
        replace: `      if (!isGateUnavailable(err))
        throw err;
      if (err.reason === "timeout")
        return await this.refreshUnderGate(ref, { nonce: "unlocked", pid: process.pid, host: "", path: lockPath2, holdsLock: () => true, release() {}, startHeartbeat() {} }, rejectedFp);
      const latest = await this.readOrThrow(ref, { uncached: true });`,
      },
    ],
  },
  {
    // Doc V2d: "restore 'any non-EEXIST error -> degrade to unlocked'". The doc's
    // site is tryCreate; the equivalent effect is placed at its only caller that
    // maps "unwritable" to 'refresh disabled' (withGate), because tryCreate
    // returns a descriptor and cannot hand back "no lock" without a larger rewrite.
    id: "V2d-unwritable-unlocked-refresh",
    rows: ["V2d"],
    expect:
      "an unwritable lock directory degrades to an unlocked refresh: a token exchange appears at the fake",
    edits: [
      {
        find: `      if (!isGateUnavailable(err))
        throw err;
      const latest = await this.readOrThrow(ref, { uncached: true });`,
        replace: `      if (!isGateUnavailable(err))
        throw err;
      if (err.reason === "unwritable")
        return await this.refreshUnderGate(ref, { nonce: "unlocked", pid: process.pid, host: "", path: lockPath2, holdsLock: () => true, release() {}, startHeartbeat() {} }, rejectedFp);
      const latest = await this.readOrThrow(ref, { uncached: true });`,
      },
    ],
  },
  {
    // Doc V2f: "release and fence on pid alone". The fence compare is sameIdentity;
    // dropping the nonce makes a successor under the same pid indistinguishable.
    id: "V2f-fence-on-pid-only",
    rows: ["V2f"],
    expect: "the stolen-from holder still persists: the token file reaches generation seed + 1",
    edits: [
      {
        find: "return a !== null && a.nonce === b.nonce && a.pid === b.pid && a.host === b.host;",
        replace: "return a !== null && a.pid === b.pid && a.host === b.host;",
      },
    ],
  },
  {
    // Doc V3: "restore blanket 5 s coalescing for selection-relevant usage writes".
    id: "V3-coalesce-selection-usage",
    rows: ["V3"],
    expect:
      "the 92% crossing is coalesced and not persisted: the second process reads the pre-crossing state and selects A",
    edits: [
      {
        find: `    if (!opts.selectionRelevant) {
      const last = this.lastUsageWrite.get(key) ?? 0;`,
        replace: `    if (true) {
      const last = this.lastUsageWrite.get(key) ?? 0;`,
      },
    ],
  },
  {
    // Doc V3b: "restore 'snapshots older than 15 min count as unknown, and unknown
    // is eligible'" in the policy's window liveness.
    id: "V3b-stale-usage-is-unknown",
    rows: ["V3b"],
    expect: "A's 20-minute-old 92% snapshot is dropped as unknown and A (eligible) is selected",
    edits: [
      {
        find: `function liveWindows(usage, now) {
  if (!usage)
    return [];`,
        replace: `function liveWindows(usage, now) {
  if (!usage || now - usage.observedAt > 15 * 60000)
    return [];`,
      },
    ],
  },
  {
    // Doc V8b: "call acquire/refresh/heal/setActive in the query": the capacity
    // query becomes an acquiring call, which refreshes C's expired token.
    id: "V8b-acquire-in-query",
    rows: ["V8b"],
    expect: "the capacity query refreshes C: one token exchange appears and C's token file changes",
    edits: [
      {
        find: "const capacityResponse = () => {",
        replace: "const capacityResponse = async () => {",
      },
      {
        find: `        const failure = pool.errorIfNoEligible({
          exclude: state2.exclude,
          selectionContext: state2.selectionContext
        });
        if (failure)
          throw failure;`,
        replace:
          "        await pool.acquire({ exclude: state2.exclude, selectionContext: state2.selectionContext });",
      },
    ],
  },
  {
    // Doc V9: "remove the journal": the journal is never made durable before the
    // exchange.
    id: "V9-no-journal",
    rows: ["V9"],
    expect:
      "no open journal survives the failed persist: the next process reads the vendor rejection, not 'a token rotation was interrupted'",
    edits: [
      {
        find: 'const journalled = await this.persist(ref, { ...record4, journal }, handle, "journal");',
        replace: "const journalled = record4;",
      },
    ],
  },
  {
    // Doc V9b: "write the pre-write record back with only journal.state changed".
    // Stand-in: the on-disk writeId is never recognised as a commit, so a committed
    // rotation is resolved as NOT committed and the turn fails.
    id: "V9b-committed-resolved-as-uncommitted",
    rows: ["V9b"],
    expect:
      "the committed rotation is lost to the caller: HTTP 503 instead of 200 on the new bearer",
    edits: [
      {
        find: "if (onDisk?.writeId === intended.writeId) {",
        replace: "if (false) {",
      },
    ],
  },
  {
    // Doc V10b: "remove the gate-ownership check on the needsReauth write".
    id: "V10b-no-gate-ownership-check",
    rows: ["V10b"],
    expect: "a holder that lost the gate still writes needsReauth: the mark appears in state.json",
    edits: [
      {
        find: `    if (!handle.holdsLock()) {
      throw new RefreshUnavailableError("the refresh gate was lost during the exchange", \`\${ref.provider}/\${ref.id}\`);
    }`,
        replace: "",
      },
    ],
  },
  {
    // Not in the doc: makes V10 case (c) evidence. The doc's three V10 mutants all
    // target the heal arms; none reaches the "refused until the retry is due" arm.
    id: "V10c-retry-always-due",
    rows: ["V10"],
    expect:
      "case (c): the untouched needsReauth mark no longer blocks; P2 exchanges at once instead of being refused",
    edits: [
      {
        find: "function isReauthRetryDue(record4, lastAttemptAt, now) {",
        replace: "function isReauthRetryDue(record4, lastAttemptAt, now) {\n  return true;",
      },
    ],
  },
  {
    // Doc V14: "refresh the probe's oracle only on this process's own mutations":
    // the registry stops re-statting config.json on every answer.
    id: "V14-no-restat-per-answer",
    rows: ["V14"],
    expect:
      "the long-lived process keeps serving the account another process disabled: bearer access-A on request 2",
    edits: [
      {
        find: `  refreshConfig() {
    const path = this.configPath();`,
        replace: `  refreshConfig() {
    const path = this.configPath();
    if (this.configStamp !== undefined)
      return;`,
      },
    ],
  },
];

export function occurrences(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length))
    count++;
  return count;
}

export function applyMutant(bundle: string, mutant: Mutant): string {
  let out = bundle;
  for (const edit of mutant.edits) {
    const n = occurrences(out, edit.find);
    if (n !== 1)
      throw new Error(`mutant ${mutant.id}: anchor occurs ${n} times, expected 1:\n${edit.find}`);
    out = out.replace(edit.find, () => edit.replace);
  }
  return out;
}

/** Lay out a runnable copy of the built tree with `mutant` applied. Returns the launcher path. */
export function emitMutantTree(mutant: Mutant, outDir: string): string {
  const root = resolve(outDir);
  if (root.startsWith(`${REPO}/`) && !root.includes("/ai-docs/sessions/")) {
    throw new Error(`refusing to emit a mutant inside the repo tree: ${root}`);
  }
  const cli = join(REPO, "packages/cli");
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  for (const f of readdirSync(join(cli, "bin")))
    copyFileSync(join(cli, "bin", f), join(root, "bin", f));
  copyFileSync(join(cli, "package.json"), join(root, "package.json"));
  copyFileSync(join(cli, "dist/hooks.js"), join(root, "dist/hooks.js"));
  writeFileSync(join(root, "dist/index.js"), applyMutant(readFileSync(BUNDLE, "utf8"), mutant), {
    mode: 0o755,
  });
  const link = join(root, "node_modules");
  if (!existsSync(link)) symlinkSync(join(cli, "node_modules"), link);
  return join(root, "bin/claudish.cjs");
}

if (import.meta.main) {
  const [cmd, id, outDir] = process.argv.slice(2);
  const bundle = readFileSync(BUNDLE, "utf8");
  if (cmd === "--check") {
    let bad = 0;
    for (const m of MUTANTS) {
      const counts = m.edits.map((e) => occurrences(bundle, e.find));
      let parses = "parses";
      if (counts.every((n) => n === 1)) {
        try {
          // The edit must still be valid JavaScript, or the row would "fail" for the wrong reason.
          new Bun.Transpiler({ loader: "js" }).transformSync(applyMutant(bundle, m));
        } catch (err) {
          parses = `SYNTAX ERROR: ${String(err).slice(0, 120)}`;
        }
      }
      const ok = counts.every((n) => n === 1) && parses === "parses";
      if (!ok) bad++;
      console.log(
        `${ok ? "OK  " : "BAD "} ${m.id.padEnd(30)} rows=${m.rows.join(",")} anchors=${counts.join(",")} ${parses}`
      );
    }
    process.exit(bad === 0 ? 0 : 1);
  }
  if (cmd === "--emit") {
    const mutant = MUTANTS.find((m) => m.id === id);
    if (!mutant || !outDir) {
      console.error("usage: --emit <id> <outDir>");
      process.exit(2);
    }
    console.log(emitMutantTree(mutant, outDir));
    process.exit(0);
  }
  console.error("usage: --check | --emit <id> <outDir>");
  process.exit(2);
}
