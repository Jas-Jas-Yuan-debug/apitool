// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateChat } from '../lib/api.mjs';
import { fetchImage, imageEvents, isImageModel, MAX_GENERATED_IMAGE_BYTES } from '../lib/images.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=';
const encoder = new TextEncoder();
function options(extra = {}) {
  return validateChat({ baseUrl: 'https://provider.example/v1', apiKey: 'fixture-provider-key', model: 'gpt-image-2.5-sunburst', protocol: 'responses', effort: 'max', webSearch: true, messages: [{ role: 'user', content: 'Generate a dog eating dog food.' }], ...extra });
}
function attachment(name = 'photo.png', type = 'image/png', bytes = Buffer.from(PNG, 'base64'), kind = 'image') {
  return { name, type, size: bytes.length, kind, dataUrl: `data:${type};base64,${bytes.toString('base64')}` };
}
function jsonImage(body = { data: [{ b64_json: PNG }], usage: { input_tokens: 5, output_tokens: 8, total_tokens: 13 } }) {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}
function event(type, extra = {}) { return `event: ${type}\r\ndata: ${JSON.stringify({ type, b64_json: PNG, output_format: 'png', ...extra })}\r\n\r\n`; }
function streamImage(text) { return new Response(text, { headers: { 'Content-Type': 'text/event-stream' } }); }
async function collect(response, selected = options(), settings) { const output = []; for await (const value of imageEvents(response, selected, settings)) output.push(value); return output; }

test('image model routing recognizes explicit and namespaced image models conservatively', () => {
  for (const model of ['gpt-image-2.5-sunburst', 'gpt-image-1', 'dall-e-3', 'chatgpt-image-latest', 'provider/gpt-image-2.5-sunburst', ' provider/dall-e-2 ']) assert.equal(isImageModel(model), true, model);
  for (const model of ['gpt-6.1-sol', 'gemini-image', 'gpt-imagery', 'not-gpt-image-1', 'chatgpt-image-latest-extra', '', null]) assert.equal(isImageModel(model), false, String(model));
});

test('generation sends one streamed Images request preserving the selected model and latest prompt', async () => {
  const selected = options({ model: 'provider/gpt-image-2.5-sunburst', systemPrompt: 'Old instructions', messages: [{ role: 'user', content: 'Old message' }, { role: 'assistant', content: 'Old reply' }, { role: 'user', content: 'Draw this exactly.\nKeep the blue bowl.', attachments: [{ kind: 'text', name: 'notes.txt', type: 'text/plain', size: 6, text: 'softly' }] }] });
  const before = structuredClone(selected);
  let calls = 0;
  const response = await fetchImage(selected, { fetchImpl: async (url, request) => {
    calls++;
    assert.equal(url, 'https://provider.example/v1/images/generations');
    assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, 'Bearer fixture-provider-key');
    assert.equal(request.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(request.body), { model: 'provider/gpt-image-2.5-sunburst', prompt: 'Draw this exactly.\nKeep the blue bowl.\n\nAttachment: notes.txt\nsoftly', n: 1, stream: true, partial_images: 2 });
    return jsonImage();
  } });
  assert.equal(calls, 1); assert.ok(response.ok); assert.deepEqual(selected, before);
});

test('legacy image model requests JSON without unsupported streaming, effort, or web fields', async () => {
  await fetchImage(options({ model: 'dall-e-3' }), { fetchImpl: async (url, request) => {
    assert.equal(url, 'https://provider.example/v1/images/generations');
    assert.deepEqual(JSON.parse(request.body), { model: 'dall-e-3', prompt: 'Generate a dog eating dog food.', n: 1 });
    return jsonImage();
  } });
});

test('attached images use multipart edits with original filenames, MIME, bytes, and prompt', async () => {
  const first = attachment(); const second = attachment('other.png');
  const selected = options({ messages: [{ role: 'user', content: 'Put these dogs beside the bowl.', attachments: [first, second] }] });
  await fetchImage(selected, { fetchImpl: async (url, request) => {
    assert.equal(url, 'https://provider.example/v1/images/edits');
    assert.equal(request.headers['Content-Type'], undefined);
    assert.ok(request.body instanceof FormData);
    for (const [field, expected] of Object.entries({ model: selected.model, prompt: selected.messages[0].content, n: '1', stream: 'true', partial_images: '2' })) assert.equal(request.body.get(field), expected);
    const images = request.body.getAll('image[]'); assert.equal(images.length, 2);
    assert.deepEqual(images.map(value => value.name), ['photo.png', 'other.png']);
    assert.deepEqual(images.map(value => value.type), ['image/png', 'image/png']);
    assert.deepEqual(Buffer.from(await images[0].arrayBuffer()), Buffer.from(PNG, 'base64'));
    assert.equal(request.body.get('reasoning_effort'), null); assert.equal(request.body.get('tools'), null);
    return jsonImage();
  } });
});

test('unsupported current attachments fail before a provider call and older document history remains intact', async () => {
  const document = attachment('manual.pdf', 'application/pdf', Buffer.from('%PDF-1.7'), 'file');
  let calls = 0;
  const settings = { fetchImpl: async () => { calls++; return jsonImage(); } };
  await assert.rejects(fetchImage(options({ messages: [{ role: 'user', content: 'Use this.', attachments: [document] }] }), settings), /Use a chat model/);
  await assert.rejects(fetchImage(options({ messages: [{ role: 'user', content: 'Edit this.', attachments: [attachment('anim.gif', 'image/gif', Buffer.from('GIF89a'))] }] }), settings), /Convert GIF/);
  await assert.rejects(fetchImage(options({ model: 'dall-e-3', messages: [{ role: 'user', content: 'Edit this.', attachments: [attachment()] }] }), settings), /does not support editing/);
  assert.equal(calls, 0);
  const selected = options({ messages: [{ role: 'user', content: 'Old document.', attachments: [document] }, { role: 'assistant', content: 'Old answer.' }, { role: 'user', content: 'Generate a dog.' }] });
  const before = structuredClone(selected);
  await fetchImage(selected, { fetchImpl: async (url, request) => { assert.equal(JSON.parse(request.body).prompt, 'Generate a dog.'); return jsonImage(); } });
  assert.deepEqual(selected, before);
});

test('image prompts reject empty content, excessive text, and assistant-only final turns', async () => {
  for (const selected of [options({ messages: [{ role: 'user', content: '  ' }] }), options({ messages: [{ role: 'user', content: 'x'.repeat(32001) }] }), options({ messages: [{ role: 'assistant', content: 'Draw this.' }] }), options({ model: 'dall-e-2', messages: [{ role: 'user', content: 'x'.repeat(1001) }] })]) {
    await assert.rejects(fetchImage(selected, { fetchImpl: async () => { throw new Error('must not send'); } }), { name: 'ApiError', status: 400 });
  }
});

test('provider HTTP errors are bounded, credential-redacted, and never retried', async () => {
  let calls = 0;
  await assert.rejects(fetchImage(options(), { fetchImpl: async () => { calls++; return new Response(JSON.stringify({ error: { message: 'Invalid fixture-provider-key for this endpoint' } }), { status: 401 }); } }), error => error.status === 401 && error.message === 'Invalid [redacted] for this endpoint');
  assert.equal(calls, 1);
  await assert.rejects(fetchImage(options(), { fetchImpl: async () => new Response('<html>private account page</html>', { status: 502 }) }), /request failed \(502\)/);
});

test('network errors give an actionable message and pre-cancellation sends no request', async () => {
  await assert.rejects(fetchImage(options(), { fetchImpl: async () => { throw new Error('untrusted-network-detail'); } }), /Could not reach the image provider/);
  const controller = new AbortController(); const reason = new Error('Cancelled locally'); controller.abort(reason);
  await assert.rejects(fetchImage(options(), { signal: controller.signal, fetchImpl: async () => { throw new Error('must not send'); } }), error => error === reason);
});

test('JSON fallback produces a final image and normalized usage without invented partial events', async () => {
  const events = await collect(jsonImage());
  assert.deepEqual(events.map(value => value.type), ['meta', 'stage', 'image', 'done']);
  assert.equal(events[0].task, 'image'); assert.equal(events[0].protocol, 'images');
  assert.equal(events[2].dataUrl, `data:image/png;base64,${PNG}`);
  assert.deepEqual(events.at(-1).usage, { inputTokens: 5, outputTokens: 8, totalTokens: 13 });
});

for (const prefix of ['image_generation', 'image_edit']) {
  test(`${prefix} native partial is delivered before final completion and terminal event closes a stalled stream`, async () => {
    let upstream; let cancelled = false;
    const body = new ReadableStream({ start(controller) { upstream = controller; }, cancel() { cancelled = true; return new Promise(() => {}); } });
    const generator = imageEvents(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }), options());
    assert.equal((await generator.next()).value.type, 'meta');
    assert.equal((await generator.next()).value.type, 'stage');
    const partial = event(`${prefix}.partial_image`, { partial_image_index: 0 });
    upstream.enqueue(encoder.encode(partial.slice(0, 30))); upstream.enqueue(encoder.encode(partial.slice(30)));
    assert.deepEqual((await generator.next()).value, { type: 'partial_image', index: 0, partialIndex: 0, dataUrl: `data:image/png;base64,${PNG}` });
    let settled = false; const final = generator.next().then(value => { settled = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(settled, false);
    upstream.enqueue(encoder.encode(event(`${prefix}.completed`, { usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 } })));
    assert.equal((await final).value.type, 'image');
    const done = await Promise.race([generator.next(), new Promise((resolve, reject) => setTimeout(() => reject(new Error('terminal image event hung')), 500))]);
    assert.deepEqual(done.value, { type: 'done', task: 'image', usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 } });
    assert.equal(cancelled, true); assert.equal((await generator.next()).done, true);
  });
}

test('SSE event name works when the data omits type and UTF-8/chunked final data stays intact', async () => {
  const text = `event: image_generation.completed\ndata: ${JSON.stringify({ b64_json: PNG, revised_prompt: 'A café dog', output_format: 'png' })}`;
  const bytes = encoder.encode(text);
  const chunks = new ReadableStream({ start(controller) { for (let start = 0; start < bytes.length; start += 7) controller.enqueue(bytes.slice(start, start + 7)); controller.close(); } });
  const events = await collect(new Response(chunks, { headers: { 'Content-Type': 'text/event-stream' } }));
  assert.equal(events[2].revisedPrompt, 'A café dog'); assert.equal(events.at(-1).type, 'done');
});

test('partial-only, empty, or unknown image streams cannot report a completed image', async () => {
  for (const text of ['', event('image_generation.partial_image', { partial_image_index: 0 }), 'data: {"type":"provider.heartbeat"}\n\n', 'data: [DONE]\n\n']) await assert.rejects(collect(streamImage(text)), /ended before a final image/);
});

test('native stream errors preserve delivered partials and redact the provider credential', async () => {
  const output = [];
  const response = streamImage(event('image_generation.partial_image', { partial_image_index: 0 }) + 'event: error\ndata: {"error":{"message":"Bad fixture-provider-key"}}\n\n');
  await assert.rejects(async () => { for await (const value of imageEvents(response, options())) output.push(value); }, /Bad \[redacted\]/);
  assert.equal(output.at(-1).type, 'partial_image'); assert.equal(output.some(value => value.type === 'done'), false);
  await assert.rejects(collect(streamImage('data: broken json\n\n')), /invalid JSON/);
});

test('JSON image links remain safe links and reject scripts, credentials, whitespace, or key leaks', async () => {
  const events = await collect(jsonImage({ data: [{ url: 'https://cdn.example/image.png?signature=abc' }] }));
  assert.equal(events[2].url, 'https://cdn.example/image.png?signature=abc'); assert.equal(events[2].dataUrl, undefined);
  for (const url of ['javascript:alert(1)', 'data:image/svg+xml,bad', 'https://user:password@cdn.example/a.png', 'https://cdn.example/a b.png', 'https://cdn.example/a.png?key=fixture-provider-key', 'https://cdn.example/a.png?key=fixture%2Dprovider%2Dkey']) await assert.rejects(collect(jsonImage({ data: [{ url }] })), /image URL/);
});

test('invalid base64, non-image data, and mismatched raster formats fail without a final image', async () => {
  for (const value of ['', '%%%%', 'YQ=', Buffer.from('<svg>unsafe</svg>').toString('base64')]) await assert.rejects(collect(jsonImage({ data: [{ b64_json: value }] })), /image data|not a PNG/);
  await assert.rejects(collect(jsonImage({ output_format: 'jpeg', data: [{ b64_json: PNG }] })), /does not match/);
  await assert.rejects(collect(jsonImage({ output_format: 'svg', data: [{ b64_json: PNG }] })), /unsupported image format/);
  await assert.rejects(collect(jsonImage({ data: Array.from({ length: 5 }, () => ({ b64_json: PNG })) })), /too many images/);
});

test('image payloads over the text stream default can complete within the image byte limit', async () => {
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0); Buffer.from(PNG, 'base64').copy(bytes);
  const base64 = bytes.toString('base64');
  const events = await collect(streamImage(event('image_generation.completed', { b64_json: base64 })));
  assert.equal(events[2].dataUrl.length, base64.length + 'data:image/png;base64,'.length); assert.equal(events.at(-1).type, 'done');
  const oversized = Buffer.alloc(MAX_GENERATED_IMAGE_BYTES + 1, 0); Buffer.from(PNG, 'base64').copy(oversized);
  await assert.rejects(collect(jsonImage({ data: [{ b64_json: oversized.toString('base64') }] })), /oversized image data/);
});

test('cancelling a stalled JSON response releases the reader without awaiting provider cancellation', async () => {
  const controller = new AbortController(); let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } });
  const generator = imageEvents(new Response(body, { headers: { 'Content-Type': 'application/json' } }), options(), { signal: controller.signal });
  await generator.next(); await generator.next();
  const read = generator.next(); controller.abort(new Error('Stopped generating'));
  await assert.rejects(read, /Stopped generating/); assert.equal(cancelled, true);
});

test('cancelling a stalled native image stream releases the upstream reader promptly', async () => {
  const controller = new AbortController(); let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } });
  const generator = imageEvents(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }), options(), { signal: controller.signal });
  await generator.next(); await generator.next();
  const read = generator.next(); controller.abort(new Error('Stopped image stream'));
  await assert.rejects(read, /Stopped image stream/); assert.equal(cancelled, true);
});
