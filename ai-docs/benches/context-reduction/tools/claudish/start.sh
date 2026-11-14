#!/bin/sh
# Shared by the claudish variants. Copies the variant's claudish config into
# the run's ~/.claudish: claudish reads hooks and harnessGateway from the
# global config only, and resolves a hook module path against its folder.
set -eu
src=${1:?usage: start.sh <variant folder>}
mkdir -p "$HOME/.claudish"
cp "$src/config.json" "$HOME/.claudish/config.json"
for f in "$src"/*.ts; do
  if [ -f "$f" ]; then cp "$f" "$HOME/.claudish/"; fi
done
echo "start: claudish config from $(basename "$src")"
