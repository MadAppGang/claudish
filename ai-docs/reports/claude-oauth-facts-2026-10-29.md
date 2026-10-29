# Claude Code OAuth facts, measured on 2.1.312

Evidence for [`../architecture/accounts.md`](../architecture/accounts.md) Phase V (MTL-307).
Captured 2026-10-29 on darwin 27.0.0, Bun 1.4.0, against Claude Code **2.1.312**
(`/Users/jack/.local/share/claude/versions/2.1.312`) and Codex 0.161.0.

Tracked deliberately: the wrapper, the mock, the scripts and the raw logs lived in
`ai-docs/sessions/dev-feature-claude-oauth-facts-20261029-142521-cc7b775b/`, which is gitignored
and does not survive `git worktree remove`, so the lines that decide the design are reproduced here
verbatim. Tokens are fake. Every one (`fake-access-<L>-<12 hex>`) is shown redacted as `<A>`,
`<B>` or `<A-refresh>`, and times are relative to the line marked `since`.

Two decisions taken with Jack on 2026-10-29 frame the run:

1. **Switch rule.** On every switch claudish reads Claude Code's current tokens out of its item,
   refresh token included, and saves them before it writes the next account. Claude Code is the
   only refresher of the account in its item.
2. **Token lifetimes are read at run time** from the item (`expiresAt`, `refreshTokenExpiresAt`),
   never measured in advance.

---

## 1. Method

### Fake tokens in a throwaway keychain

Nothing was written to the login keychain, and no real Claude login was read. Each experiment
created its own throwaway keychain and deleted it at the end:

```
security create-keychain -p <random 48 hex> $TK
security unlock-keychain …  $TK
security set-keychain-settings $TK            # no auto-lock, so no unlock dialog is possible
security show-keychain-info $TK
  → Keychain "…/validation/kc/mtl307.keychain-db" no-timeout
list-keychains and list-keychains -d user      → equal to the baselines (true in every run)
```

A cleanup trap (SIGINT, SIGTERM, finally → `security delete-keychain $TK`) was installed before
the first launch.

### The `security` wrapper on `PATH`

Claude Code calls `security` by bare name (F5), so a wrapper placed first on `PATH` intercepts
every call. It:

- forwards only known commands, each with the throwaway path appended, to `/usr/bin/security`;
- converts every `security -i` stdin line into one argv call, so the 4095-byte stdin chunk hazard
  cannot occur;
- refuses any `-s` other than the scratch service, computed from F1 in the script and never with
  claudish's `claudeCodeKeychainService()` (F3);
- refuses when `CLAUDE_CONFIG_DIR` is unset, or when the throwaway is absent or locked;
- answers the legacy API-key service `Claude Code-52115af3` with a synthesized exit 44
  (`synth-44`) without touching any keychain;
- logs every call, with `-X` values as `<hex len=N>`.

### One exec, then a proof launch

Claude Code started in ONE exec, never through a login shell, whose `path_helper` reorders `PATH`:

```
/usr/bin/env -i HOME=/Users/jack USER=jack TERM=dumb \
  PATH=<validation/bin>:/usr/bin:/bin:/usr/sbin:/sbin \
  CLAUDE_CONFIG_DIR=<validation/cfg> DISABLE_AUTOUPDATER=1 \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 ANTHROPIC_BASE_URL=http://127.0.0.1:<port> \
  /Users/jack/.local/share/claude/versions/2.1.312 -p --input-format stream-json \
  --output-format stream-json --verbose --debug-file <logs/…-debug.log>
```

The cwd was a scratchpad directory outside any repo. A dry run inside the worktree had loaded the
claudish repo's `settings.local.json` and skills. Before each measured launch:

```
command -v security (launch env) => …/validation/bin/security
PROOF first Claude Code call: {"argv":["find-generic-password","-a","jack","-w","-s","Claude Code-credentials-52115af3"],"decision":"forwarded","exit":44,…,"caller":"claude"}
PROOF service sent="Claude Code-credentials-52115af3" expected="Claude Code-credentials-52115af3" match=true
```

The proof launch ran with an EMPTY throwaway, so the wrapper saw Claude Code's first read before
any item existed.

### Isolation proof, after every experiment

The list of `Claude Code*` services in the login keychain is diffed against a baseline taken
before the run. The baseline holds 253 services:

```
security dump-keychain < /dev/null 2>/dev/null | grep -a '"svce"' | grep -a -i 'claude code' | sort | diff <baseline> -
```

The diff was empty before and after each of the 9 experiments, and once more at the end. One
false alarm came first. The first selftest attempt stopped at its pre-check with a non-empty diff
over an identical set, because a C-locale `sort` moves the unsuffixed `"Claude Code-credentials"`
line from last to first; nothing had been created yet, and every later proof ran in the caller's
locale (`en_AU.UTF-8`). Final checks:

```
security list-keychains          | diff baseline/list-keychains.before.txt -       → SAME
security list-keychains -d user  | diff baseline/list-keychains-user.before.txt -  → SAME
final isolation proof                                                              → diff-exit=0, empty
```

### Wrapper totals

`security-wrapper.log` holds 93 records. Claude Code made **0 refused calls**.

| caller | call | decision | n |
|---|---|---|---|
| claude | `-i` add-generic-password | forwarded, exit 0 | 2 |
| claude | find-generic-password (credentials) | forwarded, exit 0 / 44 | 34 / 7 |
| claude | find-generic-password (`Claude Code-52115af3`) | synth-44 | 15 |
| driver | add / find / delete | forwarded, exit 0 | 15 / 10 / 1 |

The log holds **4** refusals, all from the wrapper's selftest. The session's `results.md` says 3,
and the log is authoritative:

```
"argv":["find-generic-password","-a","jack","-w","-s","Claude Code-credentials"] … "reason":"service \"Claude Code-credentials\" != expected \"Claude Code-credentials-52115af3\"" … "caller":"selftest"
"argv":["dump-keychain"] … "reason":"unknown command \"dump-keychain\"" … "caller":"selftest"
"argv":["find-generic-password","-s","Claude Code-credentials-52115af3","/tmp/x"] … "reason":"unexpected argument <positional>" … "caller":"selftest"
"argv":["show-keychain-info"] … "reason":"CLAUDE_CONFIG_DIR unset" … "caller":"selftest"
```

### Fake tokens reached real Anthropic hosts

No local OAuth mock is possible. `function E(){return"prod"}` hardcodes the environment, and the
custom OAuth URL is allowlisted to three Anthropic hosts (it would also change the service name).
The mock behind `ANTHROPIC_BASE_URL` received only `/v1/messages`, so fake tokens reached:

- the profile endpoint: **8 GETs → 401**, one per Claude Code start with an item;
- the token endpoint: **3 refresh POSTs → 400** (D2a after release, D2b i and ii).

Each failed exchange costs nothing. The proof launches ran with no item and made neither call.

```
[ERROR] Failed to fetch oauth profile from OAuth token: [REDACTED] Request failed with status code 401
[ERROR] OAuth refresh failed (expected): Request failed with status code 400
```

### Static reading

Static facts come from the binary read as latin1 with `indexOf`, with stdin from `/dev/null`.
Minified names (`HW()`, `Wu()`, `ON()`) belong to 2.1.312 only and change between builds.
The script at the end of the appendix re-reads the window behind each static fact, with its byte
offset, and the appendix quotes its output verbatim. The "Command" column names the needle each
row was found by.

---

## 2. Facts F1 to F15

The Evidence column says where each row comes from. **Static** means read from the binary and
quoted in the appendix. **Live** means observed in the runs above. **Both** means a static reading
that a run also confirmed.

| id | Evidence | Question | Command | Observed (verbatim excerpt) | Verdict |
|---|---|---|---|---|---|
| F1 | Both | Keychain service name | `'OAUTH_FILE_SUFFIX}'`; live: the proof line | ``var KPe="-credentials"`` … ``a=t?"":`-${c("sha256").update(r).digest("hex").substring(0,8)}`;return`Claude Code${on().OAUTH_FILE_SUFFIX}${e}${a}` `` (called with `e`=`"-credentials"`). Suffix values: `OAUTH_FILE_SUFFIX:""` (prod), `"-local-oauth"` (local config), `"-custom-oauth"` (`CLAUDE_CODE_CUSTOM_OAUTH_URL`). Live: `-s "Claude Code-credentials-52115af3"` | static + live: `Claude Code${OAUTH_FILE_SUFFIX}-credentials-<sha256(dir)[0:8]>`; the hash comes AFTER `-credentials` |
| F2 | Live | Which order do real items use? | the isolation-proof pipeline on the login keychain (attributes only) | 253 services: 252 `Claude Code-credentials-<hash>` (e.g. `"svce"<blob>="Claude Code-credentials-015a53eb"`), 1 unsuffixed `"Claude Code-credentials"`, 0 matching `Claude Code-<hash>-credentials` | live: every suffixed item uses the F1 order; zero of the old order |
| F3 | Static (claudish source) | Does claudish build the same name? | `packages/cli/src/auth/claude-code-facts.ts` | ``return `${BASE_KEYCHAIN_SERVICE}-${configDirHash(resolved)}${KEYCHAIN_SERVICE_SUFFIX}`;`` builds `Claude Code-<hash>-credentials`; it also returns the unsuffixed name when the dir resolves to `~/.claude` and ignores `CLAUDE_SECURESTORAGE_CONFIG_DIR` and NFC | **defect**: the login probe (`claude-runner.ts:146`) misses every custom-config-dir login and can fall back to the unsuffixed item, a different login. Tracked as MTL-316, fixed outside this branch |
| F4 | Static | When is the suffix added? | `'n=process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR'` | ``n=process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,t=n!==void 0?!n:!process.env.CLAUDE_CONFIG_DIR,r=n!==void 0?n.normalize("NFC"):Le()`` | static: whenever `CLAUDE_CONFIG_DIR` is non-empty, even when it names the default dir; `CLAUDE_SECURESTORAGE_CONFIG_DIR`, when set, decides alone (empty means no suffix) |
| F5 | Both | Which `security` runs? | static reads; live: wrapper on `PATH` | ``it("security",["find-generic-password","-a",a,"-w","-s",s])``; writes go to `security -i` with no keychain argument, and to argv above 4032 bytes (`re=4032`). Live: every Claude Code call reached the `PATH` wrapper | static + live: bare `security` by `PATH`, default keychain |
| F6 | Static | When does the plaintext file get used? | `'".credentials.json"'` | ``storagePath:oe(e,".credentials.json")`` … ``var J7r="Warning: Storing credentials in plaintext."`` | static: `<dir>/.credentials.json` only after a non-transient keychain failure. Live: never reached, because 0 calls were refused |
| F7 | Static | Refresh with no new refresh token | `'refreshToken:j,expiresAt:q'` | ``{access_token:G,refresh_token:j=e,expires_in:Q}=B,q=Date.now()+Q*1000,Z=q9r(B.refresh_token_expires_in,!1)`` … ``return{accessToken:G,refreshToken:j,expiresAt:q,refreshTokenExpiresAt:Z,`` | static only: keeps the old refresh token when none is returned, and stores `refreshTokenExpiresAt`. Every live refresh exchange answered 400, so no run exercised this |
| F8 | Both (owner record, takeover gate: Static) | Claude Code's locks | `'stale:60000'`, `'.oauth_refresh.lock.owner'`, `'no_owner_record'`, `'".storage-write"'` | ``lockfilePath:Vp(e,".oauth_refresh.lock"),realpath:!1,stale:60000,update:5000`` · ``var TN="tengu_quiet_marten",…,CN=".oauth_refresh.lock.owner"`` · ``if(!zc(TN))return"disabled";let y=await Wc(e);if(y===null)return(await lo(n)).mtimeMs===s?"no_owner_record":"lock_changed"`` · ``rd(te(s,".storage-write"),{realpath:!1,retries:{retries:10,minTimeout:100,maxTimeout:1000},stale:15000`` | static + live (D2): `<dir>/.oauth_refresh.lock` first, then the legacy `<realpath(dir)>.lock` (stale 60 s, update 5 s). Owner file `.oauth_refresh.lock.owner`. Takeover only with an owner record AND the flag `tengu_quiet_marten`; `no_owner_record` → never taken over. Second lock dir `<dir>/.storage-write.lock` (stale 15 s, 10 retries) around every item read-modify-write |
| F9 | Static | PKCE shape | `'CLIENT_ID:"'` | ``MANUAL_REDIRECT_URL:"https://platform.claude.com/oauth/code/callback"``; redirect `http://localhost:<port>/callback`; S256; JSON exchange body with `state` | static only; see D6 |
| F10 | Static | Which client id is prod? | `'CLIENT_ID:"'`, `'22422756'` | ``CLIENT_ID:"9d1c250a-e61b-44d9-88ed-5944d1962f5e",…,OAUTH_FILE_SUFFIX:""`` · ``CLIENT_ID:"22422756-60c9-4084-8eb7-27705fd5cf9a",DESIGN_CLIENT_ID:"00000000-0000-4000-8000-000000000000",OAUTH_FILE_SUFFIX:"-local-oauth"`` (beside `http://localhost:8205`) | static: `9d1c250a-…` is prod; `22422756-…` is the local-dev OAuth config |
| F11 | Static (D7: Live) | Does Codex have a usage endpoint? | `strings` on Codex 0.161.0 | contains `/wham/usage` and `/api/codex/usage` | static; measured live as D7 |
| F12 | Both | When does Claude Code refresh? | `'300000>='` | ``function AA(e,n=Date.now()){if(e===null)return!1;return n+300000>=e}`` | static + live (D5 step 4): only on demand, when `now + 300000 >= expiresAt`; no timer found |
| F13 | Both | Item cache | `'R4t=30000'` | ``var R4t=30000;class i{cache={data:null,cachedAt:0};generation=0;readInFlight=null;`` | static + live (D5): reads are cached 30 s |
| F14 | Both | Adoption under the lock | static (`Wu()`) | ``if(G.accessToken!==B)return xn(),a("tengu_oauth_token_refresh_race_resolved")`` | static + live (D5 step 4): under the lock it re-reads; a different stored token is adopted; a save adopts a newer write |
| F15 | Both | Account attribute; other services read | `'claude-code-user'`; live D4; wrapper log | ``e=process.env.USER\|\|l().username}catch{e="claude-code-user"}if(!s.test(e))return"claude-code-user"`` with `s=/^[a-zA-Z0-9._-]+$/`. Live: `"acct"<blob>="jack"`; 15 reads of `Claude Code-52115af3` | static + live: `acct` = `$USER`, fallback `claude-code-user`. The legacy API-key service `Claude Code-<hash>` (no `-credentials`) is read at every start |

**Hash input.** The two kinds of evidence answer different questions.

- **Live:** the wrapper's computed service name, `sha256(cfg.normalize("NFC"))`, matched Claude
  Code's first read for this scratch path, in every run. The path held no symlink and was an
  ordinary path, so the run separates neither raw from resolved nor NFC from no normalization.
- **Static** (appendix, "F1: config dir `dN()`" and `HW()`): the input is the configured dir
  string, NFC-normalized. The external review quotes `Le()` as returning `CLAUDE_CONFIG_DIR`
  verbatim, with no `realpath` and no slash stripping. That body is not in the extract, and it is
  unverified live.

Still unmeasured live: whether a trailing slash survives.

---

## 3. Gate experiments

### D2a: `.oauth_refresh.lock` and the legacy `<realpath(CFG)>.lock` held

Item A had `expiresAt` = seed time. At 04:56:42.460Z the driver ran `mkdir cfg/.oauth_refresh.lock`
and `mkdir cfg.lock`, refreshed their mtime every 5 s and wrote no owner file. Claude Code launched
at the same instant. Prompt 1 went at +4002 ms, the locks were released at +8368 ms, then prompt 2.

Timeline while held (since 04:56:42.460Z):

```
+52ms   WRAP find-generic-password … Claude Code-credentials-52115af3 -> forwarded exit=0
+234ms  WRAP find-generic-password …credentials… exit=0
+246ms  WRAP find-generic-password …credentials… exit=0      ← refresh attempt 0 (ELOCKED)
+1637ms WRAP find-generic-password …credentials… exit=0      ← retry 1   (+1391)
+2987ms WRAP find-generic-password …credentials… exit=0      ← retry 2   (+1350)
          (prompt 1 sent at +4002ms; it joins the pending refresh check)
+4677ms WRAP find-generic-password …credentials… exit=0      ← retry 3   (+1690)
+6488ms WRAP find-generic-password …credentials… exit=0      ← retry 4   (+1811)
+8167ms WRAP find-generic-password …credentials… exit=0      ← retry 5   (+1679)
+8245ms MOCK POST /v1/messages?beta=true auth=A status=200    ← sent with the EXPIRED token
prompt 1 result after 4266ms: {"subtype":"success","is_error":false,"result":"ok"}
item while held: {"claudeAiOauth":{"accessToken":"<A>","refreshToken":"<A-refresh>",…}}
```

After release (since 04:56:50.829Z):

```
+120ms DBG [ERROR] Failed to fetch oauth profile from OAuth token: [REDACTED] Request failed with status code 401
+598ms DBG [ERROR] OAuth refresh failed (expected): Request failed with status code 400
+772ms WRAP add-generic-password -U -a jack -s Claude Code-credentials-52115af3 -X <hex len=272> -> forwarded exit=0
+818ms DBG [ERROR] API error (attempt 1/11): OAuth refresh token is no longer valid; run /login to re-authenticate
item after release: {"claudeAiOauth":{"accessToken":"","refreshToken":"","expiresAt":0,…}}   ← nYr blanking
```

| | Predicted | Observed |
|---|---|---|
| waits while held | 5 retries at 1 to 2 s, plus a settle of up to 7.5 s (`rA=7500`) | 6 attempts, 5 sleeps of 1350 to 1811 ms, total ≈ 7.9 s; **no settle wait**, because the holder's mtime moved (`oA()` false) |
| posts to the token host while held | no | no: no refresh line, no item write |
| then | `lock_busy` or `lock_timeout` | silent (`lock_busy` is a return value); the request goes out with the expired A |
| after release | proceeds | refresh POST → 400 → `nYr` blanks the item (a 272-hex write) |

**Verdict: positive.** Claude Code waits about 7.9 s on the refresh lock, then sends with the
token it holds. It never posts while the lock is held.

### D2b: `.storage-write.lock` held

The binary calls `rd(te(s,".storage-write"),…)` with no `lockfilePath`, so the contended directory
is `<dir>/.storage-write.lock`. The trigger chain was: item A expired → startup refresh → 400 →
`nYr` → `mutate` → `LCn()` takes the lock. The driver took the lock before launch.

Run (i), held throughout (since 04:59:33.182Z):

```
+766ms  DBG [ERROR] OAuth refresh failed (expected): Request failed with status code 400   (04:59:33.948Z)
+785ms  WRAP find-generic-password …credentials… exit=0
+8331ms DBG [ERROR] OAuth dead-token disk clear failed: Lock file is already being held     (04:59:41.513Z)
Claude Code add-generic-password calls: none
item now: {"claudeAiOauth":{"accessToken":"<Ai-held>","refreshToken":"<Ai-held-refresh>",…}}  ← NOT blanked
```

Run (ii), released 2000 ms after the refresh failure (since 04:59:45.657Z):

```
+685ms  DBG [ERROR] OAuth refresh failed (expected): Request failed with status code 400   (04:59:46.342Z)
+2687ms LOCK released …/cfg/.storage-write.lock (held 2687 ms)
+3279ms WRAP find-generic-password …credentials… exit=0          ← mutate's read, AFTER the lock
+3337ms WRAP add-generic-password -U … -X <hex len=272> exit=0     ← 650 ms after release
item now: {"claudeAiOauth":{"accessToken":"","refreshToken":"","expiresAt":0,…}}
```

| | Predicted | Observed |
|---|---|---|
| waits on `.storage-write.lock` | up to 10 retries of 100 to 1000 ms (100+200+400+800+6×1000 = 7.5 s) | gave up after 7546 ms and wrote nothing |
| proceeds once released | yes | yes: the read-modify-write ran 592 ms and 650 ms after release |
| read inside the lock | | the item read comes after the lock is acquired, so a write made under the lock is what `mutate` sees |

**Verdict: positive.** Claude Code waits 7.5 s on `.storage-write.lock`, then skips its write.

### D4: access list across a `-U` update

Two `bin/security add-generic-password -U -a jack -s "Claude Code-credentials-52115af3" -X <hex>`
calls wrote 201-byte JSON each. `/usr/bin/security dump-keychain -a $TK` ran before and after
(no `-d`).

```
ACL dump bytes before=1463 after=1463; identical=true; identical-ignoring-mdat=true
acct line: "acct"<blob>="jack"
```

The ACL after the update (`logs/d4-acl-after.txt`):

```
access: 3 entries
    entry 0:  authorizations (1): encrypt            don't-require-password  applications: <null>
    entry 1:  authorizations (6): decrypt derive export_clear export_wrapped mac sign
              don't-require-password  applications (1): 0: /usr/bin/security (OK)
              requirement: identifier "com.apple.security" and anchor apple
    entry 2:  authorizations (1): change_acl  don't-require-password  applications (0):
```

| | Predicted | Observed |
|---|---|---|
| access list after `-U` | unchanged | byte-identical dump |
| `acct` | `jack` | `jack` |

**Verdict:** for current items, `-U` keeps the access list, and `acct` is `$USER`. Claude Code
itself updates through the same `add-generic-password -U`, so this matches the binary.

### D5: does a running session pick up a swapped item?

Steps 1 and 2 (`d5.ts`; since 05:00:58.947Z; A lives 24 h, B 48 h):

```
[step1]     /v1/messages auth sequence: A:200
            seed item B; item reads {"claudeAiOauth":{"accessToken":"<B>",…}}
[step2-5s]  /v1/messages auth sequence: A:200
[step2-40s] /v1/messages auth sequence: B:200        ← picked up WITHOUT a 401
+32ms    WRAP find … credentials … exit=0     (last read before the swap)
+3041ms  MOCK POST /v1/messages auth=A
+8140ms  MOCK POST /v1/messages auth=A
+43122ms WRAP find … credentials … exit=0     (item cache 43 s old → re-read)
+43163ms MOCK POST /v1/messages auth=B
```

The bracket (`d5d.ts`) measures cache age since Claude Code's last item read:

```
[prompt1] item-cache age at send 2953 ms;  /v1/messages auth: A:200
[at25s]   item-cache age at send 25001 ms; /v1/messages auth: A:200
[at33s]   item-cache age at send 33001 ms; /v1/messages auth: B:200   (+33093ms WRAP find … exit=0 just before)
```

The mechanism is in the binary. `$A()` stats `<CFG>/.credentials.json`, which is absent in the
macOS keychain case, so it calls `Hu()`. `Hu()` clears the memo and calls `pl()`, which re-reads
through the 30 s cache `R4t`. When the token differs, Claude Code emits `credentialsChangedOnDisk`.
No 401 is needed.

Step 3 (`d5c.ts`, a fresh session). The item was swapped to B and the mock answered A with 401,
3123 ms after the last item read (since 05:04:45.373Z):

```
+3087ms MOCK POST /v1/messages auth=A status=200                           (step1)
+4446ms MOCK POST /v1/messages auth=A status=401
+4449ms DBG [ERROR] API error (attempt 1/11): 401 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired"}}
+5066ms WRAP find-generic-password …credentials… exit=0                    ← re-read, cache bypassed
+5181ms MOCK POST /v1/messages auth=B status=200
[step3-401] /v1/messages auth sequence: A:401 → B:200 (1033 ms)
```

Step 4 (`d5b.ts`, a restart). A expired at seed + 320 s (since 05:07:07.815Z):

```
[prompt1] at A.expiresAt-316918ms: /v1/messages auth sequence: A:200
          seed item B (48 h)
A inside the refresh window by 2001 ms; last Claude Code item read 21862 ms ago
+21968ms WRAP find-generic-password …credentials… exit=0      ← re-read with the cache only 21.9 s old
+22031ms MOCK POST /v1/messages auth=B status=200
[prompt2] at A.expiresAt-297999ms: /v1/messages auth sequence: B:200
```

Neither step 3 nor step 4 printed a refresh line or wrote the item.

| Step | Predicted | Observed |
|---|---|---|
| 1 | A | A |
| 2, 5 s | A (memoized) | A |
| 2, 40 s | A (memoized) | **B**: re-read once the 30 s item cache expired (25 s → A, 33 s → B) |
| 3, 401 to A | re-read, B | A 401 → re-read 620 ms later → B 200, no refresh |
| 4, A near expiry | B, no token POST (`race_resolved`) | B, no refresh line, no write |

**Verdict:** yes, and the adoption is request-driven. A running session adopts the changed item at
its next request once its 30 s item cache has expired. A 401 or the near-expiry check re-reads at
once. An idle session adopts nothing until it sends a request. The static side of the 401 path is
in the appendix ("D5: the 401 path").

### D7: Codex usage endpoint

`bun validation/scripts/d7.ts` read `tokens.access_token` and `tokens.account_id` from
`~/.codex/auth.json`. It sent one GET with `Authorization` and `ChatGPT-Account-Id`, logged no
header and never refreshed.

```
auth.json: access_token present=true account_id present=true
access token exp: 12742 min from now
GET /backend-api/wham/usage → status 200 (374 ms), content-type=application/json
top-level keys: ["user_id","account_id","email","plan_type","rate_limit","code_review_rate_limit","additional_rate_limits","model_usage","credits","spend_control","rate_limit_reached_type","promo","rate_limit_reset_credits"]
  rate_limit: object keys=["allowed","limit_reached","primary_window","secondary_window"]
  model_usage: object keys=["gpt-6-astra"]
  credits: object keys=["has_credits","unlimited","overage_limit_reached","balance","approx_local_messages","approx_cloud_messages"]
  spend_control: object keys=["reached","individual_limit"]
  rate_limit_reset_credits: object keys=["available_count","applicable_available_count"]
  code_review_rate_limit / additional_rate_limits / rate_limit_reached_type / promo: null
```

| | Predicted | Observed |
|---|---|---|
| idle usage without inference | positive or inconclusive | **positive**: 200 with `rate_limit.primary_window` and `secondary_window`, no model call |

This contradicts claudish's probe of 2026-08-05, which found no usage endpoint.

---

## 4. Gates not run

| Gate | Answer | Reason |
|---|---|---|
| D1 (rotation) | not needed under the switch rule, given D2-positive for both locks (measured positive) | claudish holds `.oauth_refresh.lock` with the legacy lock, and `.storage-write.lock`, across read-save-write. Claude Code cannot refresh or write inside that window (D2a, D2b), so the read-back captures the current refresh token whether or not a refresh rotates it. claudish never refreshes the account in Claude Code's item |
| D3 (immediate revocation) | not needed under the switch rule, for the same reason | no interrupted refresh can occur inside the switch, so whether the old refresh token dies at once never decides an outcome |
| D6 (PKCE) | static (F9), from the binary; server acceptance remains to be verified by the first real Phase 3 login | the redirect shape and exchange body come from the binary, and no run sent them to the server |
| D8 (in-stream `usage_limit_reached`) | unchanged | MTL-261 |

If a later Claude Code build stops waiting on either lock, D2 turns negative, and D1 and D3 need a
real login again.

---

## 5. Not covered

- **Items created by older Claude Code builds (D4).** Only items written by the current
  `add-generic-password -U` were examined. An older build's item may carry a different access list
  or partition list.
- **Lock outcomes are timing evidence.** No `tengu_*` event name reaches `--debug-file`;
  `lock_retry`, `lock_busy`, `race_resolved` and `401_recovered_from_keychain` are telemetry only.
  Every lock result above comes from wrapper-log timestamps, lock-dir times and side effects.
- **Raw vs resolved hash input.** The scratch path had no symlink, so the two were not separated
  live (§2, hash input). The static reading says raw; it is unverified live. Still unmeasured
  live: whether a trailing slash survives.
- **Dead-holder takeover.** The owner-file branch was read from `ON()`, not exercised: a holder that
  refreshes its mtime never reaches it.

---

## Appendix. Static extracts (2.1.312)

Every static fact above rests on one of these 19 windows. Each is quoted verbatim from
`validation/static-extract.txt`, with the byte offset of its anchor in
`/Users/jack/.local/share/claude/versions/2.1.312`. Non-printable bytes are dropped. To reproduce
them, run `bun validation/scripts/static-extract.ts` from the session dir
`ai-docs/sessions/dev-feature-claude-oauth-facts-20261029-142521-cc7b775b/`. The script reads the
binary as latin1, skips the earlier bundle copy below offset 200000000, and prints each window.

### F1, F4: service name `HW()`

Offset 220051673. The suffix `-<sha256(r)[0:8]>` is added unless `t`. `t` is true when `CLAUDE_SECURESTORAGE_CONFIG_DIR` is set and empty, or, when it is unset, when `CLAUDE_CONFIG_DIR` is empty or unset. The hash input `r` is `CLAUDE_SECURESTORAGE_CONFIG_DIR` NFC-normalized, else `Le()`.

```
function HW(e=""){let n=process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,t=n!==void 0?!n:!process.env.CLAUDE_CONFIG_DIR,r=n!==void 0?n.normalize("NFC"):Le(),a=t?"":`-${c("sha256").update(r).digest("hex").substring(0,8)}`;return`Claude Code${on().OAUTH_FILE_SUFFIX}${e}${a}`}var s=/^[a-zA-Z0-9._-]+$/;function iO(){let e;try{e=process.env.USER||l().user
```

### F1: config dir `dN()`

Offset 220051502. With `CLAUDE_SECURESTORAGE_CONFIG_DIR` unset, the dir is `Le()`, quoted in the next window.

```
function dN(){let e=process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;if(e!==void 0)return(e||u(o(),".claude")).normalize("NFC");return Le()}function qPe(){return X()?null:dN()}function HW(e
```

### F1: hash input `Le`

Offset 217226836. `Le` is `B8t()`, or `~/.claude` when that is nullish, then NFC-normalized. No `realpath` call appears in it. The body of `B8t()` is not in this window. The external review reads it as returning `CLAUDE_CONFIG_DIR` verbatim, with no slash stripping. That part is unverified, statically and live.

```
var Le=f(()=>(B8t()??u(D(),".claude")).normalize("NFC"),B8t);function bf(){return fne()?null:Le()}f
```

### F15: account attribute `iO()`

Offset 220051968. `acct` is `$USER`, else the OS username. It is `claude-code-user` when that throws or fails `s=/^[a-zA-Z0-9._-]+$/`.

```
function iO(){let e;try{e=process.env.USER||l().username}catch{e="claude-code-user"}if(!s.test(e))return"claude-code-user";return e}var R4t=30000;class i{cache={data:null,cachedAt:0};generation=0;readInFl
```

### F13: item cache

Offset 220052100. `R4t` is the 30 s item cache; the class after it holds `cache`, `generation` and `readInFlight`.

```
var R4t=30000;class i{
```

### F5: write through `security -i`, argv above `re`

Offset 220059537. A write goes to bare `security -i` on stdin while the command line is at most `re` bytes, and to argv above that. Neither form passes a keychain argument.

```
urn u(P,e)},async update(e){let r=DW();cN();try{let n=HW(KPe),s=iO(),a=_(e),o=Buffer.from(a,"utf-8").toString("hex"),i=`add-generic-password -U -a "${s}" -s "${n}" -X "${o}"`,c;if(i.length<=re)c=await Ry("security",["-i"],{input:i,stdio:["pipe","pipe","pipe"],reject:!1,timeout:l});else t(`Keychain payload (${a.length}B JSON) exceeds security -i stdin limit; using argv`,{level:"warn"}),c=await Ry("security",["add-generic-password","-U","-a",s,"-s",n,"-X",o],{stdio:["ignore","pipe","pipe"],reject:!1,timeout:l});if(c.exitCode!==0){if(c.exitCode===M&&r.keychainHoldsItem)return{success:!1,t
```

### F5: the `re` value

Offset 220058041. `re` is 4032.

```
,re=4032,N=44,M=36
```

### F5: the `re` comparison

Offset 220059595. The test that selects stdin or argv.

```
if(i.length<=re)c=await Ry("security
```

### F6: plaintext fallback

Offset 220057583. The plaintext store `r` is written only after the keychain write `e.update` fails with a result that is not `transient`.

```
alidateCache(){e.invalidateCache?.(),r.invalidateCache?.()},mutate(a,o){return u(s,a,o)},async update(a,o){let i=await e.readAsync(),c=await e.update(a);if(c.success){if(i===null)await r.delete(o);return g("secure_storage_credentials_write"),c}if(c.transient)return p("secure_storage_credentials_write",c.keychainLocked?"keychain_locked_skip_fallback":"primary_transient_skip_fallback"),c;let b=await r.update(a,o);if(b.success){if(i!==null&&!await e.delete())return m("secure_storage_credentials_write","plaintext_fallback_primary_not_cleared",c.exitCode===void 0?void 0:{primary_write_exit_code:c.exitCode}),{success:!1,transient:!0,fallbackWritten:!0};return p("secure_storage_credentials_write","plaintext_fallback_used"),{success:!0,warning:b.warning}}return m("secure_storage_c
```

### F7: refresh grant, old refresh token kept

Offset 220546563. `refresh_token:j=e` keeps the presented refresh token when the response carries none, and `Z` comes from `refresh_token_expires_in`. Static only: every live refresh exchange answered 400, so none exercised this.

```
grant_type:"refresh_token",refresh_token:e,client_id:s??on().CLIENT_ID,scope:x.join(" ")};if(r!==void 0)P.expires_in=r;try{let D=await Pt.post(on().TOKEN_URL,P,{headers:{"Content-Type":"application/json"},timeout:30000,signal:y,...dn});if(D.status!==200)throw Error(`Token refresh failed: ${D.statusText}`);let B=D.data,{access_token:G,refresh_token:j=e,expires_in:Q}=B,q=Date.now()+Q*1000,Z=q9r(B.refresh_token_expires_in,!1),de=jir(B.scope);a("tengu_oauth_token_refresh_success",{plugins_scope_requested:x.includes(Qxt),plugins_scope_granted:de.includes(Qxt)})
```

### F7: `refreshTokenExpiresAt` kept on merge

Offset 220790005. A refresh result without `refreshTokenExpiresAt` keeps the stored value.

```
function TA(e,n,r="refresh"){return{accessToken:n.accessToken,refreshToken:n.refreshToken,expiresAt:n.expiresAt,refreshTokenExpiresAt:n.refreshTokenExpiresAt??e?.refreshTokenExpiresAt,scopes:n.scopes,...r==="sign_in"?IG(n):FG(e,n),rateLimitTier:n.rateLimitTier??(r==="sign_in"?null:e?.rat
```

### F8: refresh lock options

Offset 220808519. `<dir>/.oauth_refresh.lock`, `realpath:!1`, stale 60 s, update 5 s.

```
function jar(e,n){return{lockfilePath:Vp(e,".oauth_refresh.lock"),realpath:!1,stale:60000,update:5000,onCompromised:(r)=>{t(`OAuth refresh lock compromised: ${r.message}`,{level:"error"}),n?.(r)}}}async function YA(e){return`${await tG(e).catch(()=
```

### F8: owner record

Offset 220559198. The owner file `.oauth_refresh.lock.owner` (at most 4096 bytes) records `pid`, `procStart`, `pidDomain`, `pidSpace`, `lockBirthtimeMs` and `legacyLockBirthtimeMs`.

```
from"path";var TN="tengu_quiet_marten",bS="tengu_zany_book",CN=".oauth_refresh.lock.owner",RN=4096,xN=f(()=>u({pid:E().int(),procStart:o().max(64).optional(),pidDomain:o().max(512),pidSpace:o().max(512),lockBirthtimeMs:E().positive(),legacyLockBirthtimeMs:E().positive().optional()}));class SS{reader=null;register(e){let n=this.reader;return this.reader=e,n}}var vS=new SS;function ES(e){r
```

### F8: takeover gate

Offset 220560540. With the flag `tengu_quiet_marten` off, the answer is `disabled`. With no owner record, it is `no_owner_record` or `lock_changed`, and the holder is never taken over.

```
T"?"lock_changed":n}}async function ON({claudeDir:e,lockfilePath:n,legacyLockfilePath:r,watchedMtimeMs:s}){let h=!1;try{if(!zc(TN))return"disabled";let y=await Wc(e);if(y===null)return(await lo(n)).mtimeMs===s?"no_owner_record":"lock_changed";let b=async()=>{let j=await lo(n);if(j.mtimeMs!==s)return"lock_changed";return j.birthtimeMs===y.lockBir
```

### F8: `.storage-write` lock

Offset 220055580. No `lockfilePath` is given, so the lock dir is `<dir>/.storage-write.lock`: 10 retries of 100 to 1000 ms, stale 15 s.

```
=new Promise((s)=>{n=s});try{if(await r,X())return await A.run(!0,e);let s=dN();await ae().mkdir(s);let a=await rd(te(s,".storage-write"),{realpath:!1,retries:{retries:10,minTimeout:100,maxTimeout:1000},stale:15000,onCompromised:(o)=>t(`[secureStorage] write lock compromised: ${d(o)}`,{level:"wa
```

### F9: PKCE exchange body

Offset 220545746. A JSON body with `grant_type`, `code`, `redirect_uri` (`http://localhost:<port>/callback`, or `MANUAL_REDIRECT_URL`), `client_id`, `code_verifier` and `state`.

```
rt:s,useManualRedirect:h=!1,expiresIn:y,clientId:b}){let w={grant_type:"authorization_code",code:e,redirect_uri:h?on().MANUAL_REDIRECT_URL:`http://localhost:${s}/callback`,client_id:b??on().CLIENT_ID,code_verifier:r,state:n};if(y!==void 0)w.expires_in=y;let R=await Pt.post(on().TOKEN_URL,w,{headers:{"Content-Type":"application/json"},timeout:30000,.
```

### F10: prod client id

Offset 217350917. `9d1c250a-…` is the `CLIENT_ID` of the config whose `MANUAL_REDIRECT_URL` is `https://platform.claude.com/oauth/code/callback`.

```
com/api/oauth/claude_cli/roles",CONSOLE_SUCCESS_URL:"https://platform.claude.com/buy_credits?returnUrl=/oauth/code/success%3Fapp%3Dclaude-code",CLAUDEAI_SUCCESS_URL:"https://platform.claude.com/oauth/code/success?app=claude-code",MANUAL_REDIRECT_URL:"https://platform.claude.com/oauth/code/callback",CLIENT_ID:"9d1c250a-e61b-44d9-88ed-5944d1962f5e",DESIGN_CLIENT_ID:"59637612-477b
```

### F10: local-dev client id

Offset 217352033. `22422756-…` sits beside `OAUTH_FILE_SUFFIX:"-local-oauth"`.

```
ze`,CLAUDE_AI_AUTHORIZE_URL:`${e}/oauth/authorize`,CLAUDE_AI_ORIGIN:e,TOKEN_URL:`${t}/v1/oauth/token`,API_KEY_URL:`${t}/api/oauth/claude_cli/create_api_key`,ROLES_URL:`${t}/api/oauth/claude_cli/roles`,CONSOLE_SUCCESS_URL:`${o}/buy_credits?returnUrl=/oauth/code/success%3Fapp%3Dclaude-code`,CLAUDEAI_SUCCESS_URL:`${o}/oauth/code/success?app=claude-code`,MANUAL_REDIRECT_URL:`${o}/oauth/code/callback`,CLIENT_ID:"22422756-60c9-4084-8eb7-27705fd5cf9a",DESIGN_CLIENT_ID:"00000000-0000-4000-8000-000000000000",OAUTH_FILE_SUFFIX:"-local-oauth",PL
```

### F12: refresh trigger `AA()`

Offset 220551335. A refresh is due when `now + 300000 >= expiresAt`.

```
function AA(e,n=Date.now()){if(e===null)return!1;return n+300000>=e}var J9r=new Map([["claude_max
```

### F14: adoption under the lock

Offset 220812363. Under the lock, a stored access token that differs from the presented one is adopted (`race_resolved`) with no token request.

```
??D.accessToken;ty();let G=await pl(b);if(!G?.refreshToken)return"no_refresh_token";if(G.accessToken!==B)return xn(),a("tengu_oauth_token_refresh_race_resolved",{}),"refreshed";if(!h&&!AA(G.expiresAt
```

### D5: the 401 path

Offset 220806626. After a 401, a re-read token that differs from the rejected one is adopted (`401_recovered_from_keychain`). This is the static side of D5 step 3.

```
 so the runner recycles this session with fresh credentials",{level:"error"}),setTimeout(()=>process.exit(1),2000);return!1}if(y.accessToken!==e)return xn(),a("tengu_oauth_401_recovered_from_keychain",{}),g("oauth_401_recovery"),avn({recov
```

### Reproducing the extracts

Save as `static-extract.ts` and run `bun static-extract.ts < /dev/null` against the same binary.
Every window above is one block of its output.

```ts
// Re-extracts, verbatim, every static fact the Phase V report cites from the 2.1.312 binary.
// Prints the byte offset and a fixed window around each anchor. Read-only.
import { readFileSync } from "node:fs";

const BIN = "/Users/jack/.local/share/claude/versions/2.1.312";
const b = readFileSync(BIN).toString("latin1");
const MIN = 200_000_000; // skip the earlier bundle copy; the live code sits past this offset

const anchors: Array<[id: string, needle: string, before: number, after: number]> = [
  ["F1/F4 service name HW()", "function HW(e=\"\")", 0, 330],
  ["F1 config dir dN()", "function dN(){", 0, 170],
  ["F1 hash input Le", "var Le=f(", 0, 90],
  ["F15 account iO()", "function iO(){", 0, 190],
  ["F10 prod client id", "CLIENT_ID:\"9d1c250a-", 300, 60],
  ["F13 item cache", "var R4t=", 0, 14],
  ["F5 write via security -i, argv above re", "add-generic-password -U -a \"${s}\" -s \"${n}\" -X \"${o}\"", 120, 420],
  ["re threshold value", ",re=4032", 0, 10],
  ["re threshold use", "if(i.length<=re)", 0, 20],
  ["F6 plaintext fallback", "plaintext_fallback_used", 700, 60],
  ["F7 refresh grant and old-token default", "grant_type:\"refresh_token\",refresh_token:e", 0, 520],
  ["F7 refreshTokenExpiresAt kept", "function TA(e,n,r=\"refresh\")", 0, 260],
  ["F8 refresh lock options", "function jar(e,n){", 0, 230],
  ["F8 owner record", "CN=\".oauth_refresh.lock.owner\"", 60, 300],
  ["F8 takeover gate", "if(!zc(TN))return\"disabled\"", 120, 200],
  ["F8 storage-write lock", "\".storage-write\"", 120, 160],
  ["F9 PKCE exchange", "grant_type:\"authorization_code\"", 60, 260],
  ["F10 local-dev client id", "CLIENT_ID:\"22422756-", 400, 120],
  ["F12 refresh trigger AA()", "function AA(e,n=Date.now())", 0, 70],
  ["F14 adoption under the lock", "tengu_oauth_token_refresh_race_resolved", 120, 40],
  ["D5 401 re-read", "tengu_oauth_401_recovered_from_keychain", 160, 40],
];

for (const [id, needle, before, after] of anchors) {
  const i = b.indexOf(needle, MIN);
  console.log(`=== ${id}`);
  if (i === -1) {
    console.log(`NOT FOUND: ${needle}\n`);
    continue;
  }
  const text = b.slice(Math.max(0, i - before), i + needle.length + after).replace(/[^\x20-\x7e]/g, "");
  console.log(`offset ${i}\n${text}\n`);
}
```
