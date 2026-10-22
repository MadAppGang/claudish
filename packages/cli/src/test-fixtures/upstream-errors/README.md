# Upstream error bodies — verbatim fixtures

Real bodies captured by `appendUpstreamError` (`handlers/shared/response-capture.ts`)
into `upstream-errors.log`. Each file is the raw `body` field, byte-for-byte, so a
classifier is pinned against what the engine actually answered rather than against a
retyped approximation.

| File | Captured | Model | Occurrences |
|---|---|---|---|
| `vllm-image-cap-400.json` | 2026-10-12 → 2026-10-20 | `vllm-myia@swift-1.5-27b` (7), `frognano@frognano-4b` (2), `frognano@mini` (1) | 10 |

The 20/10 occurrences are the measured incident behind #575: the hub retried this
shape four times in 45 s on CoursIA-2's blocked-compaction session (4.4 MB body),
then sixteen minutes later the SAME session trimmed to 949 569 B got the real
`maximum context length` 400 — two different refusals, one session.