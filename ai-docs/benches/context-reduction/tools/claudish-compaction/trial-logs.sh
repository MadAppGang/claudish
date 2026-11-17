#!/bin/sh
# Prints the claudish debug logs of one trial, one path per line, for the
# trial's launch folder given as the argument.
#
# madbench starts the launcher more than once per trial: first for
# `claude plugin ...`, then for the session. The launches share the trial's
# work folder, and only the first one makes its ./logs link, so the session's
# log claudish_*_<session pid>.log is in the FIRST launch folder's debug/, not
# in the session's own. This finds the launch folder, among those with the
# same "launch: cwd" (the same trial; the parent folder is shared by every
# trial), whose debug/ holds the session pid's log, and prints every
# claudish_*.log there. With no such folder it prints the given folder's own
# debug logs, as before.
#
#   sh trial-logs.sh <launch folder>
launch=$1
[ -n "$launch" ] || exit 0
pid=${launch##*-}
cwd_of() { grep -m1 '^launch: cwd ' "$1/launch.log" 2>/dev/null | cut -d' ' -f3- | sed 's|^/private/|/|'; }
cwd=$(cwd_of "$launch")
if [ -n "$cwd" ]; then
  for d in "$(dirname "$launch")"/*launch-*; do
    [ -d "$d/debug" ] || continue
    [ "$(cwd_of "$d")" = "$cwd" ] || continue
    if ls "$d"/debug/claudish_*_"$pid".log >/dev/null 2>&1; then
      ls "$d"/debug/claudish_*.log
      exit 0
    fi
  done
fi
ls "$launch"/debug/claudish_*.log 2>/dev/null
exit 0
