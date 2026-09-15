# `--probe zengo@` reports a missing key while that key authenticates

Measured 2026-09-15 against the build at `v9.4.0`'s candidate commit, on a
machine where `zengo@` works.

## What was observed

```
claudish --probe zengo@minimax-m3
→ opencode-zen-go · 0/1 live
→ ○ missing
→ Key —
```

Minutes later, on the same machine and the same build, a real run through the
same provider succeeded:

```
[Proxy] Created OpenCode Zen Go (composed): minimax-m3
[Zen Go] Calling API: https://opencode.ai/zen/go/v1/chat/completions
[Zen Go] Response status: 200
```

Zero `[Fallback]` lines. The credential is present in the macOS Keychain under
the item `claudish` / account `OPENCODE_GO_API_KEY`.

## Why this is NOT the failure it resembles

This looks like the credential-name drift that produced the v7.11.0 Test All
regression, and it is not. The name matches exactly:
`providers/provider-definitions.ts:849` declares
`apiKeyEnvVar: "OPENCODE_GO_API_KEY"`, and `OPENCODE_GO_API_KEY` is the account
name stored in the Keychain. The same line's `siblingKeyEnvVars: ["OPENCODE_API_KEY"]`
is also unrelated — that is the metered Zen key, a different credential.

So the probe is not looking for the wrong name. It is not consulting the
Keychain backend for this provider at all, or it is consulting it in a way that
answers "absent" for a key that reads fine.

## Why it matters more than a cosmetic wrong label

`○ missing` and `Key —` are a claim about the machine, and the machine was never
asked — the same shape as the gate-that-gates-its-own-diagnostic failure recorded
in `ai-docs/architecture/testing.md`. It is indistinguishable from the output on
a machine that genuinely has no key, so it sends a user to fix a working
credential. `ai-docs/architecture/keychain.md` records the distinction this
probably turns on: enumerate-for-presence and read-for-value are different
operations against `security(1)` and do not always agree.

## Not yet established

- Whether both probe UIs are affected. `ai-docs/reports/`-adjacent notes record
  that claudish has TWO separate probe paths (the config TUI and `--probe`);
  only `--probe` was observed here.
- Whether other Keychain-backed providers show the same thing, or only
  `opencode-zen-go`.
- Whether `CLAUDISH_DISABLE_KEYCHAIN` was somehow in the environment. It was not
  set by the caller, but this was not asserted directly.

Reproduce before fixing: run `--probe` against a Keychain-only provider, then run
the same provider for real, and compare. Do not test against the real Keychain by
killing `security` processes — see `ai-docs/architecture/keychain.md`.
