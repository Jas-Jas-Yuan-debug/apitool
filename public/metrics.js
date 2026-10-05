// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens'];
const TIME_FIELDS = ['elapsedMs', 'firstTokenMs'];
const RATE_FIELDS = ['outputTokensPerSecond', 'outputTokensPerSecondExcludingDelay'];
const METRIC_FIELDS = [...TOKEN_FIELDS, ...TIME_FIELDS, ...RATE_FIELDS];
const COVERAGE_FIELDS = { inputTokens: 'inputCalls', outputTokens: 'outputCalls', totalTokens: 'totalCalls' };

function record(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function tokenCount(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function milliseconds(value, allowZero = false) { return typeof value === 'number' && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0) ? value : null; }
function terminal(message) { return !['streaming', 'pending'].includes(message.status); }
function imageReply(message) { return message.isImage === true || message.task === 'image' || message.stage === 'image' || (Array.isArray(message.images) && message.images.length > 0); }
function sample(value) {
  return record(value) && (value.role === 'assistant' || (value.role === undefined && ['usage', 'usageKnown', 'usageCoverage', 'elapsed', 'firstTokenMs'].some(key => key in value)));
}
function perSecond(tokens, duration) {
  if (tokens === null || duration === null || duration <= 0) return null;
  const rate = tokens / (duration / 1000);
  return Number.isFinite(rate) && rate >= 0 ? rate : null;
}
function blankMetrics(samples = 0) {
  return {
    ...Object.fromEntries(METRIC_FIELDS.map(key => [key, null])),
    complete: Object.fromEntries(METRIC_FIELDS.map(key => [key, false])),
    knownSamples: Object.fromEntries(METRIC_FIELDS.map(key => [key, 0])),
    samples, isImage: false,
  };
}
function summarizeSample(message) {
  if (!sample(message)) return blankMetrics();
  const result = blankMetrics(1);
  result.isImage = imageReply(message);
  const usage = record(message.usage) ? message.usage : {};
  const known = record(message.usageKnown) ? message.usageKnown : {};
  const coverage = record(message.usageCoverage) ? message.usageCoverage : {};
  const providerCalls = tokenCount(coverage.providerCalls);
  for (const field of TOKEN_FIELDS) {
    const exact = tokenCount(usage[field]);
    const partial = tokenCount(known[field]);
    const calls = tokenCount(coverage[COVERAGE_FIELDS[field]]);
    result[field] = exact ?? partial;
    result.knownSamples[field] = result[field] === null ? 0 : 1;
    // Legacy counts remain useful, but without call coverage they cannot prove a whole multi-call reply.
    result.complete[field] = exact !== null && terminal(message) && usage.complete !== false &&
      ((providerCalls !== null && providerCalls > 0 && calls === providerCalls) || (providerCalls === null && usage.complete === true));
  }
  result.elapsedMs = milliseconds(message.elapsed);
  result.complete.elapsedMs = result.elapsedMs !== null && terminal(message);
  result.knownSamples.elapsedMs = result.elapsedMs === null ? 0 : 1;
  const firstToken = result.isImage ? null : milliseconds(message.firstTokenMs, true);
  result.firstTokenMs = firstToken !== null && (result.elapsedMs === null || firstToken <= result.elapsedMs) ? firstToken : null;
  result.complete.firstTokenMs = result.firstTokenMs !== null;
  result.knownSamples.firstTokenMs = result.firstTokenMs === null ? 0 : 1;
  if (message.status === 'complete' && !result.isImage && result.complete.outputTokens && result.complete.elapsedMs) {
    result.outputTokensPerSecond = perSecond(result.outputTokens, result.elapsedMs);
    if (result.complete.firstTokenMs) result.outputTokensPerSecondExcludingDelay = perSecond(result.outputTokens, result.elapsedMs - result.firstTokenMs);
  }
  for (const field of RATE_FIELDS) {
    result.complete[field] = result[field] !== null;
    result.knownSamples[field] = result[field] === null ? 0 : 1;
  }
  return result;
}
function sumKnown(values, integers = false) {
  const known = values.filter(value => value !== null);
  if (!known.length) return null;
  const total = known.reduce((sum, value) => sum + value, 0);
  return Number.isFinite(total) && (!integers || Number.isSafeInteger(total)) ? total : null;
}
function summarizeConversation(messages) {
  const summaries = (Array.isArray(messages) ? messages : []).filter(sample).map(summarizeSample);
  const result = blankMetrics(summaries.length);
  if (!summaries.length) return result;
  result.isImage = summaries.some(item => item.isImage);
  for (const field of [...TOKEN_FIELDS, ...TIME_FIELDS]) {
    result[field] = sumKnown(summaries.map(item => item[field]), TOKEN_FIELDS.includes(field));
    result.knownSamples[field] = summaries.filter(item => item[field] !== null).length;
    result.complete[field] = result[field] !== null && summaries.every(item => item.complete[field]);
  }
  // A subset rate is not the throughput of the whole conversation. All samples must be comparable.
  if (!result.isImage && result.complete.outputTokens && result.complete.elapsedMs && summaries.every(item => item.complete.outputTokensPerSecond)) {
    result.outputTokensPerSecond = perSecond(result.outputTokens, result.elapsedMs);
    if (result.complete.firstTokenMs && summaries.every(item => item.complete.outputTokensPerSecondExcludingDelay)) {
      result.outputTokensPerSecondExcludingDelay = perSecond(result.outputTokens, result.elapsedMs - result.firstTokenMs);
    }
  }
  for (const field of RATE_FIELDS) {
    result.complete[field] = result[field] !== null;
    result.knownSamples[field] = summaries.filter(item => item[field] !== null).length;
  }
  return result;
}

/**
 * Provider token counts, including repeated replayed input and any reasoning counted as output.
 * Pass the conversation's current assistant replies plus retired attempt records in messages.
 * No records are deduplicated or inferred from visible text. Conversation firstTokenMs is the
 * sum of observed first-answer delays, not a single conversation's initial latency.
 */
export function summarizeReplyMetrics(message, messages = [message]) {
  return { reply: summarizeSample(message), conversation: summarizeConversation(messages) };
}

function formatted(value, text, complete) { return value === null ? 'N/A' : `${text}${complete === true ? '' : ' (partial)'}`; }
export function formatMetricTokens(value, complete = true) {
  const tokens = tokenCount(value);
  return formatted(tokens, tokens === null ? '' : tokens.toLocaleString('en-US'), complete);
}
export function formatMetricDuration(value, complete = true) {
  const duration = milliseconds(value, true);
  const text = duration === null ? '' : duration < 1000 ? `${Math.round(duration)} ms` : `${(duration / 1000).toFixed(2)} s`;
  return formatted(duration, text, complete);
}
export function formatMetricRate(value, complete = true) {
  const rate = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  return formatted(rate, rate === null ? '' : `${rate.toFixed(2)} tok/s`, complete);
}
