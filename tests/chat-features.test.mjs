// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, completed } from './support/app-harness.mjs';
import { buildChatPayload, validateChat } from '../lib/api.mjs';

const source = { title: 'Reference', url: 'https://example.com/reference', snippet: 'Verified context for the question.' };
const textFile = { id: 'saved-file', name: 'notes.txt', type: 'text/plain', size: 5, kind: 'text', text: 'notes' };
const search = { query: 'original research', engine: 'duckduckgo', sources: [source] };
const initialState = () => ({
  config: { baseUrl: 'https://provider.example/v1', model: 'test-model', modelMode: 'custom', protocol: 'chat', effort: 'high' },
  activeChatId: 'existing', savedAt: 1000,
  chats: [
    { id: 'existing', title: 'Existing conversation', updatedAt: 100, messages: [
      { id: 'u-old', role: 'user', content: 'Remember our earlier question', status: 'complete' },
      { id: 'a-old', role: 'assistant', content: 'Earlier answer is still here', status: 'complete' },
    ] },
    { id: 'other', title: 'Other conversation', updatedAt: 50, messages: [{ id: 'other-user', role: 'user', content: 'Separate history', status: 'complete' }] },
  ],
});
function input(app, id, value) { const element = app.elements.get(id); element.value = value; element.listeners.input?.({ target: element }); }
function switchChat(app, title) {
  const row = app.elements.get('history-list').children.find(row => row.children.some(child => child.title === title));
  assert.ok(row, `Missing history row: ${title}`);
  row.children.find(child => child.title === title).click();
}
function deleteChat(app, title) {
  const row = app.elements.get('history-list').children.find(row => row.children.some(child => child.title === title));
  assert.ok(row, `Missing history row: ${title}`);
  row.children.find(child => child.className.includes('delete-chat')).click();
}
function attachmentToggle(app, action, name) {
  const button = app.elements.get('messages').querySelectorAll('button').find(button => button.getAttribute('aria-label') === `${action} attachment ${action === 'Exclude' ? 'from' : 'in'} future messages: ${name}`);
  assert.ok(button, `Missing ${action} control for ${name}`);
  button.click();
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const settle = () => new Promise(resolve => setImmediate(resolve));

test('attaching files adds context to a populated chat without clearing messages or the draft', async () => {
  const requests = [];
  const app = harness(async (url, options) => { assert.equal(url, '/api/chat'); requests.push(JSON.parse(options.body)); return completed('Files reviewed'); }, { initialState: initialState() });
  input(app, 'message-input', 'Read these files with our earlier context');
  await app.run("addFiles([new File(['my text'], 'notes.txt', {type:'text/plain'}), new File(['abc'], 'diagram.png', {type:'image/png'}), new File(['xyz'], 'handout.pdf', {type:'application/pdf'})])");
  assert.equal(app.state('currentChat.id'), 'existing');
  assert.deepEqual(app.state('currentChat.messages.map(message => message.id)'), ['u-old', 'a-old']);
  assert.equal(app.elements.get('message-input').value, 'Read these files with our earlier context');
  assert.deepEqual(app.state('composer().attachments.map(file => file.kind)'), ['text', 'image', 'file']);
  await app.run('sendMessage()');
  assert.equal(requests[0].messages.length, 3);
  assert.equal(requests[0].messages[0].content, 'Remember our earlier question');
  assert.equal(requests[0].messages[1].content, 'Earlier answer is still here');
  assert.equal(requests[0].messages[2].attachments[0].text, 'my text');
  assert.equal(requests[0].messages[2].attachments[1].dataUrl, 'data:image/png;base64,YWJj');
  assert.equal(requests[0].messages[2].attachments[2].dataUrl, 'data:application/pdf;base64,eHl6');
  const chatContent = buildChatPayload(validateChat(requests[0])).messages.at(-1).content;
  assert.deepEqual(chatContent.map(part => part.type), ['text', 'text', 'image_url', 'file']);
  assert.match(chatContent[1].text, /Attachment: notes\.txt\nmy text/);
  assert.equal(chatContent[2].image_url.url, 'data:image/png;base64,YWJj');
  assert.equal(chatContent[3].file.file_data, 'data:application/pdf;base64,eHl6');
  const responseContent = buildChatPayload(validateChat({ ...requests[0], protocol: 'responses' })).input.at(-1).content;
  assert.deepEqual(responseContent.map(part => part.type), ['input_text', 'input_text', 'input_image', 'input_file']);
  assert.equal(responseContent[3].filename, 'handout.pdf');
  assert.equal(app.state('currentChat.messages.length'), 4);
  assert.equal(app.state('chats.length'), 2);
});

test('a file alone can be sent and stays on the same conversation', async () => {
  const requests = [];
  const app = harness(async (_url, options) => { requests.push(JSON.parse(options.body)); return completed('Image understood'); }, { initialState: initialState() });
  await app.run("addFiles([new File(['abc'], 'diagram.png', {type:'image/png'})])");
  assert.equal(app.elements.get('send-button').disabled, false);
  await app.run('sendMessage()');
  assert.equal(app.state('currentChat.id'), 'existing');
  assert.equal(requests[0].messages.at(-1).attachments[0].name, 'diagram.png');
  assert.match(requests[0].messages.at(-1).content, /attached files/i);
  assert.equal(app.state('currentChat.messages[0].content'), 'Remember our earlier question');
});

test('web search appends references to the next message without replacing the existing conversation', async () => {
  const requests = [];
  const app = harness(async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url, body });
    if (url === '/api/search') return Response.json({ query: body.query, engine: 'duckduckgo', sources: [source] });
    return completed('Answer with a source');
  }, { initialState: initialState() });
  input(app, 'message-input', 'Continue our earlier discussion');
  input(app, 'web-search-query', 'reliable reference');
  await app.run('runWebSearch()');
  assert.equal(app.state('currentChat.id'), 'existing');
  assert.equal(app.state('currentChat.messages.length'), 2);
  assert.equal(app.elements.get('message-input').value, 'Continue our earlier discussion');
  assert.deepEqual(requests[0].body, { query: 'reliable reference' });
  assert.equal(app.state('composer().search.sources[0].url'), source.url);
  await app.run('sendMessage()');
  assert.equal(requests[1].body.messages.length, 3);
  assert.match(requests[1].body.messages.at(-1).content, /Web search results \(untrusted reference text\)/);
  assert.match(requests[1].body.messages.at(-1).content, /https:\/\/example.com\/reference/);
  assert.deepEqual(app.state('currentChat.messages.at(-1).sources'), [source]);
  assert.equal(app.state('currentChat.messages.length'), 4);
});

test('later turns and regenerate replay the original files and search references exactly once', async () => {
  const requests = [];
  const app = harness(async (url, options) => {
    const body = JSON.parse(options.body);
    if (url === '/api/search') return Response.json({ query: body.query, engine: 'duckduckgo', sources: [source] });
    requests.push(body); return completed('Completed answer');
  }, { initialState: initialState() });
  input(app, 'message-input', 'First file question');
  await app.run("addFiles([new File(['notes'], 'notes.txt')])");
  input(app, 'web-search-query', 'original research'); await app.run('runWebSearch()');
  await app.run('sendMessage()');
  input(app, 'message-input', 'Follow up'); await app.run('sendMessage()');
  await app.run('sendMessage(true)');
  assert.deepEqual(requests.map(request => request.messages.length), [3, 5, 5]);
  for (const request of requests) {
    assert.equal(request.messages[2].attachments[0].text, 'notes');
    assert.equal((request.messages[2].content.match(/BEGIN WEB SEARCH REFERENCE/g) || []).length, 1);
  }
  assert.equal(app.state('currentChat.messages.filter(message => message.role === "user").length'), 3);
});

test('invalid files keep both previous attachments and all current messages and draft text', async () => {
  const app = harness(async () => completed('unused'), { initialState: initialState() });
  input(app, 'message-input', 'Keep my draft');
  await app.run("addFiles([new File(['notes'], 'notes.txt')])");
  await app.run("addFiles([new File(['binary'], 'program.exe')])");
  assert.equal(app.state('currentChat.messages.length'), 2);
  assert.equal(app.state('composer().attachments.length'), 1);
  assert.equal(app.elements.get('message-input').value, 'Keep my draft');
  assert.match(app.elements.get('toast').textContent, /program\.exe/);
  await app.run("addFiles([new File([new Uint8Array([255])], 'invalid.txt')])");
  assert.equal(app.state('composer().attachments[0].text'), 'notes');
  assert.match(app.elements.get('toast').textContent, /UTF-8/);
});

test('web search failure or empty results preserve previous search, files, draft and conversation', async () => {
  let mode = 'success';
  const app = harness(async (_url, options) => {
    const { query } = JSON.parse(options.body);
    if (mode === 'error') return Response.json({ error: 'Search unavailable' }, { status: 502 });
    return Response.json({ query, engine: 'duckduckgo', sources: mode === 'empty' ? [] : [source] });
  }, { initialState: initialState() });
  input(app, 'message-input', 'Keep this question');
  await app.run("addFiles([new File(['notes'], 'notes.txt')])");
  input(app, 'web-search-query', 'original research'); await app.run('runWebSearch()');
  for (mode of ['error', 'empty']) {
    input(app, 'web-search-query', 'replacement research'); await app.run('runWebSearch()');
    assert.equal(app.state('composer().search.query'), 'original research');
    assert.equal(app.state('composer().attachments[0].text'), 'notes');
    assert.equal(app.elements.get('message-input').value, 'Keep this question');
    assert.equal(app.state('currentChat.messages.length'), 2);
  }
});

test('switching chats restores separate text, file and web search drafts', async () => {
  const app = harness(async (_url, options) => Response.json({ query: JSON.parse(options.body).query, engine: 'duckduckgo', sources: [source] }), { initialState: initialState() });
  input(app, 'message-input', 'Existing chat draft'); await app.run("addFiles([new File(['notes'], 'notes.txt')])");
  input(app, 'web-search-query', 'original research'); await app.run('runWebSearch()');
  switchChat(app, 'Other conversation');
  assert.equal(app.elements.get('message-input').value, '');
  assert.equal(app.state('composer().attachments.length'), 0);
  input(app, 'message-input', 'Other chat draft'); await app.run("addFiles([new File(['abc'], 'picture.png')])");
  switchChat(app, 'Existing conversation');
  assert.equal(app.elements.get('message-input').value, 'Existing chat draft');
  assert.equal(app.state('composer().attachments[0].name'), 'notes.txt');
  assert.equal(app.state('composer().search.query'), 'original research');
  switchChat(app, 'Other conversation');
  assert.equal(app.elements.get('message-input').value, 'Other chat draft');
  assert.equal(app.state('composer().attachments[0].name'), 'picture.png');
});

test('an unsent new conversation draft stays in history after starting another chat', async () => {
  const app = harness(async () => completed('unused'));
  const originalId = app.state('currentChat.id');
  input(app, 'message-input', 'Unsent draft'); await app.run("addFiles([new File(['notes'], 'notes.txt')])");
  app.run('newChat()');
  assert.notEqual(app.state('currentChat.id'), originalId);
  const saved = JSON.parse(app.storage.get('relay.workspace.v1'));
  const draftChat = saved.chats.find(chat => chat.id === originalId);
  assert.ok(draftChat);
  assert.equal(draftChat.composer.text, 'Unsent draft');
  assert.equal(draftChat.composer.attachments[0].text, 'notes');
  switchChat(app, draftChat.title);
  assert.equal(app.elements.get('message-input').value, 'Unsent draft');
  assert.equal(app.state('composer().attachments[0].name'), 'notes.txt');
});

test('a late file read stays with its original chat and cannot overwrite another chat draft', async () => {
  const read = deferred();
  const app = harness(async () => completed('unused'), { initialState: initialState() });
  app.inject('slowFile', { name: 'slow.txt', size: 3, arrayBuffer: () => read.promise });
  input(app, 'message-input', 'Original draft');
  const pending = app.run('addFiles([slowFile])');
  switchChat(app, 'Other conversation'); input(app, 'message-input', 'Another draft');
  read.resolve(new TextEncoder().encode('abc').buffer); await pending;
  assert.equal(app.state('currentChat.id'), 'other');
  assert.equal(app.elements.get('message-input').value, 'Another draft');
  assert.equal(app.state('composer().attachments.length'), 0);
  switchChat(app, 'Existing conversation');
  assert.equal(app.elements.get('message-input').value, 'Original draft');
  assert.equal(app.state('composer().attachments[0].text'), 'abc');
});

test('late web search results stay with the originating chat after a switch', async () => {
  const result = deferred();
  const app = harness(async () => result.promise, { initialState: initialState() });
  input(app, 'web-search-query', 'original research'); const pending = app.run('runWebSearch()');
  switchChat(app, 'Other conversation'); input(app, 'message-input', 'Other draft');
  result.resolve(Response.json(search)); await pending;
  assert.equal(app.state('currentChat.id'), 'other');
  assert.equal(app.state('composer().search'), null);
  assert.equal(app.elements.get('message-input').value, 'Other draft');
  switchChat(app, 'Existing conversation'); assert.equal(app.state('composer().search.query'), 'original research');
});

test('deleting a chat prevents pending files or web search from recreating it', async () => {
  const read = deferred(), result = deferred();
  const app = harness(async () => result.promise, { initialState: initialState() });
  app.inject('slowFile', { name: 'slow.txt', size: 3, arrayBuffer: () => read.promise });
  const pendingRead = app.run('addFiles([slowFile])');
  input(app, 'web-search-query', 'original research'); const pendingSearch = app.run('runWebSearch()');
  deleteChat(app, 'Existing conversation');
  read.resolve(new TextEncoder().encode('abc').buffer); result.resolve(Response.json(search));
  await Promise.all([pendingRead, pendingSearch]);
  assert.equal(app.state('chats.some(chat => chat.id === "existing")'), false);
  assert.equal(app.state('composer().attachments.length'), 0);
  assert.equal(app.state('composer().search'), null);
  assert.equal(JSON.parse(app.storage.get('relay.workspace.v1')).chats.some(chat => chat.id === 'existing'), false);
});

test('replaced web searches ignore older results instead of attaching them to the current draft', async () => {
  const first = deferred(), second = deferred();
  const app = harness(async (_url, options) => JSON.parse(options.body).query === 'first' ? first.promise : second.promise, { initialState: initialState() });
  input(app, 'web-search-query', 'first'); const old = app.run('runWebSearch()');
  input(app, 'web-search-query', 'second'); const newest = app.run('runWebSearch()');
  second.resolve(Response.json({ ...search, query: 'second' })); await newest;
  first.resolve(Response.json({ ...search, query: 'first' })); await old;
  assert.equal(app.state('composer().search.query'), 'second');
  assert.equal(app.state('currentChat.messages.length'), 2);
});

test('refresh restores the selected chat, original files, sources and pending composer', async () => {
  const saved = initialState();
  saved.chats[0].messages.push({ role: 'user', id: 'file-user', content: 'Saved file question', status: 'complete', attachments: [textFile], search });
  saved.chats[0].composer = { text: 'Pending follow-up', attachments: [textFile], search, searchOpen: true, searchQuery: search.query };
  const app = harness(async () => completed('unused'), { initialState: saved, defaultConnection: false });
  assert.equal(app.state('currentChat.id'), 'existing');
  assert.equal(app.elements.get('message-input').value, 'Pending follow-up');
  assert.deepEqual(app.state('currentChat.messages.at(-1).attachments'), [textFile]);
  assert.deepEqual(app.state('composer().search'), search);
  assert.equal(app.elements.get('api-key').value, '');
});

test('IndexedDB restores full files and active chat when its snapshot is newer than localStorage', async () => {
  const disk = initialState(); disk.savedAt = 2000; disk.activeChatId = 'other';
  disk.chats[1].composer = { text: 'Durable draft', attachments: [textFile], search, searchQuery: search.query, searchOpen: true };
  const app = harness(async () => completed('unused'), { initialState: initialState(), defaultConnection: false, workspaceStorage: { load: async () => disk, save: async () => true } });
  await settle();
  assert.equal(app.state('currentChat.id'), 'other');
  assert.equal(app.elements.get('message-input').value, 'Durable draft');
  assert.deepEqual(app.state('composer().attachments'), [textFile]);
  assert.deepEqual(app.state('composer().search'), search);
});

test('typing before delayed IndexedDB hydration protects the active chat and new text from replacement', async () => {
  const load = deferred(), disk = initialState(); disk.savedAt = 2000; disk.activeChatId = 'other';
  const app = harness(async () => completed('unused'), { initialState: initialState(), defaultConnection: false, workspaceStorage: { load: () => load.promise, save: async () => true } });
  input(app, 'message-input', 'Newly typed before storage finished');
  load.resolve(disk); await settle();
  assert.equal(app.state('currentChat.id'), 'existing');
  assert.equal(app.elements.get('message-input').value, 'Newly typed before storage finished');
  assert.equal(app.state('currentChat.messages[0].content'), 'Remember our earlier question');
});

test('older IndexedDB state cannot overwrite newer localStorage conversation and draft', async () => {
  const local = initialState(); local.savedAt = 3000; local.chats[0].composer = { text: 'Newest local draft', attachments: [textFile], search: null, searchQuery: '', searchOpen: false };
  const old = initialState(); old.savedAt = 2000; old.activeChatId = 'other';
  const app = harness(async () => completed('unused'), { initialState: local, defaultConnection: false, workspaceStorage: { load: async () => old, save: async () => true } });
  await settle();
  assert.equal(app.state('currentChat.id'), 'existing');
  assert.equal(app.elements.get('message-input').value, 'Newest local draft');
  assert.deepEqual(app.state('composer().attachments'), [textFile]);
});

test('a durable storage restore failure retains existing local chat rather than resetting it', async () => {
  const app = harness(async () => completed('unused'), { initialState: initialState(), defaultConnection: false, workspaceStorage: { load: async () => { throw new Error('Storage denied'); }, save: async () => true } });
  await settle();
  assert.equal(app.state('currentChat.id'), 'existing');
  assert.equal(app.state('currentChat.messages.length'), 2);
  assert.match(app.elements.get('toast').textContent, /existing chat history is still available/);
});

test('provider citation events keep safe manual references and reject unsafe source links', async () => {
  const saved = initialState(); saved.chats[0].composer = { text: 'Use these sources', attachments: [], search, searchQuery: search.query, searchOpen: false };
  const providerSource = { title: 'Provider reference', url: 'https://provider-source.example/article' };
  const app = harness(async () => new Response([
    `data: ${JSON.stringify({ type: 'sources', sources: [source, providerSource, { title: 'Unsafe', url: 'javascript:alert(1)' }] })}`,
    'data: {"type":"delta","text":"Cited answer"}', 'data: {"type":"done"}', '',
  ].join('\n\n')), { initialState: saved });
  await app.run('sendMessage()');
  assert.equal(app.state('currentChat.id'), 'existing');
  assert.deepEqual(app.state('currentChat.messages.at(-1).sources'), [source, providerSource]);
  const stored = JSON.parse(app.storage.get('relay.workspace.v1'));
  assert.deepEqual(stored.chats.find(chat => chat.id === 'existing').messages.at(-1).sources, [source, providerSource]);
});

test('attachment budget rejection leaves the original files and typed question intact', async () => {
  const saved = initialState();
  saved.chats[0].messages[0].attachments = [{ ...textFile, size: 200000, text: 'x'.repeat(200000) }];
  const app = harness(async () => completed('unused'), { initialState: saved });
  input(app, 'message-input', 'Keep this draft after a file limit');
  await app.run("addFiles([new File(['y'], 'extra.txt')])");
  assert.equal(app.state('currentChat.messages[0].attachments[0].text.length'), 200000);
  assert.equal(app.state('currentChat.messages.length'), 2);
  assert.equal(app.state('composer().attachments.length'), 0);
  assert.equal(app.elements.get('message-input').value, 'Keep this draft after a file limit');
  assert.match(app.elements.get('toast').textContent, /200,000/);
});

test('sending while a file is still reading keeps the draft and adds no premature user turn', async () => {
  const read = deferred(), requests = [];
  const app = harness(async (_url, options) => { requests.push(JSON.parse(options.body)); return completed('Ready'); }, { initialState: initialState() });
  app.inject('slowFile', { name: 'slow.txt', size: 3, arrayBuffer: () => read.promise });
  input(app, 'message-input', 'Wait for this file'); const pending = app.run('addFiles([slowFile])');
  await app.run('sendMessage()');
  assert.equal(requests.length, 0);
  assert.equal(app.state('currentChat.messages.length'), 2);
  assert.equal(app.elements.get('message-input').value, 'Wait for this file');
  read.resolve(new TextEncoder().encode('abc').buffer); await pending;
  await app.run('sendMessage()');
  assert.equal(requests[0].messages.at(-1).attachments[0].text, 'abc');
});

test('clearing history cancels pending file and search results so they cannot restore cleared conversations', async () => {
  const read = deferred(), result = deferred();
  const app = harness(async () => result.promise, { initialState: initialState() });
  app.inject('slowFile', { name: 'slow.txt', size: 3, arrayBuffer: () => read.promise });
  const pendingRead = app.run('addFiles([slowFile])');
  input(app, 'web-search-query', 'original research'); const pendingSearch = app.run('runWebSearch()');
  app.elements.get('clear-history').click(); app.elements.get('clear-history').click();
  read.resolve(new TextEncoder().encode('abc').buffer); result.resolve(Response.json(search)); await Promise.all([pendingRead, pendingSearch]);
  assert.equal(app.state('chats.length'), 0);
  assert.equal(app.state('currentChat.messages.length'), 0);
  assert.equal(app.state('composer().attachments.length'), 0);
  assert.equal(app.state('composer().search'), null);
  assert.deepEqual(JSON.parse(app.storage.get('relay.workspace.v1')).chats, []);
});

test('provider failure preserves sent files and search for a retry without duplicating user messages', async () => {
  const requests = [];
  const saved = initialState(); saved.chats[0].composer = { text: 'Read my file', attachments: [textFile], search, searchQuery: search.query, searchOpen: false };
  const app = harness(async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return requests.length === 1 ? Response.json({ error: 'Temporary provider failure' }, { status: 502 }) : completed('Recovered answer');
  }, { initialState: saved });
  await app.run('sendMessage()');
  assert.equal(app.state('currentChat.messages.at(-1).status'), 'error');
  assert.deepEqual(app.state('currentChat.messages.at(-2).attachments'), [textFile]);
  assert.deepEqual(app.state('currentChat.messages.at(-2).search'), search);
  await app.run('sendMessage(true)');
  assert.equal(app.state('currentChat.messages.at(-1).status'), 'complete');
  assert.deepEqual(requests[1].messages, requests[0].messages);
  assert.equal(app.state('currentChat.messages.filter(message => message.role === "user").length'), 2);
});

test('regenerate after changing to an incompatible protocol keeps the completed reply and unsent draft files', async () => {
  const requests = [];
  const app = harness(async (_url, options) => { requests.push(JSON.parse(options.body)); return completed('Completed office document answer'); }, { initialState: initialState() });
  app.run("config.protocol = 'responses'");
  input(app, 'message-input', 'Read this document'); await app.run("addFiles([new File(['abc'], 'report.docx')])");
  await app.run('sendMessage()');
  input(app, 'message-input', 'Keep my unsent follow-up'); await app.run("addFiles([new File(['notes'], 'next.txt')])");
  app.run("config.protocol = 'chat'");
  await app.run('sendMessage(true)');
  assert.equal(requests.length, 1);
  assert.equal(app.state('currentChat.messages.at(-1).content'), 'Completed office document answer');
  assert.equal(app.state('currentChat.messages.at(-1).status'), 'complete');
  assert.equal(app.elements.get('message-input').value, 'Keep my unsent follow-up');
  assert.equal(app.state('composer().attachments[0].name'), 'next.txt');
  assert.match(app.elements.get('toast').textContent, /Responses API/);
});

test('excluding a provider-rejected image permits a text follow-up while preserving the original chat and file', async () => {
  const requests = [];
  const app = harness(async (_url, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    return request.messages.some(message => message.attachments?.length) ? Response.json({ error: 'This provider rejects images' }, { status: 400 }) : completed('Text conversation continued');
  }, { initialState: initialState() });
  input(app, 'message-input', 'What is in this image?'); await app.run("addFiles([new File(['abc'], 'diagram.png')])");
  await app.run('sendMessage()');
  assert.equal(app.state('currentChat.messages.at(-1).status'), 'error');
  attachmentToggle(app, 'Exclude', 'diagram.png');
  input(app, 'message-input', 'Continue without that image'); await app.run('sendMessage()');
  assert.equal(app.state('currentChat.id'), 'existing');
  assert.equal(app.state('currentChat.messages[3].status'), 'error');
  assert.equal(app.state('currentChat.messages.at(-1).content'), 'Text conversation continued');
  assert.equal(requests[1].messages.some(message => message.attachments?.length), false);
  assert.equal(requests[1].messages[2].content, 'What is in this image?');
  const file = app.state('currentChat.messages[2].attachments[0]');
  assert.equal(file.excluded, true);
  assert.equal(file.dataUrl, 'data:image/png;base64,YWJj');
  const persisted = JSON.parse(app.storage.get('relay.workspace.v1'));
  const restored = harness(async () => completed('unused'), { initialState: persisted, defaultConnection: false });
  assert.equal(restored.state('currentChat.id'), 'existing');
  assert.deepEqual(restored.state('currentChat.messages[2].attachments[0]'), file);
  assert.equal(restored.state('currentChat.messages[3].error'), 'This provider rejects images');
});

test('including an excluded attachment sends its original payload again without deleting chat history', async () => {
  const saved = initialState(); saved.chats[0].messages[0].attachments = [{ ...textFile, excluded: true }];
  const requests = [];
  const app = harness(async (_url, options) => { requests.push(JSON.parse(options.body)); return completed('File included again'); }, { initialState: saved });
  attachmentToggle(app, 'Include', 'notes.txt');
  input(app, 'message-input', 'Use the original notes again'); await app.run('sendMessage()');
  assert.deepEqual(requests[0].messages[0].attachments, [textFile]);
  assert.equal(app.state('currentChat.messages[0].content'), 'Remember our earlier question');
  assert.equal(app.state('currentChat.messages[1].content'), 'Earlier answer is still here');
  assert.equal(app.state('currentChat.messages[0].attachments[0].text'), 'notes');
  assert.notEqual(app.state('currentChat.messages[0].attachments[0].excluded'), true);
});

test('regenerate in Chat Completions ignores an excluded office document and keeps pending draft files', async () => {
  const requests = [];
  const app = harness(async (_url, options) => { const request = JSON.parse(options.body); requests.push(request); buildChatPayload(validateChat(request)); return completed(`Answer ${requests.length}`); }, { initialState: initialState() });
  app.run("config.protocol = 'responses'");
  input(app, 'message-input', 'Read this Word file'); await app.run("addFiles([new File(['abc'], 'report.docx')])");
  await app.run('sendMessage()');
  attachmentToggle(app, 'Exclude', 'report.docx');
  input(app, 'message-input', 'My unsent question'); await app.run("addFiles([new File(['notes'], 'next.txt')])");
  app.run("config.protocol = 'chat'"); await app.run('sendMessage(true)');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.some(message => message.attachments?.length), false);
  assert.equal(app.state('currentChat.messages.at(-1).content'), 'Answer 2');
  assert.equal(app.state('currentChat.messages[2].attachments[0].dataUrl'), 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,YWJj');
  assert.equal(app.elements.get('message-input').value, 'My unsent question');
  assert.equal(app.state('composer().attachments[0].name'), 'next.txt');
});

test('excluded files no longer consume future request budgets while their full contents stay saved', async () => {
  const saved = initialState(); saved.chats[0].messages[0].attachments = [{ ...textFile, size: 200000, text: 'x'.repeat(200000), excluded: true }];
  const requests = [];
  const app = harness(async (_url, options) => { requests.push(JSON.parse(options.body)); return completed('Smaller context works'); }, { initialState: saved });
  input(app, 'message-input', 'Use only the new small file'); await app.run("addFiles([new File(['y'], 'extra.txt')])");
  assert.equal(app.state('composer().attachments.length'), 1);
  await app.run('sendMessage()');
  assert.equal(requests[0].messages[0].attachments, undefined);
  assert.equal(requests[0].messages.at(-1).attachments[0].text, 'y');
  assert.equal(app.state('currentChat.messages[0].attachments[0].text.length'), 200000);
  assert.equal(JSON.parse(app.storage.get('relay.workspace.v1')).chats.find(chat => chat.id === 'existing').messages[0].attachments[0].text.length, 200000);
});
