# Muse Code (`muse@`) live validation, 2026-10-20

What was checked against Meta's live Muse Code service before `meta-muse-code` shipped, and
what was not. The account was one Muse Code Power Usage subscription. The binary was the
branch bundle (`bun packages/cli/dist/index.js`), never a globally installed claudish. Two
rounds ran: the first found three reporting defects (F1-F3), and the second re-checked them
after the fixes. Rationale for the design lives in `ai-docs/architecture/providers/meta-muse-code.md`.

## Checked live

| Behaviour | Result |
|---|---|
| `--probe muse@muse-spark-1.3` | live in 3.58 s, wire `openai-responses-sse`, 1.0M context, subscription tier |
| `--probe` names the signer (F1) | `Key  Muse Code borrowed copy · Muse Code Power Usage  (signed this probe request)`; with no login files it names `claudish login muse`; `--json` names source and tier with 0 occurrences of a `dca:` token |
| Interactive session | PONG; status line `Muse Code • FREE`, 1M window |
| `-p` single shot | PONG, exit 0, 0 Keychain value reads |
| Tool use | a `Read` tool call answered correctly |
| Two `team` slots on the borrowed copy | both COMPLETED with PONG, `costUsd: 0`, 0 Keychain value reads over 41 s |
| `preflight` probe:false then probe:true | SUB "not probed", then live; 0 Keychain value reads (watcher attributed per process) |
| `preflight` with no claudish login files (F3) | no dialog; the no-route row names `claudish login muse` and `muse login` in an interactive terminal |
| A rejected login (F2) | exit 1: `Meta rejected the Muse Code login (HTTP 401): it has expired or been revoked. Run \`claudish login muse\`, …`; with a fake `META_API_KEY` set, no metered hop was attempted |
| The Muse CLI afterwards | `muse exec "say PONG"` answered PONG, exit 0 |
| Bare `muse-spark-1.3` today | goes to gateways; the OpenCode Zen Go `-contributor` id is dropped with "contributor id: content-use opt-in" |

The Keychain item `ai.meta.dev.credentials` was read once, after one "Always Allow" in an
interactive launch. claudish wrote `~/.claudish/meta-muse-borrowed.json` (0600) only after a
mint confirmed the login. A stale read lock left by an interrupted earlier attempt (dead pid)
was recovered automatically.

## Not checked live

- A metered `meta@` request: no `META_API_KEY` was available. Only `--probe` was checked (tier `native API`, "set META_API_KEY").
- An account without a subscription: none was available. Unit tests cover it.
- A bare name routing to `muse@`: impossible until models-index publishes the Muse Code route
  (`BACKEND_TASKS_meta_muse_code_route-20261016.md`, tasks M1-M6). The seeded-catalog test for
  that ordering is blocked on the same work.

## Measurement traps met on the way

- A Keychain watcher that matches any `find-generic-password … -w` on the machine counted 16
  value reads that belonged to other sessions. Count reads per process command line.
- `team` in grid mode spawned the `claudish` on PATH, not the branch bundle. JSON mode with
  `CLAUDISH_BIN` pointing at the bundle measured the branch.
