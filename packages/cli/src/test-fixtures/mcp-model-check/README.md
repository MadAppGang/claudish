# MCP model-choice test data

`recommended-20261023.json` is the complete projected recommended cache read
from `~/.claudish/recommended-models-cache-v2.json` on 2026-10-23. Its generation
is `g-20261023083613563-57fd1690`; only JSON whitespace was changed on capture.
The source cache was read, never written.

`efforts-20261023.json` captures the newest generation of
`~/.claudish/cloud-models-catalog-v3.efforts.json` on 2026-10-23:
`g-20261023103553152-06aca043`, `writtenAt: 1792752143002`. It retains the
real sidecar's `contractVersion: 3`, `format: 2`, and generation structure,
with the three matching GPT ids as its only effort rows. Their task types, levels,
basis values, and complete `sendableOn` arrays are unchanged. Other generations
and model rows were omitted; only JSON whitespace was otherwise changed.
The source sidecar was read, never written.

The effort-answer case removes `gpt-6-astra` only from its temporary HOME's
copy to prove that a matching recommended id without an effort row is absent
from the effort JSON. The MiniMax case uses the captured sidecar unchanged:
it has effort rows, but none for the matching `minimax-m3` id.

The capture preserves real recommendation tiers, duplicate ids across tiers,
vendors, and release dates. Tests use it from this directory, not from the
developer's HOME, and copy it only into temporary isolated HOME directories.

The black-box tests reuse `../stage5-explain-route-catalog.json` for the
catalog's `gpt-5` entry and the existing captured MiniMax SSE response for the
optional post-check `run_prompt` path. No live model or credential is used.
