# Devin roster fixture

`GetCliModelConfigs.res.bin` — a **real, unmodified** `GetCliModelConfigs` response body captured
from `server.codeium.com` on 2026-08-06 against the developer's own Devin subscription. Bare
protobuf (unary rpcs are not Connect-enveloped), 173 model configs, 170 of which have a non-zero
context window.

It is the fixture for `providers/model-resolvers/devin.ts`, whose entire job is to fold this roster
into the rows a human picks and unfold a selection back into a wire id. Both directions are only
meaningful against a real roster: the resolver's rules exist because of properties this file has
and a hand-written fixture would not —

- 97 uids are natively 1M with no `-1m` suffix, while only 7 carry one
- 32 uids carry a `-priority` speed premium at ~2x cost
- exactly 3 of 39 families expose more than one context window
- 20 of 39 groups declare `is_default_model_in_family`, and none declares two
- 4 families carry a time-boxed promo, 2 of which expired within days of capture

Tests must READ this file. Restating any of it as literals in a test would reintroduce exactly the
staleness the live-discovery design removes, and would stop catching the case the resolver exists
for: a roster shape nobody anticipated.

Contains no credentials — the request metadata carrying the api key is not part of a response body.
