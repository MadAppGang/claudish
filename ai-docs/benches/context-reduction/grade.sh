#!/bin/sh
# Grades one finished workspace against the feature's own tests.
#
#   grade.sh <workspace>
#
# The tests live beside this script under hidden-tests/, each with a `.hidden`
# suffix so neither `bun test` nor a linter in this repository picks them up. They are
# copied into the workspace here, at grading time, so the agent never had them.
# A test file the agent edited is overwritten by the graded copy.
#
# Exit 0: every hidden test passed. Any other exit: the feature is not done.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
ws=${1:?usage: grade.sh <workspace>}

if [ ! -d "$ws/packages/cli/src" ]; then
  echo "grade: $ws holds no packages/cli/src" >&2
  exit 2
fi

cd "$here/hidden-tests"
find . -type f -name '*.hidden' | while read -r f; do
  dest="$ws/${f%.hidden}"
  mkdir -p "$(dirname "$dest")"
  cp "$f" "$dest"
done

# bun reads bunfig.toml (the test preload) from the working directory only.
cd "$ws/packages/cli"
if [ ! -d node_modules ]; then
  (cd "$ws" && bun install --frozen-lockfile >/dev/null 2>&1)
fi

exec bun test \
  src/claude-runner-lmstudio-window.test.ts \
  src/cli-context-window.test.ts \
  src/cli-passthrough-walker.test.ts \
  src/providers/context-window-limit.test.ts \
  src/providers/lmstudio-devices.test.ts \
  src/providers/lmstudio-machine-selection.test.ts \
  src/providers/transport/local-lmstudio-window.test.ts
