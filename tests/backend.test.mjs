// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from '../server.mjs';
import { normalizeBaseUrl, normalizeUsage, validateChat, buildChatPayload, parseSSE } from '../lib/api.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

async function requestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

async function fixture(t, handler, options) {
  const upstream = http.createServer(handler);
  const baseUrl = await listen(upstream);
  const server = createServer(options);
  const url = await listen(server);
  t.after(async () => { await close(server); await close(upstream); });
  return { baseUrl, url };
}

function post(url, endpoint, body, options = {}) {
  return fetch(`${url}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...options });
}

function getWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Host: host } }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
  });
}

function chatBody(baseUrl, extras = {}) {
  return { baseUrl, apiKey: 'test-secret', model: 'test-model', effort: 'high', protocol: 'chat', messages: [{ role: 'user', content: 'Hello' }], ...extras };
}

async function events(response) {
  const output = [];
  for await (const record of parseSSE(response.body)) output.push(JSON.parse(record.data));
  return output;
}

test('base URLs preserve custom roots, strip endpoint suffixes, and restrict insecure hosts', () => {
  assert.equal(normalizeBaseUrl('https://api.openai.com/'), 'https://api.openai.com/v1');
  assert.equal(normalizeBaseUrl('https://example.com/custom/v2/chat/completions'), 'https://example.com/custom/v2');
  assert.equal(normalizeBaseUrl('https://example.com/custom/v2/images/generations'), 'https://example.com/custom/v2');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8317/v1/images/edits/'), 'http://127.0.0.1:8317/v1');
  assert.equal(normalizeBaseUrl('http://localhost:11434/v1/models/'), 'http://localhost:11434/v1');
  assert.equal(normalizeBaseUrl('https://example.com'), 'https://example.com');
  for (const value of ['http://example.com/v1', 'file:///tmp/test', 'https://user:password@example.com', 'https://example.com?key=x', 'not a URL']) assert.throws(() => normalizeBaseUrl(value));
});

test('protocol selection and reasoning effort map to the selected API without retrying', () => {
  const responses = validateChat(chatBody('https://api.openai.com', { protocol: 'auto', systemPrompt: 'Be concise' }));
  assert.equal(responses.protocol, 'responses');
  assert.deepEqual(buildChatPayload(responses), { model: 'test-model', input: [{ role: 'user', content: 'Hello' }], instructions: 'Be concise', reasoning: { effort: 'high' }, stream: true, store: false });
  const chat = validateChat(chatBody('https://example.com/custom', { protocol: 'auto', effort: 'auto', systemPrompt: 'Be concise' }));
  assert.equal(chat.protocol, 'chat');
  assert.deepEqual(buildChatPayload(chat).messages[0], { role: 'system', content: 'Be concise' });
  assert.equal('reasoning_effort' in buildChatPayload(chat), false);
  assert.throws(() => validateChat(chatBody('https://example.com', { effort: 'invalid' })));
  assert.throws(() => validateChat(chatBody('https://example.com', { messages: [{ role: 'system', content: 'Hello' }] })));
});

test('provider usage accepts only actual non-negative integer counts and never invents missing output counts', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: 3 }), { inputTokens: 10, outputTokens: 3, totalTokens: 13 });
  assert.deepEqual(normalizeUsage({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  assert.deepEqual(normalizeUsage({ input_tokens: 10, total_tokens: 25 }), { inputTokens: 10, totalTokens: 25 });
  assert.deepEqual(normalizeUsage({ input_tokens: 10 }), { inputTokens: 10 });
  assert.deepEqual(normalizeUsage({ input_tokens: 10, output_tokens: 3, total_tokens: -1 }), { inputTokens: 10, outputTokens: 3 });
  for (const invalid of [undefined, null, [], {}, { input_tokens: -1, output_tokens: '3' }, { input_tokens: Infinity, output_tokens: NaN, total_tokens: 1.5 }, { total_tokens: Number.MAX_SAFE_INTEGER + 1 }]) assert.equal(normalizeUsage(invalid), null);
  assert.deepEqual(normalizeUsage({ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }), { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 });
});

test('models endpoint sends bearer auth and returns unique sorted model IDs', async t => {
  let seen;
  const { url, baseUrl } = await fixture(t, (req, res) => {
    seen = { path: req.url, auth: req.headers.authorization };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'zeta' }, { id: 'alpha' }, { id: 'alpha' }, {}, { id: 7 }] }));
  });
  const response = await post(url, '/api/models', { baseUrl: `${baseUrl}/v1/models`, apiKey: 'test-secret' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { models: ['alpha', 'zeta'] });
  assert.deepEqual(seen, { path: '/v1/models', auth: 'Bearer test-secret' });
});

test('Chat Completions handles byte-split multibyte SSE, reasoning, usage, and a trailing event', async t => {
  let seen;
  const { url, baseUrl } = await fixture(t, async (req, res) => {
    seen = { path: req.url, auth: req.headers.authorization, body: await requestBody(req) };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const stream = Buffer.from(': comment\r\ndata: {"choices":[{"delta":{"reasoning_content":"Think"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"你好 🌍"}}]}\r\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\r\n\r\ndata: [DONE]');
    // Every byte is a separate upstream write, including UTF-8 and CRLF boundaries.
    for (let i = 0; i < stream.length; i++) res.write(stream.subarray(i, i + 1));
    res.end();
  });
  const output = await events(await post(url, '/api/chat', chatBody(baseUrl, { systemPrompt: 'Be helpful' })));
  assert.deepEqual(output, [{ type: 'meta', protocol: 'chat', model: 'test-model' }, { type: 'reasoning', text: 'Think' }, { type: 'delta', text: '你好 🌍' }, { type: 'usage', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } }, { type: 'done' }]);
  assert.equal(seen.path, '/chat/completions');
  assert.equal(seen.auth, 'Bearer test-secret');
  assert.equal(seen.body.reasoning_effort, 'high');
  assert.deepEqual(seen.body.messages[0], { role: 'system', content: 'Be helpful' });
});

test('Responses streams normalize deltas, refusal, summary, and completion usage', async t => {
  let payload;
  const { url, baseUrl } = await fixture(t, async (req, res) => {
    assert.equal(req.url, '/responses');
    payload = await requestBody(req);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const event of [
      { type: 'response.reasoning_summary_text.delta', delta: 'Summary' },
      { type: 'response.output_text.delta', delta: 'Hello' },
      { type: 'response.refusal.delta', delta: ' refusal' },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 } } },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  const output = await events(await post(url, '/api/chat', chatBody(baseUrl, { protocol: 'responses', effort: 'none', systemPrompt: 'Be concise' })));
  assert.deepEqual(output.map(event => event.type), ['meta', 'reasoning', 'delta', 'delta', 'usage', 'done']);
  assert.deepEqual(output.at(-2).usage, { inputTokens: 5, outputTokens: 6, totalTokens: 11 });
  assert.deepEqual(payload.reasoning, { effort: 'none' });
  assert.equal(payload.instructions, 'Be concise');
  assert.equal(payload.store, false);
});

test('providers returning nonstream JSON work with either protocol', async t => {
  const { url, baseUrl } = await fixture(t, async (req, res) => {
    await requestBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/responses'
      ? { status: 'completed', output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Summary' }] }, { type: 'message', content: [{ type: 'output_text', text: 'Response answer' }] }], usage: { input_tokens: 2, output_tokens: 3 } }
      : { choices: [{ message: { content: 'Chat answer', reasoning_content: 'Reasoning' } }], usage: { prompt_tokens: 2, completion_tokens: 3 } }));
  });
  for (const protocol of ['chat', 'responses']) {
    const output = await events(await post(url, '/api/chat', chatBody(baseUrl, { protocol })));
    assert.equal(output.find(event => event.type === 'delta').text, protocol === 'chat' ? 'Chat answer' : 'Response answer');
    assert.deepEqual(output.find(event => event.type === 'usage').usage, { inputTokens: 2, outputTokens: 3, totalTokens: 5 });
    assert.equal(output.at(-1).type, 'done');
  }
});

test('provider errors redact keys, and failed or interrupted streams do not report done', async t => {
  let calls = 0;
  const { url, baseUrl } = await fixture(t, async (req, res) => {
    const body = await requestBody(req);
    calls++;
    if (body.model === 'bad-auth') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid key test-secret' } }));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const event = body.model === 'failed' ? { type: 'response.failed', response: { error: { message: 'Failure test-secret' } } } : { type: 'response.output_text.delta', delta: 'Partial' };
      res.end(`data: ${JSON.stringify(event)}\n\n`);
    }
  });
  const badAuth = await post(url, '/api/chat', chatBody(baseUrl, { model: 'bad-auth' }));
  assert.equal(badAuth.status, 401);
  assert.deepEqual(await badAuth.json(), { error: 'Invalid key [redacted]' });
  for (const model of ['failed', 'interrupted']) {
    const output = await events(await post(url, '/api/chat', chatBody(baseUrl, { protocol: 'responses', model })));
    assert.equal(output.at(-1).type, 'error');
    assert.equal(output.some(event => event.type === 'done'), false);
    assert.equal(JSON.stringify(output).includes('test-secret'), false);
  }
  assert.equal(calls, 3, 'No automatic retry should create a second provider request');
});

test('failed and incomplete plain Responses retain real usage before a terminal error', async t => {
  const usage = { input_tokens: 11, output_tokens: 7, total_tokens: 18 };
  const { url, baseUrl } = await fixture(t, async (req, res) => {
    const body = await requestBody(req);
    const status = body.model.startsWith('failed') ? 'failed' : 'incomplete';
    const response = { status, usage, ...(status === 'failed' ? { error: { message: 'Failure test-secret' } } : { incomplete_details: { reason: 'max_output_tokens' } }) };
    if (body.model.endsWith('json')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ type: `response.${status}`, response })}\n\n`);
    }
  });
  for (const model of ['failed-json', 'failed-stream', 'incomplete-json', 'incomplete-stream']) {
    const output = await events(await post(url, '/api/chat', chatBody(baseUrl, { protocol: 'responses', model })));
    assert.deepEqual(output.find(event => event.type === 'usage')?.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 }, model);
    assert.equal(output.filter(event => event.type === 'usage').length, 1, model);
    assert.equal(output.at(-1).type, 'error', model);
    assert.equal(output.some(event => event.type === 'done'), false, model);
    assert.equal(JSON.stringify(output).includes('test-secret'), false, model);
  }
});

test('failed final image outputs retain actual usage without marking the image complete', async t => {
  const usage = { input_tokens: 21, output_tokens: 8, total_tokens: 29 };
  const { url, baseUrl } = await fixture(t, async (req, res) => {
    const body = await requestBody(req);
    const invalidImage = body.model.includes('invalid');
    if (body.model.endsWith('json')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ usage, ...(invalidImage ? { data: [{ b64_json: '%%%%' }] } : { error: { message: 'Image failure test-secret' } }) }));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ usage, ...(invalidImage ? { type: 'image_generation.completed', b64_json: '%%%%', output_format: 'png' } : { type: 'error', error: { message: 'Image failure test-secret' } }) })}\n\n`);
    }
  });
  for (const model of ['gpt-image-1-invalid-json', 'gpt-image-1-invalid-stream', 'gpt-image-1-error-json', 'gpt-image-1-error-stream']) {
    const output = await events(await post(url, '/api/chat', chatBody(baseUrl, { model })));
    assert.deepEqual(output.find(event => event.type === 'usage')?.usage, { inputTokens: 21, outputTokens: 8, totalTokens: 29 }, model);
    assert.equal(output.filter(event => event.type === 'usage').length, 1, model);
    assert.equal(output.at(-1).type, 'error', model);
    assert.equal(output.some(event => event.type === 'done' || event.type === 'image'), false, model);
    assert.equal(JSON.stringify(output).includes('test-secret'), false, model);
  }
});

test('disconnecting the browser cancels the active upstream request', async t => {
  let disconnected;
  const upstreamClosed = new Promise(resolve => { disconnected = resolve; });
  const { url, baseUrl } = await fixture(t, async (req, res) => {
    await requestBody(req);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
    const interval = setInterval(() => res.write(': heartbeat\n\n'), 50);
    res.on('close', () => { clearInterval(interval); disconnected(); });
  });
  const controller = new AbortController();
  const response = await post(url, '/api/chat', chatBody(baseUrl), { signal: controller.signal });
  await response.body.getReader().read();
  controller.abort();
  await Promise.race([upstreamClosed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Upstream was not cancelled')), 2000); timer.unref(); })]);
});

test('empty replies and truncated or unsupported tool completions report clear errors', async t => {
  const { url, baseUrl } = await fixture(t, async (req, res) => {
    const body = await requestBody(req);
    if (body.model === 'empty') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    } else if (body.model === 'json-tool') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { tool_calls: [] }, finish_reason: 'tool_calls' }] }));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"Partial"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n');
    }
  });
  for (const [model, pattern] of [['empty', /no text reply/], ['json-tool', /tool call/], ['truncated', /truncated/]]) {
    const output = await events(await post(url, '/api/chat', chatBody(baseUrl, { model })));
    assert.equal(output.at(-1).type, 'error');
    assert.match(output.at(-1).message, pattern);
    assert.equal(output.some(event => event.type === 'done'), false);
  }
});

test('redirects are rejected so authorization is never forwarded to another endpoint', async t => {
  let redirectedCalls = 0;
  const destination = http.createServer((req, res) => { redirectedCalls++; res.end('{"data":[]}'); });
  const destinationUrl = await listen(destination);
  t.after(() => close(destination));
  const { url, baseUrl } = await fixture(t, (req, res) => { res.writeHead(302, { Location: `${destinationUrl}/models` }); res.end(); });
  const response = await post(url, '/api/models', { baseUrl, apiKey: 'test-secret' });
  assert.equal(response.status, 502);
  assert.equal(redirectedCalls, 0);
});

test('server protects loopback access, validates requests, and confines static files', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'apitool-public-'));
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><title>API tool</title>');
  await symlink(path.resolve('server.mjs'), path.join(directory, 'outside.js'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { url } = await fixture(t, (req, res) => res.end(), { publicDir: directory, maxBodyBytes: 200 });
  assert.equal((await fetch(`${url}/api/health`)).status, 200);
  assert.equal(await getWithHost(`${url}/api/health`, 'example.com'), 403);
  assert.equal((await fetch(`${url}/api/health`, { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(`${url}/api/models`)).status, 405);
  assert.equal((await fetch(`${url}/api/models`, { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await post(url, '/api/models', { baseUrl: 'http://example.com', apiKey: '' })).status, 400);
  assert.equal((await post(url, '/api/models', { baseUrl: 'x'.repeat(300) })).status, 413);
  assert.equal((await fetch(`${url}/outside.js`)).status, 404);
  assert.equal((await fetch(`${url}/server.mjs`)).status, 404);
  const index = await fetch(url);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy'), /connect-src 'self'/);
});

test('SSE parser handles CRLF split across chunks, multiline data, and EOF without a newline', async () => {
  const encoder = new TextEncoder();
  const chunks = ['event: custom\r', '\ndata: line 1\r\n', 'data: line 2\r\n\r', '\ndata: final'];
  const source = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } });
  const output = [];
  for await (const record of parseSSE(source)) output.push(record);
  assert.deepEqual(output, [{ event: 'custom', data: 'line 1\nline 2' }, { event: '', data: 'final' }]);
});

test('model discovery normalizes IDs to those accepted by Send', async t => {
  const boundaryId = 'x'.repeat(256);
  const { url, baseUrl } = await fixture(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: ' zeta ' }, { id: 'alpha' }, { id: 'alpha ' }, { id: 'bad\u0000id' }, { id: 'x'.repeat(257) }, { id: boundaryId }, { id: null }, {}] }));
  });
  const response = await post(url, '/api/models', { baseUrl, apiKey: '' });
  const { models } = await response.json();
  assert.deepEqual(models, ['alpha', boundaryId, 'zeta']);
  for (const model of models) assert.equal(validateChat(chatBody(baseUrl, { model })).model, model);
});

test('recognized alternate model-list shapes remain selectable', async t => {
  const shapes = [{ data: ['beta', ' alpha ', null] }, ['beta', { id: 'alpha' }], { models: [{ name: 'beta' }, { id: 'alpha' }] }];
  let index = 0;
  const { url, baseUrl } = await fixture(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(shapes[index++]));
  });
  for (const shape of shapes) {
    const response = await post(url, '/api/models', { baseUrl, apiKey: '' });
    assert.equal(response.status, 200, JSON.stringify(shape));
    assert.deepEqual(await response.json(), { models: ['alpha', 'beta'] });
  }
});

test('empty lists succeed while invalid-only lists and wrong shapes explain custom entry', async t => {
  const shapes = [{ data: [] }, { data: [{ id: null }, { id: 'x'.repeat(257) }] }, { data: 'invalid' }, null];
  let index = 0;
  const { url, baseUrl } = await fixture(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(shapes[index++]));
  });
  const empty = await post(url, '/api/models', { baseUrl, apiKey: '' });
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { models: [] });
  for (let i = 1; i < shapes.length; i++) {
    const response = await post(url, '/api/models', { baseUrl, apiKey: '' });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /model manually/);
  }
});

test('keyless loopback providers support model discovery and custom chat', async t => {
  const seen = [];
  const { url, baseUrl } = await fixture(t, async (req, res) => {
    seen.push({ path: req.url, auth: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.method === 'GET') res.end(JSON.stringify({ data: [{ id: 'local-model' }] }));
    else { await requestBody(req); res.end(JSON.stringify({ choices: [{ message: { content: 'Local answer' } }] })); }
  });
  const models = await post(url, '/api/models', { baseUrl, apiKey: '' });
  assert.deepEqual(await models.json(), { models: ['local-model'] });
  const output = await events(await post(url, '/api/chat', chatBody(baseUrl, { apiKey: '', model: 'local-model', effort: 'auto' })));
  assert.equal(output.find(event => event.type === 'delta').text, 'Local answer');
  assert.equal(output.at(-1).type, 'done');
  assert.deepEqual(seen, [{ path: '/models', auth: undefined }, { path: '/chat/completions', auth: undefined }]);
});

test('remote HTTP discovery returns an actionable HTTPS error', async t => {
  let providerCalls = 0;
  const { url } = await fixture(t, (req, res) => { providerCalls++; res.end(); });
  const response = await post(url, '/api/models', { baseUrl: 'http://example.com/v1', apiKey: 'dummy-key' });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Use HTTPS/);
  assert.equal(providerCalls, 0);
});

test('a missing models endpoint still allows sending a custom model', async t => {
  let deliveredModel;
  const { url, baseUrl } = await fixture(t, async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/custom/v2/models') { res.writeHead(404); res.end(JSON.stringify({ error: 'No model listing is available.' })); return; }
    assert.equal(req.url, '/custom/v2/chat/completions');
    deliveredModel = (await requestBody(req)).model;
    res.end(JSON.stringify({ choices: [{ message: { content: 'Custom model answer' } }] }));
  });
  const connection = { baseUrl: `${baseUrl}/custom/v2`, apiKey: 'dummy-key' };
  const models = await post(url, '/api/models', connection);
  assert.equal(models.status, 404);
  assert.equal((await models.json()).error, 'No model listing is available.');
  const output = await events(await post(url, '/api/chat', chatBody(connection.baseUrl, { model: 'custom-model-id' })));
  assert.equal(deliveredModel, 'custom-model-id');
  assert.equal(output.find(event => event.type === 'delta').text, 'Custom model answer');
});

test('malformed model discovery can recover on the next request', async t => {
  let calls = 0;
  const { url, baseUrl } = await fixture(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(++calls === 1 ? '{"data":[' : JSON.stringify({ data: [{ id: 'recovered-model' }] }));
  });
  const first = await post(url, '/api/models', { baseUrl, apiKey: 'dummy-key' });
  assert.equal(first.status, 502);
  assert.match((await first.json()).error, /valid JSON/);
  const retry = await post(url, '/api/models', { baseUrl, apiKey: 'dummy-key' });
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), { models: ['recovered-model'] });
  assert.equal(calls, 2, 'Only the user-triggered requests reach the provider');
});

test('simple string provider errors preserve the message and redact the key', async t => {
  const cases = [
    [401, { error: 'Rejected dummy-key' }],
    [403, { detail: 'Denied dummy-key' }],
    [429, 'Rate limited dummy-key'],
    [200, { error: 'Model list unavailable dummy-key' }],
  ];
  let index = 0;
  const { url, baseUrl } = await fixture(t, (req, res) => {
    const [status, body] = cases[index++];
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  for (const [status, body] of cases) {
    const response = await post(url, '/api/models', { baseUrl, apiKey: 'dummy-key' });
    assert.equal(response.status, status === 200 ? 502 : status);
    const source = typeof body === 'string' ? body : body.error || body.detail;
    assert.equal((await response.json()).error, source.replace('dummy-key', '[redacted]'));
  }
});

test('provider timeouts remain clear while connecting or reading model and chat bodies', async t => {
  for (const mode of ['model-headers', 'model-body', 'chat-json', 'chat-stream']) {
    await t.test(mode, async scenario => {
      const { url, baseUrl } = await fixture(scenario, async (req, res) => {
        if (req.method === 'POST') await requestBody(req);
        if (mode !== 'model-headers') {
          res.writeHead(200, { 'Content-Type': mode === 'chat-stream' ? 'text/event-stream' : 'application/json' });
          res.write(mode === 'chat-stream' ? 'data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n' : '{"data":[');
        }
        // Leave the response open until the local tool times it out.
      }, { requestTimeoutMs: 60 });
      if (mode.startsWith('model')) {
        const response = await post(url, '/api/models', { baseUrl, apiKey: 'dummy-key' });
        assert.equal(response.status, 504);
        assert.deepEqual(await response.json(), { error: 'The provider request timed out.' });
      } else {
        const output = await events(await post(url, '/api/chat', chatBody(baseUrl)));
        assert.equal(output.at(-1).type, 'error');
        assert.equal(output.at(-1).message, 'The provider request timed out.');
        assert.equal(output.some(event => event.type === 'done'), false);
      }
    });
  }
});

test('large usable model lists load while excessive counts and JSON bodies fail clearly', async t => {
  const models = Array.from({ length: 2002 }, (_, index) => ({ id: `model-${index}` }));
  const cases = [{ data: models }, { data: Array.from({ length: 10001 }, (_, index) => ({ id: `model-${index}` })) }, { data: [{ id: 'only-model' }], padding: 'x'.repeat(2 * 1024 * 1024) }];
  let index = 0;
  const { url, baseUrl } = await fixture(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cases[index++]));
  });
  const large = await post(url, '/api/models', { baseUrl, apiKey: '' });
  assert.equal(large.status, 200);
  assert.equal((await large.json()).models.length, 2002);
  for (let i = 1; i < cases.length; i++) {
    const response = await post(url, '/api/models', { baseUrl, apiKey: '' });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /too large|oversized/);
  }
});

test('Responses final-only output works without duplicating streamed text or usage', async t => {
  const { url, baseUrl } = await fixture(t, async (req, res) => {
    const body = await requestBody(req);
    res.writeHead(200, { 'Content-Type': 'Text/Event-Stream; charset=utf-8' });
    if (body.model === 'with-delta') res.write('data: {"type":"response.output_text.delta","delta":"Final answer"}\n\n');
    const final = { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Final answer' }] }], usage: { input_tokens: 2, output_tokens: 3 } } };
    res.end(`data: ${JSON.stringify(final)}\n\n`);
  });
  for (const model of ['final-only', 'with-delta']) {
    const output = await events(await post(url, '/api/chat', chatBody(baseUrl, { protocol: 'responses', model })));
    assert.deepEqual(output.filter(event => event.type === 'delta'), [{ type: 'delta', text: 'Final answer' }]);
    assert.equal(output.filter(event => event.type === 'usage').length, 1);
    assert.equal(output.at(-1).type, 'done');
  }
});

async function nextLiveRecord(iterator) {
  let timer;
  try { return await Promise.race([iterator.next(), new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Relay buffered an available upstream event until completion.')), 1000); })]); }
  finally { clearTimeout(timer); }
}

test('Relay forwards delayed Chat and Responses text before upstream completion with and without tools', async t => {
  for (const protocol of ['chat', 'responses']) for (const webSearch of [false, true]) await t.test(`${protocol}/${webSearch ? 'tools' : 'plain'}`, async t => {
    let release;
    let ended = false;
    const upstreamGate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const { url, baseUrl } = await fixture(t, async (req, res) => {
      const body = await requestBody(req);
      assert.equal(body.stream, true);
      assert.match(req.headers.accept, /^text\/event-stream/);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const first = protocol === 'chat' ? { choices: [{ delta: { content: 'First live chunk ' } }] } : { type: 'response.output_text.delta', item_id: 'msg_live', output_index: 0, content_index: 0, delta: 'First live chunk ' };
      res.write(`data: ${JSON.stringify(first)}\n\n`);
      await upstreamGate;
      const tail = protocol === 'chat' ? [{ choices: [{ delta: { content: 'and the second.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]
        : [{ type: 'response.output_text.delta', item_id: 'msg_live', output_index: 0, content_index: 0, delta: 'and the second.' }, { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', id: 'msg_live', content: [{ type: 'output_text', text: 'First live chunk and the second.' }] }] } }];
      tail.forEach(event => res.write(`data: ${JSON.stringify(event)}\n\n`));
      ended = true; res.end();
    });
    const response = await post(url, '/api/chat', chatBody(baseUrl, { protocol, webSearch }));
    const iterator = parseSSE(response.body);
    try {
      const meta = JSON.parse((await nextLiveRecord(iterator)).value.data);
      assert.equal(meta.type, 'meta');
      const first = JSON.parse((await nextLiveRecord(iterator)).value.data);
      assert.deepEqual(first, { type: 'delta', text: 'First live chunk ' });
      assert.equal(ended, false, 'First client delta must arrive while upstream is still waiting.');
      release();
      const output = [first];
      for await (const record of iterator) output.push(JSON.parse(record.data));
      assert.equal(output.filter(event => event.type === 'delta').map(event => event.text).join(''), 'First live chunk and the second.');
      assert.equal(output.filter(event => event.type === 'done').length, 1);
    } finally { release(); await iterator.return(); }
  });
});

test('Responses finalized parts reach the client before completed and later snapshots retain all parts exactly once', async t => {
  for (const webSearch of [false, true]) await t.test(webSearch ? 'tools' : 'plain', async t => {
    let release;
    const upstreamGate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const { url, baseUrl } = await fixture(t, async (req, res) => {
      await requestBody(req);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.done', item_id: 'msg', output_index: 1, content_index: 0, text: 'Early finalized part. ' })}\n\n`);
      await upstreamGate;
      const message = { type: 'message', id: 'msg', content: [{ type: 'output_text', text: 'Early finalized part. ' }, { type: 'refusal', refusal: 'A later refusal part.' }] };
      res.write(`data: ${JSON.stringify({ type: 'response.refusal.done', item_id: 'msg', output_index: 1, content_index: 1, refusal: 'A later refusal part.' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 1, item: message })}\n\n`);
      res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'reasoning', summary: [] }, message] } })}\n\n`);
    });
    const iterator = parseSSE((await post(url, '/api/chat', chatBody(baseUrl, { protocol: 'responses', webSearch }))).body);
    try {
      assert.equal(JSON.parse((await nextLiveRecord(iterator)).value.data).type, 'meta');
      const first = JSON.parse((await nextLiveRecord(iterator)).value.data);
      assert.deepEqual(first, { type: 'delta', text: 'Early finalized part. ' });
      release();
      const output = [first];
      for await (const record of iterator) output.push(JSON.parse(record.data));
      assert.deepEqual(output.filter(event => event.type === 'delta').map(event => event.text), ['Early finalized part. ', 'A later refusal part.']);
      assert.equal(output.at(-1).type, 'done');
    } finally { release(); await iterator.return(); }
  });
});

test('SSE per-event character budget rejects complete and multiline oversized records, keeps default, and accepts bounded image overrides', async () => {
  async function parse(contents, options) {
    const events = [];
    for await (const event of parseSSE(new Response(contents).body, options)) events.push(event);
    return events;
  }
  assert.equal((await parse(`data: ${'x'.repeat(64)}\n\n`, { maxEventCharacters: 64 }))[0].data.length, 64);
  for (const contents of [`data: ${'x'.repeat(65)}\n\n`, `data: ${'x'.repeat(65)}`, `data: ${'x'.repeat(32)}\ndata: ${'x'.repeat(32)}\n\n`]) await assert.rejects(parse(contents, { maxEventCharacters: 64 }), /oversized stream event/);
  assert.equal((await parse(Array.from({ length: 3 }, () => `data: ${'x'.repeat(64)}\n\n`).join(''), { maxEventCharacters: 64 })).length, 3);
  const large = `data: ${'x'.repeat(2_000_001)}\n\n`;
  await assert.rejects(parse(large), /oversized stream event/);
  assert.equal((await parse(large, { maxEventCharacters: 12 * 1024 * 1024 }))[0].data.length, 2_000_001);
  for (const limit of [0, -1, 1.5, NaN, '100', 32 * 1024 * 1024 + 1]) await assert.rejects(parse('data: ok\n\n', { maxEventCharacters: limit }), /size limit/);
});
