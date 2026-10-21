# Spec: behaviour telemetry endpoint

**For:** backend developer
**From:** claudish CLI
**Status:** ✅ implemented on both sides — endpoint deployed, client shipped and verified end-to-end against the live service.
**⚠️ Action needed:** one additive field, see the change request below.
**Related:** MTL-79 (this endpoint), MTL-77 (what it feeds)

## Settled answers (were §11 open questions)

| Question | Answer |
|---|---|
| Route | `POST https://claudish.com/v1/behavior` |
| Auth | none |
| Rate limit | 60 accepted requests per source per minute |
| Retention | session rows 12 months; non-identifying weekly per-model/per-rule aggregates indefinitely |
| Schema versioning | client sends `schema_version`, server tolerates; no negotiation |

## ⚠️ One change request: add `context_fill_pct`

**This is a correction to my spec, not a gap in your implementation** — you built the bucket list I gave you, and the bucket list was wrong.

`context_bucket` was designed to answer query 3 ("does violation rate rise with context pressure?") and cannot. Two defects:

1. **Absolute tokens aren't comparable across models.** 178K is 89% of a 200K window — near compaction — and 18% of a 1M one, barely started. Both land in `150-200k`. Query 2 and query 3 are inherently cross-model, so this makes them unanswerable.
2. **`200k+` is unbounded**, so it has zero resolution from 200K to 1M — exactly where 1M-context models operate.

**The ask — one additive field:**

```jsonc
"context_fill_pct": 48    // integer 0-100, peak fill of the ENFORCED window. May be absent.
```

- **Additive, not a redefinition.** `context_bucket` stays and keeps its current meaning ("how big was the session"), so no stored row is invalidated and there's no discontinuity. Re-cutting the bucket boundaries instead would split the data at the change, and it can't be backfilled — the token count is deliberately never sent.
- **Absent when the window is unknown.** Treat missing as unknown; the client omits the key rather than send a percentage computed against a guessed denominator.
- **Computed client-side, necessarily.** The enforced window is `min(spec, CLAUDE_CODE_MAX_CONTEXT_TOKENS, CLAUDE_CODE_AUTO_COMPACT_WINDOW)`, and it diverges from the catalog's spec window routinely — the Codex OAuth backend caps gpt-5.6-sol at ~372K against a 1.05M API spec. Dividing by the catalog value server-side would report 17% where the session actually ran at 48%.
- **Leaks less than what's already sent**, not more: bounded 0–100, and carries no absolute scale, so nothing about project size is inferable.

Client already emits it (v7.36.0+). Until you add the column your ingest will drop it as an unknown field, which is harmless — no coordination needed on timing.

**Client-side deviation worth knowing:** a 429 is *not* honoured by waiting. The client drains its outbox in the background of a later session and must not sit on a `Retry-After` timer, so a rate-limited report is simply kept for the next run. Net effect on your side is identical, just later.

---

## 1. Intent — why this endpoint exists

Claudish routes Claude Code to non-Anthropic models (GPT, Gemini, GLM, Kimi, Qwen, …). Those
models regularly violate Claude Code's *behavioural* conventions in a way that is completely
invisible to the transport: HTTP 200, valid response, correct wire format — the model simply
did the wrong thing.

A worked example, which is the reason this exists:

> Claude Code's plan mode assigns each session a plan file at a random path and tells the model
> to write there. GPT-5.6 wrote a complete, correct 12.9 KB plan — to a filename it invented.
> Claude Code read the assigned path, found nothing, and silently degraded the approval dialog
> to a bare yes/no, stripping the only option that grants elevated permissions. Nothing failed.
> Nothing logged an error.

Claudish now has **built-in supervisor hooks** (the hook system) that detect these divergences and repair
some of them deterministically. Writing a rule requires evidence: *which* models violate *which*
convention, *how often*, and *under what conditions*. We reproduced the case above from 1129
local transcripts on one machine — but that is one developer's models on one developer's
projects. Every model we do not personally use is invisible.

**This endpoint is how a rule gets written for a model the maintainer has never run.**

That is the entire purpose. It is not product analytics, it is not usage tracking, and it is not
error reporting.

## 2. What this is NOT — and why it needs its own route

**It is not the existing `POST https://claudish.com/v1/report`.**

|  | `/v1/report` (exists) | this endpoint (new) |
|---|---|---|
| **Fires when** | a provider call **failed** | everything **succeeded** |
| **Question it answers** | "is this provider broken?" | "which model misbehaved, and how often?" |
| **Trigger** | per error | per session |
| **Consent flag** | `telemetry.enabled` | `hooks.telemetry.enabled` (separate) |

Different trigger, different schema, different consent. Mixing them makes both harder to query
and would mean an error-reporting consent silently authorised behavioural collection.

**Suggested route:** `POST https://claudish.com/v1/behavior` — confirm or propose your own.

## 3. Request

```
POST /v1/behavior
Content-Type: application/json
User-Agent: claudish/7.32.0
```

**One request per Claude Code session**, sent when the session ends. Not one per decision.

Field naming is `snake_case` and versioning is `schema_version`, matching `/v1/report`.

```jsonc
{
  "schema_version": 1,

  "session_id":  "9f2c…",           // salted hash, see §5
  "started_at":  "2026-08-04T01:00:00Z",
  "ended_at":    "2026-08-04T01:42:11Z",

  "claudish_version": "7.32.0",
  "platform":         "darwin",

  "model_id":       "gpt-5.6-sol",
  "provider_name":  "openai-codex",

  "context_bucket":   "150-200k",   // session size; coarse, never an exact count
  "context_fill_pct": 48,           // peak % of the ENFORCED window; omitted if unknown
  "turns":          42,

  "decisions": [
    {
      "rule_id":   "plan-mode/plan-file-path",
      "surface":   "tool_call",
      "tool_name": "Write",
      "counts": {
        "ignored":  420,
        "matched":  0,
        "warned":   0,
        "repaired": 11,
        "novel":    0
      },
      "path_relations": {
        "as_expected":          420,
        "same_dir_wrong_name":  11,
        "outside_expected_dir": 0
      }
    }
  ]
}
```

### Enumerations (closed sets — reject unknown values or store them as-is, your call)

| Field | Values |
|---|---|
| `surface` | `request`, `tool_call`, `model_output`, `sequence` |
| `counts.*` keys | `ignored`, `matched`, `warned`, `repaired`, `novel` |
| `path_relations.*` keys | `as_expected`, `same_dir_wrong_name`, `outside_expected_dir`, `no_expectation`, `not_applicable` |
| `platform` | `darwin`, `linux`, `win32` |
| `context_bucket` | `0-50k`, `50-100k`, `100-150k`, `150-200k`, `200k+` — session SIZE only, see the change request above |
| `context_fill_pct` | integer `0`-`100`, or **absent** when the window is unknown — this is the pressure signal |

`rule_id`, `tool_name`, `model_id`, and `provider_name` are **open** strings — new rules, tools,
and models appear constantly and must not require a schema change or a deploy on your side.

### Field notes

- **`context_bucket` is coarse because an exact token count is a fingerprint** — it leaks project
  and working scale across sessions. That reason still holds, so the field stays coarse. What
  does *not* hold is the claim this note originally made, that coarse buckets are sufficient for
  the pressure question: they are not, for the two reasons in the change request above. Read this
  field as **session size**.
- **`context_fill_pct` is the pressure signal**, and needs no bucketing of its own. An integer
  percent is already a 101-value quantisation, it is bounded 0–100, and it carries no absolute
  scale — so it leaks strictly less than the token count it replaces, while being comparable
  across models in a way absolute tokens never are.
- **`path_relations` is both why this data is useful and why it is safe.**
  `same_dir_wrong_name` is the exact discriminator the plan-mode rule keys off — and it carries
  no path. This categorical-instead-of-literal pattern is how we intend to handle every future
  value-like signal.
- **`decisions` is an array** so new rules and surfaces need no schema change.
- `counts` and `path_relations` are sparse: zero-valued keys may be omitted.

## 4. Response

| Status | Meaning | Client behaviour |
|---|---|---|
| `202 Accepted` | stored or queued | done |
| `400` | malformed | dropped, never retried |
| `429` | rate limited | honours `Retry-After`, then drops |
| `5xx` | your problem | at most one retry, then drops |

Body is ignored. Do not return data the client is expected to act on — there is no code path
that reads it.

## 5. Session id

Claude Code supplies a per-session UUID. Claudish sends a **salted hash** of it, never the raw
value, so this dataset cannot be joined against any other system that sees the same id. Stable
within a session, unlinkable across sessions and across users.

You need it only to group rows and to deduplicate retried deliveries.

## 6. What claudish will NEVER send

Enforced client-side by an **allow-list**, not a deny-list: the session report is built only from
the named fields of `recordTelemetryDecision` (`packages/cli/src/hooks/telemetry/aggregate.ts`), so a
field a future contributor adds to the local journal cannot leak by default — it has to be added to
the report explicitly. The hook engine's `journal()` fan-out (`packages/cli/src/hooks/engine.ts`) is
its only caller, and it sends a user-written hook's id as `"user"` and withholds an `mcp__` tool
name on such a row.

Treat this as a contract you can rely on when reasoning about retention, access, and where this
data is allowed to live:

- file paths, or any fragment of one
- tool-call argument **values** (argument key *names* only, and only where useful)
- message text, prompts, code, or model output
- `device_id` or `account_uuid` — Claude Code sends both alongside the session id; claudish
  discards them at the point of extraction
- API keys, tokens, or credentials of any kind
- repository, branch, project, or organisation names

If you ever receive any of the above, that is a **client bug**. Please report it rather than
storing it.

## 7. Delivery semantics the client guarantees

- **Opt-in, default off** (`hooks.telemetry.enabled`), deliberately separate from the
  existing error-reporting consent
- Fire-and-forget with a 3s timeout, matching `/v1/report`
- Any failure is silently discarded and never affects the user's request
- No retry storm: at most one retry, then dropped
- Honours `Retry-After`

## 8. Retention — a decision we need from you

Because the client sends **only session aggregates**, the server never holds raw per-decision
records. That removes the hardest retention question before it is asked. What remains:

1. How long are session summaries kept?
2. Are they rolled up (per model / per rule / per week) after some window, with session rows
   dropped?

**Our recommendation:** session summaries for 12 months; roll up to per-model/per-rule/per-week
aggregates kept indefinitely. Rule discovery uses recent data; the long-term value is trend
("did this model improve after their release"), which survives rollup intact.

Whatever you choose, please state it publicly — this is collected under an explicit opt-in, and
the consent prompt should be able to quote the retention period.

## 9. Queries this must answer

Design storage for these. They are the whole point.

1. For model M, which rules fire, at what rate per session?
2. Which models violate rule R most often? → *finds models that need a rule armed*
3. Does violation rate for rule R correlate with `context_bucket`? → *the motivating bug was
   context-pressure driven, so this is a first-class axis, not a nice-to-have*
4. Did rule R's `repaired` rate drop after `claudish_version` V? → *did the fix work*
5. Which `tool_name` + `surface` combinations produce `novel` decisions with no matching rule?

**Query 5 is the highest-value one — it is how the next rule gets discovered.** If storage design
forces a trade-off, favour it.

## 10. Not in scope for you

Analysis, rule generation, and the offline replay ("dream session") all run **client-side**
against the local journal, which keeps full detail including real paths. This endpoint is only
the cross-user aggregate.

Please don't build analysis on top of it without talking to us first — we would rather send you a
better payload than have two implementations of the same logic drift apart.

## 11. Open questions — what we need back

1. **Route and name** — confirm `/v1/behavior` or propose
2. **Auth model.** Claudish has no user accounts on this path and `/v1/report` is
   unauthenticated. Shared client token, per-install token, or unauthenticated with rate
   limiting? Please state the **rate limit** so the client can respect it rather than discover it
3. **Retention** (§8) — needed before the consent prompt can be written
4. **Schema versioning.** Is client-side `schema_version: N` plus server-side tolerance enough,
   or do you want negotiation?

Nothing is sent until 1–3 are answered. There is no upload transport in the client yet — the
projection and the consent flag exist, the `fetch` deliberately does not.

## References

- Client design: `ai-docs/architecture/hooks.md` → "Telemetry: the cross-user corpus"
- Allow-list: `packages/cli/src/hooks/telemetry/aggregate.ts` → `recordTelemetryDecision()`, fed by
  the `journal()` fan-out in `packages/cli/src/hooks/engine.ts`
- Existing bug-report endpoint, for contrast: `packages/cli/src/telemetry.ts`
