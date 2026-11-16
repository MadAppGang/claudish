#!/bin/sh
# Shared by the claudish variants. Copies the variant's claudish config into
# the run's ~/.claudish: claudish reads hooks and harnessGateway from the
# global config only, and resolves a hook module path against its folder.
set -eu
src=${1:?usage: start.sh <variant folder>}
mkdir -p "$HOME/.claudish"
cp "$src/config.json" "$HOME/.claudish/config.json"
# claudish's always-on log goes to the shared output folder from the start, so
# a Session that errors, whose sandbox is deleted, keeps it.
if [ -d "$HOME/.bench-out" ]; then
  live="$HOME/.bench-out/claudish-live-$(date +%Y%m%dT%H%M%S)"
  mkdir -p "$live"
  ln -sfn "$live" "$HOME/.claudish/logs"
  echo "start: claudish logs in $live"
fi
for f in "$src"/*.ts; do
  if [ -f "$f" ]; then cp "$f" "$HOME/.claudish/"; fi
done
echo "start: claudish config from $(basename "$src")"
