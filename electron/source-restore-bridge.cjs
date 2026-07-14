'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { buildOpenUrl, cleanUrl } = require('./source-location.cjs');

const RESTORE_PORT = 17322;
const RESTORE_TOKEN = 'aisel-local-bridge-v1';
let installed = false;
let pendingRestore = null;
let server = null;

function storeFile(app) {
  return path.join(app.getPath('userData'), 'data', 'store.json');
}

function readStore(app) {
  try { return JSON.parse(fs.readFileSync(storeFile(app), 'utf8')); }
  catch (_) { return null; }
}

function comparableUrl(value) {
  const cleaned = cleanUrl(value);
  if (!cleaned) return '';
  try {
    const url = new URL(cleaned);
    url.hash = '';
    for (const key of ['t', 'start', 'time_continue']) url.searchParams.delete(key);
    return url.toString();
  } catch (_) {
    return cleaned;
  }
}

function samePage(a, b) {
  const left = comparableUrl(a);
  const right = comparableUrl(b);
  if (!left || !right) return false;
  try {
    const x = new URL(left);
    const y = new URL(right);
    if (x.hostname !== y.hostname || x.pathname !== y.pathname) return false;
    if (x.hostname.endsWith('youtube.com')) return x.searchParams.get('v') === y.searchParams.get('v');
    return true;
  } catch (_) {
    return left === right;
  }
}

function findSourceRecord(app, targetUrl) {
  const store = readStore(app);
  const records = Array.isArray(store?.history) ? store.history : [];
  return records.find((record) => {
    const location = record?.sourceLocation;
    if (!location?.url) return false;
    return samePage(buildOpenUrl(location), targetUrl) || samePage(location.url, targetUrl);
  }) || null;
}

function queueRestore(record) {
  if (!record?.sourceLocation?.url) return null;
  pendingRestore = {
    id: `${Date.now()}-${String(record.id || '').slice(0, 24)}`,
    recordId: String(record.id || ''),
    sourceLocation: record.sourceLocation,
    createdAt: Date.now(),
    expiresAt: Date.now() + 90000,
  };
  return pendingRestore;
}

function currentRestoreFor(url) {
  if (!pendingRestore) return null;
  if (Date.now() > pendingRestore.expiresAt) {
    pendingRestore = null;
    return null;
  }
  return samePage(pendingRestore.sourceLocation?.url, url) ? pendingRestore : null;
}

function startServer() {
  if (server) return;
  server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    let parsed;
    try { parsed = new URL(req.url || '/', `http://127.0.0.1:${RESTORE_PORT}`); }
    catch (_) { res.writeHead(400); res.end('bad url'); return; }

    if (req.method !== 'GET' || parsed.pathname !== '/restore') {
      res.writeHead(404); res.end('not found'); return;
    }
    if (parsed.searchParams.get('token') !== RESTORE_TOKEN) {
      res.writeHead(403); res.end('bad token'); return;
    }

    const pending = currentRestoreFor(parsed.searchParams.get('url') || '');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, restore: pending }));
  });
  server.on('error', (error) => {
    if (error?.code !== 'EADDRINUSE') console.error('[SourceRestore] server error', error);
  });
  server.listen(RESTORE_PORT, '127.0.0.1', () => {
    console.log(`[SourceRestore] listening on http://127.0.0.1:${RESTORE_PORT}/restore`);
  });
}

function install() {
  if (installed) return;
  installed = true;
  const { app, shell } = require('electron');
  const originalOpenExternal = shell.openExternal.bind(shell);
  shell.openExternal = async function openExternalWithRestore(target, options) {
    try {
      const record = findSourceRecord(app, target);
      if (record) queueRestore(record);
    } catch (_) {}
    return originalOpenExternal(target, options);
  };

  app.whenReady().then(startServer);
  app.once('before-quit', () => {
    try { server?.close(); } catch (_) {}
    shell.openExternal = originalOpenExternal;
  });
  console.log('[SourceRestore] installed');
}

module.exports = {
  RESTORE_PORT,
  RESTORE_TOKEN,
  comparableUrl,
  samePage,
  queueRestore,
  currentRestoreFor,
  install,
};
