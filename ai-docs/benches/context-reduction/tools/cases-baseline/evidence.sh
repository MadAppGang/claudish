#!/bin/sh
# The same record as claudish-compaction's evidence, so both arms of cases/
# print the same fields; on this arm every compaction count is 0.
here=$(cd "$(dirname "$0")" && pwd)
sh "$here/../claudish-compaction/evidence.sh" | sed 's/^variant=claudish-compaction$/variant=cases-baseline/'
