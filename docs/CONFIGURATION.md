# Configuration Reference

> Generated from `packages/config/configuration-schema.json` by `node scripts/generate-config-docs.mjs`. Do not edit manually.

This is a non-secret reference. Production values belong in the immutable server environment file and must never be committed. Secret examples are always blank; redaction describes how the value must be handled in diagnostics and interfaces.

## Platform

One GitHub App serves all customers; each customer installs it on its organisation.

| Variable | Type and range | Safe default | Secret / redaction | Compatibility aliases | Description |
| --- | --- | --- | --- | --- | --- |
| `GITHUB_APP_ID` | string; GitHub App numeric ID | `(unset)` | no / none | - | GitHub App identifier. |
| `GITHUB_APP_PRIVATE_KEY_PATH` | path; readable PEM path | `./orvex-review.pem` | no / path | - | Path to the GitHub App private key. Keep the key outside source control. |
| `GITHUB_APP_PRIVATE_KEY` | string; PEM value | `(unset)` | yes / secret | - | Inline GitHub App private key compatibility option. Prefer GITHUB_APP_PRIVATE_KEY_PATH. |
| `GITHUB_WEBHOOK_SECRET` | string; GitHub webhook signing secret | `(unset)` | yes / secret | - | GitHub webhook signing secret; also a legacy local-only PLATFORM_SECRET fallback. |
| `ORVEX_WEBHOOK_BODY_DEDUP_TTL_MS` | integer; 1..604800000 ms; default 7200000 | `7200000` | no / none | - | How long a processed GitHub body hash blocks rotated-delivery replay. Delivery-ID dedupe remains permanent until normal retention. |
| `GITHUB_APP_SLUG` | string; GitHub App slug; default orvex-review | `orvex-review` | no / none | - | GitHub App slug used by install and OAuth flows. |
| `GITHUB_APP_BOT_LOGIN` | string; GitHub login; default orvex-review[bot] | `orvex-review[bot]` | no / none | - | GitHub bot login used to identify Orvex comments. |
| `ORVEX_ALLOW_UNSIGNED_WEBHOOKS` | boolean; 1 enables; default disabled | `1` | no / none | - | Allow unsigned GitHub webhooks only for controlled local development. |
| `GITHUB_ALLOWED_REPO` | owner/repository; optional single repository | `Velatrixcloud/Velatrix-Cloud` | no / none | - | Legacy single-repository development mode. Do not set for SaaS. |
| `PLATFORM_SECRET` | string; at least 32 UTF-8 bytes in production or public binds | `(unset)` | yes / secret | `GITHUB_WEBHOOK_SECRET` | High-entropy signing key for sessions, OAuth state, CSRF, and MFA. It is mandatory for production and explicit public binds; GITHUB_WEBHOOK_SECRET is only a local compatibility fallback. |
| `APP_URL` | URL; absolute public URL | `http://localhost:8787` | no / none | - | Public service URL for callbacks and the connect UI. |
| `PORT` | integer; 1..65535; default 8787 | `8787` | no / none | - | HTTP listening port. |
| `HOST` | string; host/IP; default 127.0.0.1 | `127.0.0.1` | no / none | - | HTTP listening host. Use a public bind only with a high-entropy PLATFORM_SECRET. |
| `NODE_ENV` | enum; production or development | `(unset)` | no / none | - | Node runtime environment. Production selects durable queue/storage safeguards. |
| `ORVEX_ENV` | enum; production or development | `production` | no / none | `NODE_ENV` | Compatibility production-mode selector. |
| `ORVEX_LLM_COST_VISIBLE_TENANTS` | csv; workspace slugs | `(unset)` | no / none | - | Comma-separated workspaces allowed to view internal LLM spend. Empty hides it from every tenant. |

## Identity and browser security

Email/password authentication is always available; GitHub and Google are optional account-linking providers.

| Variable | Type and range | Safe default | Secret / redaction | Compatibility aliases | Description |
| --- | --- | --- | --- | --- | --- |
| `GITHUB_OAUTH_CLIENT_ID` | string; OAuth client ID | `(unset)` | no / none | - | GitHub OAuth client ID. Callback is {APP_URL}/auth/oauth/callback. |
| `GITHUB_OAUTH_CLIENT_SECRET` | string; OAuth client secret | `(unset)` | yes / secret | - | GitHub OAuth client secret. |
| `GOOGLE_OAUTH_CLIENT_ID` | string; OAuth client ID | `(unset)` | no / none | - | Google OAuth web-client ID. Redirect URI is {APP_URL}/auth/google/callback. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | string; OAuth client secret | `(unset)` | yes / secret | - | Google OAuth client secret. |
| `AUTH_DISABLED` | boolean; 1 enables; default disabled | `1` | no / none | - | Local development only: bypass OAuth and sign in as a fake development user. |
| `ORVEX_ALLOW_PUBLIC_NOLOGIN` | boolean; 1 enables; default disabled | `1` | no / none | - | Allow public no-login operation where the server explicitly supports it. |
| `ORVEX_REQUIRE_LOGIN` | boolean; 1 enables; default disabled | `1` | no / none | - | Require an authenticated account for supported product flows. |
| `ORVEX_TRUSTED_PROXY_IPS` | csv; exact socket peer IP addresses; default empty | `127.0.0.1,::1` | no / none | - | Explicit reverse-proxy socket addresses allowed to supply X-Real-IP and X-Forwarded-For. Leave empty unless the proxy is known and controlled. |
| `ORVEX_DEFAULT_PLAN` | plan; known plan ID; default free | `free` | no / none | - | Default tenant plan for newly created tenant records. |
| `ORVEX_EXTRA_DISPOSABLE_DOMAINS` | csv; lowercase domains | `(unset)` | no / none | - | Additional email domains rejected during registration. |
| `ORVEX_IP_MAX_ACCOUNTS_PER_DAY` | integer; 1..10000; default 5 | `5` | no / none | - | Daily account-creation cap per IP address. |
| `ORVEX_IP_ABUSE_BLOCK` | boolean; 0 disables; default enabled | `0` | no / none | - | Disable IP abuse blocking only for controlled local diagnostics. |
| `ORVEX_REGISTER_RATE_WINDOW_MS` | integer; 1000..86400000 ms; default 3600000 | `3600000` | no / none | - | Registration rate-limit window. |
| `ORVEX_REGISTER_RATE_IP_MAX` | integer; 1..10000; default 10 | `10` | no / none | - | Maximum registrations per IP per window. |
| `ORVEX_REGISTER_RATE_EMAIL_MAX` | integer; 1..10000; default 3 | `3` | no / none | - | Maximum registrations per email per window. |
| `ORVEX_LOGIN_RATE_WINDOW_MS` | integer; 1000..86400000 ms; default 900000 | `900000` | no / none | - | Login rate-limit window. |
| `ORVEX_LOGIN_RATE_IP_MAX` | integer; 1..10000; default 20 | `20` | no / none | - | Maximum login attempts per IP per window. |
| `ORVEX_LOGIN_RATE_ACCOUNT_MAX` | integer; 1..10000; default 5 | `5` | no / none | - | Maximum login attempts per account per window. |
| `ORVEX_MFA_RATE_WINDOW_MS` | integer; 1000..86400000 ms; default 600000 | `600000` | no / none | - | MFA rate-limit window. |
| `ORVEX_MFA_RATE_IP_MAX` | integer; 1..10000; default 20 | `20` | no / none | - | Maximum MFA attempts per IP per window. |
| `ORVEX_MFA_RATE_MAX` | integer; 1..10000; default 5 | `5` | no / none | - | Maximum MFA attempts per account per window. |

## Stripe billing

Stripe controls subscriptions and prepaid credit purchase. Prices are deployment configuration, not plan semantics.

| Variable | Type and range | Safe default | Secret / redaction | Compatibility aliases | Description |
| --- | --- | --- | --- | --- | --- |
| `STRIPE_SECRET_KEY` | string; Stripe secret key | `(unset)` | yes / secret | - | Stripe server API key. |
| `STRIPE_PUBLISHABLE_KEY` | string; Stripe publishable key | `(unset)` | no / none | - | Stripe publishable key for browser-facing payment configuration. |
| `STRIPE_WEBHOOK_SECRET` | string; Stripe signing secret | `(unset)` | yes / secret | - | Primary Stripe webhook signing secret. |
| `STRIPE_WEBHOOK_SECRET_2` | string; Stripe signing secret | `(unset)` | yes / secret | - | Secondary Stripe webhook signing secret during key rotation. |
| `STRIPE_WEBHOOK_TOLERANCE_S` | integer; 0..3600 seconds; default 300 | `300` | no / none | - | Accepted Stripe webhook timestamp tolerance. |
| `STRIPE_PRICE_REVIEW` | string; Stripe recurring price ID | `(unset)` | no / none | - | Starter subscription price: 100 included reviews then prepaid $0.50 overage, hard ceiling 1000. |
| `STRIPE_PRICE_REVIEW_PLUS` | string; Stripe recurring price ID | `(unset)` | no / none | - | Pro subscription price: 500 reviews per month, hard cap, no prepaid overage. |
| `STRIPE_PRICE_VERIFY_LITE` | string; Stripe recurring price ID | `(unset)` | no / none | - | Verify Lite subscription price: 50 included reviews then prepaid $0.75 overage, hard ceiling 500. |
| `STRIPE_PRICE_VERIFY` | string; Stripe recurring price ID | `(unset)` | no / none | - | Verify subscription price: 120 included reviews then prepaid $0.75 overage, hard ceiling 1000. |
| `STRIPE_METER_EVENT_REVIEW` | string; Stripe meter event name | `orvex_review_overage` | no / none | - | Legacy metered billing name. Prepaid wallet billing is the normal path. |
| `STRIPE_METER_EVENT_VERIFY_LITE` | string; Stripe meter event name | `orvex_verify_lite_overage` | no / none | - | Legacy Verify Lite metered billing name. |
| `STRIPE_METER_EVENT_VERIFY` | string; Stripe meter event name | `orvex_verify_overage` | no / none | - | Legacy Verify metered billing name. |
| `ORVEX_CREDIT_PACKS_CENTS` | csv-integers; 100..1000000 cents; default 1000,2500,5000,10000 | `1000,2500,5000,10000` | no / none | - | Prepaid credit-pack sizes offered in the dashboard. |
| `ORVEX_CHECKOUT_RATE_WINDOW_MS` | integer; 1000..86400000 ms; default 600000 | `600000` | no / none | - | Checkout rate-limit window. |
| `ORVEX_CHECKOUT_RATE_MAX` | integer; 1..10000; default 12 | `12` | no / none | - | Maximum checkout starts per rate-limit window. |

## Review providers and pricing

Normal plans use MiniMax and DeepSeek Flash. High tiers require API-key-authenticated Luna through the pinned Codex CLI at maximum reasoning effort.

| Variable | Type and range | Safe default | Secret / redaction | Compatibility aliases | Description |
| --- | --- | --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | string; legacy provider API key | `(unset)` | yes / secret | - | Legacy premium-provider fallback credential; public MiniMax plans still require MiniMax. |
| `ANTHROPIC_MODEL` | string; legacy provider model ID | `claude-sonnet-4-20250514` | no / none | - | Legacy premium-provider fallback model identifier. |
| `MINIMAX_API_KEY` | string; provider API key | `(unset)` | yes / secret | `ORVEX_STANDARD_API_KEY` | MiniMax platform API key. |
| `MINIMAX_BASE_URL` | URL; Anthropic-compatible API URL | `https://api.minimax.io/anthropic` | no / none | `ORVEX_STANDARD_BASE_URL` | MiniMax Anthropic-compatible streaming API URL. |
| `MINIMAX_MODEL` | string; provider model ID | `MiniMax-M3` | no / none | `ORVEX_STANDARD_MODEL` | MiniMax model identifier. |
| `MINIMAX_API` | enum; anthropic | `anthropic` | no / none | `ORVEX_STANDARD_API` | MiniMax transport shape; reasoning blocks are preserved. |
| `ORVEX_STANDARD_API_KEY` | string; provider API key | `(unset)` | yes / secret | `MINIMAX_API_KEY` | Active standard reviewer API key compatibility setting. |
| `ORVEX_STANDARD_BASE_URL` | URL; Anthropic-compatible API URL | `https://api.minimax.io/anthropic` | no / none | `MINIMAX_BASE_URL` | Active standard reviewer endpoint compatibility setting. |
| `ORVEX_STANDARD_MODEL` | string; provider model ID | `MiniMax-M3` | no / none | `MINIMAX_MODEL` | Active standard reviewer model compatibility setting. |
| `ORVEX_STANDARD_API` | enum; anthropic | `anthropic` | no / none | `MINIMAX_API` | Active standard reviewer transport compatibility setting. |
| `ORVEX_DEEPSEEK_API_KEY` | string; provider API key | `(unset)` | yes / secret | - | DeepSeek v4 Pro/Flash shared API key. |
| `ORVEX_DEEPSEEK_BASE_URL` | URL; HTTPS provider base URL | `https://api.deepseek.com` | no / connection | - | DeepSeek endpoint; public Flash stages retain the fixed model and max-reasoning contract. |
| `ORVEX_DEEPSEEK_MODEL` | string; provider model ID | `deepseek-v4-pro` | no / none | - | DeepSeek v4 Pro model identifier. |
| `ORVEX_DEEPSEEK_EFFORT` | enum; max | `max` | no / none | - | DeepSeek v4 Pro reasoning effort. Production must remain maximum. |
| `ORVEX_DEEPSEEK_FLASH_MODEL` | string; provider model ID | `deepseek-v4-flash` | no / none | - | DeepSeek Flash model for reviewer and fixed verifier stages. |
| `ORVEX_DEEPSEEK_FLASH_EFFORT` | enum; max | `max` | no / none | - | DeepSeek Flash reasoning effort. Production must remain maximum. |
| `ORVEX_OPENAI_API_KEY` | string; OpenAI API key | `(unset)` | yes / secret | - | OpenAI API key used through the isolated Luna broker/CLI flow. |
| `ORVEX_OPENAI_BASE_URL` | URL; OpenAI /v1 endpoint | `https://api.openai.com/v1` | no / none | - | OpenAI endpoint for explicit diagnostics and evaluation; it must not substitute for Luna CLI stages. |
| `ORVEX_OPENAI_MODEL` | string; pinned Luna model ID | `gpt-5.6-luna` | no / none | - | Pinned Luna model identifier. |
| `ORVEX_OPENAI_API` | enum; responses | `responses` | no / none | - | OpenAI API shape used by explicit diagnostics/evaluation. |
| `ORVEX_OPENAI_REASONING_EFFORT` | enum; max | `max` | no / none | - | Luna reasoning effort. Production must remain maximum. |
| `ORVEX_LLM_MAX_TOTAL_MS` | integer; 30000..300000 ms; default 300000 | `300000` | no / none | - | Hard budget for a provider attempt. Hard timeouts are not retried. |
| `ORVEX_ANTHROPIC_THINKING_BUDGET_TOKENS` | integer; positive tokens; unset disables | `20000` | no / none | - | Anthropic-compatible provider thinking-token budget. |
| `ORVEX_OPENAI_COST_INPUT_PER_M` | number; USD / 1M input tokens | `0.2` | no / none | - | OpenAI input cost used in metering. Keep current with provider pricing. |
| `ORVEX_OPENAI_COST_OUTPUT_PER_M` | number; USD / 1M output tokens | `1.2` | no / none | - | OpenAI output cost used in metering. Keep current with provider pricing. |
| `ORVEX_DEEPSEEK_FLASH_COST_INPUT_PER_M` | number; USD / 1M input tokens | `0.14` | no / none | - | DeepSeek Flash input pricing, verified 2026-08-01. |
| `ORVEX_DEEPSEEK_FLASH_COST_OUTPUT_PER_M` | number; USD / 1M output tokens | `0.28` | no / none | - | DeepSeek Flash output pricing, verified 2026-08-01. |
| `ORVEX_COST_INPUT_PER_M` | number; USD / 1M input tokens | `1.4` | no / none | - | Legacy premium-route input pricing. |
| `ORVEX_COST_OUTPUT_PER_M` | number; USD / 1M output tokens | `4.4` | no / none | - | Legacy premium-route output pricing. |
| `ORVEX_STANDARD_COST_INPUT_PER_M` | number; USD / 1M input tokens | `0.3` | no / none | - | MiniMax standard-route input pricing. |
| `ORVEX_STANDARD_COST_OUTPUT_PER_M` | number; USD / 1M output tokens | `1.2` | no / none | - | MiniMax standard-route output pricing. |
| `ORVEX_DEEPSEEK_COST_INPUT_PER_M` | number; USD / 1M input tokens | `0.435` | no / none | - | DeepSeek Pro input pricing. |
| `ORVEX_DEEPSEEK_COST_OUTPUT_PER_M` | number; USD / 1M output tokens | `0.87` | no / none | - | DeepSeek Pro output pricing. |
| `MOONSHOT_API_KEY` | string; provider API key | `(unset)` | yes / secret | - | Reserved future multi-model provider key; not wired. |
| `ZHIPU_API_KEY` | string; provider API key | `(unset)` | yes / secret | - | Reserved future multi-model provider key; not wired. |

## Storage, queue, and operations

Production uses durable storage outside the checkout and Redis with a namespaced queue. deploy-safe never modifies the immutable server environment file.

| Variable | Type and range | Safe default | Secret / redaction | Compatibility aliases | Description |
| --- | --- | --- | --- | --- | --- |
| `STORE_PATH` | path; absolute outside checkout in production | `./.data/orvex-review.db` | no / path | - | SQLite path. The relative example is local development only; production must use /home/orvex/orvex-data/velatrix-review.db or another absolute external path. |
| `ORVEX_REQUIRE_DURABLE_STORAGE` | boolean; 1 enables; production enables automatically | `1` | no / none | - | Require an absolute durable database path outside the checkout. |
| `ORVEX_WORKER_ID` | string; worker identity; default process PID | `(unset)` | no / none | - | Stable worker identity suffix for durable ownership/leases. |
| `ORVEX_CHECKOUT_ROOT` | path; absolute or relative root; default current directory | `(unset)` | no / path | - | Root under which temporary review checkouts may be created. |
| `QUEUE_BACKEND` | enum; memory or redis; production defaults redis | `memory` | no / none | - | Queue implementation. Production requires Redis unless explicitly allowed for an emergency local case. |
| `REDIS_URL` | URL; Redis connection URL | `redis://127.0.0.1:6379` | no / connection | - | Redis connection URL. It may contain credentials and is redacted in documentation/logs. |
| `ORVEX_ALLOW_MEMORY_QUEUE` | boolean; 1 enables; default disabled | `1` | no / none | - | Explicit emergency allowance for memory queue in production. Avoid in normal deployments. |
| `ORVEX_QUEUE_NAMESPACE` | string; Redis key prefix; default orvex-review | `orvex-review` | no / none | - | Namespace for queue keys on shared Redis. Tests use a unique namespace and never FLUSHDB. |
| `ORVEX_QUEUE_MAX_DEDUP` | integer; 1..1000000; default 20000 | `20000` | no / none | - | In-memory development queue deduplication bound. |
| `ORVEX_MAX_RESUME_AFTER_RESTART` | integer; 0..10; default 0 | `0` | no / none | - | Orphan review resume cap. Keep zero until durable per-stage checkpoints exist. |
| `ORVEX_MAX_JOB_RETRIES` | integer; 0..1; default 0 | `0` | no / none | - | Automatic whole-review retry count. Keep zero because a failed ensemble can already have incurred most of its cost. |
| `ORVEX_PROVIDER_LEASE_WAIT_MS` | integer; 1000..3600000 ms; default 30000 | `30000` | no / none | - | Bounded provider-slot wait. Saturation fails transiently after this interval instead of holding every worker indefinitely. |
| `ORVEX_SHUTDOWN_DRAIN_MS` | integer; 1000..86400000 ms; default 240000 | `960000` | no / none | - | Graceful shutdown drain. It must exceed ORVEX_LLM_MAX_TOTAL_MS to avoid mid-flight requeues. |
| `ORVEX_SHUTDOWN_CANCEL_MS` | integer; 100..60000 ms; default 10000 | `10000` | no / none | - | Graceful shutdown cancellation grace period. |
| `ORVEX_MAX_CONCURRENT_REVIEWS` | integer; 1..100; default 8 | `8` | no / none | - | Authoritative whole-review concurrency ceiling. |
| `ORVEX_CODEX_APIKEY_CONCURRENCY` | integer; 1..32; default worker concurrency | `8` | no / none | - | API-key-authenticated Codex/Luna concurrency cap. It cannot raise the whole-review limit. |
| `ORVEX_PROVIDER_CONCURRENCY_<PROVIDER>` | integer-template; provider in LUNA, DEEPSEEK, MINIMAX; 1..32; defaults to the applicable worker/Codex limit | `(inherited; not rendered)` | no / none | - | Bounded provider-specific concurrency family. Supported instances are LUNA, DEEPSEEK, and MINIMAX; arbitrary names are rejected by schema drift checks. |
| `ORVEX_PROVIDER_CONCURRENCY_LUNA` | integer; 1..32; default applicable worker/Codex limit | `8` | no / none | - | Luna provider-stage concurrency cap. |
| `ORVEX_PROVIDER_CONCURRENCY_DEEPSEEK` | integer; 1..32; default applicable worker/Codex limit | `24` | no / none | - | DeepSeek provider-stage concurrency cap. The eight-review production profile uses 24 for two discovery stages plus verification. |
| `ORVEX_PROVIDER_CONCURRENCY_MINIMAX` | integer; 1..32; default applicable worker/Codex limit | `8` | no / none | - | MiniMax provider-stage concurrency cap. |
| `ORVEX_MONTHLY_COGS_CAP_USD` | number; positive USD; default 250 | `250` | no / none | - | Monthly spend circuit breaker for non-custom plans. |
| `ORVEX_RUNNING_STALE_MS` | integer; 60000..86400000 ms; default 900000 | `900000` | no / none | - | Durable heartbeat staleness threshold before startup recovery interrupts a row. |
| `ORVEX_LEASE_RENEW_MS` | integer; 10000..300000 ms; default 300000 | `300000` | no / none | - | Review-lease renewal cadence. Keep it well below the queue lease TTL. |
| `ORVEX_AGENT_ARCHIVE_MAX_BYTES` | integer; positive bytes | `150000000` | no / none | - | Maximum compressed agent checkout size accepted before extraction. |
| `ORVEX_FREE_TIER_DAILY_CAP` | integer; 0..1000000; default 300 | `300` | no / none | - | Daily free-tier review admission cap. |
| `ORVEX_COGS_RESERVATION_USD` | number; positive USD; default 5 | `5` | no / none | - | Reserved review cost used by admission before provider work begins. |
| `ORVEX_CODEX_STATUS_FILE` | path; status path | `/home/orvex/orvex-data/codex-auth-status` | no / path | - | Codex authentication status file used by readiness reporting. |
| `ORVEX_DEPLOY_DRAIN_PATH` | path; drain marker path | `/home/orvex/orvex-data/deploy-drain` | no / path | - | Deployment drain-marker file outside the checkout. |
| `ORVEX_MONITOR_DISK_PATH` | path; optional monitored path | `(unset)` | no / path | - | Optional disk path for operational monitoring. |
| `ORVEX_ALERT_WEBHOOK_URL` | URL; operator webhook URL | `(unset)` | yes / connection | - | Operator-owned alert webhook for queue, billing, and database failures. |

## Review execution and prompt budgets

Limits bound time, spend, and context. Production verification remains on; max reasoning is enforced for Luna and DeepSeek.

| Variable | Type and range | Safe default | Secret / redaction | Compatibility aliases | Description |
| --- | --- | --- | --- | --- | --- |
| `MAX_FILE_BYTES` | integer; positive bytes | `300000` | no / none | - | Legacy per-file review limit. |
| `MAX_FILES` | integer; positive files | `150` | no / none | - | Legacy maximum changed-file count. |
| `MAX_LLM_TOKENS` | integer; positive tokens | `50000` | no / none | - | Legacy LLM token ceiling. |
| `ORVEX_LLM_TIMEOUT_MS` | integer; 1000..900000 ms; default 240000 | `240000` | no / none | - | Per-call timeout protecting the per-PR lock from hung calls. |
| `ORVEX_RESPONSES_TIMEOUT_MS` | integer; 1000..900000 ms; default 900000 | `900000` | no / none | - | Responses API hard timeout. |
| `ORVEX_TEST_SHORT_TIMEOUTS` | boolean; test-only flag | `1` | no / none | - | Shorten timeout bounds only in tests. |
| `ORVEX_MAX_OUTPUT_TOKENS` | integer; positive tokens; default 64000 | `64000` | no / none | - | Maximum LLM output token request. |
| `ORVEX_MAX_OUTPUT_TOKENS_CAP` | integer; 1..1000000; default 64000 | `64000` | no / none | - | Hard cap for maximum LLM output tokens. |
| `ORVEX_MAX_FINDINGS` | integer; 1..1000; default 25 | `25` | no / none | - | Maximum findings retained per review pass. |
| `ORVEX_AGENT_CTX_CHARS` | integer; 1..2000000 chars; default 240000 | `240000` | no / none | - | Agent review context budget. |
| `ORVEX_TRIGGER` | string; GitHub comment trigger; default @orvex | `@orvex` | no / none | - | Manual review command trigger. |
| `ORVEX_INLINE_EVIDENCE_GATE` | boolean; 0 disables; default enabled | `0` | no / none | - | Disable inline evidence gating only for controlled experimentation. |
| `ORVEX_DEEP_CONTEXT` | boolean; 1 enables; default disabled | `1` | no / none | - | Feed repository tree and imported files to the model. |
| `ORVEX_RISK_HUNT` | boolean; 1 enables; default disabled | `1` | no / none | - | Optional additive Flash risk hunt for high-risk diffs. Normal plans retain their advertised reviewer count when unset. |
| `ORVEX_INVESTIGATE` | boolean; 1 enables; default disabled | `1` | no / none | - | Enable the optional high-tier investigation pass after fixed public-plan reviewers are scheduled. |
| `ORVEX_INVESTIGATE_TIER` | enum; deepseek-flash, deepseek, openai, or standard; default deepseek-flash | `deepseek-flash` | no / none | - | Explicit provider slot for the optional investigation pass; it never changes public-plan routing. |
| `ORVEX_VERIFY` | boolean; 0 disables only locally; production always enables | `1` | no / none | - | Skeptical final verification stage. Production does not permit disabling it. |
| `ORVEX_VERIFY_FILE_CHARS` | integer; positive chars; default 32000 | `32000` | no / none | - | Verifier per-file context budget. |
| `ORVEX_VERIFY_TOTAL_CHARS` | integer; positive chars; default 96000 | `96000` | no / none | - | Verifier total context budget. |
| `ORVEX_VERIFY_BATCH_SIZE` | integer; positive; default 3 | `3` | no / none | - | Verifier candidate batch size. |
| `ORVEX_VERIFY_CONCURRENCY` | integer; 1..8; default 3 | `1` | no / none | - | Verifier batch concurrency. The production profile uses one per review to keep total DeepSeek fan-out bounded. |
| `ORVEX_RISK_PROBES` | integer; 0..4; unset disables | `(unset)` | no / none | - | Optional number of additional risk probes. |
| `ORVEX_RISK_PROBE_SELECTIVITY` | number; >=1.5; default 2 | `2` | no / none | - | Risk-probe selection threshold. |
| `ORVEX_LARGE_PR_FILES` | integer; positive; default 40 | `40` | no / none | - | Changed-file count classifying a large PR. |
| `ORVEX_LARGE_PR_PATCH_CHARS` | integer; positive chars; default 150000 | `150000` | no / none | - | Patch size classifying a large PR. |
| `ORVEX_BREADTH_ON` | string; review breadth mode; default deep-or-large | `deep-or-large` | no / none | - | Condition selecting breadth/removed-behaviour review lenses. |
| `ORVEX_INVESTIGATE_MAX_STEPS` | integer; 1..20; default 8 | `8` | no / none | - | Maximum investigation-tool steps. |
| `ORVEX_INVESTIGATE_TOOL_CHARS` | integer; 2000..80000 chars; default 24000 | `24000` | no / none | - | Investigation-tool output budget. |
| `ORVEX_INVESTIGATE_FILE_BYTES` | integer; positive bytes; default 250000 | `250000` | no / none | - | Largest file eligible for investigation. |
| `ORVEX_REVIEW_AGGREGATION_RUNS` | integer; 1 or measured 5..10 samples; default 1 | `1` | no / none | - | Repeated-review aggregation count. Enable 5-10 only after measuring the pinned evaluation corpus. |
| `ORVEX_REVIEW_AGGREGATION_MIN_OCCURRENCES` | integer; positive; default 2 | `2` | no / none | - | Minimum repeated-run recurrence before a finding is kept. |
| `ORVEX_REVIEW_AGGREGATION_TEMPERATURE` | number; 0..1; default 0.2 | `0.2` | no / none | - | Repeated-run sampling temperature. |
| `ORVEX_REVIEW_AGGREGATION_MAX_CANDIDATES` | integer; 10..250; default 120 | `120` | no / none | - | Maximum candidates sent to aggregation. |
| `ORVEX_MAX_INLINE_PER_PR` | integer; positive comments | `20` | no / none | - | Lifetime inline-comment cap per PR; remaining findings go to the summary. |
| `ORVEX_MAX_UNANCHORED_COMMENTS` | integer; 0..50; default 3 | `3` | no / none | - | Maximum summary-only comments for findings without a safe diff anchor. |
| `ORVEX_ABORT_POLL_MS` | integer; 1000..900000 ms; default 5000 | `5000` | no / none | - | Durable review-run ownership heartbeat cadence. GitHub PR-state fallback polling is never more frequent than every 30 seconds. |
| `ORVEX_REVIEW_MAX_CALLS` | integer; 1..100; default 28 | `28` | no / none | - | Hard per-review provider-call budget including optional work. |
| `ORVEX_REVIEW_CONCURRENCY` | integer; 1..64; default 3 | `3` | no / none | - | Maximum concurrent stages inside one review after provider admission. |
| `ORVEX_SWEEP_FILE_CHARS` | integer; 1..200000 chars; default 10000 | `10000` | no / none | - | Per-file context cap for optional repository sweeps. |
| `ORVEX_REVIEW_COOLDOWN_S` | integer; 0..86400 seconds; default 120 | `120` | no / none | - | Duplicate-review cooldown per pull-request head. |
| `ORVEX_REQUEST_CHANGES` | boolean; 1 enables; default advisory | `1` | no / none | - | Use GitHub REQUEST_CHANGES for open P1 findings. |
| `ORVEX_FAIL_CHECK_ON_P1` | boolean; 1 enables; default advisory | `1` | no / none | - | Fail the GitHub check run when P1 findings remain open. |
| `CHECK_RUNS_ENABLED` | boolean; 1 enables; default disabled | `0` | no / none | - | Enable GitHub check-run publishing. |
| `SEMGREP_DISABLED` | boolean; 1 disables; default enabled | `0` | no / none | - | Disable Semgrep integration. |
| `REVIEW_API_SECRET` | string; random bearer secret | `(unset)` | yes / secret | - | Protects POST /review. Do not reuse as an admin secret. |
| `ORVEX_ADMIN_SECRET` | string; random bearer secret | `(unset)` | yes / secret | - | Separate credential for privileged plan and super-admin automation. There is no PLATFORM_SECRET fallback. |
| `ORVEX_NIGHTLY_SCANS` | boolean; 1 enables; default disabled | `1` | no / none | - | Enable scheduled nightly scanning. |
| `ORVEX_NIGHTLY_LOOKBACK_DAYS` | integer; 1..30; default 1 | `1` | no / none | - | Nightly scan lookback period. |
| `ORVEX_NIGHTLY_HOUR` | integer; 0..23; default 3 | `3` | no / none | - | Nightly scan hour. |
| `ORVEX_NIGHTLY_MAX_SCANS_PER_TENANT` | integer; 1..500; default 25 | `25` | no / none | - | Maximum nightly scans per tenant/day. |
| `ORVEX_COMMANDS_PER_HOUR` | integer; 1..10000; default 60 | `60` | no / none | - | Autofix command rate cap. |
| `ORVEX_MAX_FIX_RUNS_PER_DAY` | integer; 1..10000; default 30 | `30` | no / none | - | Maximum autofix runs per day. |
| `ORVEX_MAX_FIX_TARGETS` | integer; 1..500; default 25 | `25` | no / none | - | Maximum autofix targets per run. |
| `ORVEX_CTX_SOURCE` | integer; 1..10000; default 100 | `100` | no / none | - | Autofix source-file context cap. |
| `ORVEX_CTX_RELATED` | integer; 0..10000; default 30 | `30` | no / none | - | Autofix related-file context cap. |
| `ORVEX_CTX_DEPENDENTS` | integer; 0..10000; default 20 | `20` | no / none | - | Autofix dependent-file context cap. |
| `ORVEX_CTX_FILE_BYTES` | integer; 1..10000000 bytes; default 32000 | `32000` | no / none | - | Autofix per-file context byte cap. |
| `ORVEX_CTX_OTHERS` | integer; 0..10000; default 20 | `20` | no / none | - | Autofix other-file context cap. |

## Codex CLI and sandbox

Agentic Luna execution is restricted to named trusted repositories, API-key authentication, and the internal runtime boundary. The code pins model and maximum reasoning effort.

| Variable | Type and range | Safe default | Secret / redaction | Compatibility aliases | Description |
| --- | --- | --- | --- | --- | --- |
| `ORVEX_CODEX_CLI` | boolean; 1 enables; default disabled | `0` | no / none | - | Enable the restricted Codex CLI agentic pass. |
| `ORVEX_CODEX_CLI_REPOS` | csv; explicit owner/repo names | `(unset)` | no / none | - | Trusted repositories allowed to run the Codex CLI. Wildcards are refused. |
| `ORVEX_CODEX_HOME` | path; API-key-authenticated home | `/home/orvex/.codex-apikey` | no / path | - | Dedicated API-key Codex home. OAuth homes are refused in production. |
| `ORVEX_CODEX_HOMES` | csv-paths; dedicated Codex homes | `(unset)` | yes / path | - | Optional bounded set of dedicated Codex homes. |
| `ORVEX_CODEX_PROXIES` | csv-URLs; approved proxies | `(unset)` | yes / connection | - | Optional bounded set of approved Codex proxies. |
| `ORVEX_CODEX_PROXY` | URL; approved proxy URL | `(unset)` | yes / connection | - | Single approved Codex proxy compatibility setting. |
| `ORVEX_CODEX_CLI_PATH` | path; pinned project-local CLI path | `(unset)` | no / path | - | Pinned local Codex CLI executable. Unpinned global binaries are refused. |
| `ORVEX_CODEX_TIMEOUT_MS` | integer; 60000..300000 ms; default 300000 | `300000` | no / none | - | Wall-clock cap for one agentic pass. |
| `ORVEX_CODEX_INACTIVITY_TIMEOUT_MS` | integer; 30000..ORVEX_CODEX_TIMEOUT_MS; default 180000 | `180000` | no / none | - | Stdout/stderr silence cap for one agentic pass. |
| `ORVEX_CODEX_RATELIMIT_MAX_WAIT_MS` | integer; milliseconds; default 60000 | `60000` | no / none | - | Codex rate-limit retry maximum wait. |
| `ORVEX_CODEX_RATELIMIT_TOTAL_WAIT_MS` | integer; milliseconds; default 60000 | `60000` | no / none | - | Codex rate-limit total sleep budget. |
| `ORVEX_CODEX_USAGE_FLOOR_INPUT` | integer; positive tokens; default 50000 | `50000` | no / none | - | Conservative input-token floor for Codex usage accounting. |
| `ORVEX_CODEX_USAGE_FLOOR_OUTPUT` | integer; positive tokens; default 5000 | `5000` | no / none | - | Conservative output-token floor for Codex usage accounting. |
| `ORVEX_CODEX_MAX_DIFF_CHARS` | integer; positive chars; default 60000 | `60000` | no / none | - | Codex opening-turn diff budget. |
| `ORVEX_CODEX_MAX_PROMPT_CHARS` | integer; positive chars; default 100000 | `100000` | no / none | - | Codex opening-turn prompt budget. |
| `ORVEX_CODEX_MAX_TREE_PATHS` | integer; positive; default 400 | `400` | no / none | - | Codex repository-tree path budget. |
| `ORVEX_CODEX_SLIM_DIFF_CHARS` | integer; positive chars; default 30000 | `30000` | no / none | - | Slim retry diff budget after a request-too-large error. |
| `ORVEX_CODEX_SLIM_PROMPT_CHARS` | integer; positive chars; default 50000 | `50000` | no / none | - | Slim retry prompt budget after a request-too-large error. |
| `ORVEX_SANDBOX_WORKDIR_MAX_BYTES` | integer; positive bytes; default 1 GiB; maximum 2 GiB | `1073741824` | no / none | - | Per-container /work disk budget checked after install and between steps. |
| `ORVEX_SANDBOX_SLOT_WAIT_MS` | integer; milliseconds; default 600000 | `600000` | no / none | - | Maximum wait for an internal sandbox slot. |
| `ORVEX_SANDBOX_STEP_TIMEOUT_MS` | integer; positive milliseconds; default 240000; maximum 900000 | `240000` | no / none | - | Maximum duration of one internal runtime-verification step. |
| `ORVEX_SANDBOX_INSTALL_TIMEOUT_MS` | integer; positive milliseconds; default 600000; maximum 900000 | `600000` | no / none | - | Maximum dependency-install duration in an internal runtime-verification sandbox. |
| `DOCKER_HOST` | URL; rootless local Unix socket only | `unix:///run/user/<orvex-uid>/docker.sock` | no / connection | - | Rootless Docker socket for the internal runtime sandbox. Never use a rootful socket or remote Docker context. |
| `DOCKER_CONTEXT` | string; local rootless Docker context only; default unset | `(unset)` | no / connection | - | Optional Docker context for the internal sandbox. Keep it unset unless the rootless local context is explicitly required. |
| `ORVEX_CODE_EXECUTION` | boolean; 1 enables after preflight; default disabled | `0` | no / none | - | Enable runtime execution only after the rootless-host preflight passes. |
| `ORVEX_CODEX_CONTAINER_RUNTIME` | boolean; 1 enables after internal egress preflight; default disabled | `0` | no / none | - | Run agentic Codex only inside the rootless internal sandbox with the dedicated egress broker. |
| `ORVEX_MAX_SANDBOXES` | integer; positive; default 8; maximum 8 | `8` | no / none | - | Host-wide maximum concurrent internal sandbox containers. |
| `ORVEX_SANDBOX_SLOT_DIR` | path; absolute private service-owned directory; default system temporary directory | `/home/orvex/orvex-data/sandbox-slots` | no / path | - | Host-wide atomic sandbox-slot lease directory. Keep it outside the deployed checkout. |
| `ORVEX_SANDBOX_SLOT_STALE_MS` | integer; positive milliseconds; default 600000; maximum 3600000 | `600000` | no / none | - | Grace period used when reclaiming a sandbox slot whose owning process is no longer alive. |
| `ORVEX_SANDBOX_IMAGE` | image digest; locally loaded immutable digest | `sha256:<64-hex-local-image-id>` | no / none | - | Mandatory immutable internal sandbox image. It must be preloaded into the rootless daemon. |
| `ORVEX_CODEX_EGRESS_BROKER_IMAGE` | image digest; locally loaded immutable digest | `sha256:<64-hex-local-image-id>` | no / none | - | Mandatory immutable image for the internal Codex-to-OpenAI egress broker when container runtime is enabled. |

## Retries and focused prompt limits

These values bound retry delays and supporting context. The diff remains first and is fairly sampled only on oversized PRs.

| Variable | Type and range | Safe default | Secret / redaction | Compatibility aliases | Description |
| --- | --- | --- | --- | --- | --- |
| `ORVEX_RATELIMIT_MAX_RETRIES` | integer; non-negative; default 2 | `2` | no / none | - | Maximum recoverable provider rate-limit retry rounds. |
| `ORVEX_RATELIMIT_MAX_WAIT_MS` | integer; milliseconds; default 60000 | `60000` | no / none | - | Maximum per-rate-limit retry sleep. |
| `ORVEX_RATELIMIT_BASE_MS` | integer; milliseconds; default 2000 | `2000` | no / none | - | Base retry-backoff duration. |
| `ORVEX_RATELIMIT_TOTAL_WAIT_MS` | integer; milliseconds; default 60000 | `60000` | no / none | - | Total retry sleep budget per provider call. |
| `ORVEX_MAX_DIFF_CHARS` | integer; positive chars; default 96000 | `96000` | no / none | - | Primary diff context budget. |
| `ORVEX_MAX_CHANGED_CHARS` | integer; positive chars; default 64000 | `64000` | no / none | - | Changed-file supporting context budget. |
| `ORVEX_MAX_RELATED_CHARS` | integer; positive chars; default 24000 | `24000` | no / none | - | Related-file context budget. |
| `ORVEX_MAX_OTHER_CHARS` | integer; positive chars; default 8000 | `8000` | no / none | - | Other supporting context budget. |
| `ORVEX_MAX_TREE_PATHS` | integer; positive paths; default 400 | `400` | no / none | - | Repository-tree path budget. |
| `ORVEX_FULL_CHANGED_FILE_CHARS` | integer; positive chars; default 12000 | `12000` | no / none | - | Full changed-file context budget. |
| `ORVEX_CHANGED_CONTEXT_LINES` | integer; positive lines; default 32 | `32` | no / none | - | Changed-line surrounding context. |
| `ORVEX_MAX_CHANGED_CHUNKS_PER_FILE` | integer; positive chunks; default 4 | `4` | no / none | - | Changed chunks retained per file. |
| `ORVEX_MAX_CHANGED_CHUNK_CHARS` | integer; positive chars; default 12000 | `12000` | no / none | - | Changed chunk length budget. |
| `ORVEX_DEEPSEEK_MAX_OUTPUT_TOKENS` | integer; positive tokens | `24000` | no / none | - | DeepSeek completion token cap while maintaining maximum reasoning effort. |
| `ORVEX_MINIMAX_MAX_OUTPUT_TOKENS` | integer; positive tokens | `24000` | no / none | - | MiniMax completion token cap. |

## Inherited child-process environment

These are copied only when already present into the tightly allowlisted environment of approved local tools. They are operating-system values, not Orvex configuration, so they are documented but not rendered into .env.example.

| Variable | Type and range | Safe default | Secret / redaction | Compatibility aliases | Description |
| --- | --- | --- | --- | --- | --- |
| `PATH` | path; inherited OS search path | `(inherited; not rendered)` | no / path | - | Executable search path passed to allowlisted child processes. |
| `HOME` | path; inherited OS home directory | `(inherited; not rendered)` | no / path | - | Home directory inherited by allowlisted child processes. |
| `USER` | string; inherited OS user | `(inherited; not rendered)` | no / none | - | User name inherited by allowlisted child processes. |
| `LOGNAME` | string; inherited OS login | `(inherited; not rendered)` | no / none | - | Login name inherited by allowlisted child processes. |
| `LANG` | string; inherited locale | `(inherited; not rendered)` | no / none | - | Locale inherited by allowlisted child processes. |
| `LC_ALL` | string; inherited locale override | `(inherited; not rendered)` | no / none | - | Locale override inherited by allowlisted child processes. |
| `LC_CTYPE` | string; inherited locale category | `(inherited; not rendered)` | no / none | - | Character-type locale inherited by allowlisted child processes. |
| `TERM` | string; inherited terminal type | `(inherited; not rendered)` | no / none | - | Terminal type inherited by allowlisted child processes. |
| `TMPDIR` | path; inherited temporary directory | `(inherited; not rendered)` | no / path | - | Temporary directory inherited by allowlisted child processes. |
| `SHELL` | path; inherited shell path | `(inherited; not rendered)` | no / path | - | Shell path inherited by allowlisted child processes. |
| `SSL_CERT_FILE` | path; inherited certificate bundle | `(inherited; not rendered)` | no / path | - | TLS certificate bundle inherited by allowlisted child processes. |
| `SSL_CERT_DIR` | path; inherited certificate directory | `(inherited; not rendered)` | no / path | - | TLS certificate directory inherited by allowlisted child processes. |
| `NODE_EXTRA_CA_CERTS` | path; inherited additional certificate bundle | `(inherited; not rendered)` | no / path | - | Additional TLS certificates inherited by allowlisted child processes. |
