// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, completed, html } from './support/app-harness.mjs';
import { conversationMessages, readSavedState, stateForStorage, sanitizeSearches } from '../public/client.js';

const source = { title: 'Mars fact sheet', url: 'https://example.com/mars', snippet: 'Mars has an iron oxide surface.' };
const file = { id: 'saved-file', name: 'notes.txt', kind: 'text', type: 'text/plain', size: 5, text: 'notes' };
const legacySearch = { query: 'earlier research', sources: [source], engine: 'Bing' };
function initialState(webSearch) {
  return {
    config: { baseUrl: 'https://provider.example/v1', model: 'test-model', modelMode: 'custom', effort: 'high', protocol: 'chat', systemPrompt: 'Answer clearly', ...(typeof webSearch === 'boolean' ? { webSearch } : {}) },
    activeChatId: 'keep', savedAt: 1000,
    chats: [{ id: 'keep', title: 'Keep our chat', messages: [
      { id: 'old-user', role: 'user', content: 'Remember the earlier question', status: 'complete', attachments: [file], search: legacySearch },
      { id: 'old-answer', role: 'assistant', content: 'Earlier completed answer', status: 'complete', sources: [source] },
    ], composer: { text: 'Unsent follow-up', attachments: [file], search: legacySearch, searchQuery: legacySearch.query, searchOpen: true } }],
  };
}
function input(app, value) { const element = app.elements.get('message-input'); element.value = value; element.listeners.input?.({ target: element }); }
function events(...items) { return new Response(items.map(item => `data: ${JSON.stringify(item)}\n\n`).join('')); }
function liveResponse(signal) {
  let writer;
  const stream = new ReadableStream({ start(controller) { writer = controller; signal.addEventListener('abort', () => controller.error(new Error('Aborted')), { once: true }); } });
  return { response: new Response(stream), emit: event => writer.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)), close: () => writer.close() };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const persisted = app => JSON.parse(app.storage.get('relay.workspace.v1'));

// The toggle does not perform a search, submit a draft, or replace a conversation.
test('AI search defaults on for new and legacy users, and manual query controls stay hidden', () => {
  for (const state of [undefined, initialState()]) {
    const app = harness(() => { throw new Error('Toggle must not make network requests'); }, { initialState: state });
    assert.equal(app.state('config.webSearch'), true);
    assert.equal(app.elements.get('web-search-toggle').getAttribute('aria-pressed'), 'true');
    assert.equal(app.elements.get('web-search-setting').textContent, 'On');
    assert.equal(app.elements.get('web-search-panel').hidden, true);
  }
  assert.match(html, /AI web search/);
  assert.doesNotMatch(html, /Type a direct question or topic/);
});

test('AI search toggling and reload preserve chat, model, files, saved reference context and unsent draft', () => {
  const app = harness(() => { throw new Error('Toggle must not fetch'); }, { initialState: initialState() });
  const messages = app.state('currentChat.messages');
  const draft = app.state('composer()');
  const model = app.state('config.model');
  app.elements.get('web-search-toggle').click();
  assert.equal(app.state('config.webSearch'), false);
  assert.equal(app.elements.get('web-search-setting').textContent, 'Off');
  assert.deepEqual(app.state('currentChat.messages'), messages);
  assert.deepEqual(app.state('composer()'), draft);
  assert.equal(app.state('currentChat.id'), 'keep');
  const saved = persisted(app);
  assert.equal(saved.config.webSearch, false);
  assert.equal('apiKey' in saved.config, false);
  const restored = harness(() => {}, { initialState: saved, defaultConnection: false });
  assert.equal(restored.state('config.webSearch'), false);
  assert.equal(restored.state('config.model'), model);
  assert.deepEqual(restored.state('currentChat.messages'), messages);
  assert.deepEqual(restored.state('composer()'), draft);
  restored.elements.get('web-search-toggle').click();
  assert.equal(persisted(restored).config.webSearch, true);
  assert.deepEqual(restored.state('currentChat.messages'), messages);
});

test('send includes the explicit AI search permission while preserving model, effort, key and history', async () => {
  for (const enabled of [true, false]) {
    const requests = [];
    const app = harness(async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return completed('Follow-up answer'); }, { initialState: initialState(enabled) });
    input(app, 'Continue our discussion');
    await app.run('sendMessage()');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/api/chat');
    const request = requests[0].body;
    assert.equal(request.webSearch, enabled);
    assert.equal(request.model, 'test-model'); assert.equal(request.effort, 'high'); assert.equal(request.protocol, 'chat');
    assert.equal(request.baseUrl, 'https://provider.example/v1'); assert.equal(request.apiKey, 'test-key'); assert.equal(request.systemPrompt, 'Answer clearly');
    assert.equal(request.messages.length, 3);
    assert.equal(request.messages[0].attachments[0].text, 'notes');
    assert.match(request.messages[0].content, /Remember the earlier question/);
    assert.equal(request.messages[1].content, 'Earlier completed answer');
    assert.equal(app.state('currentChat.id'), 'keep');
    assert.deepEqual(app.state('currentChat.messages.slice(0,2).map(message => message.id)'), ['old-user', 'old-answer']);
  }
});

test('multiple autonomous search rounds show live activity and preserve reasoning, reply content, citations and draft', async () => {
  let live;
  const app = harness(async (_url, options) => { live = liveResponse(options.signal); return live.response; }, { initialState: initialState(true) });
  input(app, 'Find current facts about Mars');
  const pending = app.run('sendMessage()'); await settle();
  live.emit({ type: 'reasoning', text: 'I will check a source.' });
  live.emit({ type: 'search', status: 'searching', callId: 'first', searchIndex: 1, query: 'Mars iron oxide' }); await settle();
  assert.equal(app.state('currentChat.messages.at(-1).searches[0].status'), 'searching');
  const activity = app.elements.get('messages').querySelectorAll('div').find(item => item.className === 'search-activity');
  assert.ok(activity); assert.match(activity.children[0].children[1].textContent, /Searching the web: Mars iron oxide/);
  input(app, 'Keep this draft while the AI researches');
  live.emit({ type: 'search', status: 'complete', callId: 'first', searchIndex: 1, query: 'Mars iron oxide', resultCount: 1 });
  live.emit({ type: 'sources', sources: [source, { title: 'Unsafe source', url: 'javascript:alert(1)' }] });
  live.emit({ type: 'delta', text: 'Mars is red. ' });
  live.emit({ type: 'search', status: 'searching', callId: 'second', searchIndex: 2, query: 'Mars iron oxide' });
  live.emit({ type: 'search', status: 'complete', callId: 'second', searchIndex: 2, query: 'Mars iron oxide', resultCount: 1 });
  live.emit({ type: 'delta', text: '[Read the fact sheet](https://example.com/mars).' });
  live.emit({ type: 'done' }); await pending;
  const reply = app.state('currentChat.messages.at(-1)');
  assert.equal(reply.status, 'complete');
  assert.equal(reply.reasoning, 'I will check a source.');
  assert.match(reply.content, /^Mars is red\. \[Read the fact sheet\]/);
  assert.deepEqual(reply.searches.map(search => [search.callId, search.status]), [['first', 'complete'], ['second', 'complete']]);
  assert.deepEqual(reply.sources, [source]);
  assert.equal(app.elements.get('message-input').value, 'Keep this draft while the AI researches');
  const restored = readSavedState({ getItem: () => JSON.stringify(persisted(app)) });
  assert.deepEqual(restored.chats[0].messages.at(-1).searches, reply.searches);
  assert.deepEqual(restored.chats[0].messages.at(-1).sources, [source]);
  assert.equal(restored.chats[0].composer.text, 'Keep this draft while the AI researches');
  assert.deepEqual(restored.chats[0].messages.slice(0,2).map(message => message.id), ['old-user', 'old-answer']);
});

test('changing the AI search toggle during a reply only affects future messages', async () => {
  let live, request, signal;
  const app = harness(async (_url, options) => { request = JSON.parse(options.body); signal = options.signal; live = liveResponse(signal); return live.response; }, { initialState: initialState() });
  const pending = app.run('sendMessage()'); await settle();
  live.emit({ type: 'search', status: 'searching', callId: 'active', query: 'Mars sources' }); await settle();
  const messagesBefore = app.state('currentChat.messages');
  input(app, 'Draft for the next turn');
  app.elements.get('web-search-toggle').click();
  assert.equal(request.webSearch, true); assert.equal(signal.aborted, false); assert.equal(app.state('config.webSearch'), false);
  assert.deepEqual(app.state('currentChat.messages'), messagesBefore);
  assert.equal(app.elements.get('message-input').value, 'Draft for the next turn');
  live.emit({ type: 'search', status: 'complete', callId: 'active', query: 'Mars sources', resultCount: 1 });
  live.emit({ type: 'delta', text: 'Research completed.' }); live.emit({ type: 'done' }); await pending;
  assert.equal(app.state('currentChat.messages.at(-1).status'), 'complete');
  assert.equal(persisted(app).config.webSearch, false);
  assert.equal(persisted(app).chats[0].composer.text, 'Draft for the next turn');
});

test('search budget notice keeps the assistant streaming toward a final answer without changing chat or draft', async () => {
  let live;
  const app = harness(async (_url, options) => { live = liveResponse(options.signal); return live.response; }, { initialState: initialState() });
  const pending = app.run('sendMessage()'); await settle();
  live.emit({ type: 'search', status: 'complete', callId: 'collected', query: 'Mars data', resultCount: 1 });
  live.emit({ type: 'sources', sources: [source] });
  live.emit({ type: 'delta', text: 'The available data says ' }); await settle();
  input(app, 'Keep this unsent question');
  const beforeNotice = app.state('currentChat.messages');
  live.emit({ type: 'notice', code: 'search_limit', message: 'Unexpected raw text must not be displayed or saved', apiKey: 'must-not-store' }); await settle();
  const reply = app.state('currentChat.messages.at(-1)');
  assert.equal(reply.status, 'streaming'); assert.equal(reply.notice, 'search_limit'); assert.equal(reply.error, '');
  assert.equal(reply.content, beforeNotice.at(-1).content);
  assert.deepEqual(reply.searches, beforeNotice.at(-1).searches); assert.deepEqual(reply.sources, beforeNotice.at(-1).sources);
  const notice = app.elements.get('messages').querySelectorAll('div').find(item => item.className === 'generation-notice');
  assert.equal(notice.textContent, 'Finishing with the sources already collected.');
  assert.equal(app.elements.get('live-announcement').textContent, notice.textContent);
  assert.equal(app.elements.get('message-input').value, 'Keep this unsent question');
  live.emit({ type: 'delta', text: 'Mars is red.' }); live.emit({ type: 'done' }); await pending;
  const finalReply = app.state('currentChat.messages.at(-1)');
  assert.equal(finalReply.status, 'complete'); assert.equal(finalReply.content, 'The available data says Mars is red.');
  assert.equal(finalReply.notice, 'search_limit'); assert.equal(finalReply.error, '');
  assert.deepEqual(app.state('currentChat.messages.slice(0,2).map(message => message.id)'), ['old-user', 'old-answer']);
  const state = persisted(app);
  assert.equal(JSON.stringify(state).includes('Unexpected raw text'), false); assert.equal(JSON.stringify(state).includes('must-not-store'), false);
  const restored = harness(() => {}, { initialState: state, defaultConnection: false });
  assert.equal(restored.state('currentChat.messages.at(-1).notice'), 'search_limit');
  assert.equal(restored.elements.get('message-input').value, 'Keep this unsent question');
  assert.equal(restored.elements.get('messages').querySelectorAll('div').find(item => item.className === 'generation-notice').textContent, 'Finished with the available web results.');
});

test('stopping budget finalization keeps the notice and existing sources without claiming completion', async () => {
  let live;
  const app = harness(async (_url, options) => { live = liveResponse(options.signal); return live.response; }, { initialState: initialState() });
  const pending = app.run('sendMessage()'); await settle();
  live.emit({ type: 'notice', code: 'search_limit' }); await settle();
  input(app, 'My draft stays'); app.run('stopGeneration()'); await pending;
  assert.equal(app.state('currentChat.messages.at(-1).status'), 'interrupted');
  assert.equal(app.state('currentChat.messages.at(-1).notice'), 'search_limit');
  assert.equal(app.elements.get('message-input').value, 'My draft stays');
  const notice = app.elements.get('messages').querySelectorAll('div').find(item => item.className === 'generation-notice');
  assert.equal(notice.textContent, 'Stopped while finishing the answer.');
  const restored = readSavedState({ getItem: () => JSON.stringify(persisted(app)) });
  assert.equal(restored.chats[0].messages.at(-1).notice, 'search_limit');
  assert.equal(restored.chats[0].messages.at(-1).status, 'interrupted');
});

test('cached search results are labeled as reused, preserved in storage and included in follow-up source context', async () => {
  const app = harness(async () => events(
    { type: 'search', status: 'complete', callId: 'fresh', query: 'Mars data', resultCount: 1 },
    { type: 'search', status: 'complete', callId: 'cached', query: 'Mars data', resultCount: 1, cached: true },
    { type: 'sources', sources: [source] },
    { type: 'delta', text: 'Answer from available sources' }, { type: 'done' },
  ), { initialState: initialState() });
  await app.run('sendMessage()');
  const reply = app.state('currentChat.messages.at(-1)');
  assert.equal(reply.searches[1].cached, true); assert.equal('cached' in reply.searches[0], false);
  const activity = app.elements.get('messages').querySelectorAll('div').find(item => item.className === 'search-activity');
  assert.match(activity.children[0].children[1].textContent, /^Searched the web/);
  assert.match(activity.children[1].children[1].textContent, /^Reused earlier web search/);
  assert.equal(activity.children.filter(item => item.className.includes('searching')).length, 0);
  const restored = readSavedState({ getItem: () => JSON.stringify(persisted(app)) });
  assert.equal(restored.chats[0].messages.at(-1).searches[1].cached, true);
  assert.match(conversationMessages(restored.chats[0].messages).at(-1).content, /https:\/\/example\.com\/mars/);
  assert.equal('cached' in sanitizeSearches([{ query: 'wrong flag', status: 'complete', cached: 'true' }])[0], false);
});

test('unknown notices and raw notice fields are discarded instead of becoming saved assistant data', async () => {
  const app = harness(async () => events({ type: 'notice', code: 'unexpected', message: 'private text', apiKey: 'private-key' }, { type: 'delta', text: 'Normal answer' }, { type: 'done' }), { initialState: initialState() });
  await app.run('sendMessage()');
  assert.equal('notice' in app.state('currentChat.messages.at(-1)'), false);
  const state = stateForStorage({}, [{ id: 'notice', messages: [{ role: 'assistant', content: 'Answer', status: 'complete', notice: { code: 'search_limit', apiKey: 'private-key' } }] }]);
  assert.equal('notice' in state.chats[0].messages[0], false); assert.equal(JSON.stringify(state).includes('private-key'), false);
  assert.equal('notice' in readSavedState({ getItem: () => JSON.stringify({ chats: [{ id: 'unknown', messages: [{ role: 'assistant', content: 'Keep this', status: 'complete', notice: 'unknown' }] }] }) }).chats[0].messages[0], false);
});

test('a search error remains visible while the model retries and completes an honest answer', async () => {
  const app = harness(async () => events(
    { type: 'search', status: 'searching', callId: 'failed', query: 'initial query' },
    { type: 'search', status: 'error', callId: 'failed', query: 'initial query', message: 'Search temporarily unavailable.' },
    { type: 'search', status: 'searching', callId: 'retry', query: 'better query' },
    { type: 'search', status: 'complete', callId: 'retry', query: 'better query', resultCount: 1 },
    { type: 'sources', sources: [source] },
    { type: 'delta', text: 'The first search failed. I found a source on retry.' },
    { type: 'done' },
  ), { initialState: initialState() });
  await app.run('sendMessage()');
  const reply = app.state('currentChat.messages.at(-1)');
  assert.equal(reply.status, 'complete');
  assert.deepEqual(reply.searches.map(search => search.status), ['error', 'complete']);
  assert.equal(reply.searches[0].message, 'Search temporarily unavailable.');
  assert.deepEqual(app.state('currentChat.messages.slice(0,2).map(message => message.id)'), ['old-user', 'old-answer']);
  const restored = readSavedState({ getItem: () => JSON.stringify(persisted(app)) });
  assert.equal(restored.chats[0].messages.at(-1).searches[0].message, reply.searches[0].message);
});

test('stopping autonomous search retains earlier messages, partial reply and any new unsent draft', async () => {
  let live;
  const app = harness(async (_url, options) => { live = liveResponse(options.signal); return live.response; }, { initialState: initialState() });
  const pending = app.run('sendMessage()'); await settle();
  live.emit({ type: 'delta', text: 'Checking now. ' });
  live.emit({ type: 'search', status: 'searching', callId: 'pending', query: 'latest Mars research' }); await settle();
  input(app, 'Keep my next message');
  app.run('stopGeneration()'); await pending;
  const reply = app.state('currentChat.messages.at(-1)');
  assert.equal(reply.status, 'interrupted'); assert.equal(reply.searches[0].status, 'interrupted'); assert.equal(reply.content, 'Checking now. ');
  assert.equal(app.elements.get('message-input').value, 'Keep my next message');
  assert.deepEqual(app.state('currentChat.messages.slice(0,2).map(message => message.id)'), ['old-user', 'old-answer']);
  const context = conversationMessages(app.state('currentChat.messages'));
  assert.equal(context.some(message => message.content.includes('Checking now.')), false);
  const restored = readSavedState({ getItem: () => JSON.stringify(persisted(app)) });
  assert.equal(restored.chats[0].messages.at(-1).searches[0].status, 'interrupted');
  assert.equal(restored.chats[0].composer.text, 'Keep my next message');
});

test('refresh during an in-flight search restores it as stopped without inventing a completed answer', () => {
  const state = initialState();
  state.chats[0].messages.push({ id: 'partial', role: 'assistant', content: 'Partial answer', status: 'streaming', searches: [{ callId: 'running', query: 'unfinished search', status: 'searching' }] });
  const restored = readSavedState({ getItem: () => JSON.stringify(stateForStorage({ webSearch: true, apiKey: 'never-store' }, state.chats, 'keep')) });
  const reply = restored.chats[0].messages.at(-1);
  assert.equal(reply.status, 'interrupted'); assert.equal(reply.searches[0].status, 'interrupted');
  assert.equal(restored.config.webSearch, true); assert.equal('apiKey' in restored.config, false);
  assert.equal(restored.chats[0].composer.text, 'Unsent follow-up');
});

test('search activity is bounded and credential fields are omitted from snapshots', () => {
  const searches = sanitizeSearches([
    null, { query: 'bad', status: 'pretend-success' },
    { query: 'safe\nquery', status: 'complete', callId: 'safe-call', searchIndex: 1, resultCount: 3, apiKey: 'private-key', rawResult: { authorization: 'secret' } },
    ...Array.from({ length: 30 }, (_, index) => ({ query: `query ${index}`, status: 'complete', resultCount: -1 })),
  ]);
  assert.equal(searches.length, 20); assert.equal(searches[0].query, 'safe query');
  assert.deepEqual(Object.keys(searches[0]), ['query', 'status', 'callId', 'searchIndex', 'resultCount']);
  assert.equal('resultCount' in searches[1], false);
  const state = stateForStorage({ webSearch: 'false', apiKey: 'private-key' }, [{ id: 'safe', messages: [{ role: 'assistant', content: 'Done', status: 'complete', searches }] }]);
  assert.equal('webSearch' in state.config, false); assert.equal(JSON.stringify(state).includes('private-key'), false);
  assert.deepEqual(readSavedState({ getItem: () => JSON.stringify(state) }).chats[0].messages[0].searches, searches);
});

test('completed AI search references remain available in follow-ups, and historical plain answers stay exact', () => {
  const messages = [
    { role: 'assistant', content: 'Plain answer', status: 'complete', sources: [source] },
    { role: 'assistant', content: 'Researched answer', status: 'complete', sources: [source, { url: 'javascript:bad' }], searches: [{ query: 'Mars fact sheet', status: 'complete', resultCount: 1 }] },
    { role: 'user', content: 'What did that source say?' },
  ];
  const context = conversationMessages(messages);
  assert.deepEqual(context[0], { role: 'assistant', content: 'Plain answer' });
  assert.match(context[1].content, /Researched answer/); assert.match(context[1].content, /untrusted reference text/);
  assert.match(context[1].content, /Mars fact sheet/); assert.match(context[1].content, /https:\/\/example\.com\/mars/); assert.match(context[1].content, /iron oxide surface/);
  assert.doesNotMatch(context[1].content, /javascript:/);
  assert.deepEqual(context[2], { role: 'user', content: 'What did that source say?' });
});

test('Auto with autonomous search allows Responses documents for supported local GPT models', async () => {
  const requests = [];
  const app = harness(async (_url, options) => { requests.push(JSON.parse(options.body)); return completed('Read the document'); }, { initialState: initialState() });
  app.setConnection('http://127.0.0.1:8317/v1'); app.chooseModel('gpt-6.1-sol', { custom: true }); app.run("config.protocol = 'auto'");
  await app.run("addFiles([new File(['abc'], 'lesson.docx', {type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'})])");
  await app.run('sendMessage()');
  assert.equal(requests.length, 1); assert.equal(requests[0].webSearch, true); assert.equal(requests[0].protocol, 'auto');
  assert.equal(requests[0].messages.at(-1).attachments.at(-1).name, 'lesson.docx');
  app.elements.get('web-search-toggle').click(); input(app, 'Keep my next question');
  await app.run('sendMessage()');
  assert.equal(requests.length, 1); assert.equal(app.elements.get('message-input').value, 'Keep my next question');
  assert.match(app.elements.get('toast').textContent, /Responses API/);
});
