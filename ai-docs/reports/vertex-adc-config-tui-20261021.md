# Vertex AI in the config TUI: ADC identity, project, and cache resets (2026-10-21)

Released in 12.3.1. Read before editing `auth/vertex-auth.ts`, `auth/credentials/vertex-credential.ts`,
`providers/transport/vertex-discovery.ts`, or the Vertex branches in `tui/`.

## Two identities, two sources

A Vertex request needs a token and a project, and claudish reads them from different places:

- **Token** — Application Default Credentials: `~/.config/gcloud/application_default_credentials.json`
  (or the file `GOOGLE_APPLICATION_CREDENTIALS` names). Written by `gcloud auth application-default login`.
- **Project** — `VERTEX_PROJECT` / `GOOGLE_CLOUD_PROJECT`, else the ADC file's `quota_project_id`, else
  `gcloud config get project` (`resolveVertexConfig`).

`gcloud config get project` belongs to the gcloud CLI login (`gcloud auth login`), which is a different
login from ADC. A machine with two Google accounts can therefore sign as one account and address
another account's project. Measured on 2026-10-21: ADC signed as account A (oauth2 `tokeninfo` →
`email`), `gcloud config` named a project only account B could see
(`gcloud projects describe <p> --account=B` → ACTIVE), and both the model list and `generateContent`
answered 403 `Caller does not have required permission to use project <p>`.

Presence of the ADC file (`hasVertexAdcCredentials`) is a presence check, not entitlement: the TUI
can show `Ready / oauth` while every request 403s. Only a live request proves access.

## Error text: relay, never diagnose

The same 403 status also means "Vertex AI API not enabled", billing disabled, or a missing IAM role;
a 401 means an expired or revoked token; a mistyped project answers **400**
`Project 'projects/<p>' not found or deleted.`. claudish cannot tell these apart, Google's
`error.message` can. Every non-OK model-list response therefore leads with
`HTTP <status>: <error.message>`, followed only by measured facts (project and its source; for
401/403 the ADC account and the sign-in command). The TUI's failure area is two lines, so the first
~120 characters must be Google's sentence. A first version that led with a diagnosis
("account X cannot use project Y") was wrong for every other cause and pushed Google's sentence
off-screen; two reviewers rejected it.

The ADC account is named via `GET https://oauth2.googleapis.com/tokeninfo` on the 401/403 path only
(3 s timeout, token never logged), or `client_email` for a service-account file. An
`authorized_user` ADC file carries no email.

## Re-login must reset two caches

`credentials.invalidate("vertex")` was a no-op before 12.3.1: `VertexCredentialProvider` had no
`invalidate()`, so the authority only forgot which credential last signed. Two caches then replayed
the OLD identity after a successful `gcloud auth application-default login` in the same process:

- the `VertexAuthManager` singleton's token (≈55 min) — `resetVertexAuthManager()`;
- the discovery FAILURE cache (5 min, keyed by project+location) — `_clearVertexDiscoveryCache()`.

The TUI's `l` login (`tui/index.tsx`, `gcloud-adc` action) resets both plus project discovery.
Verified live: after the login the re-entered TUI showed the project source change to
`the ADC file's quota_project_id` and Test `valid`, with no restart.

## The detail pane is fixed height

`DETAIL_H = 7` gives 5 content rows. Free-wrapping text overflows it and paints over the rows
above (the Vertex note once erased the `Status:` row at 85 columns). Every variable-length row goes
through `wrapToLines` with an explicit line budget (`credentialNoteLines`, the failure text).

## Known test dependency

`providers/transport/vertex-discovery.test.ts` (4 confirmation tests) returns
`no chat-capable model among the 2 … listed` in a fresh home with the catalog warm disabled
(`CLAUDISH_DISABLE_CATALOG_WARM=1`). Identical on `main` at `c1082ce5`, so not caused by 12.3.1;
the listed models are ranked through the cloud models catalog. See `ai-docs/release.md` § CI/CD on
making such tests hermetic.
