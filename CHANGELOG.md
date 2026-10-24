# Changelog

All notable changes to [Claudish](https://github.com/MadAppGang/claudish).

## [14.4.2] - 2026-10-24

### Bug Fixes

- write ~/.claudish/settings-*.json with mode 0600 *(settings)* ([`6823aca`](https://github.com/MadAppGang/claudish/commit/6823acaa29d608b526d6c47249d0cb5476023247))

### Documentation

- record the 0600 mode of the child's settings overlay *(mcp)* ([`7197e73`](https://github.com/MadAppGang/claudish/commit/7197e73aa43cb0116b4de917aa3685ca046399ad))
- update CHANGELOG.md for v14.4.1([`579114b`](https://github.com/MadAppGang/claudish/commit/579114b125ed03324ef8bb9cf1f3fe659ab4443a))

### Other Changes

- v14.4.2 (#352) *(release)* ([`b1e671e`](https://github.com/MadAppGang/claudish/commit/b1e671eaf1bc84121daa3315d8f5225052b5d92a))
- v14.4.2 *(release)* ([`d87a6a7`](https://github.com/MadAppGang/claudish/commit/d87a6a7cc74dcebcc777b53815bd576a92665d99))

## [14.4.1] - 2026-10-23

### Bug Fixes

- classify a context overflow as api_error via the in-band marker (#349) *(team)* ([`6468bd0`](https://github.com/MadAppGang/claudish/commit/6468bd05ed8c649f06496c5160bac74a870014c6))
- classify a context overflow as api_error via the in-band marker *(team)* ([`412a14d`](https://github.com/MadAppGang/claudish/commit/412a14d980f5192275eb58ffc8d6b1bb6bda683d))

### Documentation

- state why team's model check reads the server's project rules *(mcp)* ([`d62baa1`](https://github.com/MadAppGang/claudish/commit/d62baa10ffbb37aeb56fbf7ad93a2633b8c64dce))
- update CHANGELOG.md for v14.4.0([`8d13a5f`](https://github.com/MadAppGang/claudish/commit/8d13a5fdabd136e83813bb38c6b809887a21de4a))
- mark the release playbook verified by v14.4.0 *(release)* ([`fa8eba9`](https://github.com/MadAppGang/claudish/commit/fa8eba93e219b9c95e22870959c9c9e6abb12ee6))

### Other Changes

- v14.4.1 (#350) *(release)* ([`1cb0683`](https://github.com/MadAppGang/claudish/commit/1cb06839149ce66b222fc1aaa7fea570e1f9159d))
- v14.4.1 *(release)* ([`dc5decf`](https://github.com/MadAppGang/claudish/commit/dc5decfe5e2b55acdfa5009bba7713d3d1ea0307))

## [14.4.0] - 2026-10-23

### Bug Fixes

- read a trailing in-band API error on an unread turn *(team)* ([`13c0cf0`](https://github.com/MadAppGang/claudish/commit/13c0cf0a1d095f5caf7d089602042ab67af5e7ab))
- compare canonical catalog ids in the model check *(mcp)* ([`0e5a79f`](https://github.com/MadAppGang/claudish/commit/0e5a79fde53eecd5b03baeb44934f0ca19b49da1))
- suggest only a recommended model in search_models *(mcp)* ([`edd4cef`](https://github.com/MadAppGang/claudish/commit/edd4cef53f39fa45362567a7cd359ec2f186fdc2))
- report an in-band API error as api_error, not prompt_not_read *(team)* ([`6c48093`](https://github.com/MadAppGang/claudish/commit/6c480936b741a85e80a356e398a5494a3b292dcb))
- answer 'session_id' is required instead of a path-join error *(mcp)* ([`89e8230`](https://github.com/MadAppGang/claudish/commit/89e82304facc053b3aa5c049c23bc45cdc2af1c3))
- add effort rows of the matching ids to the model-check answer *(mcp)* ([`64fc5fa`](https://github.com/MadAppGang/claudish/commit/64fc5faf81b0be2c275d8e05e9d2405edf1cb90b))

### Documentation

- update CHANGELOG.md for v14.3.0([`8f0ebdf`](https://github.com/MadAppGang/claudish/commit/8f0ebdf4700c905341d45ec4c3b0ddb874b86d3d))

### New Features

- refuse a bare name outside the recommended models list *(mcp)* ([`621a523`](https://github.com/MadAppGang/claudish/commit/621a5232a87ff08a4fe2095ea0ca80c471ac7a49))

### Other Changes

- v14.4.0 (#347) *(release)* ([`1728cca`](https://github.com/MadAppGang/claudish/commit/1728ccab4e595d105f24e2ecca800d5bb314d90b))
- v14.4.0 *(release)* ([`cdab576`](https://github.com/MadAppGang/claudish/commit/cdab5765780124d96426019e900c5f09df089928))

## [14.3.0] - 2026-10-23

### Documentation

- record agent_requested and agent in the mod contract v1 *(mcp)* ([`e92101b`](https://github.com/MadAppGang/claudish/commit/e92101b1937ba3f7b9ba5f7fa7a500ccd10faac0))
- mark the release playbook verified by v14.2.0 (#343) *(release)* ([`f1dabfb`](https://github.com/MadAppGang/claudish/commit/f1dabfb5391d630e688996f21b2773646bc6ec48))
- mark the release playbook verified by v14.2.0 *(release)* ([`8827764`](https://github.com/MadAppGang/claudish/commit/8827764b976023214aefa9a4714c7c5e6ff4e5d3))
- update CHANGELOG.md for v14.2.0([`8ea8084`](https://github.com/MadAppGang/claudish/commit/8ea80841f6688d72023dba685fc638c25dea89b8))

### New Features

- add agent_requested and agent to session and team slot rows *(mcp)* ([`c8c1ccd`](https://github.com/MadAppGang/claudish/commit/c8c1ccd6cf88228fd74962dc00134c50a8a16b14))

### Other Changes

- v14.3.0 (#346) *(release)* ([`ffdd4e9`](https://github.com/MadAppGang/claudish/commit/ffdd4e911284df7a6136c571ae4ac876ff5b34c5))
- v14.3.0 *(release)* ([`33a5a8c`](https://github.com/MadAppGang/claudish/commit/33a5a8c581c25e9538146fcca7ccbda44be2a304))

## [14.2.0] - 2026-10-23

### Bug Fixes

- add a random suffix to atomic-write temp file names *(catalog)* ([`8529038`](https://github.com/MadAppGang/claudish/commit/85290388ad7691fec14418edec178abe2a84ad62))
- disable the always-on log when its directory is unwritable *(logging)* ([`cbbad80`](https://github.com/MadAppGang/claudish/commit/cbbad806b85fa40400c47f619a75fe199893ecbb))
- keep a custom endpoint's or anthropic@ provider in MCP specs *(mcp)* ([`6261395`](https://github.com/MadAppGang/claudish/commit/6261395931802abb69fd38b59e5da689c7af487a))
- list models in list_models without provider specs *(mcp)* ([`ec80094`](https://github.com/MadAppGang/claudish/commit/ec80094ed97aaa31b9c6290fa83cdeaa8c671ca8))
- write the models cache and route registry atomically *(catalog)* ([`d27b930`](https://github.com/MadAppGang/claudish/commit/d27b930cbdda40358335e6179340440bc541381e))
- log refresh failures and retry a refresh that threw *(catalog)* ([`c297881`](https://github.com/MadAppGang/claudish/commit/c297881dee87e182a2b0908feb44a159e3be8ccf))

### Documentation

- document per-model effort, needs_effort and bare model names *(mcp)* ([`7518d4a`](https://github.com/MadAppGang/claudish/commit/7518d4adcf64709699f71c27d702eff467212c80))
- update CHANGELOG.md for v14.1.0([`0a5e7ac`](https://github.com/MadAppGang/claudish/commit/0a5e7ac909786b9a204826478c5d10d3229d1b29))

### New Features

- accept one reasoning effort per model from the calling agent *(mcp)* ([`09f9cde`](https://github.com/MadAppGang/claudish/commit/09f9cde34cd28cafb3ca88a6f11e15432a3f58be))
- store the recommended effort per model and task type *(catalog)* ([`acc0c17`](https://github.com/MadAppGang/claudish/commit/acc0c179f314874f0c1e5b1e2670336d0eb3794a))
- rotate the always-on log per process name *(logging)* ([`80cbf4c`](https://github.com/MadAppGang/claudish/commit/80cbf4c99c3a17d7aa5021a747d27c16b9985f98))

### Other Changes

- v14.2.0 (#342) *(release)* ([`cfbd61a`](https://github.com/MadAppGang/claudish/commit/cfbd61a5a043653880d682446461ff1021018497))
- v14.2.0 *(release)* ([`5ce42d3`](https://github.com/MadAppGang/claudish/commit/5ce42d33dfad56f0db14f7ce5cea6a4d6bc7c6a9))

## [14.1.0] - 2026-10-22

### Bug Fixes

- kill a magmux --version probe that ignores its timeout *(pane)* ([`8a4d7b0`](https://github.com/MadAppGang/claudish/commit/8a4d7b07e43223a5ef7b96e8fe01a701b209003f))
- accept provider shortcuts in isKnownProviderName *(routing)* ([`aae2ea0`](https://github.com/MadAppGang/claudish/commit/aae2ea0b19ad8fa2d933db8f06f8c0b55220c49c))
- reread credentials.toml when the Devin CLI rewrites it *(devin)* ([`80a41d9`](https://github.com/MadAppGang/claudish/commit/80a41d9fc640abe0880a55240a7c51cd9abd27d1))
- keep a newer kimi-oauth.json when a refresh is rejected *(kimi)* ([`9f4da73`](https://github.com/MadAppGang/claudish/commit/9f4da73239177340449c0ca28b549acf8ddda184))
- reload kimi-oauth.json when another process logs in *(kimi)* ([`93efa21`](https://github.com/MadAppGang/claudish/commit/93efa21b38e1290eacc1e3beb70d3bc97874da0c))
- skip the ~/.grok/auth.json write-back when the file changed *(grok)* ([`0ebd646`](https://github.com/MadAppGang/claudish/commit/0ebd64602e6ac505e0392ac9b4096e20186a4ed4))
- keep a newer grok-oauth.json over a racing token refresh *(grok)* ([`5f0e8aa`](https://github.com/MadAppGang/claudish/commit/5f0e8aaa703938382c01f6e4c5900a8f2404875c))
- reload grok-oauth.json when another process logs in *(grok)* ([`6a4d111`](https://github.com/MadAppGang/claudish/commit/6a4d111df5a585a0e4c63290ee91ebf31f593e92))
- probe preflight hops in chain order until one serves *(mcp)* ([`b138f00`](https://github.com/MadAppGang/claudish/commit/b138f00d453ae1ade85c2ce075125f24bc441d6f))
- name an unknown provider shortcut in explicit-spec errors *(proxy)* ([`6e00ea9`](https://github.com/MadAppGang/claudish/commit/6e00ea93eccaa2ed2f3fab12eddc8a4b1ac57732))
- name an unknown provider shortcut instead of no credential *(routing)* ([`66180b6`](https://github.com/MadAppGang/claudish/commit/66180b6935d3a33b5486d1cbf5cd1daee13c0f49))

### Documentation

- record the magmux --version probe deadline rule *(pane)* ([`64a6dd8`](https://github.com/MadAppGang/claudish/commit/64a6dd8f96fb602d6a5e303f0b63c279dffe270f))
- add the credential-file invariant and credential-files.md to CLAUDE.md([`61e51f9`](https://github.com/MadAppGang/claudish/commit/61e51f97f43ce19395c881a0917ba3a58324bbd1))
- say children get --default-provider from an explicit env copy *(routing)* ([`03c1388`](https://github.com/MadAppGang/claudish/commit/03c1388412a62d23dc49a2c646c688be79ab181d))
- mark D1, D4, D5, D6 and D9 fixed on the branch *(reports)* ([`9dc09f0`](https://github.com/MadAppGang/claudish/commit/9dc09f076fa07a58097b46471c2978e0f3c47994))
- record unknown shortcuts and the test preload *(architecture)* ([`988475a`](https://github.com/MadAppGang/claudish/commit/988475a34ea13b23dacf177012bcc71b166cd377))
- record the preflight chain walk and hop decision *(architecture)* ([`3cc05d8`](https://github.com/MadAppGang/claudish/commit/3cc05d8e21d09a5cd38430097774f75b85116f0a))
- record credential-file reload and write-back rules *(architecture)* ([`b575e19`](https://github.com/MadAppGang/claudish/commit/b575e191d04a5a4a29049bd5280ba28ffd7ce3b7))
- update CHANGELOG.md for v14.0.0([`0944cc8`](https://github.com/MadAppGang/claudish/commit/0944cc88306acca293272781e147d2f681cf7613))

### New Features

- report whether a failed hop advances the routing chain *(probe)* ([`346310f`](https://github.com/MadAppGang/claudish/commit/346310f0c4408aabfc806516448b161dd66d15cf))
- mark unhandled-error 500s with x-claudish-unhandled-error *(proxy)* ([`25763f1`](https://github.com/MadAppGang/claudish/commit/25763f1030f5b7b27edea6eb488db3639970c3d1))

### Other Changes

- v14.1.0 (#337) *(release)* ([`28c0b10`](https://github.com/MadAppGang/claudish/commit/28c0b10834c0fa7b959398defe1ccdbd44dd519a))
- v14.1.0 *(release)* ([`7fedd34`](https://github.com/MadAppGang/claudish/commit/7fedd34c7d0509d97d3372e41e8693d7a10241aa))

### Refactoring

- extract FallbackHandler's hop decision *(adapters)* ([`a41955b`](https://github.com/MadAppGang/claudish/commit/a41955b455bb3fb3c71fd4d3597d4033d8e17d8e))

## [14.0.0] - 2026-10-21

### ⚠ BREAKING CHANGES

- a Claude panel member is called on api.anthropic.com, not OpenRouter. The Claude Code login signs only when claudish controls the child's auth (no foreign --model, no ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, apiKeyHelper or settings token reaching Claude Code); otherwise the inbound x-api-key or ANTHROPIC_API_KEY signs, metered. A launch with neither and a Claude panel member is now refused. Use or@anthropic/<id> for OpenRouter, or --model-haiku haiku so the login signs. *(advisor)* ([`cb8c6bb`](https://github.com/MadAppGang/claudish/commit/cb8c6bba380fcde3fcb81f355d189d5571b91f7b))

### Bug Fixes

- stop a 400 connection verdict advancing onto metered hops *(routing)* ([`f8e0950`](https://github.com/MadAppGang/claudish/commit/f8e09504cbe3c59ede6b719c23a5575909de7e76))
- end a startup refusal reason with one full stop *(advisor)* ([`ba7c17c`](https://github.com/MadAppGang/claudish/commit/ba7c17c1e67d23270635a736ddaa032704090c9b))
- print a hop's billing label once in the notice *(advisor)* ([`62be8ab`](https://github.com/MadAppGang/claudish/commit/62be8abe3fd0b18984a626b1a92cb237752629d2))
- resolve ids in the availability check like the transport *(antigravity)* ([`8452d27`](https://github.com/MadAppGang/claudish/commit/8452d275c566b4fa1749315870effd0e0e1f3b46))
- say a rejected subscription login moves on to metered hops *(advisor)* ([`2f28210`](https://github.com/MadAppGang/claudish/commit/2f28210178ad182f176a6ba1b49ccbf39d088a28))
- advance past a rejected subscription key to metered hops *(routing)* ([`9ace3fe`](https://github.com/MadAppGang/claudish/commit/9ace3fe5bf8dab807b43849841e4e607ae352e7d))
- record a client-cancelled turn as cancelled in stats *(adapters)* ([`06e8a9f`](https://github.com/MadAppGang/claudish/commit/06e8a9f8bb30e4d456f25fae747b426a5035591d))
- redact native SSE error data that precedes event: error *(adapters)* ([`133c512`](https://github.com/MadAppGang/claudish/commit/133c512cf8809518a358bdc2103be530a1e2351e))
- print the metered-key login warning once per member reason *(advisor)* ([`7b5fe89`](https://github.com/MadAppGang/claudish/commit/7b5fe89da42428ae8234e2b6ec5a0ed9540b37fa))
- price each request's tokens by the arm that signed it *(adapters)* ([`7f47a92`](https://github.com/MadAppGang/claudish/commit/7f47a921a9ce33cf7b843de499bebe7b80b94852))
- redact native-passthrough credentials from error bodies *(adapters)* ([`c566585`](https://github.com/MadAppGang/claudish/commit/c566585961308b462590eefb56c6f216c82eca85))
- release a cancelled request's lease after its parser settles *(proxy)* ([`aa9f9e3`](https://github.com/MadAppGang/claudish/commit/aa9f9e3a1ec47f24fc85441820331031ce1ca062))
- end a client-cancelled stream without a truncation verdict *(adapters)* ([`eaff40c`](https://github.com/MadAppGang/claudish/commit/eaff40c21f8b090e0058bc768633e40a455dce5a))
- typecheck upstream-cancel.ts in the macos-bridge build *(adapters)* ([`3418721`](https://github.com/MadAppGang/claudish/commit/3418721b99563a6908b587d90b39e16d2c805ffe))
- print the metered-key login warning once per Claude member *(advisor)* ([`1a0776b`](https://github.com/MadAppGang/claudish/commit/1a0776bb7bc2b8a4fad017fe02bf5ecb2a7751cb))
- apply the signing-value registry to advisor log lines *(advisor)* ([`966e478`](https://github.com/MadAppGang/claudish/commit/966e478d1c00039d02a5366c9439bbdeef50139b))
- refuse a Claude member when custom headers send no x-api-key *(advisor)* ([`619ec5c`](https://github.com/MadAppGang/claudish/commit/619ec5cc0a218a31682e79cc7f9a1d92860e629a))
- bill an openai-codex hop by the arm that signed it *(adapters)* ([`da61415`](https://github.com/MadAppGang/claudish/commit/da614153f3cb123ac9496506930b18c151304a28))
- keep a built-pending hop's planned uid in the hop log *(advisor)* ([`e69fb1e`](https://github.com/MadAppGang/claudish/commit/e69fb1eb910bb610ff780eac51dbeaa2fcb0702e))
- redact the Claude advisor response body before parsing it *(advisor)* ([`ee99f85`](https://github.com/MadAppGang/claudish/commit/ee99f85b7947eef7593741b146e8e8e29006742e))
- redact the request's own values from an error before release *(proxy)* ([`8fee792`](https://github.com/MadAppGang/claudish/commit/8fee7923f85418999e12bc83abb96b4369c897fc))
- redact stream-head error text before the 400 and 503 bodies *(errors)* ([`6374f7c`](https://github.com/MadAppGang/claudish/commit/6374f7cfe04d94c41b63cb1be88637b9216e3454))
- redact signing values in auth-failure response bodies *(errors)* ([`8729202`](https://github.com/MadAppGang/claudish/commit/87292028c96c825b385df8d874827a3e07f9b4e9))
- end the upstream read loop before a cancel releases a lease *(adapters)* ([`fd5d224`](https://github.com/MadAppGang/claudish/commit/fd5d2243823cae121d4959bba37cd420a5ea4fde))
- read every --settings value in childAuthControl *(advisor)* ([`3b5135c`](https://github.com/MadAppGang/claudish/commit/3b5135c217c21203f8cc5e79166ca56ac2c4b5c9))
- name reasoning-only and max-tokens replies in S4 stubs *(advisor)* ([`f9d2304`](https://github.com/MadAppGang/claudish/commit/f9d23046b705fa6b80f2c3fdb924d7042208afc1))
- stop sending Claude Code selectors as Anthropic model ids *(advisor)* ([`6899f3e`](https://github.com/MadAppGang/claudish/commit/6899f3e2dbe94f60bb11f86dc2202cdb0cdb5ac1))
- expose the access token sent by capacity fallback *(antigravity)* ([`fabaa51`](https://github.com/MadAppGang/claudish/commit/fabaa512f10e7142a392c70523b22a117c41253f))
- expose the body-embedded credential for redaction *(devin)* ([`9420d21`](https://github.com/MadAppGang/claudish/commit/9420d211ad9f2c26473f099f2f853283fa99e4f3))
- remove registered signing values from error reports *(telemetry)* ([`83c6e86`](https://github.com/MadAppGang/claudish/commit/83c6e868d7a9ee1dd1fc82d7c8b113e282286ea4))
- redact signing credentials in errors sent to Claude Code *(adapters)* ([`d8f6e52`](https://github.com/MadAppGang/claudish/commit/d8f6e5214019145151d0f8e1fe16973647eaa556))
- register each request's signing credentials for redaction *(adapters)* ([`2923adb`](https://github.com/MadAppGang/claudish/commit/2923adb7c5a081175ce438f0fb6e9925226df136))
- add the pid to temp settings filenames to stop collisions *(cli)* ([`1066489`](https://github.com/MadAppGang/claudish/commit/1066489bd82e5a297cb6d889853bd8c4a861bc54))
- render an interrupted script as Script terminated *(openai-codex)* ([`f425a0b`](https://github.com/MadAppGang/claudish/commit/f425a0b287ee98f08eaa079638e7d3b9b8d39ad2))
- skip trailing system messages on exec resume *(openai-codex)* ([`4cb34e5`](https://github.com/MadAppGang/claudish/commit/4cb34e54ffc066ce0695b6dad5f139d26570381a))
- say "not resent" when a sign-in change stops a retry *(openai-codex)* ([`9e5c9ca`](https://github.com/MadAppGang/claudish/commit/9e5c9ca5cc57362213ac89e6d31e05fdb3ee438c))
- refuse a tool_use finish over a cut-off block *(openai-codex)* ([`0503443`](https://github.com/MadAppGang/claudish/commit/050344357201365f416141c56836103186b720d1))
- stop failing an innocent script at the wasm ceiling *(openai-codex)* ([`7d95ca2`](https://github.com/MadAppGang/claudish/commit/7d95ca2062972c1ba29f528ec0fb428d1691f602))
- load a sandbox module before replaying after a retire *(openai-codex)* ([`1cbc109`](https://github.com/MadAppGang/claudish/commit/1cbc109a0fa3e292dd9ce36e2f0b4d39bbd0d1ec))
- count repair hashes in the settled script-store bytes *(openai-codex)* ([`8792c18`](https://github.com/MadAppGang/claudish/commit/8792c18f61fa68929009744b234356f2c28db6c5))
- keep cache_control inside tool inputs in hashes *(openai-codex)* ([`c01900b`](https://github.com/MadAppGang/claudish/commit/c01900b765c7f25619c25df751e4393a7c27706c))
- report text() drops in characters, not bytes *(openai-codex)* ([`4504396`](https://github.com/MadAppGang/claudish/commit/4504396ea8ae023a118f7bb65ed8c487b208b81c))
- name the legs bound in the code-mode stop text *(openai-codex)* ([`0eda324`](https://github.com/MadAppGang/claudish/commit/0eda3241fe64331a2140ec82e4fe35d035cb4f62))
- leave cache_control out of code-mode history hashes *(openai-codex)* ([`a681ca1`](https://github.com/MadAppGang/claudish/commit/a681ca1708bcbe99ae13d100e4b51cc2ed6c1d8d))
- record an exec that ends in a leg with a tool_use *(openai-codex)* ([`dad8154`](https://github.com/MadAppGang/claudish/commit/dad8154f0ec50b956301143d1280acf2daf0081b))
- send an SSE error when a socket drops inside an exec *(openai-codex)* ([`a1b2196`](https://github.com/MadAppGang/claudish/commit/a1b21969be681b4e359cd7375b902019c2c2fcda))
- read a degenerate wrapper leg's usage before ending it *(adapters)* ([`65e8cd1`](https://github.com/MadAppGang/claudish/commit/65e8cd105aa94216a2c4210da1299f0e396b536a))
- end a Responses turn with an SSE error when a hook throws *(adapters)* ([`7e8e395`](https://github.com/MadAppGang/claudish/commit/7e8e395192a8ad4dcecfe39c2f7002b8f740dcc3))
- stop the 401 retry resending under another account *(openai-codex)* ([`75369ba`](https://github.com/MadAppGang/claudish/commit/75369ba1acca6e8ac3bd0ce461b42b164a24fd1f))
- render an exec output answered after a user message *(openai-codex)* ([`4a751f0`](https://github.com/MadAppGang/claudish/commit/4a751f0cd35da3869b6d2fe6a06c4628880c862f))
- reject a promise passed as a nested tool's input *(openai-codex)* ([`0e5548f`](https://github.com/MadAppGang/claudish/commit/0e5548f888e9f3ca7d6d35ee0cf1304b5b778df6))
- replay a script whose relayed calls Layer 4 repaired *(openai-codex)* ([`0cc643c`](https://github.com/MadAppGang/claudish/commit/0cc643c37956eb537ab3dc181a0a3ba38b6ceb58))
- refuse to resume a script whose results changed *(openai-codex)* ([`9e58484`](https://github.com/MadAppGang/claudish/commit/9e584844794890d2f3e4122e25d7c31d8369b7c9))
- skip step 5r on a request that declares no tools *(openai-codex)* ([`b685c9c`](https://github.com/MadAppGang/claudish/commit/b685c9c1a203b0539816aea0695684a4f4c80a7d))
- never hand a forked session the owner's next batch *(openai-codex)* ([`a59220a`](https://github.com/MadAppGang/claudish/commit/a59220a7148f5f52b4895e9ec0296c1b10ef5343))
- end a replayed script at the user's interrupt *(openai-codex)* ([`819c52c`](https://github.com/MadAppGang/claudish/commit/819c52c22bc506ad9dea2ca6d619264e4c6cbe9d))
- pick the round the last message answers in 5r *(openai-codex)* ([`d8ae1c0`](https://github.com/MadAppGang/claudish/commit/d8ae1c0575e01f2825001892da571a694d91087c))
- store a lost script's tombstone after a restart *(openai-codex)* ([`ed786b6`](https://github.com/MadAppGang/claudish/commit/ed786b6f7c9df2b30380113f2641a9236a835980))
- skip output parts for empty text() calls *(openai-codex)* ([`e3f0df1`](https://github.com/MadAppGang/claudish/commit/e3f0df15e1784bffef62e059d932d5abf6668486))
- move an evicted script's record to lost at eviction *(openai-codex)* ([`3abb67a`](https://github.com/MadAppGang/claudish/commit/3abb67a84e0d74ac5bb2de87a7e6a1aa4ddfb47b))
- evict a retired sandbox module's suspended scripts *(openai-codex)* ([`b366f12`](https://github.com/MadAppGang/claudish/commit/b366f12a81de824e4610730da219a36840947ed5))
- keep the CPU deadline armed during script errors *(openai-codex)* ([`ac6f7bd`](https://github.com/MadAppGang/claudish/commit/ac6f7bdc9055e54a16fec52b02d7c255eeff48ac))
- answer a lost exec script's results as Script failed *(openai-codex)* ([`ec3f2cc`](https://github.com/MadAppGang/claudish/commit/ec3f2cce04a88f979c5e031bc29e819d3da04446))
- retry a rejected lite request in classic shape *(openai-codex)* ([`9bb828c`](https://github.com/MadAppGang/claudish/commit/9bb828c66cbfdad074356b5c4e8654b56359ada3))
- apply filterIdentity to the Codex instructions field *(openai-codex)* ([`54ed3f5`](https://github.com/MadAppGang/claudish/commit/54ed3f5e3af921a9de1d78fe91e620e7794f5b26))
- force-refresh the Codex OAuth token on a 401 response *(openai-codex)* ([`c10b21e`](https://github.com/MadAppGang/claudish/commit/c10b21ee81509f3caf2f0ac7f21bc131e8f149c9))
- abort a Codex leg after 150 s without an output item *(openai-codex)* ([`8a4f122`](https://github.com/MadAppGang/claudish/commit/8a4f1229d826b71b738942e0cbdf4aaf1cbfae30))
- retry a degenerate parallel wrapper within the same turn *(adapters)* ([`48e3fc3`](https://github.com/MadAppGang/claudish/commit/48e3fc3c1b7c0e77b7381e74a4fdb34236588698))
- cancel the upstream Responses reader on client disconnect *(adapters)* ([`7d8d89e`](https://github.com/MadAppGang/claudish/commit/7d8d89ebd96d6ecc1e4c07e047c73dc042ff4c3a))
- skip repairToolCall journal entries for empty arguments *(behavior)* ([`330c16a`](https://github.com/MadAppGang/claudish/commit/330c16af0fe2dab62c244c62c485c4aa5e070753))
- expand parallel tool_uses wrapper into tool_use blocks *(adapters)* ([`954e2a8`](https://github.com/MadAppGang/claudish/commit/954e2a835d788a87f7b2670e9ec46d8074433726))
- return an error response for a non-streamed SSE error *(adapters)* ([`2d6213e`](https://github.com/MadAppGang/claudish/commit/2d6213eb9f5f741aa20b03dbedd444a780951a16))
- return stream-failure errors verbatim from FallbackHandler *(routing)* ([`5585472`](https://github.com/MadAppGang/claudish/commit/558547250fb84a1af00ccd529f04c2ae9bcc9ca4))
- emit final function_call arguments when no delta arrived *(adapters)* ([`c4ed58a`](https://github.com/MadAppGang/claudish/commit/c4ed58ae4ac79fa85aca1c4091889f0c14caaa52))

### Documentation

- mark the release playbook verified by v13.4.0 *(release)* ([`0e8efe0`](https://github.com/MadAppGang/claudish/commit/0e8efe0c7242380a10d907030dc2e6102768a4bb))
- update CHANGELOG.md for v13.4.0([`ef4c492`](https://github.com/MadAppGang/claudish/commit/ef4c492df987399af94ecc1bd0e29c237966f3be))
- record the advisor subscription-routing build and bench *(reports)* ([`77a999b`](https://github.com/MadAppGang/claudish/commit/77a999b77b2a7104260264cff768eb31e722f5d2))
- say routedModel holds the planned wire id, not the sent one *(advisor)* ([`a6b2764`](https://github.com/MadAppGang/claudish/commit/a6b2764009e5a5d7be6dd040596b186457424082))
- reclassify the expired-key, Antigravity and go@ failures *(reports)* ([`983ab1f`](https://github.com/MadAppGang/claudish/commit/983ab1fa925c3ffac3264adee5e2af46c502e1c4))
- record the failed models of the 2026-10-21 preflight run *(reports)* ([`453798e`](https://github.com/MadAppGang/claudish/commit/453798ed9e29c5d7c55cd3e5ef8664b35796efd7))
- record the round-2 lease, cancel and redaction rules *(adapters)* ([`2ff49c0`](https://github.com/MadAppGang/claudish/commit/2ff49c0d147ea9f6e04e494e9801fb9a848e923c))
- record that advisor planning resolves fallback hop keys *(advisor)* ([`7037d15`](https://github.com/MadAppGang/claudish/commit/7037d15e6c75a0be16c94fbc38006804558aef8a))
- describe lease release on cancel and the new client sinks *(adapters)* ([`f5b1825`](https://github.com/MadAppGang/claudish/commit/f5b1825dabcddd497cd2f5d5f7300be70520770e))
- add the advisor login and redaction invariants to CLAUDE.md([`df6ef7f`](https://github.com/MadAppGang/claudish/commit/df6ef7ff87d290a6d514c3618fdb6a84f03fe085))
- remove the subscription-aware advisor routing entry *(roadmap)* ([`7b31070`](https://github.com/MadAppGang/claudish/commit/7b31070863eee630638c219e097de0bea010364b))
- describe the call abort and the signing-value registry *(adapters)* ([`46ec048`](https://github.com/MadAppGang/claudish/commit/46ec0486f2006d9da173c09b91269e6683b18d3b))
- replace the advisor's hand-built request note *(wire)* ([`5d8b1a7`](https://github.com/MadAppGang/claudish/commit/5d8b1a70676913d88a2e0fe2b6ba9f6fff2b74ad))
- rewrite panel routing and billing for routed calls *(advisor)* ([`6f91697`](https://github.com/MadAppGang/claudish/commit/6f916977ed5608ecef8a22f4fb76fb4c2ff12833))
- record the bench single-call run and settings collision *(reports)* ([`ac33c15`](https://github.com/MadAppGang/claudish/commit/ac33c159c8217efbdce78c0a2db82c5d6312eec0))
- add the code-mode bench run and V3 credit block *(reports)* ([`b70e213`](https://github.com/MadAppGang/claudish/commit/b70e213d163bc0e5dd3b274184a7dea949cd7cec))
- record the Codex tool-call fix and code-mode validation *(reports)* ([`b046de2`](https://github.com/MadAppGang/claudish/commit/b046de27d792eb9005b02bc702104ad6bce6dfab))
- replace currentAuthArm() with the request's binding arm *(adapters)* ([`13bbba4`](https://github.com/MadAppGang/claudish/commit/13bbba4f3d4f1277fe97de2f075a89af73b51b1b))
- add code-mode.md and list it in CLAUDE.md *(adapters)* ([`d2b8b4b`](https://github.com/MadAppGang/claudish/commit/d2b8b4b87bbc0729fb5ebd9975eb03c6ab038c3e))
- record zero-delta calls, parallel wrapper and leg retry *(adapters)* ([`904f9ce`](https://github.com/MadAppGang/claudish/commit/904f9ce660daf2d23dc20c0908d9deaf01e485d1))
- record the Codex parallel-wrapper factor experiment *(reports)* ([`5c992ec`](https://github.com/MadAppGang/claudish/commit/5c992ece8941d77c508a75400b5391bb64682fb5))

### New Features

- say in the notice that advisor keys are resolved at launch *(advisor)* ([`fd13d8a`](https://github.com/MadAppGang/claudish/commit/fd13d8a6aa3504f9ad5bac5f347b6c1280cef4a1))
- warn when a panel call is billed unlike the notice said *(advisor)* ([`5621fd4`](https://github.com/MadAppGang/claudish/commit/5621fd46a86ea27ff267f155557708b48df2dbb1))
- send panel and collector calls through routing chains *(advisor)* ([`cb8c6bb`](https://github.com/MadAppGang/claudish/commit/cb8c6bba380fcde3fcb81f355d189d5571b91f7b))
- record stats for advisor Claude calls *(advisor)* ([`e633eee`](https://github.com/MadAppGang/claudish/commit/e633eee19984c57102920975c6bf2f7ac177aa73))
- add the Claude Code login arm to the advisor Claude call *(advisor)* ([`c534885`](https://github.com/MadAppGang/claudish/commit/c5348859fc3ab00a7f5cf8444303dd357ea25609))
- add an in-process panel gateway to createProxyServer *(advisor)* ([`7c1f31f`](https://github.com/MadAppGang/claudish/commit/7c1f31f3919efdd92217f0e278cb3def90d00afd))
- build advisor chains from planned hops before the port *(advisor)* ([`bc3291e`](https://github.com/MadAppGang/claudish/commit/bc3291e3636593981a969ad4bdb6831f7472a063))
- add planAdvisorModel over explainRoute for advisor specs *(advisor)* ([`9be309b`](https://github.com/MadAppGang/claudish/commit/9be309ba1bbf4a2ce8cb5d8396789e08a05d5747))
- log tier-1 recovery skips for advisor calls as advisor *(adapters)* ([`d0d2aa5`](https://github.com/MadAppGang/claudish/commit/d0d2aa51c5b908e624639b0a63dcc7103aecb071))
- record each signed hop's provider and arm on the context *(adapters)* ([`3a5c904`](https://github.com/MadAppGang/claudish/commit/3a5c904d9135cde536bf6cda99f9d60e449e1d20))
- stop advancing the routing chain after a call abort *(routing)* ([`aa6a549`](https://github.com/MadAppGang/claudish/commit/aa6a5495d94e9dd2b1b98ec08660c38be7ec7d93))
- end openai and anthropic-compat retry waits on abort *(adapters)* ([`efbe6f4`](https://github.com/MadAppGang/claudish/commit/efbe6f496811cd975754915f9a2e984c1be09f14))
- honour call abort in retries and capacity fallback *(antigravity)* ([`6c1a3eb`](https://github.com/MadAppGang/claudish/commit/6c1a3eba5737e6486d2dc7542df86098d8b851e4))
- stop an aborted internal call's fetch, queue and retries *(adapters)* ([`0022af8`](https://github.com/MadAppGang/claudish/commit/0022af8451e6d1ba78205205b09db4af8f11d0a4))
- redact registered signing values in every log sink *(logging)* ([`3ea38da`](https://github.com/MadAppGang/claudish/commit/3ea38dae2624423288fff4e28bea79ed2ca00517))
- add requestRole "advisor" that writes no token file *(adapters)* ([`4b6ef54`](https://github.com/MadAppGang/claudish/commit/4b6ef547350310b5ca838ead63541e34f4ceb9df))
- add request_role to StatsEvent and its OTLP record *(stats)* ([`1cf14f6`](https://github.com/MadAppGang/claudish/commit/1cf14f6e042fa83ce12aa4a8cc40a8598cfa7e9f))
- enable code mode when /models reports code_mode_only *(openai-codex)* ([`2751a1b`](https://github.com/MadAppGang/claudish/commit/2751a1b791b99cd720458ed359fd7d1409f487f1))
- replay an evicted exec script from history *(openai-codex)* ([`52afe02`](https://github.com/MadAppGang/claudish/commit/52afe02753df1e376b5f5bbb15cbeebfbf145e64))
- replay classic tool rounds as exec items *(openai-codex)* ([`f4a19e2`](https://github.com/MadAppGang/claudish/commit/f4a19e22b82b00f69dd7bbf6f76c28f41b4cacca))
- resume suspended exec scripts from tool_result ids *(openai-codex)* ([`fc0a7b2`](https://github.com/MadAppGang/claudish/commit/fc0a7b26049ea4e4063ddf7e4b3d527042d487e8))
- relay exec tool calls as Claude Code tool_use blocks *(openai-codex)* ([`786010c`](https://github.com/MadAppGang/claudish/commit/786010c24155992600cbbb3f8c73518eddd032d3))
- send the exec tool in lite or classic request shape *(openai-codex)* ([`517a742`](https://github.com/MadAppGang/claudish/commit/517a7422f3cb19a92ce4b19a999a355ad52d9d85))
- build code-mode input from Claude Code messages *(openai-codex)* ([`da2c9c6`](https://github.com/MadAppGang/claudish/commit/da2c9c62fa68171c782c356b0691f38ca4a59cd9))
- keep exec and turn records in byte-bounded stores *(openai-codex)* ([`a854eb4`](https://github.com/MadAppGang/claudish/commit/a854eb4570d7bea28024ef73cd7b3b09311ea357))
- run exec scripts in a QuickJS sandbox *(openai-codex)* ([`bd49a38`](https://github.com/MadAppGang/claudish/commit/bd49a38d1a14a2271142181e517f10ec61029bbd))
- render Claude Code tools into a freeform exec tool *(openai-codex)* ([`38ad55a`](https://github.com/MadAppGang/claudish/commit/38ad55a2b602ed280b9aecbfaf1f66bb127fc156))
- add --code-mode flag and codeMode config *(openai-codex)* ([`0a0fb6d`](https://github.com/MadAppGang/claudish/commit/0a0fb6d7076f3957c190843057144c1522419253))
- read tool_mode from the Codex /models endpoint *(openai-codex)* ([`9f7a1e4`](https://github.com/MadAppGang/claudish/commit/9f7a1e41a99fc363b95a2059acea882f72dfdc4c))

### Other Changes

- v14.0.0 (#336) *(release)* ([`ae3df07`](https://github.com/MadAppGang/claudish/commit/ae3df0714b604419b7cf635262059f6f383c9bf8))
- v14.0.0 *(release)* ([`64a3f9f`](https://github.com/MadAppGang/claudish/commit/64a3f9f403e390c3996824feef9e9a28abe98956))
- merge origin/main (13.4.0 changelog) into worktree-investgiage-gpt-file([`20376e2`](https://github.com/MadAppGang/claudish/commit/20376e2a99604b42f7fbc1d5775b0d46cdef9f75))
- merge origin/main (13.3.0) into worktree-investgiage-gpt-file([`982c116`](https://github.com/MadAppGang/claudish/commit/982c1169c5b25e8989eabfb213db5113406303d0))
- merge origin/main into worktree-investgiage-gpt-file([`20935f6`](https://github.com/MadAppGang/claudish/commit/20935f6c35ad1d70dd92f07778ca9ef34956bced))
- merge origin/main into worktree-investgiage-gpt-file([`5d08ea8`](https://github.com/MadAppGang/claudish/commit/5d08ea8c8890862163b25ebb03198ff6bdb49ff5))
- suppress noConfusingVoidType on the Responses leg-binding helper([`45b2cf8`](https://github.com/MadAppGang/claudish/commit/45b2cf8742c3a1c445c645596761758f60b6da20))

### Performance

- read the transport's redaction secrets once per binding *(devin)* ([`69c4492`](https://github.com/MadAppGang/claudish/commit/69c44927695bc1929330bdec95647317736350a9))

### Refactoring

- remove advisorRouteFor's metered bare-fetch routes *(advisor)* ([`6508ceb`](https://github.com/MadAppGang/claudish/commit/6508ceb727063137ec6c2bee522af961cd0963ba))
- export whether claudish controls the child's auth *(cli)* ([`b1e8f24`](https://github.com/MadAppGang/claudish/commit/b1e8f240241caef29381a1f2aa849e83c5449c10))
- move Claude alias resolution into a leaf module *(advisor)* ([`2ffa959`](https://github.com/MadAppGang/claudish/commit/2ffa959b83ff50a27a0e4a429a8a6bfc38610306))
- move the handler caches into a createHandlerSet factory *(proxy)* ([`23c4073`](https://github.com/MadAppGang/claudish/commit/23c40731a8b1074f8f9507ef91f7d2fe8832d928))
- route ComposedHandler stats through one helper *(adapters)* ([`8891c8e`](https://github.com/MadAppGang/claudish/commit/8891c8ebd8be812e66beadab706b619e2aec98db))
- remove the wasm admission gate that never fires *(openai-codex)* ([`c30375e`](https://github.com/MadAppGang/claudish/commit/c30375e2b24dfa8ed28439306a31088685cf0118))
- add injection points for code-mode tests *(openai-codex)* ([`cb4bf5d`](https://github.com/MadAppGang/claudish/commit/cb4bf5dba3d0a8ebcba09c555e61094e2cf06b34))
- bind fetches to the RequestAuth of their request *(openai-codex)* ([`cf14234`](https://github.com/MadAppGang/claudish/commit/cf1423434893bbefce7ed435919429e0328f9f12))
- split Responses parsing into leg and turn modules *(adapters)* ([`62e9d6b`](https://github.com/MadAppGang/claudish/commit/62e9d6b634ca7c359056e6c2214429f8b8af2bc6))

## [13.4.0] - 2026-10-21

### Bug Fixes

- reject a setup_from that is not an existing directory *(mcp)* ([`174743f`](https://github.com/MadAppGang/claudish/commit/174743feff097edc7be81e3ec03f425be25cf72d))

### Documentation

- record the agent probe and sandbox hook state for work_dir *(mcp)* ([`2274999`](https://github.com/MadAppGang/claudish/commit/227499999270114dc2f2a4a695468041c40856ce))
- mark the release playbook verified by v13.3.0 *(release)* ([`27d8956`](https://github.com/MadAppGang/claudish/commit/27d8956cf32c679093c54d683ef899824208a97f))
- update CHANGELOG.md for v13.3.0([`c4654e9`](https://github.com/MadAppGang/claudish/commit/c4654e921bdba1b5b2e65429204a765bd4853d38))

### New Features

- inherit the caller's settings in a create_session work_dir *(mcp)* ([`df8e124`](https://github.com/MadAppGang/claudish/commit/df8e124dcd696e1985da892381defa4df8a1e80c))

### Other Changes

- v13.4.0 *(release)* ([`633d188`](https://github.com/MadAppGang/claudish/commit/633d18848379b82726f4bcba86bbcb0854a7f0d9))

## [13.3.0] - 2026-10-21

### Bug Fixes

- show a native shortcut only where its route serves it *(listing)* ([`7c32c50`](https://github.com/MadAppGang/claudish/commit/7c32c508717e3d4bc6acefc0ee1f77d39112c56e))
- pin the muse@ base URL before the registry base check *(muse)* ([`be348bb`](https://github.com/MadAppGang/claudish/commit/be348bb6f1cd97c01959cb9760eae4a3f13a955d))
- show the pinned api.meta.ai URL for muse@ connections *(probe)* ([`54dd3b3`](https://github.com/MadAppGang/claudish/commit/54dd3b35054c81e23e4c1951a225b3dd35947d8d))
- read a bare name's context window by its routed wire id *(runner)* ([`ddf7880`](https://github.com/MadAppGang/claudish/commit/ddf7880f56bbee3b412b0a760851e92d617d22b4))
- route bare muse-wonder-full to the muse@ subscription *(muse)* ([`56df54b`](https://github.com/MadAppGang/claudish/commit/56df54b547f5cb5f386a0286de7ffa59d4541a19))

### Documentation

- record the MTL-189 findings and live verification *(muse)* ([`dfa65e8`](https://github.com/MadAppGang/claudish/commit/dfa65e8121e4d373b62c10f9ebecf7b4cd34bb14))
- update CHANGELOG.md for v13.2.0([`9c9a90f`](https://github.com/MadAppGang/claudish/commit/9c9a90fb9ab4ebfb7182c5db38b08bfb89c76168))

### New Features

- decide contributor connections by their contentUse field *(routing)* ([`07662ff`](https://github.com/MadAppGang/claudish/commit/07662fffc62ac8481c4b74db356150f3c18446ee))

### Other Changes

- v13.3.0 *(release)* ([`8188437`](https://github.com/MadAppGang/claudish/commit/818843728e7230c54060d1741f7cf41919a0c694))

## [13.2.0] - 2026-10-21

### Documentation

- document the text body and the internal failure class *(antigravity)* ([`1fa1cef`](https://github.com/MadAppGang/claudish/commit/1fa1cef64e1c034ce0ea5e5188f7acccce57daee))
- replace the stale self-refresh description *(antigravity)* ([`5732aa7`](https://github.com/MadAppGang/claudish/commit/5732aa746104ba8ed53056b6833e94e5b254e2d7))
- document the raw model list command *(antigravity)* ([`9637b84`](https://github.com/MadAppGang/claudish/commit/9637b8486a04908482c7b287d14451a38bfd0701))
- update CHANGELOG.md for v13.1.0([`c19a8ab`](https://github.com/MadAppGang/claudish/commit/c19a8ab0549a22de5d5b69033a14eb3821a29d67))

### New Features

- print a failure object on usage and internal errors *(antigravity)* ([`42091b7`](https://github.com/MadAppGang/claudish/commit/42091b7a5b3a754604d1dd9827eb463df0fb6eb0))
- print the verbatim fetchAvailableModels response text *(antigravity)* ([`eccf5c6`](https://github.com/MadAppGang/claudish/commit/eccf5c662df6f884595ae4a401e81846c97a0338))
- print the raw fetchAvailableModels body as JSON *(antigravity)* ([`5edb656`](https://github.com/MadAppGang/claudish/commit/5edb656243f898836f83dbc9bfe17740f5c71479))

### Other Changes

- v13.2.0 *(release)* ([`f9b4500`](https://github.com/MadAppGang/claudish/commit/f9b4500ba65f63dccd715754694e9da1965760d3))

### Refactoring

- export the token deps and a classified store read *(antigravity)* ([`1cf7df1`](https://github.com/MadAppGang/claudish/commit/1cf7df13ed18562313e00637b5e2fe918e5a9ea2))
- extract fetchAntigravityAvailableModelsRaw from discovery *(antigravity)* ([`8f1741e`](https://github.com/MadAppGang/claudish/commit/8f1741eb515d2c7be951d8526f9cb373468902cd))

## [13.1.0] - 2026-10-21

### Bug Fixes

- checksum every released binary, and match whole filenames *(release)* ([`e6428ca`](https://github.com/MadAppGang/claudish/commit/e6428ca0b65555c835caba39347aec67535e1675))
- ask magmux for the exit code when the child dies while the socket is down *(pane)* ([`f0feba3`](https://github.com/MadAppGang/claudish/commit/f0feba30a60e28314ad07234c10592bd590fa334))
- write journal rows in the order the decisions were made *(hooks)* ([`235affe`](https://github.com/MadAppGang/claudish/commit/235affe92a00b5dd89cfc46ad95f3ac1b5711f18))

### Documentation

- update CHANGELOG.md for v13.0.3([`24d0667`](https://github.com/MadAppGang/claudish/commit/24d0667572ce6c5fa9a47a4092cc3d367018b4fc))

### New Features

- show the catalog selection in `claudish hooks list` *(hooks)* ([`9432c41`](https://github.com/MadAppGang/claudish/commit/9432c41b846aaea6165fdbb7666bd7f89a35c659))

### Other Changes

- v13.1.0 *(release)* ([`8c350e8`](https://github.com/MadAppGang/claudish/commit/8c350e8801c66949a7a868d75b9d769f3da04a02))

## [13.0.3] - 2026-10-21

### Bug Fixes

- cap CLAUDE_CODE_AUTO_COMPACT_WINDOW at 1,000,000 *(context-window)* ([`5406c31`](https://github.com/MadAppGang/claudish/commit/5406c31d97209eb8240b0c0402dbe42707b6bc8f))
- update stale key links in the settings reference *(docs)* ([`553905a`](https://github.com/MadAppGang/claudish/commit/553905a157004108cdaac44e4b3becb8a0673197))
- print the provider API endpoint without its https:// scheme *(tui)* ([`3c4767c`](https://github.com/MadAppGang/claudish/commit/3c4767ce5e70a528f7fb786c423748b07b054cdb))
- replace apiKeyUrl links that 404 or miss the key page *(providers)* ([`f0282dc`](https://github.com/MadAppGang/claudish/commit/f0282dcfaad5de6ebe44d1e36cea22d06651f956))
- retry the definition's model-list URL after a 404 *(discovery)* ([`c54b14e`](https://github.com/MadAppGang/claudish/commit/c54b14ec8267ed502d3dce9e64b05dfd818235eb))

### Documentation

- record the key expiry, Zen Go host split and link audit *(opencode)* ([`da371a2`](https://github.com/MadAppGang/claudish/commit/da371a29d1fe7d6d4744941ded3f1610b12a1b31))
- update CHANGELOG.md for v13.0.2([`b5c9e79`](https://github.com/MadAppGang/claudish/commit/b5c9e7939a6152bfceda49588e99049b5ef22cd4))

### Other Changes

- v13.0.3 *(release)* ([`71395b7`](https://github.com/MadAppGang/claudish/commit/71395b7e51d49284052907995605794825f0e5dc))

## [13.0.2] - 2026-10-21

### Bug Fixes

- keep a socket whose lstat fails for a reason other than ENOENT *(pane)* ([`84e461c`](https://github.com/MadAppGang/claudish/commit/84e461c1ecc2ef8f1454311d5350ebb71d19b1e3))
- check a dial's ENOENT against the socket path *(pane)* ([`63859b5`](https://github.com/MadAppGang/claudish/commit/63859b52f9add8931a36b60b9485ac07fc9af623))
- list a live owner's pane as kept when only kill(pid, 0) vouches for it *(pane)* ([`f01a155`](https://github.com/MadAppGang/claudish/commit/f01a155ed8817b551b5e04115c61a67086cc4108))
- treat a refused pane socket as stale only when its magmux is dead *(pane)* ([`a7f3d93`](https://github.com/MadAppGang/claudish/commit/a7f3d9320817a552533ea5066d7d2991af852a97))
- keep pane files when a socket probe is inconclusive *(pane)* ([`dee6a09`](https://github.com/MadAppGang/claudish/commit/dee6a098d98ef5d30c627e8b5d54848554fe0356))
- stop dead owners' records filling the pane limit without ps *(pane)* ([`3713ac1`](https://github.com/MadAppGang/claudish/commit/3713ac19dcb7738c712c3199132ed3439890be68))
- check a pane owner's start time from etime, not lstart *(pane)* ([`2b35fb3`](https://github.com/MadAppGang/claudish/commit/2b35fb372eee199766a4b21885686efa363b5f0a))
- skip the stats banner in a pane child *(pane)* ([`7a210bf`](https://github.com/MadAppGang/claudish/commit/7a210bffcf8953e2c3b47eac390f9c760dfbe574))
- keep the MCP server alive when ps cannot run in a sandbox *(pane)* ([`72f3c62`](https://github.com/MadAppGang/claudish/commit/72f3c624fdea6aa25eee8b3a23959db4bc052a4e))

### Documentation

- update CHANGELOG.md for v13.0.1([`546b9bc`](https://github.com/MadAppGang/claudish/commit/546b9bc6d583928df92306ba80b0c8bd9bb18ba1))

### Other Changes

- v13.0.2 *(release)* ([`a3c4b9d`](https://github.com/MadAppGang/claudish/commit/a3c4b9d54bbb0300c6acabdb51c79488485be69a))

## [13.0.1] - 2026-10-21

### Bug Fixes

- ship all of bin/ in the npm package, and start the packed package before publishing *(release)* ([`9cf0725`](https://github.com/MadAppGang/claudish/commit/9cf0725ee0a089a8a60025d886d39365109ac950))

### Documentation

- stamp the playbook verified at the v12.3.2 merge *(release)* ([`edb1e57`](https://github.com/MadAppGang/claudish/commit/edb1e574b936d39a473d07824909f585cebd3a82))
- bring main into a release PR with gh pr update-branch *(release)* ([`f4cd82f`](https://github.com/MadAppGang/claudish/commit/f4cd82fc27390b29eaa70cb2bbaf9aa9ff40ba65))
- update CHANGELOG.md for v13.0.0([`2320b8a`](https://github.com/MadAppGang/claudish/commit/2320b8a0ca4af14b8a0b2da38a6bf8f07d8ddc9c))

### Other Changes

- v13.0.1 *(release)* ([`579e14c`](https://github.com/MadAppGang/claudish/commit/579e14c2d32ae3170d17fd2231446c170f973130))

## [13.0.0] - 2026-10-20

### ⚠ BREAKING CHANGES

- closed hooks no longer run concurrently. Two hooks changing one tool's description, schema or a tool call's arguments both apply in chain order, and a later replaceToolDescription drops an earlier append (plan-mode's included). A stored responseEnd note now precedes the request hooks' notes in the system prompt. *(hooks)* ([`1d2a2a7`](https://github.com/MadAppGang/claudish/commit/1d2a2a7895fac0fff41528c9ea864f0c4fa820b3))
- a .env in the working directory no longer sets claudish's other settings. CLAUDISH_PORT, CLAUDISH_RECOVERY, OLLAMA_HOST, GOOGLE_APPLICATION_CREDENTIALS, every *_BASE_URL and every other variable outside provider API keys and CLAUDISH_MODEL / CLAUDISH_MODEL_* must come from the shell or an MCP server's env. *(hooks)* ([`7e83473`](https://github.com/MadAppGang/claudish/commit/7e834738f8a7a75c716cf81f54b50ccd2e9bda14))
- `claudish behavior` is removed with no alias; use `claudish hooks list|corpus|telemetry`. The `behavior` config block is no longer read (it is reported once with where each key moved), and telemetry consent is not carried over. *(hooks)* ([`42bc36c`](https://github.com/MadAppGang/claudish/commit/42bc36ccdf8d0de6918cf1ac373865925286380a))
- the behavior config block no longer configures the proxy. Move behavior.rules to hooks.severity and behavior.hooks to hooks.modules (rewritten to the claudish/hooks contract, apiVersion 1). claudish reports a behavior block on stderr once per process. *(hooks)* ([`dfa70e5`](https://github.com/MadAppGang/claudish/commit/dfa70e5f9fbdd7ac88379804d847663fcc1505ab))

### Bug Fixes

- store the exit code with the exit, so a settle in the capture window keeps it *(pane)* ([`3dce467`](https://github.com/MadAppGang/claudish/commit/3dce467709aaab2dbc2d9e3626957a0b0db6bfb6))
- pass configFile in v12.1.2's native-cursor pane-launch tests after rebase onto v12.1.2 *(hooks)* ([`f79034a`](https://github.com/MadAppGang/claudish/commit/f79034a494c3b7767a259c7e91eb2ff9537461d5))
- run session hooks on v12.1.0's gated send and settle after rebase onto v12.1.0 *(hooks)* ([`c2476b3`](https://github.com/MadAppGang/claudish/commit/c2476b3e26c31ba3516881995db786a55a60c054))
- run v12.0.1's muse@ and prompt-role tests on the hook APIs after rebase onto v12.0.1 *(hooks)* ([`ef9fc16`](https://github.com/MadAppGang/claudish/commit/ef9fc16385e9ac13155976160ad6e01200aa6d8e))
- run hook tests on v11.1.0's session records and nesting rule after rebase onto v11.1.0 *(hooks)* ([`5fdca91`](https://github.com/MadAppGang/claudish/commit/5fdca91b5cd64aa4193e9b5f41eedd3698980382))
- select gemini/thought-signature from catalog data after rebase onto v11.1.0 *(hooks)* ([`1eb8620`](https://github.com/MadAppGang/claudish/commit/1eb86203fe15728c7f18a9186fa55fd94e000651))
- apply response-rewrite steps over what the previous step left *(hooks)* ([`a720867`](https://github.com/MadAppGang/claudish/commit/a7208679d34e8511a31bee3618b2093cbedfa885))
- make every hook context read-only all the way down *(hooks)* ([`b7577fd`](https://github.com/MadAppGang/claudish/commit/b7577fd0bac780ee67d2690bdae8ac48e8f43acf))
- ignore a project .claudish.json model that points at a raw URL *(config)* ([`a7ee35f`](https://github.com/MadAppGang/claudish/commit/a7ee35f70c63fcd9f48d72df29294db48e3791a7))
- load a repository .env through the allowlist in --mcp mode too *(mcp)* ([`117ab9e`](https://github.com/MadAppGang/claudish/commit/117ab9e80a7cbb4dc797f0fb7f7722e32ad4a39b))
- reject a cwd .env model pin that resolves to a raw URL *(hooks)* ([`b689eb6`](https://github.com/MadAppGang/claudish/commit/b689eb69cb9ec8727e434fb042e091024da428f0))
- write the debug log for --mcp --debug-claudish and -d *(mcp)* ([`17b13b9`](https://github.com/MadAppGang/claudish/commit/17b13b9b497079c8043fe71933e882707d7cc1a5))
- report invalid and ignored hooks config in hooks list *(hooks)* ([`ede23d4`](https://github.com/MadAppGang/claudish/commit/ede23d4441738f5b1d4abd64b4250b45d91e498b))
- spawn the login child with --no-env-file, keeping --config *(tui)* ([`5ecd6fc`](https://github.com/MadAppGang/claudish/commit/5ecd6fcfe57d5874d01249b8de32a027f8264523))
- drop every env-file name when Bun loaded the env files *(hooks)* ([`9046d3c`](https://github.com/MadAppGang/claudish/commit/9046d3c6cd1b3276e218753b27cb36493655f9d6))
- read only API keys and model settings from a cwd .env *(hooks)* ([`7e83473`](https://github.com/MadAppGang/claudish/commit/7e834738f8a7a75c716cf81f54b50ccd2e9bda14))
- pass the credentials path to gcloud as an argument *(vertex)* ([`758dac2`](https://github.com/MadAppGang/claudish/commit/758dac26d5d4af76546c9cfbf38a973f575d5ff8))
- pass the parent's --config file to each pane child *(team)* ([`d881379`](https://github.com/MadAppGang/claudish/commit/d881379de41eb8f7032aec784dc5bdc865aa4439))
- ignore claudish control variables set by cwd env files *(hooks)* ([`7be22b4`](https://github.com/MadAppGang/claudish/commit/7be22b4c0a07cfaf3fae686834e903d8516432ee))
- pass hooks frozen copies of the request messages and tools *(hooks)* ([`bb9965b`](https://github.com/MadAppGang/claudish/commit/bb9965bface896f5bce77725b66585f1aa750591))
- validate hook inbox lines at the owner before queueing them *(hooks)* ([`f5718a5`](https://github.com/MadAppGang/claudish/commit/f5718a561ee56c452afd349098f4beb07155cbbd))
- run responseEnd without waiting for warn responseRewrite *(hooks)* ([`3841f73`](https://github.com/MadAppGang/claudish/commit/3841f73daed51ec544d13c06f2a8d82eea900ff6))
- re-wrap stderr and stdout writers replaced after capture *(hooks)* ([`b679f66`](https://github.com/MadAppGang/claudish/commit/b679f66f65cc17e5181b993105604d7743dc5ab4))

### Documentation

- stop naming the magus monitor as a session-record reader([`855f152`](https://github.com/MadAppGang/claudish/commit/855f1527ad57471c750c79b4d954e37272e522d2))
- add --no-env-file to the run-from-source recipes *(serve)* ([`3e71277`](https://github.com/MadAppGang/claudish/commit/3e71277f48c400651d54f1b649c115568c803ac3))
- describe hook records and stop naming the magus monitor *(mcp)* ([`3d32b9d`](https://github.com/MadAppGang/claudish/commit/3d32b9d20a322ad391edae8596998bed560f91e7))
- replace behavior-layer.md with the hook system rationale *(hooks)* ([`71a3b21`](https://github.com/MadAppGang/claudish/commit/71a3b21655546bdefd0ad8479d010228771229ef))
- document the hooks key and the removed behavior block *(config)* ([`39d075b`](https://github.com/MadAppGang/claudish/commit/39d075be2659368b06fed957716e92285dadd41b))
- add the hooks guide with type-checked examples *(hooks)* ([`eb289f3`](https://github.com/MadAppGang/claudish/commit/eb289f3beae033c51d077b6743632fbafdf926d3))
- update CHANGELOG.md for v12.3.2([`d36d27a`](https://github.com/MadAppGang/claudish/commit/d36d27a942e162329a164c9224c7dce079dcaed7))

### New Features

- run an event's hooks in turn, each seeing earlier edits *(hooks)* ([`1d2a2a7`](https://github.com/MadAppGang/claudish/commit/1d2a2a7895fac0fff41528c9ea864f0c4fa820b3))
- wrap claudish -i in magmux when session hooks are loaded *(launcher)* ([`a026b5e`](https://github.com/MadAppGang/claudish/commit/a026b5e0c62734bf434af64379374ad13b9f9d22))
- run session hooks in claudish -i through InteractiveDriver *(hooks)* ([`47125a9`](https://github.com/MadAppGang/claudish/commit/47125a9798face34236731644c2c58cb22a99ae9))
- add InProcessSink for claudish -i responseEnd injections *(hooks)* ([`c9b8790`](https://github.com/MadAppGang/claudish/commit/c9b87909bc1083deebbd2a6f881e5cb015b2cd7e))
- match a human-typed prompt by provenance, not by shape *(pane)* ([`70dc58a`](https://github.com/MadAppGang/claudish/commit/70dc58a4e7ea04010c04fc657bed0a7edb94ed35))
- drive session hooks for create_session and team panes *(mcp)* ([`b29cad8`](https://github.com/MadAppGang/claudish/commit/b29cad80d6d2dd89ae285ba879984cc2f9c2c350))
- hold a settled turn in SETTLING while session hooks run *(pane)* ([`67ba543`](https://github.com/MadAppGang/claudish/commit/67ba5436d6e9829ac6b5b4c59bf07f13e633fff4))
- add SessionHookBinding for pane owners *(hooks)* ([`06c35c7`](https://github.com/MadAppGang/claudish/commit/06c35c7512ca7dd2a1b0158a37d90fd427450b55))
- keep CLAUDISH_HOOK_INBOX and CLAUDISH_HOOK_SESSION in panes *(pane)* ([`3c5efb3`](https://github.com/MadAppGang/claudish/commit/3c5efb3e38d1ae3a6e134f634c6973beab106a92))
- replace claudish behavior with claudish hooks *(hooks)* ([`42bc36c`](https://github.com/MadAppGang/claudish/commit/42bc36ccdf8d0de6918cf1ac373865925286380a))
- export claudish/hooks types and runtime from the package *(hooks)* ([`5fa15b1`](https://github.com/MadAppGang/claudish/commit/5fa15b1bdfd7a8a8590f2bc3acea18385ea70ed5))
- replace MiddlewareManager with the raw hook tier *(hooks)* ([`6057c0c`](https://github.com/MadAppGang/claudish/commit/6057c0c6a00b6a3d29b4d86a09c2e18f3cb96131))
- add the response seam above every stream parser *(hooks)* ([`97a4e87`](https://github.com/MadAppGang/claudish/commit/97a4e870ce85613552e4bff9ab6742b42c68aa98))
- replace applyRequest with the hook request stage *(hooks)* ([`dfa70e5`](https://github.com/MadAppGang/claudish/commit/dfa70e5f9fbdd7ac88379804d847663fcc1505ab))
- add the hook engine, module loader and closed actions *(hooks)* ([`90abd6f`](https://github.com/MadAppGang/claudish/commit/90abd6fe39b40fdc166c1a091e5f6fe7c19a824a))

### Other Changes

- v13.0.0 *(release)* ([`435a303`](https://github.com/MadAppGang/claudish/commit/435a3030fb8f48fbc4e80649e0205809bea6c401))

### Performance

- split SSE events in one pass over each chunk *(hooks)* ([`f217f43`](https://github.com/MadAppGang/claudish/commit/f217f43f35cdac3c216c27c270ce6599482fbff0))

### Refactoring

- move findOwnPane to pane/own-pane.ts *(recovery)* ([`b8bf958`](https://github.com/MadAppGang/claudish/commit/b8bf95843d23a8bf9172ab23c56fe229fa343a6a))

## [12.3.2] - 2026-10-20

### Bug Fixes

- set no ANTHROPIC_API_KEY in a proxied pane child *(pane)* ([`185a9c1`](https://github.com/MadAppGang/claudish/commit/185a9c1b40fa5a8b449a5ff1efa9c4bb39977716))
- keep live panes when the sweep cannot read the process table *(pane)* ([`cbf7996`](https://github.com/MadAppGang/claudish/commit/cbf79965e290925ed4a0036628c39edb98429f79))
- name the ADC account for an authorized_user credential file *(vertex)* ([`ac28515`](https://github.com/MadAppGang/claudish/commit/ac28515e6134ad4784ba8806dc6297a6c85c4d6c))
- run gcloud.cmd for the ADC login on Windows *(tui)* ([`e6ee327`](https://github.com/MadAppGang/claudish/commit/e6ee327b0b3900ac6dce171571eb88e3c70fcd5e))
- clear the "Starting probe proxy…" status after the test starts *(tui)* ([`9abab24`](https://github.com/MadAppGang/claudish/commit/9abab244f5bf884183c921fc2da49862ba7fc443))
- name the credential in the provider Test success line *(tui)* ([`6965ff3`](https://github.com/MadAppGang/claudish/commit/6965ff333254797e6daae9851ecaf498ca0d8827))
- bound the provider Auth note to the detail pane height *(tui)* ([`171d160`](https://github.com/MadAppGang/claudish/commit/171d160b0f65c6838a8f108d254f432976a7ab70))
- label the Vertex s key "set project" *(tui)* ([`fd6b909`](https://github.com/MadAppGang/claudish/commit/fd6b909e979cab17f874a838476ef58857ec3bc0))
- run gcloud ADC login from the Vertex row's l key *(tui)* ([`94f5f33`](https://github.com/MadAppGang/claudish/commit/94f5f33580026de3d45a5c559d03c3da5a221a3d))
- lead model-list errors with the upstream message *(vertex)* ([`14bf07f`](https://github.com/MadAppGang/claudish/commit/14bf07ff995baed5587cb8fbaaf385e020a238cc))

### Documentation

- record the Vertex ADC identity split and cache resets *(reports)* ([`f3887cf`](https://github.com/MadAppGang/claudish/commit/f3887cf9968ce66be841cfd8dba01538e2a5b57f))
- update CHANGELOG.md for v12.3.1([`e13980c`](https://github.com/MadAppGang/claudish/commit/e13980c2e398e04320ffc0b1d6c2dc7188ee0501))

### Other Changes

- v12.3.2 *(release)* ([`469ba5b`](https://github.com/MadAppGang/claudish/commit/469ba5b69b90a628c512e2e3a47bc155f2db60fc))

## [12.3.1] - 2026-10-20

### Bug Fixes

- list ag@ models in the order agy models prints them *(picker)* ([`d8a4819`](https://github.com/MadAppGang/claudish/commit/d8a48196ff5cf28ef6eca8b52ed57faa70001823))
- send the installed agy version in the User-Agent *(antigravity)* ([`c2ec41c`](https://github.com/MadAppGang/claudish/commit/c2ec41ccca9f8142ec4347dd6467c4d975749cc1))

### Documentation

- update CHANGELOG.md for v12.3.0([`7e73bb6`](https://github.com/MadAppGang/claudish/commit/7e73bb665a3cd564f959dcdf14174f3ef483033a))

### Other Changes

- v12.3.1 *(release)* ([`6e2ed7c`](https://github.com/MadAppGang/claudish/commit/6e2ed7c6cce2ec504a667814f12ded7434d5847c))

## [12.3.0] - 2026-10-20

### Bug Fixes

- match select footers across wrapped rows in isUnnamedChoice *(pane)* ([`5371143`](https://github.com/MadAppGang/claudish/commit/53711434a91431e8faed00aa22511a156b99a470))

### Documentation

- quote the Bash dialog's rows from the true 40x24 screen *(pane)* ([`1fb4641`](https://github.com/MadAppGang/claudish/commit/1fb46411de6d484c6dad6fadf8471d65d78e64ac))
- update CHANGELOG.md for v12.2.2([`0957b79`](https://github.com/MadAppGang/claudish/commit/0957b79e16d11b4ec0a6b5cfdf5c792922926246))

### New Features

- lower resize_session's minimum width from 80 to 40 columns *(mcp)* ([`75945c6`](https://github.com/MadAppGang/claudish/commit/75945c6513d5058267ee010b1df7d8bc093236d9))

### Other Changes

- v12.3.0 *(release)* ([`dc8c316`](https://github.com/MadAppGang/claudish/commit/dc8c316a63762de8ffe11527a6f42405b61069bf))

## [12.2.2] - 2026-10-20

### Bug Fixes

- show the signer of a live muse@ request over a sibling rejection *(probe)* ([`2735ac1`](https://github.com/MadAppGang/claudish/commit/2735ac1f4e0c1bf25e5976e48b38639c050202e2))
- set the config TUI's Keychain role to never in an MCP session *(mcp)* ([`bbd4c40`](https://github.com/MadAppGang/claudish/commit/bbd4c40ab3af0f2b6db3be421745e5a06a7cecdb))
- keep wrapped BREAKING CHANGE footer lines in the changelog *(release)* ([`33822ae`](https://github.com/MadAppGang/claudish/commit/33822aef5b9eae0d3b8d1d0b33bf17472c350eb2))

### Documentation

- record why deepseek-v4-pro answers wrong on Zen Go *(reports)* ([`a7e1770`](https://github.com/MadAppGang/claudish/commit/a7e17707c8159376a365400a88800c68975ce441))
- record the re-run of the 8 recommended-model Bench rows *(reports)* ([`110c667`](https://github.com/MadAppGang/claudish/commit/110c667e4fda66e4eb14eb12691405fd4369541c))
- update CHANGELOG.md for v12.2.1([`1eec9a8`](https://github.com/MadAppGang/claudish/commit/1eec9a8e9f87fa2faf2db9b305a557df5d7069a3))

### Other Changes

- v12.2.2 *(release)* ([`9234732`](https://github.com/MadAppGang/claudish/commit/9234732e251d1bc255b969db161e4a8e5b2760e7))
- v12.2.1 *(release)* ([`fae5141`](https://github.com/MadAppGang/claudish/commit/fae514124649537123c047069312ad1139d6a1b8))

## [12.2.1] - 2026-10-20

### Bug Fixes

- compare session paths to cwd by realpath *(team)* ([`6af3a69`](https://github.com/MadAppGang/claudish/commit/6af3a690588861f9bd5da2b66b76c91af98161f0))
- keep the MCP server alive when ps cannot be spawned *(pane)* ([`df391d3`](https://github.com/MadAppGang/claudish/commit/df391d32005110818a38b72c47e42fd8fc4b8da6))

### Documentation

- update CHANGELOG.md for v12.2.0([`55c1906`](https://github.com/MadAppGang/claudish/commit/55c19061a504686e168b715cb3604e785a09222b))

### Other Changes

- v12.2.1 *(release)* ([`6278a3e`](https://github.com/MadAppGang/claudish/commit/6278a3eb696c40c267d7dff98af5e25fbad5818b))

## [12.2.0] - 2026-10-20

### Bug Fixes

- try other subscriptions after a subscription login fails *(routing)* ([`8c06927`](https://github.com/MadAppGang/claudish/commit/8c069277c153ebd20dcde2a789427c762a65f721))

### Documentation

- update CHANGELOG.md for v12.1.2([`5ef7507`](https://github.com/MadAppGang/claudish/commit/5ef7507ed56dd38e187d28c5693b8e520deb643d))

### Other Changes

- v12.2.0 *(release)* ([`803b411`](https://github.com/MadAppGang/claudish/commit/803b41163e4cebd2dcc90ef85c2d39e768379120))

## [12.1.2] - 2026-10-20

### Bug Fixes

- start pane children with Claude Code's native cursor *(pane)* ([`6265866`](https://github.com/MadAppGang/claudish/commit/626586617143c6c38751467b9db470574005819a))

### Documentation

- record the 2026-10-20 recommended-models Bench run *(reports)* ([`34fbe21`](https://github.com/MadAppGang/claudish/commit/34fbe212af1172f13480a7de9f4725e6c8091087))
- update CHANGELOG.md for v12.1.1([`43eeca1`](https://github.com/MadAppGang/claudish/commit/43eeca1e4c02fde1b4392b7b98be6480ab6822db))

### Other Changes

- v12.1.2 *(release)* ([`7efd15b`](https://github.com/MadAppGang/claudish/commit/7efd15bb5a774b6a286da2a6c6e42891799be9b5))

## [12.1.1] - 2026-10-20

### Bug Fixes

- bundle magmux 0.18.0, which binds deep pane socket paths *(pane)* ([`dd91ceb`](https://github.com/MadAppGang/claudish/commit/dd91cebfe51f59f637a7f89336a743aaf94ece06))
- accept pane socket paths of 100 bytes or more *(pane)* ([`7836e09`](https://github.com/MadAppGang/claudish/commit/7836e09a70660dca7ed6afce44b99a25ae643f68))

### Documentation

- update CHANGELOG.md for v12.1.0([`2a66aeb`](https://github.com/MadAppGang/claudish/commit/2a66aebcac4005fc3670cc3d10f5a98c373feb51))

### Other Changes

- v12.1.1 *(release)* ([`02b6009`](https://github.com/MadAppGang/claudish/commit/02b600917d7c23c0410bc3611f3732a7b4923faa))

### Refactoring

- read the magmux minimum in help text from MIN_MAGMUX_VERSION *(mcp)* ([`50850fa`](https://github.com/MadAppGang/claudish/commit/50850fab617366076e54d1f7256562d6d774706f))

## [12.1.0] - 2026-10-20

### Bug Fixes

- run one magmux --version probe for panes that start together *(pane)* ([`378b854`](https://github.com/MadAppGang/claudish/commit/378b85448d88e01e9112990d3343923ebddaa2aa))
- corroborate turn settle with the input gate, not the box *(pane)* ([`af427dd`](https://github.com/MadAppGang/claudish/commit/af427ddf81ba1d473b02f9ba89e482d130aff56c))
- submit each prompt through one gated magmux send *(pane)* ([`1673aeb`](https://github.com/MadAppGang/claudish/commit/1673aeb89ef2c5689306002ea68e2422a525c428))
- keep an explicit typed:false on a magmux failure reply *(pane)* ([`64233a2`](https://github.com/MadAppGang/claudish/commit/64233a2f90e14765b10b02f531257a250c3dfc1e))
- read a binding missing its id or path as unbound *(pane)* ([`5e664f2`](https://github.com/MadAppGang/claudish/commit/5e664f22a2b421cd5c17fbc522f7b7d0f1b2f6c7))
- read maybeSubmitted from the magmux reply *(pane)* ([`2b03645`](https://github.com/MadAppGang/claudish/commit/2b03645c099065293fd88a998726fbb455e15eae))
- clamp resize_session width to 250 columns, not 500 *(mcp)* ([`f67bd3a`](https://github.com/MadAppGang/claudish/commit/f67bd3aaa6467a7d30daca63bb3588630f1cb3f5))
- send a resize_session size stored during a redial *(pane)* ([`6978d2a`](https://github.com/MadAppGang/claudish/commit/6978d2a5f5ae463706aaa316e5b93fe6e465169f))
- require magmux 0.15.1 so a taller pane redraws Claude Code *(team)* ([`243bd01`](https://github.com/MadAppGang/claudish/commit/243bd0142b700839a94036e3a8d8468989c55759))
- match echo, dialog and working rows at any terminal width *(pane)* ([`cd6baf3`](https://github.com/MadAppGang/claudish/commit/cd6baf37b9ba268926b17805574328ba071bcdd7))

### Documentation

- record the live validation of resize_session and team resize *(reports)* ([`80b6d4e`](https://github.com/MadAppGang/claudish/commit/80b6d4e64518a9be832db6ad152c1a0d09f58b87))
- close the magmux controller and double-typed prompt items *(roadmap)* ([`2ea9dfb`](https://github.com/MadAppGang/claudish/commit/2ea9dfbd845eafbea155c15ea3e321c3783b189a))
- document the magmux input gate in pane-session.md *(pane)* ([`d19050c`](https://github.com/MadAppGang/claudish/commit/d19050c1f297e0b1aa2f912dbf15171e07798f1d))
- update CHANGELOG.md for v12.0.1([`0d875ef`](https://github.com/MadAppGang/claudish/commit/0d875ef062a688e162f1f10c45091dd8f33e3936))

### New Features

- remove the 250-column cap from resize_session *(mcp)* ([`7d43b73`](https://github.com/MadAppGang/claudish/commit/7d43b73263e737c46e491e52ef60de139057459e))
- read boot readiness and dialogs from the magmux input gate *(pane)* ([`2462745`](https://github.com/MadAppGang/claudish/commit/24627459e8cb4312936eebbff2aa825e32976719))
- bind each pane to its transcript in magmux's input gate *(pane)* ([`ea1b992`](https://github.com/MadAppGang/claudish/commit/ea1b99280c83421e253b3f3de5a6f3c2d0bbb56c))
- locate the input box by the cursor row *(pane)* ([`dd5baac`](https://github.com/MadAppGang/claudish/commit/dd5baac62ab053e5cca175952e29dfdfa74ea092))
- keep magmux reply reason and typed fields *(pane)* ([`c36359f`](https://github.com/MadAppGang/claudish/commit/c36359f614c69cb2c3c424520b81a2d972013c31))
- list resize in the contract capabilities *(mcp)* ([`ab23345`](https://github.com/MadAppGang/claudish/commit/ab2334508ea8d6ec870e6df1adf13dadaad61c4c))
- require magmux 0.15.0 and ship it in the npm packages *(team)* ([`2e2e836`](https://github.com/MadAppGang/claudish/commit/2e2e8361b230fe1d4e1cc4aa58ed747ae99c9fb5))
- add resize_session tool and team mode resize *(mcp)* ([`9c400d2`](https://github.com/MadAppGang/claudish/commit/9c400d235d7e742b2ee92272d42f232512c57cc4))

### Other Changes

- raise the hermetic test step timeout to 40 minutes *(ci)* ([`1f72a19`](https://github.com/MadAppGang/claudish/commit/1f72a1996030d50040b648e62c87960a7d64309e))
- v12.1.0 *(release)* ([`458adf6`](https://github.com/MadAppGang/claudish/commit/458adf6be7c6d19a7b5de38bbd33b93ebd938211))

## [12.0.1] - 2026-10-20

### Bug Fixes

- copy tool, reasoning and vision support into recommended rows *(catalog)* ([`14e7e60`](https://github.com/MadAppGang/claudish/commit/14e7e606f7c2b1331dcd8741047ee989a541eefe))

### Documentation

- document supportsTools, supportsReasoning and supportsVision *(catalog)* ([`ad0c82e`](https://github.com/MadAppGang/claudish/commit/ad0c82e62f9e03bba91ee6cd60977b27363162f9))
- stamp the playbook verified at the v12.0.0 merge *(release)* ([`dfd23e6`](https://github.com/MadAppGang/claudish/commit/dfd23e6203566381138fc1946dc7a43ad7b90338))
- update CHANGELOG.md for v12.0.0([`f1d641a`](https://github.com/MadAppGang/claudish/commit/f1d641ae0ced799f0dabae3803e399d7719adf9a))

### Other Changes

- v12.0.1 *(release)* ([`c6115ea`](https://github.com/MadAppGang/claudish/commit/c6115eacdadbfa181bb238fe0bad9686d61bb72b))

## [12.0.0] - 2026-10-20

### ⚠ BREAKING CHANGES

- meta@<model> no longer routes to OllamaCloud. Use oc@<model> or llama@<model> for OllamaCloud. *(ollamacloud)* ([`2724916`](https://github.com/MadAppGang/claudish/commit/2724916dfc3ca0dec5bf4e41c8c2c319ac493de2))

### Bug Fixes

- keep the shutdown hook outside the SIGINT event-loop hold *(mcp)* ([`b3934a6`](https://github.com/MadAppGang/claudish/commit/b3934a667787b6246dd99296cfc4c51658c80a53))
- exit 130 on SIGINT instead of 0 after the pane reap *(team)* ([`b31e383`](https://github.com/MadAppGang/claudish/commit/b31e38329db2182b667b5935cb37e6e92c8e9d44))
- deny Keychain prompts to every process in an MCP session *(auth)* ([`c099163`](https://github.com/MadAppGang/claudish/commit/c099163b7e3097ff7e602b9a2e274cc2a095a777))
- name the Muse signer when a signed probe request fails *(probe)* ([`20a2a87`](https://github.com/MadAppGang/claudish/commit/20a2a87fd1bdb608623e8a589ea3da123eb3e5fd))
- show the Muse Key line only when muse@ answered the probe *(probe)* ([`ead3017`](https://github.com/MadAppGang/claudish/commit/ead3017acce5a7d9e53d31818b185b967e1c9f11))
- take x-claudish-signed-with from the request's own key *(probe)* ([`4cb9d3d`](https://github.com/MadAppGang/claudish/commit/4cb9d3da167c970075b768626dab6c1a4188c0d5))
- keep upstream_status 401/403 on a rejected login *(meta-muse-code)* ([`04360e8`](https://github.com/MadAppGang/claudish/commit/04360e8d0b1d627f99787489fa0467b18669bb02))
- show the Muse login fix when muse@ is dropped for no login *(probe)* ([`1a6acd8`](https://github.com/MadAppGang/claudish/commit/1a6acd8056012cb67ad24e428039aa76526b6a97))
- show the Muse Key line in the interactive --probe screen *(probe)* ([`0c62978`](https://github.com/MadAppGang/claudish/commit/0c62978a71545a4c3c37828c3754e0cccc33fbed))
- name the Muse login that signed each probe request *(probe)* ([`a7a7655`](https://github.com/MadAppGang/claudish/commit/a7a765500b56d1a40a885b016870f5ade6c31678))
- keep one-line remedies in preflight no-route rows *(mcp)* ([`0da6f59`](https://github.com/MadAppGang/claudish/commit/0da6f59c624423570c7643d38b542109e9c38b10))
- add the login instruction to a preflight no-route row *(mcp)* ([`e1099a8`](https://github.com/MadAppGang/claudish/commit/e1099a85143852a640519522ad3253be8e3b0d7f))
- say a rejected Muse login was rejected, not missing *(meta-muse-code)* ([`410ee8f`](https://github.com/MadAppGang/claudish/commit/410ee8ff066ca789c6ead96df126ab218ca38407))
- show the Muse Code login source and tier on the Key line *(probe)* ([`4eba300`](https://github.com/MadAppGang/claudish/commit/4eba3001d5dbd69c44c401d35f1fa59d59d7522d))
- read tool_call from the Muse models list *(meta-muse-code)* ([`d8fe49b`](https://github.com/MadAppGang/claudish/commit/d8fe49b5c427de6908976d0cbc850312fe0a6535))
- send no device-code poll after the code expires *(meta-muse-code)* ([`267a5fe`](https://github.com/MadAppGang/claudish/commit/267a5feb54f0e8dd26cf00f858beacee203796f1))
- stop calling a local Muse mint error unreachable *(meta-muse-code)* ([`60f79e7`](https://github.com/MadAppGang/claudish/commit/60f79e781e611ca3e5cb490de6f59d587b7586e9))
- retry a 2xx Muse key mint whose body is not JSON *(meta-muse-code)* ([`24bb804`](https://github.com/MadAppGang/claudish/commit/24bb8040c7c9436a0088f00c5706fcb62f786ca3))
- stop a subscription chain on a raw 403 credential rejection *(routing)* ([`45d74c8`](https://github.com/MadAppGang/claudish/commit/45d74c8a9e27d4e94b8f59574c0ed80327d6052f))
- report a 401/403 on the parameter-recovery re-fetch *(errors)* ([`d1500aa`](https://github.com/MadAppGang/claudish/commit/d1500aae206850d59342fbab5b8a425ad3163ecf))
- tell a rejected subscription login to run claudish login *(errors)* ([`d037370`](https://github.com/MadAppGang/claudish/commit/d03737085d03721c548e5b3290cfcd5e586a8afa))
- answer a subscription's unclassified primary-fetch throw 503 *(errors)* ([`d1fbde6`](https://github.com/MadAppGang/claudish/commit/d1fbde695da66f38133c7c64eac059b75a67ea1d))
- restore the real Muse login stores after test:safe *(meta-muse-code)* ([`bf4736b`](https://github.com/MadAppGang/claudish/commit/bf4736b8b37da4424ee02c562402413f73aff1fb))
- retry a 2xx token refresh that carries no access_token *(errors)* ([`3adfc29`](https://github.com/MadAppGang/claudish/commit/3adfc299384d9989a798a9d748106e0400734f20))
- delete the Kimi login only on a 401/403 or invalid_grant 400 *(kimi)* ([`78e8b3e`](https://github.com/MadAppGang/claudish/commit/78e8b3e59f9b492fa77f0df54a0de42d357419b5))
- drop the login hint from a 429/5xx token refresh *(openai-codex)* ([`30f6c88`](https://github.com/MadAppGang/claudish/commit/30f6c8871e84f66c5f55ebf0877737e7f97230bd))
- refuse a kc@ request that no credential signs *(kimi-coding)* ([`00832e8`](https://github.com/MadAppGang/claudish/commit/00832e848f80af21b3786686e766352534ebb5f2))
- drop Keychain results that finish after a Muse reset *(meta-muse-code)* ([`a1172e6`](https://github.com/MadAppGang/claudish/commit/a1172e6919fc84cbcbabb34d9f98254ae51ec628))
- sign kc@ with only its own key after a rejected login *(kimi-coding)* ([`d3821f7`](https://github.com/MadAppGang/claudish/commit/d3821f7cbecb6e6ee0bd4345fe1f1dd19b0f9550))
- keep the Kimi login on a refresh blip or non-JSON 200 *(kimi)* ([`c14e162`](https://github.com/MadAppGang/claudish/commit/c14e16231140382d975ca4381317dee26968c8ff))
- keep a stalled refresh body retryable, never a dead login *(openai-codex)* ([`41ffcd8`](https://github.com/MadAppGang/claudish/commit/41ffcd852159c7a2eac9fb0b77bde52d2a05e9eb))
- send the Muse login only to api.meta.ai *(meta-muse-code)* ([`f08e5d9`](https://github.com/MadAppGang/claudish/commit/f08e5d97c4332557233ae8f6b3cbea8647d2d0a8))
- hold an approved Keychain token only after its mint fails *(meta-muse-code)* ([`36b5446`](https://github.com/MadAppGang/claudish/commit/36b54463ab5b29d9b841f6f50f2d1b8699f251c8))
- drop held Keychain tokens on a Muse credential reset *(meta-muse-code)* ([`e6a0e0c`](https://github.com/MadAppGang/claudish/commit/e6a0e0c5520426b41b9442334d071a10fde23659))
- skip the borrowed-copy write of a fenced Muse resolve *(meta-muse-code)* ([`a74f6e2`](https://github.com/MadAppGang/claudish/commit/a74f6e2d883cf0ae1a5fe414d1ea0d839d96426c))
- ignore a cwd .env's host opt-in for the Muse login *(meta-muse-code)* ([`f65763a`](https://github.com/MadAppGang/claudish/commit/f65763adbb4c7ba60a9d309ab9d7a0e40d3541bb))
- keep a forced refresh's agy timeout retryable *(antigravity)* ([`b161d13`](https://github.com/MadAppGang/claudish/commit/b161d1331917d73bd980820563e0f297ea6c4524))
- retry a token-host blip before the CLI credential *(grok-subscription)* ([`e40d109`](https://github.com/MadAppGang/claudish/commit/e40d109b6d6326d895ddf4c938b4a1b829814003))
- keep an interrupted token-refresh body retryable *(grok-subscription)* ([`698df0a`](https://github.com/MadAppGang/claudish/commit/698df0aad596afab3ba857691b87e4d575a55090))
- surface an OAuth refresh failure instead of an empty key *(kimi-coding)* ([`95d17a8`](https://github.com/MadAppGang/claudish/commit/95d17a83aaa136164018d5641ebb206bb4caaa3e))
- stop on a rejected OAuth refresh instead of the API key *(openai-codex)* ([`1ca8ccb`](https://github.com/MadAppGang/claudish/commit/1ca8ccbb19c943a6a95640b04013ef9c5a8de5e0))
- open only an https verification URL during login *(meta-muse-code)* ([`418d49c`](https://github.com/MadAppGang/claudish/commit/418d49c375f1b7d8729e507e16f781b3773c374c))
- keep the team-slot login message after a 401 re-mint *(meta-muse-code)* ([`49d88ea`](https://github.com/MadAppGang/claudish/commit/49d88eaba8499068d3d99589549154629e788de7))
- read the Muse Keychain login before testing a Muse Code row *(tui)* ([`0f459ef`](https://github.com/MadAppGang/claudish/commit/0f459efd2cc4ea84c4e3bc5e791083d0e0d78138))
- bound each login request and keep polling on a 5xx *(meta-muse-code)* ([`8784723`](https://github.com/MadAppGang/claudish/commit/8784723fd7be712491a77b021eb6e3425f4c8dec))
- fence a Muse resolve that outlives a credential reset *(meta-muse-code)* ([`fc2bfaf`](https://github.com/MadAppGang/claudish/commit/fc2bfaf02804da6cdf907c9e70b2f675966c920f))
- stop the Keychain read lock spinning without a deadline *(meta-muse-code)* ([`c4749fe`](https://github.com/MadAppGang/claudish/commit/c4749fe191d576a1867dcc83c6a7718026872ba0))
- refuse to send the Muse login to a non-Meta host *(meta-muse-code)* ([`a1528b1`](https://github.com/MadAppGang/claudish/commit/a1528b1885c1f397d87f4ca687b1c546d44600ac))
- keep a mint body-read reset as a connection fault *(meta-muse-code)* ([`09a3cd4`](https://github.com/MadAppGang/claudish/commit/09a3cd4bdc37d062b9221da66a33d2c9826d054b))
- return an auth-verdict response verbatim from FallbackHandler *(errors)* ([`4c397f3`](https://github.com/MadAppGang/claudish/commit/4c397f3905594eb8b7cd26298c45b5020dfc5efc))
- retry a subscription token host's 429/5xx instead of a 400 *(errors)* ([`264b275`](https://github.com/MadAppGang/claudish/commit/264b275907af818e02ed6bc0975c4e8f75224508))
- advance past an opencode-zen-go 401 for an uncarried model *(errors)* ([`5d57a9e`](https://github.com/MadAppGang/claudish/commit/5d57a9e2ec6d3012a2c7cf540195ab1bf0450447))
- classify auth failures alike at every auth site *(errors)* ([`7fbd96f`](https://github.com/MadAppGang/claudish/commit/7fbd96f184dc5dc152a0783666697a4bad4b73f6))
- stop the routing chain on a subscription credential failure *(errors)* ([`72d63cc`](https://github.com/MadAppGang/claudish/commit/72d63cc34419d7a373e3babd419640592684620e))
- apply plan membership to gathered subscription candidates *(routing)* ([`9830dda`](https://github.com/MadAppGang/claudish/commit/9830dda1e8f021c6f6a613723fac6df0b90e733d))
- exclude contributor wire ids unless typed exactly *(routing)* ([`13d4e69`](https://github.com/MadAppGang/claudish/commit/13d4e691e4304202321ace37b8fc0bad75874f22))
- remove the meta@ shortcut *(ollamacloud)* ([`2724916`](https://github.com/MadAppGang/claudish/commit/2724916dfc3ca0dec5bf4e41c8c2c319ac493de2))

### Documentation

- add the live validation report for muse@ *(meta-muse-code)* ([`11584f4`](https://github.com/MadAppGang/claudish/commit/11584f4b20209186997992b0f0e553027d4d49fc))
- record tests that read the real ~/.claudish and pass only locally *(testing)* ([`6ed99e6`](https://github.com/MadAppGang/claudish/commit/6ed99e6f1947cd3fbf27b5dfe567bd181ad87918))
- put getRecoveryHint's JSDoc back above it *(errors)* ([`2a6031e`](https://github.com/MadAppGang/claudish/commit/2a6031e43ba7cfc8813244ede2dcc34467962912))
- put credentialHintFrom's JSDoc back above it *(probe)* ([`3e99892`](https://github.com/MadAppGang/claudish/commit/3e998920430e9dfc2a4791bc97efa403076260af))
- describe the rethrow in the Codex transport comments *(openai-codex)* ([`51b8f53`](https://github.com/MadAppGang/claudish/commit/51b8f5362d85d8498e2129512bcfd517b48ce684))
- move setMuseKeychainTestDeps' JSDoc back above it *(meta-muse-code)* ([`4ea77d9`](https://github.com/MadAppGang/claudish/commit/4ea77d97cfeb1f84b07b71d0c4562ca498b63fb2))
- document unclassified subscription auth failures as 503 *(errors)* ([`7c83735`](https://github.com/MadAppGang/claudish/commit/7c83735e335a739262d788fa4cfd9cbaa4e5ae4e))
- state the stale-lock reclaim window in muse-keychain.ts *(meta-muse-code)* ([`0752594`](https://github.com/MadAppGang/claudish/commit/075259444338748bbec3059d668b71989948246b))
- track the Muse Code wire capture notes *(meta-muse-code)* ([`c1b25c5`](https://github.com/MadAppGang/claudish/commit/c1b25c5c2660199fc84e9868d73faa058fcd8f18))
- add the Muse Code usage page and the meta@ shortcut rows([`41464d6`](https://github.com/MadAppGang/claudish/commit/41464d6df37b18219bff499b794965aa24bd146b))
- record the Muse Code wire and Keychain login *(meta-muse-code)* ([`dfd0c96`](https://github.com/MadAppGang/claudish/commit/dfd0c9661e82cd4499fc726218682760e39bce0b))
- add the models-index tasks for a Muse Code route *(meta)* ([`f173620`](https://github.com/MadAppGang/claudish/commit/f173620bf00fd4db04450c45f95369a099d15a8b))
- stamp the playbook verified at the v11.1.0 merge *(release)* ([`24461bc`](https://github.com/MadAppGang/claudish/commit/24461bc60db237662ab4fe6216674002dcfb9a15))
- update CHANGELOG.md for v11.1.0([`3647c88`](https://github.com/MadAppGang/claudish/commit/3647c88fe5b088162d67526589b83054a10cb5b8))

### New Features

- add claudish login muse with Meta device code *(meta-muse-code)* ([`c60836f`](https://github.com/MadAppGang/claudish/commit/c60836f38157cd097e9218c6ecdc462925ee5ad7))
- borrow reasoning effort from the meta direct-api wire *(meta-muse-code)* ([`795c8aa`](https://github.com/MadAppGang/claudish/commit/795c8aaad44108326582ddc702f8f97f5ae88dbc))
- prepare the Muse login before Claude Code starts *(meta-muse-code)* ([`2d968a6`](https://github.com/MadAppGang/claudish/commit/2d968a6745ee85bb710090e9cafad4679d41b254))
- list muse@ models from /muse-code/models *(picker)* ([`b99a4be`](https://github.com/MadAppGang/claudish/commit/b99a4be315506a7e7bd85110d36b261fb2c1a173))
- add muse@ signed by the Muse Code login *(meta-muse-code)* ([`a5e67ec`](https://github.com/MadAppGang/claudish/commit/a5e67ec026f843ee90d75dea318a131c067de59c))
- read the Muse Keychain login with a per-machine lock *(meta-muse-code)* ([`7e9ea74`](https://github.com/MadAppGang/claudish/commit/7e9ea74995208299a3c191df15b3e0cbdc404837))
- add the Muse key mint with entitlement checks *(meta-muse-code)* ([`b5fa734`](https://github.com/MadAppGang/claudish/commit/b5fa734a377cd2d5b0c3a174dd2e0be1bb5d887d))
- fix the credential prompt role once per process *(auth)* ([`17c4392`](https://github.com/MadAppGang/claudish/commit/17c43922bac0bb9b47953094b669ba25b4decbc8))
- add the metered meta provider for META_API_KEY *(meta)* ([`a6d8391`](https://github.com/MadAppGang/claudish/commit/a6d83918ec295fa6faf3180b821472e2ec855b20))

### Other Changes

- v12.0.0 *(release)* ([`adc3b96`](https://github.com/MadAppGang/claudish/commit/adc3b96b01796a36a34bd65faadef382a95b1e44))
- apply biome format to composed-handler and muse-mint *(meta-muse-code)* ([`d780111`](https://github.com/MadAppGang/claudish/commit/d7801118f09ac05f01d24e339107bb57eefc88da))

### Refactoring

- add a joinable spawnAsync with no kill path *(keychain)* ([`79023a0`](https://github.com/MadAppGang/claudish/commit/79023a041487c6f4c3fe234c2e56921a9aed3a44))

## [11.1.0] - 2026-10-19

### Documentation

- say recent rows reach the calling agent, not stay local *(team)* ([`34519f8`](https://github.com/MadAppGang/claudish/commit/34519f80c330f88613e91d45d3c2df9158713ea4))
- record the live validation of SlotRow.recent *(reports)* ([`32415f7`](https://github.com/MadAppGang/claudish/commit/32415f7033631777519ed3f9b4e66746970ed07b))
- remove the background-agent settle item fixed in 11.0.0 *(roadmap)* ([`fc9b476`](https://github.com/MadAppGang/claudish/commit/fc9b476f0e207ebe6c67d4b3e408f2ca601b8266))
- record the double-typed prompt and the text-shaped API error *(roadmap)* ([`b9b2c7b`](https://github.com/MadAppGang/claudish/commit/b9b2c7b85f4d5d6aa533929c9b1db910a52b2c9c))
- stamp the playbook verified at the v11.0.0 merge *(release)* ([`b8ce659`](https://github.com/MadAppGang/claudish/commit/b8ce6592ac015dd02c99a37294c78111614306bd))
- update CHANGELOG.md for v11.0.0([`0065691`](https://github.com/MadAppGang/claudish/commit/006569193cfbe83e01dab22b2e2cce0c56da8c01))

### New Features

- add recent steps to SlotRow for team and session rows *(team)* ([`01b28bb`](https://github.com/MadAppGang/claudish/commit/01b28bb92ff1f792587e9110079251c91bc64727))

### Other Changes

- v11.1.0 *(release)* ([`adf58ea`](https://github.com/MadAppGang/claudish/commit/adf58eab8fcb8003985cb6c275bdc5fa9bad82f3))

## [11.0.0] - 2026-10-19

### ⚠ BREAKING CHANGES

- a bare `claudish team run` no longer opens the grid; pass --grid for it. *(team)* ([`3a35680`](https://github.com/MadAppGang/claudish/commit/3a356804b3a777d8a48249e60fbfdae4e4111ce9))

### Bug Fixes

- run `team run` as panes when --grid is not given *(team)* ([`3a35680`](https://github.com/MadAppGang/claudish/commit/3a356804b3a777d8a48249e60fbfdae4e4111ce9))
- keep an existing input.md when `team run` has no --input *(team)* ([`b7a708a`](https://github.com/MadAppGang/claudish/commit/b7a708a2415e0f340909db1c795633929790b469))
- settle turns whose background agents finish mid-turn *(pane)* ([`a673918`](https://github.com/MadAppGang/claudish/commit/a6739184392201892a5d8e853ed0181eade8bd8e))

### Documentation

- record how the 11.0.0 pane and team fixes were verified *(reports)* ([`e8d1f5b`](https://github.com/MadAppGang/claudish/commit/e8d1f5bd81b2cb884d88401b6adaea7146dd4e23))
- update CHANGELOG.md for v10.7.1([`8d8a0ea`](https://github.com/MadAppGang/claudish/commit/8d8a0eaccca4a27958a9d1432fe258fbbf2f529d))

### New Features

- report agent_count_mismatch when agent counts disagree *(pane)* ([`de9366b`](https://github.com/MadAppGang/claudish/commit/de9366b49a538a72da6a1b0b0aa127be3a922fee))

### Other Changes

- v11.0.0 *(release)* ([`a9b98b0`](https://github.com/MadAppGang/claudish/commit/a9b98b0bab02e6c8937940c9509e4a872ec1ca32))

## [10.7.1] - 2026-10-16

### Bug Fixes

- tell a nested session to run delegated work itself *(mcp)* ([`01f3ec1`](https://github.com/MadAppGang/claudish/commit/01f3ec149e051b951a0efe2fc68ad1eb2e5ba978))

### Documentation

- record why the nested instructions name the delegate role *(mcp)* ([`68cb097`](https://github.com/MadAppGang/claudish/commit/68cb0976357bdd026ce8419e77e401e74820a4e2))
- stamp the playbook verified at the v10.7.0 merge *(release)* ([`fb3f470`](https://github.com/MadAppGang/claudish/commit/fb3f470f5e6324ce4688d08f1aa06b47f9158e0f))
- update CHANGELOG.md for v10.7.0([`e3930ae`](https://github.com/MadAppGang/claudish/commit/e3930ae93d1da3a7dc218aa30e97d9e7c058a97d))

### Other Changes

- v10.7.1 *(release)* ([`bcbc968`](https://github.com/MadAppGang/claudish/commit/bcbc9686620a034ba8355780713ffb5bc822160c))

## [10.7.0] - 2026-10-16

### ⚠ BREAKING CHANGES

- hosts started with `--channels` no longer receive <channel source="claudish"> blocks. Poll list_sessions for a session's state and call get_output once it is COMPLETED. *(mcp)* ([`753a3c3`](https://github.com/MadAppGang/claudish/commit/753a3c3e87ba611afd7609394a4f58a69bf98ff9))
- CLAUDISH_MCP_TOOLS=channel now selects all tools. Set CLAUDISH_MCP_TOOLS=session for the seven session tools alone. *(mcp)* ([`46ad7b7`](https://github.com/MadAppGang/claudish/commit/46ad7b787c27ca5d969e8217b614d326ecb772b3))

### Bug Fixes

- wait for the cleared input box before retyping the prompt *(team)* ([`62c58b5`](https://github.com/MadAppGang/claudish/commit/62c58b5962738414d80b383c23d8628db0c5ea85))
- warn on an unknown CLAUDISH_MCP_TOOLS value *(mcp)* ([`29b0b23`](https://github.com/MadAppGang/claudish/commit/29b0b230216f981f6328596fbf84b285984c565b))
- fill a missing max_tokens from the catalog, not 4096 *(adapters)* ([`ebed28e`](https://github.com/MadAppGang/claudish/commit/ebed28e3f220f5b214821ce0a037c534bb180887))
- wait out Claude Code's stdin reset before typing the prompt *(team)* ([`b119b54`](https://github.com/MadAppGang/claudish/commit/b119b54803ca7ee862a43dd5ffb287225a7b137a))
- force editorMode normal in pane children *(team)* ([`87d3194`](https://github.com/MadAppGang/claudish/commit/87d31943fb03e5d1c8af822be80c6a7b2b3af1e4))
- report the package version instead of 9.0.0 in serverInfo *(mcp)* ([`6280236`](https://github.com/MadAppGang/claudish/commit/6280236938c9382a29176d22ce03e8b455d219e1))
- remove max_tokens from run_prompt and compare_models *(mcp)* ([`bfc6857`](https://github.com/MadAppGang/claudish/commit/bfc685705817b4238950c185277c678675302588))
- send Claude models in run_prompt to claudish -p, not the proxy *(mcp)* ([`a8ea269`](https://github.com/MadAppGang/claudish/commit/a8ea269a5c4722fb2fa61472b12d8af51c948987))

### Documentation

- record the 10.7.0 validation and the pane follow-ups *(mcp)* ([`903c1f4`](https://github.com/MadAppGang/claudish/commit/903c1f4360523aa3a84964e56fbbd3aa369a8482))
- update CHANGELOG.md for v10.6.3([`2f005e2`](https://github.com/MadAppGang/claudish/commit/2f005e20107377c2810b96c0897f1f9fb1425d14))
- add the magus handoff for this branch's MCP surface changes *(mcp)* ([`1f9f83b`](https://github.com/MadAppGang/claudish/commit/1f9f83b9826ce5a72c9f3113ee4529e6128470de))
- record why a session with background agents never settles *(reports)* ([`e027f11`](https://github.com/MadAppGang/claudish/commit/e027f11a0805fec72b3df61ece679679c89d78f8))
- close the channel notification phases as removed *(roadmap)* ([`e932e61`](https://github.com/MadAppGang/claudish/commit/e932e6162c88375abef96644a9e29d06cbb0bb63))
- record run_prompt's Claude Code path and the push removal *(mcp)* ([`3fe4980`](https://github.com/MadAppGang/claudish/commit/3fe49800059a45f57774c2878ddff5bc370b98d5))
- document run_prompt's Claude path and session polling *(mcp)* ([`4aec497`](https://github.com/MadAppGang/claudish/commit/4aec4975fdafdfb3de2a50bcba450a4cc10a2920))

### New Features

- add reason_detail to SlotRow *(team)* ([`059cb25`](https://github.com/MadAppGang/claudish/commit/059cb2535271206209746e294abbf39339afe97f))
- stop sending notifications/claude/channel *(mcp)* ([`753a3c3`](https://github.com/MadAppGang/claudish/commit/753a3c3e87ba611afd7609394a4f58a69bf98ff9))
- add the debug tool group and move compare_models into it *(mcp)* ([`0a28db6`](https://github.com/MadAppGang/claudish/commit/0a28db6862cf528a8e6f343c0467f068eb0902cf))
- rename the channel tool group to session *(mcp)* ([`46ad7b7`](https://github.com/MadAppGang/claudish/commit/46ad7b787c27ca5d969e8217b614d326ecb772b3))

### Other Changes

- v10.7.0 *(release)* ([`d38fba8`](https://github.com/MadAppGang/claudish/commit/d38fba803070d27021135455a9f66ec0b7e5606b))

### Refactoring

- rename the channel module and vocabulary to session *(session)* ([`a13d7e4`](https://github.com/MadAppGang/claudish/commit/a13d7e4caf8b17c4428641663522c92868a324a0))
- delete the frame emitter and the trace diagnostics *(channel)* ([`7751901`](https://github.com/MadAppGang/claudish/commit/7751901c1e1e0e9d1c9927b7e7e5868faa6d0cd4))

## [10.6.3] - 2026-10-16

### Bug Fixes

- register no session tools in a server inside an MCP session *(mcp)* ([`1b73e51`](https://github.com/MadAppGang/claudish/commit/1b73e51c02a6024407a34445b0e6de96a8a87b45))
- refuse claudish -p and team run inside an MCP-started session *(pane)* ([`9c5cd84`](https://github.com/MadAppGang/claudish/commit/9c5cd84ffeeb07e43741d3585c9e098afeea1a91))

### Documentation

- record the one-level nesting rule and CLAUDISH_PANE_CHILD *(pane)* ([`6a19ee5`](https://github.com/MadAppGang/claudish/commit/6a19ee53bf058fdafdb38eefe66f015cf1981e91))
- update CHANGELOG.md for v10.6.2([`8d3437b`](https://github.com/MadAppGang/claudish/commit/8d3437b6159e38d8d56b5fc5835d5b1460a98590))

### Other Changes

- v10.6.3 *(release)* ([`bb695f1`](https://github.com/MadAppGang/claudish/commit/bb695f13194b3272abecf8f2ce50cb6f9608ecb7))

## [10.6.2] - 2026-10-16

### Bug Fixes

- show one recommended fallback row per model id *(picker)* ([`21a7837`](https://github.com/MadAppGang/claudish/commit/21a78370f6cda456f768610420a7dfe0f3bb7672))
- list cost_efficient and luxury tiers as their own sections *(catalog)* ([`cfe7de0`](https://github.com/MadAppGang/claudish/commit/cfe7de0b5b2ad407d98ba3ce877f3541b676aff8))

### Documentation

- document recommendationTier in --models-top --json *(catalog)* ([`21d3f59`](https://github.com/MadAppGang/claudish/commit/21d3f59af77a42dc153b90d0bcb204a9b03eee05))
- update CHANGELOG.md for v10.6.1([`086cf60`](https://github.com/MadAppGang/claudish/commit/086cf608e82124c5d92f13f2184575c091eb6723))

### Other Changes

- v10.6.2 *(release)* ([`206f96b`](https://github.com/MadAppGang/claudish/commit/206f96be8f88dadf11b33c6078411cb9b666c985))

## [10.6.1] - 2026-10-14

### Bug Fixes

- print help for `claudish update --help` instead of updating *(update)* ([`86dc5fd`](https://github.com/MadAppGang/claudish/commit/86dc5fd2f025a66c630edcbd882bd7265f6502ec))

### Documentation

- update CHANGELOG.md for v10.6.0([`efd5896`](https://github.com/MadAppGang/claudish/commit/efd5896c688f6a5cf619854e616d30e492c3ef23))

### Other Changes

- v10.6.1 *(release)* ([`530d5ed`](https://github.com/MadAppGang/claudish/commit/530d5ed9ce9739cde68cbb1ee100207623323817))

## [10.6.0] - 2026-10-13

### ⚠ BREAKING CHANGES

- a request without a catalog connection or a declared `wire` no longer gets reasoning parameters from the model name; declare them in the endpoint's `wire` block or pass --model-params. *(routing)* ([`10d9516`](https://github.com/MadAppGang/claudish/commit/10d95160b26607dbf3101296ea47c2b0b79bfd54))
- claudish no longer sends `reasoning_effort` or picks a token field by model name on a custom endpoint; use --model-params. *(routing)* ([`0d40e39`](https://github.com/MadAppGang/claudish/commit/0d40e3961415e964df2581f076863200e220db60))

### Bug Fixes

- read SSE `data:` lines without the space after the colon *(adapters)* ([`3dbd316`](https://github.com/MadAppGang/claudish/commit/3dbd3167315f7e23ff6b3fa6083de61c02c84f92))
- read image support from the catalog, not a dialect's default *(routing)* ([`b66a2a0`](https://github.com/MadAppGang/claudish/commit/b66a2a078815e8a59c045d040c04aefba71a3133))
- list models from the route registry's host *(discovery)* ([`af4b098`](https://github.com/MadAppGang/claudish/commit/af4b098a50aa8159d0b2d0e75582bcd44dc9f018))
- keep the route registry in a sidecar older releases leave alone *(catalog)* ([`2ebb20a`](https://github.com/MadAppGang/claudish/commit/2ebb20ae9ff47a99b486b581fe212888a711b7d1))
- retry the catalog instead of caching a first-run refusal *(routing)* ([`3a25794`](https://github.com/MadAppGang/claudish/commit/3a257944300255b716097afccbc8f5dea2676a57))
- send grok-* to /v1/responses instead of chat *(opencode-zen-go)* ([`4db144a`](https://github.com/MadAppGang/claudish/commit/4db144a70ba2a6a33820f149c60a156870912bf7))

### Documentation

- document the wire reader, model-spec markers and custom wire *(catalog)* ([`9bde383`](https://github.com/MadAppGang/claudish/commit/9bde383b1e9237edd826792c045d31de964a4f0e))
- correct the profile and OpenCode Messages comments *(routing)* ([`acf356b`](https://github.com/MadAppGang/claudish/commit/acf356be5073c58b9e1e88a9649bcb29246c7b28))
- add the per-connection wire profile request to Models Index *(catalog)* ([`e17523f`](https://github.com/MadAppGang/claudish/commit/e17523f23333c1009d9486c708ed35dfba17ab17))
- record the pinned magmux and the catalog test trap in the playbook *(release)* ([`b8857a8`](https://github.com/MadAppGang/claudish/commit/b8857a808072198fc05196712bc6e0e5d0690146))
- update CHANGELOG.md for v10.5.0([`a0230cc`](https://github.com/MadAppGang/claudish/commit/a0230ccadbc89a423741035f1f1ed6f4bbda9ceb))

### New Features

- build macOS bridge handlers from the connection's wire *(bridge)* ([`5360766`](https://github.com/MadAppGang/claudish/commit/53607665cdd48488617d223a86d48ed3cce4f510))
- build advisor requests from the connection's wire *(advisor)* ([`9baf642`](https://github.com/MadAppGang/claudish/commit/9baf6421a449ad2df4f254a63d0938962e2928af))
- add --accept-served-model for reasoning-off served by another model *(effort)* ([`e436e8e`](https://github.com/MadAppGang/claudish/commit/e436e8e6b5e520624d6e9f9809c9173274882c86))
- declare the request shape in a `wire` block *(custom-endpoints)* ([`a2259c7`](https://github.com/MadAppGang/claudish/commit/a2259c7270e9fb309780f8c4257593353c91d97d))
- show each hop's API, URL and fields from its catalog wire *(probe)* ([`e7f4cef`](https://github.com/MadAppGang/claudish/commit/e7f4cef92578d6e4d4e876db7c60705289f06a6e))
- build catalog requests from the connection's wire *(routing)* ([`b16dbd4`](https://github.com/MadAppGang/claudish/commit/b16dbd4b707a0674a7471c042ac8dd5f2d2fb238))
- read connection wires and the route registry *(catalog)* ([`11d2ce2`](https://github.com/MadAppGang/claudish/commit/11d2ce2491e9382da08f34a910d9d45d1b740fa6))

### Other Changes

- v10.6.0 *(release)* ([`e70c3ba`](https://github.com/MadAppGang/claudish/commit/e70c3ba55ff1766d417a1c9aceec32d1c131f1e0))

### Refactoring

- stop picking request dialects by model name *(routing)* ([`10d9516`](https://github.com/MadAppGang/claudish/commit/10d95160b26607dbf3101296ea47c2b0b79bfd54))
- remove model-name API, token and effort rules *(routing)* ([`0d40e39`](https://github.com/MadAppGang/claudish/commit/0d40e3961415e964df2581f076863200e220db60))

## [10.5.0] - 2026-10-13

### Bug Fixes

- append a re-woken turn's follow-up answer to get_output *(mcp)* ([`bd5b26d`](https://github.com/MadAppGang/claudish/commit/bd5b26db44bc89c90224577b3963c9bb28317a0e))
- accept the agent-labelled input box rule at slot boot *(team)* ([`cada488`](https://github.com/MadAppGang/claudish/commit/cada488aaa63ef582728f6fc5f58e0ffd3cc4a19))

### Documentation

- record the session registry and park the in-child mod *(team)* ([`f4fb61d`](https://github.com/MadAppGang/claudish/commit/f4fb61d0187a1c538a534039a2e0815c73b48223))
- update CHANGELOG.md for v10.4.1([`2e4ac24`](https://github.com/MadAppGang/claudish/commit/2e4ac2468afca757519e0d27e24fc0892a1f5fa6))

### New Features

- log session-registry vs screen disagreements per pane *(mcp)* ([`873f59d`](https://github.com/MadAppGang/claudish/commit/873f59de8dd5f9597facee51159ed4ef032dee90))

### Other Changes

- v10.5.0 *(release)* ([`d599c9c`](https://github.com/MadAppGang/claudish/commit/d599c9c457398d85a40488afcf693a4053418fc2))

## [10.4.1] - 2026-10-07

### Bug Fixes

- read parentClaudeSessionId from the host session record *(mcp)* ([`f4952d1`](https://github.com/MadAppGang/claudish/commit/f4952d145e695dc6cc4cc73ef2a0841785cd692d))

### Documentation

- park the pane migration's deferred follow-ups *(roadmap)* ([`461b8d4`](https://github.com/MadAppGang/claudish/commit/461b8d4c0c43c0cc81034c49d744a80e11b6ec44))
- keep the pane migration's design and build record *(mcp)* ([`0f13790`](https://github.com/MadAppGang/claudish/commit/0f1379026a7043accadcb37b4d6948380b5958d1))
- update CHANGELOG.md for v10.4.0([`8bfa82b`](https://github.com/MadAppGang/claudish/commit/8bfa82b7867666f99fda10d7744f2cda6ee9cdf3))

### Other Changes

- v10.4.1 *(release)* ([`bd7894d`](https://github.com/MadAppGang/claudish/commit/bd7894da4c9b53f71ac2a714d5c34769d6cc2cdd))

## [10.4.0] - 2026-10-06

### ⚠ BREAKING CHANGES

- create_session, send_input, cancel_session, list_sessions and get_diagnostics answers changed shape: the SessionInfo `status` key is removed (use `state`, or `event` in get_diagnostics); `finishing` is no longer emitted. CLAUDISH_TEAM_CAPTURE is removed. claude_flags that only work in print mode (--max-turns, --max-budget-usd, --fallback-model, --json-schema, --permission-prompt-tool) and positional text are refused. MCP create_session and team, and CLI team/--team, need magmux >= 0.14.0, so they no longer run on Windows. *(mcp)* ([`352e1ee`](https://github.com/MadAppGang/claudish/commit/352e1ee15350e3784675df84a3997f9175e02c1f))
- MCP `team` and CLI `claudish team` / `--team --mode json` need magmux >= 0.14.0, so they no longer work on Windows. CLAUDISH_TEAM_CAPTURE and TeamRunOptions.captureMode are removed. claude_flags that only work with --print (--max-turns, --max-budget-usd, --fallback-model, --json-schema, --permission-prompt-tool), the transport flags and any positional token are refused with invalid_args. status.json states are the closed nine-value set (PENDING is gone; a new slot is STARTING) and the failure reasons nonzero_exit and background_task_ceiling are gone. team(mode="cancel") answers {run_id, path, results} and an unknown run is a ContractError; team status/list/cancel/capture errors are ContractError JSON. *(mcp)* ([`7a22c84`](https://github.com/MadAppGang/claudish/commit/7a22c8447009513c98f2547a8251cca47b6b5c8e))

### Bug Fixes

- refuse a non-boolean include_completed or spans argument *(mcp)* ([`3fe6bc2`](https://github.com/MadAppGang/claudish/commit/3fe6bc2c4db2fc8ada44581f99a5bad75ab52cd3))
- check team verb argument types before resolving the run *(mcp)* ([`856e2d5`](https://github.com/MadAppGang/claudish/commit/856e2d5bac19df6b0016103bfce50420ab36715c))
- accept /compact at its typed record, not after compaction *(mcp)* ([`4311d6f`](https://github.com/MadAppGang/claudish/commit/4311d6f45b50401e6a949fe12c815d82d8ccc75c))
- keep a pane's escaped background shell after its parent dies *(mcp)* ([`70c0f11`](https://github.com/MadAppGang/claudish/commit/70c0f11a552bea88fb8a223861d0b68c3e7d6132))
- give a settled disk-read run a finished_at without completedAt *(team)* ([`fb27b07`](https://github.com/MadAppGang/claudish/commit/fb27b07e4f47fd8f78c6b99f1ed388510b2d8647))
- map legacy models[slot].state into the closed SlotState set *(team)* ([`bb276f1`](https://github.com/MadAppGang/claudish/commit/bb276f1af8d32c1508e7ea875088e9d8ea9dcecd))
- leave nothing behind when pane-drive is interrupted *(scripts)* ([`a700335`](https://github.com/MadAppGang/claudish/commit/a7003352d5a144e60f1313f6aab336a33683a69d))
- write a session's meta.json atomically *(mcp)* ([`9aef742`](https://github.com/MadAppGang/claudish/commit/9aef742c0344ed6bad23559a5ec9e659abe572f0))
- name the final screen, not stderr, in the failed-frame hint *(mcp)* ([`f791b44`](https://github.com/MadAppGang/claudish/commit/f791b44f6f3622976962f4426db56ad6d73eec1e))
- answer an invalid_args create_session without the report hint *(mcp)* ([`6d7ec7f`](https://github.com/MadAppGang/claudish/commit/6d7ec7fcb6a1745129e20a106829f725c9b9b77f))
- refuse to judge a team run that is still ACTIVE *(team)* ([`780cb66`](https://github.com/MadAppGang/claudish/commit/780cb66cb6af42181b0c42f3e606d7dff86e19b1))
- write a slot's terminal row even when its response file fails *(team)* ([`511b122`](https://github.com/MadAppGang/claudish/commit/511b1227dbf0077f0f18f1ee8f6c6e5d9c6c62aa))
- refuse an invalid require_pattern before writing the session *(team)* ([`dd5abb7`](https://github.com/MadAppGang/claudish/commit/dd5abb70a0b474271c317f560dccc663020929a3))
- run the magmux --version probe without blocking the event loop *(mcp)* ([`cab1585`](https://github.com/MadAppGang/claudish/commit/cab15850bc7b2ec50d7621724ef0b3a8e95a1fa2))
- treat a code-less exit after a delivered /exit as clean *(mcp)* ([`d02be60`](https://github.com/MadAppGang/claudish/commit/d02be60fb9667950f1519d8b88f0cb9cd7a13fda))
- end a pane whose watcher or record could not be created *(mcp)* ([`8c08a61`](https://github.com/MadAppGang/claudish/commit/8c08a61de74e471b4c2c3ecbc403c86e161819ff))
- refuse a claude_flags value after a Claude Code boolean flag *(mcp)* ([`3541459`](https://github.com/MadAppGang/claudish/commit/3541459b9de12f18c209e2d9e82baebfa1b30b54))
- keep a nested claudish off its parent session's token file *(statusline)* ([`ca64ba8`](https://github.com/MadAppGang/claudish/commit/ca64ba8505cfcf0d02f1afd7cf3e1cb9366bec8b))
- write the token file at the path its readers resolve *(statusline)* ([`0295054`](https://github.com/MadAppGang/claudish/commit/0295054afb4c714c12a31e8732e055016de422e0))
- redact a pane's failure detail before any owner records it *(mcp)* ([`8358698`](https://github.com/MadAppGang/claudish/commit/83586981361bee7394df105a87c968915c37ef9a))
- end every run's record before shutdownAllTeamRuns resolves *(team)* ([`f34725a`](https://github.com/MadAppGang/claudish/commit/f34725adc869a76df49339708bfa6e3f053e5e58))
- show turn_end_record_missing in slot rows only while it holds *(team)* ([`6b51920`](https://github.com/MadAppGang/claudish/commit/6b51920472be19bbb9f1ef0bded06ad97b7d9b6e))
- signal a pane's background shells that left its process group *(mcp)* ([`b7c6901`](https://github.com/MadAppGang/claudish/commit/b7c6901b783fbc076b98faabf1f358bfacf281bd))
- read the input box before retyping a send whose reply was lost *(mcp)* ([`5330afe`](https://github.com/MadAppGang/claudish/commit/5330afe6a31505583a9b5a7cf65ceccf75b68d06))
- keep only the newest turn's state in the transcript follower *(mcp)* ([`606187e`](https://github.com/MadAppGang/claudish/commit/606187ecaf941e0c159dd1abedaad978653303fd))
- drop dead members from a pane's group snapshot on refresh *(mcp)* ([`47d5780`](https://github.com/MadAppGang/claudish/commit/47d5780cb309a995a785ae1d907dee9d3946ef56))
- report a command turn's unread file as unverified, not failed *(mcp)* ([`2f1fcc2`](https://github.com/MadAppGang/claudish/commit/2f1fcc27c3c8581bee719a2cbad252d9cccb8dab))
- reject a pane record whose paneId is not its own filename *(mcp)* ([`bc0bebb`](https://github.com/MadAppGang/claudish/commit/bc0bebb04cd91c50d80b6100894328dcf6cfef62))
- resolve CLAUDISH_PANE_ROOT before comparing pane paths to it *(mcp)* ([`8f6ff7e`](https://github.com/MadAppGang/claudish/commit/8f6ff7ebf15962d5d50bfe664ea682990cbc2910))
- decide a turn settled inside send_input as interactive *(mcp)* ([`75f7f0a`](https://github.com/MadAppGang/claudish/commit/75f7f0a6e4a144f29ef36f733fbd8967eeb4ecf1))
- end a panel command's admission without a turn after Esc *(mcp)* ([`581042f`](https://github.com/MadAppGang/claudish/commit/581042fa2906f54b0dd119e1f0c709b634c90b3f))
- accept a system/local_command record as a command witness *(mcp)* ([`9e79bc8`](https://github.com/MadAppGang/claudish/commit/9e79bc8d7e3905c17bfc4d6e840d1dccc9e35dc1))
- settle a local slash-command turn on its local-command-stdout *(mcp)* ([`d0f59a1`](https://github.com/MadAppGang/claudish/commit/d0f59a1f9f852b10997ed1ae82aaaff70abd6b6c))
- end a pane session COMPLETED on /exit after a settled turn *(mcp)* ([`58284ee`](https://github.com/MadAppGang/claudish/commit/58284eea0a648a6554b179190ad59d2509a3b60f))
- truncate project-dir names over 200 characters with a hash *(session)* ([`2ec4d8d`](https://github.com/MadAppGang/claudish/commit/2ec4d8d8cd143c439c1e314eab540d04f05deb76))
- decode transcript lines only once their newline has arrived *(mcp)* ([`b9c238f`](https://github.com/MadAppGang/claudish/commit/b9c238fff5645fa83a3da15fb149cd07f0318136))
- attach the magmux dial's error listener before connect *(mcp)* ([`bd49e68`](https://github.com/MadAppGang/claudish/commit/bd49e683f64cab44194a60471530194ad071fa49))
- end session and team records before exiting on SIGTERM *(mcp)* ([`6a71068`](https://github.com/MadAppGang/claudish/commit/6a710686177abd7ff787fb33a463b069ce45b011))
- use up a held pane reservation when startPaneSession throws *(mcp)* ([`8213dd2`](https://github.com/MadAppGang/claudish/commit/8213dd29edb72834b5365ad1b25e2722fc47ae82))
- drop the retry watchdog in MCP pane children *(recovery)* ([`f38c7e9`](https://github.com/MadAppGang/claudish/commit/f38c7e94b4b01d2493e5e535b0cc56ac003a71d9))
- map the awaiting_permission channel event to input_required *(mcp)* ([`415b76b`](https://github.com/MadAppGang/claudish/commit/415b76b29dcde7c2532c607d6fdae2e03d0ce365))
- strip CLAUDE_CODE_CHILD_SESSION from interactive Claude Code *(runner)* ([`3bb5fee`](https://github.com/MadAppGang/claudish/commit/3bb5fee5d3021b451572dd11241c6a64b9e5950a))
- read an inherited CLAUDISH_TOKEN_FILE in the status line *(statusline)* ([`e6309f0`](https://github.com/MadAppGang/claudish/commit/e6309f0df63b2f72bf0bc324bad2f05dcc1e7c82))
- read CLAUDE_CONFIG_DIR for the transcript projects dir *(session)* ([`980964b`](https://github.com/MadAppGang/claudish/commit/980964b840f324326280e6b1d1b1fe8d6134ee6b))
- slug every non-alphanumeric cwd character in transcriptPathFor *(session)* ([`31c908d`](https://github.com/MadAppGang/claudish/commit/31c908d5a22c3f2308feb51a15f9f3274bf60dbc))
- poll the transcript for 2 s to prove parentClaudeSessionId *(mcp)* ([`51104c7`](https://github.com/MadAppGang/claudish/commit/51104c769b58c64985b41a34750613847d6cfebf))
- round and clamp timeout_seconds to 1-3600 in createSession *(channel)* ([`9d511f4`](https://github.com/MadAppGang/claudish/commit/9d511f4c9bed3b8579b58ea6dd8ddfa4fdd57ab4))
- keep a team run record open when its meta.json write fails *(team)* ([`d3bb554`](https://github.com/MadAppGang/claudish/commit/d3bb55405e82dc59fc607db33f71fe996dc07a7c))
- send SIGKILL to spawned slots when the spawn loop throws *(team)* ([`a63d517`](https://github.com/MadAppGang/claudish/commit/a63d51723ab2908d29fc8f33104fef631ded7840))
- cache only a verified parent-proof project directory *(channel)* ([`6527d4e`](https://github.com/MadAppGang/claudish/commit/6527d4ea3e7d7dfed3c71777b8f6dad5de4c7045))
- resolve the sessions directory from $HOME before homedir *(channel)* ([`1d87bfd`](https://github.com/MadAppGang/claudish/commit/1d87bfd7296de65658e0d4d036d793b8822a369e))
- report waiting_for_input only while stdin stays open *(channel)* ([`c315ebc`](https://github.com/MadAppGang/claudish/commit/c315ebc522964fe14371dc9a7ec9c08f41e765d6))

### Documentation

- record the live validation of pane-based team and sessions *(mcp)* ([`907c63a`](https://github.com/MadAppGang/claudish/commit/907c63adb11336f24ec85f7036b6df207ab1c286))
- add the 2.1.291 code-review captures to the capture report *(mcp)* ([`f2b83ca`](https://github.com/MadAppGang/claudish/commit/f2b83ca783848927cbd26d023c1248d603bdbd20))
- say that a value after a Claude Code switch is refused *(mcp)* ([`b28cae7`](https://github.com/MadAppGang/claudish/commit/b28cae7fb9cc0d73a3a4147e60ab2ad955e147db))
- describe the one token-file rule and the published marker *(statusline)* ([`88a91a4`](https://github.com/MadAppGang/claudish/commit/88a91a4b3d4c896c4fede7acb41cbeec7ab88916))
- record the 2.1.291 captures behind the pane review fixes *(mcp)* ([`12f0635`](https://github.com/MadAppGang/claudish/commit/12f063548ef4a58ed87eebdd47c4b83460aa5500))
- record the bun 1.3.10 socket ENOENT that a 1.4.0 run hid *(test)* ([`54d99ae`](https://github.com/MadAppGang/claudish/commit/54d99ae43f2ebb3718771b6884ee13bd27eb547f))
- document the magmux 0.14.0 requirement and the capture verbs *(mcp)* ([`3c249b1`](https://github.com/MadAppGang/claudish/commit/3c249b1378b3675e78fb5df5900580112ff20c04))
- document hermetic pane tests and the opt-in live tests *(test)* ([`e4c5aea`](https://github.com/MadAppGang/claudish/commit/e4c5aea7cdeb7a3fce048a034a05922266b47445))
- record why a pane child exports no retry watchdog *(recovery)* ([`281b65f`](https://github.com/MadAppGang/claudish/commit/281b65f787b28bb4bacfd9673e3953026566c439))
- point headless-vs-interactive.md at the pane driver *(mcp)* ([`74852e7`](https://github.com/MadAppGang/claudish/commit/74852e7bb7d202cff83e421872c420c5e494a7ce))
- describe team slots as panes in team-lifecycle and capture *(team)* ([`d4a4eb3`](https://github.com/MadAppGang/claudish/commit/d4a4eb3975ea31e198e45a1b33f320a06bca0d14))
- rewrite mcp-channel.md for channel sessions in panes *(mcp)* ([`00e1c3f`](https://github.com/MadAppGang/claudish/commit/00e1c3f30eebe69fd4313e4c4e6c18420a7f2548))
- add pane-session.md, the rationale of the headless pane driver *(mcp)* ([`1365e84`](https://github.com/MadAppGang/claudish/commit/1365e84a6114248bbb1ddf7f1d6f92235eb2d1eb))
- record the phase-2 Claude Code captures *(mcp)* ([`441c98e`](https://github.com/MadAppGang/claudish/commit/441c98efebab357449fedb83e42e111d53f93b48))
- poll npm for 15 minutes before calling a package missing *(release)* ([`fbf759a`](https://github.com/MadAppGang/claudish/commit/fbf759a36beec9b9f3a95dec90d061b9e3e4ae02))
- require a typecheck after the last test file lands *(release)* ([`0d4bfe9`](https://github.com/MadAppGang/claudish/commit/0d4bfe92453f0706df57723a9a286eb8cf509a3d))
- check the merge tree against the tested PR merge *(release)* ([`4cfb678`](https://github.com/MadAppGang/claudish/commit/4cfb67839dbbf37d13ac235f48db11bb2dbdc77e))
- mark the playbook verified by the 10.3.0 release *(release)* ([`610402f`](https://github.com/MadAppGang/claudish/commit/610402f3bfce21957ea8fad73a4b9bd42945a03e))
- update CHANGELOG.md for v10.3.0([`fa8d630`](https://github.com/MadAppGang/claudish/commit/fa8d63041ad124454981db61c702989b659d19a5))

### New Features

- run create_session as an interactive pane in headless magmux *(mcp)* ([`352e1ee`](https://github.com/MadAppGang/claudish/commit/352e1ee15350e3784675df84a3997f9175e02c1f))
- expose assistant message ids and pane diagnostics on PaneSession *(mcp)* ([`20a0104`](https://github.com/MadAppGang/claudish/commit/20a01049e5ae05efb3205defa91f23990246579e))
- run team slots as interactive panes in headless magmux *(mcp)* ([`7a22c84`](https://github.com/MadAppGang/claudish/commit/7a22c8447009513c98f2547a8251cca47b6b5c8e))
- export deliveryRefusal and ContractErrorException from pane/ *(mcp)* ([`3833e61`](https://github.com/MadAppGang/claudish/commit/3833e618f0955da540d6b0e2f6ae13d6ac68709d))
- replace magmux-drive-session.ts with pane-drive.ts *(scripts)* ([`750b7a2`](https://github.com/MadAppGang/claudish/commit/750b7a21ae2f286da0c6ec4a73e9a99446c48280))
- add PaneSession, the live interactive pane, and pane/index.ts *(mcp)* ([`3cc4820`](https://github.com/MadAppGang/claudish/commit/3cc48205d13fd1f4cf01e165488bd9f7c220bcaa))
- add the pane registry: records, sweep, limit, shutdown hooks *(mcp)* ([`9a56240`](https://github.com/MadAppGang/claudish/commit/9a56240617fbe093af4efd3cb4459131c038071e))
- add pane launch: env snapshot, sh shim, launcher, flag check *(mcp)* ([`1789253`](https://github.com/MadAppGang/claudish/commit/1789253a9efb71ea086af3d5b506c9ce0c4425e5))
- add the magmux socket client for pane sessions *(mcp)* ([`7525976`](https://github.com/MadAppGang/claudish/commit/75259760ed252dabb048078d4c7b5b05b554ce51))
- add pane process identity and the generated pane watcher *(mcp)* ([`08ba88d`](https://github.com/MadAppGang/claudish/commit/08ba88d6eeab1bcbb46c2821b5f80ff8618a9a48))
- build contract slot rows from pane accounting *(mcp)* ([`c454a44`](https://github.com/MadAppGang/claudish/commit/c454a44da2bdf51edea673c166d640c030bf02a5))
- read billed_input_tokens from the proxy token file *(team)* ([`98e6d15`](https://github.com/MadAppGang/claudish/commit/98e6d15988c51777c38c2ea9e525d602c02a595e))
- add pane prompt delivery for typed, command and file turns *(mcp)* ([`ccc8f34`](https://github.com/MadAppGang/claudish/commit/ccc8f34f5a66bd57a1e72ab20357ac43ec63af33))
- add the pane transcript follower and settle rule *(mcp)* ([`2132e5c`](https://github.com/MadAppGang/claudish/commit/2132e5c173336258827f62d20a8df225f38c25b4))
- add the pane screen model and screen classifier *(mcp)* ([`fb10f8f`](https://github.com/MadAppGang/claudish/commit/fb10f8f6c131e305f4aaa6cc6149d51887f07a7f))
- add the pane contract types and slot lifecycle table *(mcp)* ([`ac17b1c`](https://github.com/MadAppGang/claudish/commit/ac17b1c86467eb06cc96bc43a3963336b126be04))
- strip the CLAUDISH_PANE_* markers from Claude Code's env *(mcp)* ([`5c6b397`](https://github.com/MadAppGang/claudish/commit/5c6b3974747977ce29e7d76cab9ca5c7430a98ec))
- set skipDangerousModePermissionPrompt in a pane child overlay *(mcp)* ([`cc1e41d`](https://github.com/MadAppGang/claudish/commit/cc1e41de9ed3826e1369c52c220e59a4c93140f7))
- apply the CLAUDISH_PANE_ENV snapshot in a pane child claudish *(mcp)* ([`aa9c5a2`](https://github.com/MadAppGang/claudish/commit/aa9c5a22ba2e40928674c56979ad6691d31d7f92))
- write a sessions-directory record for each team run *(team)* ([`0558546`](https://github.com/MadAppGang/claudish/commit/0558546e6eec093660db452a178b31e34312b46d))
- record the calling Claude Code session in spawn.json *(channel)* ([`011fffb`](https://github.com/MadAppGang/claudish/commit/011fffb0441a9af2b25677f090d0eb8cb2298bfd))

### Other Changes

- remove references to the deleted reducer and agent probe *(mcp)* ([`e1e40cf`](https://github.com/MadAppGang/claudish/commit/e1e40cfa720561414b6b79dc7708113dd62767da))
- pin the bundled magmux to v0.14.0 and verify it *(release)* ([`7563ab2`](https://github.com/MadAppGang/claudish/commit/7563ab213eb3da39373762cbe5ede20715bf5ce7))
- sort the channel/types import in mcp-server.ts *(mcp)* ([`c13addb`](https://github.com/MadAppGang/claudish/commit/c13addb063f9104b219e0d6f4f03b3bfc3c847de))
- set the version to 10.4.0 for the session records *(release)* ([`a1edfd7`](https://github.com/MadAppGang/claudish/commit/a1edfd74e7bbf0b6d2f7c97574c76d5cd91410d3))

### Performance

- run the startup pane sweep once per root through ensureSwept *(mcp)* ([`b0c9b9a`](https://github.com/MadAppGang/claudish/commit/b0c9b9ae5a233e5e3064b4daf9650f6e269653eb))
- cache the magmux version check per binary path *(mcp)* ([`113c558`](https://github.com/MadAppGang/claudish/commit/113c5585ec9d427932fcacd0e43f58265f447c4c))

### Refactoring

- extract parseArgs's token rule as classifyPassthroughTokens *(cli)* ([`d4179ed`](https://github.com/MadAppGang/claudish/commit/d4179ed573a62bc3d461ea156b1e6aae138a27f0))
- read magmuxPaneCapability in the ambient UI branch *(recovery)* ([`3863ddf`](https://github.com/MadAppGang/claudish/commit/3863ddf048907ad57612595d6db542da747301bd))

## [10.3.0] - 2026-09-24

### Bug Fixes

- hold the chain when a stream retry cannot reach the provider *(routing)* ([`0f2c5e1`](https://github.com/MadAppGang/claudish/commit/0f2c5e14e93cdd3a249890cf2d2982adc402b86e))
- put a vendor's own dynamic subscription first in its band *(routing)* ([`c327eb0`](https://github.com/MadAppGang/claudish/commit/c327eb0c57f7bb5bba69b63be2c1a895accce41f))
- advance the chain on an upstream 502, 503 or 504 *(routing)* ([`5e839b5`](https://github.com/MadAppGang/claudish/commit/5e839b511c784e7302ca20e8df81114cb39894cf))
- list every provider shortcut in --help from the definitions *(cli)* ([`6324876`](https://github.com/MadAppGang/claudish/commit/6324876e91fecf4da586330f581c03d401c148c2))
- stop describing a dropped fallback as "fallback only" *(routing)* ([`5459e7c`](https://github.com/MadAppGang/claudish/commit/5459e7c2d3e5d7a84c7f79ecf8340b10bf09f083))
- use the shared NATIVE_NOT_PROBED note in the route probe *(tui)* ([`047bed2`](https://github.com/MadAppGang/claudish/commit/047bed2557a6d56aff3669e6a7e80c84fe7ee8f8))
- show the calculated route in the grid pane header *(team)* ([`fdadea7`](https://github.com/MadAppGang/claudish/commit/fdadea7fe8cfbd250eaf85a5231d76489c554675))
- describe unmapped profile roles as calculated routing *(tui)* ([`83ce97a`](https://github.com/MadAppGang/claudish/commit/83ce97afe4d5aa85f1494a6a87ad8c4d2fdadaeb))
- remove hard-coded example model names from the route probe *(tui)* ([`4b25690`](https://github.com/MadAppGang/claudish/commit/4b25690b618046d023564776394bdf023d5cc9a6))
- show the resolved fallback hop in the Routing tab header *(tui)* ([`ba60e9d`](https://github.com/MadAppGang/claudish/commit/ba60e9d127fad600efbf018463e577e38106b5e1))
- show the user's "*" rule in the Routing tab header *(tui)* ([`9b4342a`](https://github.com/MadAppGang/claudish/commit/9b4342a915a229ffe05c3f5fff6c35598f65d653))
- label route probe hops by tier, not a provider map *(tui)* ([`72ae5e6`](https://github.com/MadAppGang/claudish/commit/72ae5e654cc87c2c91eb913d7271b123fe1c5739))
- render the route probe from explainRoute *(tui)* ([`e71aafb`](https://github.com/MadAppGang/claudish/commit/e71aafb371cfc286eca12ee0fc3ae2ce57818b6b))
- show the chain route() calculates, with dropped candidates *(probe)* ([`d28cb1c`](https://github.com/MadAppGang/claudish/commit/d28cb1c116848d18bf153c72072ab344b83082ec))
- return rule warnings instead of printing them to stderr *(routing)* ([`5af1bf3`](https://github.com/MadAppGang/claudish/commit/5af1bf3f719d16500fb8a8d33e7c9559d267b890))
- show qpay@ for Qwen rows in the recommended-models list *(catalog)* ([`df70aea`](https://github.com/MadAppGang/claudish/commit/df70aea2b156d3c694ff69cb7e54ec4688cb44a4))
- use claudish provider names in the cold-start slug seeds *(catalog)* ([`d479013`](https://github.com/MadAppGang/claudish/commit/d479013ad9339e03cb8f854ac4e5de9f9062162f))
- key the probe map under every provider bound to a route *(routing)* ([`4d5478f`](https://github.com/MadAppGang/claudish/commit/4d5478f92dd58263f318e4c788023595ba3bb40c))
- split lookup-only names out of CATALOG_ROUTE_BINDINGS *(routing)* ([`21496c1`](https://github.com/MadAppGang/claudish/commit/21496c14119322a08a74a75b67baa250ea01c950))
- make --default-provider reach the proxy and child sessions *(cli)* ([`9be012f`](https://github.com/MadAppGang/claudish/commit/9be012fc6e2dc6cd3b869b2d8282d296c048108b))
- apply defaultProvider in the proxy's bare-name routing *(routing)* ([`9f8364f`](https://github.com/MadAppGang/claudish/commit/9f8364f5c028418e9080b3935d916790a8ea34c3))
- honour CLAUDISH_DEFAULT_PROVIDER in route() *(routing)* ([`8eb8897`](https://github.com/MadAppGang/claudish/commit/8eb8897940f0e9469d77fc3bfd2edad25e0beb7b))
- treat defaultProvider "" in env or config as no fallback *(routing)* ([`dd22847`](https://github.com/MadAppGang/claudish/commit/dd22847f46fde4f2eb545b58d282fd8c245fbbe7))
- send bare non-Claude names to route(), not to Anthropic *(routing)* ([`16b92cc`](https://github.com/MadAppGang/claudish/commit/16b92ccaa01ad69fb7a042cb955aeb0d79a94e05))
- restore CLAUDISH_DISABLE_KEYCHAIN instead of deleting it *(test)* ([`5729c28`](https://github.com/MadAppGang/claudish/commit/5729c2879ca5e25a4328c6d5597ac03c8bbcedf8))

### Documentation

- add the --probe explicit-target defect to the open list *(reports)* ([`5e5e7f6`](https://github.com/MadAppGang/claudish/commit/5e5e7f685ad0b07beb53ad8e37d0c618c1b10104))
- record what calculated routing shipped and what is open *(reports)* ([`60fbf7e`](https://github.com/MadAppGang/claudish/commit/60fbf7e9271090f7bde9c1e88a3cd0dbb82c3ba6))
- correct two stale routing comments in proxy and resolver *(routing)* ([`e2c5b57`](https://github.com/MadAppGang/claudish/commit/e2c5b57bafb6bdd55f83b0849a46921abbf469e0))
- replace the ModelCatalogResolver section of routing.md *(routing)* ([`ad6ebea`](https://github.com/MadAppGang/claudish/commit/ad6ebea46fedf112f23fb923a2002f6393afbb10))
- describe calculated routing in parser and hint comments *(routing)* ([`7a6cc48`](https://github.com/MadAppGang/claudish/commit/7a6cc48a6a5802e459f2bd00570bde7a108d6722))
- state that project rules override global per pattern *(routing)* ([`e17a776`](https://github.com/MadAppGang/claudish/commit/e17a77688399b17e72ba18d3d540de9269ac55cd))
- remove DEFAULT_ROUTING_RULES from code comments *(routing)* ([`c78b57e`](https://github.com/MadAppGang/claudish/commit/c78b57e37589abd66f5b3742777b029d7cf114f6))
- use <model> placeholders in --help model examples *(cli)* ([`ae8547e`](https://github.com/MadAppGang/claudish/commit/ae8547e91b5ad62ff16c2d2737fbb0cf40875fb6))
- replace the static routing table in --help *(cli)* ([`4946520`](https://github.com/MadAppGang/claudish/commit/494652058828ec63479d7f19dd90bad6ea4ad52a))
- document defaultProvider sources and the empty value *(routing)* ([`2f6f903`](https://github.com/MadAppGang/claudish/commit/2f6f903a0fa3bbdc89d58318cddff326fd5bc1dc))
- add the commit message rule *(claude)* ([`a4e17c2`](https://github.com/MadAppGang/claudish/commit/a4e17c2826bc9e849646c4f75ef553ea6e3b041f))
- update CHANGELOG.md for v10.2.0([`e1191e2`](https://github.com/MadAppGang/claudish/commit/e1191e2b95a4f21761c2e32e6d973c764a3b502b))

### New Features

- warn when a routing rule names an unknown provider *(routing)* ([`8a23cf3`](https://github.com/MadAppGang/claudish/commit/8a23cf3e890f272d3c703185db93f2b00295b413))

### Other Changes

- record the resolved defaultProvider in the route gate *(routing)* ([`4c00bb0`](https://github.com/MadAppGang/claudish/commit/4c00bb0bb80b326677dc9454ec5d3266c5d946eb))
- record the proxy decision per row in the route gate *(routing)* ([`56fe2fb`](https://github.com/MadAppGang/claudish/commit/56fe2fbcff85a905ffd9d84598e2da5d79b8aa41))
- add a --strict mode to the route-table gate diff *(routing)* ([`d876de2`](https://github.com/MadAppGang/claudish/commit/d876de26b3adb1539b83838f434610b09d5fec23))

### Refactoring

- export hopLabel and drop its two copies *(routing)* ([`e0d32d4`](https://github.com/MadAppGang/claudish/commit/e0d32d4b064d03445b53cbd52329c6efc28a0dc4))
- add explainRoute and derive route() from it *(routing)* ([`1b76309`](https://github.com/MadAppGang/claudish/commit/1b7630931ba7a8879c0a7b4390e491bee71636d3))
- add matchRoutingRuleKey beside matchRoutingRule *(routing)* ([`a244bf2`](https://github.com/MadAppGang/claudish/commit/a244bf2aaab0179a49d22a5ab09781787e567941))
- remove the unused DefaultProviderSchema *(config)* ([`c881569`](https://github.com/MadAppGang/claudish/commit/c88156908c8dabbb43f33a44f95c41b0e3941032))
- remove the dead LiteLLM auto-promotion hint *(cli)* ([`e326fa9`](https://github.com/MadAppGang/claudish/commit/e326fa90fce833acd42e7987dfad9d2def1aeeb7))
- add isClaudeCodeModelName to claude-code-aliases *(routing)* ([`d91d355`](https://github.com/MadAppGang/claudish/commit/d91d355d5b5eb13da68d90122c9ceaeb37987714))
- extract proxyRouteDecision from the proxy gate *(routing)* ([`123be2b`](https://github.com/MadAppGang/claudish/commit/123be2bf6f391dd44b66b6d5a64357b7c4dde2b8))
- replace the retired term "served set" *(discovery)* ([`ad1fcf6`](https://github.com/MadAppGang/claudish/commit/ad1fcf6ab829098e8cdc96a67bbc56a8ac3b1407))

## [10.2.0] - 2026-09-23

### Bug Fixes

- a hung token refresh no longer wedges the single-flight latch *(recovery)* ([`e20b408`](https://github.com/MadAppGang/claudish/commit/e20b4083c6d0a07133749d584b311bc987681c56))
- a nested claudish drops the retry watchdog its parent exported *(recovery)* ([`e1d771b`](https://github.com/MadAppGang/claudish/commit/e1d771b363ac956a393fdd0c4b125b11ccf2ba25))
- a short API_TIMEOUT_MS no longer silently disables auth-path recovery *(recovery)* ([`453040b`](https://github.com/MadAppGang/claudish/commit/453040bfc338ceee0b2cca87a29b9d9a5840efea))
- an unreachable token host no longer bills the subscriber metered *(codex)* ([`3a50e60`](https://github.com/MadAppGang/claudish/commit/3a50e60c232651a093bbc31e8a6e509c2fbdae99))
- a late acknowledgement no longer revives a closed episode's lease *(recovery)* ([`1f63010`](https://github.com/MadAppGang/claudish/commit/1f6301009d777efcb6c933a6def6be57660c1f79))
- draw the banner with magmux's overlay, not a pane that wedges Claude Code *(recovery)* ([`a261140`](https://github.com/MadAppGang/claudish/commit/a261140ead16b4db5bdc415a81044ccf54cd020b))
- stop --no-recovery paying for a pane it can never open *(recovery)* ([`4a88047`](https://github.com/MadAppGang/claudish/commit/4a88047ff8a90fd082fcb96d484cef9da6fafdf1))
- make the budget, the chain guard and the log real in the arm nobody tested *(recovery)* ([`09eb4de`](https://github.com/MadAppGang/claudish/commit/09eb4deb75d20a321364d66213c9923d770ecf78))
- stop the ladder faking attempts, billing latency, and ignoring [q] *(recovery)* ([`4e45c0c`](https://github.com/MadAppGang/claudish/commit/4e45c0cdb4c0b12e3760296b98802cc3062ca7a3))
- stop a network outage from advancing the fallback chain *(handlers)* ([`da0cd5b`](https://github.com/MadAppGang/claudish/commit/da0cd5bc7a7a35cf81ab2b531300a19a15d7e786))

### Documentation

- update CHANGELOG.md for v10.1.1([`9833607`](https://github.com/MadAppGang/claudish/commit/98336077c1a1c8e652fbde10a67dd91f82bd7d22))
- retire "roster" from the magmux binary resolver's header *(recovery)* ([`7029467`](https://github.com/MadAppGang/claudish/commit/70294679e34b6288bd3b61f3567ef9f745c8633c))
- record the overlay banner, verified live through teardown *(recovery)* ([`f3e262e`](https://github.com/MadAppGang/claudish/commit/f3e262eca64f7c511710aa0a043115b56517ea7d))
- closing the pane wedges the host TUI, and magmux already had the surface *(recovery)* ([`3586b8b`](https://github.com/MadAppGang/claudish/commit/3586b8b6dcf1689c45332834a524565cc9aca816))
- the build report — what shipped, what the process caught *(recovery)* ([`1460d93`](https://github.com/MadAppGang/claudish/commit/1460d9369133267f5cb75aa07d4a4d3e200a9169))

### New Features

- count the outages, and write down why the shape is what it is *(recovery)* ([`ca5b4eb`](https://github.com/MadAppGang/claudish/commit/ca5b4eb92a1506a8c7555c371c83769a05a81f86))
- hand the retry back to the client when the reason is legible *(recovery)* ([`7a9f4c5`](https://github.com/MadAppGang/claudish/commit/7a9f4c5b1a25df4b321fd6eb4bdeb7a7cd26d45f))
- give the retry ladder a face — the magmux recovery pane *(recovery)* ([`fce758e`](https://github.com/MadAppGang/claudish/commit/fce758eab2ca73033a7751520460269d5b52dc00))

### Other Changes

- restore the exit hook that only the recovery pane changed *(recovery)* ([`2a7da9a`](https://github.com/MadAppGang/claudish/commit/2a7da9a4fa6bd40c984627a9ba25a71e0df25bfb))

## [10.1.1] - 2026-09-23

### Bug Fixes

- ask an older Ollama daemon for capabilities it lists only in /api/show([`50c7f0e`](https://github.com/MadAppGang/claudish/commit/50c7f0ed71ab6cf0f79ca8669e36949bb7ef1929))
- keep what a provider says about its own models, and three release-review findings([`7981787`](https://github.com/MadAppGang/claudish/commit/79817872238b3a4103b56f63d56666134d91a2a6))
- ask Devin about swe-1.7 in Devin's own spelling([`d408ac9`](https://github.com/MadAppGang/claudish/commit/d408ac96ee56868b71b5fa0e5421edf8b0c4eca7))
- a model is offered when something says it works, never when nothing does([`4c48c63`](https://github.com/MadAppGang/claudish/commit/4c48c63fe3072d3163d1945bb32e835932efda1c))
- minimal effort is the lowest rung, not the off switch([`90ac5cb`](https://github.com/MadAppGang/claudish/commit/90ac5cb66a3fee9bf9be7a2384e25903c421d966))
- show the provider's own error, not claudish's guess about it([`196e6f8`](https://github.com/MadAppGang/claudish/commit/196e6f8f8caa38ea783f1b6bd1c9331c7b40d936))
- stop the probe tearing its own rows, and drop a hop no key can satisfy([`406461c`](https://github.com/MadAppGang/claudish/commit/406461c8b5d3be213cd0e2b1251949de6476d009))

### Documentation

- park two release-review findings, and report three catalog rows([`1f2fed5`](https://github.com/MadAppGang/claudish/commit/1f2fed5ef53440fe83d33b9fc67498e3c530f54e))
- record the availability spelling rule and the route-table gate's blind spots([`8dfcfb7`](https://github.com/MadAppGang/claudish/commit/8dfcfb79646eb53e8d81027a465b0091b76badb7))
- withdraw the wrong list of models to restore([`8580fa9`](https://github.com/MadAppGang/claudish/commit/8580fa9f87631a47a511938c99e60ff9ce92c986))
- verify claudish against models-index v1.4.14([`38139d4`](https://github.com/MadAppGang/claudish/commit/38139d4df0f0ef598bb08ed95d454f6f08f6a0d1))
- correct four claims the review of #263 disproved([`87289bb`](https://github.com/MadAppGang/claudish/commit/87289bb6340707dad74da3a3ea006e6e3c674f57))
- record why stop_sequences has no effect on gk@ *(grok)* ([`96776b4`](https://github.com/MadAppGang/claudish/commit/96776b408863326ca1fcbddf7e4dc2c8964e7dc3))
- record the free-claude-code translation findings *(reports)* ([`5084905`](https://github.com/MadAppGang/claudish/commit/5084905bc6eb806b3ca8d3cbee6191946f9bb0a0))
- stamp the playbook verified at v10.1.0 *(release)* ([`c568a6a`](https://github.com/MadAppGang/claudish/commit/c568a6a447aca7481d795d29088f0894a2c3725d))
- update CHANGELOG.md for v10.1.0([`7b2d493`](https://github.com/MadAppGang/claudish/commit/7b2d4938d06d985fbe37cb76e820f6a52f53e358))

## [10.1.0] - 2026-09-23

### Bug Fixes

- read v3 reasoning.supported, not the field's presence *(catalog)* ([`2247340`](https://github.com/MadAppGang/claudish/commit/224734090e4c1bbc8bb4dcdf7611ef912312755c))
- keep a load that lands after the user steps back *(picker)* ([`101933e`](https://github.com/MadAppGang/claudish/commit/101933ea2464f8bb238d54e51173f9726b0f839f))
- memoize the model list on the ready set's membership, not its identity *(picker)* ([`1979800`](https://github.com/MadAppGang/claudish/commit/19798009d24ada192fcfb36f570d60374c34b43c))
- never open the model picker without a terminal *(picker)* ([`c0951e7`](https://github.com/MadAppGang/claudish/commit/c0951e75a95a8c15c49e1412eb314f3f920a8850))

### Documentation

- record the review findings that did not ship fixed *(picker)* ([`c61b4f1`](https://github.com/MadAppGang/claudish/commit/c61b4f1232ffb93344da82a190e5aaf6e5ad6d4f))
- record why the picker is shaped as it is, and what is still open *(picker)* ([`ad6137b`](https://github.com/MadAppGang/claudish/commit/ad6137b4f60820e45d09843cad1029b354514d0b))
- update CHANGELOG.md for v10.0.1([`7059910`](https://github.com/MadAppGang/claudish/commit/70599108f57bea66de7ea22298c0f85e89ffd307))

### New Features

- $$$ in a cost colour, and a filter on the provider list *(picker)* ([`41e5244`](https://github.com/MadAppGang/claudish/commit/41e52443907b07012d3b65e18a334d3347103f29))
- build chips per palette — tint on light, saturated on dark *(picker)* ([`1dc7559`](https://github.com/MadAppGang/claudish/commit/1dc7559f701aae7b251fce18e2b41dc45887aa67))
- soften the SUB fill and chip `$` at the same width *(picker)* ([`f4b428b`](https://github.com/MadAppGang/claudish/commit/f4b428b4c8ce8cb6db04e2d683dcf1fc7f11d4f3))
- fill the notable state only, and measure every chip against both terminals *(picker)* ([`f1f09a3`](https://github.com/MadAppGang/claudish/commit/f1f09a3532817f95e061ae86269737420889ae58))
- the provider list is the default screen, and nothing is prefetched *(picker)* ([`ff00f56`](https://github.com/MadAppGang/claudish/commit/ff00f56c7b7c529eb3c77f8f754b35156e649073))
- a compact inline dialog, because the dashboard was the defect *(picker)* ([`43218b4`](https://github.com/MadAppGang/claudish/commit/43218b4d0aa245dcc64e63ff8d72fd1efde43c49))
- an OpenTUI model picker that says what it is showing you *(picker)* ([`cec6017`](https://github.com/MadAppGang/claudish/commit/cec60172ca4a2a9ecdffc8700c79aed9853322dc))
- a discovery OUTCOME, so an empty list can say why *(picker)* ([`c626866`](https://github.com/MadAppGang/claudish/commit/c6268660434bcd975beb7c99ad222c6f50283288))
- shared components and leaves for the OpenTUI model picker *(tui)* ([`4100454`](https://github.com/MadAppGang/claudish/commit/4100454fbc620c64f6e8cefd04751b51d65c0aed))

### Other Changes

- v10.1.0 *(release)* ([`037b7a2`](https://github.com/MadAppGang/claudish/commit/037b7a2c19b660a7a20c930dda333d5187a96819))

### Refactoring

- retire "roster" in the picker, for the thesaurus terms *(picker)* ([`444ee60`](https://github.com/MadAppGang/claudish/commit/444ee60f5eb3c90ce08c1d8e052ff6463c61b33c))

## [10.0.1] - 2026-09-21

### Bug Fixes

- never ask a GLM model to stop thinking([`974de4a`](https://github.com/MadAppGang/claudish/commit/974de4a0457d493293aaac5f58e3415f6df24118))

### Documentation

- record the v10.0.0 release and what was deferred from it([`addc0f8`](https://github.com/MadAppGang/claudish/commit/addc0f8fb28daa8dae0e592fc22b3dc96c8c282c))
- update CHANGELOG.md for v10.0.0([`570b75f`](https://github.com/MadAppGang/claudish/commit/570b75f4e0b0f7d4918dbbb245b8638eead392ed))

## [10.0.0] - 2026-09-21

### Bug Fixes

- redact key-shaped text from a credential failure line([`0c5920f`](https://github.com/MadAppGang/claudish/commit/0c5920f5d60feda513316f5ece99110ffe1ab8cc))
- a metered price of zero is missing data, not free([`9bedcf7`](https://github.com/MadAppGang/claudish/commit/9bedcf7ba84b91012d4dd1818ae8df8e7c71e6ab))
- offer the newest model, not the alphabetically first *(discovery)* ([`b4110d3`](https://github.com/MadAppGang/claudish/commit/b4110d3a05a2a34478f430ba5cf432ce51db68d5))
- say which auth problem a local server has, and keep walking on a denied model *(probe)* ([`aac36ee`](https://github.com/MadAppGang/claudish/commit/aac36ee54f204ee1169845f6a5c1060d90f7207b))
- drop the effort knob when thinking is disabled *(deepseek)* ([`19cdaa6`](https://github.com/MadAppGang/claudish/commit/19cdaa6fd0583e99361fe6f00a9d80eb7e211573))
- a probe pick for Poe, retries for a slow list, and a 403 that is not the key *(probe)* ([`1512d66`](https://github.com/MadAppGang/claudish/commit/1512d665cc49bf00b345fe258f793c1d8776c617))
- Gemini's effort, a parameter mistaken for a model, and Mistral's list *(probe)* ([`7d89795`](https://github.com/MadAppGang/claudish/commit/7d89795c91bd5e106acf6d191fc94bfa99f5f74d))
- send metered keys to the international host by default *(minimax)* ([`0177ca9`](https://github.com/MadAppGang/claudish/commit/0177ca9b4531d701ef94ed9b889b7c637a2f813a))
- name qwen-coding and qwen-payg in every hand-written table *(alibaba)* ([`8691eed`](https://github.com/MadAppGang/claudish/commit/8691eedcdcf8ea27281e2753411989fbe66fa782))
- an incomplete model list cannot deny, a missing base URL is a failure *(discovery)* ([`28fc06d`](https://github.com/MadAppGang/claudish/commit/28fc06d8c741afecd71522dc7229eb70150c9469))
- name an unsupported model and a wrong-plan key in the hint *(errors)* ([`fa09cb7`](https://github.com/MadAppGang/claudish/commit/fa09cb7eb85bf455b77e439a9d4cffbd70b5aec1))
- read readiness once per candidate and say when a subscription credential failed *(routing)* ([`4362311`](https://github.com/MadAppGang/claudish/commit/4362311272dc374d683e2650c144b181581d90fa))
- print the dropped-subscription notice with one prefix *(routing)* ([`eceab30`](https://github.com/MadAppGang/claudish/commit/eceab3067a4c102a830d352b4bc546b90bdbe393))
- keep a Claude model's thinking budget below max_tokens *(gemini)* ([`5fc423c`](https://github.com/MadAppGang/claudish/commit/5fc423c1039df411c125f3a2eec4376eabfab7ba))
- Antigravity picks its probe model from the account's own list *(probe)* ([`4128e07`](https://github.com/MadAppGang/claudish/commit/4128e07f331c140ddfd16e9b6d2a4294efd6fb82))
- give the v3 cache its own file, and the OpenRouter list another *(catalog)* ([`af02ca3`](https://github.com/MadAppGang/claudish/commit/af02ca359203c80a5d9e68619efa88212a8075ea))
- decide chat capability from the catalog's videoOutput *(catalog)* ([`492b0e4`](https://github.com/MadAppGang/claudish/commit/492b0e4c33c9a6f3af47e67dbb9e57352a2d5686))
- send the exact wire id, and fetch route variants *(catalog)* ([`30f70d4`](https://github.com/MadAppGang/claudish/commit/30f70d4df701681ad5d99f26821b2fa672ef0b9b))

### Documentation

- the backend feedback doc now carries the full route census([`b4ac4ae`](https://github.com/MadAppGang/claudish/commit/b4ac4ae6e5e3161eb3fdb7e5f7d17c8d0e31c296))
- retire roster, and rebuild a safety argument on its new premise([`e95b8a5`](https://github.com/MadAppGang/claudish/commit/e95b8a51a5520efba5e95262a2512b975671abba))
- note that Phase 2 landed behind its gate([`d0c0da8`](https://github.com/MadAppGang/claudish/commit/d0c0da88f1443c1d5b34cf1120a0ecdfa643e513))
- the routing index no longer points at a deleted table([`7727f99`](https://github.com/MadAppGang/claudish/commit/7727f997e9850ff5d122e3b8f502220fb29dbb28))
- name the routing redesign's three new concepts in the thesaurus([`e030823`](https://github.com/MadAppGang/claudish/commit/e0308236466a2f22898bfc1de1a08ad5402900ad))
- revision 3 of the remaining-work plan([`1a6817c`](https://github.com/MadAppGang/claudish/commit/1a6817cc45bc3f1a2fdccdffe09784dc87e0edfc))
- revision 2 of the remaining-work plan([`1d468b8`](https://github.com/MadAppGang/claudish/commit/1d468b8ae59341c1303e5ff511e485aeffb96005))
- the reply to send to models-index([`d9c1791`](https://github.com/MadAppGang/claudish/commit/d9c1791da9e1721f8c33bd89cd6c2cda2c43d56d))
- the discriminator is called type, and ask the backend to rename shape([`18b4bf3`](https://github.com/MadAppGang/claudish/commit/18b4bf3741f67b718e43ad5a18c6fe7dcb85bbe3))
- validate the backend delivery on generation g-20260920154425586([`fdf237a`](https://github.com/MadAppGang/claudish/commit/fdf237a31638f6062caa516f88d81e7f529acb53))
- fold Jack's answers into the backend reply and the work plan([`b41efe8`](https://github.com/MadAppGang/claudish/commit/b41efe87d4a21165d5fa2770d72fd6cb587d737c))
- record Jack's decisions on Vertex, routing and the fallback([`2e5cd1d`](https://github.com/MadAppGang/claudish/commit/2e5cd1dd4491b46cdd75bbdef2a992a1c197eac8))
- the remaining claudish work, with decisions and open questions([`f24a841`](https://github.com/MadAppGang/claudish/commit/f24a8413ed30403315caf73af7194a93f723a073))
- evaluate the Vertex ADC work, and name the real blocker *(plan)* ([`12154e4`](https://github.com/MadAppGang/claudish/commit/12154e40e69eba58a9e5ec98f977091afd97d3a8))
- answer the backend's re-review of the task list([`fd075e0`](https://github.com/MadAppGang/claudish/commit/fd075e0e7d56231fc6952ea81920cd655c4da83e))
- Ollama Cloud keeps one route, classified metered *(plan)* ([`a9effb0`](https://github.com/MadAppGang/claudish/commit/a9effb0ef5509912a27af1bc2980051197c150c4))
- six validated tasks for models-index([`7df52b8`](https://github.com/MadAppGang/claudish/commit/7df52b8d775cba884f3296ce3ca3bfa7e0812f2f))
- the routing redesign is decided *(plan)* ([`d60c064`](https://github.com/MadAppGang/claudish/commit/d60c06421b3c8d2b442178649da7f6d100a51cd2))
- MiniMax metered is a claudish host bug; PAYG and oMLX findings *(plan)* ([`3f50158`](https://github.com/MadAppGang/claudish/commit/3f50158fa5baa61c1e7fd634aa83bfd86e290078))
- Test All with every key set, and moving Vertex to ADC *(plan)* ([`4ad7ff2`](https://github.com/MadAppGang/claudish/commit/4ad7ff294f4aa23719dcfc273a861330c93625bc))
- record the ports from the old Alibaba branch, and why group D stays out([`70f2e07`](https://github.com/MadAppGang/claudish/commit/70f2e076a4e3659dfb6c845e7b8bcf55a198c7c9))
- carry the Alibaba billing-products and black-box reports *(reports)* ([`9d0e2fa`](https://github.com/MadAppGang/claudish/commit/9d0e2faf6e75b84f276037e39dcbf69ce81ad610))
- record the Alibaba measurements and which catalog may deny *(architecture)* ([`ab7d0f5`](https://github.com/MadAppGang/claudish/commit/ab7d0f55cf63707a59a14df7323b53883115fa3d))
- document the three Alibaba products and fix the qwen* row *(settings)* ([`cc55c1b`](https://github.com/MadAppGang/claudish/commit/cc55c1baac32e9530cb180d7c80c93f982091ddf))
- record the reader-gap fixes and their live evidence([`0e048a7`](https://github.com/MadAppGang/claudish/commit/0e048a7b30e58fd83ff11cd0f8b7780eb07a2a46))
- ask the backend for input and output modalities on every projection([`f16ab83`](https://github.com/MadAppGang/claudish/commit/f16ab837083e3878e9335cc671a45d0121ccaff1))
- a project thesaurus in CLAUDE.md, with the words never to write([`774eafc`](https://github.com/MadAppGang/claudish/commit/774eafc52565e3854daa58d265b9130a89b89685))
- give every agent one vocabulary, and retire "roster"([`0b6cc3c`](https://github.com/MadAppGang/claudish/commit/0b6cc3cd21e4c2810290bb2f67f4b9ec46d68873))
- validate PR #266 and the 1.2.90 backend against live v3([`b30c4b5`](https://github.com/MadAppGang/claudish/commit/b30c4b531c1fc41c62cfc1d4b305df6ac3f1df82))
- measure claudish's catalog functions against the live v3([`330abd2`](https://github.com/MadAppGang/claudish/commit/330abd2982757c94935013024bb4bbe1187f08b4))
- verify the shared Alibaba contract live and request retiring "roster"([`5a5d19d`](https://github.com/MadAppGang/claudish/commit/5a5d19d4fbb5b86e237064e483b3f5769be3a176))
- take the Alibaba identities from the backend contract, with no aliases([`843dd5a`](https://github.com/MadAppGang/claudish/commit/843dd5a1cd8eca6bfef6f35d6feee2ed6ee247e6))
- reconcile the qwen-token-plan work and flag the Alibaba contract conflict([`fc1a52e`](https://github.com/MadAppGang/claudish/commit/fc1a52e1ef540a5eeef6810d4a2cadbf78d79a91))
- plan the catalog v3 reader([`1856c4a`](https://github.com/MadAppGang/claudish/commit/1856c4ad0b066483080c542a7a9d7b185cef08a0))
- rename the Token Plan key and deprecate QWEN_CLOUD_PLAN_API_KEY([`d89633b`](https://github.com/MadAppGang/claudish/commit/d89633b9037aaf4fea099be4107fd1f51656f649))
- record the v3 reader decisions and the requests to the backend([`63168b5`](https://github.com/MadAppGang/claudish/commit/63168b571f866832c223e6c49e1fc7cdf8c435cd))
- verify the models-index v3 reader handoff against the live catalog([`d0d2f2c`](https://github.com/MadAppGang/claudish/commit/d0d2f2ce900815f659559e5a05b5a93166479c67))
- update CHANGELOG.md for v9.7.1([`b6201e9`](https://github.com/MadAppGang/claudish/commit/b6201e91f79af9e426f92ac988b3fdd331cd7c39))

### New Features

- routing gathers candidates from the catalog; Vertex discovers its own models([`af98f4f`](https://github.com/MadAppGang/claudish/commit/af98f4f232ab4c2e173c506c62f78d95b8d700fb))
- gather routing candidates from the catalog (not wired in)([`4f4f765`](https://github.com/MadAppGang/claudish/commit/4f4f765b4c4608f70310b70213ffe8224c1ed180))
- Vertex AI runs on Application Default Credentials; Express is deleted([`ae78527`](https://github.com/MadAppGang/claudish/commit/ae785275889fc49cca6bb3fe05705cde0ce6b638))
- the catalog decides chat capability and carries comparable prices([`7fce457`](https://github.com/MadAppGang/claudish/commit/7fce457ab72390174b92a45b7a32aa94591398cc))
- validate an Alibaba PAYG key outside claudish *(scripts)* ([`11e8b48`](https://github.com/MadAppGang/claudish/commit/11e8b48aa5f4223b7c54da529bb8911f7400cb50))
- tell a credential that failed apart from one that is absent *(credentials)* ([`7127287`](https://github.com/MadAppGang/claudish/commit/712728762ccae4ad5b36abb554b3bdefae8adea5))
- consume catalog v3 and separate Alibaba products([`9a1206e`](https://github.com/MadAppGang/claudish/commit/9a1206e5695248b7e03e1fc0bdbb539148179890))

### Other Changes

- release 10.0.0([`0716ba9`](https://github.com/MadAppGang/claudish/commit/0716ba935784ec60d530c08b40f2f02821b45c6f))

### Refactoring

- retire "roster" for the thesaurus terms([`ab1fc09`](https://github.com/MadAppGang/claudish/commit/ab1fc0953ed4761913d803593345d1ff7998db47))

## [9.7.1] - 2026-09-18

### Bug Fixes

- stop Test All failing every provider when the probe catalog is unreadable *(tui)* ([`e5d3cc5`](https://github.com/MadAppGang/claudish/commit/e5d3cc543ee57ecd55a1ed1ea3c8cb414447f354))

### Documentation

- report the models-index v3 cutover to the backend([`a7c2b3a`](https://github.com/MadAppGang/claudish/commit/a7c2b3a2df9b675dac804efa626bb7c5195cfa85))
- update CHANGELOG.md for v9.7.0([`06a82a5`](https://github.com/MadAppGang/claudish/commit/06a82a579d083addca59836e4dd0d9304748be62))

## [9.7.0] - 2026-09-18

### Bug Fixes

- stop the incompatibility guard exiting, and let the sentinel expire *(catalog)* ([`eec9e7e`](https://github.com/MadAppGang/claudish/commit/eec9e7e156a1f832cc5219c35fadd7499f44837a))

### Documentation

- record the v3 remediation and d0c1538 reviews([`8bb4097`](https://github.com/MadAppGang/claudish/commit/8bb4097fca452cfd16b23ade3a30b3b42c95dfdd))
- review the models-index v3 implementation from the client side([`510e7cd`](https://github.com/MadAppGang/claudish/commit/510e7cdd8d893b41c232f3612584e5140c968443))
- update CHANGELOG.md for v9.6.1([`e712718`](https://github.com/MadAppGang/claudish/commit/e712718d94d23c43b3d6cddd5fab100a7ba6ed75))

### New Features

- refuse a stale cache when the catalog contract moves ahead *(catalog)* ([`cb46b0a`](https://github.com/MadAppGang/claudish/commit/cb46b0a04f0642f810ad763f28a6bda02f176568))

## [9.6.1] - 2026-09-17

### Bug Fixes

- tell --models --provider users which vocabulary their slug is from *(cli)* ([`a01f759`](https://github.com/MadAppGang/claudish/commit/a01f759834f79ada24a6df9b737fd656663e59ab))
- separate SSE streams by upstream response id *(test-fixtures)* ([`4d5ae9f`](https://github.com/MadAppGang/claudish/commit/4d5ae9fc80e3f0ce1e86a5f63219a907d4dfa3f7))
- unwrap <tool_call> envelopes before the strict parser sees them *(tools)* ([`58b5775`](https://github.com/MadAppGang/claudish/commit/58b577512cbd37e37844c07ba5b496670c0309de))

### Documentation

- update CHANGELOG.md for v9.6.0([`590777b`](https://github.com/MadAppGang/claudish/commit/590777b7e5c8ae8dc7e917bea0ee4ad5a35014e4))

### Other Changes

- v9.6.1 *(release)* ([`2cb18a2`](https://github.com/MadAppGang/claudish/commit/2cb18a2667a54a0c2e1ccc50b21a4d53fceace1c))

## [9.6.0] - 2026-09-17

### Bug Fixes

- keep the head of a response in stdoutSnippet *(team)* ([`9a96b19`](https://github.com/MadAppGang/claudish/commit/9a96b1974545111d553ba9f3bdc620f67ac728e3))
- put the pid in log filenames so concurrent children stop clobbering *(logger)* ([`819ed50`](https://github.com/MadAppGang/claudish/commit/819ed5011d16754e52f8e33be554043cfdde5c40))
- keep Claude Code's unrecognized-model line out of child stderr *(runner)* ([`3ea3dbd`](https://github.com/MadAppGang/claudish/commit/3ea3dbd6025ca76d5ab7e32c71fc6bab078bc627))
- surface an upstream error carried inside a 200 stream *(sse)* ([`321c2f0`](https://github.com/MadAppGang/claudish/commit/321c2f040da78c37553b6d2ae2458575e80fac69))

### Documentation

- record the gemini in-band 400 investigation *(reports)* ([`c3e95b4`](https://github.com/MadAppGang/claudish/commit/c3e95b47bfc9b645ada199ff5387dbf15596f818))
- update CHANGELOG.md for v9.5.0([`b7a7868`](https://github.com/MadAppGang/claudish/commit/b7a7868df64e4241839f1658235179693f3d5250))

### New Features

- consume the repaired models-index contract *(catalog)* ([`d50ae6a`](https://github.com/MadAppGang/claudish/commit/d50ae6a24b246eeea46b263dc4a601e30c4cd21a))

### Other Changes

- v9.6.0 *(release)* ([`cbfd9fa`](https://github.com/MadAppGang/claudish/commit/cbfd9fab09cb5bf7e1c6db059d1d53c8e5b75941))

## [9.5.0] - 2026-09-16

### Bug Fixes

- choose the tool_result image marker per RESULT, not per turn *(format)* ([`9f4488d`](https://github.com/MadAppGang/claudish/commit/9f4488d325a2ae152b189c524482064295925478))
- the block writer refuses to re-open an index it already stopped *(sse)* ([`48f1f90`](https://github.com/MadAppGang/claudish/commit/48f1f90d510804c1cea60f4c5ff76a25bfc0f5ca))
- ask BOTH adapters to recover from a rejected parameter *(handlers)* ([`9013032`](https://github.com/MadAppGang/claudish/commit/90130322e75eb7bc42e291a7a327b3245176b109))
- never encode tool names into a wire that cannot decode them *(adapters)* ([`5b15868`](https://github.com/MadAppGang/claudish/commit/5b15868760cca73b178c9dbcd7b06a4b421cd099))
- a context overflow leads with `prompt is too long` (item 8) *(errors)* ([`e0b4016`](https://github.com/MadAppGang/claudish/commit/e0b401699b11fc8b68b594758317d07f1d12f1a2))
- split prompt_tokens into the three input counters (item 6) *(tokens)* ([`f9baf2e`](https://github.com/MadAppGang/claudish/commit/f9baf2effbaefd811f18bd6a68d4d3853b96666a))
- a reversible 64-char tool-name codec on every OpenAI wire (item 7) *(adapters)* ([`2e18042`](https://github.com/MadAppGang/claudish/commit/2e18042c67504f9b6e07de75feed1ded491d7efe))
- map tool_choice any to required, from one shared mapper (item 10) *(adapters)* ([`d170a3f`](https://github.com/MadAppGang/claudish/commit/d170a3ff3b8063d72d55a22ec1087aec5ec17f79))
- forward stop_sequences as stop, and top_p (item 11) *(adapters)* ([`912031e`](https://github.com/MadAppGang/claudish/commit/912031e61128becc77727e79bb465040fe5309be))
- order tool results by their calls and name a missing one (item 14) *(format)* ([`a981d13`](https://github.com/MadAppGang/claudish/commit/a981d13acfe906407567f435d3fa3026617c0d4b))
- merge adjacent user messages and close an orphan tool round (item 13) *(format)* ([`b9e2163`](https://github.com/MadAppGang/claudish/commit/b9e21638283a3524dbe8bf8dc261fba763b55820))
- forward a url image source as that url (item 16) *(format)* ([`84578c9`](https://github.com/MadAppGang/claudish/commit/84578c9d42e58a7e270bbba45f3d5a54086368c6))
- parse the function-tag envelope first, then type its values (item 9) *(tools)* ([`4a0948c`](https://github.com/MadAppGang/claudish/commit/4a0948c45f03cde86feed73aae16f2ac7a3c2a6f))
- an empty-string required argument is present, not missing (item 1) *(tools)* ([`417ef5c`](https://github.com/MadAppGang/claudish/commit/417ef5c49c3a18aa06bfa79c81e8d3c1721fe446))
- a successful turn is never contentless (item 12) *(sse)* ([`edd4ce9`](https://github.com/MadAppGang/claudish/commit/edd4ce9407324e72c7ef05f8a342a4758ea60b57))
- a stream that ends with no finish_reason after producing content is a failure (item 4) *(sse)* ([`c1b907f`](https://github.com/MadAppGang/claudish/commit/c1b907ffb1630bddbb5af02b8ff050ffa46caf0a))
- <think>…</think> in content becomes a thinking block (item 3) *(sse)* ([`d4cba87`](https://github.com/MadAppGang/claudish/commit/d4cba87ef27e8910fd1351db363ac8ef5355a097))
- buffer tool-argument fragments that arrive before function.name (item 2) *(sse)* ([`baf19ef`](https://github.com/MadAppGang/claudish/commit/baf19efb210f3c9586df7146926830826a688642))
- a tool_use content_block_start carries input: {} (item 17) *(sse)* ([`1fb4e31`](https://github.com/MadAppGang/claudish/commit/1fb4e31d290a4fbf34244cd6db6b647970e704ac))
- exactly one content block open at a time (item 5) *(sse)* ([`ccca029`](https://github.com/MadAppGang/claudish/commit/ccca029c43d04b33fc7c85348c4b941a9c444dd3))
- log instead of swallowing in the openai-sse chunk-loop catch *(sse)* ([`ea5258c`](https://github.com/MadAppGang/claudish/commit/ea5258c3db15017a1c9f334472dfdb3f6b0c549d))

### Documentation

- stamp the playbook verified at v9.4.0 *(release)* ([`ea19974`](https://github.com/MadAppGang/claudish/commit/ea1997432207759102468237a8eabc081cd410fd))
- update CHANGELOG.md for v9.4.0([`f1c6f7a`](https://github.com/MadAppGang/claudish/commit/f1c6f7a3adcb5240dede167f8f60adc5d550bf67))

### Other Changes

- v9.5.0 *(release)* ([`a939149`](https://github.com/MadAppGang/claudish/commit/a9391494c7eadffa832ab37c467ee505b6e8da6b))

## [9.4.0] - 2026-09-15

### Documentation

- stamp the playbook verified at v9.3.2 *(release)* ([`488a17f`](https://github.com/MadAppGang/claudish/commit/488a17fdcc609f715cdd8b5374bfe4f76b6c655e))
- update CHANGELOG.md for v9.3.2([`464637a`](https://github.com/MadAppGang/claudish/commit/464637ae289c2b178e5474b2e6b6a14bc60f82af))

## [9.3.2] - 2026-09-14

### Documentation

- update CHANGELOG.md for v9.3.1([`1561622`](https://github.com/MadAppGang/claudish/commit/1561622a2cd1cf4b92bba15e8b9cc93f5a05090d))

### Other Changes

- v9.3.2 *(release)* ([`22cef36`](https://github.com/MadAppGang/claudish/commit/22cef36aecf8b49977d7fe4bdbbc0f93c1ada4c8))

## [9.3.1] - 2026-09-14

### Bug Fixes

- drop exited slots from team liveness; send x-opencode-session to Zen Go *(team,zen)* ([`d675536`](https://github.com/MadAppGang/claudish/commit/d6755362a51669854cc0ba155d3d5e857c3a738e))

### Documentation

- add the handoff for the four advisor follow-ups([`1397aac`](https://github.com/MadAppGang/claudish/commit/1397aacae91a7e36673df8f52cb2643ff58954d2))
- archive the advisor build evidence, and park three follow-ups([`fe0bd29`](https://github.com/MadAppGang/claudish/commit/fe0bd29c160e4a9b1f33692708273db781578a55))
- update CHANGELOG.md for v9.3.0([`301182d`](https://github.com/MadAppGang/claudish/commit/301182dc8bd0b708bf7bea3680214a788a2e22b0))

### Other Changes

- v9.3.1 *(release)* ([`6f6e026`](https://github.com/MadAppGang/claudish/commit/6f6e0261e249858bf7dea4a088fe448270c49154))

## [9.3.0] - 2026-09-10

### Bug Fixes

- stop truncating SSE payloads, and refuse corrupt fixtures *(debug)* ([`333026b`](https://github.com/MadAppGang/claudish/commit/333026bcf9385645aac07a201e4cc07f73d104a5))
- ask the panel the question, warm the catalog, resolve the collector *(advisor)* ([`5836843`](https://github.com/MadAppGang/claudish/commit/583684355d79949be29ee4ad9f7f6bec62be3e36))
- send the token parameter and model id each endpoint accepts *(advisor)* ([`6edb729`](https://github.com/MadAppGang/claudish/commit/6edb729d4f63c50f639f026f6ee198f7f56ad7ac))
- sanitise failure text, resolve prefixed panel specs, stop false S10 *(advisor)* ([`58b44b1`](https://github.com/MadAppGang/claudish/commit/58b44b1b95275c64a12af884cad9709906a56b27))
- give Claude Code an advisor model, or it offers no tool *(advisor)* ([`6216b79`](https://github.com/MadAppGang/claudish/commit/6216b7938a12ba30f5462deb4cb28da9308f3e68))
- address the four-model code review *(advisor)* ([`961b858`](https://github.com/MadAppGang/claudish/commit/961b858628a626146d3bfb6658ebfb99e8d7892c))
- never forward an inherited claudish placeholder to Anthropic *(runner)* ([`4206dea`](https://github.com/MadAppGang/claudish/commit/4206dea5b87d8eaeca580d421cdde0b0a0d380ab))
- publish live answer bytes so `outputSize: 0` stops reading as "produced nothing" *(team)* ([`6122d48`](https://github.com/MadAppGang/claudish/commit/6122d48a6abbf118a97939627021c7b600f5c0d4))

### Documentation

- restore the section rule the merge resolution dropped *(roadmap)* ([`9a3d9dc`](https://github.com/MadAppGang/claudish/commit/9a3d9dc6ae723eba76c52dc27e13505af2746519))
- add a release playbook, and rescue the advisor verification evidence([`aa3a51e`](https://github.com/MadAppGang/claudish/commit/aa3a51e613f40b3cde2d7c532b18d1751bce6909))
- update CHANGELOG.md for v9.2.1([`7f81a14`](https://github.com/MadAppGang/claudish/commit/7f81a1412ba37e99a25c51c6737688dcd6329da3))
- record the runs that verified the last three fixes *(advisor)* ([`c5cd0cf`](https://github.com/MadAppGang/claudish/commit/c5cd0cfe5ba1aab962972f542ee90a2914d790c7))
- record what the real runs proved, and what they found *(advisor)* ([`4d46a27`](https://github.com/MadAppGang/claudish/commit/4d46a275556bc10bf9ff2c29485f1d911d789a0f))
- record why the advisor works the way it does *(advisor)* ([`a09c310`](https://github.com/MadAppGang/claudish/commit/a09c31090c652b762fa2283d783be940d6b243c5))
- correct the release instructions that would break a release([`ad326c3`](https://github.com/MadAppGang/claudish/commit/ad326c33ed93888541133e0df38bdda1e8a55b79))
- park the stale bundled claudish-usage copies, note the third team transport *(roadmap)* ([`1a79727`](https://github.com/MadAppGang/claudish/commit/1a7972746402ce9a6e8b25fba8f99833cd5fa675))

### Other Changes

- release v9.3.0([`aa34017`](https://github.com/MadAppGang/claudish/commit/aa34017c207e2b4cbef6fdc0e03996e39ceb0071))
- release v9.2.0([`9b2cc83`](https://github.com/MadAppGang/claudish/commit/9b2cc83aa7b2cc0b54789f8e0c0f92119f9a696e))

## [9.2.1] - 2026-09-10

### Bug Fixes

- an explicit -y no longer still asks "Enable auto-approve?"([`30b3cbf`](https://github.com/MadAppGang/claudish/commit/30b3cbf4a80de9d5d2b7306dd9c414e274d42198))
- a stream that dies mid tool-call no longer reports a completed turn([`9560d00`](https://github.com/MadAppGang/claudish/commit/9560d00f0718bfe10adab61912d7150fb4f88ea9))
- close shell and prompt injection in issue-triage *(ci)* ([`d7d48c3`](https://github.com/MadAppGang/claudish/commit/d7d48c347471ed24a46f16bf45da3b9f32d0c545))

### Documentation

- preserve the truncated-toolcall verification harness([`86330c4`](https://github.com/MadAppGang/claudish/commit/86330c42729b18c32e662a47a6d50f5698219e36))
- prove Claude Code honours a mid-stream error event([`28c8628`](https://github.com/MadAppGang/claudish/commit/28c8628d1af9466ed6f0547e1ca6d113f2b8eff0))
- update CHANGELOG.md for v9.2.0([`1e8e83a`](https://github.com/MadAppGang/claudish/commit/1e8e83a5557a2de2c5f6e7352b4d738c45d0ca6b))

### Other Changes

- release v9.2.1([`729bfb3`](https://github.com/MadAppGang/claudish/commit/729bfb36802a9ae579a467900359b28ca5da84f0))

## [9.2.0] - 2026-09-09

### Bug Fixes

- publish live answer bytes so `outputSize: 0` stops reading as "produced nothing" *(team)* ([`6597451`](https://github.com/MadAppGang/claudish/commit/65974511df340989d27485ce8e686b50d863fb14))

### Documentation

- correct the release instructions that would break a release([`2822052`](https://github.com/MadAppGang/claudish/commit/2822052e45ff97f2dc10dc10854f5ffae3f096ed))
- park the stale bundled claudish-usage copies, note the third team transport *(roadmap)* ([`5f51de7`](https://github.com/MadAppGang/claudish/commit/5f51de7eb38ae484cfaf00c346a90240575bb722))
- update CHANGELOG.md for v9.1.0([`22b9138`](https://github.com/MadAppGang/claudish/commit/22b91388bbaf0b2cb5f16a9b5007d2bbf22c8744))

### Other Changes

- release v9.2.0([`080ff50`](https://github.com/MadAppGang/claudish/commit/080ff50a919b0f52617f687c17ec56797e2d44e8))

## [9.1.0] - 2026-09-09

### Documentation

- update CHANGELOG.md for v9.0.9([`beea81b`](https://github.com/MadAppGang/claudish/commit/beea81baa52c530c4fcee94cddf7babd6bcfb309))

### New Features

- show the claudish wordmark and offer the update inline *(cli)* ([`a1d392e`](https://github.com/MadAppGang/claudish/commit/a1d392e85826e6abc623ebf3a8e27f2955a8c36d))

### Other Changes

- release v9.1.0([`41b2475`](https://github.com/MadAppGang/claudish/commit/41b2475242ccc7ebb0e5d97a771ae724dd505da5))

## [9.0.9] - 2026-09-09

### Bug Fixes

- stop `security` stderr corrupting the config TUI *(antigravity)* ([`f1f26e1`](https://github.com/MadAppGang/claudish/commit/f1f26e1e69cd209c7656dcca51ff9d40ada17c5a))

### Documentation

- update CHANGELOG.md for v9.0.8([`7b6b9b2`](https://github.com/MadAppGang/claudish/commit/7b6b9b23d517482a843448a1052b37f4947daa3c))

### Other Changes

- release v9.0.9([`a5748da`](https://github.com/MadAppGang/claudish/commit/a5748da2151c437587cc48d5513dba82d0ef0059))

## [9.0.8] - 2026-09-09

### Bug Fixes

- resume the right session from the right directory, and quieten the card *(session)* ([`263d0b4`](https://github.com/MadAppGang/claudish/commit/263d0b47518f863734921c5f65b251dbe040064a))
- drop tool-schema patterns the provider cannot compile *(openai)* ([`0997da5`](https://github.com/MadAppGang/claudish/commit/0997da55db31436c79e2969a774e48ff842cc4eb))

### Documentation

- update CHANGELOG.md for v9.0.7([`e02d810`](https://github.com/MadAppGang/claudish/commit/e02d8109155352ed4606a8a966372909ea445613))

### Other Changes

- release v9.0.8([`cef2acf`](https://github.com/MadAppGang/claudish/commit/cef2acf1b209b3fed885203bd9310610602927ad))

## [9.0.7] - 2026-09-09

### Bug Fixes

- read the catalog's endpoint, not just its tokenParam *(openai)* ([`87b7311`](https://github.com/MadAppGang/claudish/commit/87b731115e5f99ba7b0e73cab1aac08d2bde1ea4))

### Documentation

- the catalog's endpoint contract has two halves *(adapters)* ([`7b8e17e`](https://github.com/MadAppGang/claudish/commit/7b8e17e9d1786f39b7c026d158f34a9b1ea8a8e5))
- update CHANGELOG.md for v9.0.6([`9f76e77`](https://github.com/MadAppGang/claudish/commit/9f76e7702f515c249c79bd7808c410d0eeb23404))

### Other Changes

- release v9.0.7([`27c82eb`](https://github.com/MadAppGang/claudish/commit/27c82ebecab163d2e1b69d2e76873ec177cf3155))

## [9.0.6] - 2026-09-07

### Bug Fixes

- stop the anyOf pass-through eating the schema around it *(gemini)* ([`77e48fe`](https://github.com/MadAppGang/claudish/commit/77e48fe21b1f14d4c1f31b90b686d432448bc542))
- translate tuples as unions, not as one collapsed type *(gemini)* ([`59c7d31`](https://github.com/MadAppGang/claudish/commit/59c7d31b4e3bddfade8a16d8e2341446312a3360))
- give every array schema `items` so Gemini stops 400-ing *(gemini)* ([`d37eb9f`](https://github.com/MadAppGang/claudish/commit/d37eb9f61965a6155abd64cb06cc57b9b4b45678))

### Documentation

- a red local suite may just be a newer bun than CI pins *(testing)* ([`b6a7f0e`](https://github.com/MadAppGang/claudish/commit/b6a7f0e9e7dc78aaee0fa9c3482a9ac66d110393))
- update CHANGELOG.md for v9.0.5([`8d0d595`](https://github.com/MadAppGang/claudish/commit/8d0d5956d24e50390e6eb2d6911eb502efe0a9f6))

### Other Changes

- release v9.0.6([`773b14f`](https://github.com/MadAppGang/claudish/commit/773b14f7ebb850ae6ccc736685308b5e1392d46e))

## [9.0.5] - 2026-09-07

### Bug Fixes

- swallow EPIPE on a cancelled slot's stdin *(team)* ([`03409b2`](https://github.com/MadAppGang/claudish/commit/03409b255bbf6fe37e2637fbc3069458d01eb7b9))
- settle native names before the probe proxy is started *(diagnostics)* ([`328ebeb`](https://github.com/MadAppGang/claudish/commit/328ebebde8f11675af4893846747c66a4f56bb28))
- stop preflight and the TUI probe misreporting native Claude names *(diagnostics)* ([`1b481d3`](https://github.com/MadAppGang/claudish/commit/1b481d3af53580c37717b2411c5cfe5783e9e9bb))
- stop telling the agent to preflight before spawning models *(mcp)* ([`1200dd1`](https://github.com/MadAppGang/claudish/commit/1200dd1ca86278c9338de94f14b93a18038950d2))

### Documentation

- preflight-plan validation and the grok-4.6 stale-9.0.2 misroute *(reports)* ([`e2ebdee`](https://github.com/MadAppGang/claudish/commit/e2ebdee6b43e66f5d8787750ad0d1e7d0cb14784))
- update CHANGELOG.md for v9.0.4([`acf18bb`](https://github.com/MadAppGang/claudish/commit/acf18bb620c368969032dea96ae954787e075abb))

### Other Changes

- release v9.0.5([`6ce0629`](https://github.com/MadAppGang/claudish/commit/6ce0629513fe617899cfaeac44671b6e9ace6f71))

## [9.0.4] - 2026-09-03

### Bug Fixes

- stop declaring a subscription not-served from a partial plan view (#231) *(catalog)* ([`9c6947f`](https://github.com/MadAppGang/claudish/commit/9c6947f7c04798154c40aa96401fd04aae083a72))

### Documentation

- update CHANGELOG.md for v9.0.3([`b2f31b6`](https://github.com/MadAppGang/claudish/commit/b2f31b6047259100849cb24e6e2e2ceec8c1397f))

## [9.0.3] - 2026-09-03

### Bug Fixes

- stop the catalog deleting providers from every chain (#230) *(routing)* ([`e75ff5f`](https://github.com/MadAppGang/claudish/commit/e75ff5f2eb2b04e3f417df01b44e85810a915088))

### Documentation

- update CHANGELOG.md for v9.0.2([`218cb8f`](https://github.com/MadAppGang/claudish/commit/218cb8f5ff6ecc1643c22e592cf279ca86c88711))

## [9.0.2] - 2026-09-02

### Bug Fixes

- stop reporting a quit as a failed session (#227) *(cli)* ([`98cbb59`](https://github.com/MadAppGang/claudish/commit/98cbb59eeb3e5acdafcf32d860925cd7e6d80a3f))

### Documentation

- update CHANGELOG.md for v9.0.1([`ada02da`](https://github.com/MadAppGang/claudish/commit/ada02dae88fcb545175f894cde5c579f415f8c4b))

### Other Changes

- release v9.0.2([`61e71c2`](https://github.com/MadAppGang/claudish/commit/61e71c221953781d92eb01e12673a48840e2a1ad))

## [9.0.1] - 2026-09-02

### Bug Fixes

- consume backend subscription routing (#228) *(catalog)* ([`ad7b79b`](https://github.com/MadAppGang/claudish/commit/ad7b79b918a1af106237d43021b946f381bd26b5))

### Documentation

- update CHANGELOG.md for v9.0.0([`a3895fb`](https://github.com/MadAppGang/claudish/commit/a3895fb93b321e629ba0dde9aa9c5dedd1a68151))

## [9.0.0] - 2026-09-02

### ⚠ BREAKING CHANGES

- OPENCODE_API_KEY no longer authenticates `zgo@` / `zengo@`. A user reaching OpenCode Zen Go with only that key must now set OPENCODE_GO_API_KEY. The missing-credential hint names it explicitly and adds: *(providers)* ([`a01ffb9`](https://github.com/MadAppGang/claudish/commit/a01ffb9659b4ebb0b05c0d4daf1fa675aa86e396))

### Bug Fixes

- render BREAKING CHANGES in the generated changelog *(release)* ([`620ae1f`](https://github.com/MadAppGang/claudish/commit/620ae1fc37a378fe17de12c4fa2f77e34b63e6e5))
- drop OPENCODE_API_KEY alias from opencode-zen-go *(providers)* ([`a01ffb9`](https://github.com/MadAppGang/claudish/commit/a01ffb9659b4ebb0b05c0d4daf1fa675aa86e396))
- classify OpenCode correctly and bill Codex by credential *(billing)* ([`1f551d0`](https://github.com/MadAppGang/claudish/commit/1f551d0a05c01d89d28f11d73fb0b8cbccd33712))

### Documentation

- record the findings, the measurements and the backend contract([`f973c77`](https://github.com/MadAppGang/claudish/commit/f973c779cd5c3e858751bbe247cd1650adeedc8b))
- update CHANGELOG.md for v8.1.0([`44e519f`](https://github.com/MadAppGang/claudish/commit/44e519f711eb3860a1717ae115f1f1f5a5563cc0))

### New Features

- render every subscription route, not just the first *(catalog)* ([`7304daa`](https://github.com/MadAppGang/claudish/commit/7304daadd4aa926dd5e3240ed8e52de39f3f4e6c))

### Other Changes

- release v9.0.0([`e7bcaa9`](https://github.com/MadAppGang/claudish/commit/e7bcaa917afcd8f9c807b254e1076b9fce7c0b56))

## [8.1.0] - 2026-08-29

### Bug Fixes

- consume route reasoning mode capability([`dba92f7`](https://github.com/MadAppGang/claudish/commit/dba92f7f47f88515865ad8454c0f2500f1191b5e))

### Documentation

- update CHANGELOG.md for v8.0.0([`5ac86aa`](https://github.com/MadAppGang/claudish/commit/5ac86aae783011d3b13d62871c23c1d302cdd4ed))

### New Features

- search_models answers with catalog names, not a PAYG address *(mcp)* ([`7239941`](https://github.com/MadAppGang/claudish/commit/72399411a0942d8d10bcf92a025d5931271d1ff7))

### Other Changes

- release v8.1.0([`8673114`](https://github.com/MadAppGang/claudish/commit/867311458803890ec9639bb2e7424825f6b89502))

## [8.0.0] - 2026-08-27

### Bug Fixes

- bun --cwd before `run` silently skips the package *(scripts)* ([`e69be3e`](https://github.com/MadAppGang/claudish/commit/e69be3e410df8a111979702c9ce155c854b1b10d))
- share the child-supervision mechanism; two latent bugs fall out *(team)* ([`079e7e3`](https://github.com/MadAppGang/claudish/commit/079e7e3d161020b5dac502b2f48fc5efdac3a805))

### Documentation

- update CHANGELOG.md for v7.67.1([`ca79a7c`](https://github.com/MadAppGang/claudish/commit/ca79a7c5f588f5cef2c6c58a76d975cba1344014))

### New Features

- non-blocking run, caller-owned cancellation, prompts from a file *(team)* ([`beaf889`](https://github.com/MadAppGang/claudish/commit/beaf88968005535f89d05b752ab9eaea6784b2dd))
- report idle time as data; the caller decides what it means *(channel)* ([`fdde2a7`](https://github.com/MadAppGang/claudish/commit/fdde2a71f112cc60ab2cebda1348085d9689a206))

### Other Changes

- release v8.0.0([`56e4963`](https://github.com/MadAppGang/claudish/commit/56e4963c341004fb5c476e13cb5ea0c6bde78958))

### Refactoring

- one stream-json parser; team feeds the reducer *(team)* ([`26bc39f`](https://github.com/MadAppGang/claudish/commit/26bc39fea49e92e23df3c62483bf1706f3ff27b6))
- delete the stall reaper; nothing kills a working slot *(team)* ([`0a4c2f0`](https://github.com/MadAppGang/claudish/commit/0a4c2f02813109fda09604d94977767b19707ce7))

## [7.67.1] - 2026-08-27

### Bug Fixes

- stop text tool-call recovery dispatching mangled tool names (#223)([`e82c315`](https://github.com/MadAppGang/claudish/commit/e82c31574eb09a1553fcc42cdd43dad05ec04bd2))

### Documentation

- update CHANGELOG.md for v7.67.0([`d96e8e6`](https://github.com/MadAppGang/claudish/commit/d96e8e652216517522e0205ecc17aa04c40a5af8))

### Other Changes

- release v7.67.1([`d01026e`](https://github.com/MadAppGang/claudish/commit/d01026e66cc912fc2ed8db7720e71e3ad89e93b9))

## [7.67.0] - 2026-08-27

### Documentation

- update CHANGELOG.md for v7.66.1([`1eed670`](https://github.com/MadAppGang/claudish/commit/1eed6701e9767ac4845a592ff9de1507253312bf))

### New Features

- --model-params, --effort-override, and catalog-driven ultracode presets (#220)([`cf53f4f`](https://github.com/MadAppGang/claudish/commit/cf53f4fe8a949383e3719a37dd409d6b696fc8d4))

### Other Changes

- release v7.67.0([`84622c0`](https://github.com/MadAppGang/claudish/commit/84622c0ad86298c61a98a409b479e720e0d64542))

## [7.66.1] - 2026-08-26

### Bug Fixes

- tell a spent plan apart from an empty balance (#219) *(probe)* ([`c044eb8`](https://github.com/MadAppGang/claudish/commit/c044eb840bc290df5190ceb5d9a1b21dcbad5b41))

### Documentation

- update CHANGELOG.md for v7.66.0([`62af5ca`](https://github.com/MadAppGang/claudish/commit/62af5caba96c1a00afd7ab971e94b275aaaccf4b))

### Other Changes

- release v7.66.1([`5f7bbb1`](https://github.com/MadAppGang/claudish/commit/5f7bbb15509e210833a419cab0aec670c5ad29af))

## [7.66.0] - 2026-08-24

### Bug Fixes

- talk to Antigravity's backend, not Code Assist's *(antigravity)* ([`4af2c14`](https://github.com/MadAppGang/claudish/commit/4af2c14c3b3bedb1c2285c73812745aed4092eb0))
- paint the page in the terminal's own colour, not a hardcoded slab *(tui)* ([`add2461`](https://github.com/MadAppGang/claudish/commit/add2461baa16a988ce01f12a4710f1545d7aa2cd))

### Documentation

- update CHANGELOG.md for v7.65.0([`5f14367`](https://github.com/MadAppGang/claudish/commit/5f143677aec3ff3b8ffbd46ec078681e14927de6))
- the two ways a green local run lied during the v7.65.0 release *(testing)* ([`a8361ef`](https://github.com/MadAppGang/claudish/commit/a8361efc98f3d3ac0eee659a86974e6f25f2ed83))

### New Features

- macOS Keychain as a credential backend *(keychain)* ([`fb37c2d`](https://github.com/MadAppGang/claudish/commit/fb37c2dcb0bae9ca541dfa4c7456b996724072fb))

### Other Changes

- release v7.66.0([`8f1e20d`](https://github.com/MadAppGang/claudish/commit/8f1e20d0956b60981b2915c3aeddc2c7fcab9ab6))

## [7.65.0] - 2026-08-22

### Bug Fixes

- track the stream-json captures instead of reading them from a gitignored session dir *(test)* ([`74a6541`](https://github.com/MadAppGang/claudish/commit/74a6541c4414b1f8f8a336cc50f545fdb14dce40))
- recover evicted sessions from disk, and stop a NUL byte hiding the file from grep *(channel)* ([`bf33054`](https://github.com/MadAppGang/claudish/commit/bf33054a224b9efe9cfe3d3bf4ad6a169e54528a))
- stop rate_limit_event frames being captured as the model's answer *(team)* ([`8e1e4cb`](https://github.com/MadAppGang/claudish/commit/8e1e4cbdd957e1cbbcba63f6bd40cef6707d7242))

### Documentation

- update CHANGELOG.md for v7.64.1([`b1caaa5`](https://github.com/MadAppGang/claudish/commit/b1caaa5e81565a69087fed56219f0aeb5536b12d))
- prove the cost/latency guards grade, instead of excusing a red control *(benches)* ([`fb911bc`](https://github.com/MadAppGang/claudish/commit/fb911bc1e8689111729f27139438c927188cfc26))
- how to actually drive a magmux session to completion, and the four traps([`dced29f`](https://github.com/MadAppGang/claudish/commit/dced29f389acda43a82b59f90220bcf2a35be8d0))
- correct why magmux exists — agent-drives-agent, and headless keeps the PTY([`a901f75`](https://github.com/MadAppGang/claudish/commit/a901f7518d2f54743e21ce11c4fd293ef9482f19))
- headless is not a faithful subset of interactive — and why magmux exists([`17e1fe9`](https://github.com/MadAppGang/claudish/commit/17e1fe98b2d03b7388cb37c34249a8c4961c43c0))

### New Features

- bidirectional stream-json transport, and a timeout that stops reporting success *(channel)* ([`da1b485`](https://github.com/MadAppGang/claudish/commit/da1b4855d89887cf92f452a310d271e56f1f9a13))
- working driver that runs a magmux Claude session to completion *(scripts)* ([`4ab8966`](https://github.com/MadAppGang/claudish/commit/4ab8966f4e470a8828c7593fb9c2d3be929638de))
- native Claude is a runnable team slot, with a first-class agent param *(team)* ([`471bbf7`](https://github.com/MadAppGang/claudish/commit/471bbf77ad0677dd97f32024cd6eff4691abfbcf))

### Other Changes

- v7.65.0 *(release)* ([`9b74034`](https://github.com/MadAppGang/claudish/commit/9b7403437e212beb939048a94bc05f857dd87091))

## [7.64.1] - 2026-08-22

### Bug Fixes

- repair account-scoped probe diagnostics *(providers)* ([`73e0233`](https://github.com/MadAppGang/claudish/commit/73e02330bb643d58809525f72f9083642f7151a5))

### Documentation

- move architecture rationale out of CLAUDE.md into ai-docs/architecture/([`ceeef60`](https://github.com/MadAppGang/claudish/commit/ceeef606ff49c0952ce65794ca1f6ffa312625be))
- update CHANGELOG.md for v7.64.0([`4daf804`](https://github.com/MadAppGang/claudish/commit/4daf80403122e61b395d0feb550d049fdd151cc1))

## [7.64.0] - 2026-08-19

### Documentation

- update CHANGELOG.md for v7.63.0([`c61f9f1`](https://github.com/MadAppGang/claudish/commit/c61f9f1053290f4d30859b5cc74bd1d31c78b229))

### New Features

- v7.64.0 — custom endpoints that take no credential, and 809 lines of dead provider table([`94ae235`](https://github.com/MadAppGang/claudish/commit/94ae2352a85ddc8ecf32fcff5f203f6adf8b21db))

## [7.63.0] - 2026-08-19

### Documentation

- update CHANGELOG.md for v7.62.0([`7515317`](https://github.com/MadAppGang/claudish/commit/751531784183a856e07a4268632b182dfa843c66))

### New Features

- v7.63.0 — one endpoint-registration seam, and a chain that advances on a dead key([`a2cc661`](https://github.com/MadAppGang/claudish/commit/a2cc661cfafe929a49e052f1c218453f879ec3eb))

## [7.62.0] - 2026-08-18

### Bug Fixes

- biome-ignore for control chars in the OSC 11 reply matcher([`9bff033`](https://github.com/MadAppGang/claudish/commit/9bff03366f98911249759adf1ec3b9e842ac59d0))
- give the spawned pty a size, and stop blaming magmux for it (#209) *(test)* ([`76c0a93`](https://github.com/MadAppGang/claudish/commit/76c0a936b63e7cada973ca7af38c89a8b706f8d6))

### Documentation

- update CHANGELOG.md for v7.61.0([`69bf7b0`](https://github.com/MadAppGang/claudish/commit/69bf7b060c21840010e6457994d7013de8216f7d))

### New Features

- v7.61.0 - auto-detected light theme for all TUI screens and CLI output([`5fbdc56`](https://github.com/MadAppGang/claudish/commit/5fbdc56f69ac3a427f9e61aad021f4fdbcd02e9a))
- light-theme sweep, tests, and docs — screenshot-verified both modes([`c9cb626`](https://github.com/MadAppGang/claudish/commit/c9cb6265435b8f68f3059e43492cc4b4d1d44770))
- theme-mode core — dual light/dark palette with auto-detection([`4930e64`](https://github.com/MadAppGang/claudish/commit/4930e64207dd89f8f45059a89573ed869408becc))

### Other Changes

- v7.62.0 - auto-detected light theme for all TUI screens and CLI output([`8c1a3db`](https://github.com/MadAppGang/claudish/commit/8c1a3db819115c7e511d3d3763c35f3967c240ed))
- upgrade @opentui/core+react 0.1.87 -> 0.1.107 for theme detection APIs([`bd14693`](https://github.com/MadAppGang/claudish/commit/bd14693f1d31293883d582807bc995de6f78595e))

## [7.61.0] - 2026-08-18

### Bug Fixes

- auth gate — detect macOS Keychain OAuth so classifier passthrough works pure-Codex on macOS([`95b682d`](https://github.com/MadAppGang/claudish/commit/95b682d592722c242f3bea5d07d10066f8de89bc))
- attach a per-conversation prompt_cache_key to Responses requests *(codex)* ([`9e059f3`](https://github.com/MadAppGang/claudish/commit/9e059f319eae7f9bb74dd41bd667419edd3c867a))
- stop sending reasoning_effort alongside thinking_budget *(qwen)* ([`9199adb`](https://github.com/MadAppGang/claudish/commit/9199adb467dc45953e1adeeba9f5718618d5eec1))
- stop blaming the credential when the provider handed back a fix *(errors)* ([`586e0ea`](https://github.com/MadAppGang/claudish/commit/586e0ead7ed7fc7a78c42d8c60ef04516cd5a2c4))

### Documentation

- say what CLAUDISH_CLASSIFIER_DEBUG actually writes *(classifier)* ([`9ad0b6f`](https://github.com/MadAppGang/claudish/commit/9ad0b6f62f7c3de6ed831e1f5b686a93b3cb6b51))
- update CHANGELOG.md for v7.60.0([`9ba1d3c`](https://github.com/MadAppGang/claudish/commit/9ba1d3cdddcdd124de80ef40a18ec3f0b8bd8e88))

### New Features

- classifier passthrough — run auto-mode permission classifier on native Anthropic([`c460eb6`](https://github.com/MadAppGang/claudish/commit/c460eb6ce4bab4c4ad5040164dc12e47df1c3913))
- live model discovery for glm (Z.AI pay-as-you-go) *(providers)* ([`105f785`](https://github.com/MadAppGang/claudish/commit/105f78544196ec90e2bf7c3a6ad7a6926efc9744))

### Other Changes

- v7.61.0 — qwen reasoning-knob conflict, actionable-link errors, glm discovery([`8461a0b`](https://github.com/MadAppGang/claudish/commit/8461a0b1f705a6ba696d27f19f342a50a7afb239))

## [7.60.0] - 2026-08-18

### Documentation

- update CHANGELOG.md for v7.59.0([`c271742`](https://github.com/MadAppGang/claudish/commit/c271742b979c79371660d98e6d2f086229cbbd23))

### Other Changes

- v7.60.0 - one provider table, roster-fetcher registry([`8103da4`](https://github.com/MadAppGang/claudish/commit/8103da498bf705e8b77a05aaedf589fe8d32a9e8))

### Refactoring

- one provider table, and a registry for roster fetchers *(providers)* ([`2956f18`](https://github.com/MadAppGang/claudish/commit/2956f1814a449a8cf1c2d455aeac6e59e5452296))

## [7.59.0] - 2026-08-18

### Documentation

- update CHANGELOG.md for v7.58.0([`4d5095e`](https://github.com/MadAppGang/claudish/commit/4d5095e694eddc9074e036fb5668d8641d765368))

### New Features

- drop candidates that positively do not serve the model *(routing)* ([`774bcf2`](https://github.com/MadAppGang/claudish/commit/774bcf2f5c7c3c2a7952149bad0a885144e7854a))

### Other Changes

- v7.59.0 — routing drops providers that do not serve the model([`fd76197`](https://github.com/MadAppGang/claudish/commit/fd761973c0b79ece3d6f0b62e9f5d36c78fb36b6))

## [7.58.0] - 2026-08-18

### Documentation

- update CHANGELOG.md for v7.57.0([`ef610ae`](https://github.com/MadAppGang/claudish/commit/ef610ae0b407edb6fc6fa777d892f159a1810bfa))

### New Features

- keep upstream error bodies, and let /v1/models answer (#207) *(proxy)* ([`3eca767`](https://github.com/MadAppGang/claudish/commit/3eca7673261c7bc7e0d2628db0004861bbe2b219))

### Other Changes

- v7.58.0 — upstream error capture and /v1/models discovery (#208)([`0255a68`](https://github.com/MadAppGang/claudish/commit/0255a68954ebaf0fd62cf285311eb1216eb1158f))

## [7.57.0] - 2026-08-18

### Bug Fixes

- stop substituting a working model for unknown names *(probe)* ([`d0322a2`](https://github.com/MadAppGang/claudish/commit/d0322a2c1ea791dcbecce6d415546ac0531290f9))
- derive the native Opus id from the catalog; stop sending an effort Anthropic rejects *(probe)* ([`9d7d8d8`](https://github.com/MadAppGang/claudish/commit/9d7d8d8b51efc3c484f32966bc3981c4906a96c9))
- classify an auth-shaped 401 by its body, not its status *(probe)* ([`cecc2cf`](https://github.com/MadAppGang/claudish/commit/cecc2cfe2b557f9fe5269af40de9f0be4c8e53f6))
- make swe-* routable, explicit chains one-item, and SUB visible *(routing)* ([`eb98e84`](https://github.com/MadAppGang/claudish/commit/eb98e841bd5fc73433844b9ed53eacbe9497e47f))

### Documentation

- file the models-index recommended-catalog subscription gap([`97819a6`](https://github.com/MadAppGang/claudish/commit/97819a6db074229c8137bbf59e6fb55bd152d209))

### New Features

- live model discovery for 5 more providers, and a two-source availability resolver *(providers)* ([`8beb59b`](https://github.com/MadAppGang/claudish/commit/8beb59bf1262a1f9b17382acccc1d9a24132f59d))
- add `preflight` — check a roster before spending a run on it *(mcp)* ([`23445b7`](https://github.com/MadAppGang/claudish/commit/23445b7ead29e305ffcf92f6375ec06e36356a68))

### Other Changes

- v7.57.0 — preflight tool, probe honesty, and two-source model availability([`e50d9b0`](https://github.com/MadAppGang/claudish/commit/e50d9b082da52f827ed1a9d5a6b5ad40688690be))
- v7.56.0 — Vertex eu and global reach hosts that exist (#206)([`ba57b10`](https://github.com/MadAppGang/claudish/commit/ba57b10a94e40fbcf47aafbf2ccf1a0e7f7c5cdb))

## [7.56.0] - 2026-08-18

### Bug Fixes

- send eu and global to hosts that exist (#204) *(vertex)* ([`1678aa9`](https://github.com/MadAppGang/claudish/commit/1678aa9be6eef6eec963716e0b7e4b3f091bba93))

### Documentation

- update CHANGELOG.md for v7.55.0([`a893ac5`](https://github.com/MadAppGang/claudish/commit/a893ac5652c955464ce0918daca93294a9c2e9f4))

### New Features

- Grok usage reporting, and Antigravity stops reporting the wrong tier *(quota)* ([`4386b6a`](https://github.com/MadAppGang/claudish/commit/4386b6aa94163457ad0e558ab853a4a9645cf1bb))

## [7.55.0] - 2026-08-18

### Bug Fixes

- one index-mapping layer, applied on both parser branches (#200) *(anthropic-sse)* ([`b48042c`](https://github.com/MadAppGang/claudish/commit/b48042cbbee73501ceae755ecacf5e3c9b3fbbdc))
- honour the streamFormat a config already declares (#201) *(custom-endpoints)* ([`7500062`](https://github.com/MadAppGang/claudish/commit/7500062e3328ec479fcfd9d1135a2b2b37b94f28))

### Documentation

- update CHANGELOG.md for v7.54.0([`ac7aaaf`](https://github.com/MadAppGang/claudish/commit/ac7aaafe4f89e2dfff1397bc7b525b82325e2234))

### Other Changes

- v7.55.0 — community PR round (#203)([`a97958c`](https://github.com/MadAppGang/claudish/commit/a97958c5f56e3a4e8598d16401c783d6a0c806c4))

### Refactoring

- resolve a model dialect with a function, not a manager (#202) *(adapters)* ([`e658a4c`](https://github.com/MadAppGang/claudish/commit/e658a4ce1d638c66810cabd926f41d511f708c34))

## [7.54.0] - 2026-08-18

### Documentation

- update CHANGELOG.md for v7.53.0([`69dc744`](https://github.com/MadAppGang/claudish/commit/69dc74496c455cdd4fad9e05f1ab77079d3839f8))

### New Features

- Grok Build subscription provider with its own OAuth (gk@) *(providers)* ([`091efe7`](https://github.com/MadAppGang/claudish/commit/091efe7413b374e9ee78db70798ba356c7fcfb49))

### Other Changes

- v7.54.0 - fix import order, rebase onto 7.53.0([`fcbb933`](https://github.com/MadAppGang/claudish/commit/fcbb9332cb6aec736fab0eb0e1cb983f65cde698))
- v7.53.0 - Grok Build subscription provider with its own OAuth([`1cf4618`](https://github.com/MadAppGang/claudish/commit/1cf4618380195ce014429fa0fba47df3643de156))

## [7.53.0] - 2026-08-17

### Bug Fixes

- stop reporting a transient 429 as terminal quota exhaustion *(antigravity)* ([`889e532`](https://github.com/MadAppGang/claudish/commit/889e532f6063afc82da699f9b807e873ef933805))
- drive magmux over its socket, not through a pty *(test)* ([`697d9ff`](https://github.com/MadAppGang/claudish/commit/697d9fff361902726b9bc057590e99d1d0b81e38))

### Documentation

- move the predefined-endpoints evidence somewhere it survives([`c01268f`](https://github.com/MadAppGang/claudish/commit/c01268f32c18789b2a9e811671b473ca1a51d19f))
- update CHANGELOG.md for v7.52.0([`08dfbf7`](https://github.com/MadAppGang/claudish/commit/08dfbf7a9de24617040ff983856760fdbd9ffdf4))

### Other Changes

- v7.53.0 — Antigravity transient 429 no longer reported as terminal quota exhaustion([`240244c`](https://github.com/MadAppGang/claudish/commit/240244c80671ab76f47f6a814cd7fa130d9fbdc0))

## [7.52.0] - 2026-08-17

### Bug Fixes

- close the bug report's remaining findings, and a test-isolation defect([`e46898e`](https://github.com/MadAppGang/claudish/commit/e46898edd46deae43fe8b63893b33c62f56578ed))
- ignore magmux's control panel when reading pane results *(team-grid)* ([`483cc83`](https://github.com/MadAppGang/claudish/commit/483cc832331a8903ed212e2bcc09d43d4645e1e9))
- actually stop timed-out children, and stop discarding their answers *(team)* ([`26865dc`](https://github.com/MadAppGang/claudish/commit/26865dccfadcff8ce48de606fff2c535189db62e))
- source reasoning capability from the catalog, not hardcoded gates *(adapters)* ([`80d5766`](https://github.com/MadAppGang/claudish/commit/80d5766c13b19ddf64d6376f19cdb664b07ed294))
- stop silently discarding reasoning_effort on new xAI models *(grok)* ([`b7c61d3`](https://github.com/MadAppGang/claudish/commit/b7c61d3d6f72529699e7a02ef31c3c5d116a2a2c))
- ignore magmux's control panel when reading pane results *(team-grid)* ([`b8c456a`](https://github.com/MadAppGang/claudish/commit/b8c456a94e9f2fecad31c937420a49159fb0eaa8))

### Documentation

- update CHANGELOG.md for v7.51.0([`1913b82`](https://github.com/MadAppGang/claudish/commit/1913b822152e20f3ecf86250b35d310fa4676728))

### Other Changes

- v7.52.0 - enforce team timeouts, and unbreak grok-4.6 reasoning effort([`59e717b`](https://github.com/MadAppGang/claudish/commit/59e717b110637f26597294a945c9b8cb957da8b6))

## [7.51.0] - 2026-08-17

### Documentation

- rescue the two session artifacts that tracked files still cite([`d05a62f`](https://github.com/MadAppGang/claudish/commit/d05a62f9b6f9994da3e868fcac7a27c21eddb922))
- update CHANGELOG.md for v7.50.0([`b5643ca`](https://github.com/MadAppGang/claudish/commit/b5643caf7e0bf8248daec597c39481f750f04538))

### New Features

- predefined custom endpoints — 25 measured OpenAI-compatible vendors, bundled([`bab9d84`](https://github.com/MadAppGang/claudish/commit/bab9d84986142dc5cc16dcb3db603c42a635380c))

### Other Changes

- v7.51.0 — predefined custom endpoints([`e0fd878`](https://github.com/MadAppGang/claudish/commit/e0fd878c99fc96d685dc6148e1ccecf1d1aa6188))

## [7.50.0] - 2026-08-15

### Documentation

- update CHANGELOG.md for v7.49.0([`b682749`](https://github.com/MadAppGang/claudish/commit/b682749c673f801ca0ac83c2c6332fc6074d86ba))

### New Features

- recover the full answer instead of only the final message *(team)* ([`8d9f459`](https://github.com/MadAppGang/claudish/commit/8d9f459d13fd8824d132ec29bb82e8ffab954389))

## [7.49.0] - 2026-08-15

### Bug Fixes

- widen heartbeat timing margins so CI contention cannot fail them *(test)* ([`5737e01`](https://github.com/MadAppGang/claudish/commit/5737e0191b143b8717c7d84456d96694622995d9))
- sort imports in progress-heartbeat.test.ts *(lint)* ([`b7df3f1`](https://github.com/MadAppGang/claudish/commit/b7df3f106ff849a3fb35c90cfc04833eb5f57483))
- drop thinking blocks Anthropic cannot have signed *(native)* ([`0e8f3b0`](https://github.com/MadAppGang/claudish/commit/0e8f3b05ffe9f5839a049d3597e7b8a126c3daeb))
- hoist inline system messages out of messages[] *(anthropic)* ([`0aeb2e8`](https://github.com/MadAppGang/claudish/commit/0aeb2e8da6005e81577678b40f8a071f740adc25))
- find Bun on Windows, where `which` does not exist *(cli)* ([`264bd38`](https://github.com/MadAppGang/claudish/commit/264bd38df5d66f46b59e21edd4a6766d2f8d1912))
- point mm@/mmax@ at minimaxi.com, the silo its keys come from *(minimax)* ([`b7173d2`](https://github.com/MadAppGang/claudish/commit/b7173d2d401c97968b7251499e371c5f46e5956a))
- give codex models a Responses body, not just a Responses endpoint *(openai)* ([`7095e64`](https://github.com/MadAppGang/claudish/commit/7095e64b5fc64402773945162e63df2762ea56eb))
- answer a non-streaming request with JSON, not SSE *(compact)* ([`5dc1a75`](https://github.com/MadAppGang/claudish/commit/5dc1a7558c9630a7a9a4478e57abb09ebe01eb9b))
- emit the terminal tail when upstream abandons a stream *(anthropic-sse)* ([`5934fec`](https://github.com/MadAppGang/claudish/commit/5934fec110c7c0d6de66ea03c3433a091f1483fd))
- don't print the previous session's cost when a run dies early *(session)* ([`1241cfc`](https://github.com/MadAppGang/claudish/commit/1241cfcc4ab169a96dcd0a43782a46627d6af6ce))

### Documentation

- update CHANGELOG.md for v7.48.0([`ba7eb7d`](https://github.com/MadAppGang/claudish/commit/ba7eb7dade864356cbf2a805a4d09610a2e4a6ed))

### New Features

- v7.49.0 — stop reporting a vote-less epilogue as succeeded *(team)* ([`28d4c27`](https://github.com/MadAppGang/claudish/commit/28d4c27016177a9ad2d581be2e37be4a208cc630))

### Other Changes

- let .claudemem/ be ignored globally, where its convention says it lives([`2d5fe61`](https://github.com/MadAppGang/claudish/commit/2d5fe611c8fad14441be97081cabac04e3397c0e))

## [7.48.0] - 2026-08-10

### Documentation

- update CHANGELOG.md for v7.47.0([`f3d84f6`](https://github.com/MadAppGang/claudish/commit/f3d84f6de7703618e5fce6dfe2bac5ace1aa3b57))

### New Features

- add the pay-as-you-go silo, and stop discovery failing silently *(qwen)* ([`f66e7c9`](https://github.com/MadAppGang/claudish/commit/f66e7c9b9c40080a3c3c42ca6e759fa6d7e3ca51))

### Other Changes

- v7.48.0([`71dec74`](https://github.com/MadAppGang/claudish/commit/71dec74f4ef9c7d6971386be2d32659bdbb9e564))
- restore the .claudemem/ ignore rule and collapse claudeup's duplicate headers([`7ef33dd`](https://github.com/MadAppGang/claudish/commit/7ef33dd38c67a068f55553619356c5110b5fc73b))

## [7.47.0] - 2026-08-10

### Bug Fixes

- make the branch pass the hermetic gate main added *(session)* ([`8afaabb`](https://github.com/MadAppGang/claudish/commit/8afaabb9c1029fed5f5cdfb4d324b35ad14a24c8))
- tolerate dash-slugified GLM version names on bare model specs *(routing)* ([`5a0d4ff`](https://github.com/MadAppGang/claudish/commit/5a0d4ff5f230dbeb31b106f429373646e8550a66))
- strip Claude Code's billing header so prefix caching survives *(transform)* ([`228db3c`](https://github.com/MadAppGang/claudish/commit/228db3c6833e9202f331cd14ab2c27d2e06aaf2b))
- tear down from a finally so a failed finalize cannot hang the turn *(stream-parsers)* ([`a40d2de`](https://github.com/MadAppGang/claudish/commit/a40d2de0f603a67e7ad507bb642d0e2740b42961))
- cover review comments, gate on write access, skip fork pull_request *(ci)* ([`818ea72`](https://github.com/MadAppGang/claudish/commit/818ea7234dfade123df82b18f2fe1cb47c0a9dd1))
- check out the PR head for @claude comment-triggered reviews *(ci)* ([`8cbc895`](https://github.com/MadAppGang/claudish/commit/8cbc89502e2bedf5a44ebed85cfde6449480f1f9))
- address independent review — TTY/non-git fallback, card clipping, resume id *(session)* ([`27b938f`](https://github.com/MadAppGang/claudish/commit/27b938f1a99d3af29bc26700b01f9f69f9faca72))
- address Claude review — savings basis, worktree matching, Devin, resume spec *(session)* ([`d746cf2`](https://github.com/MadAppGang/claudish/commit/d746cf255db30bab8ff9a1462923b56dc51f2050))

### Documentation

- update CHANGELOG.md for v7.46.0([`04a466d`](https://github.com/MadAppGang/claudish/commit/04a466d937f6b6a1c762e1233c3e2337b902c3b5))

### New Features

- a full-screen transcript reader, opened with `v` *(session)* ([`723091f`](https://github.com/MadAppGang/claudish/commit/723091f84ee1cb275dfc6eef73b0c82d1f6ec192))
- text-first picker rows, and a transcript tail that includes the human *(session)* ([`78c7673`](https://github.com/MadAppGang/claudish/commit/78c7673d734542349f90e266e9400a3906bc739a))
- name-then-status rows, a bigger sidebar, and two bottom panels *(session)* ([`1b02634`](https://github.com/MadAppGang/claudish/commit/1b02634efb983751a00ec9899b12902156b2cbaa))
- show the conversation tail, and put every row on one grid *(session)* ([`c4b6027`](https://github.com/MadAppGang/claudish/commit/c4b60278fde20a9e41d56027cc80328da09e3e05))
- chip the worktree state, split stale, and fold agents into a tree *(session)* ([`24d3677`](https://github.com/MadAppGang/claudish/commit/24d36771d2ed4ba5fff28aaf48bf0b0e825a9094))
- worktree state in the picker, and hide agent-driven sessions *(session)* ([`2fad6ca`](https://github.com/MadAppGang/claudish/commit/2fad6cad9bb4d12f99d5ad7a4bdab487a55d04ce))
- end-of-session summary card + worktree-aware resume picker *(session)* ([`c2ac8cf`](https://github.com/MadAppGang/claudish/commit/c2ac8cfe244ad907d8c737619431cb15fb559b94))

### Other Changes

- v7.47.0([`e796cad`](https://github.com/MadAppGang/claudish/commit/e796cad6cff47c229ede34dd086789245c0e4176))

## [7.46.0] - 2026-08-08

### Documentation

- update CHANGELOG.md for v7.45.0([`361f214`](https://github.com/MadAppGang/claudish/commit/361f214ded266168e9b67d21533ccf0903757e16))

### New Features

- v7.45.0 — derive the picker's provider roster, and give 1Password denials a fourth cause([`1ab9697`](https://github.com/MadAppGang/claudish/commit/1ab9697af280cecc2646d25d06c9c635c6bfd932))

### Other Changes

- v7.46.0([`4879110`](https://github.com/MadAppGang/claudish/commit/487911067186f551d3f7743a2451b643486ef79e))

## [7.45.0] - 2026-08-08

### Documentation

- update CHANGELOG.md for v7.44.0([`ded4c9e`](https://github.com/MadAppGang/claudish/commit/ded4c9e69ea1921e9c76b8a03807f622efff1853))

### New Features

- restore the provider chain for MiniMax and for spawned children *(routing)* ([`a9112dc`](https://github.com/MadAppGang/claudish/commit/a9112dceb4e66ca6fbe876bab8ce43c05aa705d6))

## [7.44.0] - 2026-08-07

### Documentation

- update CHANGELOG.md for v7.43.0([`5ec2cc2`](https://github.com/MadAppGang/claudish/commit/5ec2cc2d8f774903a46f112fa8661007a2a705a1))

### New Features

- per-provider roster collapse, and fix two order-dependent resolutions (#160) *(model-resolvers)* ([`c33ce8d`](https://github.com/MadAppGang/claudish/commit/c33ce8d012649e8625d701ffb347210a8406d426))

### Other Changes

- biome clean — organize imports and format([`438a0bc`](https://github.com/MadAppGang/claudish/commit/438a0bc5961a55e94ebcd474f0d47e1f844fedc9))

## [7.43.0] - 2026-08-06

### ⚠ BREAKING CHANGES

- v7.36.0 — remove the Gemini Code Assist provider, repoint gemini-* at Antigravity([`8258e1f`](https://github.com/MadAppGang/claudish/commit/8258e1fbd46a8067984c5228cfcda04ae6645431))

### Bug Fixes

- keep the provider's own wire id when an alias is removed *(picker)* ([`af71a40`](https://github.com/MadAppGang/claudish/commit/af71a4009987724b7e86a38cc61e06a25ffc2435))
- derive the aggregator roster from the catalog, not a hardcoded set *(picker)* ([`3a293b9`](https://github.com/MadAppGang/claudish/commit/3a293b92e55803fe9455d0add0e0aabde4d4a7eb))
- read the model facts the catalog already ships, instead of guessing from names([`b8f5f08`](https://github.com/MadAppGang/claudish/commit/b8f5f08cb1ba1cfb3dd152063b17b9245d10649d))

### Documentation

- update CHANGELOG.md for v7.42.0([`f3a7bd3`](https://github.com/MadAppGang/claudish/commit/f3a7bd38357f2fad1dbcc6d5ab1c46c1e91cc967))

### New Features

- add a Mistral transport, and stop an alias collision serving the wrong model([`6f58eea`](https://github.com/MadAppGang/claudish/commit/6f58eea97a1a194040df0a8d5ee705d4f5615a0a))
- v7.36.0 — remove the Gemini Code Assist provider, repoint gemini-* at Antigravity([`8258e1f`](https://github.com/MadAppGang/claudish/commit/8258e1fbd46a8067984c5228cfcda04ae6645431))

### Other Changes

- v7.43.0([`58a2dd8`](https://github.com/MadAppGang/claudish/commit/58a2dd816492ae7be506be636dea46c3abd79e4d))

### Refactoring

- one catalog client for every provider, and no per-model cloud lookup([`3daa6cd`](https://github.com/MadAppGang/claudish/commit/3daa6cd83d28714be7b825362b9a30e8b9080acf))

## [7.42.0] - 2026-08-06

### Bug Fixes

- stop deleting answers that open like reasoning, and report truncation honestly *(gemini)* ([`92b72cb`](https://github.com/MadAppGang/claudish/commit/92b72cb89e2d06ad813931fc42fc2064b54238f0))

### Documentation

- update CHANGELOG.md for v7.41.0([`78ae3b5`](https://github.com/MadAppGang/claudish/commit/78ae3b54a82b5eb8f074f72ec208d724955471c0))

### Other Changes

- v7.42.0([`6dd2ab8`](https://github.com/MadAppGang/claudish/commit/6dd2ab86237b40b00cafb6327f0fa7675dda0794))

## [7.41.0] - 2026-08-06

### Documentation

- update CHANGELOG.md for v7.40.0([`df3b279`](https://github.com/MadAppGang/claudish/commit/df3b27957ca5cad275f133bc7eeee5659d9796db))

### New Features

- v7.38.0 — dv@ Devin provider, route Claude Code through a Devin subscription (#154)([`176761a`](https://github.com/MadAppGang/claudish/commit/176761a4842c5d319953902425343318ce4d265f))

## [7.40.0] - 2026-08-06

### Documentation

- update CHANGELOG.md for v7.39.0([`7aff9f9`](https://github.com/MadAppGang/claudish/commit/7aff9f9a6476872624cac10ac740e13e71e4d538))

### New Features

- v7.40.0 — subscriptions before metered APIs, and stop mistaking a spent plan for a broken key([`cd952c2`](https://github.com/MadAppGang/claudish/commit/cd952c2948d79601deb24335a04e7a6fd1628113))

## [7.39.0] - 2026-08-05

### Documentation

- update CHANGELOG.md for v7.38.0([`aad6060`](https://github.com/MadAppGang/claudish/commit/aad60604164a4741123d15517901fe807db8e27d))

### New Features

- v7.39.0 — real subscription usage in the status line, and gemini-* routes to Antigravity([`f7670f8`](https://github.com/MadAppGang/claudish/commit/f7670f85536e8600ebf27c4e32d4286fd42157f5))
- publish real subscription usage, and stop the 2s probe that measured it *(quota)* ([`c700f68`](https://github.com/MadAppGang/claudish/commit/c700f680a14cb54021e7294b521307429597b506))

## [7.38.0] - 2026-08-05

### Bug Fixes

- v7.38.0 — one 1Password dialog per multi-model run, not one per model([`7714a22`](https://github.com/MadAppGang/claudish/commit/7714a228a716368e14d6f4c4b8763c10a84b6a54))

### Documentation

- update CHANGELOG.md for v7.37.0([`fb7aa51`](https://github.com/MadAppGang/claudish/commit/fb7aa517aa4467662388b68974b60a7b6e217c0f))

## [7.37.0] - 2026-08-05

### Bug Fixes

- v7.37.0 — 1Password works without a TTY, and stops asking twice([`b81ec1c`](https://github.com/MadAppGang/claudish/commit/b81ec1c6885f664b809c0326addb07028b20c2f8))
- pass --cache=false to `op` — the daemon was the TCC prompt *(1password)* ([`6e9bde7`](https://github.com/MadAppGang/claudish/commit/6e9bde79a7942b5305c698d9104efdb29bd56b96))
- cache the auth FAILURE, not just the success *(1password)* ([`1ccbe7f`](https://github.com/MadAppGang/claudish/commit/1ccbe7f6e22a49fc770fc0ac475636f6507e40bc))
- the harness was testing the INSTALLED claudish, not this tree *(mcp-e2e)* ([`a22c647`](https://github.com/MadAppGang/claudish/commit/a22c647cecc2d687b8729b94aefc5dbed4729042))
- make per-account routing testable, and prove dialog scoping *(1password)* ([`2a77777`](https://github.com/MadAppGang/claudish/commit/2a77777d1f6bf49c8d77f9337dd797136be55959))
- honour the test seam in per-entry auth *(1password)* ([`731380e`](https://github.com/MadAppGang/claudish/commit/731380ebf1693679df7f4ca3f4afaf2c93de8148))
- never infer a 1Password account — `op` has no default to infer from([`306a62c`](https://github.com/MadAppGang/claudish/commit/306a62caa2ee85c083586658bb08f6df6f40eca7))

### Documentation

- update CHANGELOG.md for v7.36.0([`0d97c12`](https://github.com/MadAppGang/claudish/commit/0d97c12ef4da9aaff30cff0a2535cbd85d1aaffa))

### New Features

- print the dialogs each arm should raise, before it runs *(mcp-e2e)* ([`079a909`](https://github.com/MadAppGang/claudish/commit/079a909829b318e4edb52e9646e150565645aa94))
- honour declared accounts for refs, globs, and the add-wizard *(1password)* ([`353b0b1`](https://github.com/MadAppGang/claudish/commit/353b0b1efaa0894a87455a97a05b4694cf1259da))
- account per source — parser, entry-aware config, per-entry auth *(1password)* ([`c7b0134`](https://github.com/MadAppGang/claudish/commit/c7b01344fcd19b0d687d39c9ddf88edb4244b195))

## [7.36.0] - 2026-08-05

### Bug Fixes

- drive the reasoning knob from the catalog, not a 4.5/4.6 name test *(glm)* ([`fd23ca4`](https://github.com/MadAppGang/claudish/commit/fd23ca427289af9b9de6d8859031ed68532d0964))
- bound the `op` probes — an unbounded spawn is a hang, not a slow path *(1password)* ([`7cd83d0`](https://github.com/MadAppGang/claudish/commit/7cd83d0433aad917f0edda6d11ad0429849d7946))
- onepassword tests shelled out to the real `op` binary *(test)* ([`4726d3d`](https://github.com/MadAppGang/claudish/commit/4726d3d9dcd8a63bb1af32a4d12c74bcd555c92d))

### Documentation

- update CHANGELOG.md for v7.35.0([`c678e51`](https://github.com/MadAppGang/claudish/commit/c678e51cb430c01e9fedd4c0a1295e37b3494647))

### New Features

- send context fill percent — absolute tokens were the wrong unit *(telemetry)* ([`8a0efba`](https://github.com/MadAppGang/claudish/commit/8a0efba457d82e89fbcef3bd395dc6c5c7b3748a))

### Other Changes

- v7.36.0([`5c9ec8a`](https://github.com/MadAppGang/claudish/commit/5c9ec8aa14b8ceeba9d129d61df651a72935da09))
- make the lint gate pass, and stop one rule fighting another([`1495fb3`](https://github.com/MadAppGang/claudish/commit/1495fb3217f24f4d70b60ef1c8b067dabfd29f8c))

## [7.35.0] - 2026-08-04

### Documentation

- update CHANGELOG.md for v7.34.0([`b20a191`](https://github.com/MadAppGang/claudish/commit/b20a1919fc161f0893ded649237fbc7dca2852e2))

### New Features

- v7.35.0 — the behavior layer can report what it learns, without reporting you([`f6fdd31`](https://github.com/MadAppGang/claudish/commit/f6fdd31d45240798707cb5c27a35455138ea1bc0))

## [7.34.0] - 2026-08-04

### Bug Fixes

- v7.34.0 — bridge bugs that were invisible until the compiler could see them([`323c5f5`](https://github.com/MadAppGang/claudish/commit/323c5f511c6a4bf35d9346b0c1856f53689c9f92))
- emit one line per value for repeated HTTP headers *(bridge)* ([`6d26898`](https://github.com/MadAppGang/claudish/commit/6d268987b8db19986849aa33966a2122a5fbf387))
- make `bun run typecheck` a real gate — the macOS bridge was never checked([`f982966`](https://github.com/MadAppGang/claudish/commit/f982966b59d5ae323ec8635fe7c2588d897388d0))
- stop 1Password failures from being invisible under MCP, guard ${OP_ACCOUNT}([`d09d6c5`](https://github.com/MadAppGang/claudish/commit/d09d6c59afbc90fc77babb2e9e43e4e6777328c5))
- resolve the 1Password account from `op` when there is no TTY([`1fe6d6a`](https://github.com/MadAppGang/claudish/commit/1fe6d6a57efa7486384ec82a0cf7c3868d6d0f52))
- import the real orchestrator types instead of shadowing them *(test)* ([`9479032`](https://github.com/MadAppGang/claudish/commit/947903281cbf63628f92a719c88df4f3a1dd0e96))

### Documentation

- update CHANGELOG.md for v7.32.0([`76db990`](https://github.com/MadAppGang/claudish/commit/76db990c48f584ba24432577776b3e45127519ee))

### New Features

- v7.33.0 — claudish login antigravity (delegates to agy)([`d549575`](https://github.com/MadAppGang/claudish/commit/d549575a8078bfbdb0bf7be28d1c1a92d351d361))

## [7.32.0] - 2026-08-04

### Documentation

- update CHANGELOG.md for v7.31.0([`8516c8c`](https://github.com/MadAppGang/claudish/commit/8516c8cba4c443babf81828063cb945f764b9c01))

### New Features

- v7.32.0 — the behavior layer can see model output, read the system prompt, and scope rules per model([`f94a07b`](https://github.com/MadAppGang/claudish/commit/f94a07bda0b8ef4223a7703cbaae3f97520687e3))

## [7.31.0] - 2026-08-04

### Documentation

- update CHANGELOG.md for v7.30.0([`c409764`](https://github.com/MadAppGang/claudish/commit/c409764bc889f272480bfcc022b32da483b9b8fd))

### New Features

- v7.31.0 — Qwen Plan follow-ups, status-line chaining, wire-aware reasoning([`bf38c3a`](https://github.com/MadAppGang/claudish/commit/bf38c3a1c31f36a644875dea47e1b5ab39f79490))
- Qwen Plan follow-ups, status-line chaining, newest-first model ordering([`ecce434`](https://github.com/MadAppGang/claudish/commit/ecce434468f67659361b54748e70a589157b0f2f))

## [7.30.0] - 2026-08-04

### Documentation

- update CHANGELOG.md for v7.29.1([`6a12e54`](https://github.com/MadAppGang/claudish/commit/6a12e54e478f6f6e9a6fb206951203fc2db87831))

### New Features

- v7.30.0 — Antigravity provider (ag@), split Gemini into two flows([`17abfcd`](https://github.com/MadAppGang/claudish/commit/17abfcd9b361e45789636c3f05b2d0bcba6be880))

## [7.29.1] - 2026-08-04

### Bug Fixes

- v7.29.1 — probe checks that passed on the wrong signal([`4197ec4`](https://github.com/MadAppGang/claudish/commit/4197ec49d203fa5fd084ddb7c9a024b5704c0c3c))

### Documentation

- update CHANGELOG.md for v7.29.0([`932cf4e`](https://github.com/MadAppGang/claudish/commit/932cf4e1116f7c63c48f04a1f97a9f6b9e9404c4))

## [7.29.0] - 2026-08-04

### Documentation

- update CHANGELOG.md for v7.28.0([`3a1489e`](https://github.com/MadAppGang/claudish/commit/3a1489e547d7f667ca60191f5991f1c334650642))

### New Features

- v7.29.0 — behavior layer introspection, working observer, decision journal([`20acadc`](https://github.com/MadAppGang/claudish/commit/20acadcdf2b0ef1938540e4bedbec5ecae065f7f))

## [7.28.0] - 2026-08-02

### Documentation

- update CHANGELOG.md for v7.27.0([`466dfce`](https://github.com/MadAppGang/claudish/commit/466dfcea4ab1468ab99ca39b0b049680b0b0aee0))

### New Features

- v7.28.0 — make the status line report the context window Claude Code enforces([`a3123c5`](https://github.com/MadAppGang/claudish/commit/a3123c5bc8ef5ad543f124408cfd6a9187945b89))

## [7.27.0] - 2026-08-01

### Documentation

- update CHANGELOG.md for v7.26.0([`3e5ec85`](https://github.com/MadAppGang/claudish/commit/3e5ec85ee133c7bffb0bbaabfca6ca3c46bb81c7))

### New Features

- v7.27.0 — behavior-layer tool repair on every stream format([`d1ebe49`](https://github.com/MadAppGang/claudish/commit/d1ebe49a78ccb8bab222d027c40c7d037896d29c))

## [7.26.0] - 2026-07-31

### Bug Fixes

- make the app-lock probe inert — the heuristic was falsified *(1password)* ([`32eb641`](https://github.com/MadAppGang/claudish/commit/32eb64150594b42b54ae486d59a92f08d6d28074))
- stop redacting `your-key` out of credential help text([`4618d6c`](https://github.com/MadAppGang/claudish/commit/4618d6c2b0bed789f25b9d8057f2ccbe313b8ccc))
- make failures observable, bounded, and safe; add live progress *(team)* ([`056ae29`](https://github.com/MadAppGang/claudish/commit/056ae2904fd131bf8d0236d7eab73f10e94c264f))
- always serialize tool `parameters` so X-ai stops rejecting requests([`7016311`](https://github.com/MadAppGang/claudish/commit/7016311bb17f10539c46634e3030611bf079a65e))

### Documentation

- update CHANGELOG.md for v7.25.0([`160554e`](https://github.com/MadAppGang/claudish/commit/160554eae164283ca86880f4bac55f3dd2e39cc8))

### New Features

- v7.25.0 — stop claudish from denying its own 1Password requests([`31d5a02`](https://github.com/MadAppGang/claudish/commit/31d5a02527bf7a7640c4d9a1fcd870a8bdc5d709))
- serialize the DesktopAuth handshake across processes *(1password)* ([`fa3b988`](https://github.com/MadAppGang/claudish/commit/fa3b98861c4fbb77501728b3dc9fc0f832878219))
- detect a locked APP, and make lock recovery reachable at all *(1password)* ([`6f933d7`](https://github.com/MadAppGang/claudish/commit/6f933d786d4d89ffcaaa0bed75648c2c082ce24d))
- add two-level redaction for diagnostics([`118650e`](https://github.com/MadAppGang/claudish/commit/118650ed9256d909f0ee874354a4a36dfcb49148))

### Other Changes

- release as v7.26.0 — v7.25.0 was taken mid-flight([`fe78ee4`](https://github.com/MadAppGang/claudish/commit/fe78ee491a412904dd4095310fdf04a493da3307))
- add MCP client capability probes; correct the progress ROADMAP entry([`b214860`](https://github.com/MadAppGang/claudish/commit/b2148607d61ec59537780078f057dfd1345015c2))

## [7.25.0] - 2026-07-31

### Documentation

- update CHANGELOG.md for v7.24.0([`9c29cfa`](https://github.com/MadAppGang/claudish/commit/9c29cfac10869f6ec3061181a0705dca8a1d0d48))

### New Features

- v7.25.0 — Layer 4 behavior compatibility layer for foreign models([`0fb80e4`](https://github.com/MadAppGang/claudish/commit/0fb80e48b660cf12acc25f00c41ffcd92e12e902))

## [7.24.0] - 2026-07-30

### Documentation

- update CHANGELOG.md for v7.23.0([`91507e9`](https://github.com/MadAppGang/claudish/commit/91507e9704cd7c1962939a702777f5d0aadcd60f))

### New Features

- v7.24.0 — stop compacting a 1M-window model at 200K, and stop demanding keys routing won't use([`ffac9b3`](https://github.com/MadAppGang/claudish/commit/ffac9b3c33c4671a04e5db9d395411ab314b36bb))

## [7.23.0] - 2026-07-29

### Documentation

- update CHANGELOG.md for v7.22.0([`3e78db5`](https://github.com/MadAppGang/claudish/commit/3e78db5162711e4c2cf167986ccca51306181290))

### New Features

- v7.23.0 — prevent 1Password denial when claudish spawns models in parallel([`c146482`](https://github.com/MadAppGang/claudish/commit/c1464825dbd96d92f00877e4d52a705477391d53))

## [7.22.0] - 2026-07-29

### Documentation

- update CHANGELOG.md for v7.20.1([`598a6da`](https://github.com/MadAppGang/claudish/commit/598a6da842cc1ae415bc2440250db5f165f81937))

### New Features

- v7.22.0 — retry Codex faults that ride an HTTP 200 stream([`40d2432`](https://github.com/MadAppGang/claudish/commit/40d2432cc085d2dec581edd0aefd7f2d4caafe1e))

### Other Changes

- disable two plugins, bump browser-use to 1.4.0([`948070e`](https://github.com/MadAppGang/claudish/commit/948070e73a0e3699a33d40fa110ab772175491dc))

## [7.21.0] - 2026-07-29

### New Features

- v7.21.0 — recover from a 1Password denial caused by a locked Mac([`d201f2a`](https://github.com/MadAppGang/claudish/commit/d201f2a33e01d859d6aabcd922b856a5d9c7d85b))

## [7.20.1] - 2026-07-29

### Documentation

- update CHANGELOG.md for v7.19.2([`8d71cbd`](https://github.com/MadAppGang/claudish/commit/8d71cbdf7b116208156f30bd317c51112cdb1125))

## [7.20.0] - 2026-07-29

### New Features

- v7.20.0 — Kimi K3 subscription routing, live discovery, context-window fix([`42b4e81`](https://github.com/MadAppGang/claudish/commit/42b4e81e50e4daddd1cdbd80930c9d017750dc35))

## [7.19.2] - 2026-07-29

### Bug Fixes

- v7.19.2 — Responses SSE parser no longer crashes the proxy on client cancel([`24a44d6`](https://github.com/MadAppGang/claudish/commit/24a44d639ce09d97d39057299dfc198e22e905ab))
- add missing cancel() handler to Responses SSE parser([`37f178e`](https://github.com/MadAppGang/claudish/commit/37f178efb7f05828c2e9f96c3b853c1552936aaa))

### Documentation

- update CHANGELOG.md for v7.19.1([`8184231`](https://github.com/MadAppGang/claudish/commit/81842317f0506e84731caa07ed040d01d29e15e9))

## [7.19.1] - 2026-07-27

### Bug Fixes

- v7.18.2 — restore auto-compaction and honest context accounting([`ae8c07f`](https://github.com/MadAppGang/claudish/commit/ae8c07feb99729a145616343ae1cb98d90c87a00))

### Documentation

- update CHANGELOG.md for v7.19.0([`1cb9a48`](https://github.com/MadAppGang/claudish/commit/1cb9a48a61d736507f56f94fef1bafd2bd0e5f60))

## [7.19.0] - 2026-07-27

### Documentation

- update CHANGELOG.md for v7.18.1([`a4dcffa`](https://github.com/MadAppGang/claudish/commit/a4dcffa607009370b0357ba1abfdf145b30ae4d0))

### New Features

- v7.19.0 — prefer claude.ai subscription over a stray ANTHROPIC_API_KEY([`228b861`](https://github.com/MadAppGang/claudish/commit/228b861cf4e22f25807e7697ae8b68b9416dd8f2))

## [7.18.1] - 2026-07-26

### Bug Fixes

- v7.18.1 — isolate terminal output from provider connection errors([`dc4b0c3`](https://github.com/MadAppGang/claudish/commit/dc4b0c3518ea2e0cea15844ebb761dbc857be5e0))
- isolate terminal output from provider connection errors([`218c358`](https://github.com/MadAppGang/claudish/commit/218c3586bcdd3842e417a3e18aa121556c57bce0))

### Documentation

- update CHANGELOG.md for v7.18.0([`f3c8b85`](https://github.com/MadAppGang/claudish/commit/f3c8b85a5e5c4dfeaa9f2b33a256c0047166c860))

## [7.18.0] - 2026-07-26

### Bug Fixes

- treat a 1Password authorization denial as terminal, not transient([`aa71ce3`](https://github.com/MadAppGang/claudish/commit/aa71ce3a4f8d01398ee0c59cbe8fd233fdcecb2f))
- serve the proxy with Bun.serve, and silence dotenv on the MCP stdio stream([`3086261`](https://github.com/MadAppGang/claudish/commit/3086261d37c222b408aae11a0af568bd5914123e))
- stop @hono/node-server from clobbering Bun's native fetch/Response globals([`3a67af9`](https://github.com/MadAppGang/claudish/commit/3a67af9dad538889149864f5f158a77393076a97))
- custom-endpoint ${VAR} apiKey credential bug + de-flake catalog/mock-bleed tests([`d8e37da`](https://github.com/MadAppGang/claudish/commit/d8e37da94de1b9a793e4d96ed4665a6030a9b8f6))

### Documentation

- update CHANGELOG.md for v7.17.1([`f6bc939`](https://github.com/MadAppGang/claudish/commit/f6bc939c6c6c414f280ff33b4251cacb1539a040))

### New Features

- v7.18.0 — --config override, terminal 1Password cancel, Bun.serve proxy([`90fb741`](https://github.com/MadAppGang/claudish/commit/90fb7417078b65e02cd5d76a6238b8b06559b314))
- finish --config override — provenance, testable planner, docs([`ae3d47e`](https://github.com/MadAppGang/claudish/commit/ae3d47eb4fc7fe2e8b9d872a470a871708e3c732))
- --config <file> run-scoped config override (WIP)([`cb76703`](https://github.com/MadAppGang/claudish/commit/cb76703d33089ddb748c2b6c4ba192b151309e70))

## [7.17.1] - 2026-07-24

### Bug Fixes

- v7.17.1 — surface DNS/connection failures as network errors, not 500s([`d1a3379`](https://github.com/MadAppGang/claudish/commit/d1a33795e75d7aa6a61bf1648958fcc17f86defc))

### Documentation

- update CHANGELOG.md for v7.17.0([`bc24326`](https://github.com/MadAppGang/claudish/commit/bc243268f73a60bac7e8bb8ab2996ab49037f418))

## [7.17.0] - 2026-07-23

### Documentation

- update CHANGELOG.md for v7.16.0([`64dcbfc`](https://github.com/MadAppGang/claudish/commit/64dcbfc32a6ffd55d4276db38081aea149ebefd9))

### New Features

- v7.17.0 — codex auto-compaction via CLAUDE_CODE_AUTO_COMPACT_WINDOW([`2c0f5fb`](https://github.com/MadAppGang/claudish/commit/2c0f5fb97d9e04423fff10febf1f0f45b8cd5dde))

## [7.16.0] - 2026-07-23

### Documentation

- update CHANGELOG.md for v7.15.0([`4f35271`](https://github.com/MadAppGang/claudish/commit/4f35271e5cbca9853bdf769f64e518699139324c))

### New Features

- v7.16.0 — codex context-window handling + 1Password point-of-need([`40422ce`](https://github.com/MadAppGang/claudish/commit/40422ce1906648d91becf4b6873886bcd523e26e))

## [7.15.0] - 2026-07-17

### Documentation

- update CHANGELOG.md for v7.13.0([`c6d92bb`](https://github.com/MadAppGang/claudish/commit/c6d92bbfcac45ff93d929652a29d06c00e0281c1))

### New Features

- v7.15.0 — global/persistent debug mode (CLAUDISH_DEBUG + config "debug")([`23f9f78`](https://github.com/MadAppGang/claudish/commit/23f9f78c4e817f7d0032e2fde85239e8d3720ffb))

## [7.14.0] - 2026-07-15

### New Features

- v7.14.0 — pass OpenAI reasoning items back across turns (Responses/Codex)([`9090d3e`](https://github.com/MadAppGang/claudish/commit/9090d3e5fdf76a36e515fe828c79d7622ce168cc))

## [7.13.0] - 2026-07-15

### ⚠ BREAKING CHANGES

- v7.13.0 — rename --log-debug to --debug-claudish([`61ec374`](https://github.com/MadAppGang/claudish/commit/61ec374df98c81d1c3c3d2759a47729e9affcc12))

### Documentation

- update CHANGELOG.md for v7.12.7([`14dcf8c`](https://github.com/MadAppGang/claudish/commit/14dcf8ccd82bdac6f46a80a5db7376791df3636a))

### New Features

- v7.13.0 — rename --log-debug to --debug-claudish([`61ec374`](https://github.com/MadAppGang/claudish/commit/61ec374df98c81d1c3c3d2759a47729e9affcc12))

## [7.12.7] - 2026-07-15

### Bug Fixes

- v7.12.7 — a turn cut off by max_output_tokens is no longer reported as a completed tool call([`dc0bca4`](https://github.com/MadAppGang/claudish/commit/dc0bca46e6698406c6065377a20fffa41b32a116))

### Documentation

- update CHANGELOG.md for v7.12.6([`1745d3c`](https://github.com/MadAppGang/claudish/commit/1745d3c8a9072255d0c0c672aad7b0b680e0ae83))

## [7.12.6] - 2026-07-15

### Bug Fixes

- v7.12.6 — claudish update no longer blames the network for its own timeout([`1c31fa9`](https://github.com/MadAppGang/claudish/commit/1c31fa9b3928388849e947e067753d5aa038c584))

### Documentation

- update CHANGELOG.md for v7.12.5([`8983215`](https://github.com/MadAppGang/claudish/commit/8983215fa6a70ebc1e59c0d0498648efc9659ff3))

## [7.12.5] - 2026-07-15

### Bug Fixes

- v7.12.5 — OpenAI/Codex Responses parser: no duplicate tools, thinking blocks, tool_result images([`0d57fc7`](https://github.com/MadAppGang/claudish/commit/0d57fc7d59c02f69903647be1c884be87499f5f3))

### Documentation

- update CHANGELOG.md for v7.12.3([`4dde453`](https://github.com/MadAppGang/claudish/commit/4dde4537739e110150a59c6b6bdbffcd1ac51af7))

## [7.12.4] - 2026-07-14

### Bug Fixes

- v7.12.4 — single-shot stream-json is machine-clean (verbose forwarding, stderr chatter, no first-run prompt)([`d620bca`](https://github.com/MadAppGang/claudish/commit/d620bca90aa5af68c89e9dc5d4353aae2977ba66))

## [7.12.3] - 2026-07-13

### Bug Fixes

- v7.12.3 — route gpt-5.6 family via /v1/responses on oai@, native max effort, RequestMeta trace([`4679748`](https://github.com/MadAppGang/claudish/commit/4679748cfba493a5130bed8a1dd9cc583f645b9d))

### Documentation

- update CHANGELOG.md for v7.12.2([`5070f99`](https://github.com/MadAppGang/claudish/commit/5070f997725d9f4dca7ce89cfdf4c299fc0f2c5f))

## [7.12.2] - 2026-07-12

### Bug Fixes

- v7.12.2 — 1Password glob import drops keys on recurring field titles([`8bb4f9a`](https://github.com/MadAppGang/claudish/commit/8bb4f9a4226dd34fd825e5ce4f12931aaa06fe69))

### Documentation

- update CHANGELOG.md for v7.12.1([`c6e831d`](https://github.com/MadAppGang/claudish/commit/c6e831dceb8b145e9a7792bee730d845292c7823))

## [7.12.1] - 2026-07-06

### Documentation

- update CHANGELOG.md for v7.12.0([`e2a1dae`](https://github.com/MadAppGang/claudish/commit/e2a1dae31dc7cafa02742cb50a40ee9a5bc2032d))

### Other Changes

- v7.12.1 — test suite cleanup (theater/implementation-test cull)([`e80c8bf`](https://github.com/MadAppGang/claudish/commit/e80c8bfed22baf6a05c02fb67ffa1d6f7c7e4826))

## [7.12.0] - 2026-07-05

### Documentation

- update CHANGELOG.md for v7.11.0([`511da8e`](https://github.com/MadAppGang/claudish/commit/511da8eb9bed519fb6f20f2cd0ed6d8bd8d3692e))

### New Features

- v7.12.0 — forced-auth hardening, async credential layer, startup tracing([`69083af`](https://github.com/MadAppGang/claudish/commit/69083af1d53353de439e9aa41cf471df936fef06))

## [7.11.0] - 2026-06-30

### Bug Fixes

- rename sakana-coding → sakana-subscription, use SAKANA_SUBSCRIPTION_API_KEY *(sakana)* ([`b78e6ea`](https://github.com/MadAppGang/claudish/commit/b78e6ea4e5512a2a90f2a6dc5f9536ec0d9b7f1d))
- subscription (sc@) uses its own key, not the API-usage key *(sakana)* ([`84a7a95`](https://github.com/MadAppGang/claudish/commit/84a7a95854eb869e848f24b596ac5011886413a0))
- subscription (sc@) must use its own key, not the pay-as-you-go key *(sakana)* ([`7a18c83`](https://github.com/MadAppGang/claudish/commit/7a18c83f9f8374cf495949c018a626d60d3fe711))
- surface provider errors + fail loud on explicit-spec missing credential *(routing)* ([`bbb448f`](https://github.com/MadAppGang/claudish/commit/bbb448f6bd6fc9e52a4506498b28a9ded1f5d13e))

### Documentation

- update CHANGELOG.md for v7.10.0([`26385ff`](https://github.com/MadAppGang/claudish/commit/26385ff590ccc3c943043eff5a78cdf5a59f66e1))

### New Features

- v7.11.0 — reasoning-effort mapping across all providers([`a517ccc`](https://github.com/MadAppGang/claudish/commit/a517ccc0d41a1d1906aa73614ec7148c602251a0))

### Other Changes

- clean tsc + biome — zero type/lint errors across the codebase([`bc2ead4`](https://github.com/MadAppGang/claudish/commit/bc2ead461b354bc0fbe2296bf4433ae095cccb85))

## [7.10.0] - 2026-06-28

### Documentation

- update CHANGELOG.md for v7.8.4([`62cf646`](https://github.com/MadAppGang/claudish/commit/62cf646a465d7d11e012d8dc4c9ef17c20ddad9b))

### New Features

- v7.10.0 — effort mapping, tool cap, error surfacing, op-run TTY, served-by picker([`964efc6`](https://github.com/MadAppGang/claudish/commit/964efc61499f3a2e3eabd19dbe6f847120aaa2bd))
- v7.9.0 — add Sakana AI Fugu provider (sakana@/fugu@ API, sc@ subscription)([`a786b79`](https://github.com/MadAppGang/claudish/commit/a786b790b17050c28489d17aef5bffe490201900))

### Refactoring

- close all credential-layer bypasses — one authority for every signer *(credentials)* ([`1339c04`](https://github.com/MadAppGang/claudish/commit/1339c04de00c58d7c2ac9e0ffadd1a3fbffc7791))
- unify key management under one async credential layer *(credentials)* ([`7389502`](https://github.com/MadAppGang/claudish/commit/73895020b1861e818c1ab228c1124e26cbaef85c))

## [7.8.4] - 2026-06-28

### Bug Fixes

- v7.8.4 — OAuth login takes effect without relaunch([`9158bba`](https://github.com/MadAppGang/claudish/commit/9158bba42afb22e8331bdc64e2c08836e373fc4e))

### Documentation

- update CHANGELOG.md for v7.8.3([`6c11933`](https://github.com/MadAppGang/claudish/commit/6c119333765d1e4846cc52f7409099da0fe06e67))

## [7.8.3] - 2026-06-27

### Bug Fixes

- v7.8.3 — local server off / no chat model is 'unavailable', not FAIL([`c9331e0`](https://github.com/MadAppGang/claudish/commit/c9331e02cd24ab4c52617f4013ac5202741a77fa))
- v7.8.2 — running local shown 'running' was filed under 'not configured'([`3dc57f4`](https://github.com/MadAppGang/claudish/commit/3dc57f4adc4352c2143400bb244cedf484db121e))

### Documentation

- update CHANGELOG.md for v7.8.2([`2e3136c`](https://github.com/MadAppGang/claudish/commit/2e3136cbecef961c1b73feee0c2a6bdb068e6aab))
- update CHANGELOG.md for v7.8.1([`a31b0ca`](https://github.com/MadAppGang/claudish/commit/a31b0caca7715af7e5c9f34f6ad69961cd98d106))

## [7.8.1] - 2026-06-27

### Bug Fixes

- v7.8.1 — credential-authority regressions + config Providers fixes([`3f8806e`](https://github.com/MadAppGang/claudish/commit/3f8806ed7b2dc97b63d29b4a139429fddae8a2ee))

### Documentation

- update CHANGELOG.md for v7.8.0([`a26551d`](https://github.com/MadAppGang/claudish/commit/a26551d0e04c3e63b0cfe36cb60e76b779d3d75e))

## [7.8.0] - 2026-06-27

### ⚠ BREAKING CHANGES

- consistent flag naming + colorized, validated --help *(cli)* ([`7ec5407`](https://github.com/MadAppGang/claudish/commit/7ec5407afa3403df7c98f541cd1449fc6a3024fb))

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

### ⚠ BREAKING CHANGES

- v7.5.0 — claudish serve gateway for Claude Desktop + provider slug alignment([`22df65f`](https://github.com/MadAppGang/claudish/commit/22df65f68abbb095f9d4144b1a212ce77d06c46a))

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

### ⚠ BREAKING CHANGES

- v7.0.0 — configurable default provider, custom endpoints([`c5ae212`](https://github.com/MadAppGang/claudish/commit/c5ae2127aee0f27d3d226958490741460f7a88e2))

### Documentation

- update CHANGELOG.md for v6.14.0([`8f18ec2`](https://github.com/MadAppGang/claudish/commit/8f18ec21e67babcebab862f49e2dade859d1f44c))

### New Features

- v7.0.0 — configurable default provider, custom endpoints([`c5ae212`](https://github.com/MadAppGang/claudish/commit/c5ae2127aee0f27d3d226958490741460f7a88e2))
- add aggregators[] field to ModelDoc and slim catalog *(firebase)* ([`8a08535`](https://github.com/MadAppGang/claudish/commit/8a08535ceb3fa941e9859adea0926e804728425b))
- runtime-registered custom endpoints *(providers)* ([`1451aea`](https://github.com/MadAppGang/claudish/commit/1451aea57448417e44d64e1a7d2ccf2d7a8ee789))
- demote LiteLLM from hardcoded priority *(routing)* ([`5a0d294`](https://github.com/MadAppGang/claudish/commit/5a0d294f63203e068da5e4e241dd56d9ea509964))
- add defaultProvider key + customEndpoints schemas *(config)* ([`12ff0b1`](https://github.com/MadAppGang/claudish/commit/12ff0b110cedef365dd6146550f0afb2f3af573c))

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

### ⚠ BREAKING CHANGES

- v6.10.0 — Codex subscription OAuth, unified login/logout, quota registry([`a2dd1ea`](https://github.com/MadAppGang/claudish/commit/a2dd1ea156b96da16ac8021702edf614ce9ebe3d))

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

### ⚠ BREAKING CHANGES

- v6.7.0 — replace mtm with magmux, improve catalog resolver, add OAuth manager([`6759005`](https://github.com/MadAppGang/claudish/commit/675900567be9f139aece1f674ed8f6880843bd89))

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

### ⚠ BREAKING CHANGES

- v6.5.0 — Gemini Code Assist overhaul, auth commands, quota CLI, Codex OAuth([`f9b1c54`](https://github.com/MadAppGang/claudish/commit/f9b1c54682d16cf8684d3ec8ce4b4201cddef59d))

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

### ⚠ BREAKING CHANGES

- All adapter class names, interface names, and file paths have been renamed to reflect the three-layer architecture. Code importing old names will break.([`14efceb`](https://github.com/MadAppGang/claudish/commit/14efceb0fdb819f07180bcef7540eab7d7f7fe05))

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

### ⚠ BREAKING CHANGES

- v5.14.0 - adapter architecture rearchitecture with 3-layer separation([`871f338`](https://github.com/MadAppGang/claudish/commit/871f3387c6e68dba4b3820aa711aaa6f3bcb3bb2))

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

### ⚠ BREAKING CHANGES

- v5.0.0 - composable handler architecture, minimax-coding provider([`fdcadd5`](https://github.com/MadAppGang/claudish/commit/fdcadd51eac54d27eab34b3b6be9cee29db5cce8))

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

### ⚠ BREAKING CHANGES

- Permission prompts are now ENABLED by default. This matches normal Claude Code behavior.([`54293f2`](https://github.com/MadAppGang/claudish/commit/54293f20d0a433156221d5b2e845ffab2fc8e293))

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

### ⚠ BREAKING CHANGES

- v4.0.0 - New provider@model routing syntax([`f16caf4`](https://github.com/MadAppGang/claudish/commit/f16caf4c06c0140accf5c7d5aa5af8d552442afc))

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

### ⚠ BREAKING CHANGES

- Major version bump for local model support([`a216c95`](https://github.com/MadAppGang/claudish/commit/a216c9556f2c0b9e20ee68e45ac1579275a72604))

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


