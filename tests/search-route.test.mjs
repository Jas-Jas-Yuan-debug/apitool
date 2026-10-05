// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createServer } from '../server.mjs';
import { ApiError, parseSSE } from '../lib/api.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

async function fixture(t, search, options = {}) {
  const server = createServer({ ...options, search });
  const url = await listen(server);
  t.after(() => close(server));
  return { url, server };
}

function result(query) {
  return { query, engine: 'Bing', sources: [{ title: 'Example source', url: 'https://example.com/article', snippet: 'A short search excerpt.' }] };
}

function post(url, body, options = {}) {
  return fetch(`${url}/api/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...options });
}

function rawRequest(url, { method = 'POST', headers = {}, chunks = [] } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${url}/api/search`, { method, headers }, response => {
      const body = [];
      response.on('data', chunk => body.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(body).toString() }));
    });
    request.on('error', reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

test('search route forwards only the explicit query and cancellation signal, without provider credentials or files', async t => {
  const seen = [];
  const { url } = await fixture(t, async (...arguments_) => { seen.push(arguments_); return result(arguments_[0]); });
  const response = await post(url, {
    query: 'A user-entered search', apiKey: 'never-forward-this-key', baseUrl: 'https://provider.example/v1',
    messages: [{ role: 'user', content: 'private previous chat' }], attachments: [{ data: 'private file bytes' }],
    model: 'my-model', effort: 'high',
  }, { headers: { 'Content-Type': 'application/json', Origin: url, Authorization: 'Bearer another-secret' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), result('A user-entered search'));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, 2);
  assert.equal(seen[0][0], 'A user-entered search');
  assert.deepEqual(Object.keys(seen[0][1]), ['signal']);
  assert.ok(seen[0][1].signal instanceof AbortSignal);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
});

test('search route rejects remote origins, cross-site fetches, invalid hosts and mismatched ports before searching', async t => {
  let calls = 0;
  const { url, server } = await fixture(t, async query => { calls++; return result(query); });
  for (const headers of [{ Origin: 'https://example.com' }, { Origin: 'http://localhost:9999' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = await post(url, { query: 'test' }, { headers: { 'Content-Type': 'application/json', ...headers } });
    assert.equal(response.status, 403);
  }
  for (const host of ['example.com', `localhost:${server.address().port + 1}`, '127.0.0.1.evil.example']) {
    const response = await rawRequest(url, { headers: { Host: host, 'Content-Type': 'application/json' }, chunks: ['{"query":"test"}'] });
    assert.equal(response.status, 403);
  }
  assert.equal(calls, 0);
});

test('search route requires POST and advertises its supported method', async t => {
  let calls = 0;
  const { url } = await fixture(t, async query => { calls++; return result(query); });
  for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS', 'HEAD']) {
    const response = await fetch(`${url}/api/search`, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
  }
  assert.equal(calls, 0);
});

test('search route requires an application/json object and rejects invalid JSON before searching', async t => {
  let calls = 0;
  const { url } = await fixture(t, async query => { calls++; return result(query); });
  const wrongType = await fetch(`${url}/api/search`, { method: 'POST', body: '{"query":"test"}' });
  assert.equal(wrongType.status, 415);
  for (const body of ['{', 'null', '[]', '"text"', '7', '']) {
    const response = await fetch(`${url}/api/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /valid JSON object/);
  }
  assert.equal(calls, 0);
  const valid = await post(url, { query: 'test' }, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  assert.equal(valid.status, 200);
  assert.equal(calls, 1);
});

test('search route uses a 4096-byte limit independently of the larger chat attachment allowance', async t => {
  let calls = 0;
  const { url } = await fixture(t, async query => { calls++; return result(query); }, { maxBodyBytes: 16 * 1024 * 1024 });
  const base = JSON.stringify({ query: 'test', padding: '' });
  const exact = JSON.stringify({ query: 'test', padding: 'x'.repeat(4096 - Buffer.byteLength(base)) });
  assert.equal(Buffer.byteLength(exact), 4096);
  const accepted = await fetch(`${url}/api/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: exact });
  assert.equal(accepted.status, 200);
  const oversized = await fetch(`${url}/api/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: exact + ' ' });
  assert.equal(oversized.status, 413);
  assert.match((await oversized.json()).error, /too large/);
  assert.equal(calls, 1);
});

test('search route enforces its byte limit for chunked and multibyte bodies without Content-Length', async t => {
  let calls = 0;
  const { url } = await fixture(t, async query => { calls++; return result(query); });
  const response = await rawRequest(url, {
    headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
    chunks: ['{"query":"test","padding":"', '你'.repeat(1400), '"}'],
  });
  assert.equal(response.status, 413);
  assert.match(JSON.parse(response.text).error, /too large/);
  assert.equal(calls, 0);
});

test('search route preserves actionable search errors and never fabricates successful results', async t => {
  let calls = 0;
  const { url } = await fixture(t, async () => {
    const errors = [new ApiError('Enter a valid search query.', 400), new ApiError('Bing is limiting web searches. Try later.', 429), new ApiError('Web search timed out. Try again.', 504), new ApiError('Web search is unavailable.', 502)];
    throw errors[calls++];
  });
  for (const [status, phrase] of [[400, /valid/], [429, /limiting/], [504, /timed out/], [502, /unavailable/]]) {
    const response = await post(url, { query: 'test' });
    assert.equal(response.status, status);
    const body = await response.json();
    assert.match(body.error, phrase);
    assert.equal(body.sources, undefined);
    assert.equal(body.engine, undefined);
  }
});

test('disconnecting from the search route cancels its search without waiting for the result', async t => {
  let started;
  let cancelled;
  const ready = new Promise(resolve => { started = resolve; });
  const cancellation = new Promise(resolve => { cancelled = resolve; });
  const { url } = await fixture(t, async (query, { signal }) => {
    started();
    return await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { cancelled(signal.reason); reject(signal.reason); }, { once: true });
    });
  });
  const controller = new AbortController();
  const response = post(url, { query: 'test' }, { signal: controller.signal });
  await ready;
  controller.abort();
  await assert.rejects(response, error => error.name === 'AbortError');
  const reason = await Promise.race([cancellation, new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Search was not cancelled')), 1500); timer.unref(); })]);
  assert.equal(reason.status, 499);
});

test('independent search keeps selected model, effort, provider key and both chat protocols intact', async t => {
  const providerRequests = [];
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    providerRequests.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/responses'
      ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Responses answer' }] }] }
      : { choices: [{ message: { content: 'Chat answer' } }] }));
  });
  const baseUrl = await listen(provider);
  t.after(() => close(provider));
  const { url } = await fixture(t, async query => result(query));
  assert.equal((await post(url, { query: 'test' })).status, 200);
  for (const protocol of ['chat', 'responses']) {
    const response = await fetch(`${url}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, apiKey: 'provider-test-key', model: 'selected-model', effort: 'medium', protocol, messages: [{ role: 'user', content: 'Keep my conversation.' }] }),
    });
    assert.equal(response.status, 200);
    const events = [];
    for await (const event of parseSSE(response.body)) events.push(JSON.parse(event.data));
    assert.deepEqual(events[0], { type: 'meta', protocol, model: 'selected-model' });
    assert.equal(events.at(-1).type, 'done');
  }
  assert.deepEqual(providerRequests.map(request => request.path), ['/chat/completions', '/responses']);
  for (const request of providerRequests) {
    assert.equal(request.authorization, 'Bearer provider-test-key');
    assert.equal(request.body.model, 'selected-model');
    assert.equal(request.body.tools, undefined);
    assert.equal(request.body.web_search, undefined);
  }
  assert.equal(providerRequests[0].body.reasoning_effort, 'medium');
  assert.deepEqual(providerRequests[1].body.reasoning, { effort: 'medium' });
});
