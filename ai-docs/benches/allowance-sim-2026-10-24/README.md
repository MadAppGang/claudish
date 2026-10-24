# Allowance strategy tournament — first run (2026-10-24)

Branch `worktree-multi-subscriptin`, commit `ee66b1ab`. Command:
`bun run sim:allowance --seeds 1 --days 7 --jobs 8` (2 min 32 s wall, 8 jobs). Raw table: `smoke-1seed-7d.txt`.
This is a SMOKE run (1 seed × 7 days), not the gate run (§4 wants ≥10 seeds × 28 days); read it as direction.

## Adversarial traces — all rules behave as the reviews predicted
- **lookahead** matches the oracle on every served trace: R1 3/3, gpt #1 4/4, opus H1 5/5, opus "choose" 6/6.
- **sticky** loses opus H1 (4 vs 5, a false 50 h gap) and opus "choose" (4 vs 6).
- **ebr** loses gpt #1 (3 vs 4). **governing-fefo** (the original research rule) loses R1 and gpt #1 — confirming the
  round-1/2 counterexamples.
- Gap traces (R2 at both rates, gpt #8 external use, opus M4 episodes) pass under all three deployable strategies.

## Realistic scenarios — the smart rules LOSE to sticky in most of them
| scenario (2 accounts) | sticky unserved Mcu | ebr Δ | lookahead Δ |
|---|---:|---:|---:|
| weekday-heavy · offset 26 h | 2.81 | **−1.36** | **−0.23** |
| over-subscribed · offset 26 h | 24.78 | **−2.32** | **−1.37** |
| steady · offset 26 h | 0.64 | +0.64 | +0.69 |
| steady · balanced | 0.64 | +0.64 | +0.81 |
| external-drift · offset 26 h | 0.87 | +0.60 | +0.87 |
| refactor-day · offset 26 h | 13.16 | +0.62 | +0.69 |
| weekday-heavy · 1 account | 1.53 | 0 | 0 |

Gate (§4): **neither ebr nor lookahead passes** — more unserved and more blocked hours than sticky on 7 scenarios,
too many switches on sliding-5h, 1 missed gap in each over-subscribed variant.

## Reading
The rules win exactly where the research said they would (staggered resets under real pressure) and lose where
demand is moderate: they switch to spend expiring allowance, pay the cache rebuild, and then the moved demand meets the
other account's tighter 5h window. Two likely causes to test before any tuning:
1. **Forecast quality**: forecast error 22–40 % and the plan is stale on 4.6–8.9 % of lookahead decisions.
2. **Switch cost vs vendor truth**: the simulator's hidden weights make a rebuild cost more than the model's prior.
**Decision: the default stays `sticky`.** `lookahead` and `ebr` remain opt-in. A gate run (10 seeds × 28 days) and a
replay of the real ledger come next, after real ledger data exists.
