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
  const requests = [];
  const app = harness(async (_url, options) => {
    requests.push({ body: JSON.parse(options.body), signal: options.signal });
    return new Response(new ReadableStream({
      start(controller) { writer = controller; options.signal.addEventListener('abort', () => controller.error(new Error('Aborted')), { once: true }); },
    }));
  }, { initialState: existingState() });
  const input = app.elements.get('message-input'); input.value = 'Stream the answer'; input.listeners.input({ target: input });
  return {
    app, requests,
    emit: event => writer.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)),
    badge: () => app.elements.get('messages').children.at(-1).children.find(element => element.className === 'generation-status'),
    content: () => app.elements.get('messages').children.at(-1).children.find(element => element.className === 'message-content'),
  };
}

const sentFile = { id: 'sent-file', kind: 'text', name: 'sent.txt', type: 'text/plain', size: 4, text: 'sent' };
const draftFile = { id: 'draft-file', kind: 'text', name: 'draft.txt', type: 'text/plain', size: 5, text: 'draft' };
function keepNextDraft(app) {
  const input = app.elements.get('message-input'); input.value = 'Keep my next prompt'; input.listeners.input({ target: input });
  app.inject('nextDraftFile', draftFile);
  app.run('composer().attachments = [nextDraftFile]; persist();');
}

test('repeated sends and implicit form submits keep one live request and retain draft files and reply metrics', async () => {
  const { app, emit, requests } = gatedApp();
  let now = 100;
  app.inject('performance', { now: () => now });
  app.inject('originalFile', sentFile); app.run('composer().attachments = [originalFile];');
  const pending = app.run('sendMessage()'); await settle();
  const replyId = app.state('currentChat.messages.at(-1).id');
  keepNextDraft(app);
  await app.run('sendMessage()');
  for (let repeat = 0; repeat < 3; repeat++) app.elements.get('chat-form').listeners.submit({ preventDefault() {} });
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].signal.aborted, false);
  assert.equal(app.state('currentChat.messages.at(-1).id'), replyId);
  assert.equal(app.state('currentChat.messages.at(-1).status'), 'streaming');
  now = 1100; emit({ type: 'delta', text: 'An uninterrupted answer.' }); await settle();
  emit({ type: 'usage', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } }); await settle();
  now = 2100; emit({ type: 'done' }); await pending;
  const reply = app.state('currentChat.messages.at(-1)');
  assert.equal(reply.status, 'complete'); assert.equal(reply.content, 'An uninterrupted answer.');
  assert.equal(reply.firstTokenMs, 1000); assert.equal(reply.elapsed, 2000);
  assert.deepEqual(reply.usage, { inputTokens: 4, outputTokens: 2, totalTokens: 6 });
  assert.equal(app.elements.get('message-input').value, 'Keep my next prompt');
  assert.deepEqual(app.state('composer().attachments'), [draftFile]);
  assert.deepEqual(app.state('currentChat.messages.at(-2).attachments'), [sentFile]);
  assert.deepEqual(app.state('currentChat.messages.slice(0,2).map(message => message.id)'), ['old-user', 'old-reply']);
  const saved = JSON.parse(app.storage.get('relay.workspace.v1')).chats[0];
  assert.deepEqual(saved.composer.attachments, [draftFile]);
  assert.equal(saved.composer.text, 'Keep my next prompt');
  assert.equal(saved.messages.at(-1).firstTokenMs, 1000); assert.equal(saved.messages.at(-1).usage.totalTokens, 6);
});

test('repeated Enter during generation cannot cancel or submit the next draft', async () => {
  const { app, emit, requests } = gatedApp();
  const pending = app.run('sendMessage()'); await settle();
  keepNextDraft(app);
  let prevented = 0;
  for (const repeat of [false, true, true]) app.elements.get('message-input').listeners.keydown({ key: 'Enter', repeat, shiftKey: false, isComposing: false, preventDefault() { prevented++; } });
  await settle();
  assert.equal(prevented, 3);
  assert.equal(requests.length, 1); assert.equal(requests[0].signal.aborted, false);
  assert.equal(app.state('currentChat.messages.at(-1).status'), 'streaming');
  emit({ type: 'delta', text: 'Finished after repeated Enter.' }); emit({ type: 'done' }); await pending;
  assert.equal(app.state('currentChat.messages.at(-1).status'), 'complete');
  assert.equal(app.elements.get('message-input').value, 'Keep my next prompt');
  assert.deepEqual(app.state('composer().attachments'), [draftFile]);
});

test('a separate explicit Stop button cancels while preserving partial text, files, draft and reported usage', async () => {
  const { app, emit, requests } = gatedApp();
  const stop = app.elements.get('stop-button'), send = app.elements.get('send-button');
  assert.ok(stop, 'Stop has its own control');
  assert.equal(stop.type, 'button'); assert.equal(stop.hidden, true);
  app.inject('originalFile', sentFile); app.run('composer().attachments = [originalFile];');
  const pending = app.run('sendMessage()'); await settle();
  assert.equal(stop.hidden, false); assert.equal(send.disabled, true);
  assert.equal(send.getAttribute('aria-label'), 'Send message');
  emit({ type: 'delta', text: 'Partial text kept.' });
  emit({ type: 'usage', usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } }); await settle();
  keepNextDraft(app);
  stop.click(); await pending;
  assert.equal(requests.length, 1); assert.equal(requests[0].signal.aborted, true);
  const reply = app.state('currentChat.messages.at(-1)');
  assert.equal(reply.status, 'interrupted'); assert.equal(reply.content, 'Partial text kept.');
  assert.deepEqual(reply.usage, { inputTokens: 7, outputTokens: 3, totalTokens: 10 });
  assert.ok(reply.firstTokenMs >= 0); assert.ok(reply.elapsed >= reply.firstTokenMs);
  assert.equal(app.elements.get('live-announcement').textContent, 'Generation stopped.');
  assert.equal(stop.hidden, true); assert.equal(send.disabled, false);
  assert.equal(send.getAttribute('aria-label'), 'Send message');
  assert.equal(app.elements.get('message-input').value, 'Keep my next prompt');
  assert.deepEqual(app.state('composer().attachments'), [draftFile]);
  assert.deepEqual(app.state('currentChat.messages.at(-2).attachments'), [sentFile]);
  assert.deepEqual(app.state('currentChat.messages.slice(0,2).map(message => message.id)'), ['old-user', 'old-reply']);
  const saved = JSON.parse(app.storage.get('relay.workspace.v1')).chats[0];
  assert.equal(saved.messages.at(-1).status, 'interrupted');
  assert.equal(saved.messages.at(-1).content, 'Partial text kept.');
  assert.equal(saved.messages.at(-1).usage.totalTokens, 10);
  assert.equal(saved.composer.text, 'Keep my next prompt'); assert.deepEqual(saved.composer.attachments, [draftFile]);
});

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
