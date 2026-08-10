import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const OPENAI_HOST = 'api.openai.com';
const OPENAI_RESPONSES_PATH = '/v1/responses';
const REQUIRED_MODEL = 'gpt-5.6-luna';
const REQUIRED_REASONING_EFFORT = 'max';
const MAX_CLIENTS = 1_024;
const CAPABILITY_PREFIX = 'orvex1';
const MAX_CAPABILITY_REQUESTS = 64;
const MAX_CAPABILITY_TTL_SECONDS = 1_800;

function failConfig(message) {
  throw new Error(`agentic egress configuration invalid: ${message}`);
}

function requiredString(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    failConfig(`${name} is required`);
  }
  return value;
}

function requiredInteger(env, name, minimum, maximum) {
  const raw = requiredString(env, name);
  if (!/^[0-9]+$/.test(raw)) failConfig(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    failConfig(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function readBoundedSecret(file, label, minimum = 8) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    failConfig(`${label} is unreadable`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < minimum || stat.size > 1_024) {
    failConfig(`${label} is not a bounded regular file`);
  }
  const key = fs.readFileSync(file, 'utf8').trim();
  if (key.length < minimum || /[\r\n\0]/.test(key)) failConfig(`${label} has an invalid value`);
  return key;
}

function loadConfig(env = process.env) {
  const listenPort = requiredInteger(env, 'EGRESS_LISTEN_PORT', 1, 65_535);
  const allowedHost = requiredString(env, 'EGRESS_ALLOWED_HOST');
  if (!/^[a-z0-9-]+$/.test(allowedHost)) failConfig('EGRESS_ALLOWED_HOST is invalid');
  return Object.freeze({
    apiKey: readBoundedSecret(requiredString(env, 'OPENAI_API_KEY_FILE'), 'OPENAI_API_KEY_FILE'),
    signingKey: readBoundedSecret(
      requiredString(env, 'EGRESS_SIGNING_KEY_FILE'),
      'EGRESS_SIGNING_KEY_FILE',
      32,
    ),
    listenPort,
    allowedHost,
    maxContentBytes: requiredInteger(env, 'EGRESS_MAX_CONTENT_BYTES', 1_024, 4 * 1024 * 1024),
    maxOutputTokens: requiredInteger(env, 'EGRESS_MAX_OUTPUT_TOKENS', 1, 128_000),
    maxConcurrent: requiredInteger(env, 'EGRESS_MAX_CONCURRENT', 1, 64),
    maxRequestsPerWindow: requiredInteger(env, 'EGRESS_MAX_REQUESTS_PER_WINDOW', 1, 1_000),
    rateWindowMs: requiredInteger(env, 'EGRESS_RATE_WINDOW_MS', 1_000, 3_600_000),
    bodyReadTimeoutMs: requiredInteger(env, 'EGRESS_BODY_READ_TIMEOUT_MS', 1_000, 300_000),
    upstreamTimeoutMs: requiredInteger(env, 'EGRESS_UPSTREAM_TIMEOUT_MS', 1_000, 900_000),
    maxResponseBytes: requiredInteger(env, 'EGRESS_MAX_RESPONSE_BYTES', 1_024, 64 * 1024 * 1024),
  });
}

function writeJson(response, statusCode, value) {
  if (response.headersSent || response.writableEnded) return;
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function createCapabilityToken(signingKey, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const unsigned = `${CAPABILITY_PREFIX}.${body}`;
  const signature = createHmac('sha256', signingKey).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

function verifyCapabilityToken(token, signingKey, clock = Date) {
  if (typeof token !== 'string' || token.length > 2_048) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== CAPABILITY_PREFIX) return null;
  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = createHmac('sha256', signingKey).update(unsigned).digest();
  let supplied;
  try {
    supplied = Buffer.from(parts[2], 'base64url');
  } catch {
    return null;
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const now = Math.floor(clock.now() / 1_000);
  if (
    !payload ||
    typeof payload !== 'object' ||
    !/^[a-zA-Z0-9-]{16,128}$/.test(payload.jti ?? '') ||
    !Number.isSafeInteger(payload.exp) ||
    payload.exp <= now ||
    payload.exp > now + MAX_CAPABILITY_TTL_SECONDS ||
    !Number.isSafeInteger(payload.maxRequests) ||
    payload.maxRequests < 1 ||
    payload.maxRequests > MAX_CAPABILITY_REQUESTS
  ) {
    return null;
  }
  return payload;
}

function bearerToken(request) {
  const value = request.headers.authorization;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return null;
  const token = value.slice('Bearer '.length);
  return token && token.trim() === token ? token : null;
}

function createCapabilityUsage(clock = Date) {
  const clients = new Map();
  return {
    consume(capability) {
      const now = clock.now();
      const expiresAt = capability.exp * 1_000;
      const current = clients.get(capability.jti);
      if (!current && clients.size >= MAX_CLIENTS) {
        for (const [jti, entry] of clients) if (entry.expiresAt <= now) clients.delete(jti);
        if (clients.size >= MAX_CLIENTS) return false;
      }
      const count = current?.expiresAt > now ? current.count : 0;
      if (count >= capability.maxRequests) return false;
      clients.set(capability.jti, { count: count + 1, expiresAt });
      return true;
    },
  };
}

function hostMatches(request, allowedHost) {
  const host = request.headers.host;
  return host === allowedHost || host === `${allowedHost}:8080`;
}

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function safeStatus(code) {
  return Number.isInteger(code) && code >= 100 && code <= 599 ? code : 502;
}

function readRequestBody(request, maximum, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('error', onError);
      request.removeListener('aborted', onAborted);
      clearTimeout(timeout);
      fn(value);
    };
    const onData = (chunk) => {
      total += chunk.length;
      if (total > maximum) {
        finish(reject, new Error('request_too_large'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(resolve, Buffer.concat(chunks, total));
    const onError = () => finish(reject, new Error('request_read_error'));
    const onAborted = () => finish(reject, new Error('request_aborted'));
    const onTimeout = () => {
      finish(reject, new Error('request_body_timeout'));
    };
    const timeout = setTimeout(onTimeout, timeoutMs);
    timeout.unref?.();
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
  });
}

function rejectRequest(request, response, status, payload) {
  response.setHeader('connection', 'close');
  response.once('finish', () => {
    request.socket.end();
    const forceClose = setTimeout(() => request.destroy(), 1_000);
    forceClose.unref?.();
  });
  writeJson(response, status, payload);
}

function prepareResponsesRequest(body, config) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { error: 'invalid_json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return { error: 'invalid_json' };
  if (parsed.model !== REQUIRED_MODEL) return { error: 'model_not_allowed' };
  if (parsed.reasoning?.effort !== REQUIRED_REASONING_EFFORT)
    return { error: 'reasoning_effort_not_allowed' };
  if (parsed.max_output_tokens === undefined) {
    // Codex may omit this optional Responses API field. Add the operator-owned
    // ceiling so the request stays bounded without rejecting a valid CLI call.
    parsed.max_output_tokens = config.maxOutputTokens;
  } else if (
    !Number.isInteger(parsed.max_output_tokens) ||
    parsed.max_output_tokens < 1 ||
    parsed.max_output_tokens > config.maxOutputTokens
  ) {
    return { error: 'output_token_limit' };
  }
  const upstreamBody = Buffer.from(JSON.stringify(parsed));
  if (upstreamBody.length > config.maxContentBytes) return { error: 'request_too_large' };
  return { body: upstreamBody };
}

function validateResponsesRequest(body, config) {
  return prepareResponsesRequest(body, config).error ?? null;
}

function createRateLimiter(config, clock = Date) {
  const clients = new Map();
  return {
    allow(id) {
      const now = clock.now();
      const current = clients.get(id);
      if (!current || current.resetAt <= now) {
        if (!current && clients.size >= MAX_CLIENTS) {
          for (const [knownClient, entry] of clients) {
            if (entry.resetAt <= now) clients.delete(knownClient);
          }
          if (clients.size >= MAX_CLIENTS) return false;
        }
        clients.set(id, { count: 1, resetAt: now + config.rateWindowMs });
        return true;
      }
      if (current.count >= config.maxRequestsPerWindow) return false;
      current.count += 1;
      return true;
    },
  };
}

function proxyResponses({ request, response, body, config, upstreamRequest, complete }) {
  const accept =
    typeof request.headers.accept === 'string' &&
    request.headers.accept.includes('text/event-stream')
      ? 'text/event-stream'
      : 'application/json';
  let upstream;
  let timeout;
  let responseBytes = 0;
  let done = false;
  const finish = (result) => {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    complete(result);
  };
  const abortUpstream = () => {
    if (upstream && !upstream.destroyed) upstream.destroy();
  };
  request.once('aborted', () => {
    abortUpstream();
    finish({ status: 499, responseBytes, outcome: 'client_cancelled' });
  });
  response.once('close', () => {
    if (!response.writableEnded) {
      abortUpstream();
      finish({ status: 499, responseBytes, outcome: 'client_cancelled' });
    }
  });
  try {
    upstream = upstreamRequest(
      {
        protocol: 'https:',
        hostname: OPENAI_HOST,
        port: 443,
        method: 'POST',
        path: OPENAI_RESPONSES_PATH,
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
          accept,
          'content-length': String(body.length),
          'user-agent': 'orvex-agentic-egress/1',
        },
      },
      (upstreamResponse) => {
        const statusCode = safeStatus(upstreamResponse.statusCode);
        const headers = {
          'content-type':
            typeof upstreamResponse.headers['content-type'] === 'string'
              ? upstreamResponse.headers['content-type']
              : 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        };
        const requestId = upstreamResponse.headers['x-request-id'];
        if (typeof requestId === 'string' && requestId.length <= 200)
          headers['x-request-id'] = requestId;
        response.writeHead(statusCode, headers);
        upstreamResponse.on('data', (chunk) => {
          responseBytes += chunk.length;
          if (responseBytes > config.maxResponseBytes) {
            abortUpstream();
            if (!response.writableEnded) response.destroy(new Error('upstream_response_too_large'));
            finish({ status: 502, responseBytes, outcome: 'response_too_large' });
            return;
          }
          if (!response.write(chunk)) upstreamResponse.pause();
        });
        response.on('drain', () => upstreamResponse.resume());
        upstreamResponse.once('end', () => {
          if (!response.writableEnded) response.end();
          finish({ status: statusCode, responseBytes, outcome: 'upstream_complete' });
        });
        upstreamResponse.once('error', () => {
          if (!response.writableEnded) response.destroy();
          finish({ status: 502, responseBytes, outcome: 'upstream_stream_error' });
        });
      },
    );
    upstream.once('error', () => {
      if (!response.headersSent) writeJson(response, 502, { error: 'upstream_unavailable' });
      else if (!response.writableEnded) response.destroy();
      finish({ status: 502, responseBytes, outcome: 'upstream_unavailable' });
    });
    timeout = setTimeout(() => {
      abortUpstream();
      if (!response.headersSent) writeJson(response, 504, { error: 'upstream_timeout' });
      else if (!response.writableEnded) response.destroy();
      finish({ status: 504, responseBytes, outcome: 'upstream_timeout' });
    }, config.upstreamTimeoutMs);
    upstream.end(body);
  } catch {
    if (!response.headersSent) writeJson(response, 502, { error: 'upstream_unavailable' });
    finish({ status: 502, responseBytes, outcome: 'upstream_setup_error' });
  }
}

function createBrokerServer(config, dependencies = {}) {
  const upstreamRequest = dependencies.upstreamRequest ?? https.request;
  const clock = dependencies.clock ?? Date;
  const limiter = createRateLimiter(config, clock);
  const capabilityUsage = createCapabilityUsage(clock);
  let active = 0;

  const server = http.createServer(async (request, response) => {
    const startedAt = clock.now();
    const requestId = randomUUID();
    let client = 'unauthenticated';
    let capacityHeld = false;
    let completed = false;
    const complete = ({ status, responseBytes = 0, outcome }) => {
      if (completed) return;
      completed = true;
      if (capacityHeld) {
        capacityHeld = false;
        active = Math.max(0, active - 1);
      }
      log({
        event: 'openai_responses_proxy',
        requestId,
        client,
        status,
        outcome,
        requestBytes: Number(request.headers['content-length']) || 0,
        responseBytes,
        durationMs: Math.max(0, clock.now() - startedAt),
      });
    };
    if (request.method === 'GET' && request.url === '/healthz') {
      response.writeHead(204, { 'cache-control': 'no-store' });
      response.end();
      return;
    }
    if (
      !hostMatches(request, config.allowedHost) ||
      request.method !== 'POST' ||
      request.url !== OPENAI_RESPONSES_PATH
    ) {
      rejectRequest(request, response, 404, { error: 'not_found' });
      return;
    }
    const capability = verifyCapabilityToken(bearerToken(request), config.signingKey, clock);
    if (!capability) {
      rejectRequest(request, response, 401, { error: 'invalid_capability' });
      return;
    }
    client = capability.jti;
    const declaredLength = Number(request.headers['content-length']);
    if (
      !Number.isFinite(declaredLength) ||
      declaredLength < 1 ||
      declaredLength > config.maxContentBytes
    ) {
      rejectRequest(request, response, 413, { error: 'request_too_large' });
      return;
    }
    // Apply all authenticated admission controls before reading a body so a
    // trickle upload cannot bypass request, rate, or concurrency bounds.
    if (!capabilityUsage.consume(capability)) {
      rejectRequest(request, response, 429, { error: 'capability_exhausted' });
      return;
    }
    if (!limiter.allow(client)) {
      rejectRequest(request, response, 429, { error: 'rate_limited' });
      return;
    }
    if (active >= config.maxConcurrent) {
      rejectRequest(request, response, 429, { error: 'concurrency_limited' });
      return;
    }
    active += 1;
    capacityHeld = true;
    let body;
    try {
      body = await readRequestBody(request, config.maxContentBytes, config.bodyReadTimeoutMs);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'request_read_error';
      const status =
        reason === 'request_too_large' ? 413 : reason === 'request_body_timeout' ? 408 : 400;
      rejectRequest(request, response, status, {
        error: reason === 'request_body_timeout' ? reason : 'invalid_request',
      });
      complete({ status, outcome: reason });
      return;
    }
    const prepared = prepareResponsesRequest(body, config);
    if (prepared.error) {
      const status = prepared.error === 'request_too_large' ? 413 : 400;
      rejectRequest(request, response, status, {
        error: prepared.error,
      });
      complete({ status, outcome: prepared.error });
      return;
    }
    proxyResponses({ request, response, body: prepared.body, config, upstreamRequest, complete });
  });
  server.maxConnections = Math.max(16, config.maxConcurrent * 4);
  server.requestTimeout = config.bodyReadTimeoutMs;
  server.headersTimeout = Math.min(15_000, config.bodyReadTimeoutMs);
  server.keepAliveTimeout = 5_000;
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const config = loadConfig();
  const server = createBrokerServer(config);
  server.listen(config.listenPort, '0.0.0.0');
}

export {
  OPENAI_HOST,
  OPENAI_RESPONSES_PATH,
  REQUIRED_MODEL,
  REQUIRED_REASONING_EFFORT,
  createCapabilityToken,
  createBrokerServer,
  loadConfig,
  prepareResponsesRequest,
  validateResponsesRequest,
  verifyCapabilityToken,
};
