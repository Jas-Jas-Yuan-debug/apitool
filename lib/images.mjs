// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

import { ApiError, normalizeUsage, parseSSE, safeMessage } from './api.mjs';

export const MAX_GENERATED_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_RESPONSE_BYTES = 48 * 1024 * 1024;
const MAX_IMAGE_EVENT_CHARACTERS = 12 * 1024 * 1024;
const MAX_IMAGE_BASE64_CHARACTERS = Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4;
const IMAGE_FORMATS = new Map([['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']]);

export function isImageModel(model) {
  return typeof model === 'string' && /^(?:gpt-image(?:-|$)|dall-e(?:-|$)|chatgpt-image-latest$)/i.test(model.trim().split('/').at(-1));
}

function supportsImageStreaming(model) {
  return /^(?:gpt-image(?:-|$)|chatgpt-image-latest$)/i.test(model.split('/').at(-1));
}

function imageRequest(options) {
  if (!isImageModel(options.model)) throw new ApiError('Choose an image model to generate an image.');
  const message = options.messages?.at(-1);
  if (!message || message.role !== 'user') throw new ApiError('An image request must end with a user prompt.');
  const attachments = message.attachments ?? [];
  if (attachments.some(file => file.kind === 'file')) throw new ApiError('Image models accept image and text attachments. Use a chat model for PDFs, documents, and spreadsheets.');
  const images = attachments.filter(file => file.kind === 'image');
  const modelName = options.model.split('/').at(-1);
  if (images.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) throw new ApiError('Image editing accepts PNG, JPEG, or WebP images. Convert GIF images before attaching them.');
  if (images.length && /^dall-e-3(?:-|$)/i.test(modelName)) throw new ApiError('This image model does not support editing. Choose a GPT image model for image attachments.');
  const text = attachments.filter(file => file.kind === 'text').map(file => `Attachment: ${file.name}\n${file.text}`);
  const prompt = [message.content, ...text].filter(Boolean).join('\n\n');
  const promptLimit = /^dall-e-2(?:-|$)/i.test(modelName) ? 1000 : /^dall-e-3(?:-|$)/i.test(modelName) ? 4000 : 32000;
  if (!prompt.trim()) throw new ApiError('Describe the image you want to generate or edit.');
  if (prompt.length > promptLimit) throw new ApiError(`The image prompt and attached text must total at most ${promptLimit.toLocaleString('en-US')} characters.`);
  const fields = { model: options.model, prompt, n: 1, ...(supportsImageStreaming(options.model) ? { stream: true, partial_images: 2 } : {}) };
  if (!images.length) return { endpoint: 'images/generations', body: JSON.stringify(fields), json: true };
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.set(name, String(value));
  for (const image of images) {
    const bytes = Buffer.from(image.dataUrl.slice(image.dataUrl.indexOf(',') + 1), 'base64');
    body.append(/^dall-e-2(?:-|$)/i.test(modelName) ? 'image' : 'image[]', new Blob([bytes], { type: image.type }), image.name);
  }
  return { endpoint: 'images/edits', body, json: false };
}

async function interruptible(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) throw signal.reason || new DOMException('The image request was cancelled.', 'AbortError');
  let stop;
  const cancelled = new Promise((resolve, reject) => {
    stop = () => reject(signal.reason || new DOMException('The image request was cancelled.', 'AbortError'));
    signal.addEventListener('abort', stop, { once: true });
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener('abort', stop); }
}

async function readText(response, maxBytes, signal) {
  if (!response.body) throw new ApiError('The image provider returned an empty response.', 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let finished = false;
  try {
    while (true) {
      const next = await interruptible(reader.read(), signal);
      if (next.done) { finished = true; return text + decoder.decode(); }
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new ApiError('The image provider returned an oversized response.', 502);
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    if (!finished) { try { reader.cancel().catch(() => {}); } catch {} }
    reader.releaseLock();
  }
}

function errorText(body, fallback) {
  if (typeof body?.error === 'string') return body.error;
  if (typeof body?.error?.message === 'string') return body.error.message;
  if (typeof body?.message === 'string') return body.message;
  return fallback;
}

export async function fetchImage(options, { signal, fetchImpl = fetch } = {}) {
  if (signal?.aborted) throw signal.reason || new DOMException('The image request was cancelled.', 'AbortError');
  const request = imageRequest(options);
  let response;
  try {
    response = await fetchImpl(`${options.baseUrl}/${request.endpoint}`, {
      method: 'POST', redirect: 'error', signal,
      headers: { Accept: 'text/event-stream, application/json;q=0.9', ...(request.json ? { 'Content-Type': 'application/json' } : {}), ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}) },
      body: request.body,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    throw new ApiError('Could not reach the image provider. Check the base URL and your network connection.', 502);
  }
  if (!response.ok) {
    let message = `The image provider request failed (${response.status}).`;
    try {
      const text = await readText(response, 64 * 1024, signal);
      try { message = errorText(JSON.parse(text), message); }
      catch { if (text.trim() && !/<(?:!doctype|html|head|body)/i.test(text)) message = text; }
    } catch (error) { if (signal?.aborted) throw signal.reason || error; }
    throw new ApiError(safeMessage(message, options.apiKey), response.status >= 400 && response.status <= 599 ? response.status : 502);
  }
  return response;
}

function safeImageURL(value, apiKey) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value) || (apiKey && value.includes(apiKey))) throw new ApiError('The image provider returned an invalid image URL.', 502);
  let url;
  try { url = new URL(value); } catch { throw new ApiError('The image provider returned an invalid image URL.', 502); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (apiKey && decodeURIComponentSafely(url.href).includes(apiKey))) throw new ApiError('The image provider returned an unsafe image URL.', 502);
  return url.href;
}

function decodeURIComponentSafely(value) { try { return decodeURIComponent(value); } catch { return value; } }

function rasterFormat(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  throw new ApiError('The image provider returned data that is not a PNG, JPEG, or WebP image.', 502);
}

function imageOutput(value, format, apiKey, totals) {
  if (!value || typeof value !== 'object') throw new ApiError('The image provider returned an invalid image.', 502);
  const revisedPrompt = typeof value.revised_prompt === 'string' ? safeMessage(value.revised_prompt, apiKey) : '';
  if (value.b64_json !== undefined) {
    const base64 = value.b64_json;
    if (typeof base64 !== 'string' || !base64 || base64.length > MAX_IMAGE_BASE64_CHARACTERS || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new ApiError('The image provider returned invalid or oversized image data.', 502);
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > MAX_GENERATED_IMAGE_BYTES || bytes.toString('base64') !== base64) throw new ApiError('The image provider returned invalid or oversized image data.', 502);
    totals.bytes += bytes.length;
    if (totals.bytes > MAX_IMAGE_OUTPUT_BYTES) throw new ApiError('The image provider returned too much image data.', 502);
    const actualFormat = rasterFormat(bytes);
    const outputFormat = format ?? actualFormat;
    const type = IMAGE_FORMATS.get(outputFormat);
    if (!type) throw new ApiError('The image provider returned an unsupported image format.', 502);
    if (actualFormat !== outputFormat) throw new ApiError('The image provider returned image data that does not match its format.', 502);
    return { dataUrl: `data:${type};base64,${base64}`, ...(revisedPrompt ? { revisedPrompt } : {}) };
  }
  return { url: safeImageURL(value.url, apiKey), ...(revisedPrompt ? { revisedPrompt } : {}) };
}

// Count wire bytes before the shared SSE parser. Native image events are much
// larger than text events, but each event and the entire response remain bounded.
function boundedImageStream(body, signal) {
  if (!body) throw new ApiError('The image provider returned an empty stream.', 502);
  const reader = body.getReader();
  let bytes = 0;
  let released = false;
  const release = () => { if (!released) { released = true; reader.releaseLock(); } };
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await interruptible(reader.read(), signal);
        if (next.done) { release(); controller.close(); return; }
        bytes += next.value.byteLength;
        if (bytes > MAX_IMAGE_RESPONSE_BYTES) throw new ApiError('The image provider returned an oversized stream.', 502);
        controller.enqueue(next.value);
      } catch (error) {
        try { reader.cancel().catch(() => {}); } catch {}
        release(); controller.error(error);
      }
    },
    cancel() { try { reader.cancel().catch(() => {}); } catch {} release(); },
  }, { highWaterMark: 0 });
}

export async function* imageEvents(response, options, { signal } = {}) {
  if (signal?.aborted) throw signal.reason || new DOMException('The image request was cancelled.', 'AbortError');
  yield { type: 'meta', task: 'image', protocol: 'images', model: options.model };
  yield { type: 'stage', stage: 'image', message: 'Generating image…' };
  const totals = { bytes: 0 };
  let usage = null;
  let completed = false;
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const text = await readText(response, MAX_IMAGE_RESPONSE_BYTES, signal);
    let body;
    try { body = JSON.parse(text); } catch { throw new ApiError('The image provider did not return valid image JSON.', 502); }
    usage = normalizeUsage(body?.usage);
    try {
      if (body?.error) throw new ApiError(safeMessage(errorText(body, 'The image provider returned an error.'), options.apiKey), 502);
      if (!Array.isArray(body?.data) || !body.data.length || body.data.length > 4) throw new ApiError('The image provider returned no image or too many images.', 502);
      const images = body.data.map((value, index) => ({ type: 'image', index, ...imageOutput(value, value.output_format ?? body.output_format, options.apiKey, totals) }));
      for (const image of images) yield image;
    } catch (error) {
      if (usage) yield { type: 'usage', usage };
      throw error;
    }
    completed = true;
  } else {
    for await (const record of parseSSE(boundedImageStream(response.body, signal), { signal, maxEventCharacters: MAX_IMAGE_EVENT_CHARACTERS })) {
      if (record.data === '[DONE]') break;
      let body;
      try { body = JSON.parse(record.data); } catch { throw new ApiError('The image provider sent invalid JSON in its image stream.', 502); }
      if (!body || typeof body !== 'object') throw new ApiError('The image provider returned an invalid stream event.', 502);
      const type = body.type || record.event;
      const reportedUsage = normalizeUsage(body.usage);
      try {
        if (body.error || type === 'error' || record.event === 'error') throw new ApiError(safeMessage(errorText(body, 'The image provider returned a stream error.'), options.apiKey), 502);
        if (/^image_(?:generation|edit)\.partial_image$/.test(type)) {
          if (completed || !Number.isSafeInteger(body.partial_image_index) || body.partial_image_index < 0 || body.partial_image_index > 2) throw new ApiError('The image provider returned an invalid partial image event.', 502);
          yield { type: 'partial_image', index: 0, partialIndex: body.partial_image_index, ...imageOutput(body, body.output_format, options.apiKey, totals) };
        } else if (/^image_(?:generation|edit)\.completed$/.test(type)) {
          if (completed) throw new ApiError('The image provider returned multiple final images for one image stream.', 502);
          yield { type: 'image', index: 0, ...imageOutput(body, body.output_format, options.apiKey, totals) };
          usage = reportedUsage;
          completed = true;
          break;
        }
      } catch (error) {
        if (reportedUsage) yield { type: 'usage', usage: reportedUsage };
        throw error;
      }
    }
  }
  if (!completed) throw new ApiError('The image stream ended before a final image arrived. Try again.', 502);
  yield { type: 'done', task: 'image', usage };
}
