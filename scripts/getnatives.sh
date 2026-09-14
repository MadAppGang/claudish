#!/bin/bash
# Extrait les resp natives d'un jour d'archive GDrive vers w-<jour>.
set -u
SP="C:/Users/MYIA/AppData/Local/Temp/claude/d--claudish/fe8a18f1-2f91-4169-877b-56eabe48f53d/scratchpad"
SEVEN="C:/Program Files/7-Zip/7z.exe"
for D in "$@"; do
  W="$SP/w-$D"
  ARCH="G:/Mon Drive/Backups-Cloud/claudish/captures-$D.7z"
  if [ ! -f "$ARCH" ]; then echo "$D : archive ABSENTE ($ARCH)"; continue; fi
  rm -rf "$W"; mkdir -p "$W"
  t0=$(date +%s)
  "$SEVEN" x "$ARCH" -o"$W" "-i!resp-*-native-*.sse" -y >/dev/null 2>&1
  t1=$(date +%s)
  n=$(ls "$W" 2>/dev/null | wc -l)
  echo "$D : extraits=$n  duree=$((t1-t0))s  taille=$(du -sm "$W" 2>/dev/null | cut -f1)MB"
done
