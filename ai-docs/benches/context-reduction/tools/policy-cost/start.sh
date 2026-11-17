#!/bin/sh
# The cost variant of the history-policy experiment; see ../history-policy/start.sh.
here=$(cd "$(dirname "$0")" && pwd)
exec sh "$here/../history-policy/start.sh" cost
