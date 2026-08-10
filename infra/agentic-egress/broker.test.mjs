import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import {
  createBrokerServer,
  createCapabilityToken,
  loadConfig,
  verifyCapabilityToken,
} from './broker.mjs';

const SIGNING_KEY = 'test-signing-key-that-is-long-enough-for-hmac';
let tokenSequence = 0;

function capability(overrides = {}) {
  tokenSequence += 1;
  return createCapabilityToken(SIGNING_KEY, {
    jti: `test-capability-${String(tokenSequence).padStart(4, '0')}`,
    exp: Math.floor(Date.now() / 1_000) + 300,
    maxRequests: 64,
    ...overrides,
  });
}

function config(overrides = {}) {
  return {
    apiKey: 'sk-test-not-a-real-key',
    signingKey: SIGNING_KEY,
    listenPort: 0,
    allowedHost: 'orvex-openai-egress',
    maxContentBytes: 16_384,
    maxOutputTokens: 8_192,
    maxConcurrent: 1,
    maxRequestsPerWindow: 2,
    rateWindowMs: 60_000,
    bodyReadTimeoutMs: 100,
    upstreamTimeoutMs: 500,
    maxResponseBytes: 32_768,
    ...overrides,
  };
}

function body(overrides = {}) {
  return JSON.stringify({
    model: 'gpt-5.6-luna',
    reasoning: { effort: 'max' },
    max_output_tokens: 4_096,
    stream: true,
    input: 'test',
    ...overrides,
  });
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function request(port, options = {}) {
  const requestBody = options.body ?? body();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: options.path ?? '/v1/responses',
        method: options.method ?? 'POST',
        headers: {
          host: options.host ?? 'orvex-openai-egress:8080',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(requestBody),
          authorization: `Bearer ${options.token ?? capability()}`,
          ...(options.headers ?? {}),
        },
      },
      async (response) => {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      },
    );
    req.once('error', reject);
    req.end(requestBody);
  });
}

function slowRequest(port, { token = capability(), requestBody = body() } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/v1/responses',
        method: 'POST',
        headers: {
          host: 'orvex-openai-egress:8080',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(requestBody),
          authorization: `Bearer ${token}`,
        },
      },
      async (response) => {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        settle(resolve, {
          status: response.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        req.destroy();
      },
    );
    req.once('error', (error) => settle(reject, error));
    req.write(requestBody.slice(0, Math.max(1, Math.floor(requestBody.length / 2))));
  });
}

function fakeUpstream({
  chunks = ['data: one\n\n', 'data: [DONE]\n\n'],
  delayMs = 0,
  onOptions,
  onBody,
} = {}) {
  return (options, callback) => {
    onOptions?.(options);
    const upstream = new EventEmitter();
    upstream.destroyed = false;
    upstream.end = (requestBody) => {
      onBody?.(requestBody);
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-type': 'text/event-stream', 'x-request-id': 'req_test' };
      response.pause = () => {};
      response.resume = () => {};
      callback(response);
      for (const chunk of chunks)
        setTimeout(() => response.emit('data', Buffer.from(chunk)), delayMs);
      setTimeout(() => response.emit('end'), delayMs + chunks.length + 2);
    };
    upstream.destroy = () => {
      upstream.destroyed = true;
    };
    return upstream;
  };
}

test('proxies only a bounded Luna max-reasoning Responses request and strips inbound auth', async (t) => {
  let captured;
  const server = createBrokerServer(config(), {
    upstreamRequest: fakeUpstream({
      onOptions: (value) => {
        captured = value;
      },
    }),
  });
  t.after(() => server.close());
  const result = await request(await listen(server), {
    headers: { accept: 'text/event-stream' },
  });
  assert.equal(result.status, 200);
  assert.match(result.body, /data: one/);
  assert.equal(captured.hostname, 'api.openai.com');
  assert.equal(captured.path, '/v1/responses');
  assert.equal(captured.headers.authorization, 'Bearer sk-test-not-a-real-key');
  assert.equal(captured.headers.accept, 'text/event-stream');
  assert.equal(captured.headers['x-forwarded-for'], undefined);
});

test('adds the configured output ceiling when Codex omits the optional field', async (t) => {
  let capturedBody;
  const server = createBrokerServer(config(), {
    upstreamRequest: fakeUpstream({
      onBody: (value) => {
        capturedBody = JSON.parse(value.toString('utf8'));
      },
    }),
  });
  t.after(() => server.close());
  const requestBody = JSON.parse(body());
  delete requestBody.max_output_tokens;
  const result = await request(await listen(server), { body: JSON.stringify(requestBody) });
  assert.equal(result.status, 200);
  assert.equal(capturedBody.max_output_tokens, 8_192);
  assert.equal(capturedBody.reasoning.effort, 'max');
});

test('fails closed before listening when a required broker configuration item is missing', () => {
  assert.throws(
    () => loadConfig({ EGRESS_LISTEN_PORT: '8080' }),
    /agentic egress configuration invalid/,
  );
});

test('health reveals no configuration and invalid host, path, method, model, effort, and token request fail closed', async (t) => {
  let calls = 0;
  const server = createBrokerServer(config({ maxRequestsPerWindow: 20 }), {
    upstreamRequest: (...args) => {
      calls += 1;
      return fakeUpstream()(...args);
    },
  });
  t.after(() => server.close());
  const port = await listen(server);
  const health = await request(port, { method: 'GET', path: '/healthz', body: '' });
  assert.equal(health.status, 204);
  assert.equal(health.body, '');
  for (const input of [
    { host: 'attacker.test' },
    { path: '/v1/models' },
    { method: 'GET' },
    { body: body({ model: 'gpt-5.6-luna-other' }) },
    { body: body({ reasoning: { effort: 'high' } }) },
    { body: body({ max_output_tokens: 8_193 }) },
  ]) {
    const result = await request(port, input);
    assert.ok(result.status === 400 || result.status === 404);
  }
  assert.equal(calls, 0);
  const unauthorized = await request(port, { headers: { authorization: 'Bearer invalid' } });
  assert.equal(unauthorized.status, 401);
});

test('bounds concurrent work and per-client requests while preserving streaming chunks', async (t) => {
  let delayed;
  const upstreamRequest = (options, callback) => {
    const upstream = new EventEmitter();
    upstream.destroyed = false;
    upstream.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-type': 'text/event-stream' };
      response.pause = () => {};
      response.resume = () => {};
      callback(response);
      delayed = () => {
        response.emit('data', Buffer.from('data: one\n\n'));
        response.emit('data', Buffer.from('data: two\n\n'));
        response.emit('end');
      };
    };
    upstream.destroy = () => {
      upstream.destroyed = true;
    };
    return upstream;
  };
  const server = createBrokerServer(config({ maxRequestsPerWindow: 3 }), { upstreamRequest });
  t.after(() => server.close());
  const port = await listen(server);
  const sharedToken = capability({ maxRequests: 8 });
  const first = request(port, { token: sharedToken });
  while (!delayed) await new Promise((resolve) => setImmediate(resolve));
  const concurrent = await request(port, { token: sharedToken });
  assert.equal(concurrent.status, 429);
  delayed();
  const complete = await first;
  assert.equal(complete.status, 200);
  assert.match(complete.body, /data: one/);
  delayed = undefined;
  const second = request(port, { token: sharedToken });
  while (!delayed) await new Promise((resolve) => setImmediate(resolve));
  delayed();
  assert.equal((await second).status, 200);
  const limited = await request(port, { token: sharedToken });
  assert.equal(limited.status, 429);
});

test('admits authenticated requests before body reads, times out trickle bodies, and releases capacity', async (t) => {
  let calls = 0;
  const server = createBrokerServer(config({ bodyReadTimeoutMs: 30, maxRequestsPerWindow: 8 }), {
    upstreamRequest: (...args) => {
      calls += 1;
      return fakeUpstream()(...args);
    },
  });
  t.after(() => server.close());
  const port = await listen(server);
  const slow = slowRequest(port);
  await new Promise((resolve) => setImmediate(resolve));

  const rejected = await request(port);
  assert.equal(rejected.status, 429);
  assert.match(rejected.body, /concurrency_limited/);

  const timedOut = await slow;
  assert.equal(timedOut.status, 408);
  assert.match(timedOut.body, /request_body_timeout/);
  assert.equal(calls, 0);

  const accepted = await request(port);
  assert.equal(accepted.status, 200);
  assert.equal(calls, 1);
});

test('releases pre-body capacity when body validation rejects a request', async (t) => {
  const server = createBrokerServer(config({ maxRequestsPerWindow: 8 }), {
    upstreamRequest: fakeUpstream(),
  });
  t.after(() => server.close());
  const port = await listen(server);
  const rejected = await request(port, { body: '{' });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body, /invalid_json/);
  assert.equal((await request(port)).status, 200);
});

test('cuts off an oversized upstream response and destroys the fake upstream', async (t) => {
  let upstream;
  const upstreamRequest = (_options, callback) => {
    upstream = new EventEmitter();
    upstream.destroyed = false;
    upstream.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-type': 'text/event-stream' };
      response.pause = () => {};
      response.resume = () => {};
      callback(response);
      response.emit('data', Buffer.alloc(32, 65));
    };
    upstream.destroy = () => {
      upstream.destroyed = true;
    };
    return upstream;
  };
  const server = createBrokerServer(config({ maxResponseBytes: 16 }), { upstreamRequest });
  t.after(() => server.close());
  await assert.rejects(request(await listen(server)));
  assert.equal(upstream.destroyed, true);
});

test('terminates a stalled fake upstream at the configured duration cap', async (t) => {
  let upstream;
  const upstreamRequest = (_options, _callback) => {
    upstream = new EventEmitter();
    upstream.destroyed = false;
    upstream.end = () => {};
    upstream.destroy = () => {
      upstream.destroyed = true;
    };
    return upstream;
  };
  const server = createBrokerServer(config({ upstreamTimeoutMs: 10 }), { upstreamRequest });
  t.after(() => server.close());
  const response = await request(await listen(server));
  assert.equal(response.status, 504);
  assert.equal(upstream.destroyed, true);
});

test('cancelling a downstream request destroys the upstream request and releases the slot', async (t) => {
  let upstream;
  let started;
  let calls = 0;
  const upstreamRequest = (options, callback) => {
    calls += 1;
    if (calls > 1) return fakeUpstream()(options, callback);
    upstream = new EventEmitter();
    upstream.destroyed = false;
    upstream.end = () => {
      started();
    };
    upstream.destroy = () => {
      upstream.destroyed = true;
    };
    return upstream;
  };
  const server = createBrokerServer(config(), { upstreamRequest });
  t.after(() => server.close());
  const port = await listen(server);
  const upstreamStarted = new Promise((resolve) => {
    started = resolve;
  });
  const client = http.request({
    hostname: '127.0.0.1',
    port,
    path: '/v1/responses',
    method: 'POST',
    headers: {
      host: 'orvex-openai-egress:8080',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body()),
      authorization: `Bearer ${capability()}`,
    },
  });
  client.on('error', () => {});
  client.end(body());
  await upstreamStarted;
  client.destroy();
  for (let attempt = 0; attempt < 20 && !upstream.destroyed; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(upstream.destroyed, true);
  assert.equal((await request(port)).status, 200);
});

test('capabilities are signed, expiring, isolated, and request bounded', async (t) => {
  const now = Date.now();
  const clock = { now: () => now };
  const valid = createCapabilityToken(SIGNING_KEY, {
    jti: 'bounded-capability-0001',
    exp: Math.floor(now / 1_000) + 60,
    maxRequests: 1,
  });
  assert.equal(verifyCapabilityToken(valid, SIGNING_KEY, clock)?.maxRequests, 1);
  assert.equal(verifyCapabilityToken(`${valid}x`, SIGNING_KEY, clock), null);
  const expired = createCapabilityToken(SIGNING_KEY, {
    jti: 'expired-capability-0001',
    exp: Math.floor(now / 1_000) - 1,
    maxRequests: 1,
  });
  assert.equal(verifyCapabilityToken(expired, SIGNING_KEY, clock), null);

  const server = createBrokerServer(config({ maxRequestsPerWindow: 20 }), {
    clock,
    upstreamRequest: fakeUpstream(),
  });
  t.after(() => server.close());
  const port = await listen(server);
  assert.equal((await request(port, { token: valid })).status, 200);
  const exhausted = await request(port, { token: valid });
  assert.equal(exhausted.status, 429);
  assert.match(exhausted.body, /capability_exhausted/);
  assert.equal((await request(port, { token: expired })).status, 401);
});
