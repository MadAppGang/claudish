#!/bin/sh
# long-session-xl: case d's preparation (long-session.sh, unchanged), plus a
# `bun` shim that refuses a whole-suite `bun test`.
#
# A bare `bun test` in packages/cli runs all 659 test files, which in the
# sandbox takes about 2 h; Haiku 5.5 waited for it in the background twice,
# past the Scenario timeout, while Sonnet 5.5 took the Bash tool's 10-minute
# cut-off and moved on. The shim makes that run impossible for every model and
# variant: it answers at once, names the reason, and exits 2. Every other bun
# command, and `bun test` with paths, goes to the real bun.
#
# Claude Code runs the file named by CLAUDE_ENV_FILE ahead of each Bash
# command, after the shell's own startup files, so the shim's directory comes
# first on PATH for the agent and its subagents. The launchers export
# CLAUDE_ENV_FILE from launch-env. Checks and grading do not use that file.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
sh "$here/long-session.sh"

shim="$HOME/.bench-shim"
real=$(command -v bun)
mkdir -p "$shim/bin"
sed "s|@REAL_BUN@|$real|" "$here/bun-shim.sh" >"$shim/bin/bun"
chmod +x "$shim/bin/bun"
# printf, not a here-document: the sandbox refuses the temp file a
# here-document needs ("cannot create temp file for here document").
printf '%s\n' \
  "export PATH=\"$shim/bin:\$PATH\"" \
  "if [ ! -f \"$shim/active\" ]; then" \
  "  : >\"$shim/active\"" \
  "  d=\$(cat \"$HOME/.bench-compaction/launch-dir\" 2>/dev/null) && [ -n \"\$d\" ] &&" \
  "    echo \"bun-shim: active, bun resolves to \$(command -v bun)\" >>\"\$d/launch.log\"" \
  "fi" >"$shim/env.sh"
echo "CLAUDE_ENV_FILE=$shim/env.sh" >>"$HOME/.bench-compaction/launch-env"
echo "prep: long-session-xl: bun shim in $shim/bin (real bun $real), CLAUDE_ENV_FILE=$shim/env.sh"
