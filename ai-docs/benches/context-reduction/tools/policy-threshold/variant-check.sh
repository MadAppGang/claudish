#!/bin/sh
# The threshold variant of the history-policy experiment; see ../history-policy/variant-check.sh.
here=$(cd "$(dirname "$0")" && pwd)
exec sh "$here/../history-policy/variant-check.sh" threshold
