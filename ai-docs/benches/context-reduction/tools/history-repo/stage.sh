#!/bin/sh
# Makes the small repository of the compaction-history Scenario in the
# current folder: five top-level files of clearly different sizes, six
# commits, then one changed and one untracked file, so `git status --short`
# has something to show. The content is generated, so the sizes do not
# depend on line endings or an editor.
set -eu

g() { git -c user.name=bench -c user.email=bench@example.invalid -c commit.gpgsign=false "$@"; }

git init -q -b main .

# printf, not a here-document: the sandbox refuses the temporary file a
# here-document needs.
printf '%s\n' \
  '{' \
  '  "name": "tally-sheet",' \
  '  "version": "0.3.0",' \
  '  "private": true,' \
  '  "type": "module",' \
  '  "scripts": {' \
  '    "start": "bun src/index.ts",' \
  '    "test": "bun test",' \
  '    "lint": "biome check src",' \
  '    "build": "bun build src/index.ts --outdir dist"' \
  '  }' \
  '}' >package.json
mkdir -p src
printf '%s\n' \
  'import { total } from "./total.ts";' \
  '' \
  'console.log(total([3, 4, 5]));' >src/index.ts
printf '%s\n' \
  'export function total(values: number[]): number {' \
  '  return values.reduce((sum, v) => sum + v, 0);' \
  '}' >src/total.ts
g add package.json src
g commit -q -m "feat: add the total command"

i=1
{
  echo "# tally-sheet"
  echo
  while [ $i -le 70 ]; do
    echo "Line $i of the guide: tally-sheet adds the numbers it is given and prints the sum."
    i=$((i + 1))
  done
} >README.md
g add README.md
g commit -q -m "docs: add the README"

i=1
{
  echo "# Changelog"
  echo
  while [ $i -le 160 ]; do
    echo "- 0.0.$i: changed the way tally-sheet reads its input, entry number $i."
    i=$((i + 1))
  done
} >CHANGELOG.md
g add CHANGELOG.md
g commit -q -m "docs: add the changelog"

i=1
{
  while [ $i -le 15 ]; do
    echo "Permission is given to use this file, copy $i."
    i=$((i + 1))
  done
} >LICENSE
g add LICENSE
g commit -q -m "chore: add the licence"

i=1
{
  while [ $i -le 30 ]; do
    echo "note $i: check the input before the sum."
    i=$((i + 1))
  done
} >NOTES.md
g add NOTES.md
g commit -q -m "docs: add working notes"

sed -i.bak 's/0.3.0/0.3.1/' package.json
rm -f package.json.bak
g add package.json
g commit -q -m "chore: bump version to 0.3.1"

echo "note 31: the build writes to dist." >>NOTES.md
echo "draft" >TODO.txt

echo "stage: $(git rev-list --count HEAD) commits"
ls -l | awk 'NR > 1 { print "stage: " $5 " " $9 }'
