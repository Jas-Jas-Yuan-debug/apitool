// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createServer } from '../server.mjs';
import { parseSSE } from '../lib/api.mjs';
import { createMockProvider, MOCK_IMAGE_BASE64 } from './mock-provider.mjs';

const KEY = 'disposable-image-route-key';
const DATA_URL = `data:image/png;base64,${MOCK_IMAGE_BASE64}`;
const IMAGE_BYTES = Buffer.from(MOCK_IMAGE_BASE64, 'base64');
const IMAGE = { id: 'input', name: 'square.png', type: 'image/png', kind: 'image', size: IMAGE_BYTES.length, dataUrl: DATA_URL };

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function native(res, event) { res.write(`event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`); }
function partial(index = 0) { return { type: 'image_generation.partial_image', partial_image_index: index, output_format: 'png', b64_json: MOCK_IMAGE_BASE64 }; }
function final(type = 'image_generation.completed') { return { type, output_format: 'png', b64_json: MOCK_IMAGE_BASE64, revised_prompt: 'An orange square.', usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 } }; }

async function fixture(t, handler) {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    const bytes = await rawBody(req);
    const request = { method: req.method, path: req.url, headers: req.headers, bytes };
    seen.push(request);
    try { await handler(request, res); }
    catch (error) { json(res, 500, { error: { message: error.message } }); }
  });
  const baseUrl = await listen(upstream);
  let searches = 0;
  const server = createServer({ search: () => { searches++; throw new Error('Image requests must not invoke search.'); } });
  const url = await listen(server);
  t.after(async () => { await close(server); await close(upstream); });
  return { baseUrl, url, seen, searchCalls: () => searches };
}
function body(baseUrl, extras = {}) {
  return { baseUrl: `${baseUrl}/v1`, apiKey: KEY, model: 'gpt-image-2.5-sunburst', effort: 'high', protocol: 'auto', systemPrompt: 'Earlier chat settings', webSearch: true, messages: [{ role: 'user', content: 'Draw an orange square.' }], ...extras };
}
function post(url, input, options = {}) {
  return fetch(`${url}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), ...options });
}
async function events(response) {
  const output = [];
  for await (const record of parseSSE(response.body)) output.push(JSON.parse(record.data));
  return output;
}
function completed(output) {
  assert.equal(output.at(-1).type, 'done');
  assert.equal(output.at(-1).task, 'image');
  assert.equal(output.filter(event => event.type === 'done').length, 1);
  assert.equal(output.some(event => event.type === 'error'), false);
}

test('an image-only model routes to streaming image generations even with the Responses setting', async t => {
  const { baseUrl, url, seen, searchCalls } = await fixture(t, (request, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    native(res, partial(0)); native(res, partial(1)); native(res, final()); res.end();
  });
  const input = body(baseUrl, { baseUrl: `${baseUrl}/custom/v1/images/generations`, protocol: 'responses', messages: [
    { role: 'user', content: 'Keep our earlier conversation.' },
    { role: 'assistant', content: 'Earlier answer.' },
    { role: 'user', content: 'Draw an orange square.', attachments: [{ id: 'note', name: 'notes.txt', kind: 'text', type: 'text/plain', size: 5, text: 'clean' }] },
  ] });
  const output = await events(await post(url, input));
  completed(output);
  assert.deepEqual(output.slice(0, 2).map(event => [event.type, event.task || event.stage, event.protocol]), [['meta', 'image', 'images'], ['stage', 'image', undefined]]);
  assert.deepEqual(output.filter(event => event.type === 'partial_image').map(event => [event.partialIndex, event.dataUrl]), [[0, DATA_URL], [1, DATA_URL]]);
  assert.deepEqual(output.find(event => event.type === 'image'), { type: 'image', index: 0, dataUrl: DATA_URL, revisedPrompt: 'An orange square.' });
  assert.deepEqual(output.at(-1).usage, { inputTokens: 5, outputTokens: 7, totalTokens: 12 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, '/custom/v1/images/generations');
  assert.equal(seen[0].headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(JSON.parse(seen[0].bytes), { model: 'gpt-image-2.5-sunburst', prompt: 'Draw an orange square.\n\nAttachment: notes.txt\nclean', n: 1, stream: true, partial_images: 2 });
  assert.equal(searchCalls(), 0);
  assert.equal(JSON.stringify(output).includes(KEY), false);
});

test('image edits send original latest-turn image bytes as multipart without chat or reasoning fields', async t => {
  let form;
  const { baseUrl, url, seen } = await fixture(t, async (request, res) => {
    form = await new Response(request.bytes, { headers: { 'Content-Type': request.headers['content-type'] } }).formData();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    native(res, { ...partial(), type: 'image_edit.partial_image' }); native(res, final('image_edit.completed')); res.end();
  });
  const output = await events(await post(url, body(baseUrl, { protocol: 'chat', messages: [
    { role: 'user', content: 'Earlier prompt', attachments: [{ ...IMAGE, name: 'earlier.png' }] },
    { role: 'assistant', content: 'Earlier answer' },
    { role: 'user', content: 'Make these squares blue.', attachments: [IMAGE, { ...IMAGE, id: 'second', name: 'other.png' }] },
  ] })));
  completed(output);
  assert.equal(seen.length, 1); assert.equal(seen[0].path, '/v1/images/edits');
  assert.match(seen[0].headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.equal(form.get('model'), 'gpt-image-2.5-sunburst'); assert.equal(form.get('prompt'), 'Make these squares blue.');
  assert.equal(form.get('stream'), 'true'); assert.equal(form.get('partial_images'), '2'); assert.equal(form.get('n'), '1');
  assert.equal(form.has('messages'), false); assert.equal(form.has('reasoning_effort'), false);
  const files = form.getAll('image[]');
  assert.deepEqual(files.map(file => [file.name, file.type, file.size]), [['square.png', 'image/png', IMAGE_BYTES.length], ['other.png', 'image/png', IMAGE_BYTES.length]]);
  for (const file of files) assert.deepEqual(Buffer.from(await file.arrayBuffer()), IMAGE_BYTES);
  assert.equal(output.filter(event => event.type === 'image').length, 1);
});

test('DALL-E uses one image JSON request and normalizes base64 output without fabricated previews', async t => {
  const { baseUrl, url, seen } = await fixture(t, (request, res) => json(res, 200, { data: [{ b64_json: MOCK_IMAGE_BASE64, revised_prompt: `Revised ${KEY}` }] }));
  const output = await events(await post(url, body(baseUrl, { model: 'dall-e-3' })));
  completed(output);
  assert.equal(seen[0].path, '/v1/images/generations');
  assert.deepEqual(JSON.parse(seen[0].bytes), { model: 'dall-e-3', prompt: 'Draw an orange square.', n: 1 });
  assert.equal(output.some(event => event.type === 'partial_image'), false);
  assert.equal(output.find(event => event.type === 'image').dataUrl, DATA_URL);
  assert.equal(output.find(event => event.type === 'image').revisedPrompt, 'Revised [redacted]');
});

test('JSON image URLs remain links and are never fetched or converted to inline data by the server', async t => {
  let link;
  const { baseUrl, url, seen } = await fixture(t, (request, res) => json(res, 200, { data: [{ url: link, revised_prompt: 'Signed image link' }] }));
  link = `${baseUrl}/assets/generated.png?sig=disposable-signed-url`;
  const output = await events(await post(url, body(baseUrl)));
  completed(output);
  assert.equal(seen.length, 1, 'A provider URL is not fetched by Relay.');
  assert.deepEqual(output.find(event => event.type === 'image'), { type: 'image', index: 0, url: link, revisedPrompt: 'Signed image link' });
  assert.equal(output.some(event => event.type === 'partial_image'), false);
});

test('image-provider authentication errors redact credentials and never retry a chat endpoint', async t => {
  const { baseUrl, url, seen } = await fixture(t, (request, res) => json(res, 401, { error: { message: `Image authorization failed ${KEY}` } }));
  const response = await post(url, body(baseUrl));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Image authorization failed [redacted]' });
  assert.deepEqual(seen.map(request => request.path), ['/v1/images/generations']);
});

test('image stream errors preserve native partial events but never report a completed image', async t => {
  const { baseUrl, url } = await fixture(t, (request, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    native(res, partial()); native(res, { type: 'error', error: { message: `Generation failed ${KEY}` } }); res.end();
  });
  const output = await events(await post(url, body(baseUrl)));
  assert.equal(output.find(event => event.type === 'partial_image').dataUrl, DATA_URL);
  assert.equal(output.at(-1).type, 'error'); assert.equal(output.at(-1).message, 'Generation failed [redacted]');
  assert.equal(output.some(event => ['image', 'done'].includes(event.type)), false);
});

test('a partial-only image stream reports premature completion without marking the preview final', async t => {
  const { baseUrl, url } = await fixture(t, (request, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); native(res, partial()); res.end();
  });
  const output = await events(await post(url, body(baseUrl)));
  assert.equal(output.at(-1).type, 'error'); assert.match(output.at(-1).message, /before a final image/);
  assert.equal(output.some(event => ['image', 'done'].includes(event.type)), false);
});

test('stopping an image request cancels the blocked provider stream after a native preview', { timeout: 5000 }, async t => {
  let stopped;
  const upstreamStopped = new Promise(resolve => { stopped = resolve; });
  const { baseUrl, url, seen } = await fixture(t, (request, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); native(res, partial());
    const heartbeat = setInterval(() => res.write(': waiting\n\n'), 40);
    res.on('close', () => { clearInterval(heartbeat); stopped(); });
  });
  const controller = new AbortController();
  const response = await post(url, body(baseUrl), { signal: controller.signal });
  const reader = parseSSE(response.body)[Symbol.asyncIterator]();
  let event;
  do { event = JSON.parse((await reader.next()).value.data); } while (event.type !== 'partial_image');
  controller.abort();
  await upstreamStopped;
  await reader.return().catch(() => {});
  assert.equal(seen.length, 1);
  assert.equal(event.dataUrl, DATA_URL);
});

test('the slow image mock emits genuine provider previews before the final image without logging credentials', async t => {
  const logs = [];
  const upstream = createMockProvider({ log: entry => logs.push(entry) });
  const baseUrl = await listen(upstream);
  const server = createServer({ search: () => assert.fail('Image generation cannot search.') });
  const url = await listen(server);
  t.after(async () => { await close(server); await close(upstream); });
  const response = await post(url, body(baseUrl, { model: 'gpt-image-test', messages: [{ role: 'user', content: 'slow orange square' }] }));
  const output = []; let previewAt, finalAt;
  for await (const record of parseSSE(response.body)) {
    const event = JSON.parse(record.data); output.push(event);
    if (event.type === 'partial_image' && previewAt === undefined) previewAt = performance.now();
    if (event.type === 'image') finalAt = performance.now();
  }
  completed(output);
  assert.deepEqual(output.filter(event => event.type === 'partial_image').map(event => event.partialIndex), [0, 1]);
  assert.ok(finalAt - previewAt >= 900, 'The provider waits twice for 500 ms before completing.');
  const inspect = await (await fetch(`${baseUrl}/inspect`)).json();
  assert.equal(inspect.endpoint, '/v1/images/generations'); assert.equal(inspect.stream, true); assert.equal(inspect.partialImages, 2);
  assert.equal(inspect.imageInputCount, 0); assert.equal(inspect.n, 1);
  assert.equal(JSON.stringify(logs).includes(KEY), false);
  assert.equal(JSON.stringify(logs).includes('slow orange square'), false);
});
