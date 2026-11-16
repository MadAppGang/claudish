#!/bin/sh
# As for cases-baseline; see ../cases-baseline/evidence.sh.
here=$(cd "$(dirname "$0")" && pwd)
exec sh "$here/../cases-baseline/evidence.sh"
