#!/bin/sh
# The `bun` long-session-xl puts first on the agent's PATH (installed by
# long-session-xl.sh, which replaces @REAL_BUN@ with the real bun's path).
#
# `bun test` must name what it runs. It is refused, with exit 2, when no
# positional argument is left after the options, or when one names the whole
# tree: `.`, `./`, `src`, `src/`, `./src`, `./src/`, `packages/cli`, or the
# filters `test`, `.test`, `.ts`, which match every test file. Each refusal is
# written to the trial's launch log (or BENCH_SHIM_LOG) as one line.
# Everything else runs the real bun with the same arguments.
real="@REAL_BUN@"
if [ "${1:-}" != test ]; then exec "$real" "$@"; fi

args="$*"
shift
scoped=0 whole="" skip=0
for a in "$@"; do
  if [ $skip = 1 ]; then skip=0; continue; fi
  case "$a" in
    # Options that take their value as the next argument.
    -t|--test-name-pattern|--timeout|--preload|-r|--reporter|--reporter-outfile|--coverage-dir|--coverage-reporter|--rerun-each|--seed|--max-concurrency|--path-ignore-patterns)
      skip=1 ;;
    -*) ;;
    .|./|src|src/|./src|./src/|packages/cli|packages/cli/|test|.test|.ts|ts) whole="$a" ;;
    *) scoped=1 ;;
  esac
done

if [ $scoped = 0 ] || [ -n "$whole" ]; then
  msg="This bench runs tests by path: name the test files or folders, e.g. \`bun test src/providers/context-window-limit.test.ts\`. A bare \`bun test\` runs all 659 test files and takes over 2 hours here."
  echo "$msg" >&2
  log=${BENCH_SHIM_LOG:-}
  if [ -z "$log" ]; then
    d=$(cat "$HOME/.bench-compaction/launch-dir" 2>/dev/null) && [ -n "$d" ] && log="$d/launch.log"
  fi
  [ -n "$log" ] && echo "bun-shim: refused bare bun test (args: $args${whole:+; whole tree: $whole})" >>"$log"
  exit 2
fi
exec "$real" test "$@"
