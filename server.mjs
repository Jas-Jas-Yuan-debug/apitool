// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

import http from 'node:http';
import path from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { ApiError, safeMessage, validateConnection, validateChat, fetchModels, fetchChat } from './lib/api.mjs';
import { agentChatEvents } from './lib/agent-chat.mjs';
import { searchWeb } from './lib/search.mjs';
import { isImageModel, fetchImage, imageEvents } from './lib/images.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Cache-Control', 'no-store');
}

function checkRequestOrigin(req) {
  const host = req.headers.host;
  if (typeof host !== 'string' || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)) throw new ApiError('Only a loopback host can access this tool.', 403);
  let hostUrl;
  try { hostUrl = new URL(`http://${host}`); } catch { throw new ApiError('Invalid Host header.', 403); }
  if (Number(hostUrl.port || 80) !== req.socket.localPort) throw new ApiError('The Host header does not match this server.', 403);
  const origin = req.headers.origin;
  if (origin && origin !== hostUrl.origin) throw new ApiError('Cross-origin requests are not allowed.', 403);
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new ApiError('Cross-site requests are not allowed.', 403);
}

function json(res, status, body) {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJson(req, maxBytes) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new ApiError('Send requests as application/json.', 415);
  if (Number(req.headers['content-length']) > maxBytes) { req.resume(); throw new ApiError('Request body is too large.', 413); }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    function cleanup() { req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted); }
    function error(cause) { cleanup(); reject(cause); }
    function aborted() { error(new ApiError('The request was cancelled.', 400)); }
    function data(chunk) {
      size += chunk.length;
      if (size > maxBytes) { cleanup(); req.resume(); reject(new ApiError('Request body is too large.', 413)); return; }
      chunks.push(chunk);
    }
    function end() {
      cleanup();
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch { reject(new ApiError('Send a valid JSON object.', 400)); }
    }
    req.on('data', data); req.on('end', end); req.on('error', error); req.on('aborted', aborted);
  });
}

async function sendEvent(res, event, signal) {
  if (res.destroyed || signal.aborted) throw signal.reason || new Error('The request was cancelled.');
  if (!res.write(`data: ${JSON.stringify(event)}\n\n`)) await once(res, 'drain', { signal });
}

async function serveStatic(req, res, pathname, publicDir) {
  if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); throw new ApiError('Method not allowed.', 405); }
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { throw new ApiError('Invalid path.', 400); }
  if (decoded === '/') decoded = '/index.html';
  if (decoded.includes('\\') || decoded.split('/').some(part => part.startsWith('.')) || !mimeTypes[path.extname(decoded).toLowerCase()]) throw new ApiError('File not found.', 404);
  try { publicDir = await realpath(publicDir); } catch { throw new ApiError('File not found.', 404); }
  const target = path.resolve(publicDir, `.${decoded}`);
  if (!target.startsWith(`${publicDir}${path.sep}`)) throw new ApiError('File not found.', 404);
  let contents;
  try {
    const resolved = await realpath(target);
    if (!resolved.startsWith(`${publicDir}${path.sep}`)) throw new ApiError('File not found.', 404);
    contents = await readFile(resolved);
  } catch { throw new ApiError('File not found.', 404); }
  res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(target).toLowerCase()], 'Content-Length': contents.length });
  res.end(req.method === 'HEAD' ? undefined : contents);
}

export function createServer({ publicDir = path.join(root, 'public'), requestTimeoutMs = 10 * 60 * 1000, maxBodyBytes = 16 * 1024 * 1024, search = searchWeb } = {}) {
  publicDir = path.resolve(publicDir);
  return http.createServer(async (req, res) => {
    securityHeaders(res);
    const controller = new AbortController();
    let apiKey = '';
    let timer;
    const cancel = () => { if (!res.writableFinished) controller.abort(new ApiError('The request was cancelled.', 499)); };
    req.on('aborted', cancel);
    res.on('close', cancel);
    try {
      checkRequestOrigin(req);
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/api/health') {
        if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); throw new ApiError('Method not allowed.', 405); }
        json(res, 200, { ok: true });
      } else if (pathname === '/api/search') {
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw new ApiError('Method not allowed.', 405); }
        const body = await readJson(req, 4096);
        json(res, 200, await search(body.query, { signal: controller.signal }));
      } else if (pathname === '/api/models' || pathname === '/api/chat') {
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw new ApiError('Method not allowed.', 405); }
        const body = await readJson(req, maxBodyBytes);
        apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
        timer = setTimeout(() => controller.abort(new ApiError('The provider request timed out.', 504)), requestTimeoutMs);
        timer.unref();
        if (pathname === '/api/models') {
          const models = await fetchModels(validateConnection(body), controller.signal);
          json(res, 200, { models });
        } else {
          const image = isImageModel(body.model);
          const options = validateChat(body, { image });
          const response = image ? await fetchImage(options, { signal: controller.signal }) : await fetchChat(options, controller.signal);
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.flushHeaders();
          req.socket.setNoDelay(true);
          if (!image) await sendEvent(res, { type: 'meta', protocol: options.protocol, model: options.model }, controller.signal);
          const events = image ? imageEvents(response, options, { signal: controller.signal }) : agentChatEvents(options, controller.signal, { search, initialResponse: response });
          for await (const event of events) await sendEvent(res, event, controller.signal);
          res.end();
        }
      } else if (pathname.startsWith('/api/')) throw new ApiError('Endpoint not found.', 404);
      else await serveStatic(req, res, pathname, publicDir);
    } catch (error) {
      if (res.destroyed) return;
      if (controller.signal.aborted && controller.signal.reason instanceof Error) error = controller.signal.reason;
      const message = safeMessage(error.message || 'The request failed.', apiKey);
      if (res.headersSent) { res.end(`data: ${JSON.stringify({ type: 'error', message })}\n\n`); }
      else json(res, error instanceof ApiError ? error.status : 500, { error: message });
    } finally {
      clearTimeout(timer);
      req.off('aborted', cancel);
      res.off('close', cancel);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
  const server = createServer();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Set PORT to use another port.` : 'Could not start the local server.');
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`API tool is running at http://127.0.0.1:${port}`));
}
