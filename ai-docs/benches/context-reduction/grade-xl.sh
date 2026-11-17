#!/bin/sh
# Grades one finished long-session-xl workspace: the --context-window feature's
# own tests (hidden-tests/, the same as grade.sh) and the tests of the second
# feature, the config file's contextWindow (hidden-tests-xl/).
#
#   grade-xl.sh <workspace>
#
# Both sets keep a `.hidden` suffix so neither `bun test` nor a linter in this
# repository picks them up. They are copied into the workspace here, at grading
# time, so the agent never had them. A test file the agent edited is
# overwritten by the graded copy.
#
# Exit 0: every hidden test passed. Any other exit: the work is not done.
# Each hidden file runs in its own bun process (see below).
set -eu

here=$(cd "$(dirname "$0")" && pwd)
ws=${1:?usage: grade-xl.sh <workspace>}

if [ ! -d "$ws/packages/cli/src" ]; then
  echo "grade-xl: $ws holds no packages/cli/src" >&2
  exit 2
fi

for set in hidden-tests hidden-tests-xl; do
  cd "$here/$set"
  find . -type f -name '*.hidden' | while read -r f; do
    dest="$ws/${f%.hidden}"
    mkdir -p "$(dirname "$dest")"
    cp "$f" "$dest"
  done
done

# bun reads bunfig.toml (the test preload) from the working directory only.
cd "$ws/packages/cli"
if [ ! -d node_modules ]; then
  (cd "$ws" && bun install --frozen-lockfile >/dev/null 2>&1)
fi

# Each file runs in its own bun process. In one process, state a file leaves
# behind reaches the next: a parseArgs that writes CLAUDISH_CONTEXT_WINDOW
# (the spec allows it there) let cli-passthrough-walker's --context-window
# inputs change lmstudio-devices' refusal results, so the grade depended on
# where the agent put the write. A file's own count lines get its name in
# front; only the totals at the end keep the "N pass" / "N fail" form that
# checks/grade-xl-check.ts reads.
set +e
pass=0; fail=0; status=0
for f in \
  src/claude-runner-lmstudio-window.test.ts \
  src/cli-context-window.test.ts \
  src/cli-passthrough-walker.test.ts \
  src/providers/context-window-limit.test.ts \
  src/providers/lmstudio-devices.test.ts \
  src/providers/lmstudio-machine-selection.test.ts \
  src/providers/transport/local-lmstudio-window.test.ts \
  src/providers/context-window-config.test.ts; do
  out=$(bun test "$f" 2>&1); code=$?
  p=$(printf '%s\n' "$out" | sed -n 's/^ *\([0-9][0-9]*\) pass *$/\1/p' | tail -1)
  n=$(printf '%s\n' "$out" | sed -n 's/^ *\([0-9][0-9]*\) fail *$/\1/p' | tail -1)
  # A file that cannot load counts no tests; it still fails the grade.
  [ "$code" -ne 0 ] && [ "${n:-0}" -eq 0 ] && n=1
  pass=$((pass + ${p:-0})); fail=$((fail + ${n:-0}))
  [ "$code" -ne 0 ] && status=1
  printf '%s\n' "$out" | sed -E "s#^( *[0-9]+ )(pass|fail) *\$#$f:\1\2#"
done
echo
echo " $pass pass"
echo " $fail fail"
exit "$status"
