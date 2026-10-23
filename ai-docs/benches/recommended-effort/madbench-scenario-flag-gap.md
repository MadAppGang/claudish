# Draft for MadAppGang/madbench: a repeated `--scenario` silently keeps only the last value

Status: draft, not filed. It needs Jack's approval first. Classification (madbench-evals gap
rule, step 2): **bug** — the flag accepts a second value without an error and drops the first.
Looked up first: `madbench --help` (`--scenario <string>  Run only this Scenario by name`,
while `--variant` says "repeatable"), `harness-and-sandbox.md` §9, and the madbench issues
(searched "scenario flag", "several scenarios": nothing). No stand-in: the recommended-effort
run12 ran one madbench invocation per Scenario instead.

```
$ madbench version
madbench 0.54.0
$ madbench skills --check --dir ~/.claude/plugins/cache/magus/madbench/0.12.3/skills
skills 0.53.0 · madbench 0.54.0 · stale
```

## Title

`--scenario` given twice runs only the last Scenario, with no error

## Reproduce

```
$ madbench ai-docs/benches/recommended-effort/madbench.yaml --harness mock \
    --scenario session-named-old-model --scenario run-prompt-pick --report-json out.json
exit 1        (the Scenario errors under mock by design; the point is which one ran)
$ jq -c '[.results[].scenario_id]' out.json
["run-prompt-pick"]
```

`session-named-old-model` is not run and not mentioned. A comma list is refused loudly
(`Error: --scenario "a,b": no such scenario; available: …`), so the only silent case is the
repeated flag.

## Expected

Either `--scenario` is repeatable like `--variant` (run every named Scenario), or a second
`--scenario` is refused at parse time. Today an Experiment that should run two Scenarios of
one variant gets one, and the report looks complete: a paid run reads as covering a Scenario it
never ran.
