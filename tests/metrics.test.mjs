// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeReplyMetrics, formatMetricTokens, formatMetricDuration, formatMetricRate } from '../public/metrics.js';

function reply({ input = 100, output = 40, total = input + output, elapsed = 2000, first = 1000, ...rest } = {}) {
  return {
    role: 'assistant', status: 'complete', elapsed, firstTokenMs: first,
    usage: { inputTokens: input, outputTokens: output, totalTokens: total },
    usageCoverage: { providerCalls: 1, inputCalls: 1, outputCalls: 1, totalCalls: 1 },
    ...rest,
  };
}
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} differs from ${expected}`);

test('reply throughput uses provider output and milliseconds, with and without the first actual answer delay', () => {
  const message = reply();
  const metrics = summarizeReplyMetrics(message).reply;
  assert.equal(metrics.inputTokens, 100); assert.equal(metrics.outputTokens, 40); assert.equal(metrics.totalTokens, 140);
  assert.equal(metrics.elapsedMs, 2000); assert.equal(metrics.firstTokenMs, 1000);
  assert.equal(metrics.outputTokensPerSecond, 20); assert.equal(metrics.outputTokensPerSecondExcludingDelay, 40);
  assert.equal(metrics.complete.outputTokens, true); assert.equal(metrics.complete.outputTokensPerSecond, true);
  assert.equal(metrics.samples, 1);
});

test('whole conversation sums billed attempts and repeated input, and weights rates by summed duration', () => {
  const first = reply({ input: 100, output: 20, elapsed: 1000, first: 200 });
  const second = reply({ input: 300, output: 40, elapsed: 4000, first: 1000 });
  const user = { role: 'user', content: 'Repeated context is already counted by provider', usage: { outputTokens: 999 }, elapsed: 1, firstTokenMs: 0 };
  const metrics = summarizeReplyMetrics(second, [first, user, second]).conversation;
  assert.equal(metrics.samples, 2); assert.equal(metrics.inputTokens, 400); assert.equal(metrics.outputTokens, 60); assert.equal(metrics.totalTokens, 460);
  assert.equal(metrics.elapsedMs, 5000); assert.equal(metrics.firstTokenMs, 1200);
  assert.equal(metrics.outputTokensPerSecond, 12);
  closeTo(metrics.outputTokensPerSecondExcludingDelay, 60 / 3.8);
  assert.notEqual(metrics.outputTokensPerSecond, (20 + 10) / 2);
  assert.equal(metrics.complete.totalTokens, true);
});

test('retired attempt records retain known billed totals while current message lists omit content and user records', () => {
  const retired = { status: 'complete', elapsed: 1000, firstTokenMs: 500, usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 }, usageCoverage: { providerCalls: 1, inputCalls: 1, outputCalls: 1, totalCalls: 1 } };
  const current = reply({ input: 70, output: 20, elapsed: 2000, first: 1000 });
  const metrics = summarizeReplyMetrics(current, [retired, { role: 'system', content: 'Instructions' }, current]).conversation;
  assert.equal(metrics.samples, 2); assert.equal(metrics.inputTokens, 120); assert.equal(metrics.outputTokens, 30); assert.equal(metrics.totalTokens, 150);
  assert.equal(metrics.outputTokensPerSecond, 10); assert.equal(metrics.outputTokensPerSecondExcludingDelay, 20);
});

test('partial round coverage uses usageKnown honestly and never turns a subtotal into exact reply or conversation throughput', () => {
  const partial = reply({ usage: null, usageKnown: { inputTokens: 50, outputTokens: 10, totalTokens: 60 }, usageCoverage: { providerCalls: 2, inputCalls: 1, outputCalls: 1, totalCalls: 1 } });
  const complete = reply();
  const { reply: current, conversation } = summarizeReplyMetrics(partial, [complete, partial]);
  assert.equal(current.inputTokens, 50); assert.equal(current.outputTokens, 10); assert.equal(current.totalTokens, 60);
  assert.equal(current.complete.totalTokens, false); assert.equal(current.outputTokensPerSecond, null); assert.equal(current.outputTokensPerSecondExcludingDelay, null);
  assert.equal(conversation.inputTokens, 150); assert.equal(conversation.outputTokens, 50); assert.equal(conversation.totalTokens, 200);
  assert.equal(conversation.complete.inputTokens, false); assert.equal(conversation.knownSamples.inputTokens, 2);
  assert.equal(conversation.outputTokensPerSecond, null); assert.equal(conversation.outputTokensPerSecondExcludingDelay, null);
  assert.equal(formatMetricTokens(conversation.totalTokens, conversation.complete.totalTokens), '200 (partial)');
});

test('token completeness is independent for input, output and total coverage, and total is not inferred by the helper', () => {
  const message = reply({ usage: { outputTokens: 10 }, usageKnown: { inputTokens: 80, outputTokens: 9 }, usageCoverage: { providerCalls: 2, inputCalls: 1, outputCalls: 2, totalCalls: 0 } });
  const metrics = summarizeReplyMetrics(message).reply;
  assert.equal(metrics.inputTokens, 80); assert.equal(metrics.complete.inputTokens, false);
  assert.equal(metrics.outputTokens, 10); assert.equal(metrics.complete.outputTokens, true);
  assert.equal(metrics.totalTokens, null); assert.equal(metrics.complete.totalTokens, false);
  assert.equal(metrics.outputTokensPerSecond, 5);
  assert.equal(formatMetricTokens(metrics.totalTokens), 'N/A');
});

test('legacy counts remain visible but incomplete without call coverage, and absent timing is not coerced to zero', () => {
  const message = { role: 'assistant', status: 'complete', usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } };
  const metrics = summarizeReplyMetrics(message).reply;
  assert.equal(metrics.totalTokens, 25); assert.equal(metrics.complete.totalTokens, false);
  assert.equal(metrics.elapsedMs, null); assert.equal(metrics.firstTokenMs, null);
  assert.equal(metrics.outputTokensPerSecond, null); assert.equal(metrics.outputTokensPerSecondExcludingDelay, null);
  assert.equal(formatMetricTokens(metrics.totalTokens, metrics.complete.totalTokens), '25 (partial)');
  assert.equal(formatMetricDuration(metrics.firstTokenMs), 'N/A');
});

test('one missing sample prevents a full-conversation rate rather than displaying the rate of the known subset', () => {
  const known = reply();
  const unknown = { role: 'assistant', status: 'complete', content: 'Older reply without metrics' };
  const metrics = summarizeReplyMetrics(known, [known, unknown]).conversation;
  assert.equal(metrics.samples, 2); assert.equal(metrics.outputTokens, 40); assert.equal(metrics.knownSamples.outputTokens, 1);
  assert.equal(metrics.complete.outputTokens, false); assert.equal(metrics.complete.elapsedMs, false);
  assert.equal(metrics.outputTokensPerSecond, null); assert.equal(metrics.outputTokensPerSecondExcludingDelay, null);
});

test('missing first-answer latency only disables delay-excluding throughput when all other data are exact', () => {
  const message = reply({ firstTokenMs: undefined });
  const { reply: current, conversation } = summarizeReplyMetrics(message);
  assert.equal(current.firstTokenMs, null); assert.equal(current.outputTokensPerSecond, 20); assert.equal(current.outputTokensPerSecondExcludingDelay, null);
  assert.equal(conversation.outputTokensPerSecond, 20); assert.equal(conversation.outputTokensPerSecondExcludingDelay, null);
});

test('zero provider counts and actual zero first-answer delay are real values, not missing data', () => {
  const metrics = summarizeReplyMetrics(reply({ input: 0, output: 0, total: 0, elapsed: 1000, first: 0 })).reply;
  assert.equal(metrics.inputTokens, 0); assert.equal(metrics.outputTokens, 0); assert.equal(metrics.totalTokens, 0); assert.equal(metrics.firstTokenMs, 0);
  assert.equal(metrics.outputTokensPerSecond, 0); assert.equal(metrics.outputTokensPerSecondExcludingDelay, 0);
  assert.equal(metrics.complete.totalTokens, true);
  assert.equal(formatMetricTokens(0), '0'); assert.equal(formatMetricDuration(0), '0 ms'); assert.equal(formatMetricRate(0), '0.00 tok/s');
});

test('invalid, absent and zero response durations or nonpositive post-delay windows never yield Infinity or fake zero rates', () => {
  for (const elapsed of [undefined, null, '1000', 0, -1, NaN, Infinity]) {
    const metrics = summarizeReplyMetrics({ ...reply(), elapsed }).reply;
    assert.equal(metrics.elapsedMs, null); assert.equal(metrics.outputTokensPerSecond, null); assert.equal(metrics.outputTokensPerSecondExcludingDelay, null);
  }
  const same = summarizeReplyMetrics(reply({ elapsed: 1000, first: 1000 })).reply;
  assert.equal(same.firstTokenMs, 1000); assert.equal(same.outputTokensPerSecond, 40); assert.equal(same.outputTokensPerSecondExcludingDelay, null);
  const reversed = summarizeReplyMetrics(reply({ elapsed: 1000, first: 1001 })).reply;
  assert.equal(reversed.firstTokenMs, null); assert.equal(reversed.outputTokensPerSecondExcludingDelay, null);
});

test('failed and interrupted attempts contribute actual token/time totals but never complete-response throughput', () => {
  for (const status of ['error', 'interrupted']) {
    const stopped = reply({ status });
    const metrics = summarizeReplyMetrics(stopped, [reply(), stopped]);
    assert.equal(metrics.reply.totalTokens, 140); assert.equal(metrics.reply.complete.totalTokens, true);
    assert.equal(metrics.reply.elapsedMs, 2000); assert.equal(metrics.reply.complete.elapsedMs, true);
    assert.equal(metrics.reply.firstTokenMs, 1000); assert.equal(metrics.reply.outputTokensPerSecond, null); assert.equal(metrics.reply.outputTokensPerSecondExcludingDelay, null);
    assert.equal(metrics.conversation.totalTokens, 280); assert.equal(metrics.conversation.elapsedMs, 4000);
    assert.equal(metrics.conversation.outputTokensPerSecond, null); assert.equal(metrics.conversation.outputTokensPerSecondExcludingDelay, null);
  }
});

test('live reply values stay partial and do not imply a completed response speed', () => {
  const metrics = summarizeReplyMetrics(reply({ status: 'streaming' })).reply;
  assert.equal(metrics.totalTokens, 140); assert.equal(metrics.complete.totalTokens, false);
  assert.equal(metrics.elapsedMs, 2000); assert.equal(metrics.complete.elapsedMs, false);
  assert.equal(metrics.firstTokenMs, 1000); assert.equal(metrics.complete.firstTokenMs, true);
  assert.equal(metrics.outputTokensPerSecond, null); assert.equal(metrics.outputTokensPerSecondExcludingDelay, null);
});

test('image tokens remain useful but image replies and mixed conversations do not pretend to have text throughput or TTFT', () => {
  for (const marker of [{ task: 'image' }, { stage: 'image' }, { isImage: true }, { images: [{ dataUrl: 'data:image/png;base64,AAAA' }] }]) {
    const image = reply(marker);
    const metrics = summarizeReplyMetrics(image, [reply(), image]);
    assert.equal(metrics.reply.totalTokens, 140); assert.equal(metrics.reply.firstTokenMs, null); assert.equal(metrics.reply.isImage, true);
    assert.equal(metrics.reply.outputTokensPerSecond, null); assert.equal(metrics.reply.outputTokensPerSecondExcludingDelay, null);
    assert.equal(metrics.conversation.totalTokens, 280); assert.equal(metrics.conversation.isImage, true);
    assert.equal(metrics.conversation.outputTokensPerSecond, null); assert.equal(metrics.conversation.outputTokensPerSecondExcludingDelay, null);
  }
});

test('malformed counters are unavailable while independent exact fields survive', () => {
  const message = reply({ usage: { inputTokens: '100', outputTokens: 40, totalTokens: NaN } });
  const metrics = summarizeReplyMetrics(message).reply;
  assert.equal(metrics.inputTokens, null); assert.equal(metrics.outputTokens, 40); assert.equal(metrics.totalTokens, null);
  assert.equal(metrics.complete.inputTokens, false); assert.equal(metrics.complete.outputTokens, true);
  assert.equal(metrics.outputTokensPerSecond, 20);
  for (const coverage of [{ providerCalls: 0, outputCalls: 0 }, { providerCalls: 2, outputCalls: 3 }, { providerCalls: 1, outputCalls: '1' }]) {
    assert.equal(summarizeReplyMetrics(reply({ usageCoverage: coverage })).reply.complete.outputTokens, false);
  }
});

test('unrepresentable aggregate token sums and rate overflow stay unavailable', () => {
  const huge = reply({ input: Number.MAX_SAFE_INTEGER, output: Number.MAX_SAFE_INTEGER, total: Number.MAX_SAFE_INTEGER });
  const aggregate = summarizeReplyMetrics(huge, [huge, huge]).conversation;
  assert.equal(aggregate.inputTokens, null); assert.equal(aggregate.outputTokens, null); assert.equal(aggregate.totalTokens, null); assert.equal(aggregate.outputTokensPerSecond, null);
  const tinyDuration = summarizeReplyMetrics(reply({ elapsed: Number.MIN_VALUE, first: 0 })).reply;
  assert.equal(tinyDuration.outputTokensPerSecond, null); assert.equal(tinyDuration.outputTokensPerSecondExcludingDelay, null);
});

test('formatters use explicit units and N/A, with partial flags and no numeric string/null coercion', () => {
  assert.equal(formatMetricTokens(1234), '1,234'); assert.equal(formatMetricTokens(1234, false), '1,234 (partial)');
  assert.equal(formatMetricDuration(250), '250 ms'); assert.equal(formatMetricDuration(1250), '1.25 s'); assert.equal(formatMetricDuration(250, false), '250 ms (partial)');
  assert.equal(formatMetricRate(12.345), '12.35 tok/s'); assert.equal(formatMetricRate(12, false), '12.00 tok/s (partial)');
  for (const value of [undefined, null, '0', -1, NaN, Infinity]) {
    assert.equal(formatMetricTokens(value), 'N/A'); assert.equal(formatMetricDuration(value), 'N/A'); assert.equal(formatMetricRate(value), 'N/A');
  }
});

test('the helper is pure and never returns message text, image bytes, credentials or arbitrary metadata', () => {
  const message = reply({ content: 'Private prompt and response', apiKey: 'private-key', images: undefined });
  Object.freeze(message.usage); Object.freeze(message.usageCoverage); Object.freeze(message);
  const before = JSON.stringify(message);
  const metrics = summarizeReplyMetrics(message, [null, {}, { role: 'user', usage: { totalTokens: 999 } }, message]);
  assert.equal(JSON.stringify(message), before); assert.equal(metrics.conversation.samples, 1);
  assert.equal(JSON.stringify(metrics).includes('private-key'), false); assert.equal(JSON.stringify(metrics).includes('Private prompt'), false);
  const empty = summarizeReplyMetrics(null, []);
  assert.equal(empty.reply.samples, 0); assert.equal(empty.conversation.samples, 0); assert.equal(empty.conversation.outputTokens, null);
});
