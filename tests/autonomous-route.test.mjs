// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createServer } from '../server.mjs';
import { parseSSE } from '../lib/api.mjs';
import { MAX_TOOL_ROUNDS, MAX_WEB_SEARCHES } from '../lib/agent-chat.mjs';
import { createMockProvider } from './mock-provider.mjs';

const KEY = 'disposable-route-key';
const QUERY = 'Mars iron oxide evidence';
const SOURCE = { title: 'Mars reference', url: 'https://example.org/mars-evidence', snippet: 'A source excerpt returned by the injected search.' };
const TOOL_ID = 'call_route_search';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

async function requestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function context(payload, protocol) {
  return payload[protocol === 'responses' ? 'input' : 'messages'];
}

function toolResult(payload, protocol) {
  const item = context(payload, protocol).findLast(item => protocol === 'responses'
    ? item.type === 'function_call_output' : item.role === 'tool');
  return item ? JSON.parse(protocol === 'responses' ? item.output : item.content) : null;
}

function toolReply(protocol, query = QUERY, extras = {}) {
  const args = typeof query === 'string' ? JSON.stringify({ query }) : query.arguments;
  if (protocol === 'responses') {
    return {
      status: 'completed',
      output: [
        { id: 'reasoning_route', type: 'reasoning', encrypted_content: 'opaque-reasoning-fixture', summary: [] },
        { id: 'fc_route', type: 'function_call', call_id: TOOL_ID, name: 'web_search', arguments: args, status: 'completed', ...extras },
      ],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    };
  }
  return {
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: TOOL_ID, type: 'function', function: { name: 'web_search', arguments: args }, ...extras }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  };
}

function answerReply(protocol, answer) {
  return protocol === 'responses'
    ? { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] }], usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 } }
    : { choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } };
}

function body(baseUrl, protocol = 'chat', extras = {}) {
  return {
    baseUrl: `${baseUrl}/v1`, apiKey: KEY, model: 'route-model', effort: 'high', protocol,
    systemPrompt: 'Give a concise sourced answer.', webSearch: true,
    messages: [{ role: 'user', content: 'Search why is Mars red' }], ...extras,
  };
}

async function fixture(t, handler, search, serverOptions = {}) {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    try {
      const payload = await requestBody(req);
      seen.push({ payload, path: req.url, auth: req.headers.authorization });
      await handler(req, res, payload, seen.length);
    } catch (error) {
      json(res, 500, { error: { message: error.message } });
    }
  });
  const baseUrl = await listen(upstream);
  const server = createServer({ search, ...serverOptions });
  const url = await listen(server);
  t.after(async () => { await close(server); await close(upstream); });
  return { baseUrl, url, seen };
}

function post(url, input, options = {}) {
  return fetch(`${url}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), ...options });
}

async function events(response) {
  const output = [];
  for await (const record of parseSSE(response.body)) output.push(JSON.parse(record.data));
  return output;
}

function answerText(output) {
  return output.filter(item => item.type === 'delta').map(item => item.text).join('');
}

function assertSuccessful(output) {
  assert.equal(output.at(-1).type, 'done');
  assert.equal(output.filter(item => item.type === 'done').length, 1);
  assert.equal(output.some(item => item.type === 'error'), false);
}

const TEXT_FILE = { id: 'notes', name: 'notes.txt', size: 12, kind: 'text', type: 'text/plain', text: 'Remember 17.' };
const IMAGE = { id: 'diagram', name: 'mars.png', size: 3, kind: 'image', type: 'image/png', dataUrl: 'data:image/png;base64,AQID' };
const PDF = { id: 'document', name: 'mars.pdf', size: 4, kind: 'file', type: 'application/pdf', dataUrl: 'data:application/pdf;base64,BAUGBw==' };

for (const protocol of ['chat', 'responses']) {
  test(`autonomous ${protocol} route executes the model query and preserves history, files, effort, and system settings`, async t => {
    const searches = [];
    const { baseUrl, url, seen } = await fixture(t, (req, res, payload) => {
      const result = toolResult(payload, protocol);
      json(res, 200, result ? answerReply(protocol, `Evidence: [${result.sources[0].title}](${result.sources[0].url}).`) : toolReply(protocol));
    }, (...args) => {
      searches.push(args);
      return { engine: 'Local test search', sources: [SOURCE] };
    });
    const input = body(baseUrl, protocol, { messages: [
      { role: 'user', content: 'Keep my earlier note.', attachments: [TEXT_FILE] },
      { role: 'assistant', content: 'I remember 17.' },
      { role: 'user', content: 'Search why is Mars red', attachments: [IMAGE, PDF] },
    ] });
    const untouched = structuredClone(input);
    const response = await post(url, input);
    assert.equal(response.status, 200);
    const output = await events(response);
    assertSuccessful(output);
    assert.match(answerText(output), /https:\/\/example\.org\/mars-evidence/);
    assert.equal(seen.length, 2, 'The model resumes once after receiving the tool result.');
    assert.equal(searches.length, 1);
    assert.equal(searches[0].length, 2);
    assert.equal(searches[0][0], QUERY, 'The query comes from the model, not directly from the user message.');
    assert.deepEqual(Object.keys(searches[0][1]), ['signal']);
    assert.ok(searches[0][1].signal instanceof AbortSignal);
    assert.deepEqual(input, untouched, 'The route must not mutate the caller history.');

    const textType = protocol === 'responses' ? 'input_text' : 'text';
    const expectedMessages = [
      { role: 'user', content: [{ type: textType, text: 'Keep my earlier note.' }, { type: textType, text: 'Attachment: notes.txt\nRemember 17.' }] },
      { role: 'assistant', content: 'I remember 17.' },
      { role: 'user', content: [
        { type: textType, text: 'Search why is Mars red' },
        protocol === 'responses' ? { type: 'input_image', image_url: IMAGE.dataUrl } : { type: 'image_url', image_url: { url: IMAGE.dataUrl } },
        protocol === 'responses' ? { type: 'input_file', filename: PDF.name, file_data: PDF.dataUrl } : { type: 'file', file: { filename: PDF.name, file_data: PDF.dataUrl } },
      ] },
    ];
    const first = seen[0].payload;
    const prefix = context(first, protocol);
    assert.deepEqual(protocol === 'responses' ? prefix : prefix.slice(1), expectedMessages);
    assert.deepEqual(context(seen[1].payload, protocol).slice(0, prefix.length), prefix);
    for (const call of seen) {
      assert.equal(call.path, protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions');
      assert.equal(call.auth, `Bearer ${KEY}`);
      assert.equal(call.payload.model, input.model);
      assert.equal(call.payload.stream, true);
      assert.equal(call.payload.tool_choice, 'auto');
      assert.equal(call.payload.tools.length, 1);
      const definition = protocol === 'responses' ? call.payload.tools[0] : call.payload.tools[0].function;
      assert.equal(definition.name, 'web_search');
      assert.deepEqual(definition.parameters.required, ['query']);
      assert.equal(definition.parameters.additionalProperties, false);
      if (protocol === 'responses') {
        assert.deepEqual(call.payload.reasoning, { effort: 'high' });
        assert.equal(call.payload.store, false);
        assert.deepEqual(call.payload.include, ['reasoning.encrypted_content']);
        assert.match(call.payload.instructions, /^Give a concise sourced answer\./);
      } else {
        assert.equal(call.payload.reasoning_effort, 'high');
        assert.match(call.payload.messages[0].content, /^Give a concise sourced answer\./);
        assert.equal(call.payload.messages[0].role, 'system');
      }
    }
    const replay = context(seen[1].payload, protocol).slice(prefix.length);
    if (protocol === 'responses') {
      assert.equal(replay[0].type, 'reasoning');
      assert.equal(replay[0].encrypted_content, 'opaque-reasoning-fixture');
      assert.equal(replay[1].call_id, TOOL_ID);
      assert.equal(replay[2].call_id, TOOL_ID);
    } else {
      assert.equal(replay[0].role, 'assistant');
      assert.equal(replay[0].tool_calls[0].id, TOOL_ID);
      assert.equal(replay[1].tool_call_id, TOOL_ID);
    }
    const result = toolResult(seen[1].payload, protocol);
    assert.deepEqual(result.sources, [SOURCE]);
    assert.equal(result.query, QUERY);
    assert.match(result.note, /untrusted reference/);
    assert.deepEqual(output.filter(item => item.type === 'search').map(item => [item.status, item.query, item.searchIndex]), [['searching', QUERY, 1], ['complete', QUERY, 1]]);
    assert.deepEqual(output.find(item => item.type === 'sources').sources, [SOURCE]);
    assert.deepEqual(output.filter(item => item.type === 'usage'), [
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 }, usageKnown: { inputTokens: 5, outputTokens: 3, totalTokens: 8 }, usageCoverage: { providerCalls: 1, inputCalls: 1, outputCalls: 1, totalCalls: 1 } },
      { type: 'usage', usage: null, usageKnown: { inputTokens: 5, outputTokens: 3, totalTokens: 8 }, usageCoverage: { providerCalls: 2, inputCalls: 1, outputCalls: 1, totalCalls: 1 } },
      { type: 'usage', usage: { inputTokens: 14, outputTokens: 7, totalTokens: 21 }, usageKnown: { inputTokens: 14, outputTokens: 7, totalTokens: 21 }, usageCoverage: { providerCalls: 2, inputCalls: 2, outputCalls: 2, totalCalls: 2 } },
    ]);
    assert.equal(JSON.stringify(output).includes(KEY), false);
  });

  test(`demo-web-search ${protocol} mock streams a genuine tool request then cites only received sources`, async t => {
    const upstream = createMockProvider({ log: () => {} });
    const baseUrl = await listen(upstream);
    const queries = [];
    const server = createServer({ search: query => { queries.push(query); return { engine: 'Local mock search', sources: [SOURCE] }; } });
    const url = await listen(server);
    t.after(async () => { await close(server); await close(upstream); });
    const output = await events(await post(url, body(baseUrl, protocol, { model: 'demo-web-search' })));
    assertSuccessful(output);
    assert.deepEqual(queries, ['why is Mars red']);
    assert.match(answerText(output), /\[Mars reference\]\(https:\/\/example\.org\/mars-evidence\)/);
    assert.match(answerText(output), /A source excerpt returned by the injected search/);
    assert.equal(output.filter(item => item.type === 'search').length, 2);
    const inspect = await (await fetch(`${baseUrl}/inspect`)).json();
    assert.equal(inspect.receivedToolResult, true);
    assert.deepEqual(inspect.toolNames, ['web_search']);
    assert.equal(inspect.effort, 'high');
  });

  test(`autonomous ${protocol} route can finish directly when the model chooses not to search`, async t => {
    let searchCalls = 0;
    const { baseUrl, url, seen } = await fixture(t, (req, res) => json(res, 200, answerReply(protocol, '2 + 2 = 4.')), () => { searchCalls++; throw new Error('A direct answer must not search.'); });
    const output = await events(await post(url, body(baseUrl, protocol, { messages: [{ role: 'user', content: 'What is 2 + 2?' }] })));
    assertSuccessful(output);
    assert.equal(answerText(output), '2 + 2 = 4.');
    assert.equal(searchCalls, 0);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].payload.tool_choice, 'auto');
    assert.equal(output.some(item => ['search', 'sources'].includes(item.type)), false);
  });

  test(`autonomous ${protocol} route passes a failed search back to the model without claiming success`, async t => {
    const { baseUrl, url, seen } = await fixture(t, (req, res, payload) => {
      const result = toolResult(payload, protocol);
      json(res, 200, result ? answerReply(protocol, `The web search was unavailable: ${result.error}.`) : toolReply(protocol));
    }, () => { throw new Error(`Search unavailable ${KEY}`); });
    const output = await events(await post(url, body(baseUrl, protocol)));
    assertSuccessful(output);
    assert.equal(seen.length, 2);
    assert.deepEqual(output.filter(item => item.type === 'search').map(item => item.status), ['searching', 'error']);
    assert.equal(output.some(item => item.type === 'sources'), false);
    const result = toolResult(seen[1].payload, protocol);
    assert.deepEqual(result.sources, []);
    assert.equal(result.error, 'Search unavailable [redacted]');
    assert.match(result.note, /do not claim/);
    assert.match(answerText(output), /unavailable/);
    assert.equal(JSON.stringify(output).includes(KEY), false);
  });
}

for (const setting of [false, undefined]) {
  test(`web search ${setting === false ? 'disabled' : 'omitted by an older caller'} keeps the ordinary one-call route`, async t => {
    let searchCalls = 0;
    const { baseUrl, url, seen } = await fixture(t, (req, res) => json(res, 200, answerReply('chat', 'Ordinary reply unchanged.')), () => { searchCalls++; });
    const input = body(baseUrl, 'chat', { webSearch: setting });
    const output = await events(await post(url, input));
    assertSuccessful(output);
    assert.equal(answerText(output), 'Ordinary reply unchanged.');
    assert.equal(searchCalls, 0);
    assert.equal(seen.length, 1);
    assert.equal('tools' in seen[0].payload, false);
    assert.equal('tool_choice' in seen[0].payload, false);
    assert.equal(seen[0].payload.messages[0].content, input.systemPrompt);
    assert.equal(output.some(item => item.type === 'search'), false);
  });
}

test('disconnecting during an autonomous search aborts that search and prevents a provider continuation', { timeout: 5000 }, async t => {
  let started;
  let stopped;
  const searchStarted = new Promise(resolve => { started = resolve; });
  const searchStopped = new Promise(resolve => { stopped = resolve; });
  const { baseUrl, url, seen } = await fixture(t, (req, res) => json(res, 200, toolReply('chat')), (query, { signal }) => {
    started({ query, signal });
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => { stopped(); reject(signal.reason); }, { once: true }));
  });
  const controller = new AbortController();
  const response = await post(url, body(baseUrl), { signal: controller.signal });
  const { query, signal } = await searchStarted;
  assert.equal(query, QUERY);
  const consumption = events(response).catch(error => error);
  controller.abort();
  await searchStopped;
  const result = await consumption;
  assert.ok(result instanceof Error);
  assert.equal(signal.aborted, true);
  assert.equal(seen.length, 1);
});

for (const [name, query, expected] of [
  ['incomplete arguments', { arguments: '{"query":"Mars' }, /invalid web search arguments/],
  ['an extra credential argument', { arguments: JSON.stringify({ query: QUERY, apiKey: KEY }) }, /only a query string/],
  ['a credential in the query', `Mars ${KEY}`, /private credentials/],
  ['a URL-encoded credential in the query', `Mars ${[...KEY].map(char => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')}`, /private credentials/],
]) {
  test(`autonomous route rejects ${name} before executing any search`, async t => {
    let searchCalls = 0;
    const { baseUrl, url, seen } = await fixture(t, (req, res) => json(res, 200, toolReply('chat', query)), () => { searchCalls++; });
    const output = await events(await post(url, body(baseUrl)));
    assert.equal(output.at(-1).type, 'error');
    assert.match(output.at(-1).message, expected);
    assert.equal(output.some(item => ['search', 'done'].includes(item.type)), false);
    assert.equal(searchCalls, 0);
    assert.equal(seen.length, 1);
    assert.equal(JSON.stringify(output).includes(KEY), false);
  });
}

test('a failed provider continuation reports one redacted terminal error without retrying', async t => {
  const { baseUrl, url, seen } = await fixture(t, (req, res, payload, call) => {
    json(res, call === 1 ? 200 : 401, call === 1 ? toolReply('chat') : { error: { message: `Continuation rejected ${KEY}` } });
  }, () => ({ sources: [SOURCE] }));
  const output = await events(await post(url, body(baseUrl)));
  assert.equal(seen.length, 2);
  assert.equal(output.at(-1).type, 'error');
  assert.equal(output.at(-1).message, 'Continuation rejected [redacted]');
  assert.equal(output.some(item => item.type === 'done'), false);
  assert.equal(output.filter(item => item.type === 'error').length, 1);
  assert.equal(JSON.stringify(output).includes(KEY), false);
});

test('a provider that rejects tools returns its capability error without a fallback or search', async t => {
  let searchCalls = 0;
  const { baseUrl, url, seen } = await fixture(t, (req, res) => json(res, 400, { error: { message: 'This model does not support function tools.' } }), () => { searchCalls++; });
  const response = await post(url, body(baseUrl));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'This model does not support function tools.' });
  assert.equal(seen.length, 1);
  assert.equal(searchCalls, 0);
});

for (const protocol of ['chat', 'responses']) {
  test(`a looping ${protocol} model finishes from collected evidence at the round budget without losing earlier files or messages`, async t => {
    const queries = [];
    const { baseUrl, url, seen } = await fixture(t, (req, res, payload, count) => {
      if (payload.tool_choice === 'none') {
        const outputs = context(payload, protocol).filter(item => protocol === 'responses' ? item.type === 'function_call_output' : item.role === 'tool');
        const result = outputs.map(item => JSON.parse(protocol === 'responses' ? item.output : item.content)).find(result => result.sources?.length);
        json(res, 200, answerReply(protocol, `Finished from the available evidence: [${result.sources[0].title}](${result.sources[0].url}).`));
        return;
      }
      const reply = toolReply(protocol, `${QUERY} refinement ${count}`);
      if (protocol === 'responses') {
        reply.output[0].id += `_${count}`;
        reply.output[1].id += `_${count}`;
        reply.output[1].call_id += `_${count}`;
      } else reply.choices[0].message.tool_calls[0].id += `_${count}`;
      json(res, 200, reply);
    }, query => { queries.push(query); return { engine: 'Local bounded search', sources: [SOURCE] }; });
    const input = body(baseUrl, protocol, { messages: [
      { role: 'user', content: 'Keep my original note.', attachments: [TEXT_FILE] },
      { role: 'assistant', content: 'I remember 17.' },
      { role: 'user', content: 'Search why is Mars red', attachments: [IMAGE, PDF] },
    ] });
    const output = await events(await post(url, input));
    assertSuccessful(output);
    assert.match(answerText(output), /Finished from the available evidence/);
    assert.match(answerText(output), /https:\/\/example\.org\/mars-evidence/);
    assert.ok(queries.length > 0 && queries.length <= MAX_WEB_SEARCHES);
    assert.ok(seen.length <= MAX_TOOL_ROUNDS + 2, 'Only one bounded final provider request is allowed after tool rounds.');
    assert.equal(seen.filter(call => call.payload.tool_choice === 'none').length, 1);
    assert.equal(seen.at(-1).payload.tool_choice, 'none');
    const firstContext = context(seen[0].payload, protocol);
    assert.match(JSON.stringify(firstContext), /Remember 17/);
    assert.match(JSON.stringify(firstContext), /mars\.png|image_url/);
    assert.match(JSON.stringify(firstContext), /mars\.pdf/);
    for (const request of seen) {
      assert.deepEqual(context(request.payload, protocol).slice(0, firstContext.length), firstContext);
      assert.equal(request.payload.model, input.model);
      assert.equal(protocol === 'responses' ? request.payload.reasoning.effort : request.payload.reasoning_effort, 'high');
    }
    assert.equal(output.filter(item => item.type === 'sources').flatMap(item => item.sources).length, 1);
    assert.equal(JSON.stringify(output).includes(KEY), false);
  });

  test(`demo-search-loop ${protocol} caches repeated queries and finishes its streamed answer when tools are disabled`, async t => {
    const upstream = createMockProvider({ log: () => {} });
    const baseUrl = await listen(upstream);
    const queries = [];
    const server = createServer({ search: query => { queries.push(query); return { engine: 'Local loop search', sources: [SOURCE] }; } });
    const url = await listen(server);
    t.after(async () => { await close(server); await close(upstream); });
    const output = await events(await post(url, body(baseUrl, protocol, { model: 'demo-search-loop', messages: [
      { role: 'user', content: 'Keep my note.', attachments: [TEXT_FILE] },
      { role: 'assistant', content: 'I remember 17.' },
      { role: 'user', content: 'Search why is Mars red', attachments: [IMAGE, PDF] },
    ] })));
    assertSuccessful(output);
    assert.match(answerText(output), /finished researching/);
    assert.match(answerText(output), /\[Mars reference\]\(https:\/\/example\.org\/mars-evidence\)/);
    assert.equal(queries.filter(query => query === 'why is Mars red').length, 1, 'The second identical model query must reuse this turn’s search result.');
    assert.equal(new Set(queries).size, queries.length);
    assert.ok(queries.length <= MAX_WEB_SEARCHES);
    const inspect = await (await fetch(`${baseUrl}/inspect`)).json();
    assert.equal(inspect.toolChoice, 'none');
    assert.ok(inspect.toolResultCount >= 2, 'The repeated tool call still receives its cached result.');
    assert.equal(inspect.receivedToolResult, true);
    assert.equal(inspect.model, 'demo-search-loop');
    assert.equal(inspect.effort, 'high');
    assert.match(inspect.messages.find(message => message.role === 'user').content, /Attachment: notes\.txt\nRemember 17/);
    assert.equal(inspect.messages.find(message => message.role === 'assistant').content, 'I remember 17.');
    const latestUser = inspect.messages.findLast(message => message.role === 'user');
    assert.equal(latestUser.content, 'Search why is Mars red');
    assert.deepEqual(latestUser.parts.filter(part => ['image_url', 'input_image', 'file', 'input_file'].includes(part.type)).map(part => part.imageBytes ?? part.fileBytes), [3, 4]);
    assert.equal(output.filter(item => item.type === 'sources').flatMap(item => item.sources).length, 1);
  });

  for (const scenario of ['six searches', 'overflow batch']) {
    test(`${protocol} route finalizes ${scenario} with paired tool outputs and existing source evidence`, async t => {
      const queries = [];
      const batches = scenario === 'six searches' ? [3, 3] : [5, 2];
      const { baseUrl, url, seen } = await fixture(t, (req, res, payload, count) => {
        if (payload.tool_choice === 'none') {
          const resultItems = context(payload, protocol).filter(item => protocol === 'responses' ? item.type === 'function_call_output' : item.role === 'tool');
          const results = resultItems.map(item => JSON.parse(protocol === 'responses' ? item.output : item.content));
          const evidence = results.find(result => result.sources?.length);
          json(res, 200, answerReply(protocol, `I have finished the bounded research. [Evidence](${evidence.sources[0].url})`));
          return;
        }
        const reply = toolReply(protocol);
        const calls = Array.from({ length: batches[count - 1] || 1 }, (_, index) => {
          const id = `call_budget_${count}_${index}`;
          const args = JSON.stringify({ query: `${QUERY} ${count} ${index}` });
          return protocol === 'responses'
            ? { type: 'function_call', id: `fc_${id}`, call_id: id, name: 'web_search', arguments: args, status: 'completed' }
            : { type: 'function', id, function: { name: 'web_search', arguments: args } };
        });
        if (protocol === 'responses') {
          reply.output[0].id += `_${count}`;
          reply.output.splice(1, 1, ...calls);
        } else reply.choices[0].message.tool_calls = calls;
        json(res, 200, reply);
      }, query => { queries.push(query); return { sources: [SOURCE] }; });
      const output = await events(await post(url, body(baseUrl, protocol)));
      assertSuccessful(output);
      assert.match(answerText(output), /bounded research/);
      assert.match(answerText(output), /https:\/\/example\.org\/mars-evidence/);
      assert.equal(queries.length, scenario === 'six searches' ? 6 : 5);
      assert.equal(seen.length, 3, 'Two tool turns are followed by one final synthesis request.');
      assert.equal(seen.at(-1).payload.tool_choice, 'none');
      const finalContext = context(seen.at(-1).payload, protocol);
      const callIds = protocol === 'responses'
        ? finalContext.filter(item => item.type === 'function_call').map(item => item.call_id)
        : finalContext.flatMap(item => item.tool_calls || []).map(call => call.id);
      const resultItems = finalContext.filter(item => protocol === 'responses' ? item.type === 'function_call_output' : item.role === 'tool');
      assert.deepEqual(resultItems.map(item => protocol === 'responses' ? item.call_id : item.tool_call_id), callIds);
      const results = resultItems.map(item => JSON.parse(protocol === 'responses' ? item.output : item.content));
      if (scenario === 'overflow batch') {
        assert.equal(results.length, 7);
        assert.deepEqual(results.slice(-2).map(result => result.code), ['search_budget_exhausted', 'search_budget_exhausted']);
        assert.deepEqual(results.slice(-2).map(result => result.sources), [[], []]);
      } else assert.equal(results.length, 6);
      assert.equal(output.filter(item => item.type === 'notice' && item.code === 'search_limit').length, 1);
      assert.equal(output.filter(item => item.type === 'sources').flatMap(item => item.sources).length, 1);
    });
  }
}
