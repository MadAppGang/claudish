#!/bin/sh
# Fetches the context-mode plugin at its pinned release tag into vendor/, which
# is gitignored. Run it once before the context-mode variant.
#
#   fetch-context-mode.sh
#
# Only the parts the plugin staging reads are kept: the marketplace file that
# gives the plugin its identity, the prebuilt Claude Code plugin, the licence.
set -eu

tag=v2.1.10
here=$(cd "$(dirname "$0")" && pwd)
dest="$here/vendor/context-mode"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

git clone --quiet --depth 1 --branch "$tag" \
  https://github.com/mksglu/context-mode "$tmp/src"

rm -rf "$dest"
mkdir -p "$dest"
cp -R "$tmp/src/.claude-plugin" "$tmp/src/plugins" "$tmp/src/LICENSE" "$dest/"
echo "context-mode $tag staged at $dest"
