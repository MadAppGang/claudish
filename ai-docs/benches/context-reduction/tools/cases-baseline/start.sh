#!/bin/sh
# The baseline variant of cases/: the run's ~/.claudish as for claudish-baseline,
# with no compaction block and no key. The claudish_config share must be the
# keyless default; the run's copy is deleted either way.
set -u
here=$(cd "$(dirname "$0")" && pwd)
src="$HOME/.bench-compaction/config.json"
if grep -q '"sk-ant-' "$src" 2>/dev/null; then
  rm -f "$src"
  echo "start: the baseline variant got a config with a key; pass no claudish_config to this variant" >&2
  exit 1
fi
rm -f "$src"
sh "$here/../claudish/start.sh" "$here/../claudish-baseline" || exit 1
