#!/bin/sh
# As for cases-baseline; see ../cases-baseline/variant-check.sh.
here=$(cd "$(dirname "$0")" && pwd)
exec sh "$here/../cases-baseline/variant-check.sh"
