# Replay pane: what stops a turn, measured

Measured 2026-11-05 on Claude Code 2.1.318, magmux 0.18.1, for the read-only replay of a finished
session (`claude --resume <id> --fork-session --bare`).

Method: a PTY (`Bun.spawn` `terminal`), a throwaway `CLAUDE_CONFIG_DIR` and `HOME`, a two-record
transcript, a typed prompt (`hello please answer`, then `\r`), and a local mock server that answers
401 and counts every request. A real API is never contacted. "Requests" is the mock's count; above
zero means Claude Code started a turn against the configured endpoint. "Approved" means the mock
key's last 20 characters are in `customApiKeyResponses.approved`, the state of a real user who once
accepted their key: without it the key raises Claude Code's "Detected a custom API key" dialog, which
hides the screen and proves nothing.

## A clean process environment does not stop a turn

| Case | Process env | `settings.json` | Extra flags | Requests | Typed prompt answers |
|---|---|---|---|---|---|
| A | clean | none | none | 0 | `Not logged in` |
| B (positive control) | key + base URL, approved | none | none | **4** | the mock's 401 |
| C | clean | `env`: key + base URL, approved | none | **4** | the mock's 401 |
| C2 | clean | `env`: auth token + base URL | none | **4** | the mock's 401 |
| D | clean | `apiKeyHelper` + `env` base URL | none | 0 | `Not logged in` |
| Q (positive control) | clean | `env`: `CLAUDE_CODE_USE_BEDROCK=1`, Bedrock base URL, skip auth | none | **8** | the mock's 401 |
| E | clean | as C | `--setting-sources ""` | 0 | `Not logged in` |
| E2 | clean | as C2 | `--setting-sources ""` | 0 | `Not logged in` |
| F | clean | as D | `--setting-sources ""` | 0 | `Not logged in` |
| P | clean | as C plus the Bedrock keys | `--setting-sources ""` | 0 | `Not logged in` |
| J, J2 | clean | as C, C2, plus `statusLine` | `--settings` blanking the named keys | 0 | `Not logged in` |

Claude Code reads the `env` block of its settings after it starts, so a credential or a provider
switch in `~/.claude/settings.json` reaches the process whatever the parent removed. C, C2 and Q are
real turns from a process with a clean environment. `--bare` does not stop them: it stops only the
login, the Keychain and an `apiKeyHelper` that is not in `--settings` (case D).

J works only for the keys it names. A provider switch added by a later Claude Code would pass through
it with no error. `--setting-sources ""` closes every settings file at once (E, E2, F, P).

## The status line survives through `--settings`

| Case | `settings.json` | Flags | Status line drawn | Requests |
|---|---|---|---|---|
| H | `statusLine` | `--setting-sources ""` | no | 0 |
| I | `statusLine` | none | yes | 0 |
| M | `statusLine` + `env` key + base URL, approved | `--setting-sources "" --settings '{"statusLine":…}'` | yes | 0 |

M keeps the full interface and starts no turn: `--settings` is read even when no setting source is.

## A fork's record is at a path claudish can name

| Case | Flags | New record |
|---|---|---|
| A | none | a random id, written after the typed prompt |
| G | `--session-id <uuid>` | exactly `<project>/<uuid>.jsonl`, after the typed prompt |

A fork that receives no prompt writes nothing. With a minted id a stray record is removed by exact
path, and no directory listing or "newest file" guess is needed.

## An untrusted folder shows the trust dialog

| Case | Folder | Flags | Result |
|---|---|---|---|
| L | not in `.claude.json` `projects` | none | `Quick safety check: Is this a project you created or one you trust?`; the transcript is not drawn |
| L2 | not in `.claude.json` `projects` | `--setting-sources ""` | the same dialog |

A new scratch folder is untrusted by definition, so a neutral scratch folder cannot be the fallback
for a removed session folder unless an ancestor is trusted. The earlier "a resume from a different
folder draws it" measurement was on an account whose parent folder is trusted. claudish accepts no
dialog on a user's behalf (`pane-session.md`), so the fallback is a folder the host already trusts: the
MCP server's own working directory, where the host Claude Code runs.

## The replay pane through magmux

Claude Code 2.1.318, magmux 0.18.1, a throwaway `HOME` and `CLAUDE_CONFIG_DIR`, a 120-record
transcript, 120 × 40, nothing typed. The launcher, shim, argv and allowlisted environment of the
replay pane, driven through the real `MagmuxClient`, `applyFrame` and `inspectBox`.

| Fact | With `CLAUDE_CODE_NATIVE_CURSOR=1` | Without |
|---|---|---|
| `inspectBox` reads `box` | yes | yes, first applied frame, 304 ms after spawn |
| the end of the conversation is drawn (`ANSWER-59`) | yes | yes |
| leader's argv has `--session-id <fork>`, and it leads its group | yes, yes | yes, yes |
| `list` `input` | null (ungated) | null |
| wheel `send` with `noGate` confirmed, screen moved | yes, yes | yes, yes |
| `resize` `changed:true`, screen 100 × 30, box still located | yes | yes |
| `capabilities.verbs` has `resize` | yes | yes |
| status line drawn through `--settings`, `SHELL=/bin/zsh` | yes | yes |
| fork record written, no prompt | no | no |
| magmux stderr | empty | empty |

## Reproduce

The measuring scripts were session scratch. The shape of the first set is above: one PTY per case,
the mock on a local port, the base URL and key in the case's process env or settings file, 5 s to
draw, the typed prompt, 7 s, then the mock's count and the project directory listing.

The magmux table needs no mock and no prompt. Write a transcript of 60 user and assistant record
pairs under a throwaway `CLAUDE_CONFIG_DIR/projects/<slug>/<uuid>.jsonl`, with the folder trusted in
its `.claude.json`. Spawn magmux headless on a socket of its own with the replay pane's launcher,
with and without `CLAUDE_CODE_NATIVE_CURSOR=1`. Feed `MagmuxClient`'s `watch` frames through
`applyFrame`, and read `inspectBox` on each. Then send one wheel `send` with `noGate`, one `resize` to
100 × 30, `list` and `ps` for the argv and group, and list the project directory.
