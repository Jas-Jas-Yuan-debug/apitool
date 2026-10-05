// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

import { marked } from './vendor/marked.js';
import DOMPurify from './vendor/purify.js';
import { consumeEvents, conversationMessages, readSavedState, stateForStorage, sanitizeSources, sanitizeSearch, sanitizeSearches, sanitizeImages, metricSnapshot } from './client.js';
import { summarizeReplyMetrics, formatMetricTokens, formatMetricDuration, formatMetricRate } from './metrics.js';
import { readAttachment, checkAttachmentBudget } from './attachments.js';
import { hasWorkspaceStorage, loadWorkspace, saveWorkspace } from './workspace-storage.js';

const $ = id => document.getElementById(id);
const iconPaths = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="m3 3 18 18M10.6 5.1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-3 3.6M6 6a18 18 0 0 0-4 6s3.5 7 10 7a11 11 0 0 0 5-1.2M10 10a3 3 0 0 0 4 4"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  plug: '<path d="M8 3v5m8-5v5M6 8h12v4a6 6 0 0 1-12 0V8Zm6 10v3"/>',
  'arrow-right': '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  'arrow-up-right': '<path d="M6 18 18 6M6 6h12v12"/>',
  'arrow-up': '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  'chevron-right': '<path d="m9 5 7 7-7 7"/>',
  chat: '<path d="M21 11a9 9 0 0 1-9 9H4l-3 2 2-6a9 9 0 1 1 18-5Z"/>',
  layers: '<path d="m12 3 10 6-10 6L2 9l10-6Zm-10 12 10 6 10-6M2 12l10 6 10-6"/>',
  sliders: '<path d="M4 6h7m4 0h5M4 12h2m4 0h10M4 18h10m4 0h2"/><circle cx="13" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
  shield: '<path d="M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6l-9-4Z"/><path d="m8 12 3 3 5-6"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  moon: '<path d="M20.8 13A9 9 0 0 1 11 3.2 9 9 0 1 0 20.8 13Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  sparkles: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Zm7-2 1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2Z"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18"/>',
  brain: '<path d="M12 20V4M12 5a4 4 0 0 0-7-1 4 4 0 0 0-2 6 4 4 0 0 0 0 6 4 4 0 0 0 9 4m0-15a4 4 0 0 1 7-1 4 4 0 0 1 2 6 4 4 0 0 1 0 6 4 4 0 0 1-9 4M5 9h3v3m11-3h-3v3M5 17h3m8 0h3"/>',
  pen: '<path d="m16 3 5 5L8 21H3v-5L16 3Zm-3 3 5 5M3 21h18"/>',
  cube: '<path d="m12 2 9 5v10l-9 5-9-5V7l9-5Zm-9 5 9 5 9-5M12 12v10M7.5 4.5l9 5"/>',
  'corner-down-left': '<path d="M20 4v8H4m5-5-5 5 5 5"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  refresh: '<path d="M20 8a8 8 0 1 0 1 7M20 3v5h-5"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3h.01"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  paperclip: '<path d="m8 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7L13 2M6 15l8-8"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${iconPaths[name] || iconPaths.chat}</svg>`;
document.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon); });

const defaults = { baseUrl: 'https://api.openai.com/v1', model: '', modelMode: 'catalog', effort: 'auto', protocol: 'auto', systemPrompt: '', theme: 'light', webSearch: true };
let browserStorage;
try { browserStorage = window.localStorage; } catch {}
const saved = readSavedState(browserStorage);
const config = { ...defaults, ...saved.config };
if (!['auto', 'chat', 'responses'].includes(config.protocol)) config.protocol = 'auto';
if (!Array.from($('effort').options).some(option => option.value === config.effort)) config.effort = 'auto';
let chats = saved.chats;
let currentChat = chats.find(chat => chat.id === saved.activeChatId) || chats[0] || makeChat();
let activeGeneration = null;
let modelRequest = null;
let modelIds = [];
let selectionRevision = 0;
let toastTimer = null;
let storageWarning = false;
let clearConfirmation = false;
let workspaceRevision = 0;
let draftTimer = null;
let durableWarning = false;
const searchRequests = new Map();
const fileReads = new Map();
const compactLayout = window.matchMedia?.('(max-width: 760px)');

function makeChat() { return { id: crypto.randomUUID(), title: 'New conversation', updatedAt: Date.now(), messages: [], composer: { text: '', attachments: [], search: null, searchQuery: '', searchOpen: false } }; }
function composer(chat = currentChat) { return chat.composer ||= { text: '', attachments: [], search: null, searchQuery: '', searchOpen: false }; }
function persist() {
  workspaceRevision++;
  const draft = composer();
  const workspaceChats = chats.some(chat => chat.id === currentChat.id) || !(draft.text || draft.attachments.length || draft.search) ? chats : [currentChat, ...chats].slice(0, 50);
  const state = stateForStorage(config, workspaceChats, currentChat.id);
  const durable = hasWorkspaceStorage();
  if (durable) saveWorkspace(state).catch(() => { if (!durableWarning) { durableWarning = true; showToast('Browser file storage is unavailable. Keep this tab open and download a chat backup before leaving.', true); } });
  try { localStorage.setItem('relay.workspace.v1', JSON.stringify(state)); }
  catch { if (!durable && !storageWarning) { storageWarning = true; showToast('Browser storage is full or unavailable. Your chat is still here; download a chat backup before leaving.', true); } }
}
function rememberDraft() { workspaceRevision++; composer().text = $('message-input').value; clearTimeout(draftTimer); draftTimer = setTimeout(persist, 300); }
function restoreComposer() { $('message-input').value = composer().text; resizeComposer(); renderComposerContext(); }
function keepDraft(chat = currentChat) {
  const draft = composer(chat);
  if ((draft.text || draft.attachments.length || draft.search || fileReads.has(chat.id) || searchRequests.has(chat.id)) && !chats.some(item => item.id === chat.id)) {
    chats.unshift(chat); chats = chats.slice(0, 50);
  }
}
function formattedSize(size) { return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MiB`; }
function sourceList(sources) {
  const list = document.createElement('div'); list.className = 'reference-list';
  for (const source of sanitizeSources(sources)) {
    const row = document.createElement('div'); row.className = 'reference-source';
    const link = document.createElement('a'); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = source.title || new URL(source.url).hostname;
    row.append(link);
    if (source.snippet) { const text = document.createElement('p'); text.textContent = source.snippet; row.append(text); }
    list.append(row);
  }
  return list;
}
function attachmentList(files, removable = false, sent = false) {
  const list = document.createElement('div'); list.className = 'attachment-list';
  for (const file of files) {
    const item = document.createElement('div'); item.className = 'attachment-pill';
    item.classList.toggle('excluded', Boolean(file.excluded));
    if (file.kind === 'image') { const image = document.createElement('img'); image.src = file.dataUrl; image.alt = file.name; item.append(image); }
    else { const mark = document.createElement('span'); mark.innerHTML = icon(file.kind === 'text' ? 'code' : 'paperclip'); item.append(mark); }
    const label = document.createElement('span'); label.className = 'attachment-name'; label.textContent = file.name; label.title = `${file.name} · ${formattedSize(file.size)}`; item.append(label);
    const size = document.createElement('span'); size.className = 'attachment-size'; size.textContent = file.excluded ? 'Kept · excluded' : formattedSize(file.size); item.append(size);
    if (removable) {
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button'; remove.setAttribute('aria-label', `Remove attachment: ${file.name}`); remove.innerHTML = icon('x');
      remove.addEventListener('click', () => { composer().attachments = composer().attachments.filter(attachment => attachment.id !== file.id); workspaceRevision++; renderComposerContext(); persist(); });
      item.append(remove);
    } else if (sent) {
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'icon-button';
      toggle.setAttribute('aria-label', `${file.excluded ? 'Include' : 'Exclude'} attachment ${file.excluded ? 'in' : 'from'} future messages: ${file.name}`);
      toggle.title = file.excluded ? 'Include in future messages' : 'Exclude from future messages; keep this file and chat';
      toggle.innerHTML = icon(file.excluded ? 'refresh' : 'x');
      toggle.addEventListener('click', () => { file.excluded = !file.excluded; persist(); renderChat(); showToast(file.excluded ? 'File kept in this chat and excluded from future messages.' : 'File included in future messages.'); });
      item.append(toggle);
    }
    list.append(item);
  }
  return list;
}
function clearPendingSearch(chat = currentChat) {
  searchRequests.get(chat.id)?.abort(); searchRequests.delete(chat.id);
  composer(chat).search = null; workspaceRevision++;
  if (chat.id === currentChat.id) renderComposerContext();
  persist();
}
function renderComposerContext() {
  const draft = composer(), pending = $('pending-context');
  pending.replaceChildren(); pending.hidden = !draft.attachments.length && !draft.search;
  if (draft.attachments.length) pending.append(attachmentList(draft.attachments, true));
  if (draft.search) {
    const chip = document.createElement('div'); chip.className = 'search-chip';
    const text = document.createElement('span'); text.textContent = `Web results: ${draft.search.query} · ${draft.search.sources.length} sources`;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button'; remove.setAttribute('aria-label', 'Remove web search results'); remove.innerHTML = icon('x'); remove.addEventListener('click', () => clearPendingSearch());
    chip.append(text, remove); pending.append(chip);
  }
  // Saved manual references remain attached to their original draft, but new searches are chosen by the AI.
  $('web-search-panel').hidden = true;
  $('web-search-toggle').setAttribute('aria-pressed', String(config.webSearch));
  $('web-search-toggle').classList.toggle('selected', config.webSearch);
  $('web-search-setting').textContent = config.webSearch ? 'On' : 'Off';
  $('ai-search-note').textContent = config.webSearch ? 'The AI chooses queries and uses web or news results while replying.' : 'AI web search is off for your next message.';
  $('web-search-query').value = draft.searchQuery;
  const searching = searchRequests.has(currentChat.id), reading = fileReads.has(currentChat.id);
  $('run-web-search').disabled = searching; $('run-web-search').textContent = searching ? 'Searching…' : 'Search';
  $('web-search-status').textContent = searching ? 'Searching the web. Your conversation stays here.' : draft.search ? `${draft.search.sources.length} sources ready for your next message · ${draft.search.engine}` : '';
  $('web-search-results').replaceChildren(); if (draft.search) $('web-search-results').append(sourceList(draft.search.sources));
  $('attach-files').disabled = reading; $('file-status').textContent = reading ? 'Reading files…' : draft.attachments.length ? `${draft.attachments.length}/5 files` : '';
  updateSendButton();
}
async function addFiles(files) {
  const chat = currentChat, draft = composer(chat), selected = Array.from(files || []);
  if (!selected.length) return;
  if (fileReads.has(chat.id)) { showToast('Wait for these files to finish reading.', true); return; }
  if (selected.length + draft.attachments.length > 5) { showToast('Attach at most 5 files to each message. Your current files and draft are kept.', true); return; }
  const token = {}; fileReads.set(chat.id, token); workspaceRevision++; keepDraft(chat); renderHistory(); renderComposerContext();
  try {
    const attachments = await Promise.all(selected.map(readAttachment));
    if (fileReads.get(chat.id) !== token) return;
    checkAttachmentBudget(chat.messages, [...draft.attachments, ...attachments]);
    draft.attachments.push(...attachments);
    persist(); if (chat.id === currentChat.id) announce(`${attachments.length} files attached. Your conversation is unchanged.`);
  } catch (error) { if (fileReads.get(chat.id) === token) showToast(error.message || 'These files could not be read. Your chat is kept.', true); }
  finally {
    if (fileReads.get(chat.id) === token) fileReads.delete(chat.id);
    if (chat.id === currentChat.id) { $('file-input').value = ''; renderComposerContext(); }
  }
}
async function runWebSearch() {
  const chat = currentChat, draft = composer(chat), query = $('web-search-query').value.trim();
  if (!query || query.length > 500) { showToast('Enter a web search query of 1–500 characters.', true); $('web-search-query').focus(); return; }
  const controller = new AbortController(); searchRequests.get(chat.id)?.abort(); searchRequests.set(chat.id, controller);
  draft.searchQuery = query; workspaceRevision++; keepDraft(chat); renderHistory(); renderComposerContext();
  let failure = '';
  try {
    const response = await fetch('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }), signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || data.error || `Web search failed (${response.status}).`);
    if (controller.signal.aborted || searchRequests.get(chat.id) !== controller) return;
    const search = sanitizeSearch(data);
    if (!search?.sources.length) throw new Error('No usable web results were returned. Try a more specific query.');
    draft.search = search; persist();
    if (chat.id === currentChat.id) announce(`${search.sources.length} web sources added to this chat’s next message.`);
  } catch (error) {
    if (!controller.signal.aborted && searchRequests.get(chat.id) === controller) { failure = error.message; if (chat.id === currentChat.id) showToast(failure, true); }
  } finally {
    if (searchRequests.get(chat.id) === controller) searchRequests.delete(chat.id);
    if (chat.id === currentChat.id) { renderComposerContext(); if (failure) $('web-search-status').textContent = failure; }
  }
}
function escapeHTML(text) { return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function showToast(message, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 6500 : 3200);
}
function announce(message) { $('live-announcement').textContent = message; }
function setConnection(status, label, message = '') {
  $('connection-state').className = `connection-state ${status}`;
  $('connection-label').textContent = label;
  $('connection-feedback').textContent = message;
  $('connection-feedback').classList.toggle('error', status === 'error');
  $('connection-feedback').hidden = !message;
}
function resetConnection({ clearModel = false } = {}) {
  modelRequest?.abort();
  modelRequest = null;
  $('load-models').disabled = false;
  $('load-models-label').textContent = 'Connect & load models';
  modelIds = [];
  if (clearModel) { config.model = ''; config.modelMode = 'catalog'; $('model-input').value = ''; selectionRevision++; }
  renderModelChoices(config.model, config.modelMode === 'custom');
  $('use-custom-model').hidden = true;
  $('model-help').textContent = clearModel ? 'Connection changed. Load this provider’s models or enter a custom ID.' : 'Load models from your connection, or choose Custom model ID.';
  setConnection('', 'Not tested');
}
function currentModel() {
  const value = $('model-select').value;
  return value === 'custom:' ? $('model-input').value.trim() : value.startsWith('id:') ? value.slice(3) : '';
}
function syncModelInput() {
  $('custom-model-wrap').hidden = $('model-select').value !== 'custom:';
  $('model-select').title = currentModel() || 'Choose a model';
}
function renderModelChoices(preferred = currentModel(), custom = $('model-select').value === 'custom:') {
  const select = $('model-select');
  select.replaceChildren();
  function option(value, label) { const item = document.createElement('option'); item.value = value; item.textContent = label; select.append(item); }
  option('', 'Choose a model');
  for (const id of modelIds) option(`id:${id}`, id);
  if (preferred && !custom && !modelIds.includes(preferred)) option(`id:${preferred}`, `${preferred} (saved — reload list)`);
  option('custom:', 'Custom model ID…');
  select.value = custom ? 'custom:' : preferred ? `id:${preferred}` : '';
  if (custom && preferred) $('model-input').value = preferred;
  syncModelInput();
}
function useCustomModel() {
  const previous = currentModel();
  $('model-select').value = 'custom:';
  if (previous) $('model-input').value = previous;
  selectionRevision++;
  syncModelInput(); updateConfig(); sidebarOpen(false);
  $('model-help').textContent = 'Enter the exact model ID from your provider. Model listing is optional.';
  $('model-input').focus();
}
function updateConfig() {
  config.baseUrl = $('base-url').value.trim();
  config.model = currentModel();
  config.modelMode = $('model-select').value === 'custom:' ? 'custom' : 'catalog';
  config.effort = $('effort').value;
  persist();
}
function applyTheme() {
  document.documentElement.dataset.theme = config.theme === 'dark' ? 'dark' : 'light';
  $('theme-toggle').innerHTML = icon(config.theme === 'dark' ? 'sun' : 'moon');
  $('theme-toggle').setAttribute('aria-label', `Switch to ${config.theme === 'dark' ? 'light' : 'dark'} theme`);
}
function updateProtocolLabel() {
  $('protocol-label').textContent = config.protocol === 'auto' ? 'OpenAI-compatible API' : config.protocol === 'responses' ? 'Responses API' : 'Chat Completions';
}
function sidebarOpen(open) {
  const isCompact = Boolean(compactLayout?.matches);
  const wasOpen = $('sidebar').classList.contains('open');
  $('sidebar').classList.toggle('open', open);
  $('sidebar').inert = isCompact && !open;
  $('main-panel').inert = isCompact && open;
  $('sidebar-backdrop').hidden = !open || !isCompact;
  $('mobile-menu').setAttribute('aria-expanded', String(open));
  if (isCompact && open) $('base-url').focus();
  else if (isCompact && !open && (wasOpen || document.activeElement === $('sidebar-backdrop'))) $('mobile-menu').focus();
}
function renderHistory() {
  $('history-count').textContent = chats.length;
  const list = $('history-list');
  list.replaceChildren();
  if (!chats.length) {
    list.innerHTML = `<div class="history-empty">${icon('chat')}<div>A little space for your ideas.<br>Your conversations will appear here.</div></div>`;
    return;
  }
  for (const chat of [...chats].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const row = document.createElement('div');
    row.className = `history-row${chat.id === currentChat.id ? ' active' : ''}`;
    const item = document.createElement('button');
    item.className = 'history-item';
    item.innerHTML = `${icon('chat')}<span>${escapeHTML(chat.title)}</span>`;
    item.title = chat.title;
    item.setAttribute('aria-current', chat.id === currentChat.id ? 'true' : 'false');
    item.addEventListener('click', () => {
      if (chat.id !== currentChat.id) stopGeneration();
      composer().text = $('message-input').value; keepDraft();
      currentChat = chat;
      restoreComposer(); renderChat(); renderHistory(); persist(); sidebarOpen(false);
    });
    const remove = document.createElement('button');
    remove.className = 'icon-button delete-chat';
    remove.innerHTML = icon('trash');
    remove.setAttribute('aria-label', `Delete conversation: ${chat.title}`);
    remove.addEventListener('click', () => {
      if (activeGeneration?.chat.id === chat.id) stopGeneration();
      searchRequests.get(chat.id)?.abort(); searchRequests.delete(chat.id); fileReads.delete(chat.id);
      chats = chats.filter(c => c.id !== chat.id);
      if (currentChat.id === chat.id) { currentChat = makeChat(); restoreComposer(); renderChat(); }
      persist(); renderHistory();
    });
    row.append(item, remove); list.append(row);
  }
}
function markdown(content) {
  return DOMPurify.sanitize(marked.parse(content, { breaks: true, gfm: true }), { FORBID_TAGS: ['img', 'style', 'input', 'form', 'button'], FORBID_ATTR: ['style'] });
}
function searchActivity(searches) {
  const activity = document.createElement('div'); activity.className = 'search-activity'; activity.setAttribute('aria-label', 'AI web searches');
  for (const search of sanitizeSearches(searches)) {
    const row = document.createElement('div'); row.className = `search-activity-row ${search.status}`;
    const mark = document.createElement('span'); mark.className = 'search-activity-icon'; mark.innerHTML = icon(search.status === 'complete' ? 'check' : search.status === 'error' ? 'alert' : 'globe');
    const text = document.createElement('span');
    const prefix = search.status === 'searching' ? (search.cached ? 'Reusing earlier web search' : 'Searching the web') : search.status === 'complete' ? (search.cached ? 'Reused earlier web search' : 'Searched the web') : search.status === 'error' ? (search.cached ? 'Reused earlier web search error' : 'Web search failed') : 'Web search stopped';
    text.textContent = `${prefix}${search.query ? `: ${search.query}` : ''}${search.status === 'complete' && Number.isInteger(search.resultCount) ? ` · ${search.resultCount} sources` : ''}`;
    row.append(mark, text); activity.append(row);
    if (search.message) { const error = document.createElement('p'); error.className = 'search-activity-error'; error.textContent = search.message; activity.append(error); }
  }
  return activity;
}
function recordSearchEvent(reply, event) {
  const [activity] = sanitizeSearches([event]);
  if (!activity) return;
  reply.searches ||= [];
  const existing = activity.callId ? reply.searches.findIndex(search => search.callId === activity.callId) : reply.searches.findLastIndex(search => search.query === activity.query && search.status === 'searching');
  if (existing !== -1) reply.searches[existing] = { ...reply.searches[existing], ...activity };
  else if (reply.searches.length < 20) reply.searches.push(activity);
  if (event.status === 'searching') announce(`AI ${activity.cached ? 'reusing earlier web search' : 'searching the web'}${activity.query ? `: ${activity.query}` : '.'}`);
  if (event.sources) reply.sources = sanitizeSources([...reply.sources, ...sanitizeSources(event.sources)]);
}
function generationStatus(message) {
  if (message?.status !== 'streaming') return '';
  if (message.task === 'image' || message.stage === 'image') return 'Generating image';
  if (Array.isArray(message.searches) && message.searches.some(search => search?.status === 'searching')) return 'Searching the web';
  if (message.content) return 'Streaming reply';
  if (message.reasoning) return 'Thinking';
  return 'Waiting for model';
}
function renderGenerationStatus(element, message) {
  const label = generationStatus(message);
  if (!label) return;
  const badge = document.createElement('div'); badge.className = 'generation-status'; badge.setAttribute('aria-label', 'Generation status');
  const dot = document.createElement('span'); dot.className = 'generation-status-dot'; dot.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span'); text.textContent = label;
  badge.append(dot, text); element.append(badge);
}
function renderReplyMetrics(message) {
  const samples = [...(currentChat.metricsHistory || []), ...currentChat.messages];
  if (currentChat.metricsHistoryIncomplete) samples.push({ role: 'assistant', status: 'interrupted' });
  const { reply, conversation } = summarizeReplyMetrics(message, samples);
  const table = document.createElement('table'); table.className = 'reply-metrics'; table.setAttribute('aria-label', 'Token usage and response timings');
  const header = document.createElement('tr');
  for (const label of ['Metric', 'This reply', 'Conversation']) { const cell = document.createElement('th'); cell.textContent = label; cell.setAttribute('scope', 'col'); header.append(cell); }
  const head = document.createElement('thead'); head.append(header); table.append(head);
  const body = document.createElement('tbody');
  const tokenText = stats => `${formatMetricTokens(stats.totalTokens, stats.complete.totalTokens)} total · ${formatMetricTokens(stats.inputTokens, stats.complete.inputTokens)} in · ${formatMetricTokens(stats.outputTokens, stats.complete.outputTokens)} out`;
  const rows = [
    ['Tokens', tokenText(reply), tokenText(conversation)],
    ['首字延迟 · first text', formatMetricDuration(reply.firstTokenMs, reply.complete.firstTokenMs), formatMetricDuration(conversation.firstTokenMs, conversation.complete.firstTokenMs)],
    ['Total time', formatMetricDuration(reply.elapsedMs, reply.complete.elapsedMs), formatMetricDuration(conversation.elapsedMs, conversation.complete.elapsedMs)],
    ['tok/s · excluding delay', formatMetricRate(reply.outputTokensPerSecondExcludingDelay), formatMetricRate(conversation.outputTokensPerSecondExcludingDelay)],
    ['tok/s · including delay', formatMetricRate(reply.outputTokensPerSecond), formatMetricRate(conversation.outputTokensPerSecond)],
  ];
  for (const row of rows) {
    const element = document.createElement('tr');
    row.forEach((text, index) => { const cell = document.createElement(index ? 'td' : 'th'); cell.textContent = text; if (!index) cell.setAttribute('scope', 'row'); element.append(cell); });
    body.append(element);
  }
  table.append(body);
  table.title = 'Tokens are reported by the provider and can include reasoning. 首字延迟 ends at the first answer text. Conversation time and delays are sums of all attempts, including retries. Partial means some usage or timing is unavailable; N/A means no reliable value. Speed uses output tokens divided by elapsed time, with or without the first-text delay.';
  return table;
}
function fillAssistant(element, message) {
  const header = document.createElement('div');
  header.className = 'assistant-header';
  header.innerHTML = `<span class="assistant-avatar">${icon('sparkles')}</span><strong class="assistant-name">Assistant</strong><span class="message-model">${escapeHTML(message.model)}</span>`;
  const detailsWasOpen = element.querySelector('details')?.open;
  element.replaceChildren(header);
  renderGenerationStatus(element, message);
  if (message.reasoning) {
    const reasoning = document.createElement('details');
    reasoning.className = 'reasoning'; reasoning.open = Boolean(detailsWasOpen);
    const summary = document.createElement('summary'); summary.textContent = 'Reasoning provided by model';
    const text = document.createElement('pre'); text.textContent = message.reasoning;
    reasoning.append(summary, text); element.append(reasoning);
  }
  if (message.searches?.length) element.append(searchActivity(message.searches));
  if (message.notice === 'search_limit') {
    const notice = document.createElement('div'); notice.className = 'generation-notice';
    notice.textContent = message.status === 'streaming' ? 'Finishing with the sources already collected.' : message.status === 'complete' ? 'Finished with the available web results.' : 'Stopped while finishing the answer.';
    element.append(notice);
  }
  const content = document.createElement('div'); content.className = 'message-content';
  if (message.content) {
    content.innerHTML = markdown(message.content);
    content.querySelectorAll('a').forEach(link => { link.target = '_blank'; link.rel = 'noopener noreferrer'; });
    if (message.status !== 'streaming') content.querySelectorAll('pre').forEach(pre => {
      const copy = document.createElement('button'); copy.className = 'code-copy'; copy.textContent = 'Copy';
      copy.addEventListener('click', () => copyText(pre.querySelector('code')?.textContent || pre.textContent, copy));
      pre.append(copy);
    });
  } else if (message.status === 'streaming') {
    if (message.task !== 'image') content.innerHTML = '<span class="typing-indicator" aria-label="Waiting for reply"><span></span><span></span><span></span></span>';
  }
  else if (!sanitizeImages(message.images).length) { content.textContent = 'No reply received.'; content.style.color = 'var(--muted)'; }
  element.append(content);
  const images = sanitizeImages(message.images);
  const preview = message.status === 'streaming' && !images.length ? sanitizeImages([message.imagePreview]) : [];
  if (images.length || preview.length) {
    const gallery = document.createElement('div'); gallery.className = 'generated-images';
    for (const [index, image] of (images.length ? images : preview).entries()) {
      const figure = document.createElement('figure');
      if (image.dataUrl) {
        const picture = document.createElement('img'); picture.src = image.dataUrl;
        picture.alt = preview.length ? 'Image generation preview' : `Generated image ${index + 1}`;
        picture.loading = 'eager'; figure.append(picture);
      }
      const link = document.createElement('a'); link.href = image.dataUrl || image.url;
      link.className = 'generated-image-download';
      if (image.dataUrl) { link.download = `relay-image-${index + 1}.${image.dataUrl.startsWith('data:image/jpeg;') ? 'jpg' : image.dataUrl.startsWith('data:image/webp;') ? 'webp' : 'png'}`; link.textContent = preview.length ? 'Preview · generating…' : 'Download image'; }
      else { link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Open generated image'; }
      figure.append(link); gallery.append(figure);
    }
    element.append(gallery);
  }
  if (message.sources?.length) { const sources = sourceList(message.sources); sources.classList.toggle('assistant-sources', true); element.append(sources); }
  if (message.error) {
    const error = document.createElement('div'); error.className = 'message-error';
    error.innerHTML = `${icon('alert')}<span>${escapeHTML(message.error)}</span>`;
    element.append(error);
  }
  if (message.status === 'interrupted') {
    const status = document.createElement('div'); status.className = 'message-status';
    status.textContent = 'Stopped · partial reply is excluded from future messages'; element.append(status);
  }
  if (message.status !== 'streaming') {
    const actions = document.createElement('div'); actions.className = 'message-actions';
    if (message.content) {
      const copy = document.createElement('button'); copy.className = 'icon-button'; copy.innerHTML = icon('copy');
      copy.title = 'Copy reply'; copy.setAttribute('aria-label', 'Copy reply');
      copy.addEventListener('click', () => copyText(message.content, copy)); actions.append(copy);
    }
    if (message === currentChat.messages.at(-1)) {
      const retry = document.createElement('button'); retry.className = 'retry-button';
      retry.innerHTML = `${icon('refresh')} ${message.status === 'complete' ? 'Regenerate' : 'Retry'}`;
      retry.disabled = Boolean(activeGeneration);
      retry.addEventListener('click', () => sendMessage(true)); actions.append(retry);
    }
    element.append(actions, renderReplyMetrics(message));
  }
}
function renderChat() {
  $('chat-title').textContent = currentChat.title;
  $('welcome').hidden = currentChat.messages.length > 0;
  const container = $('messages'); container.replaceChildren();
  container.hidden = currentChat.messages.length === 0;
  for (const message of currentChat.messages) {
    const element = document.createElement('article'); element.className = `message message-${message.role}`; element.id = `message-${message.id}`;
    if (message.role === 'user') {
      const content = document.createElement('div'); content.className = 'message-content'; content.textContent = message.content; element.append(content);
      if (message.attachments?.length) element.append(attachmentList(message.attachments, false, true));
      if (message.search?.sources.length) {
        const details = document.createElement('details'); details.className = 'user-sources';
        const summary = document.createElement('summary'); summary.textContent = `Web search: ${message.search.query} · ${message.search.sources.length} sources`;
        details.append(summary, sourceList(message.search.sources)); element.append(details);
      }
    } else fillAssistant(element, message);
    container.append(element);
  }
  updateSendButton();
  if (currentChat.messages.length) scrollToBottom();
  else $('chat-scroll').scrollTop = 0;
}
function scrollToBottom() { requestAnimationFrame(() => { $('chat-scroll').scrollTop = $('chat-scroll').scrollHeight; }); }
function renderStreamingMessage(chat, message) {
  if (chat.id !== currentChat.id) return;
  const scroll = $('chat-scroll');
  const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
  const element = $(`message-${message.id}`);
  if (element) fillAssistant(element, message);
  if (atBottom) scrollToBottom();
}
function updateSendButton() {
  const button = $('send-button');
  button.classList.toggle('generating', Boolean(activeGeneration));
  button.innerHTML = icon(activeGeneration ? 'stop' : 'arrow-up');
  button.setAttribute('aria-label', activeGeneration ? 'Stop generating' : 'Send message');
  button.title = activeGeneration ? 'Stop generating' : 'Send message';
  const draft = composer();
  button.disabled = !activeGeneration && ((!$('message-input').value.trim() && !draft.attachments.length && !draft.search) || fileReads.has(currentChat.id) || searchRequests.has(currentChat.id));
}
function resizeComposer() {
  const input = $('message-input'); input.style.height = 'auto'; input.style.height = `${Math.min(144, Math.max(40, input.scrollHeight))}px`;
  updateSendButton();
}
async function copyText(text, button) {
  try { await navigator.clipboard.writeText(text); if (button) { const old = button.innerHTML; button.innerHTML = button.classList.contains('code-copy') ? 'Copied' : icon('check'); setTimeout(() => { button.innerHTML = old; }, 1600); } }
  catch { showToast('Copy is unavailable in this browser. Select the reply text to copy it.', true); }
}
function validateConnection() {
  updateConfig();
  if (!config.baseUrl) { showToast('Enter your API base URL in the sidebar.', true); sidebarOpen(true); $('base-url').focus(); return false; }
  try {
    const url = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { showToast('Use an HTTP or HTTPS base URL without credentials, query parameters, or a fragment.', true); sidebarOpen(true); $('base-url').focus(); return false; }
  return true;
}
async function loadModels() {
  if (!validateConnection()) return;
  const controller = new AbortController(); modelRequest?.abort(); modelRequest = controller;
  const baseUrl = config.baseUrl, apiKey = $('api-key').value.trim(), startingRevision = selectionRevision;
  $('load-models').disabled = true; $('load-models-label').textContent = 'Connecting…'; setConnection('loading', 'Connecting');
  try {
    const response = await fetch('/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl, apiKey }), signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || data.error || data.message || `Connection failed (${response.status}).`);
    if (controller.signal.aborted || modelRequest !== controller) return;
    if (!Array.isArray(data.models)) throw new Error('The server returned an invalid model list. You can still use a custom model ID.');
    const models = [...new Set(data.models.filter(id => typeof id === 'string' && id.trim() && id.length <= 256 && !/[\u0000-\u001f]/.test(id)).map(id => id.trim()))];
    const previous = currentModel(), wasCustom = $('model-select').value === 'custom:';
    modelIds = models;
    let chosen = previous, custom = wasCustom;
    let help = `${models.length} models loaded. Open the Model dropdown to choose any model.`;
    if (!models.length) {
      custom = true; help = 'No models were listed. Enter the exact custom model ID to continue.';
    } else if (previous && !models.includes(previous) && !wasCustom) {
      custom = true; help = 'Your previous model is not in this list. It is shown as a custom ID; choose a listed model to change it.';
    } else if (!previous && !wasCustom && selectionRevision === startingRevision) {
      chosen = models.find(id => !/(embedding|moderation|whisper|tts|transcrib|image|dall|audio|realtime)/i.test(id)) || '';
      if (!chosen) help = 'Models loaded. Choose a model that supports text chat, or enter a custom ID.';
    }
    renderModelChoices(chosen, custom); updateConfig();
    $('model-help').textContent = help;
    $('use-custom-model').hidden = true;
    setConnection('connected', 'Connected', models.length ? `${models.length} models available in the Model dropdown.` : 'Connected. No models listed; use a custom ID.');
    sidebarOpen(false);
    (custom ? $('model-input') : $('model-select')).focus();
    announce(`Connected. ${models.length} models loaded.`);
  } catch (error) { if (!controller.signal.aborted && modelRequest === controller) {
    const previous = currentModel(), custom = $('model-select').value === 'custom:';
    modelIds = []; renderModelChoices(previous, custom);
    setConnection('error', 'List unavailable', `${error.message} You can continue with a custom model ID.`);
    $('model-help').textContent = 'Model listing is unavailable. Your previous selection is retained; choose Custom model ID to enter another.';
    $('use-custom-model').hidden = false; announce('Model listing failed. You can use a custom model ID.');
  } }
  finally { if (modelRequest === controller) { modelRequest = null; $('load-models').disabled = false; $('load-models-label').textContent = 'Connect & load models'; } }
}
function stopGeneration() { if (activeGeneration) activeGeneration.controller.abort(); }
async function sendMessage(regenerate = false) {
  if (activeGeneration) { if (!regenerate) stopGeneration(); return; }
  const draft = composer();
  const prompt = $('message-input').value.trim() || (draft.attachments.length ? 'Please analyze the attached files.' : draft.search ? `Answer using the web results for: ${draft.search.query}` : '');
  if (!regenerate && !prompt) return;
  if (!regenerate && (fileReads.has(currentChat.id) || searchRequests.has(currentChat.id))) { showToast('Wait for the files or web search to finish. Your draft is kept.'); return; }
  if (!validateConnection()) return;
  if (!config.model) { showToast('Choose a model from the dropdown or enter a custom model ID before sending.', true); ($('model-select').value === 'custom:' ? $('model-input') : $('model-select')).focus(); return; }
  if (config.model.length > 256 || /[\u0000-\u001f]/.test(config.model)) { showToast('Model IDs must be at most 256 characters and contain no control characters.', true); $('model-input').focus(); return; }
  const imageRequest = /^(?:gpt-image(?:-|$)|dall-e(?:-|$)|chatgpt-image-latest$)/i.test(config.model.trim().split('/').at(-1));
  const chat = currentChat;
  {
    const replay = imageRequest
      ? (regenerate ? chat.messages.filter(message => message.role === 'user').slice(-1) : [])
      : regenerate ? chat.messages.slice(0, chat.messages.findLastIndex(message => message.role === 'user') + 1) : chat.messages;
    const pending = regenerate ? [] : draft.attachments;
    if (imageRequest && [...replay.flatMap(message => message.attachments || []), ...pending].some(file => !file.excluded && file.kind === 'file')) { showToast('Image models accept image and text attachments. Use a chat model for PDFs, documents, and spreadsheets.', true); return; }
    try { checkAttachmentBudget(replay, pending); }
    catch (error) { showToast(error.message, true); return; }
    const protocol = config.protocol === 'auto' ? (new URL(config.baseUrl).hostname === 'api.openai.com' || (config.webSearch && /^gpt-(?:6\.1-sol|6-astra)(?:$|-)/i.test(config.model)) ? 'responses' : 'chat') : config.protocol;
    if (!imageRequest && protocol === 'chat' && [...replay.flatMap(message => message.attachments || []), ...pending].some(file => !file.excluded && file.kind === 'file' && file.type !== 'application/pdf')) { showToast('For Word, Excel, or PowerPoint files, choose Responses API in Settings. Your chat, files, and draft are kept.', true); return; }
  }
  if (!regenerate && conversationMessages(chat.messages).length >= 499) { showToast('This conversation has reached its message limit. Start a new conversation to continue.', true); return; }
  if (regenerate) {
    const lastUser = chat.messages.findLastIndex(message => message.role === 'user');
    if (lastUser === -1) return;
    chat.metricsHistory ||= [];
    for (const previous of chat.messages.slice(lastUser + 1)) {
      const record = metricSnapshot(previous);
      if (record && !chat.metricsHistory.some(item => item.id && item.id === record.id)) chat.metricsHistory.push(record);
    }
    if (chat.metricsHistory.length > 5000) { chat.metricsHistory = chat.metricsHistory.slice(-5000); chat.metricsHistoryIncomplete = true; }
    chat.messages = chat.messages.slice(0, lastUser + 1);
  } else {
    if (!chat.messages.length) chat.title = prompt.replace(/\s+/g, ' ').slice(0, 55);
    chat.messages.push({ id: crypto.randomUUID(), role: 'user', content: prompt, status: 'complete', ...(draft.attachments.length ? { attachments: [...draft.attachments] } : {}), ...(draft.search ? { search: draft.search } : {}) });
    draft.text = ''; draft.attachments = []; draft.search = null;
    $('message-input').value = ''; resizeComposer();
  }
  if (!chats.some(c => c.id === chat.id)) {
    chat.title = chat.messages[0].content.replace(/\s+/g, ' ').slice(0, 55);
    chats.unshift(chat); chats = chats.slice(0, 50);
  }
  chat.updatedAt = Date.now();
  const lastUser = chat.messages.findLast(message => message.role === 'user');
  const requestMessages = conversationMessages(imageRequest ? [lastUser] : chat.messages);
  const reply = { id: crypto.randomUUID(), role: 'assistant', content: '', reasoning: '', model: config.model, effort: config.effort, protocol: '', status: 'streaming', elapsed: 0, usage: null, error: '', sources: sanitizeSources(lastUser?.search?.sources), searches: [] };
  chat.messages.push(reply);
  const operation = { controller: new AbortController(), chat, reply, startedAt: performance.now() };
  activeGeneration = operation;
  const request = { baseUrl: config.baseUrl, apiKey: $('api-key').value.trim(), model: config.model, effort: config.effort, protocol: config.protocol, systemPrompt: config.systemPrompt, webSearch: config.webSearch, messages: requestMessages };
  renderComposerContext(); renderChat(); renderHistory(); persist(); sidebarOpen(false); announce('Generating a reply.');
  try {
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: operation.controller.signal });
    await consumeEvents(response, event => {
      if (operation.controller.signal.aborted) return;
      reply.elapsed = performance.now() - operation.startedAt;
      if (event.type === 'delta' && typeof event.text === 'string' && event.text) { if (reply.firstTokenMs === undefined) reply.firstTokenMs = reply.elapsed; reply.content += event.text; }
      if (event.type === 'reasoning') reply.reasoning += event.text || '';
      if (event.type === 'usage' || (event.type === 'done' && event.usage)) {
        reply.usage = event.usage;
        if (event.usageKnown !== undefined) reply.usageKnown = event.usageKnown;
        if (event.usageCoverage) reply.usageCoverage = event.usageCoverage;
        else if (!request.webSearch || reply.task === 'image') {
          const known = name => typeof event.usage?.[name] === 'number' && Number.isSafeInteger(event.usage[name]) && event.usage[name] >= 0 ? 1 : 0;
          reply.usageCoverage = { providerCalls: 1, inputCalls: known('inputTokens'), outputCalls: known('outputTokens'), totalCalls: known('totalTokens') };
        }
      }
      if (event.type === 'sources') reply.sources = sanitizeSources([...reply.sources, ...(event.sources || [])]);
      if (event.type === 'search') recordSearchEvent(reply, event);
      if (event.type === 'notice' && event.code === 'search_limit') { reply.notice = 'search_limit'; announce('Finishing with the sources already collected.'); }
      if (event.type === 'meta') { reply.protocol = event.protocol; if (event.model) reply.model = event.model; if (event.task === 'image') reply.task = 'image'; }
      if (event.type === 'stage' && event.stage === 'image') reply.stage = 'image';
      if (event.type === 'partial_image') { const [image] = sanitizeImages([event.image || event]); if (image) reply.imagePreview = image; }
      if (event.type === 'image') { const [image] = sanitizeImages([event.image || event]); if (image) { reply.images = sanitizeImages([...(reply.images || []), image]); delete reply.imagePreview; } }
      renderStreamingMessage(chat, reply);
    });
    if (operation.controller.signal.aborted) reply.status = 'interrupted';
    else if (reply.task === 'image' && !reply.images?.length) throw new Error('The provider finished without a usable image. Retry the request or choose another image model.');
    else { reply.status = 'complete'; announce(reply.images?.length ? 'Image complete.' : 'Reply complete.'); }
  } catch (error) {
    if (operation.controller.signal.aborted) { reply.status = 'interrupted'; announce('Generation stopped.'); }
    else { reply.status = 'error'; reply.error = error.message; announce('The reply could not be completed.'); }
  } finally {
    delete reply.imagePreview;
    for (const search of reply.searches) if (search.status === 'searching') search.status = operation.controller.signal.aborted ? 'interrupted' : 'error';
    reply.elapsed = performance.now() - operation.startedAt;
    if (activeGeneration === operation) activeGeneration = null;
    persist(); if (chat.id === currentChat.id) renderChat(); updateSendButton();
    if (chat.id === currentChat.id) $('message-input').focus();
  }
}
function newChat() {
  stopGeneration(); composer().text = $('message-input').value; keepDraft();
  currentChat = makeChat(); restoreComposer(); renderChat(); renderHistory(); persist(); sidebarOpen(false); $('message-input').focus();
}

$('base-url').value = config.baseUrl; $('model-input').value = config.model; $('effort').value = config.effort;
renderModelChoices(config.model, config.modelMode === 'custom');
applyTheme(); updateProtocolLabel(); restoreComposer(); renderHistory(); renderChat();
sidebarOpen(false);
if (hasWorkspaceStorage()) {
  const initialRevision = workspaceRevision;
  loadWorkspace().then(state => {
    if (!state || workspaceRevision !== initialRevision) return;
    const restored = readSavedState({ getItem: () => JSON.stringify(state) });
    if ((restored.savedAt || 0) < (saved.savedAt || 0)) return;
    chats = restored.chats; currentChat = chats.find(chat => chat.id === restored.activeChatId) || chats[0] || makeChat();
    Object.assign(config, defaults, restored.config);
    if (!['auto', 'chat', 'responses'].includes(config.protocol)) config.protocol = 'auto';
    if (!Array.from($('effort').options).some(option => option.value === config.effort)) config.effort = 'auto';
    $('base-url').value = config.baseUrl; $('model-input').value = config.model; $('effort').value = config.effort;
    renderModelChoices(config.model, config.modelMode === 'custom'); applyTheme(); updateProtocolLabel(); restoreComposer(); renderHistory(); renderChat();
  }).catch(() => { showToast('File storage could not be restored. Your existing chat history is still available.', true); });
}
compactLayout?.addEventListener('change', () => sidebarOpen(false));
$('base-url').addEventListener('input', () => { resetConnection({ clearModel: true }); updateConfig(); });
$('api-key').addEventListener('input', () => resetConnection());
$('model-select').addEventListener('change', () => {
  selectionRevision++; syncModelInput(); updateConfig();
  $('model-help').textContent = $('model-select').value === 'custom:' ? 'Enter the exact model ID from your provider. Model listing is optional.' : currentModel() ? `Selected: ${currentModel()}` : 'Load models from your connection, or choose Custom model ID.';
  if ($('model-select').value === 'custom:') $('model-input').focus();
});
$('model-input').addEventListener('input', () => { selectionRevision++; updateConfig(); });
$('use-custom-model').addEventListener('click', useCustomModel);
$('effort').addEventListener('change', updateConfig);
$('toggle-key').addEventListener('click', () => {
  const visible = $('api-key').type === 'password'; $('api-key').type = visible ? 'text' : 'password';
  $('toggle-key').innerHTML = icon(visible ? 'eye-off' : 'eye'); $('toggle-key').setAttribute('aria-label', visible ? 'Hide API key' : 'Show API key');
});
$('load-models').addEventListener('click', loadModels);
$('new-chat').addEventListener('click', newChat);
$('mobile-menu').addEventListener('click', () => sidebarOpen(!$('sidebar').classList.contains('open')));
$('sidebar-backdrop').addEventListener('click', () => sidebarOpen(false));
$('theme-toggle').addEventListener('click', () => { config.theme = config.theme === 'dark' ? 'light' : 'dark'; applyTheme(); persist(); });
$('message-input').addEventListener('input', () => { rememberDraft(); resizeComposer(); });
$('attach-files').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', event => addFiles(event.target.files));
$('web-search-toggle').addEventListener('click', () => {
  composer().text = $('message-input').value;
  config.webSearch = !config.webSearch;
  renderComposerContext(); persist(); announce(`AI web search ${config.webSearch ? 'enabled' : 'disabled'} for your next message.`);
});
$('web-search-query').addEventListener('input', () => { composer().searchQuery = $('web-search-query').value; workspaceRevision++; clearTimeout(draftTimer); draftTimer = setTimeout(persist, 300); });
$('web-search-query').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); runWebSearch(); } });
$('run-web-search').addEventListener('click', runWebSearch);
$('message-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault(); if (!activeGeneration) sendMessage();
  }
});
$('chat-form').addEventListener('submit', event => { event.preventDefault(); sendMessage(); });
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => { $('message-input').value = button.dataset.prompt; rememberDraft(); resizeComposer(); $('message-input').focus(); }));
$('settings-button').addEventListener('click', () => {
  $('protocol').value = config.protocol; $('system-prompt').value = config.systemPrompt;
  clearConfirmation = false; $('clear-history').textContent = 'Clear chat history'; $('settings-dialog').showModal();
});
$('close-settings').addEventListener('click', () => $('settings-dialog').close());
$('settings-dialog').addEventListener('click', event => { if (event.target === $('settings-dialog')) { const rect = $('settings-dialog').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('settings-dialog').close(); } });
$('settings-form').addEventListener('submit', event => {
  event.preventDefault(); config.protocol = $('protocol').value; config.systemPrompt = $('system-prompt').value.trim();
  persist(); updateProtocolLabel(); $('settings-dialog').close(); showToast('Settings saved.');
});
$('clear-history').addEventListener('click', () => {
  if (!clearConfirmation) { clearConfirmation = true; $('clear-history').textContent = 'Click again to clear all'; return; }
  stopGeneration(); chats = []; currentChat = makeChat(); persist(); renderHistory(); renderChat(); clearConfirmation = false;
  for (const request of searchRequests.values()) request.abort(); searchRequests.clear(); fileReads.clear(); restoreComposer();
  $('clear-history').textContent = 'Clear chat history'; showToast('Chat history cleared.');
});
$('export-chat').addEventListener('click', () => {
  if (!currentChat.messages.length) { showToast('Start a conversation to export it.'); return; }
  const text = `# ${currentChat.title}\n\n` + currentChat.messages.map(message => `## ${message.role === 'user' ? 'You' : `Assistant${message.model ? ` (${message.model})` : ''}`}\n\n${message.content}${message.attachments?.length ? '\n\n' + message.attachments.map(file => `Attachment: ${file.name} (${formattedSize(file.size)})${file.kind === 'text' ? '\n\n' + file.text : ''}`).join('\n\n') : ''}${(message.search?.sources || message.sources)?.length ? '\n\nSources:\n' + (message.search?.sources || message.sources).map(source => `- [${source.title}](${source.url})`).join('\n') : ''}${message.status !== 'complete' ? `\n\n[${message.status}${message.error ? `: ${message.error}` : ''}]` : ''}`).join('\n\n---\n\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `relay-${currentChat.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 40) || 'conversation'}.md`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('backup-chat').addEventListener('click', () => {
  composer().text = $('message-input').value;
  const state = stateForStorage(config, [currentChat], currentChat.id);
  const snapshot = { format: 'relay.chat.v1', exportedAt: new Date().toISOString(), ...state };
  const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `relay-chat-${Date.now()}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !$('settings-dialog').open) { event.preventDefault(); newChat(); }
  if (event.key === 'Escape') sidebarOpen(false);
});
window.addEventListener('beforeunload', () => { composer().text = $('message-input').value; if (activeGeneration) activeGeneration.reply.status = 'interrupted'; persist(); });
