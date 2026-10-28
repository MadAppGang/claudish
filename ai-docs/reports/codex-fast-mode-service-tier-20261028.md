# Codex `/fast`: what Claude Code sends, what Codex accepts, what it reports (2026-10-28)

Evidence behind `wire.md` § Speed (step 5s and the two launch gates).

## Claude Code 2.1.310 (static, `strings` of the Mach-O bundle)

- `/fast` on → `speed: "fast"` in the `/v1/messages` body and beta `fast-mode-2026-02-01`
  (`QSn = v("speed","fast-mode-2026-02-01")`; request field `...rD!==void 0&&{speed:rD}`).
- `rD = "fast"` only if `Xo() && aI() && !wVe() && Hh(model) && fastMode && !k_n(model)`:
  - `Xo()`: provider is `firstParty` (no `CLAUDE_CODE_USE_*`) and no `CLAUDE_CODE_DISABLE_FAST_MODE`.
  - `aI()` → `oM()`: org status. `kLe()` with `CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK` sets status
    `enabled` and returns before fetching `${BASE_API_URL}/api/claude_code_penguin_mode`.
  - `Hh(model)`: `gb(model, "fast_mode")` (from `CLAUDE_CODE_MODEL_CAPABILITIES`, parsed by `yXo`:
    `;`-separated, `pattern=cap,cap`, `*` suffix = prefix match, no `=` = every model, `-cap`
    negates, later entries win), else the name contains `opus-4-8` or `opus-5`.
  - `wVe()`: fast-mode cooldown after a rate-limit rejection.

## Codex CLI 0.164.0 (static) and the account

- The Responses request struct serializes `model, stream, service_tier, previous_response_id,
  input, tools, tool_choice, parallel_tool_calls, reasoning, store, stream_options, include, text,
  client_metadata`: no separate speed field.
- Config `service_tier = "fast"` is recorded as thread setting `service_tier: "priority"`
  (`~/.codex/sessions/**`, `thread_settings_applied`, 45 occurrences on this machine).
- `GET /backend-api/codex/models` (this account, `~/.codex/models_cache.json` fetched
  2026-10-28): all 10 listed models carry `service_tiers: [{id: "priority", name: "Fast"}]`,
  `default_service_tier: null`. gpt-5.5 is not listed (the catalog has it as `speed: rejected`).

## Live A/B (one pair, gpt-5.6-sol, ChatGPT OAuth, signed as claudish signs)

Same prompt ("numbers 1 to 120"), `reasoning.effort: low`, 243 output tokens each:

| request | status | reported tier (created → completed) | TTFT | total | tok/s after first token |
|---|---|---|---|---|---|
| `service_tier: "priority"` | 200 | `auto` → `default` | 0.80 s | 1.96 s | 210 |
| no `service_tier` | 200 | `auto` → `default` | 1.21 s | 3.50 s | 106 |

- The backend accepts the field (200) and serves about 2× faster, matching the tier's "2x speed"
  description. The no-tier request ran SECOND, so a warm cache would favour it, not the other.
- The response's `service_tier` is uninformative here: `default` either way. Do not use it to
  verify the tier; time the stream instead.
- n = 1 pair. Repeat with the order reversed before relying on the exact ratio.

A claudish session (`cx@gpt-5.6-sol`, `/fast on`, code mode lite) logged
`[Wire] openai/codex-subscription · gpt-5.6-sol: speed fast: /service_tier = "priority" (from the
account's dynamic models catalog)` and got a 200.
