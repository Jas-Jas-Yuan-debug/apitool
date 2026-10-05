// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

import { stateForStorage } from './client.js';

const DATABASE_NAME = 'relay.workspace';
const STORE_NAME = 'workspace';
const WORKSPACE_KEY = 'current';
let opening = null;
let writes = Promise.resolve();

export function hasWorkspaceStorage() {
  try { return typeof globalThis.indexedDB?.open === 'function'; }
  catch { return false; }
}

function openDatabase() {
  if (!hasWorkspaceStorage()) return Promise.reject(new Error('Browser workspace storage is unavailable.'));
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    let request, settled = false;
    const fail = error => { if (!settled) { settled = true; reject(error); } };
    try { request = globalThis.indexedDB.open(DATABASE_NAME, 1); }
    catch (error) { fail(error); return; }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onerror = () => fail(request.error || new Error('Could not open browser workspace storage.'));
    request.onblocked = () => fail(new Error('Browser workspace storage is blocked by another open tab.'));
    request.onsuccess = () => {
      const database = request.result;
      if (settled) { database.close(); return; }
      settled = true;
      database.onversionchange = () => { database.close(); opening = null; };
      database.onclose = () => { opening = null; };
      resolve(database);
    };
  }).catch(error => { opening = null; throw error; });
  return opening;
}

async function transaction(mode, operation) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction, request, result;
    try {
      transaction = database.transaction(STORE_NAME, mode);
      request = operation(transaction.objectStore(STORE_NAME));
    } catch (error) { reject(error); return; }
    request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error || request.error || new Error('Browser workspace save was interrupted.'));
    transaction.onerror = () => reject(transaction.error || request.error || new Error('Browser workspace storage failed.'));
  });
}

export async function loadWorkspace() {
  if (!hasWorkspaceStorage()) return null;
  const value = await transaction('readonly', store => store.get(WORKSPACE_KEY));
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function saveWorkspace(state) {
  let snapshot;
  try { snapshot = JSON.parse(JSON.stringify(stateForStorage(state?.config || {}, state?.chats || [], state?.activeChatId, state?.savedAt))); }
  catch (error) { return Promise.reject(error); }
  // Capture each complete snapshot immediately; later in-memory edits cannot
  // change queued writes. A failed write does not block the next save attempt.
  const pending = writes.catch(() => {}).then(() => transaction('readwrite', store => store.put(snapshot, WORKSPACE_KEY)));
  writes = pending;
  // Keep failures observable to the caller without leaving an abandoned queue
  // rejection when there are no further saves.
  pending.catch(() => {});
  return pending.then(() => true);
}
