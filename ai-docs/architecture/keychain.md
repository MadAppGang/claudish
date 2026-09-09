> The macOS Keychain credential backend: the latency measurement that dictated its shape, the two
> `security` behaviours that are traps, and why it resolves above 1Password but below env.
>
> Indexed in [`README.md`](./README.md). Sibling: [`onepassword.md`](./onepassword.md).

# macOS Keychain backend (v7.65.0+)

A local, encrypted-at-rest store for provider API keys, sitting between `config.json` and
1Password in the credential authority's resolution chain. Engine in
`providers/keychain.ts`; the lazy source behind the authority in
`auth/credentials/keychain-source.ts`; CLI in `keychain-command.ts`.

```
1. process.env[ENV_VAR]
2. process.env[alias]
3. config.json apiKeys
4. ► macOS Keychain
5. 1Password (lazy SDK)
```

**Above 1Password** because it is local, costs one subprocess, and once its ACL is established it
never prompts — where a 1Password resolve is a desktop-app handshake that can be denied, and whose
denials trip a 15-second machine-wide suppression (`onepassword.md`). Cheap and quiet goes first.

**Below env and config** because a user who exports a key, or types one into the config, means it.
Inverting that would let a stale vault entry silently outrank a deliberate override.

## Storage layout

```
service = "claudish"
account = the env var name              e.g. GEMINI_API_KEY
label   = "claudish: GEMINI_API_KEY"       (findable in Keychain Access.app)
value   = the secret — UTF-8, no control characters
```

One item per variable, not one JSON blob. The blob would collapse N spawns into one, but
`dump-keychain` already collapses the only operation that needed N, so it buys nothing and costs
per-item visibility, deletability and ACLs.

## The measurement that dictated the architecture

Measured on darwin 25.6.0, 441-item login keychain
(full transcripts: [`../reports/keychain-security-cli-measurements.md`](../reports/keychain-security-cli-measurements.md)):

| Operation | Cost | Prompts? |
|---|---|---|
| `find-generic-password -s claudish -a VAR -w` | **17.4 ms** per variable | no (after the ACL is set) |
| `dump-keychain` (no `-d`) | **28 ms** for the ENTIRE item list | no |

That gap is the whole design. A per-variable read cannot sit on a synchronous path: 25 providers
would cost ~435 ms against a provider-registration pass measured at ~1.5–2 ms
(`local-api-key.ts`). Enumeration can, because it answers for every provider at once.

So **presence** comes from enumeration and **values** come from targeted reads:

- `keychainHasVar()` / `keychainHasAnyOf()` — one `dump-keychain`, memoized. Used by the
  predefined-endpoint registration gate, which cannot await.
- `readKeychainSecret()` — one targeted read, only for a name enumeration already confirmed is
  present. A provider with nothing stored costs no per-variable spawn at all.

`dump-keychain` is prompt-free because without `-d` it reads item ATTRIBUTES and never item DATA;
the per-item access dialog is triggered by reading data. This is also why enumeration cannot
return values, and why the two paths stay separate.

Both memos use a **3-second TTL**, not process lifetime: the user can edit the keychain in
Keychain Access.app and another claudish process can write it while this one runs. The goal is
collapsing a burst inside one operation, not caching across a session — the same reasoning, and
the same TTL, as `antigravity-token.ts`'s shared-token memo.

## `security` behaviours that are traps

### 1. `-w` returns HEX for values containing control characters

`find-generic-password -w` prints the value as raw text for printable data, but as a hex string
when the data contains control characters — with nothing in the output distinguishing the two. A
printable key that happens to be all hex digits is genuinely ambiguous, so this cannot be resolved
at read time.

It is resolved at **write** time instead: `describeUnstorableValue()` rejects any value containing
a C0 control or DEL, which makes every stored value unambiguous by construction. API keys are
single-line printable tokens, so nothing a user actually has is refused.

### 2. The documented "secure" write mode silently stores an EMPTY value

The man page says to pass `-w` last so `security` prompts for the password. Measured, that path
demands the value TWICE, fails the confirmation on a single piped line, prints
`passwords don't match` — and **exits 0 having created an item with an empty password**. A write
that reports success while storing nothing is worse than no write path at all.

Writes therefore go through **`security -i`**, which reads the command from stdin. Measured exit
codes prove failures actually surface there: 0 on success, 45 on a duplicate without `-U`, 1 on an
unknown subcommand.

### 3. `execFileSync(..., {input})` HANGS inside any TUI

Node's synchronous `execFileSync` with an `input` option blocks forever when the
parent process's stdin is in **raw mode** or has an active **`data` listener** — which is
precisely what an OpenTUI app does. Measured inside the config TUI: the call sat for the full
timeout and returned `status: null, signal: "SIGTERM", code: "ETIMEDOUT"` with EMPTY stderr,
freezing the entire interface for ten seconds first. The identical code succeeds from a plain
CLI process, so **this is invisible to unit tests and to CLI testing alike** — only driving the
real TUI surfaces it.

`Bun.spawnSync` with a `Uint8Array` stdin has no such interaction: verified under raw mode with a
data listener attached, exit 0 in ~30 ms, value round-tripped. Both `syncRun` and `asyncRun` use
Bun's native spawn. `bin/claudish.cjs` refuses to run under Node at all, so the `Bun` global is
guaranteed.

A related trap this exposed: `exitCode` is `null` for a signal-killed process, and an early
version collapsed that to `1`, reporting a ten-second timeout as "security exited 1". A fabricated
exit code sends the next investigation in the wrong direction — `normalizeResult` now reports
`-1` and names the signal instead.

### 4. `execFileSync` INHERITS stderr unless `stdio` is named

Node documents `execFileSync`'s `stdio` default as `'pipe'`, then carves out one exception:
stderr goes to the **parent's** stderr unless `stdio` is given explicitly. So
`execFileSync("security", args, { encoding: "utf8" })` — no `stdio` — writes the child's
complaints straight into claudish's terminal.

That matters here because the most common keychain operation is a **miss**, and a miss is not an
error: exit 44 means "the user has not stored this", which every caller already handles by
returning `null`. `security` still announces it:

```
security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.
```

A surrounding `try`/`catch` does **not** suppress that line. The catch owns the *exception*; the
child already owned the *file descriptor*, and the write happened in another process before
`execFileSync` ever threw.

Shipped in `auth/antigravity-token.ts`'s `defaultReadStore` up to v9.0.7. The config TUI rebuilds
its provider roster on every render and each rebuild calls `hasSharedAntigravityToken()`, so the
two memos only collapse a burst — one spawn, and one leaked line, still got through every
`HAS_TOKEN_TTL_MS` (5 s) for as long as the view was open. claudish shares a terminal with the
Claude Code TUI, so the result was a display corrupted every five seconds for any user not signed
in to Antigravity. `providers/keychain.ts` was never affected: `syncRun` and `asyncRun` both pipe
stderr deliberately.

The fix names `stdio`, and **stdout must stay piped** — it carries the secret. The write and
delete siblings in the same file can use `["ignore","ignore","ignore"]` only because they read
nothing but an exit code; copying that shape onto a read silently returns `null` for every user.

Reproducing a miss needs no real keychain and no logout: `antigravity-token.ts` resolves bare
`"security"` through `PATH` while `providers/keychain.ts` uses the absolute `/usr/bin/security`,
so a `PATH` shim that exits 44 intercepts exactly the one call. Measured that way against the real
`hasSharedAntigravityToken()`: **2 leaked lines before the fix, 0 after.**

### Other measured constants

| Condition | exit |
|---|---|
| lookup miss, and delete of an absent item | **44** — the "genuinely absent" signal, distinguished from a real failure |
| `add-generic-password` without `-U` on an existing item | **45** (`-25299`) — always pass `-U` |

`-w` output carries exactly one appended `\n`. The engine strips ONE trailing newline rather than
calling `.trim()`: trim would also eat whitespace genuinely part of a secret, turning a working
key into a 401 nobody can explain.

## Why the `security` CLI and not a native binding

A keychain item's ACL is bound to the code signature of the accessing binary. `/usr/bin/security`
is Apple-signed with a stable path, so a value written through it reads back through it silently.
A native binding inside a `bun`-compiled executable presents a different identity that changes
with every rebuild and every `bun` upgrade — surfacing as a fresh "claudish wants to access your
keychain" dialog each time. The subprocess is the less elegant option and the only quiet one.
Writes pass `-T /usr/bin/security` to pin that ACL explicitly.

## Secrets never touch argv

`security add-generic-password -w <secret>` places the secret in the process's argv, where any
other user on the machine can read it from `ps` for the duration of the call. Every write here
sends its command over stdin via `security -i`, with the value carried as `-X <hex>` so no
shell-style quoting of the secret is required.

The stdin line still needs quoting for the OTHER arguments — `security -i` tokenizes like a shell,
and an unquoted label (`claudish: GEMINI_API_KEY`) split on its space and made every write fail
with a usage dump. `quoteForStdin()` quotes every argument uniformly rather than only where a
space is expected today.

**Verified negative — `security -i` does NOT echo the failing command to stderr.** This matters
because `writeKeychainSecret` splices `res.stderr` into its error message, which surfaces in the
TUI status line and the CLI; if the command were echoed, the `-X <hex>` secret would leak through
every one of those. Probed with a canary value (`probe-stderr-leak.ts`): a duplicate-write failure
returns 227 bytes naming only the error and the keychain path, and a malformed command returns the
usage text — neither contains the secret in hex OR plaintext form. (An earlier reading of a
TRUNCATED stderr ended in a dangling `add`, which looked like a command echo and was in fact
`add-generic-password: returned -25299` cut mid-word. Truncating diagnostic output during a
security review invents findings as easily as it hides them.)

**Known gap, pre-existing and out of scope here:** `auth/antigravity-token.ts:162` writes the
shared agy token with `-w` in argv and has this exposure. Fixing it means touching the shared
agy/claudish token path, which deserves its own change.

## Write verification

`writeKeychainSecret` reads the value back and compares. macOS imposes its own limits on item
data; rather than hard-code a ceiling this cannot verify, the round-trip proves the store holds
what the user was told it holds. ~17 ms extra on an operation that happens once per key.

## The laziness gate, and why no name index

`config.json` gains ONE field:

```jsonc
"keychain": { "enabled": true }
```

`hasKeychainSource()` is a sync sniff — platform plus that boolean, mirroring `hasOpSources()`. A
user who never opts in pays **zero** keychain I/O. It is set automatically on the first successful
write, and only after one: enabling first would leave the backend on after a failed write,
pointing at a store with nothing in it.

The flag records that the backend is IN USE. It deliberately does **not** mirror the stored
variable names. An index was the first design and enumeration being cheap killed it — a mirrored
list is a second thing that can be wrong, which is the exact "two answers to one question" pattern
`auth/credentials/source.ts` exists to eliminate.

**`keychain` MUST be in `profile-config.ts` `loadConfig`'s allowlist.** A field missing from that
list survives on disk until the first global save and is then silently dropped — the trap
`onepasswordEnvironments` hit, which here would quietly disable the backend.

## Why there is no new `CredentialSource` member

The strings in `CredentialSource` are a **wire contract** consumed by the external
claude-desktop-profiles app through `claudish providers --json` (`source.ts`). Adding a member
would need a coordinated change on that side.

A keychain key therefore follows the path 1Password already uses: the authority **write-throughs**
the resolved value into `process.env`, after which the existing sync rules classify it as `"env"`
— which by then is literally true. Spawned children inherit it and re-resolve nothing.

Origin is tracked separately, for display only, by `isKeychainHydratedVar()` (run-scoped, names
only, never values) — the exact counterpart of `isOpHydratedVar()`. `api-key-provenance.ts`
consults it BEFORE the 1Password branch, because the keychain resolves first, so a variable both
stores could supply was supplied by this one.

## `failed` vs `absent` — the distinction that must never collapse

"I could not ask" and "there is nothing there" are different answers, and every layer here keeps
them apart:

- `enumerateKeychainVars()` → `{names, failed, error?}`
- `lookupKeychainVar()` → `{present, failed}`
- `resolveKeychainKeyForEnvVars()` → `{value?, failed}`

- **absent** — no item for this variable. A stable answer; the authority may cache the miss.
- **failed** — the keychain could not be asked (locked, declined ACL, missing binary). Transient,
  so the authority leaves the result UNCACHED and retries on the next call.

An early version returned a bare `string[]` from enumeration and turned any non-zero
`dump-keychain` into `[]`. Code review found the consequences compound all the way down: a locked
store reads as "nothing stored" → the source reports clean absence → the authority caches the miss
for the process lifetime → predefined endpoints silently vanish → `status` cheerfully reports zero
keys. Worst of all, **`keychain import` built its overwrite plan from that false-empty set**, so
every existing key would be marked `new`, the overwrite warning would never print, and `-U` would
replace them all on a confirmation the user gave for something else. `import` now REFUSES to run
when enumeration fails, and `status` / `list` say "could not read the keychain" and exit non-zero
rather than printing a reassuring `0`.

The op source draws the same line for denied handshakes, for the same reason.

## Config TUI (Providers tab)

- **Startup hydration.** `hydrateKeychainIntoEnv()` runs once at mount, in PARALLEL (ten keys cost
  roughly one read's wall clock, not ten). Needed because `describeSourceSync` — which decides the
  readiness dot, the "configured first" sort and the not-configured divider — cannot await, so a
  keychain-only provider would render as unconfigured despite working at request time.
- **Hydration filters on `resolveLocalApiKey`, NOT on `process.env`.** This is subtle and was a
  real bug. `config.json` outranks the keychain but does not live in `process.env`, so skipping
  only variables "absent from env" pushed the keychain value into env — where step 1 of the chain
  finds it FIRST and the config key that should have won is never consulted. The TUI would then
  sign with a different credential than the same machine uses outside the TUI. Filtering through
  the authority's own steps 1-3 keeps the two identical. The post-await re-check uses the same
  predicate, for the same reason.
- **The open input pins its provider by IDENTITY, not row index** (`inputTargetRef`). Selection is
  a numeric index into a list that RE-SORTS on readiness change, and hydration flips several
  providers to ready a few hundred milliseconds after mount. A user typing immediately could have
  the rows move under an open input, and reading `selectedProvider` at submit time would store the
  secret they typed for provider A into provider B's variable — after which a probe sends that
  credential to B's endpoint. Found in review; there is no cheaper fix than pinning the identity.
- **A TUI write records `recordKeychainHydratedVar`.** Without it `x` cannot tell that the env
  value came from the keychain, so a just-stored-then-deleted secret stays live in `process.env`,
  inherited by children and still authenticating, until the process exits. (Overwriting a
  shell-exported value on write is deliberate and not the same bug: the user typed a replacement,
  and only this process is affected.)
- **`x` deletes ALIASES too**, and a delete FAILURE outranks both the success and empty-state
  messages. Deleting only the primary name left an alias item still authenticating the provider —
  a delete that visibly does nothing — and an unconditional final `setStatusMsg` used to overwrite
  a denied-ACL error with "No stored config to remove", reporting a live credential as absent.
- **`s` writes to the keychain by default on macOS**, falling back to `config.json` elsewhere or
  when the write fails (the failure reason is surfaced, and the key the user just typed is not
  lost). The input box title names the destination — a silent change of store for secrets is not
  something to spring on a user.
- **`x` deletes from BOTH stores** and clears the `process.env` write-through mirror, but only
  when the value CAME from a vault — a genuine shell export is the user's own environment and not
  ours to unset. Deleting only `config.json` would leave the keychain copy resolving happily and
  the provider green after the user asked for it to be gone.
- Both paths call `credentials.invalidate(catalogName)`. The authority memoizes each provider's
  resolved key, so without it a deleted key keeps being served and a new one is not seen until
  relaunch.
- `keychainVars` is held in React STATE, refreshed at mount and after mutations — never read per
  render, since `listKeychainVars()` spawns a subprocess behind a 3-second memo and a render-path
  call would fork one every few seconds for the life of the TUI.

## Config TUI (1Password tab) — copying INTO the keychain

`c` copies the selected entry, `C` copies every entry — the in-TUI equivalent of
`claudish keychain import --from 1password`. A ref becomes one item; a set or an Environment
becomes one item per variable. `copyOpToKeychain` resolves through the same calls as
`testOpEntry`, `withSdkRetry` included, so a copy cannot interleave with a test or an add and
corrupt the WASM bridge (the `-4` IPC fix).

**`key.raw === "C"` is tested BEFORE `key.name === "c"`.** `key.name` is `"c"` for both cases, so
checking the lowercase branch first makes the uppercase binding permanently unreachable.

**Resolve everything, then write.** A partial resolve that had already written half the keys would
leave the keychain in a state neither the user nor the status line could describe. One unstorable
value or a denied ACL is collected and reported by NAME, never aborting the batch — and never
carrying `security`'s stderr into a status line, which is not a safe place to put text derived
from a failed secret operation.

**It overwrites with no confirmation, deliberately.** 1Password still holds every value, so a
replaced item is a REFRESH, not a loss — and this tab's `x` already removes an entry with no
prompt, so gating a non-destructive refresh would be the inconsistent choice. The user gets an
exact `N new · M replaced · K skipped` report instead of a dialog.

## CLI

```
claudish keychain status|list|import|set|rm|enable|disable
```

`import` is the migration path: it copies from environment variables and/or the configured
1Password sources. Environment is gathered first and 1Password fills only the gaps, matching
runtime precedence — if a variable is live in the shell, that is the value claudish uses today,
and copying a different one out of a vault would silently change which credential signs requests.

The plan names every variable, marks each `new` / `overwrite` / `unchanged`, and requires explicit
confirmation, because an overwritten keychain value is not recoverable. `unchanged` exists so an
idempotent re-run does not invite the user to approve a destructive-sounding action that destroys
nothing. `--dry-run` prints the plan and stops.

No command prints a secret; `list` and the plan show a `••••1234` identification tail only — the
same affordance the 1Password tab uses. `set` reads from a hidden prompt or piped stdin, and there
is deliberately **no `--value` flag**: it would put the secret in argv and in shell history.

## NEVER verify against the real login keychain — `CLAUDISH_KEYCHAIN_FILE`

**This one was learned the hard way and cost the developer's whole desktop session.**

While developing this module, end-to-end verification ran against the real login keychain. The
`execFileSync` hang above meant several `security` processes were **killed by SIGTERM mid-
transaction**, and macOS responded by restarting `securityd`. A `securityd` restart drops the
authenticated keychain session of EVERY running application, so the entire machine began
demanding re-authorization, app by app, item by item.

Nothing was lost and no ACL was altered — the default keychain, the search list, item data and
non-claudish ACLs were all verified intact afterwards, and a data read on an unrelated item
succeeded without a prompt. The cost was purely disruption, and it was entirely avoidable.

The lesson is not "be careful". It is that a safe target must EXIST:

```bash
security create-keychain -p <pw> /tmp/test.keychain-db   # NOT added to the search list
security unlock-keychain -p <pw> /tmp/test.keychain-db
security set-keychain-settings /tmp/test.keychain-db     # no auto-lock → no prompts
export CLAUDISH_KEYCHAIN_FILE=/tmp/test.keychain-db
```

`keychainFileArgs()` appends that path to every `security` invocation — `security` takes an
optional trailing keychain argument on every subcommand, and it must come LAST. `create-keychain`
does not touch the search list, so the login keychain and every other application are unaffected.
The worked example — assert the redirection is live BEFORE the first write, and assert zero
`claudish` items in the login keychain after — is recorded in
[`../reports/keychain-security-cli-measurements.md`](../reports/keychain-security-cli-measurements.md) §7,
along with the incident that motivated it.

Live verification is still worth doing — it is the only thing that caught the raw-mode hang — but
it goes here, never at the default keychain.

## `CLAUDISH_DISABLE_KEYCHAIN=1` — the escape hatch tests need

`hasKeychainSource()` returns false when this is set, mirroring `CLAUDISH_DISABLE_OP` for
1Password, and `scripts/guard-real-config.ts` (behind `bun run test:safe`) sets BOTH for the whole
suite.

It exists because the backend shipped without one and a test run reached the developer's real
login keychain. `isKeychainEnabled()` reads `~/.claudish/config.json` whenever no `--config`
override is active, so a `keychain.enabled` on the machine was enough to make an unrelated suite
spawn `security dump-keychain` — and a config flag written by one of this feature's own write paths
put it there.

`mock.module` cannot substitute: Bun's registry is process-global and a stub bleeds into sibling
files that test the real module. A flag the PRODUCTION code honours is the only stub that cannot
leak — the same reasoning that produced `CLAUDISH_DISABLE_OP`.

The guard PREVENTS keychain access rather than repairing it, unlike the config file which it
snapshots and restores. A keychain mutation has no equivalent undo.

`keychain-source.test.ts` deletes the flag in `beforeAll` and restores it in `afterAll` (the
`op-source.test.ts` pattern), because it IS the suite that tests this code and is hermetic through
the deps seam plus a temp config. One test pins the hatch itself and asserts **zero** `run`
invocations — that assertion, not the boolean, is what protects the machine.

## Tests

Fully hermetic through the `setKeychainTestDeps()` seam (`platform` / `run` / `runAsync`); no test
touches a real keychain. Fixtures are the real captured `security` transcripts recorded in the
session directory above — exit codes, stderr strings, and a genuine `dump-keychain` block —
not hand-authored approximations.

`mock.module()` is NOT used: Bun's module registry leaks across files in one run and has broken
sibling e2e tests in this repo before.

## Known gap, deliberately not fixed here

`ApiKeyCredentialProvider.invalidate()` clears `cachedKey` and the `resolving` reference, but an
already-running resolution can still complete afterwards and write BOTH `process.env` and
`cachedKey` — and its `finally` can clear a NEWER in-flight promise. So a probe awaiting 1Password
can land after the user stores a fresh keychain key and overwrite the newly selected credential.

This is pre-existing in the authority's memoization, not introduced by the keychain backend; what
the backend added is a TUI path that calls `invalidate()` often enough to make it reachable. The
fix is a generation counter inside `resolveKey`, which changes credential resolution for EVERY
provider and every 1Password user, so it belongs to its own change with its own tests rather than
riding along here.
