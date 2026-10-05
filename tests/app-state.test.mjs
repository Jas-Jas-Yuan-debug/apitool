// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, completed } from './support/app-harness.mjs';
import { buildChatPayload, validateChat } from '../lib/api.mjs';

test('the selected model and high effort reach the Chat Completions payload', async () => {
  let providerPayload;
  const app = harness(async (_url, options) => {
    providerPayload = buildChatPayload(validateChat(JSON.parse(options.body)));
    return completed('Answer');
  });
  app.chooseModel('provider/chosen-chat', { custom: true });
  app.elements.get('effort').value = 'high';
  app.elements.get('effort').listeners.change();
  app.run("config.protocol = 'chat'; config.webSearch = false");
  app.elements.get('message-input').value = 'Question';
  await app.run('sendMessage()');
  assert.equal(providerPayload.model, 'provider/chosen-chat');
  assert.equal(providerPayload.reasoning_effort, 'high');
  assert.deepEqual(providerPayload.messages, [{ role: 'user', content: 'Question' }]);
});

test('the selected model and extra-high effort reach the Responses payload', async () => {
  let providerPayload;
  const app = harness(async (_url, options) => {
    providerPayload = buildChatPayload(validateChat(JSON.parse(options.body)));
    return completed('Answer');
  });
  app.chooseModel('provider/chosen-response', { custom: true });
  app.elements.get('effort').value = 'xhigh';
  app.elements.get('effort').listeners.change();
  app.run("config.protocol = 'responses'");
  app.elements.get('message-input').value = 'Question';
  await app.run('sendMessage()');
  assert.equal(providerPayload.model, 'provider/chosen-response');
  assert.deepEqual(providerPayload.reasoning, { effort: 'xhigh' });
  assert.deepEqual(providerPayload.input, [{ role: 'user', content: 'Question' }]);
});

test('Auto effort selected in the UI omits effort from both provider payload formats', async () => {
  const providerPayloads = [];
  const app = harness(async (_url, options) => {
    providerPayloads.push(buildChatPayload(validateChat(JSON.parse(options.body))));
    return completed('Answer');
  });
  app.elements.get('effort').value = 'auto';
  app.elements.get('effort').listeners.change();
  for (const protocol of ['chat', 'responses']) {
    app.run(`config.protocol = '${protocol}'`);
    app.elements.get('message-input').value = 'Question';
    await app.run('sendMessage()');
  }
  assert.equal('reasoning_effort' in providerPayloads[0], false);
  assert.equal('reasoning' in providerPayloads[1], false);
});

test('fragmented multilingual text reaches a complete visible app reply intact', async () => {
  const expected = '你好 🌍 — مرحبا — 日本語';
  const text = `data: ${JSON.stringify({ type: 'delta', text: expected })}\r\n\r\ndata: {"type":"done"}\r\n\r\n`;
  const bytes = new TextEncoder().encode(text);
  const app = harness(async () => new Response(new ReadableStream({
    start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
  })));
  app.elements.get('message-input').value = 'Question';
  await app.run('sendMessage()');
  const reply = app.state('currentChat.messages').at(-1);
  assert.equal(reply.status, 'complete');
  assert.equal(reply.content, expected);
  const rendered = app.elements.get(`message-${reply.id}`).querySelectorAll('div').find(element => element.className === 'message-content');
  assert.equal(rendered.innerHTML, expected);
});

test('Enter submits once while Shift+Enter and composing Enter leave the draft unsent', async () => {
  let calls = 0;
  const app = harness(async () => { calls++; return completed('Answer'); });
  const input = app.elements.get('message-input');
  input.value = 'Keep this draft';
  for (const flags of [{ shiftKey: true, isComposing: false }, { shiftKey: false, isComposing: true }]) {
    let prevented = false;
    input.listeners.keydown({ key: 'Enter', ...flags, preventDefault() { prevented = true; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(prevented, false);
    assert.equal(calls, 0);
    assert.equal(input.value, 'Keep this draft');
  }
  let prevented = 0;
  input.listeners.keydown({ key: 'Enter', shiftKey: false, isComposing: false, preventDefault() { prevented++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prevented, 1);
  assert.equal(calls, 1);
  assert.equal(app.state('currentChat.messages').at(-1).status, 'complete');
});

test('saved preferences restore through the visible model and effort controls', async () => {
  let sent;
  const saved = { config: { baseUrl: 'https://saved.example/custom/v2', model: 'saved/model', modelMode: 'catalog', effort: 'medium', protocol: 'responses', systemPrompt: 'Be concise', theme: 'dark' }, chats: [] };
  const app = harness(async (_url, options) => { sent = JSON.parse(options.body); return completed('Answer'); }, { initialState: saved, defaultConnection: false });
  assert.equal(app.elements.get('base-url').value, saved.config.baseUrl);
  assert.equal(app.elements.get('model-select').value, 'id:saved/model');
  assert.equal(app.elements.get('custom-model-wrap').hidden, true);
  assert.equal(app.elements.get('effort').value, 'medium');
  app.elements.get('message-input').value = 'Question';
  await app.run('sendMessage()');
  assert.equal(sent.baseUrl, saved.config.baseUrl);
  assert.equal(sent.model, saved.config.model);
  assert.equal(sent.effort, 'medium');
  assert.equal(sent.protocol, 'responses');
});

test('reloading saved preferences clears the API key field even if legacy saved data contains a key', async () => {
  const first = harness(async () => completed('Answer'));
  first.elements.get('api-key').value = 'disposable-private-key';
  first.elements.get('message-input').value = 'Question';
  await first.run('sendMessage()');
  const savedText = first.storage.get('relay.workspace.v1');
  assert.equal(savedText.includes('disposable-private-key'), false);
  const saved = JSON.parse(savedText);
  saved.config.apiKey = 'legacy-secret';
  const reloaded = harness(async () => completed('Answer'), { initialState: saved, defaultConnection: false });
  assert.equal(reloaded.elements.get('api-key').value, '');
  assert.equal('apiKey' in reloaded.state('config'), false);
});

test('two turns send complete context and keep credentials out of saved state', async () => {
  const requests = [];
  const app = harness(async (_url, options) => { requests.push(JSON.parse(options.body)); return completed(requests.length === 1 ? 'First reply' : 'Second reply'); });
  app.elements.get('message-input').value = 'First question';
  await app.run('sendMessage()');
  app.elements.get('message-input').value = 'Second question';
  await app.run('sendMessage()');
  assert.deepEqual(requests[1].messages, [
    { role: 'user', content: 'First question' },
    { role: 'assistant', content: 'First reply' },
    { role: 'user', content: 'Second question' },
  ]);
  assert.equal(app.state('currentChat.messages').at(-1).status, 'complete');
  assert.equal(app.storage.get('relay.workspace.v1').includes('test-key'), false);
});

test('regenerate reuses the last user prompt without duplicating it', async () => {
  const requests = [];
  const app = harness(async (_url, options) => { requests.push(JSON.parse(options.body)); return completed('Reply'); });
  app.elements.get('message-input').value = 'Question';
  await app.run('sendMessage()');
  await app.run('sendMessage(true)');
  assert.deepEqual(requests[1].messages, [{ role: 'user', content: 'Question' }]);
  assert.equal(app.state('currentChat.messages').length, 2);
});

test('provider failure preserves a retryable prompt and excludes failed partial output from the next request', async () => {
  const requests = [];
  const app = harness(async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return requests.length === 1
      ? new Response('data: {"type":"delta","text":"partial"}\n\ndata: {"type":"error","message":"Provider failed"}\n\n')
      : completed('Successful retry');
  });
  app.elements.get('message-input').value = 'Question';
  await app.run('sendMessage()');
  assert.equal(app.state('currentChat.messages').at(-1).status, 'error');
  assert.equal(app.state('currentChat.messages').at(-1).content, 'partial');
  await app.run('sendMessage(true)');
  assert.deepEqual(requests[1].messages, [{ role: 'user', content: 'Question' }]);
});

test('new chat aborts a pending generation without contaminating its empty history', async () => {
  const app = harness((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
  }));
  app.elements.get('message-input').value = 'Old question';
  const pending = app.run('sendMessage()');
  app.run('newChat()');
  await pending;
  assert.deepEqual(app.state('currentChat.messages'), []);
  assert.equal(app.state('chats[0].messages').at(-1).status, 'interrupted');
  assert.equal(app.state('activeGeneration'), null);
});

test('clear history during a pending generation stays cleared when old cleanup runs', async () => {
  const app = harness((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
  }));
  app.elements.get('message-input').value = 'Old question';
  const pending = app.run('sendMessage()');
  app.elements.get('clear-history').listeners.click();
  app.elements.get('clear-history').listeners.click();
  await pending;
  assert.deepEqual(app.state('chats'), []);
  assert.deepEqual(JSON.parse(app.storage.get('relay.workspace.v1')).chats, []);
});

test('the chat remains usable when the browser denies all localStorage access', async () => {
  const app = harness(async () => completed('Works without storage'), { deniedStorage: true });
  app.elements.get('message-input').value = 'Question';
  await app.run('sendMessage()');
  assert.equal(app.state('currentChat.messages').at(-1).content, 'Works without storage');
  assert.equal(app.state('currentChat.messages').at(-1).status, 'complete');
  assert.match(app.elements.get('toast').textContent, /storage.*unavailable/i);
});

test('stopping a partially streamed reply excludes it from the next message context', async () => {
  const requests = [];
  let streamController;
  const app = harness(async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length > 1) return completed('Next answer');
    options.signal.addEventListener('abort', () => streamController.error(new Error('Aborted')), { once: true });
    return new Response(new ReadableStream({
      start(controller) {
        streamController = controller;
        controller.enqueue(new TextEncoder().encode('data: {"type":"delta","text":"Stopped partial"}\n\n'));
      },
    }));
  });
  app.elements.get('message-input').value = 'First question';
  const pending = app.run('sendMessage()');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.state('currentChat.messages').at(-1).content, 'Stopped partial');
  app.run('stopGeneration()');
  await pending;
  assert.equal(app.state('currentChat.messages').at(-1).status, 'interrupted');
  app.elements.get('message-input').value = 'Followup';
  await app.run('sendMessage()');
  assert.deepEqual(requests[1].messages, [{ role: 'user', content: 'First question' }, { role: 'user', content: 'Followup' }]);
});

test('an old model-list response cannot overwrite the state after base URL changes', async () => {
  let resolveFetch;
  const app = harness(() => new Promise(resolve => { resolveFetch = resolve; }));
  const pending = app.run('loadModels()');
  app.elements.get('base-url').value = 'https://different.example/v1';
  app.elements.get('base-url').listeners.input();
  resolveFetch(new Response(JSON.stringify({ models: ['stale-model'] })));
  await pending;
  assert.equal(app.elements.get('connection-label').textContent, 'Not tested');
  assert.deepEqual(app.elements.get('model-select').options.map(option => option.value), ['', 'custom:']);
  assert.equal(app.elements.get('load-models').disabled, false);
});
