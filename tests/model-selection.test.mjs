// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, completed, html } from './support/app-harness.mjs';

function modelFixture(models, options = {}) {
  const requests = [];
  const app = harness(async (url, request) => {
    requests.push({ url, body: JSON.parse(request.body) });
    return url === '/api/models' ? new Response(JSON.stringify({ models })) : completed('Answer');
  }, { defaultConnection: false, ...options });
  app.setConnection();
  return { app, requests };
}
const catalog = app => app.elements.get('model-select').options.filter(option => option.value.startsWith('id:')).map(option => option.value.slice(3));
async function send(app, prompt = 'Question') { app.elements.get('message-input').value = prompt; await app.run('sendMessage()'); }

test('model chooser uses an explicitly labeled native select with an independent custom input', () => {
  assert.match(html, /<label\b[^>]*for="model-select"[^>]*>[\s\S]*?Model<\/label>/);
  assert.match(html, /<select\b[^>]*id="model-select"/);
  assert.doesNotMatch(html, /<datalist\b|<input\b[^>]*\blist=/);
  assert.match(html, /<label\b[^>]*for="model-input"[^>]*>Custom model ID<\/label>/);
  assert.match(html, /<input\b[^>]*id="model-input"[^>]*maxlength="256"/);
});

test('every loaded model remains a selectable catalog option', async () => {
  const ids = ['alpha-chat', 'beta-chat', 'embedding-only', 'provider/model-v2', '模型-测试'];
  const { app } = modelFixture(ids);
  await app.run('loadModels()');
  assert.deepEqual(catalog(app), ids);
  assert.equal(app.elements.get('model-select').options.at(-1).value, 'custom:');
});

test('choosing the second listed model sends that exact model ID', async () => {
  const { app, requests } = modelFixture(['alpha-chat', 'beta-chat']);
  await app.run('loadModels()');
  app.chooseModel('beta-chat');
  await send(app);
  assert.equal(requests.at(-1).body.model, 'beta-chat');
  assert.equal(app.state('currentChat.messages').at(-1).model, 'beta-chat');
});

test('automatic selection does not filter alternatives when the model chooser is reused', async () => {
  const { app } = modelFixture(['alpha-chat', 'beta-chat', 'gamma-chat']);
  await app.run('loadModels()');
  assert.equal(app.run('currentModel()'), 'alpha-chat');
  app.chooseModel('gamma-chat');
  assert.deepEqual(catalog(app), ['alpha-chat', 'beta-chat', 'gamma-chat']);
  app.chooseModel('beta-chat');
  assert.equal(app.run('currentModel()'), 'beta-chat');
});

test('the selected catalog model is indicated and persisted through the same control', async () => {
  const { app } = modelFixture(['alpha-chat', 'beta-chat']);
  await app.run('loadModels()');
  app.chooseModel('beta-chat');
  assert.equal(app.elements.get('model-select').value, 'id:beta-chat');
  assert.equal(app.elements.get('custom-model-wrap').hidden, true);
  assert.equal(JSON.parse(app.storage.get('relay.workspace.v1')).config.model, 'beta-chat');
  assert.match(app.elements.get('model-help').textContent, /beta-chat/);
});

test('namespaced Unicode and reserved-looking model IDs reach the provider unchanged', async () => {
  const ids = ['provider/模型:version-2', 'custom:', 'id:model'];
  const { app, requests } = modelFixture(ids);
  await app.run('loadModels()');
  for (const id of ids) { app.chooseModel(id); await send(app); assert.equal(requests.at(-1).body.model, id); }
  assert.deepEqual(catalog(app), ids);
});

test('an empty model list exposes custom entry and allows a message', async () => {
  const { app, requests } = modelFixture([]);
  await app.run('loadModels()');
  assert.equal(app.elements.get('model-select').value, 'custom:');
  assert.equal(app.elements.get('custom-model-wrap').hidden, false);
  assert.match(app.elements.get('model-help').textContent, /no models|not.*listed/i);
  app.chooseModel('unlisted-model', { custom: true });
  await send(app);
  assert.equal(requests.at(-1).body.model, 'unlisted-model');
});

test('reloading an overlapping provider list preserves the selected model and all alternatives', async () => {
  const { app } = modelFixture(['alpha-chat', 'beta-chat']);
  await app.run('loadModels()');
  app.chooseModel('beta-chat');
  await app.run('loadModels()');
  assert.equal(app.elements.get('model-select').value, 'id:beta-chat');
  assert.deepEqual(catalog(app), ['alpha-chat', 'beta-chat']);
});

test('a 256-character valid catalog ID is sent in full', async () => {
  const id = 'provider/' + 'm'.repeat(247);
  assert.equal(id.length, 256);
  const { app, requests } = modelFixture(['short-model', id]);
  await app.run('loadModels()');
  app.chooseModel(id);
  await send(app);
  assert.equal(requests.at(-1).body.model, id);
});

test('a custom model can send without any model discovery request', async () => {
  const { app, requests } = modelFixture([]);
  app.chooseModel('  custom-provider/model  ', { custom: true });
  await send(app);
  assert.deepEqual(requests.map(request => request.url), ['/api/chat']);
  assert.equal(requests[0].body.model, 'custom-provider/model');
});

test('switching from custom to catalog hides the custom field and sends the listed choice', async () => {
  const { app, requests } = modelFixture(['listed-model']);
  app.chooseModel('manual-model', { custom: true });
  await app.run('loadModels()');
  app.chooseModel('listed-model');
  assert.equal(app.elements.get('custom-model-wrap').hidden, true);
  await send(app);
  assert.equal(requests.at(-1).body.model, 'listed-model');
});

test('switching from catalog to custom exposes the input and sends the custom choice', async () => {
  const { app, requests } = modelFixture(['listed-model']);
  await app.run('loadModels()');
  app.chooseModel('custom-model', { custom: true });
  assert.equal(app.elements.get('custom-model-wrap').hidden, false);
  await send(app);
  assert.equal(requests.at(-1).body.model, 'custom-model');
});

test('slow model discovery preserves a custom ID entered after the request began', async () => {
  let resolve;
  const app = harness(() => new Promise(done => { resolve = done; }), { defaultConnection: false });
  app.setConnection();
  const pending = app.run('loadModels()');
  app.chooseModel('new-custom-choice', { custom: true });
  resolve(new Response(JSON.stringify({ models: ['automatic-choice'] })));
  await pending;
  assert.equal(app.elements.get('model-select').value, 'custom:');
  assert.equal(app.run('currentModel()'), 'new-custom-choice');
  assert.deepEqual(catalog(app), ['automatic-choice']);
});

test('automatic model selection avoids obvious non-chat IDs and does not select from a non-chat-only list', async () => {
  const first = modelFixture(['embedding-small', 'image-model', 'chat-model']).app;
  await first.run('loadModels()');
  assert.equal(first.run('currentModel()'), 'chat-model');
  const second = modelFixture(['embedding-small', 'tts-model', 'image-model']).app;
  await second.run('loadModels()');
  assert.equal(second.run('currentModel()'), '');
  assert.equal(catalog(second).length, 3);
});

test('invalid discovery IDs are removed while padded duplicates normalize to one usable option', async () => {
  const { app } = modelFixture(['', '   ', 'valid-model', ' valid-model ', 'valid-model', null, 7, 'bad\nmodel', 'x'.repeat(257)]);
  await app.run('loadModels()');
  assert.deepEqual(catalog(app), ['valid-model']);
  assert.equal(app.run('currentModel()'), 'valid-model');
});

test('a saved model absent from discovery has an explicit custom state and explanation', async () => {
  const { app, requests } = modelFixture(['available-model'], { initialState: { config: { model: 'saved-model', modelMode: 'catalog' }, chats: [] } });
  assert.equal(app.elements.get('model-select').value, 'id:saved-model');
  await app.run('loadModels()');
  assert.equal(app.elements.get('model-select').value, 'custom:');
  assert.equal(app.elements.get('custom-model-wrap').hidden, false);
  assert.equal(app.run('currentModel()'), 'saved-model');
  assert.match(app.elements.get('model-help').textContent, /previous model.*not.*list/i);
  await send(app);
  assert.equal(requests.at(-1).body.model, 'saved-model');
});

test('changing the API key aborts discovery and ignores its stale list while retaining the chosen ID', async () => {
  let resolve;
  let signal;
  const app = harness((_url, options) => { signal = options.signal; return new Promise(done => { resolve = done; }); });
  const pending = app.run('loadModels()');
  app.elements.get('api-key').value = 'new-key';
  app.elements.get('api-key').listeners.input();
  assert.equal(signal.aborted, true);
  resolve(new Response(JSON.stringify({ models: ['stale-model'] })));
  await pending;
  assert.equal(app.run('currentModel()'), 'test-model');
  assert.equal(catalog(app).includes('stale-model'), false);
  assert.equal(app.elements.get('connection-label').textContent, 'Not tested');
  assert.equal(app.elements.get('load-models').disabled, false);
});

test('failed model discovery removes stale alternatives and offers a working custom fallback', async () => {
  let discoveries = 0;
  const requests = [];
  const app = harness(async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    if (url === '/api/chat') return completed('Manual answer');
    return ++discoveries === 1 ? new Response(JSON.stringify({ models: ['alpha', 'beta'] })) : new Response(JSON.stringify({ error: 'Listing unavailable' }), { status: 404 });
  }, { defaultConnection: false });
  app.setConnection();
  await app.run('loadModels()');
  await app.run('loadModels()');
  assert.deepEqual(catalog(app), ['alpha']);
  assert.equal(app.state('modelIds').length, 0);
  assert.match(app.elements.get('model-select').options.find(option => option.value === 'id:alpha').textContent, /saved.*reload/i);
  assert.equal(app.elements.get('connection-label').textContent, 'List unavailable');
  assert.equal(app.elements.get('use-custom-model').hidden, false);
  app.elements.get('use-custom-model').listeners.click();
  app.chooseModel('manual-after-error', { custom: true });
  await send(app);
  assert.equal(requests.at(-1).body.model, 'manual-after-error');
});

test('blank custom model blocks submission without deleting the draft or adding a conversation', async () => {
  const { app, requests } = modelFixture([]);
  app.chooseModel('   ', { custom: true });
  await send(app, 'Keep this draft');
  assert.equal(requests.length, 0);
  assert.equal(app.elements.get('message-input').value, 'Keep this draft');
  assert.deepEqual(app.state('currentChat.messages'), []);
  assert.equal(app.focused, 'model-input');
});

test('overlong and control-character custom model IDs are rejected before clearing the draft', async () => {
  const { app, requests } = modelFixture([]);
  for (const id of ['x'.repeat(257), 'bad\u0000model']) {
    app.chooseModel(id, { custom: true });
    await send(app, 'Keep this draft');
    assert.equal(requests.length, 0);
    assert.equal(app.elements.get('message-input').value, 'Keep this draft');
    assert.deepEqual(app.state('currentChat.messages'), []);
    assert.match(app.elements.get('toast').textContent, /256.*control/i);
  }
});
