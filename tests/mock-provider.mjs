// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

// Disposable local provider for browser QA. It ignores authorization and never
// logs credentials or prompt text. Do not use /inspect with private prompts.
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MODELS = ['demo-chat', 'demo-reasoning', 'demo-web-search', 'demo-search-loop', 'gpt-image-test'];
const MODEL_SCENARIOS = 'empty|malformed|wrong-shape|error|slow|huge|strings|names';
const API_ROUTE = new RegExp(`^/(?:(?:scenarios/)?(${MODEL_SCENARIOS})/)?v1/(models|chat/completions|responses|images/generations|images/edits)$`);
// A valid, locally generated 1×1 RGBA PNG. These are actual image bytes;
// partial-image events come from the fixture provider, not a UI animation.
export const MOCK_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4v4DhPwAG4AKfS2rjvAAAAABJRU5ErkJggg==';
const TEXT_CHUNKS = [
  'Your local API tool is working. ',
  '**Streaming is live.**\n\n',
  '你好，世界 🌍\n\n',
  '- Model selection works\n',
  '- Reasoning effort reaches the provider\n',
  '- Messages preserve conversation history\n\n',
  '```js\n',
  'console.log("Hello from your API tool");\n',
  '```\n\n',
  'You can send another message or try **slow** to test Stop.',
];

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readRawBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw new Error('Test request is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readBody(req) {
  return JSON.parse((await readRawBody(req)).toString('utf8'));
}

async function readImageBody(req) {
  if (!req.headers['content-type']?.startsWith('multipart/form-data')) return { body: await readBody(req), images: [] };
  const form = await new Response(await readRawBody(req), { headers: { 'Content-Type': req.headers['content-type'] } }).formData();
  const body = {}, images = [];
  for (const [name, value] of form) {
    if (typeof value === 'string') body[name] = value;
    else images.push({ field: name, name: value.name, type: value.type, size: value.size });
  }
  return { body, images };
}

function delay(milliseconds, res) {
  return new Promise(resolve => {
    if (res.destroyed) { resolve(); return; }
    const timer = setTimeout(finish, milliseconds);
    function finish() { clearTimeout(timer); res.off('close', finish); resolve(); }
    res.once('close', finish);
  });
}

async function writeFragmented(res, payload) {
  const bytes = Buffer.from(payload);
  const sizes = [1, 7, 19, 3, 41];
  let offset = 0;
  let part = 0;
  while (offset < bytes.length && !res.destroyed) {
    const end = Math.min(bytes.length, offset + sizes[part++ % sizes.length]);
    res.write(bytes.subarray(offset, end));
    offset = end;
    // Separate some writes across event-loop turns to exercise chunk parsing.
    if (part % 3 === 0) await delay(2, res);
  }
}

function dataBytes(value) {
  if (typeof value !== 'string') return undefined;
  const match = /^data:[^;,]+;base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  if (!match || match[1].length % 4 !== 0) return undefined;
  const base64 = match[1];
  return base64.length / 4 * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
}

function cleanPart(part) {
  if (!part || typeof part !== 'object') return { type: 'unknown' };
  const type = typeof part.type === 'string' ? part.type.slice(0, 80) : 'unknown';
  if (['text', 'input_text', 'output_text'].includes(type)) {
    return { type, ...(typeof part.text === 'string' ? { text: part.text } : {}) };
  }
  if (['image_url', 'input_image'].includes(type)) {
    const imageBytes = dataBytes(typeof part.image_url === 'string' ? part.image_url : part.image_url?.url);
    return { type, ...(imageBytes !== undefined ? { imageBytes } : {}) };
  }
  if (['file', 'input_file'].includes(type)) {
    const file = type === 'file' ? part.file : part;
    const fileBytes = dataBytes(file?.file_data);
    return {
      type,
      ...(typeof file?.filename === 'string' ? { filename: file.filename.slice(0, 255) } : {}),
      ...(fileBytes !== undefined ? { fileBytes } : {}),
    };
  }
  return { type };
}

function cleanMessages(body, protocol) {
  const incoming = protocol === 'responses' ? body.input : body.messages;
  const messages = (Array.isArray(incoming) ? incoming : []).map(message => {
    const parts = Array.isArray(message?.content) ? message.content.map(cleanPart) : [];
    return {
      role: typeof message?.role === 'string' ? message.role : 'unknown',
      content: typeof message?.content === 'string' ? message.content : parts.filter(part => typeof part.text === 'string').map(part => part.text).join('\n'),
      ...(parts.length ? { parts } : {}),
    };
  });
  if (protocol === 'responses' && typeof body.instructions === 'string' && body.instructions) {
    messages.unshift({ role: 'system', content: body.instructions });
  }
  return messages;
}

function searchTool(body, protocol) {
  return (body.tools || []).find(tool => protocol === 'responses'
    ? tool.type === 'function' && tool.name === 'web_search'
    : tool.type === 'function' && tool.function?.name === 'web_search');
}

function toolOutputs(body, protocol) {
  const incoming = protocol === 'responses' ? body.input : body.messages;
  return (Array.isArray(incoming) ? incoming : []).filter(item => protocol === 'responses'
    ? item?.type === 'function_call_output' : item?.role === 'tool')
    .map(item => protocol === 'responses' ? item.output : item.content);
}

function modelSearchQuery(body, protocol) {
  const incoming = protocol === 'responses' ? body.input : body.messages;
  const user = (Array.isArray(incoming) ? incoming : []).findLast(item => item?.role === 'user');
  const primary = typeof user?.content === 'string' ? user.content : user?.content?.find(part => ['text', 'input_text'].includes(part?.type) && !part.text?.startsWith('Attachment:'))?.text;
  const query = String(primary || 'information relevant to the attached file')
    .replace(/^\s*(?:search|look up)(?:\s+(?:the web|web|for))?\s*/i, '')
    .replace(/\s+/g, ' ').trim();
  return (query || 'Relay API tool documentation').slice(0, 500);
}

function searchAnswer(output) {
  let result;
  try { result = typeof output === 'string' ? JSON.parse(output) : output; } catch {}
  const sources = Array.isArray(result?.sources) ? result.sources : [];
  if (!sources.length) {
    return result?.error ? `The search tool reported a failure: ${typeof result.error === 'string' ? result.error : result.error.message || 'Search unavailable'}. I have no search sources to cite.` : 'The search tool returned no sources. I have no search sources to cite.';
  }
  return `I searched the web for **${result.query || 'your question'}** and received these sources:\n\n` + sources.map(source => `- [${source.title || source.url}](${source.url})${source.snippet ? `: ${source.snippet}` : ''}`).join('\n') + '\n\nThese links come from the search tool results received in this conversation.';
}

function loopQuery(query, priorOutputs) {
  if (priorOutputs < 2) return query;
  const refinements = ['NASA iron oxide evidence', 'Mars surface oxidation explanation', 'iron minerals on Mars'];
  return `${query} ${refinements[(priorOutputs - 2) % refinements.length]}`.slice(0, 500);
}

function loopAnswer(outputs, query) {
  const sources = [], urls = new Set();
  for (const output of outputs) {
    let result;
    try { result = JSON.parse(output); } catch { continue; }
    for (const source of result.sources || []) {
      if (urls.has(source.url)) continue;
      urls.add(source.url); sources.push(source);
    }
  }
  return sources.length
    ? `I have finished researching and will answer from the collected evidence.\n\n${searchAnswer({ query, sources })}`
    : 'I have finished the available searches. The tool returned no usable source evidence, so I cannot give a verified web answer.';
}

export function createMockProvider({ log = console.log } = {}) {
  let recentRequest = null;
  return http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const route = pathname.match(API_ROUTE);
    const scenario = route?.[1] ?? 'default';
    const endpoint = route?.[2];
    try {
      if (req.method === 'GET' && endpoint === 'models') {
        log(`GET ${pathname}`);
        if (scenario === 'slow') await delay(1500, res);
        if (res.destroyed) return;
        if (scenario === 'error') { json(res, 401, { error: 'Mock provider rejected this model-list request.' }); return; }
        if (scenario === 'malformed') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"data":['); return; }
        if (scenario === 'wrong-shape') { json(res, 200, { data: 'not a model array' }); return; }
        if (scenario === 'empty') { json(res, 200, { object: 'list', data: [] }); return; }
        if (scenario === 'strings') { json(res, 200, { data: [...MODELS, ' demo-chat ', '', null] }); return; }
        if (scenario === 'names') { json(res, 200, { models: MODELS.map(name => ({ name })) }); return; }
        const models = scenario === 'huge'
          ? [...MODELS, ...Array.from({ length: 2000 }, (_, index) => `demo-chat-${String(index + 1).padStart(4, '0')}`)]
          : MODELS;
        json(res, 200, { object: 'list', data: models.map(id => ({ id, object: 'model', owned_by: 'local-mock' })) });
        return;
      }
      if (req.method === 'GET' && pathname === '/inspect') {
        log(`GET ${pathname}`);
        json(res, 200, recentRequest ?? { model: null, effort: null, protocol: null, messages: [] });
        return;
      }
      if (req.method === 'POST' && ['images/generations', 'images/edits'].includes(endpoint)) {
        const { body, images } = await readImageBody(req);
        const model = typeof body.model === 'string' ? body.model : 'gpt-image-test';
        const prompt = String(body.prompt || '');
        const streaming = body.stream === true || body.stream === 'true';
        recentRequest = { model, protocol: 'images', endpoint: pathname, stream: streaming, partialImages: Number(body.partial_images || 0), n: Number(body.n || 1), promptLength: prompt.length, imageInputCount: images.length, imageInputs: images };
        log(`${req.method} ${pathname} model=${JSON.stringify(model)} stream=${streaming} imageInputs=${images.length}`);
        if (/error/i.test(prompt)) { json(res, 401, { error: { message: 'Mock image provider rejected this test request.' } }); return; }
        const image = { b64_json: MOCK_IMAGE_BASE64, revised_prompt: 'A tiny orange square.', output_format: 'png' };
        if (!streaming || /\bjson\b|\burl\b/i.test(prompt)) {
          json(res, 200, { created: 1, data: [/\burl\b/i.test(prompt) ? { url: 'https://example.test/generated.png', revised_prompt: image.revised_prompt } : image], usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 } });
          return;
        }
        const pause = /slow/i.test(prompt) ? 500 : 50;
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        const eventType = endpoint === 'images/edits' ? 'image_edit' : 'image_generation';
        for (const index of [0, 1]) {
          if (res.destroyed) return;
          const event = { type: `${eventType}.partial_image`, b64_json: MOCK_IMAGE_BASE64, partial_image_index: index, output_format: 'png' };
          await writeFragmented(res, `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`);
          await delay(pause, res);
        }
        if (res.destroyed) return;
        const event = { type: `${eventType}.completed`, ...image, usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 } };
        await writeFragmented(res, `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`);
        res.end();
        return;
      }
      if (req.method !== 'POST' || !['chat/completions', 'responses'].includes(endpoint)) {
        log(`${req.method} ${pathname}`);
        json(res, 404, { error: { message: 'Mock endpoint not found.' } });
        return;
      }
      const body = await readBody(req);
      const protocol = endpoint === 'responses' ? 'responses' : 'chat';
      const messages = cleanMessages(body, protocol);
      const model = typeof body.model === 'string' ? body.model : 'demo-chat';
      if (/^(?:gpt-image|dall-e)(?:-|$)/i.test(model)) { json(res, 400, { error: { message: 'Image models use /v1/images/generations or /v1/images/edits.' } }); return; }
      const effort = protocol === 'responses' ? (body.reasoning?.effort ?? 'auto') : (body.reasoning_effort ?? 'auto');
      const outputs = toolOutputs(body, protocol);
      const result = outputs.at(-1) ?? null;
      const searchModel = ['demo-web-search', 'demo-search-loop'].includes(model);
      recentRequest = { model, effort, protocol, messages, ...(searchModel ? { toolNames: (body.tools || []).map(tool => tool.name || tool.function?.name).filter(Boolean), receivedToolResult: result !== null } : {}), ...(model === 'demo-search-loop' ? { toolChoice: body.tool_choice, toolResultCount: outputs.length } : {}) };
      log(`${req.method} ${pathname} model=${JSON.stringify(model)} effort=${JSON.stringify(effort)} roles=${messages.map(message => message.role).join(',')}`);
      const lastUser = messages.findLast(message => message.role === 'user')?.content ?? '';
      if (/error/i.test(lastUser)) {
        json(res, 401, { error: { message: 'Mock provider rejected this test request.' } });
        return;
      }
      const pause = /slow/i.test(lastUser) ? 500 : 25;
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      const send = async event => {
        if (res.destroyed) return;
        const eventLine = protocol === 'responses' ? `event: ${event.type}\r\n` : '';
        await writeFragmented(res, `${eventLine}data: ${JSON.stringify(event)}\r\n\r\n`);
      };
      if (protocol === 'responses') {
        await send({ type: 'response.created', response: { id: 'resp_local_mock', object: 'response', model, status: 'in_progress' } });
      } else {
        await send({ id: 'chatcmpl_local_mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
      }
      const loop = model === 'demo-search-loop';
      const ignoringFinalInstruction = loop && /ignore[- ]none/i.test(lastUser);
      if (searchModel && searchTool(body, protocol) && (loop ? body.tool_choice !== 'none' || ignoringFinalInstruction : result === null)) {
        const callId = loop ? `call_mock_search_loop_${outputs.length + 1}` : 'call_mock_web_search';
        const query = modelSearchQuery(body, protocol);
        const args = JSON.stringify({ query: loop ? loopQuery(query, outputs.length) : query });
        if (protocol === 'responses') {
          const item = { id: loop ? `fc_mock_search_loop_${outputs.length + 1}` : 'fc_mock_web_search', type: 'function_call', call_id: callId, name: 'web_search', arguments: args, status: 'completed' };
          await send({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } });
          await send({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: args });
          await send({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: args });
          await send({ type: 'response.output_item.done', output_index: 0, item });
          await send({ type: 'response.completed', response: { id: 'resp_mock_search_call', status: 'completed', model, output: [item], usage: { input_tokens: 24, output_tokens: 12, total_tokens: 36 } } });
        } else {
          const split = Math.floor(args.length / 2);
          await send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'web_search', arguments: args.slice(0, split) } }] }, finish_reason: null }] });
          await send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(split) } }] }, finish_reason: null }] });
          await send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
          await send({ choices: [], usage: { prompt_tokens: 24, completion_tokens: 12, total_tokens: 36 } });
          await writeFragmented(res, 'data: [DONE]\r\n\r\n');
        }
        res.end();
        return;
      }
      if (model === 'demo-reasoning') {
        const summary = `I checked the request settings. Reasoning effort: ${effort}.\n`;
        await send(protocol === 'responses'
          ? { type: 'response.reasoning_summary_text.delta', delta: summary, item_id: 'reasoning_mock', output_index: 0, summary_index: 0 }
          : { choices: [{ index: 0, delta: { reasoning_content: summary }, finish_reason: null }] });
      }
      const replyChunks = loop && outputs.length ? [loopAnswer(outputs, modelSearchQuery(body, protocol))] : model === 'demo-web-search' && result !== null ? [searchAnswer(result)] : TEXT_CHUNKS;
      for (const text of replyChunks) {
        if (res.destroyed) return;
        await delay(pause, res);
        await send(protocol === 'responses'
          ? { type: 'response.output_text.delta', delta: text, item_id: 'message_mock', output_index: 0, content_index: 0 }
          : { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
      }
      if (res.destroyed) return;
      if (protocol === 'responses') {
        await send({ type: 'response.completed', response: { id: 'resp_local_mock', status: 'completed', model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: replyChunks.join('') }] }], usage: { input_tokens: 24, output_tokens: 86, total_tokens: 110 } } });
      } else {
        await send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        await send({ choices: [], usage: { prompt_tokens: 24, completion_tokens: 86, total_tokens: 110 } });
        await writeFragmented(res, 'data: [DONE]\r\n\r\n');
      }
      res.end();
    } catch {
      if (res.destroyed) return;
      if (res.headersSent) res.end();
      else json(res, 400, { error: { message: 'Invalid mock-provider test request.' } });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.MOCK_PORT || 3211);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MOCK_PORT must be an integer between 1 and 65535.');
  const server = createMockProvider();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Mock port ${port} is already in use.` : 'Could not start the local mock provider.');
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`Mock API provider: http://127.0.0.1:${port}/v1`));
}
