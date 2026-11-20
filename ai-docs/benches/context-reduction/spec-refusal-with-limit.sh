#!/bin/sh
# SpecRefusalWithLimit: one long-session-xl workspace against
# spec-checks/ (a limit set, a smaller running instance, still refused with
# the flag and the running size). Written after the first XL results, so it is
# reported beside Graded and never folded into it. Runs in its own bun process.
#
#   spec-refusal-with-limit.sh <workspace>
# Prints "SpecRefusalWithLimit pass|fail (N pass, M fail)"; exit 0 on pass.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
ws=${1:?usage: spec-refusal-with-limit.sh <workspace>}
rel=src/providers/lmstudio-refusal-with-limit.test.ts
cp "$here/spec-checks/packages/cli/$rel.spec" "$ws/packages/cli/$rel"
cd "$ws/packages/cli"
if [ ! -d node_modules ]; then
  (cd "$ws" && bun install --frozen-lockfile >/dev/null 2>&1)
fi
set +e
out=$(bun test "$rel" 2>&1); code=$?
p=$(printf '%s\n' "$out" | sed -n 's/^ *\([0-9][0-9]*\) pass *$/\1/p' | tail -1)
n=$(printf '%s\n' "$out" | sed -n 's/^ *\([0-9][0-9]*\) fail *$/\1/p' | tail -1)
printf '%s\n' "$out" | grep -E '^\(fail\)|error:' | sed 's/ \[[0-9.]*ms\]//'
if [ "$code" -eq 0 ] && [ "${p:-0}" -eq 2 ]; then
  echo "SpecRefusalWithLimit pass (${p:-0} pass, ${n:-0} fail)"; exit 0
fi
echo "SpecRefusalWithLimit fail (${p:-0} pass, ${n:-0} fail, exit $code)"; exit 1
