#!/bin/sh
# Passes only when subagent calls ran on claude-haiku-5-5 and no subagent call
# ran on any other Haiku model. Reads Claude Code's own transcripts: each
# assistant line of a subagent carries "isSidechain":true and the model that
# answered it.
d="${1:-$HOME/.claude/projects}"
lines=$(grep -rh --include='*.jsonl' '"isSidechain":true' "$d" 2>/dev/null | grep '"type":"assistant"')
models=$(printf '%s\n' "$lines" | grep -oE '"model":"claude-haiku[^"]*"' | sort | uniq -c)
echo "subagent Haiku calls by model:"
echo "${models:-  none}"
pinned=$(printf '%s\n' "$lines" | grep -c '"model":"claude-haiku-5-5"')
other=$(printf '%s\n' "$lines" | grep -oE '"model":"claude-haiku[^"]*"' | grep -vc '^"model":"claude-haiku-5-5"$')
echo "pinned=$pinned other=$other"
[ "$pinned" -gt 0 ] && [ "$other" -eq 0 ]
