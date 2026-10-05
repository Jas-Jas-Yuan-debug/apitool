// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import {
  validateChat, buildChatPayload, fetchChat, completionEvents, normalizeSources,
  MAX_ATTACHMENT_BYTES, MAX_REQUEST_ATTACHMENT_BYTES, MAX_ATTACHMENT_TEXT_CHARACTERS,
} from '../lib/api.mjs';
import { fetchImage } from '../lib/images.mjs';

function body(protocol = 'chat', messages = [{ role: 'user', content: 'Hello' }]) {
  return { baseUrl: 'https://example.com/v1', apiKey: 'fixture-key', model: 'vision-model', protocol, effort: 'medium', messages };
}

function binary(name, type, bytes = Buffer.from('fixture file'), kind = 'file') {
  return { id: `attachment-${name}`, name, type, size: bytes.length, kind, dataUrl: `data:${type};base64,${bytes.toString('base64')}` };
}

function text(name = 'notes.txt', content = 'a useful note') {
  return { id: `attachment-${name}`, name, type: 'text/plain', size: Buffer.byteLength(content), kind: 'text', text: content };
}

function withAttachments(attachments, protocol = 'chat') {
  return body(protocol, [{ role: 'user', content: 'Read these.', attachments }]);
}

async function output(response, protocol = 'responses') {
  const events = [];
  for await (const event of completionEvents(response, { protocol, apiKey: 'fixture-key' })) events.push(event);
  return events;
}

function sse(events) {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('attachment mapping keeps earlier text and assistant context intact in both protocols', () => {
  const attachments = [text('notes.md', '# Project notes'), binary('photo.png', 'image/png', Buffer.from([137, 80, 78, 71]), 'image'), binary('manual.pdf', 'application/pdf', Buffer.from('%PDF-1.7 fixture'))];
  const messages = [{ role: 'user', content: 'Remember 17.' }, { role: 'assistant', content: 'I will remember 17.' }, { role: 'user', content: 'Explain the attachments.', attachments }];
  const original = JSON.stringify(messages);
  for (const protocol of ['chat', 'responses']) {
    const payload = buildChatPayload(validateChat(body(protocol, messages)));
    const mapped = protocol === 'responses' ? payload.input : payload.messages;
    assert.deepEqual(mapped.slice(0, 2), messages.slice(0, 2));
    assert.deepEqual(mapped[2].content[0], { type: protocol === 'responses' ? 'input_text' : 'text', text: 'Explain the attachments.' });
    assert.deepEqual(mapped[2].content[1], { type: protocol === 'responses' ? 'input_text' : 'text', text: 'Attachment: notes.md\n# Project notes' });
    assert.deepEqual(mapped[2].content[2], protocol === 'responses'
      ? { type: 'input_image', image_url: attachments[1].dataUrl }
      : { type: 'image_url', image_url: { url: attachments[1].dataUrl } });
    assert.deepEqual(mapped[2].content[3], protocol === 'responses'
      ? { type: 'input_file', filename: 'manual.pdf', file_data: attachments[2].dataUrl }
      : { type: 'file', file: { filename: 'manual.pdf', file_data: attachments[2].dataUrl } });
    assert.equal(JSON.stringify(payload).includes('attachment-manual'), false, 'Local attachment IDs do not enter provider payloads');
  }
  assert.equal(JSON.stringify(messages), original, 'Building a request must not mutate the conversation');
});

test('attachment-only turns and empty text files build usable content without empty prompt parts', () => {
  const options = validateChat(body('responses', [{ role: 'user', content: '', attachments: [text('empty.txt', '')] }]));
  assert.deepEqual(buildChatPayload(options).input, [{ role: 'user', content: [{ type: 'input_text', text: 'Attachment: empty.txt\n' }] }]);
  assert.deepEqual(buildChatPayload(validateChat(body('chat', [{ role: 'user', content: 'No files', attachments: [] }]))).messages, [{ role: 'user', content: 'No files' }]);
});

test('non-PDF documents and spreadsheets require Responses without changing the selected protocol', () => {
  for (const attachment of [
    binary('report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    binary('budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    binary('slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
  ]) {
    const chat = withAttachments([attachment]);
    assert.throws(() => validateChat(chat), /Select the Responses protocol/);
    assert.equal(chat.protocol, 'chat');
    const responses = validateChat({ ...chat, protocol: 'responses' });
    assert.deepEqual(buildChatPayload(responses).input[0].content[1], { type: 'input_file', filename: attachment.name, file_data: attachment.dataUrl });
  }
  assert.throws(() => validateChat({ ...withAttachments([binary('report.doc', 'application/msword')]), protocol: 'auto' }), /Responses protocol/);
  const automatic = validateChat({ ...withAttachments([binary('report.doc', 'application/msword')]), baseUrl: 'https://api.openai.com/v1', protocol: 'auto' });
  assert.equal(automatic.protocol, 'responses');
});

test('image validation uses only the latest prompt while retaining raw history and connection choices', () => {
  const office = binary('old-report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const latest = { role: 'user', content: 'Draw a red planet.', attachments: [text('details.txt', 'with two small moons')] };
  const request = { ...body('chat', [{ role: 'user', content: 'Read my old report.', attachments: [office] }, { role: 'assistant', content: 'Previous report summary' }, latest]), model: 'gpt-image-1', systemPrompt: 'Keep the prompt short.' };
  const original = structuredClone(request);
  const options = validateChat(request, { image: true });
  assert.deepEqual(options.messages, [latest]);
  assert.equal(options.protocol, 'chat'); assert.equal(options.effort, 'medium');
  assert.equal(options.model, 'gpt-image-1'); assert.equal(options.apiKey, 'fixture-key');
  assert.equal(options.systemPrompt, 'Keep the prompt short.');
  assert.deepEqual(request, original, 'Selecting image input must not remove historical files from the saved chat');
  assert.throws(() => validateChat(request), /Select the Responses protocol/);
  assert.throws(() => validateChat(request, { image: false }), /Select the Responses protocol/);
  assert.equal(validateChat({ ...request, protocol: 'responses' }).messages.length, 3);
});

test('historical office files no longer block image generation and never enter the Images provider prompt', async () => {
  const request = { ...body('chat', [{ role: 'user', content: 'Summarize my report.', attachments: [binary('old-report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')] }, { role: 'assistant', content: 'Previous summary' }, { role: 'user', content: 'Draw a red planet.', attachments: [text('details.txt', 'with two small moons')] }]), model: 'gpt-image-1' };
  const original = JSON.stringify(request);
  let calls = 0;
  await fetchImage(validateChat(request, { image: true }), { fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, 'https://example.com/v1/images/generations');
    const payload = JSON.parse(init.body);
    assert.equal(payload.prompt, 'Draw a red planet.\n\nAttachment: details.txt\nwith two small moons');
    assert.equal(payload.stream, true);
    assert.ok(!init.body.includes('old-report.docx'));
    assert.ok(!init.body.includes('Previous summary'));
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  } });
  assert.equal(calls, 1); assert.equal(JSON.stringify(request), original);
});

test('latest image documents reach the precise Images format error before upstream and malformed file data still fails validation', async () => {
  for (const attachment of [binary('new-report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), binary('new-budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), binary('new-manual.pdf', 'application/pdf')]) {
    const request = { ...withAttachments([attachment]), model: 'gpt-image-1' };
    const options = validateChat(request, { image: true });
    assert.equal(options.messages[0].attachments[0].name, attachment.name);
    await assert.rejects(fetchImage(options, { fetchImpl: () => assert.fail('Unsupported latest documents must not be sent upstream') }), /Image models accept image and text attachments.*PDFs, documents, and spreadsheets/);
    assert.throws(() => validateChat({ ...request, messages: [{ role: 'user', content: 'Draw', attachments: [{ ...attachment, dataUrl: 'broken' }] }] }, { image: true }), /valid base64 data URL/);
  }
});

test('image mode preserves common request validations and validates its actual latest input', () => {
  const valid = { ...body('chat'), model: 'gpt-image-1' };
  const invalid = [
    { ...valid, messages: [] }, { ...valid, messages: Array.from({ length: 501 }, () => ({ role: 'user', content: 'Draw' })) },
    { ...valid, model: '' }, { ...valid, effort: 'invalid' }, { ...valid, protocol: 'invalid' },
    { ...valid, baseUrl: 'http://example.com' }, { ...valid, apiKey: 'key\nheader' },
    { ...valid, webSearch: 'true' }, { ...valid, systemPrompt: 123 },
    { ...valid, messages: [{ role: 'user', content: 'Old valid input' }, null] },
    { ...valid, messages: [{ role: 'user', content: 123 }] },
  ];
  for (const request of invalid) assert.throws(() => validateChat(request, { image: true }), { name: 'ApiError', status: 400 });
});

test('supported image MIME types map to image inputs and unknown browser MIME falls back to the filename', () => {
  for (const [name, type] of [['a.png', 'image/png'], ['b.jpg', 'image/jpeg'], ['c.jpeg', 'image/jpeg'], ['d.webp', 'image/webp'], ['e.gif', 'image/gif']]) {
    const attachment = binary(name, type, Buffer.from('image fixture'), 'image');
    const validated = validateChat(withAttachments([attachment])).messages[0].attachments[0];
    assert.equal(validated.type, type);
    assert.equal(buildChatPayload({ ...validateChat(withAttachments([attachment])), protocol: 'responses' }).input[0].content[1].type, 'input_image');
  }
  const pdf = binary('MANUAL.PDF', 'application/pdf');
  pdf.type = '';
  assert.equal(validateChat(withAttachments([pdf])).messages[0].attachments[0].type, 'application/pdf');
  const note = text('sample.py', 'print("hello")');
  note.type = 'application/octet-stream';
  assert.equal(validateChat(withAttachments([note])).messages[0].attachments[0].type, 'text/plain');
});

test('malformed attachments, unsafe filenames, mismatched MIME, and invalid base64 fail before sending', () => {
  const good = binary('manual.pdf', 'application/pdf');
  const cases = [
    null, {}, { ...good, name: '../manual.pdf' }, { ...good, name: 'manual\u0000.pdf' },
    { ...good, name: 'a'.repeat(256) }, { ...good, size: -1 }, { ...good, size: 1.5 },
    { ...good, type: 'image/png' }, { ...good, dataUrl: 'https://example.com/manual.pdf' },
    { ...good, dataUrl: 'data:application/pdf;base64,@@@@' },
    { ...good, dataUrl: 'data:application/pdf;base64,Zh==' }, // Noncanonical padding bits.
    { ...good, dataUrl: 'data:application/pdf;base64,Zg=' },
    { ...good, dataUrl: 'data:text/plain;base64,Zg==' },
    { ...good, size: good.size + 1 }, { ...good, id: 'bad\nid' },
    { ...good, kind: 'audio' }, binary('program.exe', 'application/octet-stream'),
    { ...text(), text: 'binary\u0000data' }, { ...text(), type: 'application/pdf' },
    { ...text(), name: 'pretend.exe' },
  ];
  for (const attachment of cases) assert.throws(() => validateChat(withAttachments([attachment])), { name: 'ApiError', status: 400 });
  assert.throws(() => validateChat(withAttachments('not an array')), /at most 5/);
  assert.throws(() => validateChat(withAttachments(Array.from({ length: 6 }, () => text()))), /at most 5/);
  assert.throws(() => validateChat(body('responses', [{ role: 'assistant', content: 'Answer', attachments: [good] }])), /Only user messages/);
});

test('per-file and replayed-request byte limits use decoded content rather than base64 length', () => {
  const exact = binary('manual.pdf', 'application/pdf', Buffer.alloc(MAX_ATTACHMENT_BYTES, 1));
  assert.doesNotThrow(() => validateChat(withAttachments([exact])));
  assert.throws(() => validateChat(withAttachments([{ ...exact, size: MAX_ATTACHMENT_BYTES + 1 }])), /at most 5 MiB/);
  const messages = [{ role: 'user', content: 'first', attachments: [exact] }, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'second', attachments: [exact] }];
  assert.equal(MAX_REQUEST_ATTACHMENT_BYTES, 2 * MAX_ATTACHMENT_BYTES);
  assert.doesNotThrow(() => validateChat(body('responses', messages)));
  messages.push({ role: 'user', content: 'third', attachments: [text('one.txt', 'x')] });
  assert.throws(() => validateChat(body('responses', messages)), /request must total at most 10 MiB/);
  assert.equal(messages.length, 4, 'Rejecting a request does not delete historical turns');
});

test('extracted-text budget applies across historical turns and allows the exact boundary', () => {
  const first = text('first.txt', 'x'.repeat(100000));
  const second = text('second.txt', 'x'.repeat(MAX_ATTACHMENT_TEXT_CHARACTERS - first.text.length));
  const request = body('chat', [{ role: 'user', content: 'first', attachments: [first] }, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'second', attachments: [second] }]);
  assert.doesNotThrow(() => validateChat(request));
  request.messages.push({ role: 'user', content: 'third', attachments: [text('third.txt', 'x')] });
  assert.throws(() => validateChat(request), /200,000 characters/);
});

test('fetchChat sends attachments and complete historical context once to the selected endpoint', async t => {
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, payload: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'completed', output_text: 'I saw your file and remember 17.' }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const messages = [{ role: 'user', content: 'Remember 17.' }, { role: 'assistant', content: 'Noted.' }, { role: 'user', content: 'Read this.', attachments: [text('context.txt', 'Attached content')] }];
  const options = validateChat({ ...body('responses', messages), baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` });
  const events = await output(await fetchChat(options), 'responses');
  assert.equal(events[0].text, 'I saw your file and remember 17.');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/v1/responses');
  assert.deepEqual(requests[0].payload.input.slice(0, 2), messages.slice(0, 2));
  assert.match(requests[0].payload.input[2].content[1].text, /Attached content/);
  assert.deepEqual(requests[0].payload.reasoning, { effort: 'medium' });
});

test('citation normalization allows safe HTTP links, bounds titles, deduplicates, and redacts credentials', () => {
  const annotations = [
    { type: 'url_citation', url: 'https://example.com/article', title: 'Article' },
    { type: 'url_citation', url_citation: { url: 'https://example.com/article', title: 'Duplicate' } },
    { type: 'url_citation', url: 'http://example.org/', title: 'a'.repeat(500) },
    { type: 'url_citation', url: 'javascript:alert(1)', title: 'Unsafe' },
    { type: 'url_citation', url: 'https://name:password@example.com', title: 'Credentials' },
    { type: 'url_citation', url: 'https://example.com/?key=fixture-key', title: 'Key' },
    { type: 'url_citation', url: 'https://example.com/redacted', title: 'fixture-key\u0000 citation' },
    { type: 'file_citation', file_id: 'file-1' }, null, 'not a URL',
  ];
  const sources = normalizeSources(annotations, 'fixture-key');
  assert.equal(sources.length, 3);
  assert.deepEqual(sources[0], { title: 'Article', url: 'https://example.com/article' });
  assert.equal(sources[1].title.length, 300);
  assert.equal(sources[2].title, '[redacted] citation');
  assert.equal(JSON.stringify(sources).includes('fixture-key'), false);
  assert.equal(normalizeSources(Array.from({ length: 100 }, (_, n) => `https://example.com/${n}`)).length, 50);
});

test('Responses streaming citations survive final-object repetition without duplicate links or reply text', async () => {
  const annotation = { type: 'url_citation', url: 'https://example.com/research', title: 'Research' };
  const events = await output(sse([
    { type: 'response.output_text.delta', delta: 'Answer' },
    { type: 'response.output_text.annotation.added', annotation },
    { type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: 'Answer', annotations: [annotation] }] } },
    { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Answer', annotations: [annotation] }] }] } },
  ]));
  assert.equal(events.filter(event => event.type === 'sources').length, 1);
  assert.deepEqual(events.find(event => event.type === 'sources').sources, [{ title: 'Research', url: 'https://example.com/research' }]);
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Answer');
  assert.equal(events.at(-1).type, 'done');
});

test('Responses JSON and final-only streams include citations alongside fallback text', async () => {
  const result = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Final answer', annotations: [{ type: 'url_citation', title: 'Source', url: 'https://example.com/source' }] }] }] };
  for (const response of [new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } }), sse([{ type: 'response.completed', response: result }])]) {
    const events = await output(response);
    assert.equal(events.filter(event => event.type === 'sources').length, 1);
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Final answer');
    assert.equal(events.at(-1).type, 'done');
  }
});

test('Chat Completions citation annotations and compatible provider URL lists normalize as sources', async () => {
  const annotation = { type: 'url_citation', url_citation: { title: 'Chat source', url: 'https://example.com/chat' } };
  const response = new Response(JSON.stringify({ choices: [{ message: { content: 'Chat answer', annotations: [annotation] }, finish_reason: 'stop' }], citations: ['https://example.com/list'] }), { headers: { 'Content-Type': 'application/json' } });
  const events = await output(response, 'chat');
  assert.equal(events.find(event => event.type === 'sources').sources.length, 2);
  const stream = await output(sse([{ choices: [{ delta: { content: 'Chat answer', annotations: [annotation] } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], citations: ['https://example.com/chat'] }]), 'chat');
  assert.equal(stream.filter(event => event.type === 'sources').length, 1);
  assert.equal(stream.at(-1).type, 'done');
});
