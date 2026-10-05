// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../lib/api.mjs';
import { searchWeb } from '../lib/search.mjs';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const clock = () => NOW;
function rss(items = '') { return `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Google News</title>${items}</channel></rss>`; }
function item({ title = 'A real article - Reuters', url = 'https://news.google.com/rss/articles/article-1', date = 'Sun, 04 Oct 2026 10:00:00 GMT', publisher = 'Reuters', description = 'An article description.', extra = '' } = {}) {
  return `<item><title>${title}</title><link>${url}</link><guid isPermaLink="false">article-1</guid><pubDate>${date}</pubDate><description>${description}</description><source url="https://www.reuters.com">${publisher}</source>${extra}</item>`;
}
function feed(xml) { return async () => new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=UTF-8' } }); }

test('news queries use only the fixed Google News RSS endpoint and preserve the original query', async () => {
  let seen;
  const result = await searchWeb('  world news & headlines  ', { now: clock, apiKey: 'must-not-forward', fetchImpl: async (url, options) => { seen = { url: new URL(url), options }; return new Response(rss(item())); } });
  assert.equal(result.query, 'world news & headlines');
  assert.equal(result.engine, 'Google News');
  assert.equal(seen.url.origin, 'https://news.google.com');
  assert.equal(seen.url.pathname, '/rss/search');
  assert.deepEqual([...seen.url.searchParams], [['hl', 'en-US'], ['gl', 'US'], ['ceid', 'US:en'], ['q', 'world news & headlines']]);
  assert.equal(seen.options.method, 'GET');
  assert.equal(seen.options.redirect, 'error');
  assert.equal(seen.options.credentials, 'omit');
  assert.equal(seen.options.body, undefined);
  assert.equal(seen.options.headers.Authorization, undefined);
  assert.equal(seen.options.headers.Cookie, undefined);
  assert.ok(seen.options.signal instanceof AbortSignal);
  assert.equal(JSON.stringify(seen).includes('must-not-forward'), false);
});

test('English and Chinese news intent route to Google News while generic topics retain Bing', async () => {
  for (const query of ['World NEWS', 'a headline about science', 'Breaking economy', '国际新闻', '今日头条']) {
    let origin;
    const result = await searchWeb(query, { now: clock, fetchImpl: async url => { origin = new URL(url).origin; return new Response(rss(item())); } });
    assert.equal(origin, 'https://news.google.com', query);
    assert.equal(result.engine, 'Google News');
  }
  for (const query of ['Mars facts', 'newspaper printing methods', 'current weather']) {
    let seen;
    const result = await searchWeb(query, { fetchImpl: async url => { seen = new URL(url); return new Response(rss(item())); } });
    assert.equal(result.engine, 'Bing');
    assert.equal(seen.origin, 'https://www.bing.com');
    assert.equal(seen.searchParams.get('q'), query);
  }
});

test('clear recent-news intent appends exactly one two-day filter without rewriting the query', async () => {
  for (const query of ['latest world news', 'current news', 'world news today', 'breaking news', '最新新闻', '今天头条']) {
    let searched;
    const result = await searchWeb(query, { now: clock, fetchImpl: async url => { searched = new URL(url).searchParams.get('q'); return new Response(rss(item())); } });
    assert.equal(searched, `${query} when:2d`);
    assert.equal(result.query, query);
  }
});

test('explicit date operators, years and historical intent take precedence over automatic recency', async () => {
  for (const query of ['latest news when:7d', 'latest news after:2026-09-01', 'today headlines before:2026-10-01', 'breaking news 1989', 'latest historical news', 'latest archive news', '最新历史新闻']) {
    let searched;
    await searchWeb(query, { now: clock, fetchImpl: async url => { searched = new URL(url).searchParams.get('q'); return new Response(rss(item())); } });
    assert.equal(searched, query);
  }
});

test('recent news excludes stale, undated and future stories even when the upstream filter is ignored', async () => {
  const xml = rss([
    item({ title: 'Old July story', url: 'https://example.com/july', date: 'Wed, 01 Jul 2026 10:00:00 GMT' }),
    item({ title: 'Undated story', url: 'https://example.com/undated', date: '' }),
    item({ title: 'Future story', url: 'https://example.com/future', date: 'Mon, 05 Oct 2026 10:00:00 GMT' }),
    item({ title: 'Within the requested window', url: 'https://example.com/fresh', date: 'Sat, 03 Oct 2026 10:00:00 GMT' }),
    item({ title: 'At the inclusive boundary', url: 'https://example.com/boundary', date: 'Fri, 02 Oct 2026 12:00:00 GMT' }),
    item({ title: 'One second too old', url: 'https://example.com/expired', date: 'Fri, 02 Oct 2026 11:59:59 GMT' }),
  ].join(''));
  const { sources } = await searchWeb('latest world news', { now: clock, fetchImpl: feed(xml) });
  assert.deepEqual(sources.map(source => source.title), ['Within the requested window', 'At the inclusive boundary']);
  assert.match(sources[0].snippet, /^\[Published 2026-10-03T10:00:00\.000Z; Publisher Reuters\]/);
});

test('an old-only recent-news feed returns no evidence and never falls back to generic search', async () => {
  const requested = [];
  const result = await searchWeb('latest world news today', { now: clock, fetchImpl: async url => { requested.push(new URL(url)); return new Response(rss(item({ date: 'Wed, 01 Jul 2026 10:00:00 GMT' }))); } });
  assert.deepEqual(result, { query: 'latest world news today', sources: [], engine: 'Google News' });
  assert.equal(requested.length, 1);
  assert.equal(requested[0].origin, 'https://news.google.com');
});

test('generic news retains honestly labelled unknown dates and sorts all dated articles newest first', async () => {
  const xml = rss([
    item({ title: 'Unknown date', url: 'https://example.com/unknown', date: 'not a date', publisher: '' }),
    item({ title: 'Older article', url: 'https://example.com/older', date: 'Wed, 01 Jul 2026 10:00:00 GMT' }),
    item({ title: 'Recent article', url: 'https://example.com/recent', date: '2026-10-04T11:00:00Z' }),
    item({ title: 'Numeric date is invalid', url: 'https://example.com/numeric', date: '2026' }),
  ].join(''));
  const { sources } = await searchWeb('world news', { now: clock, fetchImpl: feed(xml) });
  assert.deepEqual(sources.map(source => source.title), ['Recent article', 'Older article', 'Unknown date', 'Numeric date is invalid']);
  assert.match(sources[2].snippet, /^\[Published date unavailable; Publisher not provided\]/);
});

test('an explicit relative news window is enforced locally without adding another filter', async () => {
  let searched;
  const xml = rss(item({ title: 'Too old for one hour', url: 'https://example.com/older' }) + item({ title: 'Within one hour', url: 'https://example.com/recent', date: 'Sun, 04 Oct 2026 11:30:00 GMT' }));
  const result = await searchWeb('latest news when:1h', { now: clock, fetchImpl: async url => { searched = new URL(url).searchParams.get('q'); return new Response(xml); } });
  assert.equal(searched, 'latest news when:1h');
  assert.deepEqual(result.sources.map(source => source.title), ['Within one hour']);
});

test('news publication date and publisher remain inside the bounded snippet passed to the model', async () => {
  const xml = rss(item({ title: '&lt;b&gt;Original &amp; real headline&lt;/b&gt;', publisher: '&lt;script&gt;private&lt;/script&gt;&lt;b&gt;Reuters &amp; AP&lt;/b&gt;', description: '<![CDATA[<ol><li><a href="https://example.com/related">Useful &amp; description</a></li></ol>]]>', extra: '<pubDate>Wed, 01 Jul 2026 10:00:00 GMT</pubDate><media:content url="https://example.com/image.jpg"/>' }));
  const { sources } = await searchWeb('latest news', { now: clock, fetchImpl: feed(xml) });
  assert.equal(sources[0].title, 'Original & real headline');
  assert.match(sources[0].snippet, /^\[Published 2026-10-04T10:00:00\.000Z; Publisher Reuters & AP\] Original & real headline/);
  assert.match(sources[0].snippet, /Useful & description/);
  assert.doesNotMatch(sources[0].snippet, /\b(?:script|private)\b|<[^>]*>/);
  assert.equal(Object.keys(sources[0]).sort().join(','), 'snippet,title,url');
  const bounded = await searchWeb('news', { now: clock, fetchImpl: feed(rss(item({ title: 'a'.repeat(500), publisher: 'p'.repeat(300), description: 'b'.repeat(900) }))) });
  assert.equal(bounded.sources[0].title.length, 240);
  assert.equal(bounded.sources[0].snippet.length, 300);
  assert.match(bounded.sources[0].snippet, /^\[Published 2026-10-04/);
});

test('news returns at most six safe unique links after sorting, without opening article or source URLs', async () => {
  let calls = 0;
  const xml = rss([
    item({ title: 'Unsafe script', url: 'javascript:alert(1)' }),
    item({ title: 'Unsafe credentials', url: 'https://user:pass@example.com/private' }),
    item({ title: 'Unsafe oversized URL', url: `https://example.com/${'x'.repeat(2050)}` }),
    item({ title: 'Unsafe expanded Unicode URL', url: `https://example.com/${'你'.repeat(250)}` }),
    item({ title: 'Duplicate older', url: 'https://example.com/0#older', date: 'Sat, 03 Oct 2026 10:00:00 GMT' }),
    item({ title: 'Duplicate near the top', url: 'https://example.com/9#older', date: 'Sun, 04 Oct 2026 08:59:00 GMT' }),
    ...Array.from({ length: 10 }, (_, index) => item({ title: `Headline ${index}`, url: `https://example.com/${index}#newer`, date: `Sun, 04 Oct 2026 ${String(index).padStart(2, '0')}:00:00 GMT` })),
  ].join(''));
  const { sources } = await searchWeb('news', { now: clock, fetchImpl: async () => { calls++; return new Response(xml); } });
  assert.equal(calls, 1);
  assert.equal(sources.length, 6);
  assert.deepEqual(sources.map(source => source.title), ['Headline 9', 'Headline 8', 'Headline 7', 'Headline 6', 'Headline 5', 'Headline 4']);
  assert.equal(new Set(sources.map(source => new URL(source.url).pathname)).size, 6);
  assert.ok(sources.every(source => source.url.length <= 2048));
});

test('Google News failures identify the news provider and never leak response or network internals', async () => {
  for (const status of [403, 429, 500]) {
    await assert.rejects(searchWeb('news', { now: clock, fetchImpl: async () => new Response('private-upstream-debug', { status }) }), error => error instanceof ApiError && error.status === (status === 429 ? 429 : 502) && /Google News/.test(error.message) && !/private/.test(error.message));
  }
  await assert.rejects(searchWeb('news', { now: clock, fetchImpl: async () => { throw new Error('private socket address'); } }), error => error.status === 502 && /Google News.*network/.test(error.message) && !/private/.test(error.message));
  for (const xml of ['<html>CAPTCHA</html>', '<rss><channel><item></channel></rss>', '<!DOCTYPE rss [<!ENTITY secret SYSTEM "file:///tmp/key">]>' + rss(), rss(item({ url: 'javascript:alert(1)' }))]) {
    await assert.rejects(searchWeb('news', { now: clock, fetchImpl: feed(xml) }), error => error.status === 502 && /Google News/.test(error.message));
  }
});

test('news cancellation preserves the caller reason and cancels a stalled feed reader', async () => {
  const controller = new AbortController();
  const reason = new DOMException('User cancelled', 'AbortError');
  let cancelled = false;
  let started;
  const reading = new Promise(resolve => { started = resolve; });
  const body = new ReadableStream({ pull() { started(); return new Promise(() => {}); }, cancel() { cancelled = true; } });
  const pending = searchWeb('latest news', { now: clock, signal: controller.signal, fetchImpl: async () => new Response(body) });
  await reading;
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(cancelled, true);
});

test('news request and body limits preserve the same bounded search behavior', async t => {
  let cancelled = false;
  const oversized = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel() { cancelled = true; } });
  await assert.rejects(searchWeb('news', { now: clock, fetchImpl: async () => new Response(oversized) }), error => error.status === 502 && /Google News.*too much data/.test(error.message));
  assert.equal(cancelled, true);
  await assert.rejects(searchWeb('news', { now: clock, fetchImpl: async () => new Response(rss(), { headers: { 'Content-Length': String(1024 * 1024 + 1) } }) }), error => error.status === 502 && /Google News.*too much data/.test(error.message));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let networkSignal;
  const pending = searchWeb('latest news', { now: clock, fetchImpl: async (_url, options) => { networkSignal = options.signal; return new Promise(() => {}); } });
  t.mock.timers.tick(15_000);
  await assert.rejects(pending, error => error.status === 504 && /Google News.*timed out/.test(error.message));
  assert.equal(networkSignal.aborted, true);
});

test('fragmented multilingual news titles and metadata remain readable', async () => {
  const bytes = new TextEncoder().encode(rss(item({ title: '真实新闻 🌍', publisher: '路透社', description: '简短摘要' })));
  const body = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const { sources } = await searchWeb('最新新闻', { now: clock, fetchImpl: async () => new Response(body) });
  assert.equal(sources[0].title, '真实新闻 🌍');
  assert.match(sources[0].snippet, /Publisher 路透社\] 真实新闻 🌍\. 简短摘要/);
});
