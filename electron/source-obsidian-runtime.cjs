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

const fsp = fs.promises;
const FAVICON_FOLDER = path.join('AI划词', '_assets', 'favicons');
const FAVICON_TIMEOUT_MS = 2500;
const MAX_FAVICON_DOWNLOADS = 3;

let installed = false;
let latestBrowserPayload = null;
let latestBrowserPayloadAt = 0;
let importQueue = Promise.resolve();
let activeFaviconDownloads = 0;
const faviconQueue = [];
const faviconTasks = new Map();

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

async function readStoreAsync(app) {
  try {
    return JSON.parse(await fsp.readFile(storeFile(app), 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeStore(app, store) {
  const file = storeFile(app);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(store, null, 2), 'utf8');
}

async function writeStoreAsync(app, store) {
  const file = storeFile(app);
  const temporary = `${file}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(temporary, JSON.stringify(store, null, 2), 'utf8');
  await fsp.rename(temporary, file);
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
  writeStore(app, { ...store, history });
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

async function cachedFaviconPath(vaultPath, location) {
  if (!vaultPath || !location?.hostname) return '';
  if (location.faviconVaultPath) return String(location.faviconVaultPath);
  const folder = path.join(vaultPath, FAVICON_FOLDER);
  const base = cleanHostFileName(location.hostname);
  try {
    const entries = await fsp.readdir(folder);
    const existing = entries.find((name) => name === base || name.startsWith(`${base}.`));
    return existing ? `${FAVICON_FOLDER.replace(/\\/g, '/')}/${existing}` : '';
  } catch (_) {
    return '';
  }
}

async function recordWithCachedFavicon(vaultPath, record) {
  const location = record?.sourceLocation;
  if (!location) return record;
  const cached = await cachedFaviconPath(vaultPath, location);
  return cached
    ? { ...record, sourceLocation: { ...location, faviconVaultPath: cached } }
    : record;
}

async function downloadFavicon(vaultPath, location) {
  if (!vaultPath || !location?.faviconUrl || !location?.hostname) return '';
  const cached = await cachedFaviconPath(vaultPath, location);
  if (cached) return cached;

  const folder = path.join(vaultPath, FAVICON_FOLDER);
  const base = cleanHostFileName(location.hostname);
  try {
    const response = await fetch(location.faviconUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FAVICON_TIMEOUT_MS),
      headers: { 'User-Agent': 'JiaoHua-AI/1.0' },
    });
    if (!response.ok) return '';
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!/^image\/(png|jpe?g|webp|x-icon|vnd\.microsoft\.icon|ico)(?:;|$)/.test(contentType)) return '';
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > 256 * 1024) return '';
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > 256 * 1024) return '';
    const ext = extensionFromContentType(contentType, location.faviconUrl);
    const name = `${base}${ext}`;
    await fsp.mkdir(folder, { recursive: true });
    await fsp.writeFile(path.join(folder, name), buffer);
    return `${FAVICON_FOLDER.replace(/\\/g, '/')}/${name}`;
  } catch (_) {
    return '';
  }
}

function pumpFaviconQueue() {
  while (activeFaviconDownloads < MAX_FAVICON_DOWNLOADS && faviconQueue.length > 0) {
    const task = faviconQueue.shift();
    activeFaviconDownloads += 1;
    Promise.resolve()
      .then(task.run)
      .catch(() => '')
      .finally(() => {
        activeFaviconDownloads -= 1;
        faviconTasks.delete(task.key);
        pumpFaviconQueue();
      });
  }
}

function scheduleFaviconDownload(vaultPath, location) {
  if (!vaultPath || !location?.faviconUrl || !location?.hostname || location.faviconVaultPath) return;
  const key = `${path.resolve(vaultPath)}|${String(location.hostname).toLowerCase()}`;
  if (faviconTasks.has(key)) return;
  faviconTasks.set(key, true);
  faviconQueue.push({ key, run: () => downloadFavicon(vaultPath, location) });
  pumpFaviconQueue();
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

async function readImportIndexAsync(vaultPath) {
  try {
    return normalizeImportIndex(JSON.parse(await fsp.readFile(importIndexFile(vaultPath), 'utf8')));
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

async function writeImportIndexAsync(vaultPath, index) {
  const file = importIndexFile(vaultPath);
  const temporary = `${file}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(temporary, JSON.stringify(normalizeImportIndex(index), null, 2), 'utf8');
  await fsp.rename(temporary, file);
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

function enqueueImport(task) {
  const run = importQueue.then(task, task);
  importQueue = run.catch(() => {});
  return run;
}

function duplicateResult(recordId) {
  return {
    recordId,
    ok: false,
    duplicate: true,
    error: '该记录已经导入 Obsidian。',
  };
}

async function loadTarget(target) {
  try { return await fsp.readFile(target, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

async function writeTargetGroup(group, existing) {
  const blocks = group.items.map((item) => item.markdown).filter(Boolean);
  if (!blocks.length) return;
  const joined = blocks.join('\n\n');
  await fsp.mkdir(path.dirname(group.target), { recursive: true });

  if (group.template.saveBehavior === 'append_to_existing_note_top') {
    const separator = existing.trim() ? '\n\n' : '';
    await fsp.writeFile(group.target, `${joined}${separator}${existing}`, 'utf8');
    return;
  }

  const separator = existing.trim() ? '\n\n' : '';
  await fsp.appendFile(group.target, `${separator}${joined}\n`, 'utf8');
}

async function importRecords(app, BrowserWindow, payload) {
  const startedAt = Date.now();
  const request = payload || {};
  const requestedIds = [...new Set(Array.isArray(request.recordIds)
    ? request.recordIds.map((id) => String(id))
    : [String(request.recordId || request.record?.id || '')].filter(Boolean))];
  if (!requestedIds.length) throw new Error('没有选择历史记录。');

  const store = await readStoreAsync(app);
  if (!store) throw new Error('无法读取本地历史数据。');
  const template = (store.obsidianTemplates || []).find((item) => item.id === request.templateId);
  if (!template) throw new Error('没有找到这个模板。');
  const vaultPath = String(store.settings?.obsidian?.vaultPath || '').trim();
  if (!vaultPath) throw new Error('还没有设置 Obsidian vault 路径。');

  let index = await readImportIndexAsync(vaultPath);
  const resultsById = new Map();
  const candidates = [];

  for (const recordId of requestedIds) {
    let record = findRecord(store, request.record && String(request.record.id) === recordId ? request.record : recordId);
    if (!record) {
      resultsById.set(recordId, { recordId, ok: false, duplicate: false, error: '没有找到这条历史记录。' });
      continue;
    }
    record = enrichRecordFromLatestSource(record);
    if (record.savedToObsidian || hasImportedRecord(index, record.id)) {
      resultsById.set(recordId, duplicateResult(recordId));
      continue;
    }
    candidates.push(await recordWithCachedFavicon(vaultPath, record));
  }

  const groups = new Map();
  for (const record of candidates) {
    const context = buildClipperContext(record);
    const { target, relativePath } = resolveTargetPath(vaultPath, template, context);
    const key = path.resolve(target);
    if (!groups.has(key)) groups.set(key, { target: key, relativePath, template, items: [] });
    groups.get(key).items.push({ record, markdown: renderClipperTemplate(template, record) });
  }

  for (const group of groups.values()) {
    try {
      const rawExisting = await loadTarget(group.target);
      const markerIds = extractRecordIds(rawExisting);
      let existing = stripRecordMarkers(rawExisting);
      for (const id of markerIds) index = markImportedRecord(index, id, group.relativePath);
      if (existing !== rawExisting) {
        await fsp.mkdir(path.dirname(group.target), { recursive: true });
        await fsp.writeFile(group.target, existing, 'utf8');
      }

      const writable = [];
      for (const item of group.items) {
        if (hasImportedRecord(index, item.record.id)) {
          resultsById.set(String(item.record.id), duplicateResult(String(item.record.id)));
        } else {
          writable.push(item);
        }
      }
      group.items = writable;
      if (!group.items.length) continue;

      await writeTargetGroup(group, existing);
      for (const item of group.items) {
        index = markImportedRecord(index, item.record.id, group.relativePath);
        resultsById.set(String(item.record.id), {
          recordId: String(item.record.id),
          ok: true,
          path: group.target,
          relativePath: group.relativePath,
        });
        scheduleFaviconDownload(vaultPath, item.record.sourceLocation);
      }
    } catch (error) {
      for (const item of group.items) {
        resultsById.set(String(item.record.id), {
          recordId: String(item.record.id),
          ok: false,
          duplicate: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const successfulIds = new Set([...resultsById.values()].filter((item) => item.ok).map((item) => String(item.recordId)));
  let nextStore = store;
  if (successfulIds.size > 0) {
    const pathsById = new Map([...resultsById.values()].filter((item) => item.ok).map((item) => [String(item.recordId), item.path]));
    const history = (store.history || []).map((record) => successfulIds.has(String(record.id))
      ? { ...record, savedToObsidian: true, obsidianPath: pathsById.get(String(record.id)) }
      : record);
    nextStore = { ...store, history };
    await Promise.all([
      writeImportIndexAsync(vaultPath, index),
      writeStoreAsync(app, nextStore),
    ]);
    broadcastHistory(BrowserWindow, history);
  } else if (extractRecordIds('').length === 0 && JSON.stringify(index) !== JSON.stringify(await readImportIndexAsync(vaultPath))) {
    await writeImportIndexAsync(vaultPath, index);
  }

  const results = requestedIds.map((id) => resultsById.get(id) || ({ recordId: id, ok: false, duplicate: false, error: '导入未完成。' }));
  const durationMs = Date.now() - startedAt;
  console.log(`[SourceClipper] imported ${results.filter((item) => item.ok).length}/${requestedIds.length} record(s) in ${durationMs}ms across ${groups.size} note(s)`);
  return {
    ok: results.every((item) => item.ok || item.duplicate),
    successCount: results.filter((item) => item.ok).length,
    duplicateCount: results.filter((item) => item.duplicate).length,
    failureCount: results.filter((item) => !item.ok && !item.duplicate).length,
    durationMs,
    results,
  };
}

async function saveClipToObsidian(app, BrowserWindow, payload) {
  const batch = await enqueueImport(() => importRecords(app, BrowserWindow, {
    ...payload,
    recordId: payload?.recordId || payload?.record?.id,
  }));
  const item = batch.results[0];
  if (!item?.ok) {
    const error = new Error(item?.error || '导入失败。');
    if (item?.duplicate) error.code = 'DUPLICATE_RECORD';
    throw error;
  }
  const store = await readStoreAsync(app);
  const record = store?.history?.find((entry) => String(entry.id) === String(item.recordId));
  return {
    ok: true,
    path: item.path,
    relativePath: item.relativePath,
    templateName: (store?.obsidianTemplates || []).find((entry) => entry.id === payload?.templateId)?.name || '',
    record,
    durationMs: batch.durationMs,
  };
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
  return enqueueImport(() => importRecords(app, BrowserWindow, payload));
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
        if (String(templateId || '') === CLIPPER_TEMPLATE_ID) updateBundledTemplateState(app, markClipperTemplateDismissed);
        return result;
      });
    }

    if (channel === 'obsidian:templates:save') {
      return registerHandler(channel, async (...args) => {
        const template = args?.[1];
        const result = await listener(...args);
        if (String(template?.id || '') === CLIPPER_TEMPLATE_ID) updateBundledTemplateState(app, markClipperTemplateAvailable);
        return result;
      });
    }

    if (channel === 'obsidian:template:preview') return registerHandler(channel, (_event, payload) => previewClip(app, payload));
    if (channel === 'obsidian:note:save') return registerHandler(channel, (_event, payload) => saveClipToObsidian(app, BrowserWindow, payload));
    if (channel === 'obsidian:notes:save-many') return registerHandler(channel, (_event, payload) => saveManyClips(app, BrowserWindow, payload));
    return registerHandler(channel, listener);
  };

  app.whenReady().then(() => {
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
  cachedFaviconPath,
  recordWithCachedFavicon,
  importRecords,
  patchResultWithSource,
};
