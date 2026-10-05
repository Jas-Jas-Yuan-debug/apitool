// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

export const FILE_LIMIT = 5 * 1024 * 1024;
export const CONTEXT_FILE_LIMIT = 10 * 1024 * 1024;
export const TEXT_LIMIT = 200000;
const images = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const documents = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
const textExtensions = new Set('txt md markdown csv tsv iif json jsonl yaml yml xml html htm css js mjs cjs ts tsx jsx py java c h cpp hpp cc cxx cs go rs rb php swift kt kts sh bash zsh sql r tex log ini toml cfg conf ipynb vue svelte'.split(' '));

export async function readAttachment(file) {
  if (!file || !Number.isSafeInteger(file.size) || file.size > FILE_LIMIT) throw new Error('Each file must be at most 5 MiB.');
  if (typeof file.name !== 'string' || !file.name.trim() || file.name.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(file.name)) throw new Error('Use a filename without paths or control characters, at most 255 characters.');
  const extension = file.name.toLowerCase().split('.').at(-1);
  const kind = images[extension] ? 'image' : documents[extension] ? 'file' : textExtensions.has(extension) || file.name.startsWith('.') ? 'text' : null;
  if (!kind) throw new Error(`${file.name}: use images, PDF, text/code, DOCX, XLSX, or PPTX files.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size || bytes.length > FILE_LIMIT) throw new Error('The file could not be read completely. Choose it again.');
  const base = { id: crypto.randomUUID(), name: file.name, size: file.size, kind };
  if (kind === 'text') {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error(`${file.name}: save this text file as UTF-8 before attaching it.`); }
    if (text.includes('\u0000')) throw new Error(`${file.name} contains binary data and cannot be read as text.`);
    if (text.length > TEXT_LIMIT) throw new Error('Attached text must total at most 200,000 characters.');
    return { ...base, type: 'text/plain', text };
  }
  if (!bytes.length) throw new Error(`${file.name} is empty. Choose a complete file.`);
  const type = images[extension] || documents[extension];
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  return { ...base, type, dataUrl: `data:${type};base64,${btoa(chunks.join(''))}` };
}

export function checkAttachmentBudget(messages, pending = []) {
  if (pending.length > 5) throw new Error('Attach at most 5 files to each message.');
  const files = [...messages.filter(message => message.role === 'user').flatMap(message => message.attachments || []), ...pending].filter(file => !file.excluded);
  const bytes = files.reduce((total, file) => total + (file.kind === 'text' ? Math.max(file.size, new TextEncoder().encode(file.text).length) : file.size), 0);
  const characters = files.reduce((total, file) => total + (file.kind === 'text' ? file.text.length : 0), 0);
  if (bytes > CONTEXT_FILE_LIMIT) throw new Error('Files in this conversation already total 10 MiB. This chat is kept; attach smaller files or continue without more files.');
  if (characters > TEXT_LIMIT) throw new Error('Attached text in this conversation must total at most 200,000 characters. Your draft and chat are kept.');
}
