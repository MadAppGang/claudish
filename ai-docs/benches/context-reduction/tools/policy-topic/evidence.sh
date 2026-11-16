#!/bin/sh
# The topic arm of the history-policy experiment; see ../history-policy/evidence.sh.
here=$(cd "$(dirname "$0")" && pwd)
exec sh "$here/../history-policy/evidence.sh" topic
