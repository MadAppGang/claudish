# Alibaba Cloud Model Studio and QwenCloud products

Alibaba Model Studio and QwenCloud are two consoles for the same account. Their
API products have separate credentials and hosts: a key must be used with its
matching product endpoint. Account rosters can differ from public documentation.

| Product | Anthropic host (+ `/v1/messages`) | Claudish | Credential |
|---|---|---|---|
| Coding Plan | `coding-intl.dashscope.aliyuncs.com/apps/anthropic` | `qwen-coding` / `qcode@` | `QWEN_CODING_PLAN_API_KEY` |
| Token Plan | `token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic` | `qwen-token-plan` / `qtoken@` | `QWEN_TOKEN_PLAN_API_KEY` |
| PAYG | `dashscope-intl.aliyuncs.com/apps/anthropic` | `qwen-payg` / `qpay@` | `DASHSCOPE_API_KEY` |

The v3 catalog binds these transports to `qwen/modelstudio-coding-plan`,
`qwen/qwencloud-token-plan`, and `qwen/dashscope-direct`, respectively. A
model's `subscriptionPlanIds` declares published plan membership, while the
matching mapped aggregator connection carries the exact wire ID. Coding Plan
has ten published models, and Token Plan's Individual and Team editions have
20 and 31; verify counts against the current catalog generation when releasing.

For bare Qwen names, the default chain considers Coding Plan, Token Plan,
OpenCode Go, PAYG, then OpenRouter. Each candidate is checked against the
catalog and local credentials. Models from other vendors on an Alibaba product
are explicit `qcode@` or `qtoken@` selections to avoid claiming their entire
vendor namespace.

The Coding Plan `/v1/models` endpoint can respond without authentication, so
its roster response alone does not prove a key works. Validate credentialed
inference for account access. Token Plan's model list is authenticated; product
keys cannot be substituted across the three hosts.
