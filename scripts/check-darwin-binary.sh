#!/usr/bin/env bash
# Checks a darwin claudish binary cross-compiled on Linux, without running it.
#
#   scripts/check-darwin-binary.sh <binary> <arm64|x64|amd64>
#
# A Linux host cannot run a darwin binary, so this checks what the build can get
# wrong: the Mach-O architecture, and that the binary embeds the OpenTUI native
# library of ITS target. A plain `bun install` on Linux installs only the host's
# @opentui/core-linux-* package, and `bun build --target=bun-darwin-*` then fails
# with `Could not resolve: "@opentui/core-darwin-arm64/index.ts"`; the build
# needs `bun install --os='*' --cpu='*'`.
#
# No codesign step: Bun ad-hoc signs a darwin binary it builds on Linux
# (`codesign -dv` on a Mac: flags=0x20002(adhoc,linker-signed)), and
# `codesign -v` passes on an arm64 Mac.
set -euo pipefail

BIN="${1:?usage: check-darwin-binary.sh <binary> <arm64|x64|amd64>}"
ARCH="${2:?usage: check-darwin-binary.sh <binary> <arm64|x64|amd64>}"

case "$ARCH" in
  arm64) MACHO=arm64; OPENTUI=arm64 ;;
  x64 | amd64) MACHO=x86_64; OPENTUI=x64 ;;
  *) echo "unknown arch: $ARCH"; exit 1 ;;
esac

ls -la "$BIN"
DESCRIPTION=$(file "$BIN")
echo "$DESCRIPTION"
# Linux's file(1) prints "Mach-O 64-bit arm64 executable, flags:<…>", macOS's
# prints "Mach-O 64-bit executable arm64"; both orders are the same answer.
if ! grep -E -q "Mach-O 64-bit (${MACHO} executable|executable ${MACHO})" <<<"$DESCRIPTION"; then
  echo "$BIN is not a Mach-O 64-bit ${MACHO} executable"
  exit 1
fi

if ! LC_ALL=C grep -a -q "core-darwin-${OPENTUI}/libopentui.dylib" "$BIN"; then
  echo "$BIN does not embed core-darwin-${OPENTUI}/libopentui.dylib"
  exit 1
fi
echo "$BIN embeds core-darwin-${OPENTUI}/libopentui.dylib"
