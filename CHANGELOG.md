# Changelog

All notable changes to [Claudish](https://github.com/MadAppGang/claudish).

## [7.8.2] - 2026-06-27

### Bug Fixes

- **A running local server showed STATUS `running` but was filed under "— not configured —".** Follow-up to the 7.8.1 local-liveness work: the liveness ping made a started-but-not-enabled local (e.g. Ollama on :11434) report `running`, but the section divider, status dot, and sort still keyed off config-enabled only — so the row showed "running" while sitting below the divider with a hollow dot. Display-readiness now counts a running local as ready (a new shared `providerIsReadyForDisplay`), so the divider, dot, and "configured first" sort all agree with the status — the same source-vs-readiness fix applied to keyless providers in 7.8.1. (The detail status still distinguishes `running` from `running · off` so you can tell a server is up but not yet enabled.)

## [7.8.1] - 2026-06-27

### Bug Fixes

This is a fast-follow to 7.8.0, fixing credential-resolution regressions from the new credential authority plus several `claudish config` Providers-tab issues surfaced by "Test All" (`T`).

- **Kimi Coding sent the wrong key (401).** `kimi-coding` was registered as an alias of the regular Kimi credential, so its coding-plan endpoint (`api.kimi.com/coding`) received the regular Moonshot key (`MOONSHOT_API_KEY` / `KIMI_API_KEY`) instead of its own `KIMI_CODING_API_KEY` → guaranteed 401. It now has its own credential, keyed on `KIMI_CODING_API_KEY` first, sharing only the `claudish login kimi` OAuth flow. This fixed real `kc@` routing, not just the probe.

- **Alias env vars resolved to the variable NAME, not its value.** `ApiKeyCredentialProvider` used `aliases.find(a => process.env[a])`, which returns the matching alias *name* string (e.g. `"GLM_API_KEY"`), and that truthy garbage short-circuited resolution — so any provider configured via its alias (GLM via `GLM_API_KEY`, GLM Coding via `ZAI_CODING_API_KEY`, OpenCode Zen Go via `OPENCODE_API_KEY`) sent the literal env-var name as the API key → 401. Now resolves the alias's value.

- **Direct Gemini falsely showed "ready", then 401'd.** A user with `claudish login gemini` (Code Assist OAuth) but no `GEMINI_API_KEY` saw the **direct** Gemini row marked ready, because its catalog name (`google`) aliases onto the Code Assist OAuth credential. The config TUI no longer treats an OAuth alias as readiness for an API-key-only provider.

- **OpenCode Zen showed "ready" under "— not configured —".** A keyless/free provider (`publicKeyFallback`) was sorted/probed as ready but rendered under the not-configured divider with a hollow dot and blank key. The Providers tab now recognizes a `public` credential source, so the divider, status dot, and KEY column (now showing `free`) all agree.

- **Running local servers were invisible; stopped ones timed out.** Local providers (Ollama, LM Studio, vLLM, MLX) are now liveness-checked: a running server shows `running` (and a detected-but-not-enabled one shows `running · off` and is testable), while an enabled-but-stopped server is fast-failed with "not running" instead of a 15s "operation timed out".

- **`claudish config` Providers detail showed "From: env" for 1Password keys.** Keys hydrated from 1Password into the environment at startup were indistinguishable from real shell env vars. Their origin is now tracked, so the detail pane shows `From: 1Password` (and `--probe` / debug provenance report `1Password` too).

- **Stale test badges persisted after fixing a credential.** A red `FAIL` (or green `ready Xms`) lingered after saving or removing a key/URL. The badge is now cleared on each credential change.

## [7.8.0] - 2026-06-27

### Bug Fixes

- seed WASM cache from nearby copy (fixes ENOENT core_bg.wasm) *(onepassword)* ([`5a11962`](https://github.com/MadAppGang/claudish/commit/5a11962109fcb362aeee2d7a0956f6c58dcd3b2c))
- resolve 1Password keys up front when opening the config TUI (step 2) *(config)* ([`0ce68c7`](https://github.com/MadAppGang/claudish/commit/0ce68c7c9d8a9579d9cd303d5e33339dd47dd130))

### Documentation

- update CHANGELOG.md for v7.7.4([`24b07ea`](https://github.com/MadAppGang/claudish/commit/24b07ea99f44a1d4a8c622b1ce93a31333528c68))

### New Features

- add CredentialProvider authority (step 1 — pure addition) *(credentials)* ([`c5364e6`](https://github.com/MadAppGang/claudish/commit/c5364e66388b1a8fb6ac614233741af1044e3bc5))

### Other Changes

- v7.8.0 — unified credential authority + flag-consistency rename([`7bf44f1`](https://github.com/MadAppGang/claudish/commit/7bf44f11ec818401992956f34cfc0173edd83c52))

### Refactoring

- consistent flag naming + colorized, validated --help *(cli)* ([`7ec5407`](https://github.com/MadAppGang/claudish/commit/7ec5407afa3403df7c98f541cd1449fc6a3024fb))
- OAuth transports delegate to the authority, stop reading files (step 5) *(credentials)* ([`217b60e`](https://github.com/MadAppGang/claudish/commit/217b60e2892eb1f3b018504757c5dea4a09c26a8))
- resolve construction-path api key via the authority (step 4) *(credentials)* ([`c58939b`](https://github.com/MadAppGang/claudish/commit/c58939b34fdae972bd52c44001bcd8e69333377c))
- route the readiness oracle through the authority (step 3) *(credentials)* ([`dc8ebac`](https://github.com/MadAppGang/claudish/commit/dc8ebac65f3f7cba178c2d8bcb92be3b8074a73b))

## [7.7.4] - 2026-06-26

### Bug Fixes

- v7.7.4 — per-credential 1Password resolution (only when a routed model needs a missing key)([`07ce107`](https://github.com/MadAppGang/claudish/commit/07ce107afbb17c00b9326b7937b13e2ed5d0579b))
- resolve config secrets at point-of-need, not top of runCli *(onepassword)* ([`7ed6a16`](https://github.com/MadAppGang/claudish/commit/7ed6a16e5c85556154036bd5ed6a18e42bbd6982))

### Documentation

- update CHANGELOG.md for v7.7.3([`47f822e`](https://github.com/MadAppGang/claudish/commit/47f822e68b727f0a958da7dc07a53eb7b33d7728))

## [7.7.3] - 2026-06-25

### Bug Fixes

- v7.7.3 — resolve config 1Password secrets only on the model-routing path([`39e8f4d`](https://github.com/MadAppGang/claudish/commit/39e8f4d48ac21239fff6a9ace99de78792b370d9))

### Documentation

- update CHANGELOG.md for v7.7.2([`0ff1130`](https://github.com/MadAppGang/claudish/commit/0ff11301027a6c7e4069c43515c2fbb05128ab0a))

## [7.7.2] - 2026-06-25

### Bug Fixes

- v7.7.2 — skip 1Password resolution on help/version + silence expected field-skip noise([`59f8bb1`](https://github.com/MadAppGang/claudish/commit/59f8bb1c4fa63b4758fcb14bfb0bb9e71ba2f227))

### Documentation

- update CHANGELOG.md for v7.7.1([`aea380b`](https://github.com/MadAppGang/claudish/commit/aea380bca49a6a866424505c4dcdce90cd4fc87a))

## [7.7.1] - 2026-06-25

### Bug Fixes

- v7.7.1 — on-demand 1Password WASM fetch (fixes ENOENT core_bg.wasm in compiled binary)([`f70ebd1`](https://github.com/MadAppGang/claudish/commit/f70ebd141576d7aa2fc8ac7057749c7ec8577b79))

### Documentation

- update CHANGELOG.md for v7.7.0([`08ed721`](https://github.com/MadAppGang/claudish/commit/08ed7219b66c8f8343349e5b01572de3a6d1d277))
- update CHANGELOG.md for v7.6.0([`9539933`](https://github.com/MadAppGang/claudish/commit/95399332be45ab19c96737ee07fe1b4d97465742))

### New Features

- v7.7.0 — 1Password config TUI tab + probe-cache self-heal([`0a91277`](https://github.com/MadAppGang/claudish/commit/0a91277d8022da3a5f474684e78845a46edb8b18))

## [7.6.0] - 2026-06-22

### Documentation

- update CHANGELOG.md for v7.5.0([`cd1a1a4`](https://github.com/MadAppGang/claudish/commit/cd1a1a44335381c49179455545aaa76b2dc00ed5))

### New Features

- v7.6.0 — native 1Password integration (SDK-based)([`20686fb`](https://github.com/MadAppGang/claudish/commit/20686fbe061f554dcf29efc0e6c4cc7256403401))

## [7.5.0] - 2026-06-10

### Documentation

- add Claude Desktop gateway handoff + routing-alignment report *(serve)* ([`4bb28e5`](https://github.com/MadAppGang/claudish/commit/4bb28e5c88cd1d96002a3a5bb5b55a20f720d540))
- update CHANGELOG.md for v7.4.0([`15489ec`](https://github.com/MadAppGang/claudish/commit/15489ec715b6f7e5f765982ff19d62ebb741065e))

### New Features

- v7.5.0 — claudish serve gateway for Claude Desktop + provider slug alignment([`22df65f`](https://github.com/MadAppGang/claudish/commit/22df65f68abbb095f9d4144b1a212ce77d06c46a))
- claudish serve gateway for Claude Desktop custom models *(serve)* ([`f266cea`](https://github.com/MadAppGang/claudish/commit/f266cea6e6bd4df18566a8eff6c9232fddc2cb52))

### Other Changes

- drop stale .claudemem/ ignore entry([`c435db8`](https://github.com/MadAppGang/claudish/commit/c435db834b8e4241a03b5b46aa075b1c8aaffb8e))

### Refactoring

- canonical slug rename xai→x-ai, zai→z-ai *(providers)* ([`2c87378`](https://github.com/MadAppGang/claudish/commit/2c873782a6ca7df5a86cae8247c1bff250b6481d))
- drop live-phase pipeline-step indicator *(probe)* ([`859cc53`](https://github.com/MadAppGang/claudish/commit/859cc534480ac1ceb8a4eb689d46f493370a1b98))

## [7.4.0] - 2026-06-03

### Bug Fixes

- route `internal` to native Claude Code passthrough *(probe)* ([`7ac5e20`](https://github.com/MadAppGang/claudish/commit/7ac5e20258703b6da6f2ed8b4098faaab192ce56))

### Documentation

- update CHANGELOG.md for v7.3.0([`fd6fbba`](https://github.com/MadAppGang/claudish/commit/fd6fbba738ef7e3e65de640f8183d8316194e83c))

### New Features

- add Leaderboard (winners) tab, clean exit *(probe)* ([`9887586`](https://github.com/MadAppGang/claudish/commit/988758681b98cf99d0f085a06b81504e58d01474))

### Other Changes

- release v7.4.0 — probe Leaderboard tab + internal native route([`f5518cf`](https://github.com/MadAppGang/claudish/commit/f5518cf7d9054c2b7e1ab49aa9961a99c07edba3))

## [7.3.0] - 2026-06-03

### Bug Fixes

- bound tok/s, absolute throughput color, details heading *(probe)* ([`dc5d7e8`](https://github.com/MadAppGang/claudish/commit/dc5d7e809fade4781e738b963f9a187aacd5f25f))

### Documentation

- update CHANGELOG.md for v7.2.0([`96bad24`](https://github.com/MadAppGang/claudish/commit/96bad24f15c4b08e8a61db9ef57247891cec9e8d))

### New Features

- stay-in-TUI tabbed results + routing advisor *(probe)* ([`701a593`](https://github.com/MadAppGang/claudish/commit/701a593baea0ae19c323dc1089a08545bf08b4ac))
- two-row header, package version, profile wizard cursor handling *(tui)* ([`d07ac4e`](https://github.com/MadAppGang/claudish/commit/d07ac4e87980cb3ff9631615e3f3fe6cf7c9de4d))
- show winning provider in leaderboard *(probe)* ([`bbffaa5`](https://github.com/MadAppGang/claudish/commit/bbffaa5d86cd11d9c0e40c11b134e74c9039b678))
- rich timing TUI — leaderboard, vivid bars, mouse + key scroll *(probe)* ([`6d1077c`](https://github.com/MadAppGang/claudish/commit/6d1077cb0a70ea3f41a007271aeb614311ffbad1))
- footer hotkey chips + provider list scroll-into-view *(tui)* ([`8796ff6`](https://github.com/MadAppGang/claudish/commit/8796ff60b054f91ba9778baf02ef6a66945f8b8c))

### Other Changes

- release v7.3.0 — interactive tabbed probe results + routing advisor([`9e9ba5d`](https://github.com/MadAppGang/claudish/commit/9e9ba5deee9743ec6daafa7ff348e866dcb2399c))

### Refactoring

- monochrome two-tone footer chips *(tui)* ([`a3b18e7`](https://github.com/MadAppGang/claudish/commit/a3b18e744015fa15e84004e4260b036a0aef9f94))

## [7.2.0] - 2026-05-29

### Bug Fixes

- probe failures across providers — verified end-to-end *(tui)* ([`ca5ef98`](https://github.com/MadAppGang/claudish/commit/ca5ef98cf3d2410f71d178d298ccc0d2f18f59ec))
- claude-sonnet-4-6 (current Sonnet), not 4-5 *(tui)* ([`d11ad2d`](https://github.com/MadAppGang/claudish/commit/d11ad2d535d882953f113636f5460bf654c6ce2e))
- use current claude-sonnet-4-5 as testModel for Anthropic-compat coding plans *(tui)* ([`ceb27bd`](https://github.com/MadAppGang/claudish/commit/ceb27bd0f425bb8a3b5b5b1368714a3cc2c8459f))
- Anthropic-compat coding plans accept Claude model names, not native *(tui)* ([`4c4bde0`](https://github.com/MadAppGang/claudish/commit/4c4bde0975473418ddb0a497b3d57b3ac86189f2))
- `t` on unconfigured provider doesn't fake a failure *(tui)* ([`c3aaea8`](https://github.com/MadAppGang/claudish/commit/c3aaea89d413b874d60a9b70cb6de5819c82f430))
- pin AUTH legend to bottom of Providers panel *(tui)* ([`df9323f`](https://github.com/MadAppGang/claudish/commit/df9323fd26960b9440d405b523211138f8fdf30c))
- OAuth wins over env for OAuth-capable providers *(tui)* ([`59283ad`](https://github.com/MadAppGang/claudish/commit/59283ad5f71898b3d083312bbbe7096be131aa59))
- test-all skips providers without a key *(tui)* ([`98e1355`](https://github.com/MadAppGang/claudish/commit/98e1355e715dbf87806490f4f851f342207544bc))
- scope picker readable, prune empty .claudish.json *(tui)* ([`bbfc7a7`](https://github.com/MadAppGang/claudish/commit/bbfc7a70d1464cb1e7f8c792c9c3a95caa3429d3))
- walk up to find .claudish.json in parent directories *(config)* ([`5630b4c`](https://github.com/MadAppGang/claudish/commit/5630b4cb59c61359a6e437663a8eeb1af5ed840e))
- make rule matching case-insensitive *(routing)* ([`253bda6`](https://github.com/MadAppGang/claudish/commit/253bda6b5e9f16a41eb2f732c6b0c6695a712054))
- treat defaultProvider == built-in as built-in in routing tab *(tui)* ([`c80a787`](https://github.com/MadAppGang/claudish/commit/c80a78779194b58f50643449c36a5465a434786a))

### Documentation

- update CHANGELOG.md for v7.1.2([`980ea08`](https://github.com/MadAppGang/claudish/commit/980ea089288070c7da99308d9fdae191ff44ffe7))

### New Features

- catalog-driven probes + endpoint self-discovery + multi-candidate retry *(tui)* ([`432efc1`](https://github.com/MadAppGang/claudish/commit/432efc1a746cb613b08f0f636768bed998b21679))
- multi-source key display, inline test errors, key scramble animation *(tui)* ([`4b32c6a`](https://github.com/MadAppGang/claudish/commit/4b32c6ae8ea3c7789b04f2044c377d29d8d0f3b0))
- return to TUI after login (child process for OAuth flow) *(tui)* ([`c4c670a`](https://github.com/MadAppGang/claudish/commit/c4c670a080a64d15466cf0640be7b3dbd5909861))
- `l` actually launches login (TUI exits, login runs, exit) *(tui)* ([`14482b3`](https://github.com/MadAppGang/claudish/commit/14482b3bb144c0ba61fdcef3d8f54b86c8466440))
- emoji AUTH icons + legend at bottom *(tui)* ([`ae007ce`](https://github.com/MadAppGang/claudish/commit/ae007cebfdc99cf661a11c33e9ed99d81a12a544))
- AUTH column shows oauth alongside set key *(tui)* ([`0813824`](https://github.com/MadAppGang/claudish/commit/0813824ab6f32af4ff0c8621c3c3c7f6c64c9773))
- AUTH column as single pill, muted colors *(tui)* ([`b16c6c3`](https://github.com/MadAppGang/claudish/commit/b16c6c37f8a69b6fd6bf5cb12eb8614d313e8d87))
- AUTH column as bg-pill tags *(tui)* ([`a0be986`](https://github.com/MadAppGang/claudish/commit/a0be986b8e91f4cfff1503d0925f7b9666839311))
- Providers AUTH capability slots + dynamic footer *(tui)* ([`dea4e21`](https://github.com/MadAppGang/claudish/commit/dea4e21494cab230f9eef9485ea6427cb84cd983))
- Providers tab column alignment + OAuth indicator *(tui)* ([`5b71e2d`](https://github.com/MadAppGang/claudish/commit/5b71e2d19e5f5133e85a464569da8d7412f161a5))
- OAuth login hint on Providers tab + footer width fix *(tui)* ([`d602667`](https://github.com/MadAppGang/claudish/commit/d602667015df95473de5b0bbcf1bb9dc80b6d939))
- restore parallel test-all on Providers tab *(tui)* ([`57ee4d7`](https://github.com/MadAppGang/claudish/commit/57ee4d760bd1d1ecf357b73f0b6288f03de8a4e7))
- compact Rules header *(tui)* ([`60c21f8`](https://github.com/MadAppGang/claudish/commit/60c21f889ac437c0d9790449646ca4a53eeed09c))
- redesign Routing Legend panel as 2x2 table *(tui)* ([`236872e`](https://github.com/MadAppGang/claudish/commit/236872e4d09a27acbce25662e66c00c5d85fe771))
- scope picker as navigable menu (arrows + Enter) *(tui)* ([`31541dc`](https://github.com/MadAppGang/claudish/commit/31541dcb003e3342737ea47d64fbe7f3609672a9))
- show all routing rules per scope, no shadowing *(tui)* ([`4bb788b`](https://github.com/MadAppGang/claudish/commit/4bb788b3f1bb386f36eb2124749b9608f264b9e6))
- project-scope routing rules with g/p picker *(tui)* ([`7ed9f91`](https://github.com/MadAppGang/claudish/commit/7ed9f91eeac4233bb41787250584e9e61c3f52d5))
- scrollable rules table and chain selector *(tui)* ([`f1be9a9`](https://github.com/MadAppGang/claudish/commit/f1be9a92301ea7eafad8458d8d5d580a38234296))
- show built-in routing rules in Routing tab *(tui)* ([`35dcda2`](https://github.com/MadAppGang/claudish/commit/35dcda25fc3f5d34c6750836ad15bac731c178b1))

### Other Changes

- release v7.2.0 — catalog-driven TUI probes + endpoint self-discovery([`7f5f534`](https://github.com/MadAppGang/claudish/commit/7f5f534441852a7658fb2adcba090e7df6fbc953))

### Refactoring

- unify provider testing via probeLink + proxy *(tui)* ([`3f0b35f`](https://github.com/MadAppGang/claudish/commit/3f0b35f5d295ee3bacd16ceed9a592d4e58caf25))
- extract useProfileWizard hook *(tui)* ([`b3b34ff`](https://github.com/MadAppGang/claudish/commit/b3b34ffce37e3faf4cae86c4d5f117debdabd852))
- extract useRouteProbe hook *(tui)* ([`9efd707`](https://github.com/MadAppGang/claudish/commit/9efd7078d6632082222cce186bf00b561234d1e2))
- extract render closures into components/ *(tui)* ([`be27b8e`](https://github.com/MadAppGang/claudish/commit/be27b8e584922b7d7797c0e95c97a3242d57acba))

## [7.1.2] - 2026-05-09

### Bug Fixes

- gate sync resolver on isFreshEnough TTL *(model-loader)* ([`067f27d`](https://github.com/MadAppGang/claudish/commit/067f27dd87417297f8ea9df5e7e15dbd4f6bf166))

### Documentation

- update CHANGELOG.md for v7.1.1([`c51ee70`](https://github.com/MadAppGang/claudish/commit/c51ee70ede43cd59f301d2c736cba74417c6e851))

### Other Changes

- release v7.1.2 — gate sync resolver on isFreshEnough TTL([`d769982`](https://github.com/MadAppGang/claudish/commit/d7699828a89b89852d57d1e3b7c8f0675f54ed20))

## [7.1.1] - 2026-05-09

### Documentation

- update CHANGELOG.md for v7.1.0([`0bad75e`](https://github.com/MadAppGang/claudish/commit/0bad75e127c60495184ad9bedd3c993b2f5a0dad))

### New Features

- SEP-1686 forward-compat + diagnostics + roadmap (#119) *(channel)* ([`2312750`](https://github.com/MadAppGang/claudish/commit/2312750522bc7de7df5a6cd096515cc0b2c83a62))

### Other Changes

- release v7.1.1 — drop CLAUDISH_GEMINI_HELP_FALLBACK env var([`22720b9`](https://github.com/MadAppGang/claudish/commit/22720b997f7e3df01767f659df18cd64537728e5))

## [7.1.0] - 2026-05-09

### Bug Fixes

- externalize @opentui/* so dist bundle loads native platform binary *(packaging)* ([`0beb77a`](https://github.com/MadAppGang/claudish/commit/0beb77a59baa1089b8fa0fa3925e1621c846df42))
- return 400 on count_tokens with missing model *(proxy)* ([`7d3f4f3`](https://github.com/MadAppGang/claudish/commit/7d3f4f366476e0e5bc8f0cf1de5ca23cd7c9afcf))
- rewrite model selector on CatalogClient, fix empty Zen list *(picker)* ([`5c6e9bf`](https://github.com/MadAppGang/claudish/commit/5c6e9bfe1f3825795365ed9693e14ed9c8816af8))

### Documentation

- update CHANGELOG.md for v7.0.3([`a944199`](https://github.com/MadAppGang/claudish/commit/a9441999085fedeb56b066060ff2d6e4adf36142))

### New Features

- sort all model lists by releaseDate (newest first) + show date *(picker)* ([`1bdafe9`](https://github.com/MadAppGang/claudish/commit/1bdafe9bac2313522d65513598b7abe7f10f43be))
- wire defaultProvider as final fallback + truthful TUI render *(routing)* ([`9ec6eab`](https://github.com/MadAppGang/claudish/commit/9ec6eab892488091ad58733f8438d88a5a311ad9))
- add catalog-query.ts read-only accessors *(catalog)* ([`8afff4f`](https://github.com/MadAppGang/claudish/commit/8afff4f047486aa438cf71acec940d267ab2b44f))
- warm catalog before proxy startup (Option D) *(launcher)* ([`77d26ae`](https://github.com/MadAppGang/claudish/commit/77d26ae38cb8ddeeb6ffb88fbe4954703b00f622))
- add refreshCatalog() returning RefreshOutcome to resolver interface *(catalog)* ([`9ba5dfc`](https://github.com/MadAppGang/claudish/commit/9ba5dfc208d92f1655531449542c5960700a548f))
- default routing rules + route() over user-rewritable schema *(routing)* ([`ceec76a`](https://github.com/MadAppGang/claudish/commit/ceec76a1c04232a501b0708d7717d7e5240df462))
- introduce CatalogClient and unify Firebase cache TTL *(catalog)* ([`0d9e1e9`](https://github.com/MadAppGang/claudish/commit/0d9e1e92a37e2a5aa3124dd3fb0586c9d0e50d80))

### Other Changes

- release v7.1.0([`d6c0483`](https://github.com/MadAppGang/claudish/commit/d6c048373e3058d66b11b46e7a3e6e1ddc59578b))
- fix writeFileSync import, tsconfig, claudeArgs strict-null *(types)* ([`27a60ba`](https://github.com/MadAppGang/claudish/commit/27a60ba45676e0685a1634e0644f9a774539c302))
- delete static-fallback.ts (OPENROUTER_VENDOR_MAP) *(catalog)* ([`ba650d5`](https://github.com/MadAppGang/claudish/commit/ba650d51d11ec7a2fbaa37ea326bca1566720ca2))
- plumb --force-update + --skip-models-update into ClaudishConfig *(cli)* ([`3849727`](https://github.com/MadAppGang/claudish/commit/3849727034487d133d5d23930e41e124c8114f28))
- extract landing page and model-update script to models-index repo([`57c1e53`](https://github.com/MadAppGang/claudish/commit/57c1e53767d22c3f890e8a5464be4caea1f2f346))

### Refactoring

- apply Phase 5 quality follow-ups (M1, M2, L1-L3) *(catalog)* ([`a0035f3`](https://github.com/MadAppGang/claudish/commit/a0035f3de3beb54b95007120692bc9184977d71f))
- replace gpt-5.4 probe + gemini help-text hardcodes *(quota)* ([`617f83c`](https://github.com/MadAppGang/claudish/commit/617f83c3928cdd0d6e5801619a673d2cca0f1c0b))
- delete PROVIDER_TO_OR_PREFIX, route pricing through aggregators[] *(cleanup)* ([`8d60d5f`](https://github.com/MadAppGang/claudish/commit/8d60d5fe440438ccb05c0738a4860a5d89636183))
- replace haiku/sonnet/opus tier map + VISION_MODEL with catalog lookups *(cleanup)* ([`06519a9`](https://github.com/MadAppGang/claudish/commit/06519a9601f31a932168b0f91f687d6e3ce032d4))
- delete direct-provider catalog code, bundled fallback, legacy routing([`029d8fd`](https://github.com/MadAppGang/claudish/commit/029d8fd07eddb1bcf56f61c03274f04688815ba9))
- extend ModelDoc with aggregators, vendors, availableInPlans *(model-loader)* ([`2ec025f`](https://github.com/MadAppGang/claudish/commit/2ec025fbc60406c8d46216f88ec97cbc3a3aef04))
- dedupe CODE_ASSIST_FALLBACK_CHAIN *(gemini)* ([`eb91bed`](https://github.com/MadAppGang/claudish/commit/eb91bed628e98871a8fcba90cc2c8f4ea9e93ec2))
- finalize Firebase migration, remove static MODEL_CATALOG *(catalog)* ([`3edc60f`](https://github.com/MadAppGang/claudish/commit/3edc60fac7b88bf51569be389c37e9c5c32152fb))

## [7.0.3] - 2026-04-21

### Bug Fixes

- inherit parent CWD so models can access the repo *(team)* ([`00a692a`](https://github.com/MadAppGang/claudish/commit/00a692a7c698cbd09a0320df65123d771d73fbf5))
- align OAuth flow with opencode for successful ChatGPT login *(codex)* ([`ceb5074`](https://github.com/MadAppGang/claudish/commit/ceb50743981b026c01e621649c71e9170c305041))
- detect in-stream error payloads from anthropic-compat providers (#106) *(anthropic-sse)* ([`9deb528`](https://github.com/MadAppGang/claudish/commit/9deb5286ecf0829e71a5d1de149dcc83a4b3ab8d))
- back interactive model picker with Firebase catalog([`b5f0e49`](https://github.com/MadAppGang/claudish/commit/b5f0e49caba6740367bc345346e31b08cf4d6bbe))

### Documentation

- update CHANGELOG.md for v7.0.1([`0ee1c1e`](https://github.com/MadAppGang/claudish/commit/0ee1c1e66c16149ebd202f5723a0ae160d748f6b))

### New Features

- --advisor flag for multi-model advisor tool replacement *(advisor)* ([`460bfd0`](https://github.com/MadAppGang/claudish/commit/460bfd01e166392e9b1693678b469735302d5068))
- enable OAuth authentication for ChatGPT Plus/Pro subscriptions *(codex)* ([`7098992`](https://github.com/MadAppGang/claudish/commit/709899215ba16afaa296fca2eb37afbad159b6b3))

### Other Changes

- release v7.0.3([`e898715`](https://github.com/MadAppGang/claudish/commit/e8987155ea634ddb84505832bfe9592c1316ddb3))

## [7.0.1] - 2026-04-16

### Bug Fixes

- filter thinking blocks from MiniMax SSE to prevent leaking internal reasoning *(minimax)* ([`bd9bd85`](https://github.com/MadAppGang/claudish/commit/bd9bd85b122c5fbade05b619e5571cc5109a96fa))
- address edge cases in PR #103 interactive-mode detection([`8932edf`](https://github.com/MadAppGang/claudish/commit/8932edfb733ebcd602154d3487db142804cc5e1e))
- default to interactive mode when only flags are passed (no prompt) (#103)([`cba30c9`](https://github.com/MadAppGang/claudish/commit/cba30c936b0afa82920b9e1e8c05a61dbaad0842))
- rewrite parser for restructured pricing page *(google-scraper)* ([`473d539`](https://github.com/MadAppGang/claudish/commit/473d539bb3ffa954735ccfb7e9e8bafe9fc29fda))

### Documentation

- update all documentation for v7.0.0 release([`297a797`](https://github.com/MadAppGang/claudish/commit/297a797d70bfb8b2f4bd90e77beeb71d9ef67911))
- update CHANGELOG.md for v7.0.0([`75fce0a`](https://github.com/MadAppGang/claudish/commit/75fce0a2d54e5a12b6ee6b992d59dad2b4bfa36a))

### Refactoring

- move model catalog system to models-index repo([`cb75290`](https://github.com/MadAppGang/claudish/commit/cb75290e836acc0059b13ee69ab7c177dc553e3e))

## [7.0.0] - 2026-04-16

### Documentation

- update CHANGELOG.md for v6.14.0([`8f18ec2`](https://github.com/MadAppGang/claudish/commit/8f18ec21e67babcebab862f49e2dade859d1f44c))

### New Features

- v7.0.0 — configurable default provider, custom endpoints([`c5ae212`](https://github.com/MadAppGang/claudish/commit/c5ae2127aee0f27d3d226958490741460f7a88e2))

### Other Changes

- add opt-in advisor-tool swap module *(experiment)* ([`fda7852`](https://github.com/MadAppGang/claudish/commit/fda78525727262baf75e5a99f298e77244915ebc))

## [6.14.0] - 2026-04-15

### New Features

- v6.14.0 — Firebase-only catalog, semantic search, --list-providers([`95684ae`](https://github.com/MadAppGang/claudish/commit/95684ae540a4cdc049a7a6cee19dfa41d6790cf7))

## [6.13.3] - 2026-04-15

### Bug Fixes

- gate consent prompt while Claude Code owns TTY (#85, #88, #99) *(telemetry)* ([`72f4460`](https://github.com/MadAppGang/claudish/commit/72f4460958a85a4c2c85179b3bfbed8013aecd15))

### Documentation

- reflect ?catalog=top100, slim PublicModel projection, search fix *(api)* ([`bdcef63`](https://github.com/MadAppGang/claudish/commit/bdcef63d9f5444753c34cd0af3ce1f979ba76298))
- update CHANGELOG.md for v6.13.2([`688e483`](https://github.com/MadAppGang/claudish/commit/688e4833774e2cb5efc37ea7e12800e1b8d1bec7))

### New Features

- slim public API — strip internal provenance from responses *(firebase)* ([`d21c2c9`](https://github.com/MadAppGang/claudish/commit/d21c2c9f4f1002fc321a83e4401506f77acf94ce))
- add ?catalog=top100 endpoint + fix search ordering bug *(firebase)* ([`f71f9ef`](https://github.com/MadAppGang/claudish/commit/f71f9eff6eaf0f308980ef947bb0977332eb99ef))

### Other Changes

- v6.13.3 — fix interactive stdin race (#85, #88, #99) *(release)* ([`ec01715`](https://github.com/MadAppGang/claudish/commit/ec0171581b09fe3cf33362c7a5e7fa4c43b57020))

### Refactoring

- align manual trigger alert paths with scheduled cron *(catalog)* ([`16379d9`](https://github.com/MadAppGang/claudish/commit/16379d9941844b80c3593b6b8ff7d8efb53d1475))

## [6.13.2] - 2026-04-15

### Bug Fixes

- stream format priority — explicit adapter wins over model dialect *(#102)* ([`a0b15a9`](https://github.com/MadAppGang/claudish/commit/a0b15a97e0586d2fea09c98bdf7fb4591ee6fd82))
- thread Slack webhook as parameter, not process.env *(recommender)* ([`0fddebd`](https://github.com/MadAppGang/claudish/commit/0fddebd69db249bb627be2d34d0eb6370d3ac677))
- centralize all-models.json through v2 helpers *(cache)* ([`157c580`](https://github.com/MadAppGang/claudish/commit/157c580e46f9ec144eecea2721a182b1ce29a736))
- #102 GLM stream parser + structural prevention + #85/88/99 stdin cleanup([`f876e79`](https://github.com/MadAppGang/claudish/commit/f876e7916979cbae1db7ba5bdf57f19d4b37ebb3))

### Documentation

- update API reference for recommender v2.0 (S1-S7 refactor)([`a68735f`](https://github.com/MadAppGang/claudish/commit/a68735f5b12ef09c2790ecae29a8d80bea563cbe))
- update CHANGELOG.md for v6.13.1([`ae86f4f`](https://github.com/MadAppGang/claudish/commit/ae86f4f0f18b2f1d16a577ef6b413228e3a162f4))

### New Features

- v6.13.2 — fix #102 GLM/Z.AI 0-byte output + #85/88/99 stdin cleanup([`c959d0e`](https://github.com/MadAppGang/claudish/commit/c959d0e37dce1ce9d7317bcdfaafcdd4d6ade419))
- add aggregators[] field to ModelDoc and slim catalog *(firebase)* ([`8a08535`](https://github.com/MadAppGang/claudish/commit/8a08535ceb3fa941e9859adea0926e804728425b))
- runtime-registered custom endpoints *(providers)* ([`1451aea`](https://github.com/MadAppGang/claudish/commit/1451aea57448417e44d64e1a7d2ccf2d7a8ee789))
- demote LiteLLM from hardcoded priority *(routing)* ([`5a0d294`](https://github.com/MadAppGang/claudish/commit/5a0d294f63203e068da5e4e241dd56d9ea509964))
- add defaultProvider key + customEndpoints schemas *(config)* ([`12ff0b1`](https://github.com/MadAppGang/claudish/commit/12ff0b110cedef365dd6146550f0afb2f3af573c))

## [6.13.1] - 2026-04-14

### Bug Fixes

- reject category headings as model IDs *(google-scraper)* ([`0582413`](https://github.com/MadAppGang/claudish/commit/058241372fe2263654ad9f165ceb9ed523cf5613))
- set en-US locale headers on every page *(browserbase)* ([`ed93c11`](https://github.com/MadAppGang/claudish/commit/ed93c1180f22aa6a1484c3905aa1cb3b1eac4f50))
- retry up to 3 times on empty response *(qwen-scraper)* ([`4fb6716`](https://github.com/MadAppGang/claudish/commit/4fb6716d87a87ee80fb51f4cd80be646184df682))

### Documentation

- update CHANGELOG.md for v6.13.0([`f66d397`](https://github.com/MadAppGang/claudish/commit/f66d397fcc69d7f014e4b7b78c7d4c23b935b23b))

### New Features

- v6.13.1 — magmux IPC integration + e2e tests([`26c7a29`](https://github.com/MadAppGang/claudish/commit/26c7a29efda8c1171c36abeae93ef84627bb825e))

### Other Changes

- gitignore local dev test scripts in firebase/functions([`a0776f0`](https://github.com/MadAppGang/claudish/commit/a0776f0490246829791d80636e1b7fb3b52ded23))

### Refactoring

- delegate all lifecycle tracking to magmux *(team-grid)* ([`168c814`](https://github.com/MadAppGang/claudish/commit/168c814db601da2976b48dd752dea5a319bd2bba))

## [6.13.0] - 2026-04-14

### Bug Fixes

- restore scroll+click that actually triggers render *(qwen-scraper)* ([`42a17d8`](https://github.com/MadAppGang/claudish/commit/42a17d8c24be0d220c20637ca6b2a883f2aa2cfe))
- wait for JS-rendered content, not a blind setTimeout *(browserbase)* ([`8e273f6`](https://github.com/MadAppGang/claudish/commit/8e273f6a715ea95d2e39d2bf7026d48e98ce08df))
- click International tab before scraping *(qwen-scraper)* ([`b04861e`](https://github.com/MadAppGang/claudish/commit/b04861e48adf7b967a6fa23b215af705120b6180))
- diff gate ignores category recategorization *(recommender)* ([`c174797`](https://github.com/MadAppGang/claudish/commit/c17479761e10d3f33b564c3e567cc337cd25baa0))
- parseVersion strips parameter-count suffixes *(recommender)* ([`32d3307`](https://github.com/MadAppGang/claudish/commit/32d33072f753e11d891ac4214cdff407d4772443))
- date-stamp handling + missing provider aliases *(firebase/recommender)* ([`760b6db`](https://github.com/MadAppGang/claudish/commit/760b6dbd45ff9be8052734db4ef9fcfe841e3798))
- fix 6 cron output issues — vendor prefix, model selection, timeouts *(recommender)* ([`6ba9043`](https://github.com/MadAppGang/claudish/commit/6ba90430281193bfadf991f43cf4408621064511))

### Documentation

- add API reference for Firebase endpoints, MCP tools, and schemas([`5f38f08`](https://github.com/MadAppGang/claudish/commit/5f38f08ceeb5182a6dcec23ecbc8c0fd8e20c322))
- update CHANGELOG.md for v6.12.3([`a39970f`](https://github.com/MadAppGang/claudish/commit/a39970fae6f188df954542730bf533abf522c00e))

### New Features

- interactive TUI with bordered result cards *(probe)* ([`22865e7`](https://github.com/MadAppGang/claudish/commit/22865e77be0c65a1b8f9a97b84c33ff84f74340a))
- lexical modality fallback in isCodingCandidate *(firebase/recommender)* ([`cdcafc6`](https://github.com/MadAppGang/claudish/commit/cdcafc6733a86cb0046fe2990483e08dd900dfa6))
- deterministic version-aware picker *(firebase/recommender)* ([`1eb5808`](https://github.com/MadAppGang/claudish/commit/1eb580831785283dab5e12d3d2c8bd20f8cda891))
- pre-publish diff gate and provider-drop alerts *(firebase/recommender)* ([`42c2b82`](https://github.com/MadAppGang/claudish/commit/42c2b825fe5d8e33936aa104e36c82ce76ecaf9d))
- add one-off cleanupStalePrefixedDocs migration endpoint *(cleanup)* ([`a6fdbbf`](https://github.com/MadAppGang/claudish/commit/a6fdbbf7f1ca3bb4b64f0fc5f733aff2c2a61982))
- --probe sends real 1-token requests to validate each provider([`f843f3e`](https://github.com/MadAppGang/claudish/commit/f843f3e1ed0e553e9303e9bb2f44ae459436dcf4))

### Other Changes

- clean up unused symbols after S1-S7 refactor *(firebase)* ([`be07e5a`](https://github.com/MadAppGang/claudish/commit/be07e5ac3f26e9a33a6ff0fc6ac70f271cc41a16))

### Refactoring

- remove tab-click, rely on en-US locale *(qwen-scraper)* ([`00b2bc1`](https://github.com/MadAppGang/claudish/commit/00b2bc147d2a0333f648f1e65a87c84fa3d5e998))
- install schema gate at RawModel ingress *(firebase/recommender)* ([`656e37a`](https://github.com/MadAppGang/claudish/commit/656e37a5a156ab061a8627aea77d84156c3a5164))

## [6.12.3] - 2026-04-11

### Bug Fixes

- make codesign verification non-fatal for Bun binaries([`2cfbccb`](https://github.com/MadAppGang/claudish/commit/2cfbccb727058b7b55119daf7945242f743e0bc9))
- Qwen pricing scraper, stale doc cleanup, xAI alias fix([`0468eae`](https://github.com/MadAppGang/claudish/commit/0468eaed19fa57e62f30ba66debc080a9f832144))
- stale doc cleanup + xAI alias resolution for correct model IDs([`343e619`](https://github.com/MadAppGang/claudish/commit/343e61952b26ba5e23accac5a61a98b4a811ea8e))

### Documentation

- update CHANGELOG.md for v6.12.2([`9e89555`](https://github.com/MadAppGang/claudish/commit/9e895558e81449660f096c47d0d35e9f195f60c2))

### New Features

- v6.12.3 — Browserbase integration for JS-rendered pricing pages([`b2e2ccc`](https://github.com/MadAppGang/claudish/commit/b2e2ccc01a841320955f2c0ae78b86f8211d8b68))
- add Qwen pricing scraper from Alibaba Cloud Model Studio docs([`f9fe44d`](https://github.com/MadAppGang/claudish/commit/f9fe44d3e7054847696759953ed456380a52eeea))

### Other Changes

- add gitignore for magmux binaries and team session dirs([`89291a3`](https://github.com/MadAppGang/claudish/commit/89291a31cb1785bdc9e4d7d4db1f3722c7efad61))

### Refactoring

- remove local magmux source, use upstream releases([`e1f8dd1`](https://github.com/MadAppGang/claudish/commit/e1f8dd1556d33d220385dfb4df2ff2894178f386))

## [6.12.2] - 2026-04-10

### Bug Fixes

- v6.12.2 — team orchestrator race conditions and test hardening([`302e3f3`](https://github.com/MadAppGang/claudish/commit/302e3f372f0be1961175ea217b07e576a3262e2c))
- use official pricing from provider docs, not aggregator prices([`0e8bc48`](https://github.com/MadAppGang/claudish/commit/0e8bc480790d92763b49f5cc99f619b8d370fa53))

### Documentation

- update CHANGELOG.md for v6.12.1([`21c5fc0`](https://github.com/MadAppGang/claudish/commit/21c5fc07cca05040097f18f5c9e7dcac92280767))

## [6.12.1] - 2026-04-10

### Bug Fixes

- v6.12.1 — fix xAI pricing conversion (was 100x too low)([`871e957`](https://github.com/MadAppGang/claudish/commit/871e95727fc18bf55963819c2b081a7f5ef952f9))
- close remaining race conditions in team-orchestrator *(team)* ([`832cbb7`](https://github.com/MadAppGang/claudish/commit/832cbb7e96e01eaca8564cdb42db400a2026a8e3))

### Documentation

- update CHANGELOG.md for v6.12.0([`107e843`](https://github.com/MadAppGang/claudish/commit/107e8439cea41cc248677714c4d14e97ed1fafb6))

## [6.12.0] - 2026-04-09

### Documentation

- update CHANGELOG.md for v6.11.1([`d89cddd`](https://github.com/MadAppGang/claudish/commit/d89cdddd5ad2004356e7727ad0898e7ef39bc0e7))

### New Features

- v6.12.0 — new API collectors, error report ingest, auto-recommender, team timeout fix([`e940c79`](https://github.com/MadAppGang/claudish/commit/e940c79a60fa3ab74dbf98ac6e0f657b6f9063ef))

## [6.11.1] - 2026-04-08

### Bug Fixes

- v6.11.1 — fix OAuth login in bundled dist, model catalog improvements([`73cff9c`](https://github.com/MadAppGang/claudish/commit/73cff9caa24818935fce2304c77756c7f13639b9))

### Documentation

- update CHANGELOG.md for v6.11.0([`f6a4ce0`](https://github.com/MadAppGang/claudish/commit/f6a4ce09af964a2df6f1dee5f83fc0ddd26f7a04))

## [6.11.0] - 2026-04-07

### Bug Fixes

- remove uncommitted warmRecommendedModels import that breaks CI([`b4265ff`](https://github.com/MadAppGang/claudish/commit/b4265ff66e0c52eac57c513eee15a0f65e39dd3a))

### Documentation

- update CHANGELOG.md for v6.10.1([`8233ae5`](https://github.com/MadAppGang/claudish/commit/8233ae5cfc20c2e802b1239856c2337ec9d65c57))

### New Features

- v6.11.0 — Anthropic error format, SSE pings, web search detection([`a249eb4`](https://github.com/MadAppGang/claudish/commit/a249eb4a2e86ec2b3a023a2183d7a3a7b76fb0a7))

## [6.10.1] - 2026-04-07

### Documentation

- update CHANGELOG.md for v6.10.0([`aaf24f2`](https://github.com/MadAppGang/claudish/commit/aaf24f21df44867cf42770202d0d7ee0a0cd0033))

### New Features

- v6.10.1 — auto-update with changelog, single version source of truth([`de889eb`](https://github.com/MadAppGang/claudish/commit/de889eb6609145bb1a40643101b70236576be1e3))

## [6.10.0] - 2026-04-07

### Documentation

- update CHANGELOG.md for v6.9.1([`714b1b5`](https://github.com/MadAppGang/claudish/commit/714b1b5166662ea3aac3087faad51be0e896fd25))

### New Features

- v6.10.0 — Codex subscription OAuth, unified login/logout, quota registry([`a2dd1ea`](https://github.com/MadAppGang/claudish/commit/a2dd1ea156b96da16ac8021702edf614ce9ebe3d))

## [6.9.1] - 2026-04-06

### Documentation

- update CHANGELOG.md for v6.9.0([`3075035`](https://github.com/MadAppGang/claudish/commit/3075035e28ffc425917f3ccc0680f27f9b860693))

### Other Changes

- bump to v6.9.1 — verify magmux npm publishing([`3384f03`](https://github.com/MadAppGang/claudish/commit/3384f034facf1da80cef0061da7ed4e2d3b5815b))

## [6.9.0] - 2026-04-06

### Documentation

- update CHANGELOG.md for v6.8.1([`9b376b6`](https://github.com/MadAppGang/claudish/commit/9b376b6eb588441bcaf165764c41052303598bc2))

### New Features

- v6.9.0 — model catalog overhaul, team grid mode, Slack alerts([`de0b815`](https://github.com/MadAppGang/claudish/commit/de0b81554206fc3072f6e74549a3699220c2862e))

## [6.8.1] - 2026-04-06

### Documentation

- update CHANGELOG.md for v6.8.0([`d72520d`](https://github.com/MadAppGang/claudish/commit/d72520db1264cf6799a9c470f5fc94d1e86fe3a3))

### New Features

- platform-specific magmux npm packages + stripped binaries([`efd6bba`](https://github.com/MadAppGang/claudish/commit/efd6bba4dd71f3ae34e9868501d10941a10b9258))

### Other Changes

- bump to v6.8.1 — platform-specific magmux packages([`a03e995`](https://github.com/MadAppGang/claudish/commit/a03e99558e06c1bae0bdfb485d471716b1bbe785))

## [6.8.0] - 2026-04-06

### Documentation

- update CHANGELOG.md for v6.7.0([`57d6ae5`](https://github.com/MadAppGang/claudish/commit/57d6ae522dc11f9d3c9c08e0c78fca12817f745b))

### New Features

- v6.8.0 — add DeepSeek as native direct API provider([`a833000`](https://github.com/MadAppGang/claudish/commit/a833000d59d3a4ce5d610201bf967ea867dd9ead))

## [6.7.0] - 2026-04-06

### Documentation

- update CHANGELOG.md for v6.6.3([`dd7e6fb`](https://github.com/MadAppGang/claudish/commit/dd7e6fbe9d47df1ba63d4bfc30436ddbd7429c31))

### New Features

- v6.7.0 — replace mtm with magmux, improve catalog resolver, add OAuth manager([`6759005`](https://github.com/MadAppGang/claudish/commit/675900567be9f139aece1f674ed8f6880843bd89))

## [6.6.3] - 2026-04-06

### Bug Fixes

- handle magmux artifact names in release file preparation *(ci)* ([`c8aca08`](https://github.com/MadAppGang/claudish/commit/c8aca08575f3265c869ca85b7b79f04dad83f2a3))
- v6.6.3 — reject sentinel model names in team orchestrator([`e485263`](https://github.com/MadAppGang/claudish/commit/e485263cfdd99aeda77b195fb7de572274c355ce))
- reject sentinel model names in team orchestrator *(team)* ([`91ee9a8`](https://github.com/MadAppGang/claudish/commit/91ee9a811fb821dbd1f01214cdbfd977017ed96f))

### Documentation

- update CHANGELOG.md for v6.6.2([`4c071a6`](https://github.com/MadAppGang/claudish/commit/4c071a69e105daf92fb2967392b0637d1129074c))

## [6.6.2] - 2026-04-06

### Bug Fixes

- use Node 24 + always-auth for npm OIDC trusted publishing *(ci)* ([`9cfb12a`](https://github.com/MadAppGang/claudish/commit/9cfb12a86d21961fe01ec07894a144ac2af49230))
- remove FORCE_JAVASCRIPT_ACTIONS_TO_NODE24 from publish-npm *(ci)* ([`f44750d`](https://github.com/MadAppGang/claudish/commit/f44750df739616e942418ef4b9bc22124e89ccde))
- use Node 20 for npm publish — Node 22.22.2 npm is broken *(ci)* ([`0414155`](https://github.com/MadAppGang/claudish/commit/0414155ef090a8a2cd1ed3cb5b40d6d417c9ecfd))
- use npm@11 for OIDC publish compatibility *(ci)* ([`f0a746e`](https://github.com/MadAppGang/claudish/commit/f0a746edb08219210f0628d0a119f4fdd14791a3))
- v6.6.2 — Gemini image translation, CI npm fix([`bba0327`](https://github.com/MadAppGang/claudish/commit/bba03275bbfaf9cb8448eff00723d800d2094341))

### Documentation

- update CHANGELOG.md for v6.6.2([`dba5006`](https://github.com/MadAppGang/claudish/commit/dba5006456b9d9d6dc16e7581b95c206c9b71dce))
- update CHANGELOG.md for v6.6.2([`84a403b`](https://github.com/MadAppGang/claudish/commit/84a403b8c27326ea975668d5ae5ce6e22ddd7863))
- update CHANGELOG.md for v6.6.2([`ade7e09`](https://github.com/MadAppGang/claudish/commit/ade7e0933686c4f045916d52bc1780f4d511f25b))
- update CHANGELOG.md for v6.6.2([`fe30c6b`](https://github.com/MadAppGang/claudish/commit/fe30c6b56f0243da48c726baca7b0f6544d154f8))
- update CHANGELOG.md for v6.6.1([`5fd634b`](https://github.com/MadAppGang/claudish/commit/5fd634b40022fd2b8d332372db9091a1ab5119b5))

## [6.6.1] - 2026-04-06

### Bug Fixes

- v6.6.1 — OpenAI schema compatibility for bare object MCP tools([`8fe7373`](https://github.com/MadAppGang/claudish/commit/8fe73736d7f3a5d07ede283e407e7a5889f9a1ca))
- ensure properties:{} on bare object schemas for OpenAI compatibility([`99d3e73`](https://github.com/MadAppGang/claudish/commit/99d3e732f82e776a4d3d809666f95233c206fb55))
- quota bar without pill bg — add lowercase color codes to magmux([`d029001`](https://github.com/MadAppGang/claudish/commit/d0290013c04248ee593b88388fa257827b694f5e))

### Documentation

- update CHANGELOG.md for v6.6.0([`2bf5e9a`](https://github.com/MadAppGang/claudish/commit/2bf5e9a6b962e4b1bc15afc46702a62f10f4c9c0))

## [6.6.0] - 2026-04-01

### Bug Fixes

- cleaner status bar — remove ok pill, provider as plain text, mini quota bar([`a9ad5be`](https://github.com/MadAppGang/claudish/commit/a9ad5be2098dad03932b5e31e439553f93436f09))

### Documentation

- update CHANGELOG.md for v6.6.0([`5d186cb`](https://github.com/MadAppGang/claudish/commit/5d186cb84dfe695938c6e7f3d75a8e3d5b888798))
- update CHANGELOG.md for v6.5.3([`76e4df5`](https://github.com/MadAppGang/claudish/commit/76e4df586c651289b17196366cd4f5711a320058))

### New Features

- magmux v0.3.0 — grid mode, status bar, socket IPC, tint overlays([`4bbbce2`](https://github.com/MadAppGang/claudish/commit/4bbbce21f341405009ee06baac0a66e7c3c7245d))

## [6.5.3] - 2026-04-01

### Bug Fixes

- quota display in status bar — strip provider prefix, await fetch, rewrite token file([`b026b2f`](https://github.com/MadAppGang/claudish/commit/b026b2ff3d2a3b95530f3136e125971177315508))

### Documentation

- update CHANGELOG.md for v6.5.2([`67d4181`](https://github.com/MadAppGang/claudish/commit/67d418143f2ee718ee425ce7a26d6f32fb3e2f8d))

### Other Changes

- bump to v6.5.3([`1eafee8`](https://github.com/MadAppGang/claudish/commit/1eafee81943eb2d45ee552de3184935f8365205a))

## [6.5.2] - 2026-04-01

### Bug Fixes

- poll token file for provider/quota in magmux status bar([`15adbb4`](https://github.com/MadAppGang/claudish/commit/15adbb488a85d9b8827ad4b4dc1bb776c8c52647))

### Documentation

- update CHANGELOG.md for v6.5.1([`6f31af7`](https://github.com/MadAppGang/claudish/commit/6f31af73460921abcc3d6a896c48f30b0dd36538))

### Other Changes

- bump to v6.5.2([`7b5a267`](https://github.com/MadAppGang/claudish/commit/7b5a2678339b79af1a73c8e18a3bd28de27aca06))

## [6.5.1] - 2026-04-01

### Bug Fixes

- show provider name and quota in claudish status bar([`eb8693c`](https://github.com/MadAppGang/claudish/commit/eb8693c9b60ed3e6e7f007c7061f51918a07733d))

### Documentation

- update CHANGELOG.md for v6.5.0([`ad801f6`](https://github.com/MadAppGang/claudish/commit/ad801f66c7862212752442b455677857301367f2))

### Other Changes

- bump to v6.5.1([`9ed4074`](https://github.com/MadAppGang/claudish/commit/9ed40745d52c7a278faa7a00a15680a2fddfebd7))

## [6.5.0] - 2026-04-01

### Bug Fixes

- magmux set TERM=screen-256color (root cause of all VT issues)([`488cf7e`](https://github.com/MadAppGang/claudish/commit/488cf7e99a18321bdabb146b58e0f81ac39d5321))
- magmux handle Kitty keyboard protocol CSI sequences([`b4b02ff`](https://github.com/MadAppGang/claudish/commit/b4b02ff56261ca01067451dfc12de184f783090c))
- magmux filter CSI intermediate bytes to prevent SGR corruption([`ea6e723`](https://github.com/MadAppGang/claudish/commit/ea6e72339ed2a5a88ef123ba96998d5629c9c61a))
- magmux suppress underline SGR + fix border rendering order([`a1b20b0`](https://github.com/MadAppGang/claudish/commit/a1b20b0f61a0a6638681fe41781784e6eb70e8c9))

### Documentation

- MTM-to-magmux migration guide for claudish developers([`c296671`](https://github.com/MadAppGang/claudish/commit/c2966716e423e4b38efc8728df908825952e00c4))
- add magmux usage guide to claudish documentation([`6ea796d`](https://github.com/MadAppGang/claudish/commit/6ea796dba3f0c5faa31a2f51315e281ab605ce66))
- update CHANGELOG.md for v6.4.6([`84674f5`](https://github.com/MadAppGang/claudish/commit/84674f5c8b6f05a92940531c300f3549091bc9a3))

### New Features

- v6.5.0 — Gemini Code Assist overhaul, auth commands, quota CLI, Codex OAuth([`f9b1c54`](https://github.com/MadAppGang/claudish/commit/f9b1c54682d16cf8684d3ec8ce4b4201cddef59d))
- magmux VT parser — implement tmux-equivalent escape sequence coverage([`c8abea2`](https://github.com/MadAppGang/claudish/commit/c8abea2f2023119f62c7e10def176ffdd87d938f))
- team grid mode — mtm-based multi-model visual display([`3da53f1`](https://github.com/MadAppGang/claudish/commit/3da53f196c90c2790d009af39ea1cf8573e9cc91))

### Performance

- magmux dirty-flag rendering — skip redraws when nothing changed([`7fb0eb3`](https://github.com/MadAppGang/claudish/commit/7fb0eb34e8d69c673c4e649beb5070e1b30e6fde))

## [6.4.6] - 2026-03-30

### Bug Fixes

- v6.4.6 - subcommand routing broken when shell alias prepends flags([`3d40667`](https://github.com/MadAppGang/claudish/commit/3d406677606b9c31b1cc638f017964e5edb2138f))

### Documentation

- update CHANGELOG.md for v6.4.5([`9751770`](https://github.com/MadAppGang/claudish/commit/975177019310c5a07f0fe38b0878e5d101e9aee1))

### New Features

- magmux - Go terminal multiplexer replacing C MTM implementation([`4e436e9`](https://github.com/MadAppGang/claudish/commit/4e436e9380b4c104072fab2cd880154270b9a70c))
- add plugin defaults endpoint for Magus plugin system([`c43d927`](https://github.com/MadAppGang/claudish/commit/c43d9277fca41ffbc28013102094187a90a97103))

## [6.4.5] - 2026-03-28

### Bug Fixes

- v6.4.5 - enforce per-model tool count limits (OpenAI 128 max)([`498a2ed`](https://github.com/MadAppGang/claudish/commit/498a2ede644daa5ed67e7119143ecedfb607f5dc))

### New Features

- v6.4.4 - team-grid orchestrator for parallel multi-model execution([`1971b71`](https://github.com/MadAppGang/claudish/commit/1971b7193aa34e160cee31fd1fc39c0685c0e48a))

## [6.4.3] - 2026-03-28

### Bug Fixes

- v6.4.3 - error reporting hints on all MCP tool failures, mtm grid improvements([`781362b`](https://github.com/MadAppGang/claudish/commit/781362bd9e207145f8458ecf1be955633a5ba2a3))

### Documentation

- update documentation for channel mode and v6.4.2([`db9fcdb`](https://github.com/MadAppGang/claudish/commit/db9fcdb9dc76075a99e06cabdadfed05424c1381))
- update CHANGELOG.md for v6.4.2([`431a473`](https://github.com/MadAppGang/claudish/commit/431a4734c1284d345324ac2d5350dbf47749c19a))

## [6.4.2] - 2026-03-28

### Bug Fixes

- v6.4.2 - channel mode test coverage + scrollback indexOf bug fix([`d2610e8`](https://github.com/MadAppGang/claudish/commit/d2610e880c60a8d1a63f8872178a8f0020be443b))
- add ignoreUndefinedProperties for Firestore writes([`fef0a59`](https://github.com/MadAppGang/claudish/commit/fef0a596427985761c61a4e5b4a3c47567c91db9))

### Documentation

- update CHANGELOG.md for v6.4.1([`7b1e6ec`](https://github.com/MadAppGang/claudish/commit/7b1e6ec921d4c31bddee1af7ef1b1804211f365a))

### New Features

- model catalog collector — Firebase Cloud Functions([`4e97178`](https://github.com/MadAppGang/claudish/commit/4e9717890cc492852a09f6eeb1eefa0ab00ffc3d))

### Other Changes

- change catalog schedule from every 6h to daily at 03:00 UTC([`a1b5d91`](https://github.com/MadAppGang/claudish/commit/a1b5d915a061a72a914d6adbd1dc36e123e211d5))

## [6.4.1] - 2026-03-28

### Bug Fixes

- v6.4.1 - fix mtm underline rendering, use xterm-256color TERM([`dd74640`](https://github.com/MadAppGang/claudish/commit/dd74640b5fea09e891735b4b7661a9bf7f094ba6))
- parseLogMessage regex, mtm rendering artifacts, fallback caching([`199b04e`](https://github.com/MadAppGang/claudish/commit/199b04eaa0851a336b2e789673846625170a4a2b))

### Documentation

- update CHANGELOG.md for v6.4.0([`ba5c7c3`](https://github.com/MadAppGang/claudish/commit/ba5c7c352a29916b1c6b009f7b4e7e0e95e080b6))

## [6.4.0] - 2026-03-27

### Documentation

- update CHANGELOG.md for v6.3.2([`79e9fa4`](https://github.com/MadAppGang/claudish/commit/79e9fa43d4736d2542e07235d85856e006a8cecf))

### New Features

- v6.4.0 - MCP multi-provider routing, channel system, TUI overhaul([`1f667cb`](https://github.com/MadAppGang/claudish/commit/1f667cb4ff646b9200de4407a0ddbd491bfb9479))

## [6.3.2] - 2026-03-25

### Bug Fixes

- v6.3.2 - rebuild mtm binary with -L flag support, remove debug code([`8842ac2`](https://github.com/MadAppGang/claudish/commit/8842ac2277a2b0268d8677e7c4490eb4dce13f42))

### Documentation

- update CHANGELOG.md for v6.3.1([`ec18d6b`](https://github.com/MadAppGang/claudish/commit/ec18d6b4e3f9965b0b1c85320eb1fc807786d557))

## [6.3.1] - 2026-03-25

### Bug Fixes

- v6.3.1 - Gemini Code Assist auth failure falls through to Direct API([`692e207`](https://github.com/MadAppGang/claudish/commit/692e207e0895b20ba9ef07a79d936be6170cca77))
- Gemini Code Assist auth failure now falls through to Google Direct API([`f063aad`](https://github.com/MadAppGang/claudish/commit/f063aade21fc6e6ba1a4b5134a506267a50907e9))

### Documentation

- update CHANGELOG.md for v6.3.0([`8f3bdc4`](https://github.com/MadAppGang/claudish/commit/8f3bdc4245aa4f2f9ba659762936615cafd87d11))

## [6.3.0] - 2026-03-25

### Documentation

- update CHANGELOG.md for v6.3.0([`eb5ac71`](https://github.com/MadAppGang/claudish/commit/eb5ac7172e679fc6cee378288d1b55d0d8ad5e66))
- update CHANGELOG.md for v6.2.2([`6ffafd4`](https://github.com/MadAppGang/claudish/commit/6ffafd4512aa05b8d0c455d907f58db87a6007a0))

### New Features

- expandable diagnostics panel — click status bar or Ctrl-G d to toggle([`42debca`](https://github.com/MadAppGang/claudish/commit/42debca56ae15f19f5e6c39c87b384f7bad1d9e5))
- v6.3.0 - TUI redesign, provider key test, route probe([`207813a`](https://github.com/MadAppGang/claudish/commit/207813acb05637df083613ea14d7e5e0f477bf55))

### Other Changes

- update landing page model names to latest versions (March 2026)([`63f652c`](https://github.com/MadAppGang/claudish/commit/63f652cec86919efbaf167ad9348ea545ab5c3a7))

## [6.2.2] - 2026-03-24

### Bug Fixes

- v6.2.2 - include mtm binary in npm package (CI fix)([`2c50c2c`](https://github.com/MadAppGang/claudish/commit/2c50c2c9c0c5a3f153ef7ae31d7c6c1c8cb3d550))
- include native/mtm binaries in npm publish CI step([`b14e4e0`](https://github.com/MadAppGang/claudish/commit/b14e4e0d29377e058e8b08e283a232a1c6bea48d))

### Documentation

- update CHANGELOG.md for v6.2.1([`fd04d4e`](https://github.com/MadAppGang/claudish/commit/fd04d4ebd8296ac64e0923a99acb1fb4deafa9d1))

## [6.2.1] - 2026-03-24

### Bug Fixes

- v6.2.1 - bundle mtm binary, reject upstream mtm, fix path resolution([`c8df199`](https://github.com/MadAppGang/claudish/commit/c8df199d8efa625870a53a68f8ac6612fb00e1d0))
- add 429 retry with exponential backoff to OpenAI transport (#66)([`9ac8991`](https://github.com/MadAppGang/claudish/commit/9ac8991deaf65e08c85e5100a3fe7dc70130452e))

### Documentation

- update CHANGELOG.md for v6.2.0([`68bf83c`](https://github.com/MadAppGang/claudish/commit/68bf83c6377c595de8452cde07d023870a627d78))

## [6.2.0] - 2026-03-24

### Documentation

- update CHANGELOG.md for v6.1.1([`d0af752`](https://github.com/MadAppGang/claudish/commit/d0af752ae85e69fda091906adc9ef9259089fcd2))

### New Features

- v6.2.0 - isProviderAvailable interface, xAI provider, model selector improvements([`e84dcc6`](https://github.com/MadAppGang/claudish/commit/e84dcc608dc9695b2f48b7d2fbe95cf3288bc070))

## [6.1.1] - 2026-03-24

### Bug Fixes

- v6.1.1 - Zen Go routing, OpenAI schema sanitization, Kimi reasoning_content([`6563f13`](https://github.com/MadAppGang/claudish/commit/6563f13b748387143e1481b3c2feb70d56943056))

### Documentation

- update CHANGELOG.md for v6.1.0([`dfb7abd`](https://github.com/MadAppGang/claudish/commit/dfb7abd476e3d3f402cd0190d52e2141af11cb26))

### New Features

- first-run auto-approve confirmation (#57)([`aff10b2`](https://github.com/MadAppGang/claudish/commit/aff10b27366eeac7202b4227a7d6764b22005f9e))

## [6.1.0] - 2026-03-23

### Bug Fixes

- ad-hoc sign macOS binaries for Gatekeeper compatibility (#73)([`e1eb919`](https://github.com/MadAppGang/claudish/commit/e1eb91930c1ac99427eff77e3c041ce768c7841a))

### Documentation

- update CHANGELOG.md for v6.0.1([`05ae6a2`](https://github.com/MadAppGang/claudish/commit/05ae6a21c4304a86f5186567912a9173224fc527))

### New Features

- v6.1.0 - centralized model catalog and MiniMax Anthropic API fixes([`fa0cf0f`](https://github.com/MadAppGang/claudish/commit/fa0cf0f0e17dda06e34bdd5707bec1c1603ac995))

## [6.0.1] - 2026-03-23

### Bug Fixes

- v6.0.1 - statusline input_tokens and -p flag conflict([`0b46b5f`](https://github.com/MadAppGang/claudish/commit/0b46b5f7253187d1ff1efb5d6c25bae22d37f9b6))
- statusline input_tokens (#74) and -p flag conflict (#76)([`056835c`](https://github.com/MadAppGang/claudish/commit/056835c69d278d4e1e7b42d62d7edbc799c87586))

### Documentation

- update CHANGELOG.md for v6.0.0([`a791d14`](https://github.com/MadAppGang/claudish/commit/a791d14a76c7d1092e864bbe4922114339215051))

## [6.0.0] - 2026-03-22

### Documentation

- update CHANGELOG.md for v5.19.0([`48c12f5`](https://github.com/MadAppGang/claudish/commit/48c12f5f9479bf121ba3763c992b697681591f02))

### New Features

- v6.0.0 - three-layer architecture rename (APIFormat / ModelDialect / ProviderTransport)([`14efceb`](https://github.com/MadAppGang/claudish/commit/14efceb0fdb819f07180bcef7540eab7d7f7fe05))

## [5.19.0] - 2026-03-22

### Bug Fixes

- include missing files for v5.19.0 CI build([`655644d`](https://github.com/MadAppGang/claudish/commit/655644d1f8020063ed00a8cba690922440d0eb3e))
- remove stale tests/ directory and export team-orchestrator helpers([`1608186`](https://github.com/MadAppGang/claudish/commit/1608186681974f18a66bb6de2b4f09f23b1051e5))

### Documentation

- update CHANGELOG.md for v5.18.1([`dfcef8f`](https://github.com/MadAppGang/claudish/commit/dfcef8f46ee4b4d8c2c09819635c82c139362ea7))

### New Features

- v5.19.0 - MCP team orchestrator, error reporting, TUI redesign([`821d348`](https://github.com/MadAppGang/claudish/commit/821d3484fd10b03d8317a91471e5358104f07939))

### Other Changes

- add FORCE_JAVASCRIPT_ACTIONS_TO_NODE24 to all CI jobs([`1524747`](https://github.com/MadAppGang/claudish/commit/15247478063f2ce35ba391badea6aead1e5bf5aa))
- upgrade GitHub Actions to Node.js 24 compatibility([`a2a6aca`](https://github.com/MadAppGang/claudish/commit/a2a6acace88313bef25b50f16948d520c1da12bf))

## [5.18.1] - 2026-03-22

### Documentation

- update CHANGELOG.md for v5.18.0([`3e934c5`](https://github.com/MadAppGang/claudish/commit/3e934c592263e58afb3885c3a4c03d982a004558))

### New Features

- v5.18.1 - API key provenance in debug logs and --probe([`cedd48d`](https://github.com/MadAppGang/claudish/commit/cedd48d22bd26e68a99a43269caeee83c987f073))
- API key provenance tracking in debug logs and --probe (#83)([`c9996a1`](https://github.com/MadAppGang/claudish/commit/c9996a155515e1e4a588d177a7204bee8b442fe8))

## [5.18.0] - 2026-03-21

### Documentation

- update CHANGELOG.md for v5.17.0([`edff2d2`](https://github.com/MadAppGang/claudish/commit/edff2d245726937940f203ec0a74441b9e504ae8))

### New Features

- v5.18.0 - auto-detect Gemini subscription tier on login([`d691140`](https://github.com/MadAppGang/claudish/commit/d691140a36ceae1bb66f8bbc2b7c4621ef86974e))

## [5.17.0] - 2026-03-20

### Bug Fixes

- release.yml heredoc syntax for GitHub Actions YAML parser([`3265a74`](https://github.com/MadAppGang/claudish/commit/3265a748fa2b5e760a6f898635ff71ffb58819f4))

### New Features

- v5.17.0 - automatic changelog generation with git-cliff([`c7caef9`](https://github.com/MadAppGang/claudish/commit/c7caef9987d55d2b0bb3728c77b06cb62925e7ee))

## [5.16.2] - 2026-03-20

### Bug Fixes

- v5.16.2 - target correct tmux pane for diag split([`e328d6b`](https://github.com/MadAppGang/claudish/commit/e328d6bc3fd0de6f95bdb962623ef55d3c5a41bf))

## [5.16.1] - 2026-03-20

### Refactoring

- v5.16.1 - single source of truth for provider definitions, fix adapter matching([`072697b`](https://github.com/MadAppGang/claudish/commit/072697bf7405f6cc47a655b8c0188cb79528efdc))
- single source of truth for provider definitions + fix adapter matching (#82)([`7fb091d`](https://github.com/MadAppGang/claudish/commit/7fb091d1ff4dcd3a7177f1b37f7efa50d4721779))

## [5.16.0] - 2026-03-20

### New Features

- v5.16.0 - DiagOutput for clean diagnostic display([`b8f82d8`](https://github.com/MadAppGang/claudish/commit/b8f82d87dc09aca56fd0945e8e2a8d4f34602ea2))
- DiagOutput — separate claudish diagnostics from Claude Code TUI([`e53b7fc`](https://github.com/MadAppGang/claudish/commit/e53b7fcc46afcd1923fefdbe8aba160dad5069ef))

## [5.15.0] - 2026-03-19

### Bug Fixes

- include team-cli and mcp-server files needed for CI build([`723a1e9`](https://github.com/MadAppGang/claudish/commit/723a1e9ed2a4878d9f0463160221c9388da3e935))
- preserve real auth credentials when native Claude models are in config([`f356328`](https://github.com/MadAppGang/claudish/commit/f356328f302098eb9fb0a69751b0f35021ba8c33))

### Documentation

- update CLAUDE.md with 3-layer architecture and debug-logs workflow([`b8dce83`](https://github.com/MadAppGang/claudish/commit/b8dce83c3f1772f658387943f64e3c8c3eb144d9))

### New Features

- v5.15.0 - XiaomiAdapter, dynamic OpenRouter context windows, fix all hardcoded context sizes([`bff916c`](https://github.com/MadAppGang/claudish/commit/bff916cd27f3e384404d80085174267ea7c340c1))
- always-on structural logging without --debug([`2f1b284`](https://github.com/MadAppGang/claudish/commit/2f1b284e8328146d5c7c96a5af8862992b79bb39))

## [5.14.0] - 2026-03-18

### Bug Fixes

- upgrade MCP SDK to ^1.27.0 to fix Zod 4 tool schema serialization([`951963c`](https://github.com/MadAppGang/claudish/commit/951963cec7880686ac2a71117ecd0fe44abfc88b))
- add ToolSearch to tool-call-recovery inference (#63)([`5a2afcf`](https://github.com/MadAppGang/claudish/commit/5a2afcfb2a3aab1f8d22f84bb04bc3b243444e7a))
- resolve spawn EINVAL on Windows when Claude binary is a .cmd file (#67)([`e511efa`](https://github.com/MadAppGang/claudish/commit/e511efa0f94b01ef36d6955032684184ea9df14d))

### New Features

- v5.14.0 - adapter architecture rearchitecture with 3-layer separation([`871f338`](https://github.com/MadAppGang/claudish/commit/871f3387c6e68dba4b3820aa711aaa6f3bcb3bb2))

## [5.13.4] - 2026-03-18

### Bug Fixes

- v5.13.4 - suppress stderr during interactive Claude Code sessions([`7cdf94d`](https://github.com/MadAppGang/claudish/commit/7cdf94d5b3c842c088ed625de26b62c8d18575d2))

## [5.13.3] - 2026-03-18

### Bug Fixes

- v5.13.3 - clean error display and openrouter/ native prefix support([`af2daec`](https://github.com/MadAppGang/claudish/commit/af2daec0cc6afee0c8b6ac98267e81c16a01df1d))

## [5.13.2] - 2026-03-18

### Bug Fixes

- v5.13.2 - recognize openrouter/ vendor prefix in model parser([`2e3d0fc`](https://github.com/MadAppGang/claudish/commit/2e3d0fc2db673f2446482253185f8af51d11bcf1))

## [5.13.1] - 2026-03-16

### Bug Fixes

- v5.13.1 - use Zen Go (subscription) instead of Zen (credits) in default fallback chain([`b610462`](https://github.com/MadAppGang/claudish/commit/b6104628906722173a311f30c475282b9fc26c4e))

## [5.13.0] - 2026-03-16

### New Features

- v5.13.0 - anonymous usage stats with OTLP format([`ca0d015`](https://github.com/MadAppGang/claudish/commit/ca0d015c4d03f5456b89aac3720605067c38a40b))

## [5.12.3] - 2026-03-16

### Bug Fixes

- v5.12.3 - Node.js launcher with Bun detection([`5c8a99b`](https://github.com/MadAppGang/claudish/commit/5c8a99be6a3ecbc02d9c32ce745cbb45d579ab3b))

## [5.12.2] - 2026-03-16

### Bug Fixes

- v5.12.2 - switch from Node to Bun runtime target([`5e85801`](https://github.com/MadAppGang/claudish/commit/5e858010ff31ee4db2aeadb319a857f676379453))

## [5.12.1] - 2026-03-16

### Bug Fixes

- v5.12.1 - exclude OpenTUI bun:ffi from Node bundle([`a0150ea`](https://github.com/MadAppGang/claudish/commit/a0150ead59f4eb8ad5ede4b610a7a742f7a46790))

## [5.12.0] - 2026-03-16

### Bug Fixes

- update landing page with brew install and v5.11.0 badge([`00438ee`](https://github.com/MadAppGang/claudish/commit/00438ee856a6e4988dcab8c506195a2470999b4a))
- add "no healthy deployment" to retryable errors for LiteLLM fallback([`8bdff19`](https://github.com/MadAppGang/claudish/commit/8bdff19d3b8c86924ecdc895c35e04bee2167acc))
- dynamically fetch top models from OpenRouter API([`71f5b1d`](https://github.com/MadAppGang/claudish/commit/71f5b1d501a5aa381cb32b4342d06c4255292646))
- use canonical homebrew-tap repo name in CI([`ca3053f`](https://github.com/MadAppGang/claudish/commit/ca3053fcabb83acff90c47ece10706cc93ceb11d))

### New Features

- v5.12.0 - LiteLLM fallback fix, dynamic top models([`37f27e4`](https://github.com/MadAppGang/claudish/commit/37f27e410ca6ecc9418ccb2a06c3d8827295dc90))

## [5.11.0] - 2026-03-15

### Bug Fixes

- skip vision probe for glm (glm-5 is text-only) *(smoke)* ([`cb8660c`](https://github.com/MadAppGang/claudish/commit/cb8660c912089d192c17d7016502d867ce4cb436))

### New Features

- v5.11.0 - config TUI, API key storage, Homebrew tap migration([`5de8c2c`](https://github.com/MadAppGang/claudish/commit/5de8c2ce4de5bc22b30519bc8f9d7d063d246d18))

## [5.10.0] - 2026-03-15

### Bug Fixes

- revert minimax supportsVision to true, skip in smoke only *(smoke)* ([`92a8d1a`](https://github.com/MadAppGang/claudish/commit/92a8d1aeab738b13d612e77a53c8508a084619d6))
- glm-coding representative model codegeex-4 → glm-5 *(smoke)* ([`a6c0b6e`](https://github.com/MadAppGang/claudish/commit/a6c0b6ebae0564d174beae05613c9a956fb4891b))
- fix zen-go reasoning, enable glm-coding, fix minimax vision *(smoke)* ([`534053f`](https://github.com/MadAppGang/claudish/commit/534053f0bf0bc2aef2bfdb785177134ab61fd0a0))
- re-enable minimax provider (balance topped up) *(smoke)* ([`3526ba5`](https://github.com/MadAppGang/claudish/commit/3526ba5a78b0ea04df87bb9dab757cc041daf663))
- skip minimax provider (redundant with minimax-coding) *(smoke)* ([`d253a5a`](https://github.com/MadAppGang/claudish/commit/d253a5a1246990dced5668965425f58847c4ae1a))
- add LITELLM_BASE_URL to smoke test workflow env *(smoke)* ([`795df6b`](https://github.com/MadAppGang/claudish/commit/795df6bbdfce33ac34d6a46b450103e9369c8f56))

### Documentation

- update landing page hero version to v5.9.0([`aa0bd65`](https://github.com/MadAppGang/claudish/commit/aa0bd651c2ed3903819f3ce3b449950e3334a1f2))

### New Features

- v5.10.0 - custom routing rules, 429 retryable, smoke test fixes([`e38af0e`](https://github.com/MadAppGang/claudish/commit/e38af0e526421de555a4d96c75d08291911a5aba))

## [5.9.0] - 2026-03-14

### Bug Fixes

- fix tool probe, opencode-zen model, minimax-coding vision *(smoke)* ([`5072d5b`](https://github.com/MadAppGang/claudish/commit/5072d5b1eefca16bcffccf1bb81611c9e46d0610))
- litellm representative model → gemini-2.5-flash (gpt-4o-mini not deployed) *(smoke)* ([`b2bb925`](https://github.com/MadAppGang/claudish/commit/b2bb925208fb89bc4942e055924c33ea080d6210))

### New Features

- v5.9.0 - provider fallback chain for auto-routed models([`dfb60dd`](https://github.com/MadAppGang/claudish/commit/dfb60dd01055a87adef9ad12fcdb71345c0f7dd1))

## [5.8.0] - 2026-03-06

### New Features

- v5.8.0 - periodic smoke test suite for all providers([`df24c7d`](https://github.com/MadAppGang/claudish/commit/df24c7d7dcd803cb803d4ea59f930e56e7ef5275))

## [5.7.1] - 2026-03-06

### Bug Fixes

- v5.7.1 - strip tool_reference blocks; fix qwen OpenRouter vendor prefix([`b8ea099`](https://github.com/MadAppGang/claudish/commit/b8ea099efcad1fdfb7036cb0519e348f87731c9f))

### Documentation

- v5.7.0 - update README and CHANGELOG for Zen Go provider([`f3cef40`](https://github.com/MadAppGang/claudish/commit/f3cef403c3bece598bade12f6b482d92cbd0bd01))

## [5.7.0] - 2026-03-06

### New Features

- v5.7.0 - add OpenCode Zen Go provider (zgo@) with live model discovery([`10afe39`](https://github.com/MadAppGang/claudish/commit/10afe39531a2b76cc63c8e1cf46713602eb278e6))

## [5.6.1] - 2026-03-05

### Bug Fixes

- v5.6.1 - fix MiniMax direct API auth (Bearer vs x-api-key)([`74d1f84`](https://github.com/MadAppGang/claudish/commit/74d1f842023fe7285d56c510fee72888b404346b))
- switch direct API auth from x-api-key to Authorization: Bearer *(minimax)* ([`0d96b8c`](https://github.com/MadAppGang/claudish/commit/0d96b8c86fd5eb55dcece4dbc810538b279d2464))

## [5.6.0] - 2026-03-05

### New Features

- v5.6.0 - auto-resolve vendor prefixes for OpenRouter and LiteLLM([`8703b2a`](https://github.com/MadAppGang/claudish/commit/8703b2a083269a45a798f2cebea2f135f4e9a3d0))

## [5.5.2] - 2026-03-03

### Bug Fixes

- v5.5.2 - truncateContent crash on undefined content([`3c047ca`](https://github.com/MadAppGang/claudish/commit/3c047ca94d9978756004ab8796382829af06fe58))

## [5.5.1] - 2026-03-03

### Bug Fixes

- v5.5.1 - consolidate duplicate update command into single path([`7bdfa14`](https://github.com/MadAppGang/claudish/commit/7bdfa147d0473a74971204b88ceae344ed9254c0))

## [5.5.0] - 2026-03-03

### New Features

- v5.5.0 - provider-agnostic recommended models and GLM adapter([`ccde45b`](https://github.com/MadAppGang/claudish/commit/ccde45b43a34b5b9ed3698f356ef611f09b47231))

## [5.4.1] - 2026-03-03

### Bug Fixes

- v5.4.1 - monitor mode no longer sets invalid model name([`956f513`](https://github.com/MadAppGang/claudish/commit/956f513fd179519640e07ea7bbd31a01af8f3e1d))
- monitor mode no longer sets ANTHROPIC_MODEL="unknown"([`f333e11`](https://github.com/MadAppGang/claudish/commit/f333e1156d0aa708eed1699f309e564f4ebd057c))

## [5.4.0] - 2026-03-03

### New Features

- v5.4.0 - anonymous error telemetry with opt-in consent([`5ac3df1`](https://github.com/MadAppGang/claudish/commit/5ac3df1b9309d9ed8152484ba92a7e57be0f5a7c))

## [5.3.1] - 2026-03-02

### Bug Fixes

- v5.3.1 - provider error visibility and quiet suppression([`066d058`](https://github.com/MadAppGang/claudish/commit/066d058c1cf20a53d8ba9e6c6db17bd146a85fca))

## [5.3.0] - 2026-03-02

### New Features

- v5.3.0 - Claude Code flag passthrough([`8422c59`](https://github.com/MadAppGang/claudish/commit/8422c59e85095669df516bdf52e049d9d6e694ca))

## [5.2.0] - 2026-02-26

### New Features

- v5.2.0 - auto model routing without provider prefix([`cabcef3`](https://github.com/MadAppGang/claudish/commit/cabcef3b14afb26654676cbf7b04f8062f6e04ea))

## [5.1.2] - 2026-02-25

### Bug Fixes

- v5.1.2 - fix landing page CI deploy (bun lockfile, Firebase project ID)([`63a9c4f`](https://github.com/MadAppGang/claudish/commit/63a9c4f03615baeda614483f05009a109f0e3c9e))
- use bun instead of pnpm for landing page deploy, correct Firebase project ID([`ff34904`](https://github.com/MadAppGang/claudish/commit/ff349040609f2009b585017cd180154ccdfce183))

## [5.1.1] - 2026-02-25

### Bug Fixes

- include LiteLLM models in --models search and listing([`06ee4e6`](https://github.com/MadAppGang/claudish/commit/06ee4e6eea9b9b2177a8266a4c19409da547b59c))
- v5.1.1 - unset CLAUDECODE env var for nested session compatibility([`9c62ca9`](https://github.com/MadAppGang/claudish/commit/9c62ca97b6c6f30ea165b1ff6aace32c3eedff56))
- v5.1.0 - landing page vision section, Gemini pricing, lint fixes([`bf9ac8c`](https://github.com/MadAppGang/claudish/commit/bf9ac8cc4238f9ee5eaee3aee120c520e3b74940))

### Documentation

- add vision proxy section to README([`0029cde`](https://github.com/MadAppGang/claudish/commit/0029cdedd20776e5b889ec60de4361ea05db9647))

### New Features

- add Changelog section to landing page with auto-deploy on release([`8aa64a7`](https://github.com/MadAppGang/claudish/commit/8aa64a77fec4a78f702b030504b1c6c43f5cdeeb))
- auto-generate structured release notes from conventional commits([`ada936f`](https://github.com/MadAppGang/claudish/commit/ada936fe3a011394b3867296773d775df7320a21))

## [5.1.0] - 2026-02-19

### New Features

- v5.1.0 - vision proxy for non-vision models([`355bbb0`](https://github.com/MadAppGang/claudish/commit/355bbb063903f473d23f31a9c4503a6226a4d91a))

## [5.0.0] - 2026-02-18

### New Features

- v5.0.0 - composable handler architecture, minimax-coding provider([`fdcadd5`](https://github.com/MadAppGang/claudish/commit/fdcadd51eac54d27eab34b3b6be9cee29db5cce8))

## [4.6.11] - 2026-02-16

### Bug Fixes

- v4.6.11 - sync reasoning_content fix to packages/cli([`0b46f87`](https://github.com/MadAppGang/claudish/commit/0b46f87857cc93ba9fcffa93f0f0f5b2546fe686))

## [4.6.10] - 2026-02-16

### Bug Fixes

- v4.6.10 - handle reasoning_content for Kimi thinking models via LiteLLM([`8af631c`](https://github.com/MadAppGang/claudish/commit/8af631cce5dac500ae1e6185503c141b9d0324b0))

## [4.6.9] - 2026-02-15

### Bug Fixes

- v4.6.9 - force-update clears all model caches, add --list-models alias([`618db96`](https://github.com/MadAppGang/claudish/commit/618db96fea42dec51c0c421533ad02e47e1932c3))
- add User-Agent header for Kimi models via LiteLLM([`6758f21`](https://github.com/MadAppGang/claudish/commit/6758f211dbd994d2a1e2369acf324746b3dd75d8))
- convert image_url to inline base64 for MiniMax via LiteLLM([`6be13ee`](https://github.com/MadAppGang/claudish/commit/6be13eebb66d90ca45cef93d0aa6131bab83782e))

## [4.6.8] - 2026-02-14

### Bug Fixes

- v4.6.8 - sync LiteLLM handler to packages/cli for npm publish([`7d27f2d`](https://github.com/MadAppGang/claudish/commit/7d27f2dead831a67bee768e1fdb540a5a5285fcf))

## [4.6.7] - 2026-02-14

### Bug Fixes

- v4.6.7 - strip images for non-vision GLM models([`e8b676e`](https://github.com/MadAppGang/claudish/commit/e8b676e57121fb8819850aa5a8879dcf325448ab))

## [4.6.6] - 2026-02-13

### Bug Fixes

- v4.6.6 - use Promise.allSettled for provider fetches([`130a00f`](https://github.com/MadAppGang/claudish/commit/130a00fe2e31839ea880073cab8a2098518e9fe8))

## [4.6.5] - 2026-02-13

### New Features

- v4.6.5 - interactive provider filter in model selector([`a937998`](https://github.com/MadAppGang/claudish/commit/a9379989eb0f6913f5a9f0d64348edff270e3e4e))

## [4.6.4] - 2026-02-13

### New Features

- v4.6.4 - add @provider filter to interactive model search([`8631bf0`](https://github.com/MadAppGang/claudish/commit/8631bf08605da02aa12834e971f0c7ffc04eada0))

## [4.6.3] - 2026-02-13

### Bug Fixes

- v4.6.3 - remove silent provider fallback, fix LiteLLM endpoint([`1b30325`](https://github.com/MadAppGang/claudish/commit/1b30325c416a54b436c622db24e97a54e93e1cde))

## [4.6.2] - 2026-02-13

### Bug Fixes

- v4.6.2 - sync LiteLLM model discovery to packages/cli for npm publish([`1db5432`](https://github.com/MadAppGang/claudish/commit/1db5432c305fc72d9f0210eb7a70155f9ee9f7aa))

## [4.6.1] - 2026-02-12

### Bug Fixes

- v4.6.1 - model routing and self-update fixes([`0b972e3`](https://github.com/MadAppGang/claudish/commit/0b972e36526b01131caa30b5001a771f2d8a27a3))

### Documentation

- update CLAUDE.md with version bump checklist and LiteLLM shortcut([`4bb7ea3`](https://github.com/MadAppGang/claudish/commit/4bb7ea32f39d5b0d5d970b9e05943cdc0226a99b))

## [4.6.0] - 2026-02-12

### Bug Fixes

- update packages/cli/package.json version to 4.6.0([`20d4fb7`](https://github.com/MadAppGang/claudish/commit/20d4fb77751ed22cfe4d5471e7cb394f120b27dd))

### New Features

- v4.6.0 - LiteLLM provider support([`fdf3719`](https://github.com/MadAppGang/claudish/commit/fdf371948c737ef85ecf9fbd60170d4fffe61403))

## [4.5.3] - 2026-02-12

### New Features

- v4.5.3 - OllamaCloud/GLM model discovery, fuzzy search improvements([`bdd27e5`](https://github.com/MadAppGang/claudish/commit/bdd27e5437d470953cfa0faeccca7635b0202db0))

## [4.5.2] - 2026-02-12

### New Features

- v4.5.2 - GLM Coding Plan provider, local/global profiles, landing page updates([`dda1c3a`](https://github.com/MadAppGang/claudish/commit/dda1c3aadb361b847dc89744ebcb41424fc91d6c))

## [4.5.1] - 2026-02-09

### New Features

- v4.5.1 - Kimi Coding provider sync and model updates([`5575ea6`](https://github.com/MadAppGang/claudish/commit/5575ea6732fd3192da2ab5f6ac98bd18b053ad45))

## [4.5.0] - 2026-02-06

### New Features

- v4.5.0 - Profile-based model routing and dynamic status line([`e0aa3eb`](https://github.com/MadAppGang/claudish/commit/e0aa3ebb76335161f075f41d035f1365cc587bad))

## [4.4.5] - 2026-02-03

### New Features

- v4.4.5 - Progress bar for context display, Vertex routing fix([`25d70ba`](https://github.com/MadAppGang/claudish/commit/25d70baa233e6d3ba3d8e8d96e0d3e42420aa212))

## [4.4.4] - 2026-02-03

### Bug Fixes

- v4.4.4 - Use models.dev API for accurate OpenAI context windows([`c85dddf`](https://github.com/MadAppGang/claudish/commit/c85dddf3a16ea3a8f915d4339da4e481aa667845))

### Other Changes

- add original OG image for landing page([`796d4a0`](https://github.com/MadAppGang/claudish/commit/796d4a0347b10136d6dca93fbac629797a7f9762))

## [4.4.3] - 2026-01-30

### Bug Fixes

- v4.4.3 - Add missing getToolNameMap method and tool-name-utils([`f9e885b`](https://github.com/MadAppGang/claudish/commit/f9e885bf6b28f001bcf578a32194942b1526b2fa))

## [4.4.2] - 2026-01-30

### Bug Fixes

- v4.4.2 - Fix update command with -y flag alias([`fe3f280`](https://github.com/MadAppGang/claudish/commit/fe3f28057655a07f35fd505b380607d84dbd492d))

## [4.4.1] - 2026-01-30

### New Features

- v4.4.1 - Add claudish update command([`ae44988`](https://github.com/MadAppGang/claudish/commit/ae449880d8f2d2ecc18c17f333e18b66f79b4954))

## [4.4.0] - 2026-01-30

### New Features

- v4.4.0 - Interactive model selector improvements([`89fd34e`](https://github.com/MadAppGang/claudish/commit/89fd34e1a53a02af3b099e99b531f45c061da0c1))

## [4.3.1] - 2026-01-30

### New Features

- v4.3.1 - SEO improvements and multi-provider documentation([`74a73b9`](https://github.com/MadAppGang/claudish/commit/74a73b94b2b52bdfd0cb6e5e39fce32383a4d042))

## [4.3.0] - 2026-01-30

### Bug Fixes

- sync packages/cli version to 4.3.0([`02700dd`](https://github.com/MadAppGang/claudish/commit/02700ddf5fc463908acaf62f619754dab1a795fc))

### New Features

- v4.3.0 - Add --stream flag for NDJSON streaming output([`7b2403b`](https://github.com/MadAppGang/claudish/commit/7b2403b1a37d8c3c447f378af5c8e13f0c7ab0ad))

## [4.2.2] - 2026-01-30

### Bug Fixes

- profile flag now skips model selector, Gemini tool name sanitization([`f97271d`](https://github.com/MadAppGang/claudish/commit/f97271dfc3491b3e79fd512e6c872f96c7d5c59b))

## [4.2.1] - 2026-01-30

### Bug Fixes

- update xAI model references to use latest Grok 4.1 models([`40f5fb2`](https://github.com/MadAppGang/claudish/commit/40f5fb29c9b584b78f8791496de72861a7a9a78a))

## [4.2.0] - 2026-01-30

### Bug Fixes

- support Anthropic subscription auth in monitor mode *(monitor)* ([`8f4fb3c`](https://github.com/MadAppGang/claudish/commit/8f4fb3c8f310e3fbff20e79bfa03b07de598ee95))

### New Features

- v4.2.0 - Add direct xAI/Grok API support and multi-provider model selector([`78bd21d`](https://github.com/MadAppGang/claudish/commit/78bd21d9221bde6cee33cd368584bf0236dfd191))

## [4.1.1] - 2026-01-28

### Bug Fixes

- use ~/.claudish/ for models cache in standalone binaries([`05583f5`](https://github.com/MadAppGang/claudish/commit/05583f5f490c5fc256f76ace76aff2e9533cbbb6))

## [4.1.0] - 2026-01-28

### Bug Fixes

- implement --gemini-login and --gemini-logout CLI flags([`ea6a5f0`](https://github.com/MadAppGang/claudish/commit/ea6a5f05f4840d1a9ff610a6f3b260c820b51129))

### New Features

- v4.1.0 - Dynamic pricing and status line improvements([`bb59b06`](https://github.com/MadAppGang/claudish/commit/bb59b06b814ee0484fff81baa92289152988f2b4))

### Other Changes

- remove AI session artifacts and legacy lockfiles([`4cb76fb`](https://github.com/MadAppGang/claudish/commit/4cb76fb3065c54cd30ada59ce900bd946f445d6b))

## [4.0.6] - 2026-01-26

### Bug Fixes

- use correct bun command for global package updates *(update)* ([`a7eee57`](https://github.com/MadAppGang/claudish/commit/a7eee579b3497132652e6bbeb4cc643c8faeb89e))

## [4.0.5] - 2026-01-26

### Bug Fixes

- model switching and role mappings now work correctly([`40fc939`](https://github.com/MadAppGang/claudish/commit/40fc939b05e05f870ea38c93dfdb0a43a4ab177d))

## [4.0.4] - 2026-01-26

### Bug Fixes

- don't skip permissions by default (safer behavior)([`54293f2`](https://github.com/MadAppGang/claudish/commit/54293f20d0a433156221d5b2e845ffab2fc8e293))

## [4.0.3] - 2026-01-26

### Bug Fixes

- improve Termux/Android support *(android)* ([`5b8e14d`](https://github.com/MadAppGang/claudish/commit/5b8e14dcb8bf26bf557dbd04862a2c5be988123d))

## [4.0.2] - 2026-01-26

### Bug Fixes

- use claude.cmd instead of claude shell script *(windows)* ([`18ae794`](https://github.com/MadAppGang/claudish/commit/18ae794699ef31f62876cec5f22052bed9b6ea85))

## [4.0.1] - 2026-01-26

### Bug Fixes

- explicit provider routing for all CLI commands([`87c4ae0`](https://github.com/MadAppGang/claudish/commit/87c4ae0e494888f9a7f1794d67633f65d0d569d5))

## [4.0.0] - 2026-01-26

### Bug Fixes

- make build work without private markdown file([`ba5427c`](https://github.com/MadAppGang/claudish/commit/ba5427cb387317283ab36c0f88c92a6bbd5096f2))

### New Features

- v4.0.0 - New provider@model routing syntax([`f16caf4`](https://github.com/MadAppGang/claudish/commit/f16caf4c06c0140accf5c7d5aa5af8d552442afc))
- auto-update recommended models on release([`e1cd5e4`](https://github.com/MadAppGang/claudish/commit/e1cd5e4ffc4587b31a74d02eccbb6cf28cf64fbf))

### Other Changes

- remove all references to shared/recommended-models.md([`98d106d`](https://github.com/MadAppGang/claudish/commit/98d106d1d5f5623307b98f7ff0cc44881bcf1ffb))

### Refactoring

- remove obsolete extract-models.ts system([`08a044c`](https://github.com/MadAppGang/claudish/commit/08a044cf9c1d9eea4dd2df227511349d5f00b051))

## [3.11.0] - 2026-01-25

### Bug Fixes

- sync workspace package versions to 3.10.0([`36eea9d`](https://github.com/MadAppGang/claudish/commit/36eea9d8ed2fc6521fb42fd7d7622e245546bd06))

### Documentation

- add Z.AI to help text([`9524a0c`](https://github.com/MadAppGang/claudish/commit/9524a0cee5d3bcbc223b92e8138b3ff713e3d275))

### New Features

- v3.11.0 - local model concurrency queue([`d51755e`](https://github.com/MadAppGang/claudish/commit/d51755e34a54cb0fb982861cbb105f2b41d968e2))

## [3.10.0] - 2026-01-25

### Bug Fixes

- route google/ and openai/ to OpenRouter, add tests([`a29087c`](https://github.com/MadAppGang/claudish/commit/a29087cf4c27f727af3d3856977f1c30ed54de74))
- API key precedence and provider resolution (#38)([`5d7d3a9`](https://github.com/MadAppGang/claudish/commit/5d7d3a940dcd7e4812846ee7f0cabbc623cbb802))
- package.json scripts (#37)([`017ce5e`](https://github.com/MadAppGang/claudish/commit/017ce5e21fbd97aa34168b02b7305b33186b0bb4))

### New Features

- v3.10.0 - add Z.AI direct provider and fix GLM reasoning([`a6d259e`](https://github.com/MadAppGang/claudish/commit/a6d259e79867d64b9f36de6c17f7c4e2afb4af42))

## [3.9.0] - 2026-01-24

### New Features

- v3.9.0 - rate limiting queue and improved error handling([`eda8b0e`](https://github.com/MadAppGang/claudish/commit/eda8b0e768eea99e2760ad338d56268eead1bf5a))

## [3.8.0] - 2026-01-23

### Bug Fixes

- sync src/ with packages/ for OpenCode Zen support([`4a22f08`](https://github.com/MadAppGang/claudish/commit/4a22f087fd7b1493381a9c57ce00cae3d5a10097))
- show FREE in status line for OpenRouter free models([`a1397e6`](https://github.com/MadAppGang/claudish/commit/a1397e619822e06c7061131ae47e247220c39d33))
- filter --free models to only show those with tool support([`47c6026`](https://github.com/MadAppGang/claudish/commit/47c6026ff7a4e3a0b16f3bea478c04fa2e2fe0d8))
- show FREE in status line for free zen/ models([`cdfc913`](https://github.com/MadAppGang/claudish/commit/cdfc9134a1aa6be7fa29869874d40af1b5c186ed))
- use correct pricing for zen/ free models([`a1ece06`](https://github.com/MadAppGang/claudish/commit/a1ece06d51c0039e59d703aa16a2b70aca035061))
- show correct provider name in status line for zen/ models([`4b0d81d`](https://github.com/MadAppGang/claudish/commit/4b0d81d9e282ac3121be2fbac60bb6c8b1de8712))
- zen/ provider skip auth header for free models([`e704671`](https://github.com/MadAppGang/claudish/commit/e7046715f82f5de640dcc2009bfc58d7a04ed8fe))

### New Features

- friendly error messages for OpenRouter API errors([`d920585`](https://github.com/MadAppGang/claudish/commit/d920585f6f51f63645f267169141de8f0922f1a7))
- add rate limiting queue for OpenRouter API([`ac46c00`](https://github.com/MadAppGang/claudish/commit/ac46c00cadafdf1ffe3f3181b625f32f3d28ac10))
- v3.8.0 - add OpenCode Zen provider (zen/ prefix)([`3568c3a`](https://github.com/MadAppGang/claudish/commit/3568c3a5fe8d4338b2f23459db176e44e0b56fe7))

## [3.7.9] - 2026-01-23

### Bug Fixes

- v3.7.9 - check all model slots for API key requirement([`568610a`](https://github.com/MadAppGang/claudish/commit/568610a7348f3fe8c9e50ec638e2380196d1650d))

## [3.7.8] - 2026-01-23

### New Features

- v3.7.8 - skip OpenRouter API key for local models([`382e741`](https://github.com/MadAppGang/claudish/commit/382e741457aadf68598ec968dd53129777534928))

## [3.7.7] - 2026-01-23

### Bug Fixes

- v3.7.7 - fix package.json not found in compiled binaries([`503897f`](https://github.com/MadAppGang/claudish/commit/503897fdd9d4986c6d6d58121247bb3a3a858ef7))

## [3.7.6] - 2026-01-23

### Bug Fixes

- v3.7.6 - improve Claude Code detection on Mac([`6566d96`](https://github.com/MadAppGang/claudish/commit/6566d964cdfd8e918e19cc8e1e74cb33cbd8fbc5))

## [3.7.5] - 2026-01-23

### Bug Fixes

- v3.7.5 - bypass Claude Code login screen in interactive mode([`350f48c`](https://github.com/MadAppGang/claudish/commit/350f48cee2d0b6265e572a137674745f6d09a703))

## [3.7.4] - 2026-01-23

### Bug Fixes

- v3.7.4 - support local Claude Code installations([`54fb39c`](https://github.com/MadAppGang/claudish/commit/54fb39c32b00c72463b6269d225122f40c8892f6))

## [3.7.3] - 2026-01-22

### New Features

- v3.7.3 - dynamic provider and model name in status line([`3e413fc`](https://github.com/MadAppGang/claudish/commit/3e413fcb47ae321480b0cd27d669a21d0568fb49))

## [3.7.2] - 2026-01-22

### Bug Fixes

- v3.7.2 - show FREE for OAuth sessions, ~$ for estimated pricing([`605c589`](https://github.com/MadAppGang/claudish/commit/605c589fc9a0ad827c10ab701385bbd1a5d4ce9c))

## [3.7.1] - 2026-01-22

### Bug Fixes

- v3.7.1 - type coercion for local model tool arguments([`a3fddd6`](https://github.com/MadAppGang/claudish/commit/a3fddd647265019494a10d25fb760328c3f8eb29))
- add type coercion for tool arguments from local models (#30)([`23ca258`](https://github.com/MadAppGang/claudish/commit/23ca25850b9c4711d1c2fa42e7c1c612fb7fa16c))

## [3.7.0] - 2026-01-22

### New Features

- v3.7.0 - Gemini Code Assist OAuth support with rate limiting([`687b953`](https://github.com/MadAppGang/claudish/commit/687b953da738bedf944c387e7bfe3e01857e946a))

## [3.6.1] - 2026-01-22

### Bug Fixes

- v3.6.1 - network error handling with SSE response format([`be37a5c`](https://github.com/MadAppGang/claudish/commit/be37a5cc226421eca7bdef69cfd7fede8c4849fb))
- handle network errors with proper SSE response format([`7f00208`](https://github.com/MadAppGang/claudish/commit/7f002084ee187a38cd043e7bd8cd1649460fae4e))

## [3.6.0] - 2026-01-22

### Documentation

- add OllamaCloud to packages/cli help text([`04c6aeb`](https://github.com/MadAppGang/claudish/commit/04c6aeb2612e0f4e938588be58b76f972fa69b88))
- add OllamaCloud provider documentation([`2bdb38a`](https://github.com/MadAppGang/claudish/commit/2bdb38a6421f0e889ee40f68d98f5f103c4dde79))

### New Features

- v3.6.0 - OllamaCloud provider support([`835ffdf`](https://github.com/MadAppGang/claudish/commit/835ffdf59f1830c636dd83078f3dc3101fd7154e))
- add OllamaCloud provider support with oc/ prefix([`4dba1a5`](https://github.com/MadAppGang/claudish/commit/4dba1a5bfc74f49b78c36f0b7b1c421bd7b7de30))
- add Claude Code Action for PR assistance([`f3d548d`](https://github.com/MadAppGang/claudish/commit/f3d548d334e6facba4cdf5c38fff99e4f53078db))
- add issue triage bot with Claude Code([`5d8b970`](https://github.com/MadAppGang/claudish/commit/5d8b9700c425b307313c8420e798182eb6e926f6))
- add Poe API provider support *(providers)* ([`57c5cb3`](https://github.com/MadAppGang/claudish/commit/57c5cb362a2abe64fb6a634bdccc0d86675d341c))

## [3.5.0] - 2026-01-21

### Bug Fixes

- use fixed default port 8899 for reliable communication *(proxy)* ([`ddd1c70`](https://github.com/MadAppGang/claudish/commit/ddd1c709e16e380b011c71600bc74c39df604c1e))

### New Features

- add Vertex AI OAuth mode and partner model support([`2a3605d`](https://github.com/MadAppGang/claudish/commit/2a3605d0bd5b703ebac575146e9adb374c5d7771))
- robust port communication with lock file and health checks *(proxy)* ([`f4b5faa`](https://github.com/MadAppGang/claudish/commit/f4b5faaee1ec66d74c97b2e98451cf818a4118b1))
- per-instance proxy via --proxy-server flag *(ClaudishProxy)* ([`2325d4d`](https://github.com/MadAppGang/claudish/commit/2325d4d15e64dec60f4437d4243cf86f7efa0ba6))
- add Vertex AI Express Mode support *(providers)* ([`c214a3c`](https://github.com/MadAppGang/claudish/commit/c214a3c6a00ef6def1e24e7edf8508616e48b547))
- native OpenAI routing, error display, and config sync *(proxy)* ([`515399e`](https://github.com/MadAppGang/claudish/commit/515399e67cc9aee76f852bb7888dca4fe1827dae))
- add auto-recovery and stale proxy cleanup *(ClaudishProxy)* ([`f2769ab`](https://github.com/MadAppGang/claudish/commit/f2769abfe65182ee777688cc71f12626dfb46ba0))
- add model routing and conversation sync persistence *(macos-bridge)* ([`ca645f3`](https://github.com/MadAppGang/claudish/commit/ca645f36a2418771dd1e733100f0f2c647f51499))

### Other Changes

- remove verbose status check debug log([`9cfc753`](https://github.com/MadAppGang/claudish/commit/9cfc753f0320d48bfc27aa7a62e512993008b617))

## [3.4.1] - 2026-01-20

### Documentation

- add MCP server documentation to --help and AI_AGENT_GUIDE([`91646f3`](https://github.com/MadAppGang/claudish/commit/91646f3936d7154424cadfa796f82ceb93ffab8a))

### New Features

- add zombie process hunting and recovery *(macos-bridge)* ([`087cf56`](https://github.com/MadAppGang/claudish/commit/087cf564667d604eff7a9a132238bfc889cfca52))
- SQLite stats, HTTPS interception, improved About screen *(ClaudishProxy)* ([`52e0626`](https://github.com/MadAppGang/claudish/commit/52e0626e6fd24887a16187a91fe0152e3306d282))
- add model profiles and dynamic model picker *(ClaudishProxy)* ([`6ce5cf6`](https://github.com/MadAppGang/claudish/commit/6ce5cf6c5c341fb851cf778ea7c239edb62f516f))
- add StatsPanel UI with activity table *(ClaudishProxy)* ([`9cc4fe1`](https://github.com/MadAppGang/claudish/commit/9cc4fe1e18395c65b431836bf23b9639a15b26fe))

## [3.4.0] - 2026-01-16

### New Features

- v3.4.0 - add claudish update command([`23a09e7`](https://github.com/MadAppGang/claudish/commit/23a09e76a34770f1e9d94b4898a6fb436313a337))
- add claudish update command([`504b52e`](https://github.com/MadAppGang/claudish/commit/504b52e21a6f4d80dd074c3c36dfc8975cc00d29))

## [3.3.12] - 2026-01-15

### Bug Fixes

- OpenAI Codex Responses API streaming and ID mapping([`b033084`](https://github.com/MadAppGang/claudish/commit/b033084d16a2c3ea85c603be6f2d2c22cc9bd730))
- proper cleanup and send() helper in Codex streaming([`d9cd2dd`](https://github.com/MadAppGang/claudish/commit/d9cd2dd9aef2e463ba51f7761977f25a470c36fc))

## [3.3.10] - 2026-01-15

### Bug Fixes

- add ping event after message_start for Responses API streaming([`6ee1da2`](https://github.com/MadAppGang/claudish/commit/6ee1da2b88454277dd3c149c37ee2d1915bc1425))

## [3.3.9] - 2026-01-15

### Bug Fixes

- calculate cost using incremental input tokens, not full context([`08aa13c`](https://github.com/MadAppGang/claudish/commit/08aa13ca70a7cd67ca30139573fe20bf0a0a6ad7))

## [3.3.8] - 2026-01-15

### Bug Fixes

- use placeholder input_tokens in message_start for Responses API([`a974c49`](https://github.com/MadAppGang/claudish/commit/a974c4906fb7b21fdf18ee269be7b63de0954341))

## [3.3.7] - 2026-01-15

### Bug Fixes

- handle both response.completed and response.done for token counting([`1a6b383`](https://github.com/MadAppGang/claudish/commit/1a6b383dbfb20836637b9474750f69624caf66b2))

## [3.3.6] - 2026-01-15

### Bug Fixes

- Responses API function_call as top-level items, not content blocks([`c9ed4ef`](https://github.com/MadAppGang/claudish/commit/c9ed4ef85c909a982d9eea0cf60e27f5f3b1ebf6))

## [3.3.5] - 2026-01-15

### Bug Fixes

- proper Responses API format for images and function calling([`b6d4af0`](https://github.com/MadAppGang/claudish/commit/b6d4af054aee29ec0bcb77aea0733f0639b1ea12))

## [3.3.4] - 2026-01-15

### Bug Fixes

- correct Responses API message format for Codex models([`8178f8e`](https://github.com/MadAppGang/claudish/commit/8178f8e3d349866ae1947b07cadd8100d4dfe86d))

## [3.3.3] - 2026-01-15

### New Features

- add OpenAI Codex model support via Responses API([`5b7d630`](https://github.com/MadAppGang/claudish/commit/5b7d63092f8dde7e0338fda2bcf591814341891c))

## [3.3.2] - 2026-01-15

### Bug Fixes

- build core before binary in CI([`1b3d93d`](https://github.com/MadAppGang/claudish/commit/1b3d93db959433c2595aa0e806211aff1b608417))

## [3.3.1] - 2026-01-15

### Bug Fixes

- build from root to preserve workspace resolution in CI([`4bcc332`](https://github.com/MadAppGang/claudish/commit/4bcc33260c267862a0d1768f297aa546ab266184))

## [3.3.0] - 2026-01-15

### Bug Fixes

- update CI/CD for monorepo structure([`97d2f68`](https://github.com/MadAppGang/claudish/commit/97d2f68c4bbf8e313d149dbfa8321b9cf9c1e444))

### New Features

- convert to monorepo with macOS desktop proxy support([`1962c38`](https://github.com/MadAppGang/claudish/commit/1962c387790de1ee7363809c17ace77899c3d72f))

## [3.2.3] - 2026-01-12

### Bug Fixes

- add thoughtSignature support for Gemini direct API([`42fa475`](https://github.com/MadAppGang/claudish/commit/42fa47534e9931652089df48328bb9b1e05dfeb1))

## [3.2.2] - 2026-01-12

### Bug Fixes

- use max_completion_tokens for newer OpenAI models([`b82f447`](https://github.com/MadAppGang/claudish/commit/b82f4472b513e289c221579a89386b679c83c4ef))

## [3.2.1] - 2026-01-11

### Bug Fixes

- sanitize JSON schema for Gemini API compatibility([`94318fb`](https://github.com/MadAppGang/claudish/commit/94318fbc173ad0fe1aac6185b02fd23c0993873e))

### Other Changes

- format codebase and update recommended models([`b350fb9`](https://github.com/MadAppGang/claudish/commit/b350fb9867a7156ced575011d63570cf9e746667))

## [3.2.0] - 2026-01-07

### New Features

- add direct API support for MiniMax, Kimi, and GLM providers([`129417b`](https://github.com/MadAppGang/claudish/commit/129417bc2e2b4278ee8c9456370cf13b505680fe))

## [3.1.3] - 2026-01-05

### Bug Fixes

- google/ prefix now routes to OpenRouter, not Gemini Direct([`9ccfa19`](https://github.com/MadAppGang/claudish/commit/9ccfa19461232fcffc4d465ff4bdc655a913f026))

## [3.1.2] - 2026-01-05

### Documentation

- update documentation for multi-provider routing([`1cab9d7`](https://github.com/MadAppGang/claudish/commit/1cab9d753d70a43ee729fe53af878050f44f62c6))

## [3.1.1] - 2026-01-05

### Bug Fixes

- enable tool support for MLX provider([`41203bd`](https://github.com/MadAppGang/claudish/commit/41203bdc77bedb40756edcff619d69be98a3a790))

## [3.1.0] - 2026-01-04

### New Features

- direct Gemini and OpenAI API support with prefix routing([`2b0064d`](https://github.com/MadAppGang/claudish/commit/2b0064d29e65ef3200716bc56d3a81998efaddeb))

## [3.0.6] - 2025-12-29

### Bug Fixes

- status line cost display always showing $0.000([`2f53e70`](https://github.com/MadAppGang/claudish/commit/2f53e70931371950bbb4e76ed043f095c808539a))

## [3.0.5] - 2025-12-29

### Bug Fixes

- token file path mismatch causing status line to show 100% context([`c2e396d`](https://github.com/MadAppGang/claudish/commit/c2e396d4e7d08216194a324387cd1fd6bf955fc9))

## [3.0.4] - 2025-12-29

### Bug Fixes

- expand Gemini reasoning filter patterns([`5a014c4`](https://github.com/MadAppGang/claudish/commit/5a014c40505d91c8a9edb6d41d16ca9f2f98ef41))

## [3.0.3] - 2025-12-27

### Bug Fixes

- Gemini reasoning leakage and native thinking block support([`523c0e4`](https://github.com/MadAppGang/claudish/commit/523c0e40cd5949aa09a1bd2b300bc87cc9bf4cf1))

## [3.0.2] - 2025-12-26

### Bug Fixes

- OpenRouter token tracking and debug logging([`f4c1df2`](https://github.com/MadAppGang/claudish/commit/f4c1df2c24f8d5255c77481339481a8fabd35746))

## [3.0.1] - 2025-12-23

### Bug Fixes

- update HTTP-Referer to claudish.com for OpenRouter visibility([`dae66c4`](https://github.com/MadAppGang/claudish/commit/dae66c44e8d892113f0ec46b4bc0af7f661603d9))
- move settings files to ~/.claudish to avoid socket watch errors([`20271eb`](https://github.com/MadAppGang/claudish/commit/20271ebb25dd85515d9cf9b8b2e93ac22ec6037b))

### Other Changes

- add CLAUDE.md and update .gitignore([`30c65d1`](https://github.com/MadAppGang/claudish/commit/30c65d1b21dda587ac7e9941a58d276a5790960a))

## [3.0.0] - 2025-12-14

### New Features

- v3.0.0 - Full local model support (Ollama, LM Studio)([`a216c95`](https://github.com/MadAppGang/claudish/commit/a216c9556f2c0b9e20ee68e45ac1579275a72604))

## [2.11.0] - 2025-12-13

### New Features

- Add tool summarization and improved local model support([`3139af9`](https://github.com/MadAppGang/claudish/commit/3139af919b958e0aefa23245c772db5ba80e1fca))

## [2.10.1] - 2025-12-13

### Bug Fixes

- Windows spawn ENOENT - runtime platform detection([`51de48f`](https://github.com/MadAppGang/claudish/commit/51de48f1b464e5cceceb05aee5d07a1f56a2b44c))

## [2.10.0] - 2025-12-13

### New Features

- Improve local model UX - tool support detection, context tracking([`d71a9ca`](https://github.com/MadAppGang/claudish/commit/d71a9ca9139bd03aa7d45ed53a770c5605b7b521))

## [2.9.0] - 2025-12-13

### Documentation

- Update installation section with all distribution options([`a43949b`](https://github.com/MadAppGang/claudish/commit/a43949b648abda9a704af8e84dd6a604f19aac78))

### New Features

- Add local Ollama models support([`d92933e`](https://github.com/MadAppGang/claudish/commit/d92933e0377d15d141c27226cc1c38f154db5392))

## [2.8.1] - 2025-12-12

### Bug Fixes

- Use build:ci for npm publish (skip extract-models)([`e60ad5b`](https://github.com/MadAppGang/claudish/commit/e60ad5b0764628b177d1bc5071104e708883bef4))

## [2.8.0] - 2025-12-12

### Bug Fixes

- CI workflow - use macos-15-intel, skip extract-models([`07db17e`](https://github.com/MadAppGang/claudish/commit/07db17e99e6e520f3a1580ecc225c057772b2204))
- fix some view of langing page([`8b9004d`](https://github.com/MadAppGang/claudish/commit/8b9004d0dd9f873b6c9796a0f7113066ba48fde6))

### New Features

- Add automated release pipeline([`31492fc`](https://github.com/MadAppGang/claudish/commit/31492fcba0d8c1dcdf0c7c745244c42b10cbabfa))
- Add profile-based model configuration v2.8.0 *(profiles)* ([`a3303a1`](https://github.com/MadAppGang/claudish/commit/a3303a12dbb54b9e5c0d2eb0ff27b19814fd43c1))


