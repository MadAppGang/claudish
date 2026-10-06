> Why exit 0 proves nothing under `claude -p`, why `require_pattern` exists, and how a team slot's answer is now read from the transcript.
>
> Extracted from `CLAUDE.md` (v7.64.0). Indexed in [`README.md`](./README.md).

# The `team` success oracle — why exit 0 proves nothing

Team slots are no longer print-mode children: each is an interactive Claude Code in a headless
magmux pane, and its answer comes from the transcript ([`pane-session.md`](pane-session.md)). The
print-mode measurement below is kept because it is why `require_pattern` exists, and why the answer
is every assistant message of the turn rather than the last one.

`claude -p` in text output mode emits **ONLY the final assistant message**. Any turn the child takes AFTER writing its answer replaces that answer on the captured surface. Isolated proof, no claudish anywhere in the path:

```
$ echo "Say exactly ALPHA_MARKER on its own line. Then run the bash command: echo hi. Then say exactly OMEGA_MARKER on its own line." | claude -p --model haiku
OMEGA_MARKER          <- 13 bytes. ALPHA_MARKER is gone.
```

Under `--output-format stream-json --verbose` BOTH messages are present, and the `result` field equals the last message — i.e. exactly what text mode prints. **The data survives upstream; only the capture path discards it.** The trigger is any post-answer turn, most often a background `Task`/`Agent` completing, whose notification prompts an acknowledgement — and that acknowledgement becomes `response-NN.md`.

Measured on claudish's `team`, deterministic 2/2 on the first attempt:

| model | output tokens generated | bytes captured | exit | reported | `vote` blocks |
|---|---|---|---|---|---|
| `gc@glm-5.2` | 7,743 | 250 B | 0 | succeeded | 0 |
| `kc@k3` | 4,737 | 396 B | 0 | succeeded | 0 |

Both surviving texts referred to "the review and vote above" — a review that is not on disk. The originally reported incident (236 B from `glm-5.2`) is the same shape. **It is not model-specific and not a claudish bug**: a madbench eval reproduced it on `claude-haiku-4-5` through plain Claude Code, no claudish in the path, 3 consecutive runs. It is a property of the print-mode capture surface.

The classifier of the time could not see it because the epilogue passes every test it ran: exit code 0, no `[API Error: ...]` marker, non-whitespace output. `DEFAULT_MIN_OUTPUT_BYTES` is 0 (opt-in, off).

**A byte threshold is the wrong instrument, and this is the design point.** An earlier default of 200 produced a 2/2 false-positive rate against real short answers (measured 141 B and 96 B replies, both valid). Length is a guess. A caller that MANDATED an output shape, by contrast, knows what a complete answer looks like — so `require_pattern` is a precise oracle where length is not.

Detection, then:

- `FailureReason` has `shape_mismatch`; `classifyRunOutput` takes the caller's `requirePattern`.
- `startModels` validates the regex **BEFORE reading the manifest and before spawning anything** — a bad regex discovered later would either waste the whole run or, worse, silently enforce nothing.
- The MCP `team` tool exposes `require_pattern` and `min_output_bytes`. The reporter of the original bug had no way to opt in, which is why the option existing internally was not enough.

Two ordering decisions worth keeping:

1. **The shape check runs LAST**, after `api_error`, `prompt_not_read`, `refused`, the whitespace-only `empty_output` and `min_output_bytes`. A turn that hit one of those would fail the shape check too, and reporting "no `vote` block" for what is really an API error sends the caller after the wrong problem.
2. **The pattern is matched against the WHOLE answer**, never a bounded tail — a contract whose marker sits near the START of a long answer would otherwise silently never match. `new RegExp(pattern)`, no flags.

## The answer is every assistant message of the turn, from the transcript

Detection turned a silent wrong verdict into a loud failure, but the generated answer was still gone: the caller re-ran and paid again. v7.50.0 recovered it by switching team children to `--output-format stream-json` and concatenating every assistant text block. The pane driver keeps that rule and drops the stream: a slot's answer is **every assistant text block of the turn, in order, joined with a blank line, read from Claude Code's own transcript** — scoped to the turn by the offset claudish recorded before delivering the prompt, and excluding API-error entries. A post-answer turn (a background agent's notification, a Stop-hook re-wake) is part of the same turn and costs nothing.

**Concatenate-everything was chosen over "keep the last substantial message"** because "substantial" is a byte threshold, and `DEFAULT_MIN_OUTPUT_BYTES` is 0 precisely because a 200-byte default recorded two correct short answers (141 B, 96 B) as EMPTY. Intermediate "let me read that file" chatter would land in the response file; that cost is visible and bounded, whereas a wrong "substantial" verdict discards the answer again silently.

One piece of chatter is now cut deliberately, because it is not about the task: when the prompt is delivered as a task file (anything but one plain line), the answer starts AFTER the Read result that returned the last unread line of that file. Narration before the task was read never reaches `response-<slot>.md` or `require_pattern`; its size is reported as `preambleBytes`. A slot whose task file was not fully read is FAILED `prompt_not_read` instead of being judged on an answer to a task it never saw.

`response-<slot>.md` stays prose, written once, byte-exact, so the judge phase and every downstream reader are unaffected. `shape_mismatch` therefore means one thing: every assistant message of the turn was read, and the model did not produce the shape. The old "your answer was discarded" explanation, the `captureMode: "print"` escape hatch and `CLAUDISH_TEAM_CAPTURE` were removed with print mode.

`max_tokens` is no longer an ending a slot sees as such: Claude Code 2.1.290 auto-continues a `max_tokens` stop on its own and finally writes a synthetic `max_output_tokens` API error, which is FAILED `api_error`. A COMPLETED turn whose recorded `stop_reason` is `max_tokens` carries the note "the answer may be truncated" in its anomalies.

The CLI shares all of this: `claudish team …` and `--team --mode json` call `runModels`, the same code the MCP tool runs. CLI `--grid` is the exception; it still runs print-mode children in a visible magmux for a human to watch.
