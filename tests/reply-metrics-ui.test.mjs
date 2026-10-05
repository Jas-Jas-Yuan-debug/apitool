// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './support/app-harness.mjs';
import { summarizeReplyMetrics } from '../public/metrics.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const encode = new TextEncoder();
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cEZkAAAAASUVORK5CYII=';
const initialState = (webSearch = false) => ({ config: { baseUrl: 'https://provider.example/v1', model: 'test-model', modelMode: 'custom', protocol: 'chat', effort: 'high', webSearch }, chats: [] });

function gatedApp({ state = initialState(), workspaceStorage } = {}) {
  let now = 100;
  const streams = [], requests = [];
  const app = harness(async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(new ReadableStream({
      start(controller) {
        streams.push(controller);
        options.signal.addEventListener('abort', () => controller.error(new Error('Stopped by user')), { once: true });
      },
    }));
  }, { initialState: state, workspaceStorage });
  app.inject('performance', { now: () => now });
  return {
    app, requests,
    at(value) { now = value; },
    async emit(value, event) {
      now = value;
      streams.at(-1).enqueue(encode.encode(`data: ${JSON.stringify(event)}\n\n`));
      await tick();
    },
  };
}

function type(app, value) {
  const input = app.elements.get('message-input'); input.value = value; input.listeners.input({ target: input });
}
function rows(app) {
  const reply = app.elements.get('messages').children.at(-1);
  const table = reply.querySelector('table');
  assert.ok(table, 'assistant footer exposes a metrics table');
  assert.equal(table.getAttribute('aria-label'), 'Token usage and response timings');
  return Object.fromEntries(table.querySelector('tbody').children.map(row => [row.children[0].textContent, row.children.slice(1).map(cell => cell.textContent)]));
}
function stored(app) { return JSON.parse(app.storage.get('relay.workspace.v1')); }
const fullUsage = (inputTokens, outputTokens) => ({
  type: 'usage', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
  usageCoverage: { providerCalls: 1, inputCalls: 1, outputCalls: 1, totalCalls: 1 },
});

test('first-answer latency ignores metadata, reasoning, searches and empty deltas, then remains fixed', async () => {
  const flow = gatedApp({ state: initialState(true) }); const { app } = flow;
  type(app, 'Answer with sources');
  const pending = app.run('sendMessage()'); await tick();
  await flow.emit(200, { type: 'meta', model: 'test-model', protocol: 'chat' });
  await flow.emit(500, { type: 'reasoning', text: 'Provider reasoning' });
  await flow.emit(700, { type: 'search', callId: 's1', query: 'source query', status: 'searching' });
  await flow.emit(800, { type: 'delta', text: '' });
  await flow.emit(900, { type: 'search', callId: 's1', query: 'source query', status: 'complete', resultCount: 1 });
  assert.equal(app.run('currentChat.messages.at(-1).firstTokenMs'), undefined);
  assert.equal(app.elements.get('messages').children.at(-1).querySelector('table'), null, 'final metrics appear after the attempt ends');
  await flow.emit(1100, { type: 'delta', text: 'First answer ' });
  assert.equal(app.run('currentChat.messages.at(-1).firstTokenMs'), 1000);
  await flow.emit(2100, { type: 'delta', text: 'then continuation.' });
  assert.equal(app.run('currentChat.messages.at(-1).firstTokenMs'), 1000);
  await flow.emit(4100, { type: 'done' }); await pending;
  assert.equal(app.run('currentChat.messages.at(-1).elapsed'), 4000);
  const savedReply = stored(app).chats[0].messages.at(-1);
  assert.equal(savedReply.firstTokenMs, 1000); assert.equal(savedReply.elapsed, 4000);
});

test('completed reply footer shows input output total counts and all four comparable speeds', async () => {
  const flow = gatedApp(); const { app } = flow;
  type(app, 'Give an answer'); const pending = app.run('sendMessage()'); await tick();
  await flow.emit(1100, { type: 'delta', text: 'Visible answer' });
  await flow.emit(3900, fullUsage(100, 60));
  assert.equal(app.elements.get('messages').children.at(-1).querySelector('table'), null, 'unfinished elapsed time has no final metrics footer');
  await flow.emit(4100, { type: 'done' }); await pending;
  assert.deepEqual(rows(app), {
    Tokens: ['160 total · 100 in · 60 out', '160 total · 100 in · 60 out'],
    '首字延迟 · first text': ['1.00 s', '1.00 s'],
    'Total time': ['4.00 s', '4.00 s'],
    'tok/s · excluding delay': ['20.00 tok/s', '20.00 tok/s'],
    'tok/s · including delay': ['15.00 tok/s', '15.00 tok/s'],
  });
});

test('partial multi-call usage stays visibly partial and cannot become a misleading speed', async () => {
  const flow = gatedApp({ state: initialState(true) }); const { app } = flow;
  type(app, 'Search before answering'); const pending = app.run('sendMessage()'); await tick();
  await flow.emit(1100, { type: 'delta', text: 'Answer using the available results' });
  await flow.emit(3900, {
    type: 'usage', usage: { inputTokens: 90 }, usageKnown: { inputTokens: 90, outputTokens: 20 },
    usageCoverage: { providerCalls: 3, inputCalls: 3, outputCalls: 1, totalCalls: 0 },
  });
  await flow.emit(4100, { type: 'done' }); await pending;
  assert.deepEqual(rows(app).Tokens, ['N/A total · 90 in · 20 (partial) out', 'N/A total · 90 in · 20 (partial) out']);
  assert.deepEqual(rows(app)['tok/s · excluding delay'], ['N/A', 'N/A']);
  assert.deepEqual(rows(app)['tok/s · including delay'], ['N/A', 'N/A']);
  const refreshed = harness(async () => {}, { initialState: stored(app), defaultConnection: false });
  assert.deepEqual(rows(refreshed).Tokens, rows(app).Tokens);
  assert.deepEqual(refreshed.state('currentChat.messages.at(-1).usageKnown'), { inputTokens: 90, outputTokens: 20 });
  assert.equal(refreshed.elements.get('api-key').value, '');
});

test('absent usage and absent coverage show N/A or partial counts rather than inferred tokens', async () => {
  for (const usageEvent of [null, { type: 'usage', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } }]) {
    const flow = gatedApp({ state: initialState(true) }); const { app } = flow;
    type(app, 'A tiny answer'); const pending = app.run('sendMessage()'); await tick();
    await flow.emit(1100, { type: 'delta', text: 'Two visible words' });
    if (usageEvent) await flow.emit(3900, usageEvent);
    await flow.emit(4100, { type: 'done' }); await pending;
    const count = usageEvent ? '6 (partial) total · 4 (partial) in · 2 (partial) out' : 'N/A total · N/A in · N/A out';
    assert.deepEqual(rows(app).Tokens, [count, count]);
    assert.deepEqual(rows(app)['tok/s · including delay'], ['N/A', 'N/A']);
    assert.deepEqual(rows(app)['tok/s · excluding delay'], ['N/A', 'N/A']);
  }
});

test('ordinary one-call usage without an agent coverage field still exposes exact provider throughput', async () => {
  const flow = gatedApp(); const { app } = flow;
  type(app, 'Answer directly'); const pending = app.run('sendMessage()'); await tick();
  await flow.emit(1100, { type: 'delta', text: 'Answer' });
  await flow.emit(4100, { type: 'done', usage: { inputTokens: 8, outputTokens: 6, totalTokens: 14 } }); await pending;
  assert.deepEqual(rows(app).Tokens, ['14 total · 8 in · 6 out', '14 total · 8 in · 6 out']);
  assert.deepEqual(rows(app)['tok/s · excluding delay'], ['2.00 tok/s', '2.00 tok/s']);
  assert.deepEqual(rows(app)['tok/s · including delay'], ['1.50 tok/s', '1.50 tok/s']);
});

test('stopped and failed attempts retain observed latency and terminal elapsed time', async () => {
  for (const ending of ['stop', 'error']) {
    const flow = gatedApp(); const { app } = flow;
    type(app, 'Keep the partial answer'); const pending = app.run('sendMessage()'); await tick();
    await flow.emit(600, { type: 'delta', text: 'Partial answer' });
    if (ending === 'stop') { flow.at(2100); app.run('stopGeneration()'); }
    else await flow.emit(2100, { type: 'error', message: 'Provider unavailable' });
    await pending;
    assert.equal(app.run('currentChat.messages.at(-1).status'), ending === 'stop' ? 'interrupted' : 'error');
    assert.equal(app.run('currentChat.messages.at(-1).firstTokenMs'), 500);
    assert.equal(app.run('currentChat.messages.at(-1).elapsed'), 2000);
    assert.deepEqual(rows(app)['Total time'], ['2.00 s', '2.00 s']);
    assert.deepEqual(rows(app)['tok/s · including delay'], ['N/A', 'N/A']);
    const refreshed = harness(async () => {}, { initialState: stored(app), defaultConnection: false });
    assert.deepEqual(rows(refreshed)['首字延迟 · first text'], ['500 ms', '500 ms']);
    assert.equal(refreshed.run('currentChat.messages.at(-1).status'), ending === 'stop' ? 'interrupted' : 'error');
  }
});

test('repeated regeneration archives each attempt once and preserves the prompt and pending draft files', async () => {
  const flow = gatedApp(); const { app } = flow;
  type(app, 'Original user prompt'); let pending = app.run('sendMessage()'); await tick();
  await flow.emit(1100, { type: 'delta', text: 'Original answer' });
  await flow.emit(3900, fullUsage(100, 60)); await flow.emit(4100, { type: 'done' }); await pending;
  const originalId = app.run('currentChat.messages.at(-1).id');
  const pendingFile = { id: 'pending', name: 'later.txt', kind: 'text', type: 'text/plain', size: 5, text: 'later' };
  app.inject('pendingFile', pendingFile); app.run('composer().attachments = [pendingFile]'); type(app, 'Pending next question');
  flow.at(5100); pending = app.run('sendMessage(true)'); await tick();
  assert.deepEqual(app.state('currentChat.metricsHistory.map(item => item.id)'), [originalId]);
  assert.deepEqual(flow.requests[1].messages, [{ role: 'user', content: 'Original user prompt' }]);
  await flow.emit(5600, { type: 'delta', text: 'Replacement answer' });
  await flow.emit(6900, fullUsage(80, 40)); await flow.emit(7100, { type: 'done' }); await pending;
  assert.deepEqual(rows(app).Tokens, ['120 total · 80 in · 40 out', '280 total · 180 in · 100 out']);
  assert.deepEqual(rows(app)['首字延迟 · first text'], ['500 ms', '1.50 s']);
  assert.deepEqual(rows(app)['Total time'], ['2.00 s', '6.00 s']);
  assert.deepEqual(rows(app)['tok/s · excluding delay'], ['26.67 tok/s', '22.22 tok/s']);
  assert.deepEqual(rows(app)['tok/s · including delay'], ['20.00 tok/s', '16.67 tok/s']);
  assert.equal(app.elements.get('message-input').value, 'Pending next question');
  assert.deepEqual(app.state('composer().attachments'), [pendingFile]);

  const replacementId = app.run('currentChat.messages.at(-1).id');
  flow.at(8100); pending = app.run('sendMessage(true)'); await tick();
  await flow.emit(9100, { type: 'delta', text: 'Third answer' });
  await flow.emit(9900, fullUsage(20, 10)); await flow.emit(10100, { type: 'done' }); await pending;
  assert.deepEqual(app.state('currentChat.metricsHistory.map(item => item.id)'), [originalId, replacementId]);
  assert.equal(app.run('currentChat.messages.filter(message => message.role === "user").length'), 1);
  assert.equal(app.run('currentChat.messages[0].content'), 'Original user prompt');
  assert.deepEqual(rows(app).Tokens, ['30 total · 20 in · 10 out', '310 total · 200 in · 110 out']);
  const refreshed = harness(async () => {}, { initialState: stored(app), defaultConnection: false });
  assert.deepEqual(rows(refreshed), rows(app));
  assert.equal(refreshed.elements.get('message-input').value, 'Pending next question');
  assert.deepEqual(refreshed.state('composer().attachments'), [pendingFile]);
});

test('regenerated metric archives whitelist numeric evidence without content credentials or images and survive durable refresh', async () => {
  let durable;
  const retired = {
    id: 'retired-image', role: 'assistant', content: 'Retired private-looking fixture text', reasoning: 'Retired reasoning fixture', status: 'complete',
    elapsed: 4000, task: 'image', images: [{ dataUrl: PNG }], imagePreview: { dataUrl: PNG }, sources: [{ title: 'Source', url: 'https://example.org' }],
    apiKey: 'fixture-credential-only', authorization: 'fixture-authorization-only', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, apiKey: 'fixture-nested-only' },
    usageCoverage: { providerCalls: 1, inputCalls: 1, outputCalls: 1, totalCalls: 1 },
  };
  const state = { ...initialState(), activeChatId: 'existing', chats: [{ id: 'existing', title: 'Keep original request', messages: [{ id: 'user', role: 'user', content: 'Original image request', status: 'complete' }, retired] }] };
  const flow = gatedApp({ state, workspaceStorage: { save: async value => { durable = value; return true; } } }); const { app } = flow;
  type(app, 'Keep my next draft'); const pending = app.run('sendMessage(true)'); await tick();
  await flow.emit(1100, { type: 'delta', text: 'New text answer' });
  await flow.emit(3900, fullUsage(10, 6)); await flow.emit(4100, { type: 'done' }); await pending;
  const history = stored(app).chats[0].metricsHistory;
  assert.deepEqual(history, [{ id: 'retired-image', role: 'assistant', status: 'complete', elapsed: 4000, task: 'image', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, usageCoverage: { providerCalls: 1, inputCalls: 1, outputCalls: 1, totalCalls: 1 } }]);
  assert.ok(!JSON.stringify(history).includes('fixture'));
  assert.ok(!JSON.stringify(history).includes('data:'));
  assert.ok(!app.storage.get('relay.workspace.v1').includes('test-key'));
  assert.deepEqual(JSON.parse(JSON.stringify(durable.chats[0].metricsHistory)), history);
  const refreshed = harness(async () => {}, { workspaceStorage: { load: async () => durable }, defaultConnection: false });
  await tick();
  assert.deepEqual(refreshed.state('currentChat.metricsHistory'), history);
  assert.equal(refreshed.elements.get('message-input').value, 'Keep my next draft');
  assert.equal(refreshed.elements.get('api-key').value, '');
  assert.equal(summarizeReplyMetrics(refreshed.state('currentChat.messages.at(-1)'), [...history, ...refreshed.state('currentChat.messages')]).conversation.totalTokens, 21);
});

test('conversation usage survives refresh when failed attempts make visible history exceed the storage limit', async () => {
  const messages = [];
  for (let index = 0; index < 249; index++) {
    messages.push({ id: `old-user-${index}`, role: 'user', content: `Earlier question ${index}`, status: 'complete' });
    messages.push({
      id: `old-assistant-${index}`, role: 'assistant', content: index === 0 ? 'Earlier completed answer' : '', status: index === 0 ? 'complete' : 'error',
      elapsed: 1000, firstTokenMs: 100, ...fullUsage(index === 0 ? 60 : 0, index === 0 ? 40 : 0),
    });
  }
  const state = { ...initialState(), activeChatId: 'long-chat', chats: [{ id: 'long-chat', title: 'Retained failed attempts', messages }] };
  const flow = gatedApp({ state }); const { app } = flow;
  for (let index = 0; index < 2; index++) {
    const start = 100 + index * 5000;
    flow.at(start); type(app, `Next question ${index}`);
    const pending = app.run('sendMessage()'); await tick();
    await flow.emit(start + 1000, { type: 'delta', text: 'New answer' });
    await flow.emit(start + 3900, fullUsage(6, 4)); await flow.emit(start + 4000, { type: 'done' }); await pending;
  }
  const before = summarizeReplyMetrics(app.state('currentChat.messages.at(-1)'), [...app.state('currentChat.metricsHistory || []'), ...app.state('currentChat.messages')]).conversation;
  assert.equal(before.totalTokens, 120); assert.equal(before.complete.totalTokens, true);
  const refreshed = harness(async () => {}, { initialState: stored(app), defaultConnection: false });
  const after = summarizeReplyMetrics(refreshed.state('currentChat.messages.at(-1)'), [...refreshed.state('currentChat.metricsHistory || []'), ...refreshed.state('currentChat.messages')]).conversation;
  assert.equal(after.totalTokens, before.totalTokens, 'retired visible attempts must keep their numeric evidence when storage trims messages');
  assert.equal(after.complete.totalTokens, true);
  assert.equal(after.elapsedMs, before.elapsedMs);
  assert.equal(after.firstTokenMs, before.firstTokenMs);
});
