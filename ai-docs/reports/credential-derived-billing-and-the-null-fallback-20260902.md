# Billing by credential, and the null-fallback bug that four defences shared

**Date:** 2026-09-02
**Scope:** the fix for defects 1-3 of
`subscription-knowledge-split-and-route-priority-20260901.md`.
**Status:** shipped in the working tree; measurements 1 and 2 below still open.

This records what the work found, not what it did. The build log lives in the
session directory, which is gitignored; everything here is meant to outlive it.

---

## 1. Three premises in the tree were false, and each had been copied forward

The original report framed the problem as "subscription knowledge is split across
two parties, and both copies are wrong". That generalises further than it claimed.
Every defect fixed here was two records disagreeing, with nothing able to prove
either wrong — and in three cases the wrong record had been quoted into a second
place, which made it look corroborated.

### `OPENAI_API_KEY` does not authenticate `cx@`

`remote-provider-types.ts` excluded `openai-codex` from `SUBSCRIPTION_PROVIDERS`
because `apiKeyAliases: ["OPENAI_API_KEY"]` supposedly let a generic metered key
sign for it. `ai-docs/architecture/routing.md` repeated the reasoning.

It is not true at sign time. `authority.ts:157` registers the Codex composite
before the generic provider loop and `:192-205` blocks the generic provider from
claiming the name, so the alias reaches display and hint code only
(`getApiKeyInfo`, `describeMissingCredential`). `codex-credential.ts` builds the
fallback with `envVar: "OPENAI_CODEX_API_KEY"` and no aliases, and says so.

`auth/credentials/equivalence.test.ts:302-305` is a live test asserting exactly
this, and `:26-31` states outright that the Codex path does not read
`oauth-registry`. Both existed before this work. The comment and the architecture
doc had simply gone stale around them.

**The real dual mode is OAuth versus `OPENAI_CODEX_API_KEY`.** Corrected in
`routing.md` and in the exclusion comment.

### The "free Zen plan" was already metered

`FREE_PROVIDERS` held `["opencode-zen", "zen"]` on the strength of a keyless tier
that had been removed — the same file records the `publicKeyFallback` literal
measured returning 401 and deleted. The set outlived the fact by months, reporting
`$0` for real metered usage, which the file's own comment calls the error that
costs the user money.

`FREE_PROVIDERS` is deleted. Zen now falls through to the estimate, flagged
`isEstimate: true`: a visible guess instead of an invisible zero.

### `apiKeyDescription` at `provider-definitions.ts:413` was never stale

The design proposed rewriting it, arguing that a label calling
`OPENAI_CODEX_API_KEY` a "ChatGPT Plus/Pro subscription" key had decayed away from
an `apiKeyUrl` two lines below pointing at the metered platform console.

Two reviewers independently ran the archaeology: `:413` and `:414` were introduced
in the **same commit**, `f9b1c546`. The contradiction was born, not drifted, so
neither line is evidence against the other. The edit was cancelled.

**Generalisation:** a comment explaining why something was excluded decays exactly
like code, and nothing type-checks it. Two of the three premises above had been
quoted into a second document, which is what made them feel settled.

---

## 2. The bug worth remembering: a discriminator that was right for one purpose

The FR-3 fix recorded which credential arm signed, so billing could follow the
credential rather than the provider name. It recorded it like this:

```ts
recordSignedArm("openai-codex", this.cachedAuth ? "subscription" : "metered");
```

`cachedAuth` is non-null on **both** arms. `CompositeCredentialProvider.getRequestAuth`
returns `this.fallback.getRequestAuth(ctx)`, and the api-key half returns an
artifact — never null, never throwing when a key is present. `cachedAuth` is null
only when `getRequestAuth` THREW.

So every `OPENAI_CODEX_API_KEY` session was labelled a subscription from request
one: `{0, 0, isSubscription: true}`, `TokenTracker` stops accruing, five surfaces
render `SUB`/`FREE`, while OpenAI meters the key. A credential-less session got
`{headers:{}}` → truthy → subscription too.

**It was a regression.** Before the change `openai-codex` always reported metered.
The fix written to prevent under-reporting metered spend introduced it.

The expression is not wrong everywhere. `getEndpoint()` and `getHeaders()` treat
null as "use the api-key path", so truthiness selects correctly there. It is
invalid only as a *billing* signal. That is why it reads as correct: it **is**
correct, for the two uses immediately above it in the same file.

### Why four defences missed it together

| Layer | Why it passed |
|---|---|
| Design | reasoned null ⇒ api-key path — true for endpoint/headers, false for billing |
| Implementation | encoded that reasoning faithfully, with a comment |
| 26 tests | the only test of the production writer stubbed `getRequestAuth` to **throw** — the one condition production cannot produce |
| Live validation | the machine held only the OAuth credential, so the broken arm was unreachable |

They were not four independent checks. They were one belief restated four times.
A reviewer ran the file and reported *"25/25 green with the CRITICAL bug live in
the tree."*

**The fix:** an explicit `RequestAuth.arm?: "oauth" | "api-key"`, stamped by each
credential half, passed through the composite, read by the transport. It names the
**credential**, not the billing outcome — deliberately, because
`ApiKeyCredentialProvider` also serves ~40 single-mode providers including
flat-rate plans (`kimi-coding`, `glm-coding`), where an api-key arm is a
subscription. Endpoint inference was rejected on evidence: `KimiOAuthHalf` sets no
endpoint override, so that heuristic is already wrong for the second instance of
the same pattern.

---

## 3. New shared state recruits every existing caller

`refreshAuth` now unconditionally records the signed arm. That silently turned
**every** Codex transport test into a billing-state writer, including ones that
only meant to pin endpoints and headers. Bun runs all test files in one process,
and the record is consulted before the presence probe.

Measured, with instrumentation, one shared Map:

```
src/providers/transport/openai-codex-oauth.test.ts:
[DIAG] recordSignedArm openai-codex subscription map@ lrz7ib
src/providers/transport/zzz-residue-leak-probe.test.ts:
[DIAG] probe read      openai-codex subscription map@ lrz7ib
```

Written by an endpoint test, read by the next file as a billing answer, in the
money-losing direction.

This is the same failure class the change had just sealed one layer up: the probe
registrar was made to return the previous probe so tests restore it rather than
uninstalling it with `null`. The rule was established at the registrar and did not
transfer to the record until a reviewer pointed at it. Both rules are now written
in the same places (`architecture.md` §7.12, the registrar doc, `clearSignedArm`).

---

## 4. Measurements

### Corrected: the Zen Go alias test that proves nothing

`provider-definitions.ts` claimed keys for one OpenCode tier are refused by the
other (401), undated and unmeasured. `opencode-zen-go` is classified flat-rate by
NAME on that claim, while aliasing `OPENCODE_API_KEY`, the metered Zen key.

The prescribed experiment — GET the Zen Go `/v1/models` and read a 401 — is
invalid. Measured 2026-09-01 with no credential at all:

```
GET  https://opencode.ai/zen/go/v1/models        -> 200 (full model list)
GET  https://opencode.ai/zen/v1/models           -> 200 (full model list)
POST https://opencode.ai/zen/go/v1/chat/completions
     -> 401 {"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}
```

Both listings are public. Only the billed path can settle it.

### Answered, 2026-09-02 — both premises measured

The two doubts this section left open have been run against the live APIs. Raw
capture: `ai-docs/reports/data/measurements-20260902.txt`.

**M2 — `OPENAI_CODEX_API_KEY` is metered. CONFIRMED.** A platform key against
exactly the host and path the api-key arm signs:

```
POST https://api.openai.com/v1/responses   -> 200
{ …, "billing": { "payer": "developer" }, … }
```

The endpoint names the payer in its own field, and it is the key holder, not a
ChatGPT plan. What was inferred from the host name and the console URL is now
read off the response. Nothing in the design changes: the probe already answered
metered for that arm. What changes is that the premise is no longer a premise —
so `remote-provider-types.ts`, `architecture.md` §3.2 and `routing.md` no longer
describe it as inferred. One 200 does not prove every account type answers the
same way; the probe's metered default still covers that.

**M1 — the OpenCode tier separation. REFUTED.** Measured on `minimax-m3`, a
model both tiers serve, one `chat/completions` POST per row:

```
CONTROL  Zen Go key -> https://opencode.ai/zen/go/v1/chat/completions -> 200 OK
CROSS    Zen Go key -> https://opencode.ai/zen/v1/chat/completions    -> 200 OK   <- claim said 401
BOGUS    fake key   -> https://opencode.ai/zen/v1/chat/completions    -> 401 AuthError "Invalid API key."
```

The bogus row is what makes the cross-tier 200 mean something: that endpoint does
authenticate, so it ACCEPTED a key minted for the other tier rather than waving
everything through. The two 200s came back with different response-id shapes
(`06e71dee…` vs `chatcmpl-76bdafac…`), i.e. two different upstreams honouring one
key. `provider-definitions.ts`'s claim that "keys for one tier are not accepted by
the other (401)" is false.

Note what was and was not measured. **Measured:** a Go key accepted by the Zen
endpoint, which refutes the symmetric claim. **Not measured:** a ZEN-tier key
against `/zen/go` — no Zen-tier key exists on this machine — and that is the
direction that loses money, because `opencode-zen-go` is classified flat-rate by
NAME.

**Consequence: the alias is removed.** `opencode-zen-go` no longer aliases
`OPENCODE_API_KEY`. The alias only ever had one justification, and it is now known
to be false; keeping it would leave the money-losing case reachable on no evidence
at all that the endpoint refuses it. With the alias gone, `zgo@` answers to one
credential — `OPENCODE_GO_API_KEY`, minted by the Lite Plan — so every credential
that can reach a provider labelled `SUB` is a plan credential. That, not the name,
is what now justifies its `SUBSCRIPTION_PROVIDERS` membership.

Removing an alias removes a working configuration, so the fallout was chased
rather than assumed. Three tables answer "does `zgo@` have a credential" and they
had to move together: the definition (which the credential authority builds from),
`API_KEY_MAP` (which `--probe` builds its `hasCredentials` rows from — left alone,
the probe would have printed a credentialed row for a key the authority refuses),
and `PROVIDER_HINT_MAP`, which had **no `opencode-zen-go` entry at all**, so the
provider heading seven default chains could go missing from a no-credentials hint
without being named. A new definition field, `siblingKeyEnvVars`, adds one clause
to the missing-credential sentence — *"OPENCODE_API_KEY (opencode-zen) is a
DIFFERENT plan's key and is not accepted here"* — because "Set
OPENCODE_GO_API_KEY" alone invites a user holding the Zen key to export it under
the new name and collect a 401 they cannot attribute.

### Still open

1. **A Zen-tier key against `/zen/go`.** Unblocked only by acquiring a Zen-tier
   key. It no longer threatens the classification (that key cannot satisfy `zgo@`
   any more), but it would matter again the moment anyone re-adds an alias or a
   shared credential to that provider.
2. **Whether a ChatGPT-plan-backed key exists for `api.openai.com/v1/responses`
   and answers `"payer"` differently.** Not tested; the probe's metered default is
   the safe answer either way.

Both are written beside the classification they affect, with the settling request
named, rather than left implicit.

---

## 5. Adjacent bug, not fixed here

`resolveSubscriptionRouting` (`adapters/model-catalog.ts`, used by
`routing-rules.ts`) compares the claudish provider uid against the catalog's
`subscriptionPlans[]`, whose values are **backend plan ids**. `kimi-coding`
matches by coincidence. `opencode-go`, `cognition-devin`, `z-ai-glm-coding-plan`
and `alibaba-token-plan-individual` do not, so `opencode-zen-go` never returns
`kind:"serves"` from that path.

This matters more now. FR-1 makes `list_models` advertise every route the backend
sends, so a user can type `kc@kimi-k3` and hit a plan-id mismatch that renders it
unresolvable. Left out of scope to keep this change's blast radius assessable;
belongs with the backend order-contract task.

Also for the backend: the live payload repeats `qc` inside one `subscriptions[]`
array for `qwen3.8-max`, `qwen3.8-flash` and `deepseek-v4-pro`. Harmless — the
client dedupes — but it suggests the generator joins something twice.

---

## 6. What this says about verification

- **A test that cannot fail proves nothing, and coverage will not tell you.** The
  first FR-1 test plan had five tests over `collectRoutingPrefixes`, full coverage
  of the function, and all five passed against the broken code. They probed the
  dedupe, the missing-`prefix` guard and the ordering — every property already
  true — and never the one that distinguishes iterating rows from iterating routes.
  Mutation testing is the cheap answer: revert a line, watch a specific test go red.
- **Mutation testing verifies a test can fail HERE, not everywhere.** One trap test
  was reported as catching its mutation, but only because
  `~/.claudish/codex-oauth.json` exists on this developer's machine. On CI it would
  pass under the very mutation it exists to detect.
- **A green live check can be structurally blind.** The live billing verification
  passed while the bug was live, because this machine holds only the OAuth
  credential. The limitation had been written down in advance and the green result
  was still over-read. Naming a blind spot does not cover it.
- **Test files are documentation.** `openai-codex-oauth.test.ts` modelled "no
  OAuth" as a throw — the exact false premise the bug shipped under. The code was
  fixed while the lesson that produced it stayed on the shelf, one simplification
  away from returning with a green suite.
