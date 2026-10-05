// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { consumeEvents, conversationMessages, readSavedState, stateForStorage, sanitizeAttachments, sanitizeSources, sanitizeSearch, sanitizeSearches, sanitizeComposer, sanitizeImages, metricSnapshot } from '../../public/client.js';
import { summarizeReplyMetrics, formatMetricTokens, formatMetricDuration, formatMetricRate } from '../../public/metrics.js';
import { readAttachment, checkAttachmentBudget } from '../../public/attachments.js';

const source = (await readFile(new URL('../../public/app.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
export const html = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8');

function decodeText(value) {
  return value.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[entity]));
}

export function harness(fetch, { deniedStorage = false, initialState, defaultConnection = true, compact = false, workspaceStorage = null } = {}) {
  const elements = new Map();
  const documentListeners = {};
  const windowListeners = {};
  let focused = null;
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toLowerCase();
      this.children = [];
      this.dataset = {};
      this.style = {};
      this._value = '';
      this.className = '';
      this.hidden = false;
      this.scrollHeight = 100;
      this.scrollTop = 0;
      this.clientHeight = 100;
      this.listeners = {};
      this.attributes = {};
      this.classList = {
        contains: name => this.className.split(' ').includes(name),
        toggle: (name, force) => {
          const classes = new Set(this.className.split(' ').filter(Boolean));
          const next = force ?? !classes.has(name);
          if (next) classes.add(name); else classes.delete(name);
          this.className = [...classes].join(' ');
          return next;
        },
      };
    }
    get options() { return this.children.filter(child => child.tagName === 'option'); }
    get value() {
      if (this.tagName !== 'select') return this._value;
      return this.options.some(option => option.value === this._value) ? this._value : '';
    }
    set value(value) {
      const text = String(value);
      this._value = this.tagName === 'select' && !this.options.some(option => option.value === text) ? '' : text;
    }
    get selectedIndex() { return this.options.findIndex(option => option.value === this.value); }
    set selectedIndex(index) { this._value = this.options[index]?.value || ''; }
    set id(value) { this._id = value; elements.set(value, this); }
    get id() { return this._id; }
    set innerHTML(value) { this._html = value; this.children = []; }
    get innerHTML() { return this._html || ''; }
    append(...children) {
      const hadOptions = this.options.length > 0;
      this.children.push(...children);
      if (this.tagName === 'select' && !hadOptions && this.options.length) this._value = this.options[0].value;
      for (const child of children) if (child.selected && this.tagName === 'select') this._value = child.value;
    }
    add(option) { this.append(option); }
    replaceChildren(...children) { this.children = []; this._value = this.tagName === 'select' ? '' : this._value; this.append(...children); }
    querySelectorAll(tag) {
      return this.children.flatMap(child => [ ...(child.tagName === tag ? [child] : []), ...child.querySelectorAll(tag) ]);
    }
    querySelector(tag) { return this.querySelectorAll(tag)[0] || null; }
    setAttribute(name, value) { this.attributes[name] = String(value); this[name] = value; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    focus() { focused = this.id; }
    click() { return this.listeners.click?.({ target: this }); }
    showModal() { this.open = true; }
    close() { this.open = false; }
  }
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const [, tag, attributes, id] = match;
    const element = new Element(tag); element.id = id;
    const value = attributes.match(/\bvalue="([^"]*)"/);
    if (value) element.value = decodeText(value[1]);
    if (/\bhidden\b/.test(attributes)) element.hidden = true;
    const type = attributes.match(/\btype="([^"]*)"/); if (type) element.type = type[1];
    if (tag === 'select') {
      const closing = html.indexOf('</select>', match.index);
      const contents = html.slice(match.index + match[0].length, closing);
      for (const [, optionAttrs, label] of contents.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)) {
        const option = new Element('option');
        option.value = decodeText(optionAttrs.match(/\bvalue="([^"]*)"/)?.[1] || label);
        option.textContent = decodeText(label);
        option.disabled = /\bdisabled\b/.test(optionAttrs);
        option.selected = /\bselected\b/.test(optionAttrs);
        element.append(option);
      }
    }
  }
  const storage = new Map(initialState ? [['relay.workspace.v1', JSON.stringify(initialState)]] : []);
  const globals = {
    document: { getElementById: id => elements.get(id) || null, get activeElement() { return elements.get(focused) || null; }, createElement: tag => new Element(tag), querySelectorAll: () => [], documentElement: new Element('html'), addEventListener: (event, callback) => { documentListeners[event] = callback; } },
    window: { addEventListener: (event, callback) => { windowListeners[event] = callback; }, matchMedia: () => ({ matches: compact, addEventListener() {} }) },
    navigator: { clipboard: { writeText: async () => {} } },
    marked: { parse: value => value }, DOMPurify: { sanitize: value => value },
    consumeEvents, conversationMessages, readSavedState, stateForStorage, sanitizeAttachments, sanitizeSources, sanitizeSearch, sanitizeSearches, sanitizeComposer, sanitizeImages, metricSnapshot,
    summarizeReplyMetrics, formatMetricTokens, formatMetricDuration, formatMetricRate,
    readAttachment, checkAttachmentBudget,
    hasWorkspaceStorage: () => Boolean(workspaceStorage),
    loadWorkspace: () => workspaceStorage?.load?.() || Promise.resolve(null),
    saveWorkspace: state => workspaceStorage?.save?.(state) || Promise.resolve(true),
    crypto: { randomUUID }, AbortController, TextDecoder, TextEncoder, URL, Blob, File, performance,
    requestAnimationFrame: callback => { callback(); return 1; }, setTimeout: () => 1, clearTimeout() {}, fetch,
  };
  if (deniedStorage) {
    const denied = { get() { throw new Error('SecurityError: storage access denied'); } };
    Object.defineProperty(globals, 'localStorage', denied); Object.defineProperty(globals.window, 'localStorage', denied);
  } else {
    globals.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) };
    globals.window.localStorage = globals.localStorage;
  }
  const context = vm.createContext(globals);
  vm.runInContext(source, context);
  const app = {
    elements, storage, documentListeners, windowListeners,
    inject: (name, value) => { context[name] = value; },
    run: expression => vm.runInContext(expression, context),
    state: expression => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context)),
    get focused() { return focused; },
    chooseModel(id, { custom = false } = {}) {
      const select = elements.get('model-select');
      if (select) {
        const catalogValue = `id:${id}`;
        if (!custom && select.options.some(option => option.value === catalogValue)) select.value = catalogValue;
        else { select.value = 'custom:'; elements.get('model-input').value = id; }
        select.listeners.change?.();
      } else elements.get('model-input').value = id;
      elements.get('model-input').listeners.input?.();
    },
    setConnection(baseUrl = 'https://provider.example/v1', apiKey = 'test-key') {
      elements.get('base-url').value = baseUrl; elements.get('api-key').value = apiKey;
    },
  };
  if (defaultConnection) { app.setConnection(); app.chooseModel('test-model', { custom: true }); }
  return app;
}

export function completed(text) {
  return new Response(`data: ${JSON.stringify({ type: 'delta', text })}\n\ndata: {"type":"done"}\n\n`);
}
