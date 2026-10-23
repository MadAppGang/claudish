# MCP model-choice test data

`recommended-20261023.json` is the complete projected recommended cache read
from `~/.claudish/recommended-models-cache-v2.json` on 2026-10-23. Its generation
is `g-20261023083613563-57fd1690`; only JSON whitespace was changed on capture.
The source cache was read, never written.

The capture preserves real recommendation tiers, duplicate ids across tiers,
vendors, and release dates. Tests use it from this directory, not from the
developer's HOME, and copy it only into temporary isolated HOME directories.

The black-box tests reuse `../stage5-explain-route-catalog.json` for the
catalog's `gpt-5` entry and the existing captured MiniMax SSE response for the
optional post-check `run_prompt` path. No live model or credential is used.
