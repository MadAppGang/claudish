#!/bin/bash
# Extrait les req apparies aux resp natives DEJA presents dans w-<jour> (sans ecraser).
set -u
SP="C:/Users/MYIA/AppData/Local/Temp/claude/d--claudish/fe8a18f1-2f91-4169-877b-56eabe48f53d/scratchpad"
SEVEN="C:/Program Files/7-Zip/7z.exe"
for D in "$@"; do
  W="$SP/w-$D"
  ARCH="G:/Mon Drive/Backups-Cloud/claudish/captures-$D.7z"
  if [ ! -d "$W" ]; then echo "$D : w-$D ABSENT (natives non extraites)"; continue; fi
  if [ ! -f "$ARCH" ]; then echo "$D : archive ABSENTE"; continue; fi
  # motifs req depuis les resp natives presentes
  ls "$W" | grep '^resp-.*native' | sed -E 's/^resp-([0-9]+)-r([0-9]+)-.*/req-\1-\2-*.json/' | sort -u > "$W/inc.txt"
  nreq=$(ls "$W"/req-*.json 2>/dev/null | wc -l)
  if [ "$nreq" -gt 0 ]; then echo "$D : $nreq req deja extraits, skip"; continue; fi
  t0=$(date +%s)
  # -i@ exige un chemin RELATIF au cwd : absolu = 0 fichier extrait, en silence (mesuré 14/09)
  (cd "$SP" && "$SEVEN" x "$ARCH" -o"$W" "-i@w-$D/inc.txt" -y >/dev/null 2>&1)
  t1=$(date +%s)
  echo "$D : motifs=$(wc -l < "$W/inc.txt")  extraits=$(ls "$W"/req-*.json 2>/dev/null | wc -l)  duree=$((t1-t0))s"
done
df -h C: 2>/dev/null | tail -1
