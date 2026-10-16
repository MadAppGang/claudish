# Muse Code

**Run Claude Code on Meta's Muse models with your Muse Code subscription.**

Added in the first claudish release after 10.6.1. Last updated 2026-10-16.

`muse@` signs requests with your Muse Code login and bills them to the subscription. `meta@` is
the separate, metered Meta Model API, signed by `META_API_KEY`.

---

## First run

```bash
claudish login muse
claudish --model muse@muse-spark-1.3 "explain what src/index.ts does"
```

`claudish login muse` prints a code and opens Meta's sign-in page:

```
Sign in to Meta for Muse Code (a Muse Code subscription is required).

  Code: KQWD-PLRT
  URL:  https://auth.meta.com/oauth/device/?code=KQWD-PLRT

Approve the request in your browser; waiting…

Signed in to Muse Code (Muse Code Power Usage). Try it with: claudish --model muse@muse-spark-1.3 "hello"
```

The tier in parentheses is the one Meta reports for your account.

### Prerequisites: a Muse Code subscription

- [ ] An active Muse Code subscription on your Meta account
- [ ] a claudish release newer than 10.6.1 (`claudish --version`)
- [ ] For `meta@` only: a Meta Model API key from https://dev.meta.ai

You do not need the Muse Code CLI. If you already use it, claudish can borrow its login instead.

---

## Two ways to log in

| | `claudish login muse` | the Muse Code CLI's `muse login` |
|---|---|---|
| Where the login lives | `~/.claudish/meta-muse-oauth.json` | the macOS Keychain item `ai.meta.dev.credentials` |
| Works on | any OS | macOS only, for claudish's purposes |
| Dialogs | none after the browser approval | one macOS Keychain access dialog, the first time |
| Works in `team` slots and MCP sessions | yes | after one interactive approval (below) |

claudish tries them in this order: its own login, then its copy of the Muse CLI's login, then the
Keychain. claudish never writes or deletes the Muse CLI's Keychain item.

### Borrowing the Muse CLI's login

Run one interactive launch in a terminal:

```bash
muse login                                   # once, in the Muse Code CLI
claudish --model muse@muse-spark-1.3 "hello"
```

Before Claude Code starts, macOS asks whether to allow access to the `ai.meta.dev.credentials`
Keychain item. Click **Always Allow**. claudish then confirms the subscription with Meta and saves a
copy of the login to `~/.claudish/meta-muse-borrowed.json` (mode 0600).

### Why team slots and MCP sessions need that copy

A `team` slot, a `create_session` pane, the MCP server, `--probe`, `claudish serve` and any piped
or CI run never open a Keychain dialog. Nobody watches their screen, so an unanswered dialog would
block the request. These processes read only claudish's two files, and without either one they
stop with:

```
muse@ in a team slot / MCP session needs a claudish login: run `claudish login muse`, or one
interactive `claudish --model muse@<model>` and allow Keychain access.
```

Either fix works, and from then on every slot signs on its own with no dialog.

---

## Choosing a model

Today you name the model with its exact wire id:

```bash
claudish --model muse@muse-wonder-full-1.0 "refactor the auth module"
claudish --model muse@muse-wonder-1.0 "review this diff"
claudish --model muse@muse-spark-1.2 "write tests for utils.ts"
```

Run `claudish` with no `--model` to open the picker. Its Muse Code row lists the models your account
serves, read live from Meta (`/muse-code/models`).

**Bare names do not reach `muse@` yet.** The cloud models catalog has no route for the Muse Code
subscription. Until it does, a bare name such as `muse-spark-1.3` goes to `meta@` if
`META_API_KEY` is set, then OpenCode Zen, then OpenRouter. Check what a name resolves to:

```bash
claudish --probe muse-spark-1.3
```

A bare name leads with `muse@` once the catalog publishes that route.

### Contributor models

Each Muse chat model also has a `-contributor` twin (`muse-spark-1.3-contributor`). Meta's description for
those ids: "Your content, including inter-session messages, may be used for product improvement."
claudish never picks a contributor id for you, on any provider. It sends one only when you type it
exactly:

```bash
claudish --model muse@muse-spark-1.3-contributor "hello"
```

### Reasoning effort

claudish sends the effort level Claude Code asks for. It encodes that level the way the metered
Meta API's catalog entry for the same model does.

The Wonder Full model is the exception. The metered API has no entry for `muse-wonder-full-1.0`,
so claudish cannot encode its effort, and the request carries the Responses adapter's default.
Contributor ids take only the output limit from their entry, with no effort encoding.

---

## Billing: `muse@` and `meta@`

### Metered `meta@`

```bash
export META_API_KEY='your-meta-model-api-key'
claudish --model meta@muse-spark-1.3 "summarise CHANGELOG.md"
```

Why two providers? `META_API_KEY` never signs `muse@`, and your Muse Code login never signs
`meta@`, because each credential is billed differently.

`meta@` used to be an OllamaCloud shortcut. It now means Meta. Use `oc@`, `llama@` or `lc@` for
OllamaCloud.

### Who bills what

| Provider | Billed | claudish shows |
|---|---|---|
| `muse@` | your Muse Code subscription, flat rate | `SUB`, $0 per request |
| `meta@` | per token, to your Meta Model API account | the per-token price |

Before it signs any `muse@` request, claudish asks Meta's key service whether your subscription is
active and needs no payment method. With no confirmation it does not sign. It asks again every 30
minutes, so a lapsed subscription stops within 30 minutes even in a long session.

If your Muse Code login expires mid-session, the request stops with a login message. claudish does
not move the request to a metered provider.

## Logging out

```bash
claudish logout muse
```

This deletes `~/.claudish/meta-muse-oauth.json` and `~/.claudish/meta-muse-borrowed.json`. It
leaves the Muse Code CLI's own login alone, and it does not revoke the token at Meta. To end the Muse
CLI's session too, use the Muse Code CLI's own logout.

---

## Troubleshooting

### "muse@ needs a Muse Code login"

**Cause**: no claudish login and no borrowed copy, and no Muse CLI login in the Keychain.

**Fix**: run `claudish login muse`.

### "Your Muse Code login has expired"

**Cause**: Meta's key service rejected the login (HTTP 401 or 403). Logging out of the Muse Code CLI
revokes the token claudish copied.

**Fix**: run `claudish login muse`, or `muse login` followed by one interactive `claudish` launch.

### "Your Meta account has no active Muse Code subscription (or needs a payment method)"

**Cause**: the login works, but Meta reports no active subscription. Logging in again does not
change this.

**Fix**: subscribe or add a payment method at the URL in the message
(https://accountscenter.meta.com/muse_code/?ep=no_payg when Meta names no other).

### "could not read the Muse Code login from the macOS Keychain"

**Cause**: the access dialog was denied, or got no answer within 120 seconds.

**Fix**: run the launch again and click **Always Allow**, or use `claudish login muse`, which needs no
Keychain access. claudish never kills the waiting Keychain read. A late answer still counts, and only
one dialog is open per machine at a time.

### "Muse Code key service unavailable (HTTP 503)"

**Cause**: Meta's key service is down or rate-limited (HTTP 429 or 5xx).

**Fix**: retry. Claude Code's own retry re-sends to `muse@`; the request does not move to another
provider.

### "muse@ in a team slot / MCP session needs a claudish login"

**Cause**: you logged in with `muse login` only, and no interactive `claudish` launch has copied
that login yet. The slot may not read the Keychain itself. See
[Why team slots and MCP sessions need that copy](#why-team-slots-and-mcp-sessions-need-that-copy).

**Fix**: run `claudish login muse` once, or one interactive `claudish --model muse@muse-spark-1.3`.

---

## Next steps

- [MCP Server Mode](mcp-server.md): use `muse@` models as tools inside Claude Code
- [Settings reference](../settings-reference.md): every provider shortcut and environment variable
- [Choosing models](../models/choosing-models.md)
