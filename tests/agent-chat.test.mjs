// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChatPayload, validateChat } from '../lib/api.mjs';
import { agentChatEvents, MAX_TOOL_ROUNDS, MAX_WEB_SEARCHES } from '../lib/agent-chat.mjs';

const secret = 'provider-secret/with+symbols';
const source = { title: 'NASA Mars', url: 'https://science.nasa.gov/mars/', snippet: 'Iron minerals oxidize and make the surface red.' };
const result = { engine: 'Bing', sources: [source] };
function options(overrides = {}) {
  return validateChat({ baseUrl: 'http://127.0.0.1:8317/v1', apiKey: secret, model: 'local-reasoner', effort: 'low', protocol: 'chat', messages: [{ role: 'user', content: 'Why is Mars red?' }], systemPrompt: 'Explain clearly.', webSearch: true, ...overrides });
}
function call(id, query, extra = {}) {
  return { id, type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query }) }, ...extra };
}
function chat(calls = [], content = null, usage, finishReason = calls.length ? 'tool_calls' : 'stop', extra = {}) {
  return { choices: [{ index: 0, message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}), ...extra }, finish_reason: finishReason }], ...(usage ? { usage } : {}) };
}
function responseOutput(output, usage) { return { status: 'completed', output, ...(usage ? { usage } : {}) }; }
function responseCall(id, query, extra = {}) { return { type: 'function_call', id: `fc_${id}`, call_id: id, name: 'web_search', arguments: JSON.stringify({ query }), status: 'completed', ...extra }; }
function responseText(value) { return { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: value }] }; }
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }
function sse(events, { splitBytes = 0, done = false, onCancel } = {}) {
  const contents = events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + (done ? 'data: [DONE]\r\n\r\n' : '');
  const bytes = new TextEncoder().encode(contents);
  const parts = [];
  for (let index = 0; index < bytes.length; index += splitBytes || bytes.length) parts.push(bytes.slice(index, index + (splitBytes || bytes.length)));
  return new Response(new ReadableStream({
    pull(controller) { if (parts.length) controller.enqueue(parts.shift()); else controller.close(); },
    cancel() { onCancel?.(); },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}
function queued(responses) {
  const requests = [];
  return { requests, fetchImpl: async (url, request) => {
    requests.push({ url, body: JSON.parse(request.body), auth: request.headers.Authorization, signal: request.signal, redirect: request.redirect });
    assert.ok(responses.length, 'unexpected provider continuation');
    const next = responses.shift(); return typeof next === 'function' ? next() : next;
  } };
}
function gatedSSE(initialEvents) {
  let controller;
  let closed = false;
  const response = new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  function push(event) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); }
  initialEvents.forEach(push);
  return { response, push, get closed() { return closed; }, end(events = []) { if (closed) return; events.forEach(push); closed = true; controller.close(); } };
}
async function nextEvent(iterator) {
  let timer;
  try { return await Promise.race([iterator.next(), new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('An available stream event was buffered until completion.')), 1000); })]); }
  finally { clearTimeout(timer); }
}
async function nextMatching(iterator, type, seen = []) {
  while (true) {
    const entry = await nextEvent(iterator);
    assert.equal(entry.done, false, `Expected a ${type} event before stream completion.`);
    seen.push(entry.value);
    if (entry.value.type === type) return entry.value;
  }
}
async function collect(settings, deps = {}, signal) {
  const events = [];
  for await (const event of agentChatEvents(settings, signal, deps)) events.push(event);
  return events;
}

test('web search validates boolean and auto-routes current Sol/Astra tools without changing disabled or explicit choices', () => {
  assert.equal(options({ webSearch: false, protocol: 'auto', model: 'gpt-6.1-sol' }).protocol, 'chat');
  assert.equal(options({ protocol: 'auto', model: 'GPT-6.1-SOL-2026' }).protocol, 'responses');
  assert.equal(options({ protocol: 'auto', model: 'gpt-6-astra' }).protocol, 'responses');
  assert.equal(options({ protocol: 'auto', model: 'local-reasoner' }).protocol, 'chat');
  assert.equal(options({ protocol: 'chat', model: 'gpt-6-astra' }).protocol, 'chat');
  assert.equal(validateChat({ ...options(), webSearch: undefined }).webSearch, false);
  assert.throws(() => options({ webSearch: 'true' }), /enabled or disabled/);
});

test('both protocols declare strict model-selected query tools and disabled payload stays text-only', () => {
  for (const protocol of ['chat', 'responses']) {
    const payload = buildChatPayload(options({ protocol }));
    const definition = protocol === 'chat' ? payload.tools[0].function : payload.tools[0];
    assert.equal(definition.name, 'web_search');
    assert.equal(definition.strict, true);
    assert.deepEqual(definition.parameters.required, ['query']);
    assert.equal(definition.parameters.additionalProperties, false);
    assert.equal(payload.tool_choice, 'auto');
    assert.match(protocol === 'chat' ? payload.messages[0].content : payload.instructions, /untrusted reference material/);
    if (protocol === 'responses') assert.deepEqual(payload.include, ['reasoning.encrypted_content']);
    const plain = buildChatPayload(options({ protocol, webSearch: false }));
    assert.equal(plain.tools, undefined); assert.equal(plain.tool_choice, undefined); assert.equal(plain.include, undefined);
    assert.equal(protocol === 'chat' ? plain.messages[0].content : plain.instructions, 'Explain clearly.');
  }
});

test('disabled mode retains the old completion path, including prefetched JSON', async () => {
  const events = await collect(options({ webSearch: false }), { initialResponse: json(chat([], 'Plain reply.')), fetchImpl: () => assert.fail('must use prefetched response'), search: () => assert.fail('search disabled') });
  assert.deepEqual(events, [{ type: 'delta', text: 'Plain reply.' }, { type: 'done' }]);
});

test('Chat JSON tool turn resumes with full previous chat, files, model, effort, system prompt and aggregate usage', async () => {
  const settings = options({ messages: [{ role: 'user', content: 'Earlier context', attachments: [{ id: 'note', name: 'note.txt', kind: 'text', size: 4, text: 'data', type: 'text/plain' }] }, { role: 'assistant', content: 'Prior answer' }, { role: 'user', content: 'Check this online.' }] });
  const provider = queued([json(chat([call('search_1', 'Mars red')], 'I will check. ', { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }, 'tool_calls', { reasoning_content: 'Need current evidence.' })), json(chat([], 'Mars is red because of oxidation.', { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }))]);
  const queries = [];
  const events = await collect(settings, { ...provider, search: async query => { queries.push(query); return result; } });
  assert.deepEqual(queries, ['Mars red']); assert.equal(provider.requests.length, 2);
  const [first, next] = provider.requests.map(request => request.body);
  assert.deepEqual(next.messages.slice(0, first.messages.length), first.messages);
  assert.equal(next.model, settings.model); assert.equal(next.reasoning_effort, 'low');
  assert.equal(next.messages.at(-2).reasoning_content, 'Need current evidence.');
  assert.equal(next.messages.at(-2).tool_calls[0].id, 'search_1');
  assert.equal(next.messages.at(-1).role, 'tool'); assert.equal(next.messages.at(-1).tool_call_id, 'search_1');
  assert.equal(JSON.parse(next.messages.at(-1).content).sources[0].url, source.url);
  assert.match(JSON.parse(next.messages.at(-1).content).note, /untrusted/);
  assert.deepEqual(events.filter(event => event.type === 'usage').at(-1).usage, { inputTokens: 30, outputTokens: 8, totalTokens: 38 });
  assert.equal(events.filter(event => event.type === 'done').length, 1);
  assert.deepEqual(events.filter(event => event.type === 'search').map(event => event.status), ['searching', 'complete']);
});

test('Chat SSE assembles interleaved multiple calls from byte-split UTF-8 argument deltas before execution', async () => {
  const first = sse([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'web_search', arguments: '{"query":"火' } }, { index: 1, id: 'b', type: 'function', function: { name: 'web_search', arguments: '{"query":"NASA' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: ' Mars"}' } }, { index: 0, function: { arguments: '星 red"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 } },
  ], { splitBytes: 1, done: true });
  const provider = queued([first, sse([{ choices: [{ index: 0, delta: { content: 'Cited answer.' } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }], { done: true })]);
  const queries = [];
  const events = await collect(options(), { ...provider, search: async query => { queries.push(query); return result; } });
  assert.deepEqual(queries, ['火星 red', 'NASA Mars']);
  assert.deepEqual(provider.requests[1].body.messages.slice(-2).map(item => item.tool_call_id), ['a', 'b']);
  assert.equal(events.filter(event => event.type === 'sources').flatMap(event => event.sources).length, 1);
  assert.equal(events.at(-1).type, 'done');
});

test('Responses JSON replays reasoning encrypted content and function items statelessly with file inputs intact', async () => {
  const reasoning = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Look up evidence.' }], encrypted_content: 'opaque-encrypted-reasoning' };
  const functionItem = responseCall('resp_call', 'Mars evidence');
  const provider = queued([json(responseOutput([reasoning, functionItem], { input_tokens: 7, output_tokens: 2, total_tokens: 9 })), json(responseOutput([responseText('Verified reply.')], { input_tokens: 11, output_tokens: 4, total_tokens: 15 }))]);
  const settings = options({ protocol: 'responses', messages: [{ role: 'user', content: 'Check my note', attachments: [{ id: 'note', name: 'note.txt', kind: 'text', size: 4, text: 'data', type: 'text/plain' }] }] });
  const events = await collect(settings, { ...provider, search: async () => result });
  const [first, next] = provider.requests.map(request => request.body);
  assert.deepEqual(next.input.slice(0, first.input.length), first.input);
  assert.deepEqual(next.input.slice(first.input.length, first.input.length + 2), [reasoning, functionItem]);
  assert.equal(next.input.at(-1).type, 'function_call_output'); assert.equal(next.input.at(-1).call_id, 'resp_call');
  assert.equal(next.previous_response_id, undefined); assert.equal(next.store, false);
  assert.deepEqual(next.reasoning, { effort: 'low' }); assert.equal(next.instructions, first.instructions);
  assert.deepEqual(events.filter(event => event.type === 'usage').at(-1).usage, { inputTokens: 18, outputTokens: 6, totalTokens: 24 });
  assert.equal(events.filter(event => event.type === 'reasoning').length, 1);
});

test('Responses SSE collects argument deltas and done items when completed output is omitted, then final-only text and citations', async () => {
  const reasoning = { type: 'reasoning', id: 'rs', encrypted_content: 'opaque', summary: [{ type: 'summary_text', text: 'Search first.' }] };
  const fn = responseCall('stream_call', 'Mars current');
  const first = sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs', summary: [] } },
    { type: 'response.reasoning_summary_text.delta', delta: 'Search first.' },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.added', output_index: 1, item: { ...fn, arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: fn.id, delta: '{"query":"Mars' },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: fn.id, delta: ' current"}' },
    { type: 'response.function_call_arguments.done', output_index: 1, item_id: fn.id, arguments: fn.arguments },
    { type: 'response.output_item.done', output_index: 1, item: fn },
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
  ], { splitBytes: 3 });
  const final = responseText('Current answer.'); final.content[0].annotations = [{ type: 'url_citation', url: source.url, title: source.title }];
  const provider = queued([first, sse([{ type: 'response.completed', response: responseOutput([final], { input_tokens: 4, output_tokens: 3, total_tokens: 7 }) }])]);
  const events = await collect(options({ protocol: 'responses' }), { ...provider, search: async () => result });
  assert.deepEqual(provider.requests[1].body.input.slice(-3, -1), [reasoning, fn]);
  assert.deepEqual(events.filter(event => event.type === 'delta').map(event => event.text), ['Current answer.']);
  assert.equal(events.filter(event => event.type === 'reasoning').length, 1);
  assert.equal(events.filter(event => event.type === 'sources').flatMap(event => event.sources).length, 1);
  assert.deepEqual(events.filter(event => event.type === 'usage').at(-1).usage, { inputTokens: 7, outputTokens: 5, totalTokens: 12 });
});

test('Responses completed output alone can request multiple searches without separate tool deltas', async () => {
  const calls = [responseCall('one', 'one topic'), responseCall('two', 'two topic')];
  const provider = queued([sse([{ type: 'response.completed', response: responseOutput(calls) }]), json(responseOutput([responseText('Both checked.')]))]);
  const queries = [];
  const events = await collect(options({ protocol: 'responses' }), { ...provider, search: async query => { queries.push(query); return result; } });
  assert.deepEqual(queries, ['one topic', 'two topic']);
  assert.deepEqual(provider.requests[1].body.input.slice(-2).map(item => item.call_id), ['one', 'two']);
  assert.equal(events.at(-1).type, 'done');
});

test('search failures become redacted tool errors and the model can retry without claiming success', async () => {
  const provider = queued([json(chat([call('failed', 'first query')])), json(chat([call('retry', 'second query')])), json(chat([], 'The second search found evidence.'))]);
  let searchCount = 0;
  const events = await collect(options(), { ...provider, search: async () => { if (++searchCount === 1) throw new Error(`Bing error ${secret}`); return result; } });
  assert.deepEqual(events.filter(event => event.type === 'search').map(event => event.status), ['searching', 'error', 'searching', 'complete']);
  const failedResult = JSON.parse(provider.requests[1].body.messages.at(-1).content);
  assert.equal(failedResult.error, 'Bing error [redacted]'); assert.deepEqual(failedResult.sources, []);
  assert.match(failedResult.note, /do not claim/);
  assert.ok(!JSON.stringify(events).includes(secret)); assert.equal(events.at(-1).type, 'done');
});

test('prefetched initial response is consumed once and only continuations issue provider fetches', async () => {
  const provider = queued([json(chat([], 'Continuation reply.'))]);
  const events = await collect(options(), { ...provider, initialResponse: json(chat([call('initial', 'initial query')])), search: async () => result });
  assert.equal(provider.requests.length, 1); assert.equal(provider.requests[0].body.messages.at(-1).role, 'tool'); assert.equal(events.at(-1).type, 'done');
});

test('normal direct answers are allowed without invented search activity', async () => {
  const provider = queued([json(chat([], 'Hello.'))]);
  const events = await collect(options(), { ...provider, search: () => assert.fail('model did not call search') });
  assert.deepEqual(events, [{ type: 'delta', text: 'Hello.' }, { type: 'done' }]);
});

test('unknown tools, malformed arguments and duplicate call IDs are rejected before any search', async t => {
  const cases = [
    ['unknown', [call('x', 'query', { function: { name: 'shell', arguments: '{"query":"query"}' } })], /unsupported tool/],
    ['truncated-json', [call('x', 'query', { function: { name: 'web_search', arguments: '{"query":"incomplete' } })], /incomplete or invalid/],
    ['extra-argument', [call('x', 'query', { function: { name: 'web_search', arguments: '{"query":"query","url":"https://example.org"}' } })], /only a query string/],
    ['duplicate-id', [call('x', 'one'), call('x', 'two')], /duplicate/],
    ['empty', [call('x', '  ')], /1 to 500/],
    ['oversized', [call('x', 'q'.repeat(501))], /1 to 500/],
    ['control', [call('x', 'line\nline')], /control/],
    ['credential', [call('x', `find ${secret}`)], /private credentials/],
    ['encoded-credential', [call('x', `find ${encodeURIComponent(secret)}`)], /private credentials/],
    ['twice-encoded-credential', [call('x', `find ${encodeURIComponent(encodeURIComponent(secret))}`)], /private credentials/],
  ];
  for (const [name, calls, pattern] of cases) await t.test(name, async () => {
    const provider = queued([json(chat(calls))]);
    await assert.rejects(collect(options(), { ...provider, search: () => assert.fail('must validate all arguments first') }), pattern);
    assert.equal(provider.requests.length, 1);
  });
});

test('tool streams require completion and complete arguments; output truncation cannot execute searches', async t => {
  const cases = [
    ['chat-no-completion', 'chat', sse([{ choices: [{ delta: { tool_calls: [{ index: 0, ...call('x', 'query') }] } }] }]), /ended before/],
    ['chat-done-no-finish', 'chat', sse([{ choices: [{ delta: { tool_calls: [{ index: 0, ...call('x', 'query') }] } }] }], { done: true }), /did not finish its tool/],
    ['chat-length', 'chat', json(chat([call('x', 'query')], null, null, 'length')), /truncated/],
    ['responses-no-completion', 'responses', sse([{ type: 'response.output_item.done', output_index: 0, item: responseCall('x', 'query') }], { done: true }), /ended before/],
    ['responses-incomplete', 'responses', sse([{ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }]), /incomplete/],
    ['responses-undone-arguments', 'responses', sse([{ type: 'response.output_item.added', output_index: 0, item: { ...responseCall('x', 'query'), status: 'in_progress' } }, { type: 'response.completed', response: { status: 'completed' } }]), /did not finish/],
  ];
  for (const [name, protocol, response, pattern] of cases) await t.test(name, async () => {
    await assert.rejects(collect(options({ protocol }), { initialResponse: response, search: () => assert.fail('partial tools must never execute'), fetchImpl: () => assert.fail('partial tools must never resume') }), pattern);
  });
});

test('round and total-search limits request a final answer with tools disabled', async t => {
  await t.test('round-limit', async () => {
    const provider = queued([...Array.from({ length: MAX_TOOL_ROUNDS }, (_, index) => json(chat([call(`r${index}`, `query ${index}`)]))), json(chat([], 'Answer from the sources already collected.'))]);
    let searches = 0;
    const events = await collect(options(), { ...provider, search: async () => { searches++; return result; } });
    assert.equal(searches, MAX_TOOL_ROUNDS); assert.equal(provider.requests.length, MAX_TOOL_ROUNDS + 1);
    assert.equal(provider.requests.at(-1).body.tool_choice, 'none');
    assert.match(provider.requests.at(-1).body.messages.at(-1).content, /final answer/);
    assert.equal(events.filter(event => event.type === 'notice').length, 1);
    assert.equal(events.at(-1).type, 'done');
  });
  await t.test('search-limit', async () => {
    const provider = queued([json(chat(Array.from({ length: MAX_WEB_SEARCHES }, (_, index) => call(`s${index}`, `query ${index}`)))), sse([{ choices: [{ delta: { content: 'Final answer.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }], { done: true })]);
    let searches = 0;
    const events = await collect(options(), { ...provider, search: async () => { searches++; return result; } });
    assert.equal(searches, MAX_WEB_SEARCHES); assert.equal(provider.requests.length, 2);
    assert.equal(provider.requests.at(-1).body.tool_choice, 'none');
    assert.equal(provider.requests.at(-1).body.messages.filter(item => item.role === 'tool').length, MAX_WEB_SEARCHES);
    assert.deepEqual(events.filter(event => event.type === 'delta').map(event => event.text), ['Final answer.']);
    assert.equal(events.at(-1).type, 'done');
  });
});

test('both protocols pair every overflow batch call before one honest finalization and execute no partial new batch', async t => {
  for (const protocol of ['chat', 'responses']) await t.test(protocol, async () => {
    const firstCalls = Array.from({ length: 5 }, (_, index) => protocol === 'chat' ? call(`first_${index}`, `query ${index}`) : responseCall(`first_${index}`, `query ${index}`));
    const pendingCalls = ['query 5', 'query 6', ' QUERY   0 '].map((query, index) => protocol === 'chat' ? call(`pending_${index}`, query) : responseCall(`pending_${index}`, query));
    const reasoning = { type: 'reasoning', id: 'rs_budget', encrypted_content: 'budget-context', summary: [] };
    const replies = protocol === 'chat'
      ? [json(chat(firstCalls)), sse([{ choices: [{ delta: { tool_calls: pendingCalls.map((item, index) => ({ ...item, index })) } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }], { done: true }), json(chat([], 'I can answer using the existing five searches; two further queries were not searched.', { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }))]
      : [json(responseOutput(firstCalls)), sse([{ type: 'response.completed', response: responseOutput([reasoning, ...pendingCalls]) }]), sse([{ type: 'response.completed', response: responseOutput([responseText('I can answer using the existing five searches; two further queries were not searched.')], { input_tokens: 12, output_tokens: 3, total_tokens: 15 }) }])];
    const provider = queued(replies);
    const queries = [];
    const events = await collect(options({ protocol }), { ...provider, search: async query => { queries.push(query); return result; } });
    assert.deepEqual(queries, Array.from({ length: 5 }, (_, index) => `query ${index}`));
    assert.equal(provider.requests.length, 3);
    const last = provider.requests.at(-1).body;
    assert.equal(last.tool_choice, 'none');
    const items = protocol === 'chat' ? last.messages : last.input;
    const outputs = items.filter(item => protocol === 'chat' ? item.role === 'tool' : item.type === 'function_call_output');
    assert.equal(outputs.length, 8);
    const pendingOutputs = outputs.slice(-3).map(item => JSON.parse(protocol === 'chat' ? item.content : item.output));
    assert.deepEqual(pendingOutputs.slice(0, 2).map(item => item.code), ['search_budget_exhausted', 'search_budget_exhausted']);
    assert.deepEqual(pendingOutputs.slice(0, 2).map(item => item.sources), [[], []]);
    assert.equal(pendingOutputs[2].cached, true); assert.equal(pendingOutputs[2].sources[0].url, source.url);
    assert.deepEqual(outputs.slice(-3).map(item => item.tool_call_id ?? item.call_id), ['pending_0', 'pending_1', 'pending_2']);
    if (protocol === 'responses') {
      assert.deepEqual(items.find(item => item.id === reasoning.id), reasoning);
      assert.match(last.instructions, /evidence is insufficient/);
    }
    assert.equal(events.filter(event => event.type === 'notice').length, 1);
    assert.equal(events.filter(event => event.type === 'search' && event.status === 'searching').length, 5);
    assert.equal(events.filter(event => event.type === 'search' && event.cached).length, 1);
    const usage = events.filter(event => event.type === 'usage').at(-1);
    assert.equal(usage.usage, null, 'Two earlier provider rounds omitted usage, so the final-round subtotal is not the exact whole reply.');
    assert.deepEqual(usage.usageKnown, { inputTokens: 12, outputTokens: 3, totalTokens: 15 });
    assert.deepEqual(usage.usageCoverage, { providerCalls: 3, inputCalls: 1, outputCalls: 1, totalCalls: 1 });
    assert.equal(events.at(-1).type, 'done');
  });
});

test('oversized but valid initial batches are fully paired without inventing searches or evidence', async t => {
  for (const protocol of ['chat', 'responses']) await t.test(protocol, async () => {
    const calls = Array.from({ length: 7 }, (_, index) => protocol === 'chat' ? call(`overflow_${index}`, `new query ${index}`) : responseCall(`overflow_${index}`, `new query ${index}`));
    const provider = queued(protocol === 'chat' ? [json(chat(calls)), json(chat([], 'I could not gather web evidence for this request.'))] : [json(responseOutput(calls)), json(responseOutput([responseText('I could not gather web evidence for this request.')]))]);
    const events = await collect(options({ protocol }), { ...provider, search: () => assert.fail('overflow batch must not partly search') });
    assert.equal(provider.requests.at(-1).body.tool_choice, 'none');
    const items = protocol === 'chat' ? provider.requests.at(-1).body.messages : provider.requests.at(-1).body.input;
    const outputs = items.filter(item => item.role === 'tool' || item.type === 'function_call_output');
    assert.equal(outputs.length, 7);
    assert.ok(outputs.every(item => JSON.parse(item.content ?? item.output).code === 'search_budget_exhausted'));
    assert.equal(events.filter(event => ['search', 'sources'].includes(event.type)).length, 0);
    assert.equal(events.at(-1).type, 'done');
  });
});

test('normalized repeated queries reuse genuine results within a batch and across rounds without using new live-search budget', async t => {
  for (const protocol of ['chat', 'responses']) await t.test(protocol, async () => {
    const batches = [['Mars   RED', ' mars red '], ['MARS RED'], ['Mars red'], [' mars   red ']];
    const replies = batches.map((queries, round) => protocol === 'chat'
      ? json(chat(queries.map((query, index) => call(`cache_${round}_${index}`, query))))
      : json(responseOutput(queries.map((query, index) => responseCall(`cache_${round}_${index}`, query)))));
    replies.push(protocol === 'chat' ? json(chat([], 'Answer from the reused result.')) : json(responseOutput([responseText('Answer from the reused result.')])));
    const provider = queued(replies);
    let searches = 0;
    const events = await collect(options({ protocol }), { ...provider, search: async () => { searches++; return result; } });
    assert.equal(searches, 1); assert.equal(provider.requests.length, 5);
    const progress = events.filter(event => event.type === 'search');
    assert.equal(progress.filter(event => event.status === 'searching').length, 1);
    assert.equal(progress.filter(event => event.status === 'complete' && event.cached).length, 4);
    assert.ok(progress.every(event => event.searchIndex <= 100));
    assert.equal(events.filter(event => event.type === 'sources').flatMap(event => event.sources).length, 1);
    assert.equal(provider.requests.at(-1).body.tool_choice, 'none');
    assert.equal(events.at(-1).type, 'done');
  });
});

test('exact Responses last allowed search finalizes before another normal tool-enabled provider request and includes final usage', async () => {
  const calls = Array.from({ length: MAX_WEB_SEARCHES }, (_, index) => responseCall(`allowed_${index}`, `query ${index}`));
  const provider = queued([sse([{ type: 'response.completed', response: responseOutput(calls, { input_tokens: 10, output_tokens: 3, total_tokens: 13 }) }]), sse([{ type: 'response.output_text.delta', delta: 'Sourced final answer.' }, { type: 'response.completed', response: responseOutput([responseText('Sourced final answer.')], { input_tokens: 20, output_tokens: 5, total_tokens: 25 }) }])]);
  let searches = 0;
  const events = await collect(options({ protocol: 'responses' }), { ...provider, search: async () => { searches++; return result; } });
  assert.equal(searches, MAX_WEB_SEARCHES); assert.equal(provider.requests.length, 2);
  assert.equal(provider.requests[1].body.tool_choice, 'none');
  assert.equal(provider.requests[1].body.input.filter(item => item.type === 'function_call_output').length, MAX_WEB_SEARCHES);
  assert.deepEqual(events.filter(event => event.type === 'usage').at(-1).usage, { inputTokens: 30, outputTokens: 8, totalTokens: 38 });
  assert.deepEqual(events.filter(event => event.type === 'delta').map(event => event.text), ['Sourced final answer.']);
  assert.equal(events.at(-1).type, 'done');
});

test('failed repeated searches stay truthful cached errors and finalization asks the model to disclose missing evidence', async () => {
  const provider = queued([...Array.from({ length: MAX_TOOL_ROUNDS }, (_, index) => json(chat([call(`failure_${index}`, index % 2 ? ' PUBLIC  QUERY ' : 'public query')]))), json(chat([], 'Web search failed, so I cannot verify the current claim.'))]);
  let searches = 0;
  const events = await collect(options(), { ...provider, search: async () => { searches++; throw new Error(`Search unavailable ${secret}`); } });
  assert.equal(searches, 1);
  const progress = events.filter(event => event.type === 'search');
  assert.equal(progress.filter(event => event.status === 'error').length, MAX_TOOL_ROUNDS);
  assert.equal(progress.filter(event => event.cached).length, MAX_TOOL_ROUNDS - 1);
  assert.equal(events.filter(event => event.type === 'sources').length, 0);
  assert.match(provider.requests.at(-1).body.messages.at(-1).content, /searches failed/);
  assert.ok(!JSON.stringify(events).includes(secret));
  assert.equal(events.at(-1).type, 'done');
});

test('providers ignoring final tool_choice none receive one actionable failure without another search or continuation', async t => {
  for (const protocol of ['chat', 'responses']) await t.test(protocol, async () => {
    const calls = Array.from({ length: MAX_WEB_SEARCHES }, (_, index) => protocol === 'chat' ? call(`allowed_${index}`, `query ${index}`) : responseCall(`allowed_${index}`, `query ${index}`));
    const ignored = protocol === 'chat' ? json(chat([call('ignored', 'one more query')])) : sse([{ type: 'response.completed', response: responseOutput([responseCall('ignored', 'one more query')]) }]);
    const provider = queued([protocol === 'chat' ? json(chat(calls)) : json(responseOutput(calls)), ignored]);
    let searches = 0;
    await assert.rejects(collect(options({ protocol }), { ...provider, search: async () => { searches++; return result; } }), /ignored tool_choice: none/);
    assert.equal(searches, MAX_WEB_SEARCHES); assert.equal(provider.requests.length, 2);
  });
});

test('an invalid call in an overflow batch still fails strict validation before any search or finalization', async () => {
  const provider = queued([json(chat([...Array.from({ length: 7 }, (_, index) => call(`valid_${index}`, `query ${index}`)), call('unknown', 'query', { function: { name: 'shell', arguments: '{"query":"query"}' } })]))]);
  await assert.rejects(collect(options(), { ...provider, search: () => assert.fail('invalid batch must not search') }), /unsupported tool/);
  assert.equal(provider.requests.length, 1);
});

test('cancelling the finalization continuation aborts without dropping cancellation or inventing a finished answer', async () => {
  const controller = new AbortController();
  const first = json(chat(Array.from({ length: MAX_WEB_SEARCHES }, (_, index) => call(`allowed_${index}`, `query ${index}`))));
  let requests = 0;
  const events = [];
  await assert.rejects((async () => {
    for await (const event of agentChatEvents(options(), controller.signal, {
      initialResponse: first, search: async () => result,
      fetchImpl: async (url, request) => {
        requests++; assert.equal(JSON.parse(request.body).tool_choice, 'none');
        controller.abort(new DOMException('Final answer cancelled.', 'AbortError'));
        return new Promise(() => {});
      },
    })) events.push(event);
  })(), /Final answer cancelled/);
  assert.equal(requests, 1);
  assert.equal(events.filter(event => event.type === 'notice').length, 1);
  assert.equal(events.filter(event => event.type === 'done').length, 0);
});

test('provider rejection of tools preserves its error and does not silently retry text-only', async () => {
  const provider = queued([json({ error: { message: `Tools are unsupported ${secret}` } }, 422)]);
  await assert.rejects(collect(options(), { ...provider, search: () => assert.fail('provider rejected request') }), error => error.status === 422 && error.message === 'Tools are unsupported [redacted]');
  assert.equal(provider.requests.length, 1); assert.equal(provider.requests[0].redirect, 'error');
});

test('tool sources discard unsafe URLs, credentials and duplicates and redact snippet/title before replay', async () => {
  const provider = queued([json(chat([call('safe', 'public query')])), json(chat([], 'Safe answer.'))]);
  const events = await collect(options(), { ...provider, search: async () => ({ engine: 'Bing', sources: [
    { ...source, title: `NASA ${secret}`, snippet: `Data ${secret}` },
    { ...source }, { title: 'Bad', url: 'javascript:alert(1)' },
    { title: 'Credentials', url: 'https://user:password@example.org/' },
    { title: 'Secret', url: `https://example.org/${encodeURIComponent(secret)}` },
  ] }) });
  const references = events.filter(event => event.type === 'sources').flatMap(event => event.sources);
  assert.deepEqual(references, [{ title: 'NASA [redacted]', url: source.url, snippet: 'Data [redacted]' }]);
  assert.ok(!provider.requests[1].body.messages.at(-1).content.includes(secret));
});

test('cancelling a pending model-selected search stops continuation even when search ignores signal', async () => {
  const controller = new AbortController();
  const events = [];
  let requestedSignal;
  const run = (async () => {
    for await (const event of agentChatEvents(options(), controller.signal, {
      initialResponse: json(chat([call('cancel', 'cancel query')])),
      search: async (query, { signal }) => { requestedSignal = signal; controller.abort(new DOMException('Stopped by user.', 'AbortError')); return new Promise(() => {}); },
      fetchImpl: () => assert.fail('must not resume after cancellation'),
    })) events.push(event);
  })();
  await assert.rejects(run, /Stopped by user/);
  assert.equal(requestedSignal, controller.signal);
  assert.deepEqual(events.map(event => event.type), ['search']);
});

test('cancelling a blocked provider event-stream read cancels its reader and never reports done', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream({ start() { queueMicrotask(() => controller.abort(new DOMException('Stream stopped.', 'AbortError'))); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  await assert.rejects(collect(options(), { initialResponse: response }, controller.signal), /Stream stopped/);
  assert.equal(cancelled, true);
});

test('oversized generated reasoning replay fails before search or provider continuation', async () => {
  const provider = queued([json(responseOutput([{ type: 'reasoning', id: 'large', encrypted_content: 'x'.repeat(2 * 1024 * 1024), summary: [] }, responseCall('x', 'public query')]))]);
  await assert.rejects(collect(options({ protocol: 'responses' }), { ...provider, search: () => assert.fail('oversized response must not search') }), /oversized JSON|too much tool/);
  assert.equal(provider.requests.length, 1);
});

test('live provider deltas are yielded while completion is still blocked in both protocols and web-search modes', async t => {
  for (const protocol of ['chat', 'responses']) for (const webSearch of [false, true]) await t.test(`${protocol}/${webSearch ? 'tools' : 'plain'}`, async () => {
    const gate = gatedSSE(protocol === 'chat' ? [{ choices: [{ delta: { content: 'First chunk ' } }] }] : [{ type: 'response.output_text.delta', item_id: 'msg_live', output_index: 0, content_index: 0, delta: 'First chunk ' }]);
    const iterator = agentChatEvents(options({ protocol, webSearch }), undefined, { initialResponse: gate.response, search: () => assert.fail('direct answer needs no search') });
    const seen = [];
    try {
      assert.deepEqual(await nextMatching(iterator, 'delta', seen), { type: 'delta', text: 'First chunk ' });
      assert.equal(gate.closed, false); assert.equal(seen.some(event => event.type === 'done'), false);
      gate.end(protocol === 'chat' ? [{ choices: [{ delta: { content: 'second chunk' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }] : [{ type: 'response.output_text.delta', item_id: 'msg_live', output_index: 0, content_index: 0, delta: 'second chunk' }, { type: 'response.completed', response: responseOutput([{ ...responseText('First chunk second chunk'), id: 'msg_live' }]) }]);
      for await (const event of iterator) seen.push(event);
      assert.equal(seen.filter(event => event.type === 'delta').map(event => event.text).join(''), 'First chunk second chunk');
      assert.equal(seen.filter(event => event.type === 'done').length, 1);
    } finally { gate.end(); await iterator.return(); }
  });
});

test('Responses finalized text/part/item fallback forwards immediately before response.completed and never repeats snapshots', async t => {
  for (const variant of ['text', 'part', 'item']) await t.test(variant, async () => {
    const message = { ...responseText('Available finalized text.'), id: 'msg_done' };
    const first = variant === 'text' ? { type: 'response.output_text.done', item_id: message.id, output_index: 1, content_index: 0, text: 'Available finalized text.' }
      : variant === 'part' ? { type: 'response.content_part.done', item_id: message.id, output_index: 1, content_index: 0, part: message.content[0] }
      : { type: 'response.output_item.done', output_index: 1, item: message };
    const gate = gatedSSE([first]);
    const iterator = agentChatEvents(options({ protocol: 'responses' }), undefined, { initialResponse: gate.response });
    const seen = [];
    try {
      assert.deepEqual(await nextMatching(iterator, 'delta', seen), { type: 'delta', text: 'Available finalized text.' });
      assert.equal(gate.closed, false);
      gate.end([
        { type: 'response.content_part.done', item_id: message.id, output_index: 1, content_index: 0, part: message.content[0] },
        { type: 'response.output_item.done', output_index: 1, item: message },
        { type: 'response.completed', response: responseOutput([{ type: 'reasoning', id: 'rs', summary: [] }, message]) },
      ]);
      for await (const event of iterator) seen.push(event);
      assert.deepEqual(seen.filter(event => event.type === 'delta').map(event => event.text), ['Available finalized text.']);
      assert.equal(seen.at(-1).type, 'done');
    } finally { gate.end(); await iterator.return(); }
  });
});

test('Responses tracks snapshots per content part, completing partial text and including later non-delta parts once', async () => {
  const message = { type: 'message', role: 'assistant', status: 'completed', id: 'msg_parts', content: [{ type: 'output_text', text: 'First answer. ' }, { type: 'refusal', refusal: 'I cannot verify the rest.' }] };
  const provider = queued([sse([
    { type: 'response.output_item.added', output_index: 1, item: { ...message, content: [], status: 'in_progress' } },
    { type: 'response.output_text.delta', item_id: message.id, output_index: 1, content_index: 0, delta: 'First ' },
    { type: 'response.output_text.done', item_id: message.id, output_index: 1, content_index: 0, text: 'First answer. ' },
    { type: 'response.refusal.done', item_id: message.id, output_index: 1, content_index: 1, refusal: 'I cannot verify the rest.' },
    { type: 'response.output_item.done', output_index: 1, item: message },
    { type: 'response.completed', response: responseOutput([{ type: 'reasoning', id: 'rs', summary: [] }, message]) },
  ])]);
  const events = await collect(options({ protocol: 'responses' }), provider);
  assert.deepEqual(events.filter(event => event.type === 'delta').map(event => event.text), ['First ', 'answer. ', 'I cannot verify the rest.']);
});

test('metadata-free Responses gateway deltas reconcile with the later message after a reasoning item', async () => {
  const provider = queued([sse([{ type: 'response.output_text.delta', delta: 'Hello' }, { type: 'response.completed', response: responseOutput([{ type: 'reasoning', id: 'rs', summary: [] }, { ...responseText('Hello there.'), id: 'msg' }]) }])]);
  const events = await collect(options({ protocol: 'responses' }), provider);
  assert.deepEqual(events.filter(event => event.type === 'delta').map(event => event.text), ['Hello', ' there.']);
});

test('search continuations and budget final answers stream their first chunk before completion without losing context', async t => {
  for (const protocol of ['chat', 'responses']) for (const budget of [false, true]) await t.test(`${protocol}/${budget ? 'finalization' : 'continuation'}`, async () => {
    const calls = Array.from({ length: budget ? MAX_WEB_SEARCHES : 1 }, (_, index) => protocol === 'chat' ? call(`stream_${index}`, `query ${index}`) : responseCall(`stream_${index}`, `query ${index}`));
    const gate = gatedSSE(protocol === 'chat' ? [{ choices: [{ delta: { content: 'Streaming final ' } }] }] : [{ type: 'response.output_text.delta', item_id: 'msg_stream', output_index: 0, content_index: 0, delta: 'Streaming final ' }]);
    const provider = queued([gate.response]);
    const initialResponse = protocol === 'chat' ? json(chat(calls)) : json(responseOutput(calls));
    const settings = options({ protocol, messages: [{ role: 'user', content: 'Prior context', attachments: [{ id: 'note', name: 'note.txt', kind: 'text', size: 4, text: 'data', type: 'text/plain' }] }, { role: 'assistant', content: 'Prior reply' }, { role: 'user', content: 'Use this context.' }] });
    const iterator = agentChatEvents(settings, undefined, { ...provider, initialResponse, search: async () => result });
    const seen = [];
    try {
      assert.equal((await nextMatching(iterator, 'delta', seen)).text, 'Streaming final ');
      assert.equal(gate.closed, false); assert.equal(provider.requests.length, 1);
      const continued = provider.requests[0].body;
      assert.equal(continued.stream, true); assert.match(provider.requests[0].auth, /^Bearer /);
      assert.equal(continued.tool_choice, budget ? 'none' : 'auto');
      const original = buildChatPayload(settings);
      const key = protocol === 'chat' ? 'messages' : 'input';
      assert.deepEqual(continued[key].slice(0, original[key].length), original[key]);
      assert.equal(protocol === 'chat' ? continued.reasoning_effort : continued.reasoning.effort, 'low');
      gate.end(protocol === 'chat' ? [{ choices: [{ delta: { content: 'answer.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }] : [{ type: 'response.output_text.delta', item_id: 'msg_stream', output_index: 0, content_index: 0, delta: 'answer.' }, { type: 'response.completed', response: responseOutput([{ ...responseText('Streaming final answer.'), id: 'msg_stream' }]) }]);
      for await (const event of iterator) seen.push(event);
      assert.equal(seen.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Streaming final answer.');
      assert.equal(seen.at(-1).type, 'done');
    } finally { gate.end(); await iterator.return(); }
  });
});

test('disabled web-search mode can cancel a delayed synthetic stream without waiting for completion', async () => {
  const controller = new AbortController();
  const response = new Response(new ReadableStream({}), { headers: { 'Content-Type': 'text/event-stream' } });
  const iterator = agentChatEvents(options({ webSearch: false }), controller.signal, { initialResponse: response });
  const pending = iterator.next();
  controller.abort(new DOMException('Stopped while waiting for the next token.', 'AbortError'));
  await assert.rejects(pending, /Stopped while waiting/);
});

test('usage counts every autonomous provider request exactly once including repeated prompt context', async t => {
  for (const protocol of ['chat', 'responses']) await t.test(protocol, async () => {
    const first = protocol === 'chat' ? json(chat([call('usage_first', 'first evidence')], null, { prompt_tokens: 100, completion_tokens: 5 })) : json(responseOutput([responseCall('usage_first', 'first evidence')], { input_tokens: 100, output_tokens: 5 }));
    const second = protocol === 'chat' ? json(chat([call('usage_second', 'second evidence')], null, { prompt_tokens: 160, completion_tokens: 7 })) : json(responseOutput([responseCall('usage_second', 'second evidence')], { input_tokens: 160, output_tokens: 7 }));
    const final = protocol === 'chat' ? json(chat([], 'A sourced answer.', { prompt_tokens: 240, completion_tokens: 20 })) : json(responseOutput([responseText('A sourced answer.')], { input_tokens: 240, output_tokens: 20 }));
    const events = await collect(options({ protocol }), { ...queued([first, second, final]), search: async () => result });
    const last = events.filter(event => event.type === 'usage').at(-1);
    assert.deepEqual(last.usage, { inputTokens: 500, outputTokens: 32, totalTokens: 532 });
    assert.deepEqual(last.usageKnown, last.usage);
    assert.deepEqual(last.usageCoverage, { providerCalls: 3, inputCalls: 3, outputCalls: 3, totalCalls: 3 });
    assert.ok(events.some(event => event.type === 'usage' && event.usage === null && event.usageCoverage.providerCalls === 2), 'An in-flight continuation must not leave its prior subtotal marked complete');
  });
});

test('missing usage in either earlier or final rounds makes aggregate fields unavailable while preserving known counts', async t => {
  for (const protocol of ['chat', 'responses']) for (const missing of ['first', 'final']) await t.test(`${protocol}/${missing}`, async () => {
    const firstUsage = missing === 'first' ? undefined : { input_tokens: 10, output_tokens: 3 };
    const finalUsage = missing === 'final' ? undefined : { input_tokens: 20, output_tokens: 5 };
    const first = protocol === 'chat' ? json(chat([call('coverage', 'evidence')], null, firstUsage)) : json(responseOutput([responseCall('coverage', 'evidence')], firstUsage));
    const final = protocol === 'chat' ? json(chat([], 'Answer.', finalUsage)) : json(responseOutput([responseText('Answer.')], finalUsage));
    const events = await collect(options({ protocol }), { ...queued([first, final]), search: async () => result });
    const last = events.filter(event => event.type === 'usage').at(-1);
    assert.equal(last.usage, null);
    assert.deepEqual(last.usageKnown, missing === 'first' ? { inputTokens: 20, outputTokens: 5, totalTokens: 25 } : { inputTokens: 10, outputTokens: 3, totalTokens: 13 });
    assert.deepEqual(last.usageCoverage, { providerCalls: 2, inputCalls: 1, outputCalls: 1, totalCalls: 1 });
  });
});

test('aggregate usage completeness is field-specific and unknown output/total are never inferred from known input', async () => {
  const provider = queued([json(chat([call('partial', 'evidence')], null, { prompt_tokens: 10 })), json(chat([], 'Answer.', { prompt_tokens: 20, completion_tokens: 5 }))]);
  const events = await collect(options(), { ...provider, search: async () => result });
  const last = events.filter(event => event.type === 'usage').at(-1);
  assert.deepEqual(last.usage, { inputTokens: 30 });
  assert.deepEqual(last.usageKnown, { inputTokens: 30, outputTokens: 5, totalTokens: 25 });
  assert.deepEqual(last.usageCoverage, { providerCalls: 2, inputCalls: 2, outputCalls: 1, totalCalls: 1 });
});

test('repeated cumulative usage snapshots within one provider stream replace rather than add counts', async () => {
  const provider = queued([sse([
    { choices: [{ delta: { content: 'Answer.' } }], usage: { prompt_tokens: 10, completion_tokens: 1 } },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ], { done: true })]);
  const events = await collect(options(), provider);
  const last = events.filter(event => event.type === 'usage').at(-1);
  assert.deepEqual(last.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  assert.deepEqual(last.usageCoverage, { providerCalls: 1, inputCalls: 1, outputCalls: 1, totalCalls: 1 });
  assert.equal(events.filter(event => event.type === 'usage').length, 3, 'The duplicated final snapshot should not be emitted again');
});

test('truncated responses retain actual provider usage if the failed final event supplies it', async () => {
  const events = [];
  await assert.rejects((async () => {
    for await (const event of agentChatEvents(options(), undefined, { initialResponse: json(chat([], 'Partial.', { prompt_tokens: 10, completion_tokens: 5 }, 'length')) })) events.push(event);
  })(), /truncated/);
  assert.deepEqual(events.find(event => event.type === 'usage').usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  assert.equal(events.some(event => event.type === 'done'), false);
});

test('failed and cancelled continuations preserve known paid counts but leave the new provider request unknown', async t => {
  await t.test('provider-fetch-error', async () => {
    const events = [];
    await assert.rejects((async () => {
      for await (const event of agentChatEvents(options(), undefined, { initialResponse: json(chat([call('paid', 'evidence')], null, { prompt_tokens: 10, completion_tokens: 3 })), search: async () => result, fetchImpl: async () => { throw new Error('private network detail'); } })) events.push(event);
    })(), /Could not reach the provider/);
    const last = events.filter(event => event.type === 'usage').at(-1);
    assert.equal(last.usage, null); assert.deepEqual(last.usageKnown, { inputTokens: 10, outputTokens: 3, totalTokens: 13 });
    assert.deepEqual(last.usageCoverage, { providerCalls: 2, inputCalls: 1, outputCalls: 1, totalCalls: 1 });
    assert.ok(!JSON.stringify(events).includes('private network detail'));
  });
  await t.test('cancelled-provider-stream', async () => {
    const controller = new AbortController();
    const events = [];
    let fetches = 0;
    await assert.rejects((async () => {
      for await (const event of agentChatEvents(options(), controller.signal, {
        initialResponse: json(chat([call('paid', 'evidence')], null, { prompt_tokens: 10, completion_tokens: 3 })), search: async () => result,
        fetchImpl: async () => { fetches++; return new Response(new ReadableStream({ start() { queueMicrotask(() => controller.abort(new DOMException('Reply stopped.', 'AbortError'))); } }), { headers: { 'Content-Type': 'text/event-stream' } }); },
      })) events.push(event);
    })(), /Reply stopped/);
    assert.equal(fetches, 1);
    const last = events.filter(event => event.type === 'usage').at(-1);
    assert.equal(last.usage, null); assert.deepEqual(last.usageKnown, { inputTokens: 10, outputTokens: 3, totalTokens: 13 });
    assert.deepEqual(last.usageCoverage, { providerCalls: 2, inputCalls: 1, outputCalls: 1, totalCalls: 1 });
    assert.equal(events.some(event => event.type === 'done'), false);
  });
});
