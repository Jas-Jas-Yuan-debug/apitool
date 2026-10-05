// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

import { ApiError } from './api.mjs';

const MAX_QUERY_CHARACTERS = 500;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SEARCH_TIMEOUT_MS = 15_000;
const MAX_RESULTS = 6;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const NEWS_QUERY = /\b(?:news|headlines?|breaking)\b|新闻|头条/i;
const RECENT_QUERY = /\b(?:latest|current|today|breaking|newest|recent)\b|最新|今天|今日|当前/i;
const HISTORICAL_QUERY = /\b(?:histor(?:y|ical|ic)|archives?|retrospective|anniversary|past|old|previous)\b|历史|往年|当年|回顾|档案/i;

function searchTarget(query) {
  if (!NEWS_QUERY.test(query)) {
    const url = new URL('https://www.bing.com/search');
    url.searchParams.set('format', 'rss');
    url.searchParams.set('q', query);
    return { url, engine: 'Bing', freshnessMs: null };
  }
  const url = new URL('https://news.google.com/rss/search');
  url.searchParams.set('hl', 'en-US');
  url.searchParams.set('gl', 'US');
  url.searchParams.set('ceid', 'US:en');
  // Preserve the chosen query. A narrowly defined recent-news intent only adds
  // the documented two-day filter; explicit dates/history always take priority.
  const dated = /\b(?:when|after|before)\s*:/i.test(query) || /\b\d{4}\b/.test(query) || HISTORICAL_QUERY.test(query);
  const recent = RECENT_QUERY.test(query) && !dated;
  url.searchParams.set('q', recent ? `${query} when:2d` : query);
  const explicitWindow = query.match(/\bwhen\s*:\s*(\d+)\s*([hdw])\b/i);
  const units = { h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000, w: 7 * 24 * 60 * 60 * 1000 };
  const explicitMs = explicitWindow ? Number(explicitWindow[1]) * units[explicitWindow[2].toLowerCase()] : null;
  return { url, engine: 'Google News', freshnessMs: recent ? TWO_DAYS_MS : Number.isFinite(explicitMs) && explicitMs > 0 ? explicitMs : null };
}

function validateQuery(value) {
  if (typeof value !== 'string') throw new ApiError('Enter a web search query.');
  const query = value.trim();
  if (!query || query.length > MAX_QUERY_CHARACTERS || CONTROL_CHARACTERS.test(query)) {
    throw new ApiError('Enter a web search query of 1 to 500 characters, without control characters.');
  }
  return query;
}

function decodeEntities(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#(?:x[\da-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code) => {
    if (!code.startsWith('#')) return entities[code.toLowerCase()] || entity;
    const number = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    if (!Number.isFinite(number) || number <= 0 || number > 0x10ffff || (number >= 0xd800 && number <= 0xdfff)) return '\ufffd';
    return String.fromCodePoint(number);
  });
}

function plainText(value, maxLength) {
  return decodeEntities(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'))
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function field(item, name) {
  return item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}\\s*>`, 'i'))?.[1] || '';
}

function feedItems(xml, engine = 'Bing') {
  // This parser only reads bounded RSS fields. It never resolves XML entities,
  // executes markup, follows source links, or processes a DTD.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !/<rss\b/i.test(xml) || !/<channel\b/i.test(xml) || !/<\/channel\s*>/i.test(xml) || !/<\/rss\s*>/i.test(xml)) {
    throw new ApiError(`Web search is unavailable: ${engine} did not return a readable results feed. Try again later.`, 502);
  }
  const items = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi)];
  if (/<item\b/i.test(xml) && !items.length) {
    throw new ApiError(`Web search is unavailable: ${engine} returned an incomplete results feed. Try again later.`, 502);
  }
  return items;
}

function parseResults(xml) {
  const items = feedItems(xml);
  const sources = [];
  const seen = new Set();
  for (const [, item] of items) {
    const title = plainText(field(item, 'title'), 240);
    const link = decodeEntities(field(item, 'link').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
    if (!title || !link || link.length > 2048 || CONTROL_CHARACTERS.test(link)) continue;
    let url;
    try { url = new URL(link); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
    const canonical = new URL(url);
    canonical.hash = '';
    if (seen.has(canonical.href)) continue;
    seen.add(canonical.href);
    sources.push({ title, url: url.href, snippet: plainText(field(item, 'description'), 300) });
    if (sources.length === MAX_RESULTS) break;
  }
  if (items.length && !sources.length) {
    throw new ApiError('Web search is unavailable: Bing returned no usable source links. Try a different query or try again later.', 502);
  }
  return sources;
}

function publishedTime(item) {
  const value = plainText(field(item, 'pubDate'), 100);
  // Avoid Date.parse's permissive interpretation of arbitrary numeric text.
  if (!/^(?:[a-z]{3},\s*)?\d{1,2}\s+[a-z]{3}\s+\d{4}\b/i.test(value) && !/^\d{4}-\d{2}-\d{2}(?:T|\s|$)/i.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function parseNewsResults(xml, { freshnessMs, now }) {
  const items = feedItems(xml, 'Google News');
  const candidates = [];
  let usableLinks = 0;
  for (const [, item] of items) {
    const title = plainText(field(item, 'title'), 240);
    const link = decodeEntities(field(item, 'link').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
    if (!title || !link || link.length > 2048 || CONTROL_CHARACTERS.test(link)) continue;
    let url;
    try { url = new URL(link); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048) continue;
    usableLinks++;
    const time = publishedTime(item);
    // RSS search filters sometimes return old stories. Enforce the chosen
    // recent window ourselves, without treating unknown dates as current news.
    if (time !== null && time > now) continue;
    if (freshnessMs !== null && (time === null || time < now - freshnessMs)) continue;
    const publisher = plainText(field(item, 'source'), 80) || 'not provided';
    const date = time === null ? 'date unavailable' : new Date(time).toISOString();
    const description = plainText(field(item, 'description'), 300);
    const excerpt = description && description !== title ? `${title}. ${description}` : title;
    const snippet = `[Published ${date}; Publisher ${publisher}] ${excerpt}`.slice(0, 300);
    const canonical = new URL(url);
    canonical.hash = '';
    candidates.push({ title, url: url.href, snippet, time, canonical: canonical.href });
  }
  if (items.length && !usableLinks) throw new ApiError('Web search is unavailable: Google News returned no usable source links. Try a different query or try again later.', 502);
  candidates.sort((left, right) => (right.time ?? -Infinity) - (left.time ?? -Infinity));
  const seen = new Set();
  const sources = [];
  for (const { title, url, snippet, canonical } of candidates) {
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    sources.push({ title, url, snippet });
    if (sources.length === MAX_RESULTS) break;
  }
  return sources;
}

function abortReason(signal) {
  return signal.reason || new DOMException('Web search was cancelled.', 'AbortError');
}

async function withAbort(promise, signal) {
  if (signal.aborted) throw abortReason(signal);
  let onAbort;
  const interrupted = new Promise((resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([promise, interrupted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

async function readFeed(response, signal, engine) {
  const label = engine === 'Google News' ? 'Google News search' : 'Web search';
  const declaredLength = response.headers?.get('content-length');
  if (declaredLength && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    try { await response.body?.cancel(); } catch {}
    throw new ApiError(`${label} returned too much data. Try a more specific query.`, 502);
  }
  if (!response.body) throw new ApiError(`${label} returned an empty response. Try again later.`, 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let finished = false;
  try {
    while (true) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) { finished = true; return text + decoder.decode(); }
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new ApiError(`${label} returned too much data. Try a more specific query.`, 502);
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    if (!finished) { try { await reader.cancel(); } catch {} }
    reader.releaseLock();
  }
}

/** Search fixed public RSS endpoints. Result URLs are never fetched. */
export async function searchWeb(value, { signal, fetchImpl = fetch, now = Date.now } = {}) {
  const query = validateQuery(value);
  const { url, engine, freshnessMs } = searchTarget(query);
  if (signal?.aborted) throw abortReason(signal);
  const timeoutController = new AbortController();
  const label = engine === 'Google News' ? 'Google News search' : 'Web search';
  const timeout = setTimeout(() => timeoutController.abort(new ApiError(`${label} timed out. Try again or use a more specific query.`, 504)), SEARCH_TIMEOUT_MS);
  timeout.unref?.();
  const requestSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
  try {
    const response = await withAbort(fetchImpl(url.href, {
      method: 'GET', redirect: 'error', credentials: 'omit', signal: requestSignal,
      headers: { Accept: 'application/rss+xml, application/xml, text/xml', 'User-Agent': 'Relay/1.1 (personal local web search)' },
    }), requestSignal);
    if (!response.ok) {
      try { await response.body?.cancel(); } catch {}
      const message = response.status === 429
        ? `${engine} is limiting web searches. Wait a moment and try again.`
        : `Could not load web search results from ${engine}. Try again later.`;
      throw new ApiError(message, response.status === 429 ? 429 : 502);
    }
    const xml = await readFeed(response, requestSignal, engine);
    const sources = engine === 'Google News' ? parseNewsResults(xml, { freshnessMs, now: Number(now()) }) : parseResults(xml);
    return { query, sources, engine };
  } catch (error) {
    if (requestSignal.aborted) throw abortReason(requestSignal);
    if (error instanceof ApiError) throw error;
    throw new ApiError(`Could not reach ${engine} for web search. Check your network connection and try again.`, 502);
  } finally {
    clearTimeout(timeout);
  }
}
