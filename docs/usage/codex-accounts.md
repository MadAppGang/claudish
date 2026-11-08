# Several Codex subscriptions

**Use more than one ChatGPT subscription with `cx@` models, and see how much allowance you have left.**

claudish can hold several Codex (ChatGPT Plus/Pro/Team) accounts and switch between them. When one account's
usage window is nearly spent it moves to the next; when an account is refused for quota it marks it until its
reset and retries the request once on another account. It also keeps a local record of usage so it can show where
your allowance is going and warn you before it runs out.

Your existing `claudish login codex` keeps working unchanged. Nothing here happens until you add a second account.

---

## Add an account

```bash
claudish account add codex
```

This opens a browser. Sign in with the ChatGPT account you want to add. claudish names the account after the
email of that login and never asks you for a name. If another account already has that email, the name becomes
`<email>-<plan>` (for example `jack@example.com-plus`), then `<email>-<plan>-2`, `-3` and so on. The first time
you add one, your existing login is kept as the account `default`.

To choose the name yourself, pass `--label`:

```bash
claudish account add codex --label work
```

A label holds letters, digits, `_`, `@`, `+`, `.`, `-` and spaces, starts with a letter, digit or `_`, and has at
most 64 characters.

Add only accounts you own. Vendor terms may restrict switching between subscriptions.

## See your accounts

```bash
claudish account status
```

```
codex
  ○ default         7d 41%
  ● jack@example.com  team  5h 3% · 7d 1%  active
  switch at 90%
  strategy: sticky
```

Each account shows the usage of its windows (the 5-hour and weekly limits the vendor reports) and when it was last
seen. `●` is the account in use.

## How claudish picks an account

By default (`strategy: sticky`) it stays on the account in use while every window is under 90 %, then moves to the
first account under that threshold in the order you added them, and only if all are over it takes the least used.
Usage is read from every response, so it never spends allowance just to measure it.

A request that hits a quota error switches once to the next account. If every account is spent, you get an error
listing when each one resets.

`ebr` and `lookahead` are experimental strategies that try to spend first the allowance that is about to reset.
They are opt-in and do not yet beat `sticky` in simulation, so `sticky` stays the default. To try one, set
`"strategy": "lookahead"` under `subscriptionAccounts.openai-codex` in `~/.claudish/config.json`.

## Forecast and warnings

```bash
claudish account forecast
```

```
Codex allowance · 2 accounts · sticky
No projected gap.
[weekly graph: history, forecast band, resets, any projected block]
Sessions this window
  1  5292dca2   28 %  17.2k / 7   cx@gpt-6-astra  jack@example.com
  -  unattributed 17 %            (Codex CLI / ChatGPT app)
```

- The graph shows your remaining allowance over the coming week, with a likely range.
- The session list ranks Claude Code sessions by their share of the current window. "unattributed" is usage
  claudish did not route, such as the Codex CLI or the ChatGPT app.
- If your current pace would leave every account spent for a long stretch, a warning says when and what to do,
  for example "cut to 60 % of current rate until Sat 09:00, or pause 14 h". Headless runs print it on stderr once,
  and the status line can show it.

`--json` prints the same data (`claudish.allowance.v1`) for scripts. The MCP tool `allowance_status` returns it to
agents.

Forecasts start rough and improve as history builds up: with no history they use only the current window.

## Change or remove accounts

```bash
claudish account login codex jack@example.com    # sign in again
claudish account disable codex jack@example.com   # stop using it, keep it configured
claudish account enable codex jack@example.com
claudish account remove codex jack@example.com
claudish account rename codex jack@example.com work   # change only the name
```

Every command takes the label or the login's email. An exact label wins. Otherwise the email must match exactly one
account; if two accounts share it, the command fails and lists each label with its id, and you pass `--id <id>` to
pick one. Each command prints the label and id it resolved, so you can see which account it changed.

`rename` changes the label and nothing else: the account keeps its place, its enabled state, its stored login and its
usage history. A new label must be unused (upper and lower case count as the same). You can also rename the original
login `default`.

Disabling your last account does not fall back to an `OPENAI_CODEX_API_KEY`; Codex requests fail visibly instead,
so a subscription user is never moved to per-token billing by accident. Removing the original login needs
`--delete-file`.

## Privacy

The usage record lives in `~/.claudish/accounts/usage/` (mode 0600), on your machine only. It holds numbers,
model names, account labels and Claude Code session ids — never prompt text or tokens. Because the default label is
your login's email, the email appears in this record, in claudish's logs, in `account list` and `account forecast`
output, and in error messages. It does not appear in telemetry. Pass `--label` to use a name without your email. Raw rows are kept 30 days,
hourly totals after that. Set `CLAUDISH_ALLOWANCE_LEDGER=off` to stop recording.
