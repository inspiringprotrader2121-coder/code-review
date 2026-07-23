import Anthropic from '@anthropic-ai/sdk';

export interface LlmClientOptions {
  apiKey: string;
  model: string;
  /** Provider base URL. Omit only for Anthropic's default endpoint. */
  baseUrl?: string;
  maxTokens?: number;
  /** ask the provider for a JSON object response where supported */
  json?: boolean;
  /** force-disable reasoning for this call (default: reasoning ON) */
  thinking?: boolean;
  /**
   * Which OpenAI-family API shape to use. 'responses' = the /v1/responses
   * endpoint (required by gpt-5.x / codex reasoning models — different request +
   * streaming shape). Default (undefined) = /chat/completions (MiniMax, etc.).
   */
  api?: 'chat' | 'responses' | 'anthropic';
  /** reasoning effort for /v1/responses models (e.g. 'low'|'medium'|'high'|'xhigh'). */
  reasoningEffort?: string;
  /** internal: suppress provider-level failover (multi-key rotation tries sibling keys first) */
  disableFailover?: boolean;
  /**
   * Called once per completed call with token usage, for cost tracking. Anthropic
   * reports exact usage; the OpenAI-compatible/streaming path estimates from
   * character counts (~4 chars/token) since it doesn't request a usage object.
   */
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
}

/** Rough chars→tokens estimate (~4 chars/token) for providers that don't return
 *  a usage object on the streaming path. Approximate but good enough for cost
 *  visibility / spend alerting. */
export function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars / 4));
}

/** Hard ceiling on any single LLM call so a hung provider can't wedge a job. */
const LLM_TIMEOUT_MS = Number(process.env.ORVEX_LLM_TIMEOUT_MS ?? 240_000);

/** Total time allowed for one provider attempt, including active streaming. */
function maxTotalMs(): number {
  const configured = Number(process.env.ORVEX_LLM_MAX_TOTAL_MS ?? 300_000);
  return Number.isFinite(configured) ? Math.min(Math.max(configured, 30_000), 900_000) : 300_000;
}

/** Reasoning models think before answering — slower, materially more accurate. */
function thinkingEnabled(opts: LlmClientOptions): boolean {
  if (opts.thinking !== undefined) return opts.thinking;
  return process.env.ORVEX_LLM_THINKING !== '0';
}

/**
 * One chat call, either provider:
 * - `baseUrl` set → OpenAI-compatible `/chat/completions` (MiniMax, etc.)
 * - otherwise → Anthropic SDK
 */

/**
 * True for a provider rate-limit / quota-exhaustion error specifically —
 * deliberately narrower than `isTransientLlmError` (packages/review/src/llm.ts),
 * which also matches generic network blips (timeouts, ECONNRESET, "fetch
 * failed"). That distinction is intentional: a transient network hiccup on the
 * PRIMARY provider is usually worth retrying on the SAME provider, not grounds
 * to switch providers entirely — but an actual quota/rate-limit signal means
 * the primary is genuinely unavailable, which IS grounds to fail over.
 * Exported so it's independently unit-tested rather than a silent duplicate.
 */
export function isRateLimitOrQuotaError(message: string): boolean {
  return /\b429\b|\b402\b[^\n]*(?:credit|quota|payment)|rate.?limit|usage limit|quota|token plan|insufficient|more credits?/i.test(message);
}

/**
 * A 128k default made OpenAI-compatible gateways reserve far more output credit
 * than a review can realistically use, causing otherwise-funded requests to be
 * rejected before generation. Historical xhigh reviews peak around 40k output
 * tokens including reasoning, so 64k preserves headroom without the false
 * "insufficient credits" failures.
 *
 * A HARD CAP backstops this: gateways (OpenRouter etc.) RESERVE the full
 * max_tokens as credit up front, so an oversized value — e.g. a mis-set
 * `ORVEX_MAX_OUTPUT_TOKENS=200000` in the live env — makes every reasoning call
 * fail with `402 insufficient credits` ("requested 128000, can only afford
 * 71299"), which then silently degrades to no-reasoning and thin reviews. That
 * exact misconfig took production down for a week, so the ceiling is enforced
 * in code, not just documented. Raise it deliberately via
 * ORVEX_MAX_OUTPUT_TOKENS_CAP when a provider genuinely needs more.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

export function resolveMaxOutputTokens(explicit?: number): number {
  const configured = explicit ?? Number(process.env.ORVEX_MAX_OUTPUT_TOKENS ?? DEFAULT_MAX_OUTPUT_TOKENS);
  const valid =
    Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_MAX_OUTPUT_TOKENS;
  const capRaw = Number(process.env.ORVEX_MAX_OUTPUT_TOKENS_CAP ?? DEFAULT_MAX_OUTPUT_TOKENS);
  const cap = Number.isFinite(capRaw) && capRaw > 0 ? Math.floor(capRaw) : DEFAULT_MAX_OUTPUT_TOKENS;
  if (valid > cap) {
    console.warn(
      `[llm] max_output_tokens ${valid} exceeds safe cap ${cap} — clamping. ` +
        `Oversized reservations trigger 402 "insufficient credits" and silently ` +
        `disable reasoning. Raise ORVEX_MAX_OUTPUT_TOKENS_CAP to lift the ceiling deliberately.`,
    );
  }
  return Math.min(valid, cap);
}

/**
 * Multi-key load balancing: `apiKey` may hold MULTIPLE comma-separated keys
 * (e.g. ORVEX_STANDARD_API_KEY=key1,key2,key3). Calls round-robin across the
 * keys, and a key that hits a rate-limit/quota error fails over to the next
 * key BEFORE falling back to a different provider. One key = exactly the old
 * behavior.
 */
let keyCursor = 0;
function splitKeys(apiKey: string): string[] {
  return apiKey
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

/** Parse a provider's "try again in N" hint into milliseconds. OpenAI embeds it
 * in the 429 body ("Please try again in 49.174s" / "in 120ms"); Anthropic and
 * others use "retry-after". Returns undefined when no explicit delay is given. */
export function parseRetryAfterMs(message: string): number | undefined {
  const ms = /try again in\s*([\d.]+)\s*ms\b/i.exec(message);
  if (ms) return Math.ceil(parseFloat(ms[1]));
  // "retry-after: 30" / "retry after 12 seconds" — the HTTP header value is bare
  // seconds, so the unit suffix is optional here.
  const ra = /retry[-\s]?after[:\s]+([\d.]+)\s*(?:s(?:ec(?:onds?)?)?)?\b/i.exec(message);
  if (ra) return Math.ceil(parseFloat(ra[1]) * 1000);
  const sec = /try again in\s*([\d.]+)\s*s(?:ec(?:onds?)?)?\b/i.exec(message);
  if (sec) return Math.ceil(parseFloat(sec[1]) * 1000);
  return undefined;
}

/** A rate limit that RECOVERS by waiting — a per-minute TPM/RPM 429, a 529
 * "overloaded", a "try again in Ns". Deliberately DISTINCT from a hard
 * credit/quota exhaustion (402 "insufficient credits"), which waiting will not
 * fix: that must fail fast so the job requeues instead of looping pointlessly. */
export function isRetryableRateLimit(message: string): boolean {
  if (/\b402\b/.test(message) && /credit|insufficient|afford|top-?up/i.test(message)) return false;
  return /\b429\b|\b529\b|rate.?limit|tokens? per min|requests? per min|\bTPM\b|\bRPM\b|try again in|overloaded|please try again/i.test(
    message,
  );
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Public entry point. Wraps the multi-key + provider-failover logic below in a
 * WAIT-AND-RETRY loop: a recoverable rate limit HOLDS the call and retries
 * (honoring the provider's advertised retry-after) instead of failing the pass
 * and discarding the whole review — the "queue it, don't cancel it" behavior.
 * Provider-agnostic: every model (OpenAI/Luna, DeepSeek, MiniMax, Anthropic)
 * funnels through here, so all get it for free. Ordinary errors and hard quota
 * exhaustion propagate immediately (no wasted waiting).
 */
export async function llmChat(system: string, user: string, opts: LlmClientOptions): Promise<string> {
  const maxAttempts = Math.max(1, Math.floor(Number(process.env.ORVEX_RATELIMIT_MAX_RETRIES ?? 4)));
  const maxWaitMs = Math.max(1_000, Number(process.env.ORVEX_RATELIMIT_MAX_WAIT_MS ?? 60_000));
  const baseMs = Math.max(250, Number(process.env.ORVEX_RATELIMIT_BASE_MS ?? 2_000));
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await llmChatWithFailover(system, user, opts);
    } catch (err) {
      lastErr = err as Error;
      if (attempt === maxAttempts - 1 || !isRetryableRateLimit(lastErr.message)) throw lastErr;
      // Honor the provider's advertised retry-after; otherwise exponential
      // backoff. Always add jitter so concurrent passes don't retry in lockstep,
      // and never exceed the per-wait cap.
      const advertised = parseRetryAfterMs(lastErr.message);
      const backoff = Math.min(baseMs * 2 ** attempt, maxWaitMs);
      const jitter = Math.floor(Math.random() * 1_000);
      const waitMs = Math.min((advertised ?? backoff) + jitter, maxWaitMs);
      console.warn(
        `[llm] rate-limited — holding ${Math.round(waitMs / 1000)}s then retrying ` +
          `(attempt ${attempt + 1}/${maxAttempts}): ${lastErr.message.slice(0, 140)}`,
      );
      await sleep(waitMs);
    }
  }
  throw lastErr!;
}

async function llmChatWithFailover(system: string, user: string, opts: LlmClientOptions): Promise<string> {
  const keys = splitKeys(opts.apiKey);
  if (keys.length > 1) {
    const start = keyCursor++;
    let lastErr: Error | undefined;
    for (let i = 0; i < keys.length; i++) {
      const idx = (start + i) % keys.length;
      try {
        // Suppress the provider-level fallback until the LAST key — sibling keys
        // on the same provider are always the preferred failover.
        return await llmChatSingle(system, user, {
          ...opts,
          apiKey: keys[idx],
          disableFailover: i < keys.length - 1 ? true : opts.disableFailover,
        });
      } catch (err) {
        lastErr = err as Error;
        if (!isRateLimitOrQuotaError(lastErr.message)) throw err;
        console.warn(`[llm] api key ${idx + 1}/${keys.length} rate-limited/quota — rotating to next key`);
      }
    }
    throw lastErr;
  }
  return llmChatSingle(system, user, opts);
}

async function llmChatSingle(system: string, user: string, opts: LlmClientOptions): Promise<string> {
  if (opts.api === 'anthropic') {
    return anthropicChat(system, user, opts);
  }
  if (opts.api === 'responses') {
    try {
      return await openAiResponsesStreamChat(system, user, opts);
    } catch (err) {
      // P2-1: codex /v1/responses must fail over on rate-limit/quota just like
      // the chat/completions path, so a single provider outage never halts reviews.
      if (!opts.disableFailover && isRateLimitOrQuotaError((err as Error).message)) {
        const fbUrl = process.env.ORVEX_FALLBACK_BASE_URL;
        const fbKey = process.env.ORVEX_FALLBACK_API_KEY;
        // Only use the URL fallback when a DISTINCT fallback key is configured —
        // never transmit the primary provider's key as a Bearer to a different host.
        if (fbUrl && fbKey) {
          console.warn('[llm] responses primary unavailable (rate-limit/quota) — failing over to fallback endpoint');
          return await openAiCompatStreamChat(system, user, {
            ...opts,
            api: undefined,
            baseUrl: fbUrl,
            apiKey: fbKey,
            model: process.env.ORVEX_FALLBACK_MODEL ?? opts.model,
          });
        }
        const anthropicKey = process.env.ANTHROPIC_API_KEY;
        if (anthropicKey) {
          console.warn('[llm] responses primary unavailable (rate-limit/quota) — failing over to Anthropic');
          return await anthropicChat(system, user, {
            ...opts,
            apiKey: anthropicKey,
            baseUrl: undefined,
            api: undefined,
            model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514',
          });
        }
      }
      throw err;
    }
  }
  if (opts.baseUrl) {
    try {
      return await openAiCompatStreamChat(system, user, opts);
    } catch (err) {
      // Automatic provider failover: if the primary provider (e.g. MiniMax) is
      // rate-limited or out of quota, retry on a configured fallback so a
      // quota-out never halts reviews. Tries a generic OpenAI-compatible fallback
      // endpoint first (any provider, or a local model), then Anthropic. No-op
      // when neither is configured — single-provider behavior is unchanged.
      if (!opts.disableFailover && isRateLimitOrQuotaError((err as Error).message)) {
        const fbUrl = process.env.ORVEX_FALLBACK_BASE_URL;
        const fbKey = process.env.ORVEX_FALLBACK_API_KEY;
        // Only use the URL fallback when a DISTINCT fallback key is configured —
        // never transmit the primary provider's key as a Bearer to a different host.
        if (fbUrl && fbKey) {
          console.warn('[llm] primary unavailable (rate-limit/quota) — failing over to fallback endpoint');
          return await openAiCompatStreamChat(system, user, {
            ...opts,
            baseUrl: fbUrl,
            apiKey: fbKey,
            model: process.env.ORVEX_FALLBACK_MODEL ?? opts.model,
          });
        }
        const anthropicKey = process.env.ANTHROPIC_API_KEY;
        if (anthropicKey) {
          console.warn('[llm] primary unavailable (rate-limit/quota) — failing over to Anthropic');
          return await anthropicChat(system, user, {
            ...opts,
            apiKey: anthropicKey,
            baseUrl: undefined,
            model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514',
          });
        }
      }
      throw err;
    }
  }
  return anthropicChat(system, user, opts);
}

async function anthropicChat(system: string, user: string, opts: LlmClientOptions): Promise<string> {
  const hardLimitMs = maxTotalMs();
  const client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseUrl, timeout: hardLimitMs });
  // Match the MiniMax branch: stream (so multi-minute reasoning calls keep the
  // socket alive instead of dying as "fetch failed"), think by default, and use
  // a high output ceiling so reasoning + findings with fix blocks never truncate.
  const maxTokens = resolveMaxOutputTokens(opts.maxTokens);
  // Extended thinking is incompatible with an assistant prefill and needs real
  // output headroom — only enable it when there's room to think.
  const think = thinkingEnabled(opts) && maxTokens >= 16_000;
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: user }];
  const prefill = opts.json && !think;
  if (prefill) messages.push({ role: 'assistant', content: '{' });
  const thinkingBudget = Math.min(
    Number(process.env.ORVEX_ANTHROPIC_THINKING_BUDGET_TOKENS ?? (opts.model.startsWith('MiniMax-') ? 20_000 : 32_000)),
    maxTokens - 8_000,
  );
  const stream = client.messages.stream({
    model: opts.model,
    max_tokens: maxTokens,
    system,
    messages,
    ...(think
      ? { thinking: { type: 'enabled' as const, budget_tokens: thinkingBudget } }
      : {}),
  });
  const startedAt = Date.now();
  let hitHardLimit = false;
  const hardTimer = setTimeout(() => {
    hitHardLimit = true;
    stream.abort();
  }, hardLimitMs);
  let response: Awaited<ReturnType<typeof stream.finalMessage>>;
  try {
    response = await stream.finalMessage();
  } catch (err) {
    if (hitHardLimit) throw new Error(`LLM anthropic call exceeded ${hardLimitMs}ms wall-clock cap`);
    throw err;
  } finally {
    clearTimeout(hardTimer);
  }
  if (response.usage) {
    opts.onUsage?.({ inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens });
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('LLM response truncated (stop_reason=max_tokens); increase max tokens');
  }
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('LLM returned no text content');
  }
  const reasoningChars = response.content.reduce(
    (total, block) => total + (block.type === 'thinking' ? block.thinking.length : 0),
    0,
  );
  const text = prefill ? `{${textBlock.text}` : textBlock.text;
  console.log(
    `[llm] model=${opts.model} api=anthropic thinking=${think ? 'on' : 'off'} ` +
      `reasoning=${reasoningChars}c answer=${text.length}c ${Math.round((Date.now() - startedAt) / 1000)}s`,
  );
  return text;
}

/**
 * OpenAI /v1/responses streaming — required by gpt-5.x / codex reasoning models.
 * Different shape from chat/completions: `instructions` (system) + `input`
 * (user), `reasoning.effort`, `max_output_tokens`, and SSE events keyed by a
 * `type` field (we accumulate `response.output_text.delta`). Reasoning content
 * is hidden by OpenAI — we only see the answer + a reasoning-token count. These
 * models can go SILENT for minutes while thinking at high effort, so the
 * inactivity timeout is deliberately generous (a silent think is not a stall).
 */
async function openAiResponsesStreamChat(system: string, user: string, opts: LlmClientOptions): Promise<string> {
  const base = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const timeoutMs = Number(process.env.ORVEX_RESPONSES_TIMEOUT_MS ?? 900_000); // 15m inactivity backstop
  // Hard wall-clock cap: the inactivity timer never fires on a call that streams
  // continuously (a 490s over-thinking pass keeps resetting it), so a single call
  // could hang a review indefinitely. This bounds total call time regardless.
  const hardLimitMs = maxTotalMs();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const armTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), timeoutMs);
  };
  armTimer();

  const maxOut = resolveMaxOutputTokens(opts.maxTokens);
  const effort = opts.reasoningEffort ?? process.env.ORVEX_OPENAI_REASONING_EFFORT ?? 'high';

  let response: Response;
  try {
    response = await fetch(`${base}/responses`, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        model: opts.model,
        instructions: system,
        input: user,
        ...(thinkingEnabled(opts) ? { reasoning: { effort } } : {}),
        max_output_tokens: maxOut,
        stream: true,
        ...(opts.json ? { text: { format: { type: 'json_object' } } } : {}),
      }),
    });
  } catch (err) {
    clearTimeout(timer!);
    if ((err as Error).name === 'AbortError') throw new Error(`LLM responses request stalled (no data for ${timeoutMs}ms)`);
    throw err;
  }

  if (!response.ok || !response.body) {
    clearTimeout(timer!);
    const errorBody = response.ok ? 'no response body' : await response.text().catch(() => '');
    throw new Error(`LLM responses request failed (${response.status}): ${errorBody.slice(0, 500)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const startedAt = Date.now();
  let buffer = '';
  let content = '';
  let reasoningTokens = 0;
  let inTok = 0;
  let outTok = 0;
  let failed: string | undefined;
  let incomplete: string | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armTimer(); // any byte (delta, progress event, keepalive) counts as progress
      if (Date.now() - startedAt > hardLimitMs) {
        try { await reader.cancel(); } catch { /* best-effort */ }
        throw new Error(`LLM responses call exceeded ${hardLimitMs}ms wall-clock cap`);
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '' || data === '[DONE]') continue;
        try {
          const evt = JSON.parse(data) as {
            type?: string;
            delta?: string;
            response?: {
              status?: string;
              incomplete_details?: { reason?: string };
              error?: { message?: string };
              usage?: { input_tokens?: number; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } };
            };
            message?: string;
          };
          if (evt.type === 'response.output_text.delta' && typeof evt.delta === 'string') {
            content += evt.delta;
          } else if (evt.type === 'response.completed' || evt.type === 'response.incomplete') {
            const u = evt.response?.usage;
            if (u) {
              inTok = u.input_tokens ?? 0;
              outTok = u.output_tokens ?? 0;
              reasoningTokens = u.output_tokens_details?.reasoning_tokens ?? 0;
            }
            if (evt.type === 'response.incomplete') incomplete = evt.response?.incomplete_details?.reason ?? 'incomplete';
          } else if (evt.type === 'response.failed' || evt.type === 'error') {
            failed = evt.response?.error?.message ?? evt.message ?? 'response failed';
          }
        } catch {
          // partial/keepalive line — ignore, more will arrive
        }
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new Error(`LLM responses stream stalled (no data for ${timeoutMs}ms)`);
    throw err;
  } finally {
    clearTimeout(timer!);
  }

  if (failed) throw new Error(`LLM responses stream failed: ${failed}`);
  // P1-4: truncation must be treated as a failure, not returned as success.
  // `response.incomplete` with non-empty content is the /v1/responses shape for
  // hitting max_output_tokens; mirror the chat path's `finish_reason==='length'`
  // and the Anthropic `stop_reason==='max_tokens'` guards.
  if (incomplete) {
    throw new Error(`LLM responses truncated (${incomplete}); increase ORVEX_MAX_OUTPUT_TOKENS`);
  }
  console.log(
    `[llm] model=${opts.model} api=responses effort=${effort} reasoning=${reasoningTokens}tok ` +
      `answer=${content.length}c ${Math.round((Date.now() - startedAt) / 1000)}s`,
  );
  opts.onUsage?.({
    inputTokens: inTok || estimateTokens(system.length + user.length),
    outputTokens: outTok || estimateTokens(content.length),
  });
  // A max_output_tokens cutoff mid-reasoning yields an empty answer — surface it
  // as a retryable error rather than silently returning nothing.
  if (!content) throw new Error('LLM responses returned no text');
  return content;
}

/**
 * Streaming call to an OpenAI-compatible endpoint (MiniMax, etc.).
 *
 * Deep reasoning over a full-repo prompt can run for many minutes; a plain
 * non-streaming POST gets its connection dropped ("fetch failed") long before
 * the answer is ready. Streaming keeps the socket alive with a steady trickle
 * of tokens. The timeout is an INACTIVITY timer (reset on every chunk), so a
 * long-but-progressing reason never aborts — only a truly stalled socket does.
 *
 * `max_completion_tokens` includes reasoning and answer tokens. The shared 64k
 * default leaves substantial reasoning headroom without making gateways reserve
 * an uneconomical 128k allowance up front. Override with
 * ORVEX_MAX_OUTPUT_TOKENS when a provider genuinely needs a different ceiling.
 */
async function openAiCompatStreamChat(
  system: string,
  user: string,
  opts: LlmClientOptions,
): Promise<string> {
  const controller = new AbortController();
  const hardLimitMs = maxTotalMs();
  let timer: ReturnType<typeof setTimeout>;
  const armTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  };
  armTimer();

  // Reasoning shares this budget with the answer.
  const maxOut = resolveMaxOutputTokens(opts.maxTokens);

  let response: Response;
  try {
    response = await fetch(`${opts.baseUrl!.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: opts.model,
        max_completion_tokens: maxOut,
        stream: true,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        // OpenAI-style reasoning effort on the CHAT path — used by DeepSeek v4
        // ('low'..'max', verified live against api.deepseek.com) and OpenAI
        // models via OpenRouter. Only sent when the target sets it, so
        // MiniMax/GLM requests are unchanged. On the no-thinking RETRY (after
        // an empty answer) drop to a REDUCED effort: gpt-5.6-luna-pro at xhigh
        // reasoned 499s into the output budget and produced 0 answer chars —
        // resending the identical effort made the "retry without reasoning" a
        // no-op. 'medium' (the provider default) keeps real depth while
        // breaking the exhaustion pattern; override via ORVEX_RETRY_EFFORT.
        ...(opts.reasoningEffort
          ? {
              reasoning_effort: thinkingEnabled(opts)
                ? opts.reasoningEffort
                : (process.env.ORVEX_RETRY_EFFORT ?? 'medium'),
            }
          : {}),
        // MiniMax-M3 reasoning is controlled via chat_template_kwargs.thinking_mode
        // ('enabled' | 'adaptive' | 'disabled'). Default 'enabled' FORCES deep
        // reasoning on every call — 'adaptive' let the model decide and it
        // under-thought simpler-looking PRs (shorter runs, fewer findings).
        // Override via ORVEX_THINKING_MODE. (The top-level `thinking.type` param
        // is a different, narrower control that rejects 'enabled' — don't use it.)
        chat_template_kwargs: {
          thinking_mode: thinkingEnabled(opts) ? (process.env.ORVEX_THINKING_MODE ?? 'enabled') : 'disabled',
        },
        // Return reasoning in a dedicated reasoning_content stream (not inline
        // <think> tags), so the answer parses cleanly and we can measure it.
        reasoning_split: true,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
  } catch (err) {
    clearTimeout(timer!);
    if ((err as Error).name === 'AbortError') {
      throw new Error(`LLM request stalled (no data for ${LLM_TIMEOUT_MS}ms)`);
    }
    throw err;
  }

  if (!response.ok || !response.body) {
    clearTimeout(timer!);
    const errorBody = response.ok ? 'no response body' : await response.text().catch(() => '');
    throw new Error(`LLM request failed (${response.status}): ${errorBody.slice(0, 500)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const startedAt = Date.now();
  let buffer = '';
  let content = '';
  let reasoningChars = 0; // separated <think> stream (reasoning_split / M-series)
  let finishReason: string | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armTimer(); // progress — reset the inactivity timer
      if (Date.now() - startedAt > hardLimitMs) {
        try { await reader.cancel(); } catch { /* best-effort */ }
        throw new Error(`LLM chat call exceeded ${hardLimitMs}ms wall-clock cap`);
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '' || data === '[DONE]') continue;
        try {
          const chunk = JSON.parse(data) as {
            choices?: Array<{
              finish_reason?: string | null;
              native_finish_reason?: string | null;
              delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null };
            }>;
          };
          const choice = chunk.choices?.[0];
          if (choice?.delta?.content) content += choice.delta.content;
          if (choice?.delta?.reasoning_content) reasoningChars += choice.delta.reasoning_content.length;
          // OpenRouter normalizes reasoning into `delta.reasoning` (verified
          // live vs gpt-5.6-luna-pro) — without this, an OpenRouter model's
          // reasoning is invisible (logged 0c while it reasoned for minutes).
          if (choice?.delta?.reasoning) reasoningChars += choice.delta.reasoning.length;
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          // OpenRouter's mapped finish_reason can say 'stop' while the
          // provider's native reason is 'length' — prefer the native one so
          // budget exhaustion is diagnosable and triggers the retry path.
          if (choice?.native_finish_reason && choice.native_finish_reason !== 'completed') {
            finishReason = choice.native_finish_reason;
          }
        } catch {
          // partial/keepalive line — ignore, more will arrive
        }
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`LLM stream stalled (no data for ${LLM_TIMEOUT_MS}ms)`);
    }
    throw err;
  } finally {
    clearTimeout(timer!);
  }

  // Reasoning arrives either as a separate reasoning_content stream OR inline as
  // <think>…</think> in content. Sum both so the log reflects how much the model
  // actually reasoned — this is the ground truth behind "is it deeply thinking?".
  const inlineThinkChars = (content.match(/<think>[\s\S]*?<\/think>/gi) ?? []).reduce((n, b) => n + b.length, 0);
  const totalReasoning = reasoningChars + inlineThinkChars;
  const answerChars = stripThinking(content).length;
  console.log(
    `[llm] model=${opts.model} thinking=${thinkingEnabled(opts) ? 'on' : 'off'} ` +
      `reasoning=${totalReasoning}c answer=${answerChars}c ${Math.round((Date.now() - startedAt) / 1000)}s finish=${finishReason ?? 'stop'}`,
  );
  opts.onUsage?.({
    inputTokens: estimateTokens(system.length + user.length),
    outputTokens: estimateTokens(totalReasoning + answerChars),
  });

  const text = stripThinking(content);
  if (!text) throw new Error('LLM returned no text content');
  if (finishReason === 'length') {
    throw new Error('LLM response truncated (finish_reason=length); increase max tokens');
  }
  return text;
}

export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s.trim());
  } catch {
    return undefined;
  }
}

/**
 * Pull a JSON payload out of a model reply. Models wrap the object in prose, in
 * a ```json fence, or — for reviews of shell/nginx code — sometimes emit an
 * unrelated ```bash block FIRST (which naive `/```(?:json)?/` extraction would
 * grab and then crash JSON.parse on). Try, in order: an explicit json fence,
 * any fenced block that parses to an object, the outermost {...} span, then the
 * bare text. Throws only when nothing parses, so callers can retry or degrade.
 */
export function extractJsonLoose(text: string): unknown {
  const stripped = stripThinking(text);

  const jsonFence = stripped.match(/```json\s*([\s\S]*?)```/i);
  if (jsonFence) {
    const parsed = tryParse(jsonFence[1]);
    if (parsed !== undefined) return parsed;
  }

  for (const m of stripped.matchAll(/```[a-z]*\s*([\s\S]*?)```/gi)) {
    const parsed = tryParse(m[1]);
    if (parsed && typeof parsed === 'object') return parsed;
  }

  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const parsed = tryParse(stripped.slice(start, end + 1));
    if (parsed !== undefined) return parsed;
  }

  const bare = tryParse(stripped);
  if (bare !== undefined) return bare;

  throw new Error('LLM response contained no parseable JSON');
}
