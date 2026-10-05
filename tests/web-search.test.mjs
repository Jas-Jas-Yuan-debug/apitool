// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../lib/api.mjs';
import { searchWeb } from '../lib/search.mjs';

function rss(items = '') {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Search results</title>${items}</channel></rss>`;
}

function item(title = 'A source', url = 'https://example.com/article', snippet = 'A short description.') {
  return `<item><title>${title}</title><link>${url}</link><description>${snippet}</description></item>`;
}

function fixedFeed(xml, options) {
  return async () => new Response(xml, { headers: { 'Content-Type': 'text/xml' }, ...options });
}

test('web search sends only an explicit query to the fixed Bing endpoint with no credentials', async () => {
  let seen;
  const result = await searchWeb('  OpenAI docs & examples  ', {
    fetchImpl: async (url, options) => {
      seen = { url: new URL(url), options };
      return new Response(rss(item()));
    },
  });
  assert.equal(result.query, 'OpenAI docs & examples');
  assert.equal(result.engine, 'Bing');
  assert.deepEqual(result.sources, [{ title: 'A source', url: 'https://example.com/article', snippet: 'A short description.' }]);
  assert.equal(seen.url.origin, 'https://www.bing.com');
  assert.equal(seen.url.pathname, '/search');
  assert.deepEqual([...seen.url.searchParams], [['format', 'rss'], ['q', 'OpenAI docs & examples']]);
  assert.equal(seen.options.redirect, 'error');
  assert.equal(seen.options.credentials, 'omit');
  assert.equal(seen.options.method, 'GET');
  assert.equal(seen.options.body, undefined);
  assert.equal(seen.options.headers.Authorization, undefined);
  assert.equal(seen.options.headers.Cookie, undefined);
  assert.ok(seen.options.signal instanceof AbortSignal);
});

test('web search rejects invalid queries before making a network request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('must not call'); };
  for (const value of [undefined, null, 7, {}, '', ' \t ', 'x'.repeat(501), 'hi\u0000there', 'hi\nthere', 'hi\u007fthere']) {
    await assert.rejects(searchWeb(value, { fetchImpl }), error => error instanceof ApiError && error.status === 400);
  }
  assert.equal(calls, 0);
  assert.equal((await searchWeb('x'.repeat(500), { fetchImpl: fixedFeed(rss()) })).query.length, 500);
});

test('web search decodes XML entities and CDATA into bounded plain text', async () => {
  const xml = rss(item('Research &amp; Q&#38;A &#x1F30D;', '<![CDATA[https://example.com/article?a=1&b=2]]>', '<![CDATA[<b>Details</b> &quot;quoted&quot; &nbsp; &#39;here&#39;]]>'));
  const { sources } = await searchWeb('research', { fetchImpl: fixedFeed(xml) });
  assert.deepEqual(sources, [{ title: 'Research & Q&A 🌍', url: 'https://example.com/article?a=1&b=2', snippet: 'Details "quoted" \'here\'' }]);
  const bounded = await searchWeb('research', { fetchImpl: fixedFeed(rss(item('a'.repeat(500), 'https://example.com', 'b'.repeat(900)))) });
  assert.equal(bounded.sources[0].title.length, 240);
  assert.equal(bounded.sources[0].snippet.length, 300);
});

test('web search removes markup and never executes or fetches result contents', async () => {
  let calls = 0;
  const result = await searchWeb('research', { fetchImpl: async () => {
    calls++;
    return new Response(rss(item('&lt;b&gt;Real title&lt;/b&gt;', 'https://example.com', '&lt;script&gt;alert(1)&lt;/script&gt;&lt;b&gt;Useful&lt;/b&gt;')));
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result.sources[0], { title: 'Real title', url: 'https://example.com/', snippet: 'Useful' });
});

test('web search skips malformed and non-HTTP links and deduplicates anchors', async () => {
  const xml = rss([
    item('Unsafe', 'javascript:alert(1)'), item('Bad URL', 'not a URL'), item('File', 'file:///tmp/a'),
    item('Credential URL', 'https://user:password@example.com/private'), item('', 'https://example.com/empty'),
    item('Good', 'https://example.com/article#one'), item('Duplicate', 'https://example.com/article#two'),
    item('Other', 'http://example.org/page'),
  ].join(''));
  const { sources } = await searchWeb('test', { fetchImpl: fixedFeed(xml) });
  assert.deepEqual(sources.map(source => source.title), ['Good', 'Other']);
});

test('web search returns at most six genuine feed results', async () => {
  const xml = rss(Array.from({ length: 20 }, (_, index) => item(`Source ${index}`, `https://example.com/${index}`)).join(''));
  const { sources } = await searchWeb('test', { fetchImpl: fixedFeed(xml) });
  assert.equal(sources.length, 6);
  assert.equal(sources.at(-1).title, 'Source 5');
});

test('a valid empty results feed returns an empty list without fabricated answers', async () => {
  assert.deepEqual(await searchWeb('unusual phrase', { fetchImpl: fixedFeed(rss()) }), { query: 'unusual phrase', sources: [], engine: 'Bing' });
});

test('web search reports malformed feeds, CAPTCHA HTML, entity declarations and unusable links truthfully', async () => {
  for (const xml of ['<html>Complete a CAPTCHA</html>', '<rss><channel><item><title>Missing end</title></channel></rss>', '<rss><channel></channel>', '<rss><channel></rss>', '<!DOCTYPE rss [<!ENTITY secret SYSTEM "file:///tmp/key">]>' + rss(), rss(item('Bad', 'javascript:alert(1)'))]) {
    await assert.rejects(searchWeb('test', { fetchImpl: fixedFeed(xml) }), error => error instanceof ApiError && error.status === 502 && /unavailable/.test(error.message));
  }
});

test('web search rejects oversized declared and streamed responses and cancels the body', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel() { cancelled = true; } });
  await assert.rejects(searchWeb('test', { fetchImpl: async () => new Response(body) }), error => error.status === 502 && /too much data/.test(error.message));
  assert.equal(cancelled, true);
  await assert.rejects(searchWeb('test', { fetchImpl: fixedFeed(rss(), { headers: { 'Content-Length': String(1024 * 1024 + 1) } }) }), error => error.status === 502 && /too much data/.test(error.message));
});

test('web search decodes UTF-8 correctly when an RSS character spans network chunks', async () => {
  const bytes = new TextEncoder().encode(rss(item('你好 🌍', 'https://example.com', '中文摘要')));
  const body = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const { sources } = await searchWeb('你好', { fetchImpl: async () => new Response(body) });
  assert.deepEqual(sources[0], { title: '你好 🌍', url: 'https://example.com/', snippet: '中文摘要' });
});

test('web search gives actionable rate limit and upstream errors without reflecting response contents', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    await assert.rejects(searchWeb('test', { fetchImpl: fixedFeed('upstream-private-debug', { status }) }), error => {
      assert.equal(error.status, status === 429 ? 429 : 502);
      assert.equal(error.message.includes('upstream-private-debug'), false);
      assert.match(error.message, status === 429 ? /limiting/ : /Try again/);
      return true;
    });
  }
});

test('web search reports network and redirect failures without leaking internals', async () => {
  await assert.rejects(searchWeb('test', { fetchImpl: async () => { throw new Error('secret internal socket address'); } }), error => error.status === 502 && /network/.test(error.message) && !/secret/.test(error.message));
});

test('pre-cancelled web search does not make a request and preserves cancellation', async () => {
  const controller = new AbortController();
  const reason = new DOMException('User cancelled', 'AbortError');
  controller.abort(reason);
  let calls = 0;
  await assert.rejects(searchWeb('test', { signal: controller.signal, fetchImpl: async () => { calls++; } }), error => error === reason);
  assert.equal(calls, 0);
});

test('web search cancellation aborts a fetch that never responds', async () => {
  const controller = new AbortController();
  let networkSignal;
  const pending = searchWeb('test', { signal: controller.signal, fetchImpl: async (url, options) => { networkSignal = options.signal; return new Promise(() => {}); } });
  controller.abort(new DOMException('User cancelled', 'AbortError'));
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(networkSignal.aborted, true);
});

test('web search cancellation stops a stalled response body and cancels its reader', async () => {
  const controller = new AbortController();
  let cancelled = false;
  let started;
  const reading = new Promise(resolve => { started = resolve; });
  const body = new ReadableStream({ pull() { started(); return new Promise(() => {}); }, cancel() { cancelled = true; } });
  const pending = searchWeb('test', { signal: controller.signal, fetchImpl: async () => new Response(body) });
  await reading;
  controller.abort(new DOMException('User cancelled', 'AbortError'));
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(cancelled, true);
});

test('web search times out stalled fetches with a useful 504 error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let networkSignal;
  const pending = searchWeb('test', { fetchImpl: async (url, options) => { networkSignal = options.signal; return new Promise(() => {}); } });
  t.mock.timers.tick(15_000);
  await assert.rejects(pending, error => error instanceof ApiError && error.status === 504 && /timed out/.test(error.message));
  assert.equal(networkSignal.aborted, true);
});

test('web search times out stalled body reads as well as request headers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started;
  const reading = new Promise(resolve => { started = resolve; });
  const body = new ReadableStream({ pull() { started(); return new Promise(() => {}); } });
  const pending = searchWeb('test', { fetchImpl: async () => new Response(body) });
  await reading;
  t.mock.timers.tick(15_000);
  await assert.rejects(pending, error => error.status === 504 && /timed out/.test(error.message));
});
