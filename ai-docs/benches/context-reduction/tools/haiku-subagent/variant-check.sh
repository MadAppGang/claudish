#!/bin/sh
# The graded Check for this variant: every subagent call ran on
# claude-haiku-5-5, and at least one did.
here=$(cd "$(dirname "$0")" && pwd)
exec sh "$here/model-check.sh"
