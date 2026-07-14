'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const {
  attachRecordLinks,
  normalizeSourceLocation,
  sourceMatchesSelection,
  buildOpenUrl,
} = require('./source-location.cjs');
const {
  CLIPPER_TEMPLATE_ID,
  IMPORT_INDEX_RELATIVE_PATH,
  markClipperTemplateDismissed,
  markClipperTemplateAvailable,
  buildClipperContext,
  renderClipperTemplate,
  resolveTargetPath,
  extractRecordIds,
  stripRecordMarkers,
  normalizeImportIndex,
  hasImportedRecord,
  markImportedRecord,
} = require('./obsidian-clipper.cjs');

let installed = false;
let latestBrowserPayload = null;
let latestBrowserPayloadAt = 0;

function parseSelectionBody(buffer) {
  try {
    const parsed = JSON.parse(String(buffer || ''));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function installSelectionCapture() {
  if (http.__jiaohuaSourceCaptureInstalled) return;
  http.__jiaohuaSourceCaptureInstalled = true;
  const originalCreateServer = http.createServer;
  http.createServer = function createServerWithSelectionCapture(listener) {
    const wrapped = typeof listener === 'function'
      ? function wrappedRequestListener(req, res) {
          try {
            const url = String(req?.url || '').split('?')[0];
            if (String(req?.method || '').toUpperCase() === 'POST' && url === '/selection') {
              const chunks = [];
              let capturedBytes = 0;
              req.on('data', (chunk) => {
                capturedBytes += chunk.length;
                if (capturedBytes <= 1024 * 512) chunks.push(Buffer.from(chunk));
              });
              req.on('end', () => {
                const payload = parseSelectionBody(Buffer.concat(chunks).toString('utf8'));
                if (payload) {
                  latestBrowserPayload = payload;
                  latestBrowserPayloadAt = Date.now();
                }
              });
            }
          } catch (_) {}
          return listener(req, res);
        }
      : listener;
    return originalCreateServer.call(this, wrapped);
  };
}

function sourceSnapshotForSelection(selection, options = {}) {
  if (!latestBrowserPayload || Date.now() - latestBrowserPayloadAt > 30000) return null;
  const hasSelection = Boolean(String(selection || '').trim());
  if (hasSelection && !sourceMatchesSelection(latestBrowserPayload, selection)) return null;
  if (!hasSelection && !options.allowLatest) return null;
  return normalizeSourceLocation(latestBrowserPayload.sourceLocation);
}

function storeFile(app) {
  return path.join(app.getPath('userData'), 'data', 'store.json');
}

function readStore(app) {
  try {
    return JSON.parse(fs.readFileSync(storeFile(app), 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeStore(app, store) {
  const file = storeFile(app);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(store, null, 2), 'utf8');
}

function routeFromUrl(url) {
  try { return new URL(String(url || '')).searchParams.get('route') || 'main'; }
  catch (_) { return 'main'; }
}

function broadcastHistory(BrowserWindow, history) {
  if (!Array.isArray(history)) return;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue;
    if (routeFromUrl(win.webContents.getURL()) !== 'main') continue;
    try { win.webContents.send('history:changed', history); } catch (_) {}
  }
}

function updateHistoryRecord(app, BrowserWindow, recordId, updater) {
  const store = readStore(app);
  if (!store || !Array.isArray(store.history)) return null;
  let updatedRecord = null;
  let changed = false;
  const history = store.history.map((record) => {
    if (String(record?.id || '') !== String(recordId || '')) return record;
    const next = updater(record) || record;
    updatedRecord = next;
    changed = next !== record;
    return next;
  });
  if (!changed) return updatedRecord;
  const nextStore = { ...store, history };
  writeStore(app, nextStore);
  broadcastHistory(BrowserWindow, history);
  return updatedRecord;
}

function cleanHostFileName(hostname) {
  return String(hostname || 'website').toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 120) || 'website';
}

function extensionFromContentType(contentType, urlValue) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('png')) return '.png';
  if (type.includes('webp')) return '.webp';
  if (type.includes('jpeg') || type.includes('jpg')) return '.jpg';
  if (type.includes('icon') || type.includes('ico')) return '.ico';
  try {
    const ext = path.extname(new URL(urlValue).pathname).toLowerCase();
    if (['.png', '.webp', '.jpg', '.jpeg', '.ico'].includes(ext)) return ext === '.jpeg' ? '.jpg' : ext;
  } catch (_) {}
  return '.png';
}

async function ensureFavicon(vaultPath, record) {
  const location = record?.sourceLocation;
  if (!vaultPath || !location?.faviconUrl || !location?.hostname) return record;
  if (location.faviconVaultPath) return record;
  const relativeFolder = path.join('AI划词', '_assets', 'favicons');
  const folder = path.join(vaultPath, relativeFolder);
  fs.mkdirSync(folder, { recursive: true });
  const base = cleanHostFileName(location.hostname);
  const existing = fs.readdirSync(folder).find((name) => name === base || name.startsWith(`${base}.`));
  if (existing) {
    return { ...record, sourceLocation: { ...location, faviconVaultPath: `${relativeFolder.replace(/\\/g, '/')}/${existing}` } };
  }

  try {
    const response = await fetch(location.faviconUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(4500),
      headers: { 'User-Agent': 'JiaoHua-AI/1.0' },
    });
    if (!response.ok) return record;
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!/^image\/(png|jpe?g|webp|x-icon|vnd\.microsoft\.icon|ico)(?:;|$)/.test(contentType)) return record;
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > 256 * 1024) return record;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > 256 * 1024) return record;
    const ext = extensionFromContentType(contentType, location.faviconUrl);
    const name = `${base}${ext}`;
    fs.writeFileSync(path.join(folder, name), buffer);
    return { ...record, sourceLocation: { ...location, faviconVaultPath: `${relativeFolder.replace(/\\/g, '/')}/${name}` } };
  } catch (_) {
    return record;
  }
}

function findRecord(store, recordInput) {
  if (recordInput && typeof recordInput === 'object' && recordInput.id) {
    const persisted = store.history?.find((item) => String(item.id) === String(recordInput.id));
    return persisted ? { ...recordInput, ...persisted, sourceLocation: persisted.sourceLocation || recordInput.sourceLocation } : recordInput;
  }
  return store.history?.find((item) => String(item.id) === String(recordInput));
}

function enrichRecordFromLatestSource(record) {
  if (!record || record.sourceLocation) return record;
  const snapshot = sourceSnapshotForSelection(record.selectedText, { allowLatest: true });
  return snapshot ? attachRecordLinks(record, snapshot) : record;
}

function importIndexFile(vaultPath) {
  return path.join(vaultPath, ...IMPORT_INDEX_RELATIVE_PATH.split('/'));
}

function readImportIndex(vaultPath) {
  try {
    return normalizeImportIndex(JSON.parse(fs.readFileSync(importIndexFile(vaultPath), 'utf8')));
  } catch (_) {
    return normalizeImportIndex(null);
  }
}

function writeImportIndex(vaultPath, index) {
  const file = importIndexFile(vaultPath);
  const temporary = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify(normalizeImportIndex(index), null, 2), 'utf8');
  fs.renameSync(temporary, file);
}

function migrateTargetMarkers(vaultPath, target, relativePath, existing, index) {
  const ids = extractRecordIds(existing);
  const cleaned = stripRecordMarkers(existing);
  let nextIndex = normalizeImportIndex(index);
  for (const id of ids) nextIndex = markImportedRecord(nextIndex, id, relativePath);
  if (cleaned !== existing) fs.writeFileSync(target, cleaned, 'utf8');
  if (ids.length > 0) writeImportIndex(vaultPath, nextIndex);
  return { existing: cleaned, index: nextIndex, migratedIds: ids };
}

async function saveClipToObsidian(app, BrowserWindow, payload) {
  const request = payload || {};
  const store = readStore(app);
  if (!store) throw new Error('无法读取本地历史数据。');
  let record = findRecord(store, request.record || request.recordId);
  if (!record) throw new Error('没有找到这条历史记录。');
  record = enrichRecordFromLatestSource(record);
  const template = (store.obsidianTemplates || []).find((item) => item.id === request.templateId);
  if (!template) throw new Error('没有找到这个模板。');
  const vaultPath = String(store.settings?.obsidian?.vaultPath || '').trim();
  if (!vaultPath) throw new Error('还没有设置 Obsidian vault 路径。');

  const nextRecord = await ensureFavicon(vaultPath, record);
  const context = buildClipperContext(nextRecord);
  const { target, relativePath } = resolveTargetPath(vaultPath, template, context);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const rawExisting = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const migrated = migrateTargetMarkers(vaultPath, target, relativePath, rawExisting, readImportIndex(vaultPath));
  const existing = migrated.existing;
  const index = migrated.index;

  if (nextRecord.savedToObsidian || hasImportedRecord(index, nextRecord.id)) {
    const error = new Error('该记录已经导入 Obsidian。');
    error.code = 'DUPLICATE_RECORD';
    throw error;
  }

  const markdown = renderClipperTemplate(template, nextRecord);
  const separator = existing.trim() ? '\n\n' : '';
  if (template.saveBehavior === 'append_to_existing_note_top') {
    fs.writeFileSync(target, `${markdown}${separator}${existing}`, 'utf8');
  } else {
    fs.writeFileSync(target, `${existing}${separator}${markdown}\n`, 'utf8');
  }
  writeImportIndex(vaultPath, markImportedRecord(index, nextRecord.id, relativePath));

  const persistedRecord = updateHistoryRecord(app, BrowserWindow, nextRecord.id, (item) => ({
    ...item,
    sourceLocation: nextRecord.sourceLocation || item.sourceLocation,
    savedToObsidian: true,
    obsidianPath: target,
  }));
  return { ok: true, path: target, relativePath, templateName: template.name, record: persistedRecord || nextRecord };
}

function previewClip(app, payload) {
  const request = payload || {};
  const store = readStore(app);
  if (!store) throw new Error('无法读取本地历史数据。');
  let record = findRecord(store, request.record || request.recordId);
  if (!record) throw new Error('没有找到这条历史记录。');
  record = enrichRecordFromLatestSource(record);
  const template = (store.obsidianTemplates || []).find((item) => item.id === request.templateId);
  if (!template) throw new Error('没有找到这个模板。');
  const context = buildClipperContext(record);
  return {
    markdown: renderClipperTemplate(template, record),
    relativePath: resolveTargetPath(String(store.settings?.obsidian?.vaultPath || '.'), template, context).relativePath,
    behavior: template.saveBehavior,
    templateName: template.name,
  };
}

async function saveManyClips(app, BrowserWindow, payload) {
  const request = payload || {};
  const ids = [...new Set(Array.isArray(request.recordIds) ? request.recordIds : [])];
  if (!ids.length) throw new Error('没有选择历史记录。');
  const results = [];
  for (const recordId of ids) {
    try {
      const result = await saveClipToObsidian(app, BrowserWindow, { templateId: request.templateId, recordId });
      results.push({ recordId, ok: true, path: result.path });
    } catch (error) {
      results.push({
        recordId,
        ok: false,
        duplicate: error?.code === 'DUPLICATE_RECORD',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    ok: results.every((item) => item.ok || item.duplicate),
    successCount: results.filter((item) => item.ok).length,
    duplicateCount: results.filter((item) => item.duplicate).length,
    failureCount: results.filter((item) => !item.ok && !item.duplicate).length,
    results,
  };
}

function patchResultWithSource(app, BrowserWindow, result, snapshot) {
  if (!result || !result.id || !snapshot) return result;
  const patched = attachRecordLinks(result, snapshot);
  updateHistoryRecord(app, BrowserWindow, result.id, (record) => ({ ...record, sourceLocation: patched.sourceLocation }));
  return patched;
}

function updateBundledTemplateState(app, updater) {
  const store = readStore(app);
  if (!store) return;
  const next = updater(store);
  if (next !== store) writeStore(app, next);
}

function install() {
  if (installed) return;
  installed = true;
  installSelectionCapture();

  const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
  const registerHandler = ipcMain.handle.bind(ipcMain);

  registerHandler('source-location:open', async (_event, payload) => {
    const recordId = payload?.recordId;
    const record = recordId ? readStore(app)?.history?.find((item) => String(item.id) === String(recordId)) : null;
    const target = buildOpenUrl(record?.sourceLocation || payload?.sourceLocation);
    if (!target) return { ok: false, error: '没有可打开的来源链接。' };
    await shell.openExternal(target);
    return { ok: true, url: target };
  });

  registerHandler('source-location:copy', (_event, payload) => {
    const recordId = payload?.recordId;
    const record = recordId ? readStore(app)?.history?.find((item) => String(item.id) === String(recordId)) : null;
    const target = buildOpenUrl(record?.sourceLocation || payload?.sourceLocation, { leadSeconds: 0 });
    if (!target) return { ok: false };
    clipboard.writeText(target);
    return { ok: true, url: target };
  });

  ipcMain.handle = function handleWithSourceClipper(channel, listener) {
    if (channel === 'skill:run') {
      return registerHandler(channel, async (...args) => {
        const selection = args?.[1]?.selection || '';
        const snapshot = sourceSnapshotForSelection(selection, { allowLatest: true });
        const result = await listener(...args);
        return patchResultWithSource(app, BrowserWindow, result, snapshot);
      });
    }

    if (channel === 'result:confirm-selection-action') {
      return registerHandler(channel, async (...args) => {
        const selectedText = args?.[1]?.selectedText || '';
        const snapshot = sourceSnapshotForSelection(selectedText, { allowLatest: true });
        const result = await listener(...args);
        return patchResultWithSource(app, BrowserWindow, result, snapshot);
      });
    }

    if (channel === 'clipboard:write') {
      return registerHandler(channel, async (...args) => {
        const payload = args?.[1];
        if (payload?.options?.openExternal) {
          const target = String(payload.text || '');
          if (!/^https?:\/\//i.test(target)) return { ok: false };
          await shell.openExternal(target);
          return { ok: true, opened: true };
        }
        return listener(...args);
      });
    }

    if (channel === 'obsidian:templates:delete') {
      return registerHandler(channel, async (...args) => {
        const templateId = args?.[1];
        const result = await listener(...args);
        if (String(templateId || '') === CLIPPER_TEMPLATE_ID) {
          updateBundledTemplateState(app, markClipperTemplateDismissed);
        }
        return result;
      });
    }

    if (channel === 'obsidian:templates:save') {
      return registerHandler(channel, async (...args) => {
        const template = args?.[1];
        const result = await listener(...args);
        if (String(template?.id || '') === CLIPPER_TEMPLATE_ID) {
          updateBundledTemplateState(app, markClipperTemplateAvailable);
        }
        return result;
      });
    }

    if (channel === 'obsidian:template:preview') {
      return registerHandler(channel, (_event, payload) => previewClip(app, payload));
    }
    if (channel === 'obsidian:note:save') {
      return registerHandler(channel, (_event, payload) => saveClipToObsidian(app, BrowserWindow, payload));
    }
    if (channel === 'obsidian:notes:save-many') {
      return registerHandler(channel, (_event, payload) => saveManyClips(app, BrowserWindow, payload));
    }

    return registerHandler(channel, listener);
  };

  app.whenReady().then(() => {
    // The old jiaohua:// route is no longer used by Obsidian notes.
    try { app.removeAsDefaultProtocolClient('jiaohua'); } catch (_) {}
  });
  console.log('[SourceClipper] installed');
}

module.exports = {
  install,
  parseSelectionBody,
  sourceSnapshotForSelection,
  importIndexFile,
  readImportIndex,
  writeImportIndex,
  migrateTargetMarkers,
  patchResultWithSource,
};