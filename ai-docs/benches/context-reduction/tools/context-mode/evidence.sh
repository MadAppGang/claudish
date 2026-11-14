#!/bin/sh
# Runs after the agent stopped. Prints what context-mode stored in its data
# folder, and copies that folder out when the run shares an output folder.
echo "variant=context-mode"
echo "node=$(node --version 2>&1)"
for d in "$HOME/.context-mode" "$HOME/.claude/context-mode"; do
  if [ -d "$d" ]; then
    echo "data=$d size=$(du -sk "$d" | cut -f1)KB files=$(find "$d" -type f | wc -l | tr -d ' ')"
    find "$d" -type f -maxdepth 3 | head -12
    if [ -d "$HOME/.bench-out" ]; then
      out="$HOME/.bench-out/context-mode-$(date +%Y%m%dT%H%M%S)"
      mkdir -p "$out" && cp -R "$d" "$out/" 2>/dev/null
      echo "copied=$out"
    fi
  else
    echo "data=$d absent"
  fi
done
exit 0
