#!/bin/bash
# Extrait les resp natives d'un jour d'archive GDrive vers w-<jour>.
set -u
# Convention unifiée : les repertoires w-<jour> vivent A COTE des scripts (comme les
# scripts Python, qui derivent SP de leur propre chemin). Surchargeables par env.
SP="${CLAUDISH_AUDIT_DIR:-$(cd "$(dirname "$0")" && pwd)}"
SEVEN="${SEVENZIP:-C:/Program Files/7-Zip/7z.exe}"
ARCHIVE_DIR="${CLAUDISH_CAPTURES_ARCHIVE_DIR:-G:/Mon Drive/Backups-Cloud/claudish}"
for D in "$@"; do
  W="$SP/w-$D"
  ARCH="$ARCHIVE_DIR/captures-$D.7z"
  if [ ! -f "$ARCH" ]; then echo "$D : archive ABSENTE ($ARCH)"; continue; fi
  rm -rf "$W"; mkdir -p "$W"
  t0=$(date +%s)
  "$SEVEN" x "$ARCH" -o"$W" "-i!resp-*-native-*.sse" -y >/dev/null 2>&1
  t1=$(date +%s)
  n=$(ls "$W" 2>/dev/null | wc -l)
  echo "$D : extraits=$n  duree=$((t1-t0))s  taille=$(du -sm "$W" 2>/dev/null | cut -f1)MB"
done
