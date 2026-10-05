// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';
import { readAttachment, checkAttachmentBudget, FILE_LIMIT, CONTEXT_FILE_LIMIT } from '../public/attachments.js';
import { validateChat, buildChatPayload } from '../lib/api.mjs';

test('browser text reader normalizes misleading code MIME and keeps multilingual UTF-8 intact', async () => {
  const attachment = await readAttachment(new File(['\ufeffconst value = "你好 🌍";'], 'example.ts', { type: 'video/mp2t' }));
  assert.equal(attachment.type, 'text/plain');
  assert.equal(attachment.text, 'const value = "你好 🌍";');
  for (const protocol of ['chat', 'responses']) {
    const payload = buildChatPayload(validateChat({ baseUrl: 'http://127.0.0.1:8317/v1', model: 'chosen-model', protocol, messages: [{ role: 'user', content: 'Read this', attachments: [attachment] }] }));
    const parts = (payload.messages || payload.input)[0].content;
    assert.equal(parts[1].text, `Attachment: example.ts\n${attachment.text}`);
  }
});

test('image reader preserves original bytes through the browser-to-provider contract', async () => {
  const bytes = Uint8Array.from({ length: 1025 }, (_, index) => index % 256);
  const attachment = await readAttachment(new File([bytes], 'sample.png', { type: '' }));
  assert.equal(attachment.type, 'image/png');
  assert.deepEqual(Buffer.from(attachment.dataUrl.split(',')[1], 'base64'), Buffer.from(bytes));
  const validated = validateChat({ baseUrl: 'http://127.0.0.1:8317/v1', model: 'chosen-model', messages: [{ role: 'user', content: '', attachments: [attachment] }] });
  assert.equal(validated.messages[0].attachments[0].size, bytes.length);
});

test('reader rejects invalid encodings, binary text, unsupported archives and overlarge files without editing them', async () => {
  await assert.rejects(readAttachment(new File([Uint8Array.of(255)], 'invalid.txt')), /UTF-8/);
  await assert.rejects(readAttachment(new File(['a\u0000b'], 'binary.txt')), /binary/);
  await assert.rejects(readAttachment(new File(['archive'], 'archive.zip')), /use images/);
  await assert.rejects(readAttachment({ name: 'large.pdf', size: FILE_LIMIT + 1, arrayBuffer: () => { throw new Error('should not read'); } }), /5 MiB/);
});

test('replayed file budget counts previous user attachments and permits the exact raw limit', () => {
  const old = { role: 'user', attachments: [{ kind: 'file', size: FILE_LIMIT }] };
  const pending = [{ kind: 'image', size: CONTEXT_FILE_LIMIT - FILE_LIMIT }];
  assert.doesNotThrow(() => checkAttachmentBudget([old], pending));
  assert.throws(() => checkAttachmentBudget([old], [...pending, { kind: 'image', size: 1 }]), /conversation already/);
  assert.equal(old.attachments[0].size, FILE_LIMIT);
  assert.equal(pending.length, 1);
});

test('UTF-8 bytes and cumulative text characters are bounded across earlier messages', () => {
  assert.throws(() => checkAttachmentBudget([{ role: 'user', attachments: [{ kind: 'text', size: 1, text: 'x'.repeat(100000) }] }], [{ kind: 'text', size: 1, text: 'y'.repeat(100001) }]), /200,000/);
  assert.throws(() => checkAttachmentBudget([], Array.from({ length: 6 }, () => ({ kind: 'text', size: 0, text: '' }))), /at most 5/);
});
