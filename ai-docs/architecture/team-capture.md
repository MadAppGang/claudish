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
- A slot whose answer misses the pattern ends in its own terminal state, `SHAPE_MISMATCH` (reason `shape_mismatch`), not `EMPTY`. The slot DID answer, and its answer is kept in `response-<slot>.md` so the caller can read the near miss; `EMPTY` stays for a turn with no usable answer (whitespace only, below `min_output_bytes`, refused). It is terminal everywhere a slot state is checked (`TERMINAL_STATES`, `TERMINAL_PHASES`, the herdr state sets), counts as failed in `summarise` and the run outcome, and a run whose only slot is `SHAPE_MISMATCH` settles.
- `startModels` validates the regex **BEFORE reading the manifest and before spawning anything** — a bad regex discovered later would either waste the whole run or, worse, silently enforce nothing.
- The MCP `team` tool exposes `require_pattern` and `min_output_bytes`. The reporter of the original bug had no way to opt in, which is why the option existing internally was not enough.

Two ordering decisions worth keeping:

1. **The shape check runs LAST**, after `api_error`, `prompt_not_read`, `refused`, the whitespace-only `empty_output` and `min_output_bytes`. A turn that hit one of those would fail the shape check too, and reporting "no `vote` block" for what is really an API error sends the caller after the wrong problem.

   An `api_error` is also a turn whose LAST API response (its transcript records grouped by `message.id`) ENDS in a text block whose trimmed text is exactly claudish's in-band marker, whatever progress text the turn wrote before it, in that response or earlier ones, and whatever its read coverage says. The proxy appends the marker as its own text block after prose that already streamed (`endWithText` in `claude-sse-sink.ts`), so a final response of [prose, marker] is an error, once the proxy has recorded it (below). When the last response is known it ALONE decides: a marker followed by another block of that response (a `tool_use`) did not end the turn, and a single final block of prose that ends in a marker is the model's text, read coverage or not. Measured: a slot narrated its work, then the vendor refused with `cyber_policy`; the final response was thinking blocks plus that one marker block, `end_turn`, no `isApiErrorMessage`, and the whole-answer rule below missed it, so the slot read `shape_mismatch` and the caller was told to re-prompt. A `cyber_policy` marker's detail names the vendor's content policy and gives no shape advice. A marker quoted inside a longer final text block is still the model's text.

   **The text alone never proves the marker is claudish's.** Every in-band marker is written in one place: `responses-turn.ts` (the `api-error` outcome) calls `onApiError` and then `sink.endWithText(formatInBandApiError(code, message))`, so the marker is always its own text block at the end of a response (the same call writes the `[Stream error: …]` text, which is no marker). The format is `\n\n[API Error: <code> <message>]` with upstream text in `<message>`, which may hold `]` and newlines, so no pattern can tell the writer from a model whose final block quotes one: `[API Error: overloaded] is what you see; retry later [see docs]` matches the greedy `^\[API Error: (\S+)([\s\S]*)\]$`. The proof comes from the proxy: `ComposedHandler`'s `onApiError` calls `TokenTracker.recordInBandApiError(code)`, which writes `in_band_api_error: {code, at}` (the code's key and the ISO time; never the message) into the slot's token file (`stats/<slot>.json`, `CLAUDISH_TOKEN_FILE`) through the tracker's one writer, keeping every token field. The key is `inBandErrorCodeKey`: the code's first whitespace-free word, or `malformed` when that word is not an identifier; the reader keys the marker's parsed code through the same function, because the marker is `<code> <message>` and a parser reads back only the first word. The writer replaces the file by a temp file and a rename (`writeFileAtomic`), so a settle read never lands on a truncated file and loses the record; the record is per file, so a `/model` switch to another handler keeps it. A last-response marker is `api_error` only when that record has the marker's code and `at` is at or after the turn's start (`SettledTurn.acceptedAt`, the witness record's time). `teamDecide` reads the record from the slot's token file and passes it in; the classifier reads no file. Without the record, with another code, or with a record older than the turn, the block is the model's text and the answer checks decide. A one-shot `create_session` has its own token file (`tokens.json` in the session folder) and applies the same proof (`oneShotVerdictOf`). The joined-answer rule below (no last-response data) is unchanged.

   With no last-response data (a screen-mode turn), an `api_error` is also an answer that is exactly claudish's in-band marker `[API Error: <code> <message>]` (`in-band-api-error.ts`). The Responses parser writes a terminal in-stream error as that text, ending `end_turn`, so Claude Code never flags it `isApiErrorMessage`. Without this rule a billing failure (`credit_balance_exhausted`, recommended-effort bench run12) fell through to `prompt_not_read`. The marker counts as the WHOLE answer, or as the answer's END after a blank line when the task file was never read (a preamble such as "I'll read the file." then the error); inside a longer answer of a turn that read its task it is the model's text. A context overflow uses the same marker: its actionable text (`Context limit reached. … Run /clear …`) is the marker's message, so an overflowed slot reads as `api_error` too (MTL-237).
2. **The pattern is matched against the WHOLE answer**, never a bounded tail — a contract whose marker sits near the START of a long answer would otherwise silently never match. `new RegExp(pattern)`, no flags.

## The answer is every assistant message of the turn, from the transcript

Detection turned a silent wrong verdict into a loud failure, but the generated answer was still gone: the caller re-ran and paid again. v7.50.0 recovered it by switching team children to `--output-format stream-json` and concatenating every assistant text block. The pane driver keeps that rule and drops the stream: a slot's answer is **every assistant text block of the turn, in order, joined with a blank line, read from Claude Code's own transcript** — scoped to the turn by the offset claudish recorded before delivering the prompt, and excluding API-error entries. A post-answer turn (a background agent's notification, a Stop-hook re-wake) is part of the same turn and costs nothing.

**Concatenate-everything was chosen over "keep the last substantial message"** because "substantial" is a byte threshold, and `DEFAULT_MIN_OUTPUT_BYTES` is 0 precisely because a 200-byte default recorded two correct short answers (141 B, 96 B) as EMPTY. Intermediate "let me read that file" chatter would land in the response file; that cost is visible and bounded, whereas a wrong "substantial" verdict discards the answer again silently.

One piece of chatter is now cut deliberately, because it is not about the task: when the prompt is delivered as a task file (anything but one plain line), the answer starts AFTER the Read result that returned the last unread line of that file. Narration before the task was read never reaches `response-<slot>.md` or `require_pattern`; its size is reported as `preambleBytes`. A slot whose task file was not fully read is FAILED `prompt_not_read` instead of being judged on an answer to a task it never saw.

**The Text view reads the same transcript and keeps everything** (`team(mode:"transcript")`, MTL-373). The answer above is one turn's assistant text, cut after the task file was read, because a judge must see the answer and nothing else. The status mod's Text view wants the opposite: the whole conversation, every turn, as a human watched it. So `transcript` renders every kind (the task-file pointer as `user`, the task file's content as `task_file`, each tool call as one `tool` line, notices and errors) from the same JSONL, and nothing in it feeds `response-<slot>.md`, `require_pattern` or the verdict. The two readers share the file, not a rule.

`response-<slot>.md` stays prose, written once, byte-exact, so the judge phase and every downstream reader are unaffected. `shape_mismatch` therefore means one thing: every assistant message of the turn was read, every file the turn wrote with `Write` after the task was read was read too (below), and neither had the shape. The old "your answer was discarded" explanation, the `captureMode: "print"` escape hatch and `CLAUDISH_TEAM_CAPTURE` were removed with print mode.

## A file the slot wrote can be the answer (MTL-229)

A slot told to "write the deliverable to answer.md" does exactly that: the 52,828-char answer went into one `Write` tool_use, and the reply was 2.9 KB of narration about it. The verdict read only assistant text, so the slot was `shape_mismatch` (then reported EMPTY), with a detail claiming "nothing was lost". The text was on disk; the verdict never looked there.

The transcript follower now records every `Write` of the turn, and the verdict falls back to those files. The decisions:

- **`Write` only, never `Edit`/`MultiEdit`/`NotebookEdit`.** An edit changes a file that predates the task, usually source code; a pattern match on it proves nothing (`require_pattern "vote"` against a source file that contains "vote"). An edit to a file the turn DID write still counts, because the file is read from disk.
- **The same post-Read cut as the reply.** A file written before the task was read cannot answer it, exactly as narration before the Read is cut. A `Write` whose `tool_result` is an error, or has not arrived, is not listed: a failed overwrite leaves the old content.
- **Read from disk at verdict time**, not from the tool_use input: a later edit is the truth, and a removed file drops out (`missing`).
- **Contained in `realpath(cwd)`** (`TeamRunOptions.cwd`, default `process.cwd()`: the same value the child starts in and its transcript path is derived from, so a test that sets it moves the child, its files and its transcript together). The content goes into `response-<slot>.md` and to the judges, so a `Write` through a symlink or outside the run's tree must not pull other disk content into the run's output. A relative path resolves against the root.
- **At most 1 MiB, and no NUL byte** (binary). The incident's file was 53,905 B.
- **Only when the caller set `require_pattern`**, and only when the reply failed an answer check (`shape_mismatch`, `empty_output`); with a pattern set, `min_output_bytes` still applies to the file as an extra floor. `min_output_bytes` alone is not enough: size is a guess, the same reason `DEFAULT_MIN_OUTPUT_BYTES` is 0 and edits are excluded, so a `min_output_bytes`-only slot that writes a large source module must not become a vote. Without a pattern the reply's verdict stands (a whitespace-only reply stays EMPTY), and its detail names the files unread.
- **Never over `api_error`, `prompt_not_read` or `refused`.** They return before the answer checks, so a written file cannot reach them.
- **The first file that passes, in write order, is the answer.** `response-<slot>.md` holds that file's content only, byte-exact; the narration failed the contract and would only confuse the judges, and it stays in the transcript. The row's `answerSource` is `file:<path>` (`reply` otherwise), and the COMPLETED row's `anomalies` carry "answer was written to <path>, not to the reply".
- **With hooks, the chain's files count**, head first, as the chain's text does: a head turn that wrote the file and a hook-caused turn that replied is one answer.

When nothing matches, the detail says what was checked: "No reply text or written file matched /p/: the reply (N B …) does not match, and the turn wrote no file" — or each file with `(no match)` or `(skipped: <reason>)`.

`max_tokens` is no longer an ending a slot sees as such: Claude Code 2.1.290 auto-continues a `max_tokens` stop on its own and finally writes a synthetic `max_output_tokens` API error, which is FAILED `api_error`. A COMPLETED turn whose recorded `stop_reason` is `max_tokens` carries the note "the answer may be truncated" in its anomalies.

The CLI shares all of this: `claudish team …` and `--team --mode json` call `runModels`, the same code the MCP tool runs. CLI `--grid` is the exception; it still runs print-mode children in a visible magmux for a human to watch.
