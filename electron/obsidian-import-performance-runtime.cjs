'use strict';

const fs = require('fs');
const path = require('path');
const {
  IMPORT_INDEX_RELATIVE_PATH,
  buildClipperContext,
  renderClipperTemplate,
  resolveTargetPath,
  extractRecordIds,
  stripRecordMarkers,
  normalizeImportIndex,
} = require('./obsidian-clipper.cjs');

const fsp = fs.promises;
const FAVICON_FOLDER = path.join('AI划词', '_assets', 'favicons');
const FAVICON_TIMEOUT_MS = 2500;
const MAX_FAVICON_DOWNLOADS = 3;
const MAX_NOTE_WRITES = 4;

let importQueue = Promise.resolve();
let activeFaviconDownloads = 0;
const faviconQueue = [];
const faviconTasks = new Set();

function storeFile(app) {
  return path.join(app.getPath('userData'), 'data', 'store.json');
}

function importIndexFile(vaultPath) {
  return path.join(vaultPath, ...IMPORT_INDEX_RELATIVE_PATH.split('/'));
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

async function atomicWriteJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  try {
    await fsp.rename(temporary, file);
  } catch (error) {
    if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(String(error?.code || ''))) throw error;
    await fsp.rm(file, { force: true });
    await fsp.rename(temporary, file);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

function normalizeFastIndex(value) {
  const normalized = normalizeImportIndex(value);
  const migratedPaths = {};
  const raw = value?.migratedPaths;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const key = String(item || '').trim();
      if (key) migratedPaths[key] = '';
    }
  } else if (raw && typeof raw === 'object') {
    for (const [relativePath, migratedAt] of Object.entries(raw)) {
      const key = String(relativePath || '').trim();
      if (key) migratedPaths[key] = String(migratedAt || '');
    }
  }
  return { ...normalized, migratedPaths };
}

function hasImportedFast(index, recordId) {
  const key = String(recordId || '').trim();
  return Boolean(key && index?.records?.[key]);
}

function markImportedFast(index, recordId, relativePath, importedAt = new Date().toISOString()) {
  const key = String(recordId || '').trim();
  if (!key) return false;
  const previous = index.records[key] || { importedAt: '', paths: [] };
  const pathValue = String(relativePath || '').trim();
  const paths = pathValue && !previous.paths.includes(pathValue)
    ? [...previous.paths, pathValue]
    : previous.paths;
  const next = {
    importedAt: previous.importedAt || String(importedAt || ''),
    paths,
  };
  const changed = !index.records[key]
    || next.importedAt !== previous.importedAt
    || next.paths !== previous.paths;
  index.records[key] = next;
  return changed;
}

function hasMigratedPath(index, relativePath) {
  return Boolean(index?.migratedPaths?.[String(relativePath || '').trim()]);
}

function markMigratedPath(index, relativePath, migratedAt = new Date().toISOString()) {
  const key = String(relativePath || '').trim();
  if (!key || index.migratedPaths[key]) return false;
  index.migratedPaths[key] = String(migratedAt || '');
  return true;
}

async function readStore(app) {
  return readJson(storeFile(app), null);
}

async function readImportIndex(vaultPath) {
  return normalizeFastIndex(await readJson(importIndexFile(vaultPath), null));
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

async function loadFaviconCache(vaultPath) {
  const folder = path.join(vaultPath, FAVICON_FOLDER);
  const cache = new Map();
  try {
    const entries = await fsp.readdir(folder);
    for (const name of entries) {
      const base = name.replace(/\.(png|webp|jpe?g|ico)$/i, '');
      if (!cache.has(base)) cache.set(base, `${FAVICON_FOLDER.replace(/\\/g, '/')}/${name}`);
    }
  } catch (_) {}
  return cache;
}

function attachCachedFavicon(record, cache) {
  const location = record?.sourceLocation;
  if (!location || location.faviconVaultPath || !location.hostname) return record;
  const cached = cache.get(cleanHostFileName(location.hostname));
  return cached
    ? { ...record, sourceLocation: { ...location, faviconVaultPath: cached } }
    : record;
}

async function downloadFavicon(vaultPath, location) {
  if (!vaultPath || !location?.faviconUrl || !location?.hostname || location.faviconVaultPath) return '';
  const folder = path.join(vaultPath, FAVICON_FOLDER);
  const base = cleanHostFileName(location.hostname);
  try {
    const existing = (await fsp.readdir(folder)).find((name) => name === base || name.startsWith(`${base}.`));
    if (existing) return `${FAVICON_FOLDER.replace(/\\/g, '/')}/${existing}`;
  } catch (_) {}

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
    await fsp.mkdir(folder, { recursive: true });
    await fsp.writeFile(path.join(folder, `${base}${ext}`), buffer);
    return `${FAVICON_FOLDER.replace(/\\/g, '/')}/${base}${ext}`;
  } catch (_) {
    return '';
  }
}

function pumpFaviconQueue() {
  while (activeFaviconDownloads < MAX_FAVICON_DOWNLOADS && faviconQueue.length) {
    const task = faviconQueue.shift();
    activeFaviconDownloads += 1;
    Promise.resolve(task.run())
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
  faviconTasks.add(key);
  faviconQueue.push({ key, run: () => downloadFavicon(vaultPath, location) });
  pumpFaviconQueue();
}

async function readText(file) {
  try { return await fsp.readFile(file, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

async function fileHasContent(file) {
  try { return (await fsp.stat(file)).size > 0; }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function mapLimit(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function duplicateResult(recordId) {
  return {
    recordId: String(recordId),
    ok: false,
    duplicate: true,
    error: '该记录已经导入 Obsidian。',
  };
}

async function prepareTarget(group, index, state) {
  const isTopInsert = group.template.saveBehavior === 'append_to_existing_note_top';
  const migrationPending = !hasMigratedPath(index, group.relativePath);
  let existing = '';
  let hasExistingContent = false;

  if (isTopInsert || migrationPending) {
    const raw = await readText(group.target);
    existing = raw;
    hasExistingContent = Boolean(raw.trim());

    if (migrationPending || raw.includes('jiaohua-record')) {
      const markerIds = extractRecordIds(raw);
      const cleaned = stripRecordMarkers(raw);
      for (const id of markerIds) {
        if (markImportedFast(index, id, group.relativePath)) state.indexDirty = true;
      }
      if (markMigratedPath(index, group.relativePath)) state.indexDirty = true;
      if (cleaned !== raw) {
        await fsp.mkdir(path.dirname(group.target), { recursive: true });
        await fsp.writeFile(group.target, cleaned, 'utf8');
        existing = cleaned;
        hasExistingContent = Boolean(cleaned.trim());
      }
    }
  } else {
    hasExistingContent = await fileHasContent(group.target);
  }

  return { existing, hasExistingContent, isTopInsert };
}

async function writeGroup(group, targetState) {
  const blocks = group.items.map((item) => item.markdown).filter(Boolean);
  if (!blocks.length) return;
  const joined = blocks.join('\n\n');
  const separator = targetState.hasExistingContent ? '\n\n' : '';
  await fsp.mkdir(path.dirname(group.target), { recursive: true });

  if (targetState.isTopInsert) {
    await fsp.writeFile(group.target, `${joined}${separator}${targetState.existing}`, 'utf8');
  } else {
    await fsp.appendFile(group.target, `${separator}${joined}\n`, 'utf8');
  }
}

function findRequestedRecord(historyById, requestRecord, recordId) {
  const persisted = historyById.get(String(recordId));
  if (!requestRecord || String(requestRecord.id) !== String(recordId)) return persisted || null;
  return persisted
    ? { ...requestRecord, ...persisted, sourceLocation: persisted.sourceLocation || requestRecord.sourceLocation }
    : requestRecord;
}

async function importRecordsFast(app, BrowserWindow, payload) {
  const startedAt = Date.now();
  const timings = {};
  const request = payload || {};
  const requestedIds = [...new Set(Array.isArray(request.recordIds)
    ? request.recordIds.map((id) => String(id)).filter(Boolean)
    : [String(request.recordId || request.record?.id || '')].filter(Boolean))];
  if (!requestedIds.length) throw new Error('没有选择历史记录。');

  let stageAt = Date.now();
  const store = await readStore(app);
  if (!store) throw new Error('无法读取本地历史数据。');
  const template = (store.obsidianTemplates || []).find((item) => item.id === request.templateId);
  if (!template) throw new Error('没有找到这个模板。');
  const vaultPath = String(store.settings?.obsidian?.vaultPath || '').trim();
  if (!vaultPath) throw new Error('还没有设置 Obsidian vault 路径。');
  const [index, faviconCache] = await Promise.all([
    readImportIndex(vaultPath),
    loadFaviconCache(vaultPath),
  ]);
  timings.loadMs = Date.now() - stageAt;

  stageAt = Date.now();
  const historyById = new Map((store.history || []).map((record) => [String(record.id), record]));
  const resultsById = new Map();
  const groups = new Map();

  for (const recordId of requestedIds) {
    let record = findRequestedRecord(historyById, request.record, recordId);
    if (!record) {
      resultsById.set(recordId, { recordId, ok: false, duplicate: false, error: '没有找到这条历史记录。' });
      continue;
    }
    if (record.savedToObsidian || hasImportedFast(index, record.id)) {
      resultsById.set(recordId, duplicateResult(recordId));
      continue;
    }
    record = attachCachedFavicon(record, faviconCache);
    const context = buildClipperContext(record);
    const { target, relativePath } = resolveTargetPath(vaultPath, template, context);
    const key = path.resolve(target);
    if (!groups.has(key)) groups.set(key, { target: key, relativePath, template, items: [] });
    groups.get(key).items.push({ record, markdown: renderClipperTemplate(template, record) });
  }
  timings.prepareMs = Date.now() - stageAt;

  stageAt = Date.now();
  const state = { indexDirty: false };
  await mapLimit([...groups.values()], MAX_NOTE_WRITES, async (group) => {
    try {
      const targetState = await prepareTarget(group, index, state);
      group.items = group.items.filter((item) => {
        if (!hasImportedFast(index, item.record.id)) return true;
        resultsById.set(String(item.record.id), duplicateResult(item.record.id));
        return false;
      });
      if (!group.items.length) return;

      await writeGroup(group, targetState);
      for (const item of group.items) {
        if (markImportedFast(index, item.record.id, group.relativePath)) state.indexDirty = true;
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
  });
  timings.writeNotesMs = Date.now() - stageAt;

  stageAt = Date.now();
  const successfulResults = [...resultsById.values()].filter((item) => item.ok);
  const successfulIds = new Set(successfulResults.map((item) => String(item.recordId)));
  let history = store.history || [];
  const updatedRecords = new Map();

  if (successfulIds.size) {
    const pathsById = new Map(successfulResults.map((item) => [String(item.recordId), item.path]));
    history = history.map((record) => {
      const id = String(record.id);
      if (!successfulIds.has(id)) return record;
      const updated = { ...record, savedToObsidian: true, obsidianPath: pathsById.get(id) };
      updatedRecords.set(id, updated);
      return updated;
    });
  }

  const writes = [];
  if (state.indexDirty) writes.push(atomicWriteJson(importIndexFile(vaultPath), index));
  if (successfulIds.size) writes.push(atomicWriteJson(storeFile(app), { ...store, history }));
  await Promise.all(writes);
  if (successfulIds.size) broadcastHistory(BrowserWindow, history);

  for (const result of successfulResults) result.record = updatedRecords.get(String(result.recordId)) || null;
  timings.persistMs = Date.now() - stageAt;

  const results = requestedIds.map((id) => resultsById.get(id) || ({ recordId: id, ok: false, duplicate: false, error: '导入未完成。' }));
  const durationMs = Date.now() - startedAt;
  console.log('[ObsidianImportFast]', JSON.stringify({
    requested: requestedIds.length,
    success: results.filter((item) => item.ok).length,
    duplicate: results.filter((item) => item.duplicate).length,
    failure: results.filter((item) => !item.ok && !item.duplicate).length,
    notes: groups.size,
    durationMs,
    timings,
  }));

  return {
    ok: results.every((item) => item.ok || item.duplicate),
    successCount: results.filter((item) => item.ok).length,
    duplicateCount: results.filter((item) => item.duplicate).length,
    failureCount: results.filter((item) => !item.ok && !item.duplicate).length,
    durationMs,
    timings,
    templateName: template.name,
    results,
  };
}

function enqueueImport(task) {
  const queuedAt = Date.now();
  const run = importQueue.then(async () => {
    const result = await task();
    result.queueWaitMs = Date.now() - queuedAt - result.durationMs;
    return result;
  }, async () => {
    const result = await task();
    result.queueWaitMs = Date.now() - queuedAt - result.durationMs;
    return result;
  });
  importQueue = run.catch(() => {});
  return run;
}

async function saveOne(app, BrowserWindow, payload) {
  const batch = await enqueueImport(() => importRecordsFast(app, BrowserWindow, {
    ...payload,
    recordId: payload?.recordId || payload?.record?.id,
  }));
  const item = batch.results[0];
  if (!item?.ok) {
    const error = new Error(item?.error || '导入失败。');
    if (item?.duplicate) error.code = 'DUPLICATE_RECORD';
    throw error;
  }
  return {
    ok: true,
    path: item.path,
    relativePath: item.relativePath,
    templateName: batch.templateName,
    record: item.record,
    durationMs: batch.durationMs,
    timings: batch.timings,
    queueWaitMs: batch.queueWaitMs,
  };
}

function saveMany(app, BrowserWindow, payload) {
  return enqueueImport(() => importRecordsFast(app, BrowserWindow, payload));
}

let installed = false;

function install() {
  if (installed) return true;
  const { app, BrowserWindow, ipcMain } = require('electron');
  if (ipcMain.__jiaohuaFastObsidianImportInstalled) return true;
  ipcMain.__jiaohuaFastObsidianImportInstalled = true;
  const originalHandle = ipcMain.handle.bind(ipcMain);

  ipcMain.handle = function handleWithFastObsidianImport(channel, listener) {
    if (channel === 'obsidian:note:save') {
      return originalHandle(channel, (_event, payload) => saveOne(app, BrowserWindow, payload));
    }
    if (channel === 'obsidian:notes:save-many') {
      return originalHandle(channel, (_event, payload) => saveMany(app, BrowserWindow, payload));
    }
    return originalHandle(channel, listener);
  };

  installed = true;
  console.log('[ObsidianImportFast] registration interceptor installed');
  return true;
}

module.exports = {
  install,
  normalizeFastIndex,
  hasImportedFast,
  markImportedFast,
  hasMigratedPath,
  markMigratedPath,
  loadFaviconCache,
  attachCachedFavicon,
  importRecordsFast,
  saveOne,
  saveMany,
};
