# long-session-xl reference

The reference state for the `long-session-xl` Scenario's grade: commit
`41fa75c4` (`feat(cli): add --context-window to set the local model window`,
the first feature, whose tests are `../hidden-tests/`) plus
`config-context-window.patch` (the second feature, the config file's
`contextWindow`, whose tests are `../hidden-tests-xl/`).

## Positive control: the reference passes all 127 tests

```
git archive --format=tar -o /tmp/xl-ref.tar 41fa75c4
mkdir /tmp/xl-ref && tar -xf /tmp/xl-ref.tar -C /tmp/xl-ref
patch -p1 -d /tmp/xl-ref -i ai-docs/benches/context-reduction/reference-xl/config-context-window.patch
sh ai-docs/benches/context-reduction/grade-xl.sh /tmp/xl-ref
```

Measured on 2026-11-17: `127 pass, 0 fail`, `Ran 127 tests across 8 files`,
exit 0. `checks/grade-xl-check.ts` on the same tree: pass, score 1.

## What the second feature's tests tell apart

| Tree | Result |
|---|---|
| `41fa75c4` with the patch | 127 pass |
| `41fa75c4` alone (the first feature only) | 119 pass, 8 fail: the 3 `loadConfig` tests and 5 `contextWindowLimit` tests that need the config |
| the patch without its `loadConfig` allowlist line | 119 pass, 8 fail: the same 8, since `contextWindowLimit` reads the config through `loadConfig` |

The other 5 of the 13 new tests (the variable wins, a bad or zero config size
is skipped, no field, no file) pass on the first feature alone: they guard
behaviour the second feature must not break.

## Negative control

`madbench check cases/history-policy-xl.experiment.yaml --scenario long-session-xl`
for each variant: every graded check must fail on the unchanged code
(`fe1a93ec`).
