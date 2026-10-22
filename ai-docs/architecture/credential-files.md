# Credential files — a long-lived process follows the file

`auth/credential-file.ts`, used by `auth/oauth-manager.ts` (Grok), `auth/kimi-oauth.ts` and
`providers/devin/devin-credentials.ts`. Read this before touching any of them, or before adding a
provider whose login lives in a file that claudish caches in memory.

## The defect it closes (D1)

On 2026-10-21 `claudish login grok` rewrote `~/.claudish/grok-oauth.json`. A fresh process served
`gk@grok-4.7` at once; a `claudish --mcp` started earlier kept answering `Grok token refresh
failed: Refresh token has been revoked. Run claudish login grok to sign in.` until it was
restarted (`ai-docs/reports/model-failures-2026-10-21.md`, D1). `GrokOAuth` read its file once, in
its constructor, and `OAuthManager.getAccessToken` used that copy for the life of the process. Four
MCP servers on that machine predated the login.

## Which credentials are covered

| claudish provider | File | Before | Now |
|---|---|---|---|
| `grok-subscription` (own login) | `~/.claudish/grok-oauth.json` | read once in the constructor | `CredentialFileState` through `OAuthManager` |
| `grok-subscription` (Grok CLI fallback) | `~/.grok/auth.json` | read on every resolve (no cache) | write-back is compare-and-set on the refresh token |
| `kimi`, `kimi-coding` (OAuth half) | `~/.claudish/kimi-oauth.json` | read once in the constructor; `rejectLogin` deleted the file unconditionally | `CredentialFileState`; `deleteIfUnchanged` |
| `devin` | `~/.local/share/devin/credentials.toml` | memo per path, never invalidated | memo keyed by path and stamp |
| `openai-codex` | `~/.claudish/codex-oauth.json` | — | **not changed here**: branch `worktree-multi-subscriptin` re-reads it on every request under a cross-process lock |
| `meta-muse-code` | the Muse login files | — | not changed: it already re-reads both files before reporting a rejected login |

Keychain-backed (`antigravity`) and 1Password-backed sources are out of scope: neither keeps a
long-lived copy of a file.

## The mechanism

No timer. One path `stat` at the moments a caller asks, and a re-read only when the stamp moved.
The stamp is `(ino, size, mtimeMs, ctimeMs)`, recorded per path, so a test seam that swaps the path
always reads the new file. `ino` catches a rename (this build writes temp + rename); `mtimeMs`,
`ctimeMs` and usually `size` catch an older claudish that truncates and writes in place
(`openSync(path, "w")`).

The checks run:

1. **Before use** — `getAccessToken()` settles before the expiry check, so a newer valid token is
   returned with no network call. `hasCredentials()` syncs too, so readiness answers yes after a
   login made elsewhere.
2. **Before refresh** — the refresh starts from the file's refresh token as just synced.
3. **Before declaring a login dead** — `refreshAndCommit` settles after ANY refresh failure. If the
   file now holds a different login, that login is used (its token when valid, else one refresh
   from it). Otherwise the original error object is rethrown unchanged, so the five auth sites in
   `composed-handler.ts` classify exactly what they did before (CLAUDE.md: never invent a status).
4. **The 401 retry** — `refreshToken()` is not told which token drew the 401. Its proxy: the access
   token held in memory right before this call's sync. If the file now holds a different one, it
   is adopted with no refresh. A concurrent request in the same process may already have synced the
   newer token, which costs one redundant refresh; adopting a token that was itself rejected cannot
   happen, because adoption needs the file to differ from memory.

The first load is lazy: no manager reads its file in a constructor. That matters for Kimi, whose
singleton is built when `auth/credentials/authority.ts` is imported, before a test can set a seam.
Its constructor used to read the real login and create the real `kimi-device-id` through
`homedir()`, which Bun resolves from passwd and not from an in-process `HOME`.

## Four disk states, and why "unreadable" never signs out

| State | Meaning | Effect |
|---|---|---|
| `unchanged` | same path, same stamp as the last good read | nothing read |
| `reloaded` | stamp moved; parsed and validated | value replaced |
| `removed` | ENOENT, and only ENOENT | value null (another process logged out) |
| `unreadable` | exists but cannot be read, parsed or validated; or a non-ENOENT stat error | last good value KEPT; stamp NOT recorded, so the next call reads again |

An older claudish writes the file in place, so between its truncate and its write a reader sees 0
bytes or half a JSON object. If that meant "no credentials", one torn read would answer "No …
credentials found" or `hasCredentials() === false`. On a subscription hop `FallbackHandler`
advances on a terminal credential verdict, and routing drops a candidate whose `hasCredentials()` is
false, so a `gk@`/`kc@` request would walk onto metered `xai@`/`kimi@`: the silent-billing class.
`settle()` re-reads an unreadable file up to 3 times, 25 ms apart (an in-place write of a few
hundred bytes takes microseconds). Still unreadable with a last good value: sign with it. Still
unreadable with none (a corrupt file at first use): the old "No … credentials found", which is what
a corrupt file always produced.

Accepted residual: if the file stays corrupt for the life of the process after a successful
refresh, the rotated refresh token lives only in memory and the next process finds the corrupt file.
Writing over the file instead could overwrite a newer login caught mid-write, the one outcome this
module exists to prevent.

## Write-back: compare-and-set on the login, not on the stamp

A refresh result is committed by `saveRefreshed(base, next)`: settle, then write `next` (temp file
opened `wx` 0600, fsync, rename) ONLY if the file still holds `base`'s refresh-token lineage. The
stamp answers "did something write", which our own previous write also does; the lineage answers
"is this still the login I refreshed", which is the question.

| Outcome | Then |
|---|---|
| `saved` | sign with `next` |
| `newer-on-disk` | another process logged in during the exchange: discard ours, sign with theirs (refresh it once if it is already expired) |
| `removed` | a logout during the exchange: not undone; "No … credentials found" |
| `unreadable` / `write-failed` | do not write; keep `next` in memory and sign with it; the next sync adopts a newer login that finished writing |

A login (`saveLogin`) is the user's intent and is written unconditionally. `logout` deletes
unconditionally. Kimi's rejected refresh deletes only through `deleteIfUnchanged(base)`: a newer
login is kept (and adopted by `refreshAndCommit` instead of answering `OAuth_FALLBACK_TO_API_KEY`),
and an unreadable file is kept.

`OAuthManager.doRefreshToken(current)` returns the next credentials and never writes them. A new
`OAuthManager` subclass inherits all of the above; a manager that is not a subclass (Kimi) holds its
own `CredentialFileState` and calls the same `refreshAndCommit`, so the adopt and retry-once rules
exist once.

The Grok CLI's `~/.grok/auth.json` is not cached, so only its write-back changed:
`persistRefreshedToken` writes the scope entry only while it still holds the refresh token the
refresh presented. This request still signs with the token it just received; the next resolve reads
the newer entry.

Devin's file is read-only for claudish: its memo is keyed by path and stamp, and a file that loses
the key a previous read found (a torn write) keeps the last good key.

## The residual window and when it closes

`saveRefreshed`'s re-read and its rename are two syscalls, so a login that lands between them
(microseconds) can still be overwritten. A cross-process lock closes that. The
`worktree-multi-subscriptin` branch carries one (`auth/accounts/refresh-lock.ts`, `file-lock.ts`);
copying it here would have caused an add/add conflict, so the window stays documented until that
branch merges.

Also open, on a follow-up ticket under MTL-209: `OAuthManager.refreshToken()` still calls the refresh
outside `getAccessToken`'s single-flight latch, and the rejected token is not threaded through from
the 401 path. The no-overwrite guarantee above does not depend on either: every refresh result
commits through `saveRefreshed`.

## What is logged

Debug log only (`log()`), label and path, never a value:
`credential file changed on disk; reloaded`, `credential file removed on disk; signed out`,
`credential file unreadable (<path>); kept the last good credentials`, `token refresh failed, but
the credential file changed on disk; using the newer login`, `credential file changed during the
token refresh; kept the newer file`, `credential file unreadable after the token refresh; kept the
refreshed token in memory, not written`, Kimi's two `login rejected, but … not deleting it`,
`[Devin] credentials file changed on disk; reloaded`, `[Grok] ~/.grok/auth.json changed during the
token refresh; kept the newer file`. Nothing new reaches stderr: a reload is a recovery, not news.

## Tests

Every test that reaches one of these managers MUST use the seams: `setGrokOAuthPathForTesting`
(`setClaudishGrokOAuthPathForTesting` and `setGrokHomeForTesting` delegate to it),
`setKimiOAuthPathForTesting`, `setKimiDeviceIdPathForTesting`, `KimiOAuth._resetForTests()` (resets
in place; never replace the singleton the authority captured), `setDevinCredentialsPathForTesting`.
`scripts/guard-real-config.ts` does not snapshot these files, and a leak here is a real login. A test
file that imports the authority or `kimi-oauth.ts` should also run in a child whose environment sets
`HOME` to a temp directory, so a missed seam lands there.
