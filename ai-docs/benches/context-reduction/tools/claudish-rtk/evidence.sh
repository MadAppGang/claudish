#!/bin/sh
# The claudish proof first, then the same evidence as the native variant.
here=$(cd "$(dirname "$0")" && pwd)
sh "$here/../claudish/evidence.sh"
exec sh "$here/../rtk/evidence.sh"
