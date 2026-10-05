// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './support/app-harness.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
const existingState = () => ({
  config: { baseUrl: 'https://provider.example/v1', model: 'test-model', modelMode: 'custom', effort: 'low', protocol: 'chat', webSearch: false },
  activeChatId: 'existing',
  chats: [{ id: 'existing', title: 'Keep earlier messages', messages: [
    { id: 'old-user', role: 'user', content: 'Earlier question', status: 'complete' },
    { id: 'old-reply', role: 'assistant', content: 'Earlier answer', status: 'complete' },
  ] }],
});
function gatedApp() {
  let writer;
  const app = harness(async (_url, options) => new Response(new ReadableStream({
    start(controller) { writer = controller; options.signal.addEventListener('abort', () => controller.error(new Error('Aborted')), { once: true }); },
  })), { initialState: existingState() });
  const input = app.elements.get('message-input'); input.value = 'Stream the answer'; input.listeners.input({ target: input });
  return {
    app,
    emit: event => writer.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)),
    badge: () => app.elements.get('messages').children.at(-1).children.find(element => element.className === 'generation-status'),
    content: () => app.elements.get('messages').children.at(-1).children.find(element => element.className === 'message-content'),
  };
}

test('generation stage labels are based on actual events and disappear for terminal replies', () => {
  const app = harness(async () => {});
  const cases = [
    [{ status: 'streaming', content: '', reasoning: '' }, 'Waiting for model'],
    [{ status: 'streaming', content: '', reasoning: 'Model-provided reasoning' }, 'Thinking'],
    [{ status: 'streaming', content: 'First words', reasoning: 'Model-provided reasoning' }, 'Streaming reply'],
    [{ status: 'streaming', content: 'First words', searches: [{ status: 'searching', query: 'actual query' }] }, 'Searching the web'],
    [{ status: 'streaming', content: '', searches: [{ status: 'complete', query: 'old query' }] }, 'Waiting for model'],
    [{ status: 'streaming', content: '', task: 'image' }, 'Generating image'],
    [{ status: 'streaming', content: '', stage: 'image' }, 'Generating image'],
    [{ status: 'complete', content: 'Done', stage: 'image' }, ''],
    [{ status: 'error', reasoning: 'Reasoning', searches: [{ status: 'searching', query: 'old query' }] }, ''],
    [{ status: 'interrupted', content: 'Partial' }, ''],
  ];
  for (const [message, label] of cases) {
    app.inject('stageMessage', message);
    assert.equal(app.run('generationStatus(stageMessage)'), label);
  }
});

test('two gated text deltas become visible before completion and the streaming badge leaves after done', async () => {
  const { app, emit, badge, content } = gatedApp();
  const pending = app.run('sendMessage()'); await settle();
  assert.equal(badge()?.children[1].textContent, 'Waiting for model');
  emit({ type: 'delta', text: 'First streamed words. ' }); await settle();
  assert.equal(app.state('currentChat.messages.at(-1).status'), 'streaming');
  assert.equal(content().innerHTML, 'First streamed words. ');
  assert.equal(badge().children[1].textContent, 'Streaming reply');
  emit({ type: 'delta', text: 'More words 中文.' }); await settle();
  assert.equal(content().innerHTML, 'First streamed words. More words 中文.');
  assert.equal(app.state('currentChat.messages.at(-1).status'), 'streaming');
  const input = app.elements.get('message-input'); input.value = 'Keep my next draft'; input.listeners.input({ target: input });
  emit({ type: 'done' }); await pending;
  assert.equal(app.state('currentChat.messages.at(-1).status'), 'complete');
  assert.equal(content().innerHTML, 'First streamed words. More words 中文.');
  assert.equal(badge(), undefined);
  assert.equal(input.value, 'Keep my next draft');
  assert.equal(app.state('currentChat.id'), 'existing');
  assert.deepEqual(app.state('currentChat.messages.slice(0,2).map(message => message.id)'), ['old-user', 'old-reply']);
  assert.equal(app.state('config.effort'), 'low');
});

test('reasoning and real search activity update the stage without hiding previously streamed text', async () => {
  const { app, emit, badge, content } = gatedApp();
  const pending = app.run('sendMessage()'); await settle();
  emit({ type: 'reasoning', text: 'Provided reasoning' }); await settle();
  assert.equal(badge().children[1].textContent, 'Thinking');
  emit({ type: 'delta', text: 'An initial answer. ' }); await settle();
  emit({ type: 'search', status: 'searching', callId: 'search', query: 'actual source query' }); await settle();
  assert.equal(badge().children[1].textContent, 'Searching the web');
  assert.equal(content().innerHTML, 'An initial answer. ');
  emit({ type: 'search', status: 'complete', callId: 'search', query: 'actual source query', resultCount: 1 }); await settle();
  assert.equal(badge().children[1].textContent, 'Streaming reply');
  emit({ type: 'delta', text: 'Answer continues.' }); emit({ type: 'done' }); await pending;
  assert.equal(content().innerHTML, 'An initial answer. Answer continues.'); assert.equal(badge(), undefined);
});

test('cancel removes the badge while retaining partial text and the original conversation', async () => {
  const { app, emit, badge, content } = gatedApp();
  const pending = app.run('sendMessage()'); await settle();
  emit({ type: 'delta', text: 'Partial streamed answer' }); await settle();
  assert.ok(badge());
  app.run('stopGeneration()'); await pending;
  assert.equal(app.state('currentChat.messages.at(-1).status'), 'interrupted');
  assert.equal(content().innerHTML, 'Partial streamed answer'); assert.equal(badge(), undefined);
  assert.deepEqual(app.state('currentChat.messages.slice(0,2).map(message => message.id)'), ['old-user', 'old-reply']);
});

test('a provider error removes the live badge without erasing text received earlier', async () => {
  const { app, emit, badge, content } = gatedApp();
  const pending = app.run('sendMessage()'); await settle();
  emit({ type: 'delta', text: 'Received before failure' }); await settle();
  emit({ type: 'error', message: 'Provider disconnected' }); await pending;
  assert.equal(app.state('currentChat.messages.at(-1).status'), 'error');
  assert.equal(content().innerHTML, 'Received before failure'); assert.equal(badge(), undefined);
  assert.equal(app.state('currentChat.messages.at(-1).error'), 'Provider disconnected');
});
