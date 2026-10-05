// Copyright (C) 2026 Jas-Jas-Yuan-debug
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdir, copyFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
await mkdir(new URL('public/vendor/', root), { recursive: true });
await copyFile(new URL('node_modules/marked/lib/marked.esm.js', root), new URL('public/vendor/marked.js', root));
await copyFile(new URL('node_modules/dompurify/dist/purify.es.mjs', root), new URL('public/vendor/purify.js', root));
console.log('Local browser dependencies ready.');
