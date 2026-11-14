# Cost Tracking

**Know what you're spending. No surprises.**

Metered providers charge per token. Claudish can help you track costs across sessions.

> **Note:** Cost tracking is experimental. Estimates are approximations based on model pricing data.

---

## Enable Cost Tracking

```bash
claudish --cost-track "do some work"
```

This:
1. Enables monitor mode automatically
2. Tracks token usage for each request
3. Calculates cost based on model pricing
4. Saves data for later analysis

---

## View Cost Report

After some sessions:

```bash
claudish --cost-audit
```

Output:
```
Cost Tracking Report
====================

Total sessions: 12
Total tokens: 245,891
  - Input tokens: 198,234
  - Output tokens: 47,657

Estimated cost: $2.34

By model:
  x-ai/grok-code-fast-1     $1.12 (48%)
  google/gemini-3-pro-preview $0.89 (38%)
  minimax/minimax-m2        $0.33 (14%)
```

---

## Reset Tracking

Start fresh:

```bash
claudish --cost-reset
```

This clears all accumulated cost data.

---

## How It Works

Claudish tracks:
- **Input tokens** - What you send (prompts, context, files)
- **Output tokens** - What the model generates
- **Model used** - For accurate per-model pricing

Each request is priced on its own, from the cloud models catalog, at the rate of
the connection that served it:

- A metered request uses the rate its provider publishes for that model's
  connection in the catalog. A tiered price uses its first tier and is marked
  an estimate, except on a Claude API session, where each request pays the band
  its whole input (cached tokens included) falls in; a free connection costs
  nothing.
- When the provider's connection publishes no rate, the model's OpenRouter
  price from the same catalog entry is used. With neither, claudish falls back
  to a per-provider default and marks the cost an estimate.
- A request served by a subscription is never counted as spend. It shows a
  cost of zero, whatever the model.
- A Claude API session is metered on your own `ANTHROPIC_API_KEY`: a launch
  with `anthropic@`, `a@` or `api@`, or the **Claude API** row in the picker.
  Every turn, subagent and background turns included, is priced at its own
  model's catalog rate. A Claude subscription session is not metered.

---

## Accuracy Notes

**Why "estimated"?**

1. **Pricing changes** - Providers adjust prices, and claudish prices with the catalog it last read
2. **Token counting** - Different tokenizers give slightly different counts
3. **Caching** - Some requests may be cached (cheaper or free)
4. **Special pricing** - Free tiers, promotions, etc.

For accurate billing, check the provider's own usage page. For OpenRouter, that is
your [OpenRouter dashboard](https://openrouter.ai/activity).

---

## Cost Optimization Tips

**Use the right model for the task:**

| Task | Recommended | Cost |
|------|-------------|------|
| Quick fixes | MiniMax M2 | $0.60/1M |
| General coding | Grok Code Fast | $0.85/1M |
| Complex work | Gemini 3 Pro | $7.00/1M |

**Avoid unnecessary context:**
Don't dump entire codebases when you only need one file.

**Use single-shot for simple tasks:**
Interactive sessions accumulate context. Single-shot starts fresh each time.

**Set up model mapping:**
Route cheap tasks to cheap models automatically. See [Model Mapping](../models/model-mapping.md).

---

## Real Cost Examples

**50K token session (typical):**
- MiniMax M2: ~$0.03
- Grok Code Fast: ~$0.04
- Gemini 3 Pro: ~$0.35

**Heavy 500K token session:**
- MiniMax M2: ~$0.30
- Grok Code Fast: ~$0.43
- Gemini 3 Pro: ~$3.50

**Monthly estimate (heavy user, 10 sessions/day):**
- Budget setup: ~$10-15/month
- Premium setup: ~$50-100/month

---

## Compare with Native Claude

For context, native Claude Code costs (via Anthropic):
- Claude 3.5 Sonnet: ~$18/1M input, ~$90/1M output
- Claude 3 Opus: ~$75/1M input, ~$375/1M output

OpenRouter models are often 10-100x cheaper for comparable tasks.

---

## OpenRouter Free Tier

OpenRouter offers $5 free credits for new accounts.

That's enough for:
- ~8M tokens with MiniMax M2
- ~6M tokens with Grok Code Fast
- ~700K tokens with Gemini 3 Pro

Plenty to evaluate if Claudish works for you.

---

## Next

- **[Choosing Models](../models/choosing-models.md)** - Cost vs capability trade-offs
- **[Environment Variables](environment.md)** - Configure model defaults
