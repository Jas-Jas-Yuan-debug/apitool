// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './support/app-harness.mjs';
import { readSavedState, sanitizeImages, stateForStorage } from '../public/client.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cEZkAAAAASUVORK5CYII=';
const enc = new TextEncoder();
const tick = () => new Promise(resolve => setImmediate(resolve));
function stream() {
  let control;
  const response = new Response(new ReadableStream({ start(value) { control = value; } }));
  return { response, send(event) { control.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`)); }, close() { control.close(); } };
}

test('native image preview is visible before completion and the completed image survives reload', async () => {
  const provider = stream();
  const app = harness(async () => provider.response);
  app.chooseModel('gpt-image-test', { custom: true });
  app.elements.get('message-input').value = 'Draw a dog';
  const pending = app.run('sendMessage()');
  await tick();
  const ids = app.state('currentChat.messages.map(message => message.id)');
  provider.send({ type: 'meta', task: 'image', model: 'gpt-image-test', protocol: 'images' });
  provider.send({ type: 'partial_image', dataUrl: PNG });
  await tick();
  assert.equal(app.run('currentChat.messages.at(-1).status'), 'streaming');
  assert.equal(app.run('document.getElementById("message-" + currentChat.messages.at(-1).id).querySelector("img").src'), PNG);
  assert.equal(app.run('currentChat.messages.at(-1).imagePreview.dataUrl'), PNG);
  assert.ok(!app.storage.get('relay.workspace.v1').includes('imagePreview'));
  provider.send({ type: 'image', dataUrl: PNG });
  provider.send({ type: 'done', usage: { totalTokens: 12 } }); provider.close();
  await pending;
  assert.equal(app.run('currentChat.messages.at(-1).status'), 'complete');
  assert.deepEqual(app.state('currentChat.messages.map(message => message.id)'), ids);
  assert.equal(app.run('currentChat.messages.at(-1).usage.totalTokens'), 12);
  assert.equal(app.run('currentChat.messages.at(-1).imagePreview'), undefined);
  assert.equal(app.run('document.getElementById("message-" + currentChat.messages.at(-1).id).querySelector("a").download'), 'relay-image-1.png');
  const saved = readSavedState({ getItem: () => app.storage.get('relay.workspace.v1') });
  assert.equal(saved.chats[0].messages.at(-1).images[0].dataUrl, PNG);
  assert.equal(saved.chats[0].messages.at(-1).task, 'image');
  assert.ok(!app.storage.get('relay.workspace.v1').includes('test-key'));
});

test('remote generated image URLs are links and never automatic browser image loads', async () => {
  const events = [{ type: 'meta', task: 'image', protocol: 'images' }, { type: 'image', url: 'https://example.org/image.png' }, { type: 'done' }];
  const app = harness(async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')));
  app.elements.get('message-input').value = 'Draw a dog'; await app.run('sendMessage()');
  assert.equal(app.run('document.getElementById("message-" + currentChat.messages.at(-1).id).querySelector("img")'), null);
  assert.equal(app.run('document.getElementById("message-" + currentChat.messages.at(-1).id).querySelector("a").href'), 'https://example.org/image.png');
  assert.equal(app.run('currentChat.messages.at(-1).status'), 'complete');
});

test('an image completion without a usable final image reports a retryable error', async () => {
  const app = harness(async () => new Response('data: {"type":"meta","task":"image"}\n\ndata: {"type":"image","url":"javascript:alert(1)"}\n\ndata: {"type":"done"}\n\n'));
  app.elements.get('message-input').value = 'Draw a dog'; await app.run('sendMessage()');
  assert.equal(app.run('currentChat.messages.at(-1).status'), 'error');
  assert.match(app.run('currentChat.messages.at(-1).error'), /without a usable image/);
  assert.equal(app.run('currentChat.messages[0].content'), 'Draw a dog');
});

test('image storage rejects unsafe URLs and active media and never saves in-progress previews', () => {
  assert.deepEqual(sanitizeImages([{ url: 'javascript:alert(1)' }, { url: 'https://user:secret@example.org/img' }, { dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }, { dataUrl: 'data:image/png;base64,YR==' }]), []);
  const state = stateForStorage({}, [{ id: 'chat', messages: [{ id: 'img', role: 'assistant', content: '', status: 'streaming', images: [{ dataUrl: PNG, credential: 'discard' }], imagePreview: { dataUrl: PNG }, task: 'image', stage: 'image' }] }]);
  assert.deepEqual(state.chats[0].messages[0].images, [{ dataUrl: PNG }]);
  assert.equal(state.chats[0].messages[0].imagePreview, undefined);
  assert.equal(state.chats[0].messages[0].stage, undefined);
});

const DOCX = { id: 'old-document', name: 'notes.docx', kind: 'file', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 3, dataUrl: 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,AQID' };
function officeChat() {
  return { config: { baseUrl: 'https://compatible.example/v1', model: 'chat-model', modelMode: 'custom', protocol: 'auto', effort: 'high' }, activeChatId: 'keep', chats: [
    { id: 'keep', title: 'Keep the document chat', messages: [
      { id: 'old-user', role: 'user', content: 'Read my notes', status: 'complete', attachments: [DOCX] },
      { id: 'old-answer', role: 'assistant', content: 'Earlier completed answer', status: 'complete' },
    ] },
  ] };
}
function typeDraft(app, text) {
  const input = app.elements.get('message-input'); input.value = text; input.listeners.input({ target: input });
}

test('switching an office-document chat to images sends only the latest prompt and regeneration keeps new draft files local', async () => {
  const requests = [];
  const app = harness(async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response([{ type: 'meta', task: 'image', protocol: 'images' }, { type: 'image', dataUrl: PNG }, { type: 'done' }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  }, { initialState: officeChat(), defaultConnection: false });
  app.chooseModel('gpt-image-test', { custom: true });
  typeDraft(app, 'Draw a blue dog');
  await app.run('sendMessage()');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].messages, [{ role: 'user', content: 'Draw a blue dog' }]);
  assert.equal(requests[0].protocol, 'auto');
  assert.equal(app.run('currentChat.messages.at(-1).status'), 'complete');
  assert.deepEqual(app.state('currentChat.messages.slice(0, 2).map(message => message.id)'), ['old-user', 'old-answer']);
  assert.deepEqual(app.state('currentChat.messages[0].attachments'), [DOCX]);

  const pendingFile = { ...DOCX, id: 'pending-document', name: 'later.docx' };
  app.inject('pendingFile', pendingFile); app.run('composer().attachments = [pendingFile]');
  typeDraft(app, 'Keep my next question');
  await app.run('sendMessage(true)');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].messages, [{ role: 'user', content: 'Draw a blue dog' }]);
  assert.equal(app.run('currentChat.id'), 'keep');
  assert.equal(app.run('currentChat.messages.length'), 4);
  assert.deepEqual(app.state('currentChat.messages.slice(0, 2).map(message => message.id)'), ['old-user', 'old-answer']);
  assert.equal(app.elements.get('message-input').value, 'Keep my next question');
  assert.deepEqual(app.state('composer().attachments'), [pendingFile]);
  const saved = readSavedState({ getItem: () => app.storage.get('relay.workspace.v1') });
  assert.deepEqual(saved.chats[0].messages[0].attachments, [DOCX]);
  assert.equal(saved.chats[0].composer.text, 'Keep my next question');
  assert.deepEqual(saved.chats[0].composer.attachments, [pendingFile]);
});

test('a latest unsupported office attachment reports the Images API error while preserving chat and unsent draft', async () => {
  let calls = 0;
  const app = harness(async () => { calls++; throw new Error('Unsupported image input should be rejected before fetching.'); }, { initialState: officeChat(), defaultConnection: false });
  app.chooseModel('gpt-image-test', { custom: true });
  const latestFile = { ...DOCX, id: 'latest-document', name: 'drawing.docx' };
  app.inject('latestFile', latestFile); app.run('composer().attachments = [latestFile]');
  typeDraft(app, 'Draw this document');
  await app.run('sendMessage()');
  assert.equal(calls, 0);
  assert.equal(app.elements.get('toast').textContent, 'Image models accept image and text attachments. Use a chat model for PDFs, documents, and spreadsheets.');
  assert.equal(app.run('currentChat.id'), 'keep');
  assert.deepEqual(app.state('currentChat.messages.map(message => message.id)'), ['old-user', 'old-answer']);
  assert.deepEqual(app.state('currentChat.messages[0].attachments'), [DOCX]);
  assert.equal(app.elements.get('message-input').value, 'Draw this document');
  assert.deepEqual(app.state('composer().attachments'), [latestFile]);
});
