'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { performance } = require('perf_hooks');
const {
  IMPORT_INDEX_RELATIVE_PATH,
  buildClipperContext,
  renderClipperTemplate,
  resolveTargetPath,
  extractRecordIds,
  stripRecordMarkers,
  normalizeImportIndex,
  hasImportedRecord,
  markImportedRecord,
} = require('./obsidian-clipper.cjs');

let importQueue = Promise.resolve();
const faviconLookupCache = new Map();
const faviconJobs = new Map();
const faviconPending = [];
let faviconActive = 0;
const MAX_FAVICON_CONCURRENCY = 3;

function enqueueImport(task) {
  const run = importQueue.then(task, task);
  importQueue = run.catch(() => {});
  return run;
}

function storeFile(app) {
  return path.join(app.getPath('userData'), 'data', 'store.json');
}

function importIndexFile(vaultPath) {
  return path.join(vaultPath, ...IMPORT_INDEX_RELATIVE_PATH.split('/'));
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

async function readStore(app) {
  return readJson(storeFile(app), null);
}

async function writeStore(app, store) {
  await writeJson(storeFile(app), store);
}

async function readImportIndex(vaultPath) {
  return normalizeImportIndex(await readJson(importIndexFile(vaultPath), null));
}

async function writeImportIndex(vaultPath, index) {
  await writeJson(importIndexFile(vaultPath), normalizeImportIndex(index));
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

function faviconRelativeFolder() {
  return path.join('AI划词', '_assets', 'favicons');
}

function faviconCacheKey(vaultPath, hostname) {
  return `${path.resolve(vaultPath)}\n${String(hostname || '').toLowerCase()}`;
}

async function findCachedFavicon(vaultPath, record) {
  const location = record?.sourceLocation;
  if (!vaultPath || !location?.hostname) return record;
  if (location.faviconVaultPath) return record;

  const key = faviconCacheKey(vaultPath, location.hostname);
  if (faviconLookupCache.has(key)) {
    const cached = faviconLookupCache.get(key);
    return cached
      ? { ...record, sourceLocation: { ...location, faviconVaultPath: cached } }
      : record;
  }

  const relativeFolder = faviconRelativeFolder();
  const folder = path.join(vaultPath, relativeFolder);
  const base = cleanHostFileName(location.hostname);
  let relativePath = '';
  try {
    const names = await fsp.readdir(folder);
    const existing = names.find((name) => name === base || name.startsWith(`${base}.`));
    if (existing) relativePath = `${relativeFolder.replace(/\\/g, '/')}/${existing}`;
  } catch (_) {}
  faviconLookupCache.set(key, relativePath);
  return relativePath
    ? { ...record, sourceLocation: { ...location, faviconVaultPath: relativePath } }
    : record;
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

async function downloadFavicon(vaultPath, record) {
  const location = record?.sourceLocation;
  if (!vaultPath || !location?.faviconUrl || !location?.hostname || location.faviconVaultPath) return '';
  const key = faviconCacheKey(vaultPath, location.hostname);
  const known = faviconLookupCache.get(key);
  if (known) return known;

  try {
    const response = await fetch(location.faviconUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(2500),
      headers: { 'User-Agent': 'JiaoHua-AI/1.0' },
    });
    if (!response.ok) return '';
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!/^image\/(png|jpe?g|webp|x-icon|vnd\.microsoft\.icon|ico)(?:;|$)/.test(contentType)) return '';
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > 256 * 1024) return '';
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > 256 * 1024) return '';

    const relativeFolder = faviconRelativeFolder();
    const folder = path.join(vaultPath, relativeFolder);
    await fsp.mkdir(folder, { recursive: true });
    const name = `${cleanHostFileName(location.hostname)}${extensionFromContentType(contentType, location.faviconUrl)}`;
    await fsp.writeFile(path.join(folder, name), buffer);
    const relativePath = `${relativeFolder.replace(/\\/g, '/')}/${name}`;
    faviconLookupCache.set(key, relativePath);
    return relativePath;
  } catch (_) {
    faviconLookupCache.set(key, '');
    return '';
  }
}

function runFaviconQueue() {
  while (faviconActive < MAX_FAVICON_CONCURRENCY && faviconPending.length) {
    const job = faviconPending.shift();
    faviconActive += 1;
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        faviconActive -= 1;
        runFaviconQueue();
      });
  }
}

function enqueueFaviconTask(key, task) {
  if (faviconJobs.has(key)) return faviconJobs.get(key);
  const promise = new Promise((resolve, reject) => {
    faviconPending.push({ task, resolve, reject });
    runFaviconQueue();
  }).finally(() => faviconJobs.delete(key));
  faviconJobs.set(key, promise);
  return promise;
}

function scheduleFaviconCache(app, BrowserWindow, vaultPath, records) {
  const grouped = new Map();
  for (const record of records) {
    const location = record?.sourceLocation;
    if (!location?.faviconUrl || !location?.hostname || location.faviconVaultPath) continue;
    const key = faviconCacheKey(vaultPath, location.hostname);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(record);
  }

  for (const [key, hostRecords] of grouped) {
    const seed = hostRecords[0];
    void enqueueFaviconTask(key, async () => {
      const relativePath = await downloadFavicon(vaultPath, seed);
      if (!relativePath) return;
      await enqueueImport(async () => {
        const store = await readStore(app);
        if (!store || !Array.isArray(store.history)) return;
        const ids = new Set(hostRecords.map((item) => String(item.id || '')));
        let changed = false;
        const history = store.history.map((item) => {
          if (!ids.has(String(item?.id || '')) || item?.sourceLocation?.faviconVaultPath) return item;
          changed = true;
          return {
            ...item,
            sourceLocation: { ...item.sourceLocation, faviconVaultPath: relativePath },
          };
        });
        if (!changed) return;
        await writeStore(app, { ...store, history });
        broadcastHistory(BrowserWindow, history);
      });
    });
  }
}

function findRecord(store, recordInput) {
  if (recordInput && typeof recordInput === 'object' && recordInput.id) {
    const persisted = store.history?.find((item) => String(item.id) === String(recordInput.id));
    return persisted
      ? { ...recordInput, ...persisted, sourceLocation: persisted.sourceLocation || recordInput.sourceLocation }
      : recordInput;
  }
  return store.history?.find((item) => String(item.id) === String(recordInput));
}

function duplicateResult(recordId) {
  return {
    recordId: String(recordId || ''),
    ok: false,
    duplicate: true,
    error: '该记录已经导入 Obsidian。',
  };
}

function failureResult(recordId, error) {
  return {
    recordId: String(recordId || ''),
    ok: false,
    duplicate: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

async function readText(file) {
  try { return await fsp.readFile(file, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

async function writeTargetGroup(group, index, metrics) {
  const { target, relativePath, behavior, entries } = group;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const rawExisting = await readText(target);
  metrics.targetReadCount += 1;

  const markerIds = extractRecordIds(rawExisting);
  let nextIndex = index;
  for (const id of markerIds) nextIndex = markImportedRecord(nextIndex, id, relativePath);
  const existing = stripRecordMarkers(rawExisting);

  const accepted = [];
  const results = [];
  for (const entry of entries) {
    if (hasImportedRecord(nextIndex, entry.record.id)) {
      results.push(duplicateResult(entry.record.id));
      continue;
    }
    try {
      accepted.push({ ...entry, markdown: renderClipperTemplate(entry.template, entry.record) });
    } catch (error) {
      results.push(failureResult(entry.record.id, error));
    }
  }

  if (!accepted.length) {
    if (existing !== rawExisting) {
      await fsp.writeFile(target, existing, 'utf8');
      metrics.targetWriteCount += 1;
      metrics.targetRewriteCount += 1;
    }
    return { index: nextIndex, results, accepted: [] };
  }

  const block = accepted.map((entry) => entry.markdown).join('\n\n');
  if (behavior === 'append_to_existing_note_top') {
    const separator = existing.trim() ? '\n\n' : '';
    await fsp.writeFile(target, `${block}${separator}${existing}\n`, 'utf8');
    metrics.targetWriteCount += 1;
    metrics.targetRewriteCount += 1;
  } else if (existing !== rawExisting) {
    const separator = existing.trim() ? '\n\n' : '';
    await fsp.writeFile(target, `${existing}${separator}${block}\n`, 'utf8');
    metrics.targetWriteCount += 1;
    metrics.targetRewriteCount += 1;
  } else if (rawExisting.trim()) {
    await fsp.appendFile(target, `\n\n${block}\n`, 'utf8');
    metrics.targetWriteCount += 1;
    metrics.targetAppendCount += 1;
  } else {
    await fsp.writeFile(target, `${block}\n`, 'utf8');
    metrics.targetWriteCount += 1;
  }

  for (const entry of accepted) {
    nextIndex = markImportedRecord(nextIndex, entry.record.id, relativePath);
    results.push({ recordId: String(entry.record.id), ok: true, path: target, relativePath });
  }
  return { index: nextIndex, results, accepted };
}

async function importTransaction(app, BrowserWindow, payload, options = {}) {
  const startedAt = performance.now();
  const metrics = {
    storeReadCount: 1,
    storeWriteCount: 0,
    indexReadCount: 1,
    indexWriteCount: 0,
    targetReadCount: 0,
    targetWriteCount: 0,
    targetAppendCount: 0,
    targetRewriteCount: 0,
    targetGroupCount: 0,
    durationMs: 0,
  };

  const request = payload || {};
  const rawIds = Array.isArray(request.recordIds)
    ? request.recordIds
    : [request.record || request.recordId];
  const ids = [...new Set(rawIds.map((item) => (item && typeof item === 'object' ? item.id : item)).filter(Boolean).map(String))];
  if (!ids.length) throw new Error('没有选择历史记录。');

  const store = await readStore(app);
  if (!store) throw new Error('无法读取本地历史数据。');
  const template = (store.obsidianTemplates || []).find((item) => item.id === request.templateId);
  if (!template) throw new Error('没有找到这个模板。');
  const vaultPath = String(store.settings?.obsidian?.vaultPath || '').trim();
  if (!vaultPath) throw new Error('还没有设置 Obsidian vault 路径。');

  let index = await readImportIndex(vaultPath);
  const resultsById = new Map();
  const groups = new Map();
  const preparedRecords = [];

  for (const id of ids) {
    try {
      const input = Array.isArray(request.recordIds) ? id : (request.record || id);
      let record = findRecord(store, input);
      if (!record) {
        resultsById.set(id, failureResult(id, '没有找到这条历史记录。'));
        continue;
      }
      if (typeof options.enrichRecord === 'function') record = options.enrichRecord(record) || record;
      if (record.savedToObsidian || hasImportedRecord(index, record.id)) {
        resultsById.set(id, duplicateResult(id));
        continue;
      }

      record = await findCachedFavicon(vaultPath, record);
      const context = buildClipperContext(record);
      const resolved = resolveTargetPath(vaultPath, template, context);
      const groupKey = path.resolve(resolved.target);
      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          target: resolved.target,
          relativePath: resolved.relativePath,
          behavior: template.saveBehavior,
          entries: [],
        });
      }
      groups.get(groupKey).entries.push({ record, template });
      preparedRecords.push(record);
    } catch (error) {
      resultsById.set(id, failureResult(id, error));
    }
  }

  metrics.targetGroupCount = groups.size;
  const successful = [];
  for (const group of groups.values()) {
    try {
      const outcome = await writeTargetGroup(group, index, metrics);
      index = outcome.index;
      for (const result of outcome.results) resultsById.set(String(result.recordId), result);
      for (const entry of outcome.accepted) successful.push({ record: entry.record, path: group.target });
    } catch (error) {
      for (const entry of group.entries) {
        resultsById.set(String(entry.record.id), failureResult(entry.record.id, error));
      }
    }
  }

  if (successful.length || Object.keys(index.records || {}).length) {
    await writeImportIndex(vaultPath, index);
    metrics.indexWriteCount += 1;
  }

  if (successful.length) {
    const updates = new Map(successful.map((item) => [String(item.record.id), item]));
    const history = Array.isArray(store.history) ? store.history.map((item) => {
      const update = updates.get(String(item?.id || ''));
      if (!update) return item;
      return {
        ...item,
        sourceLocation: update.record.sourceLocation || item.sourceLocation,
        savedToObsidian: true,
        obsidianPath: update.path,
      };
    }) : [];
    await writeStore(app, { ...store, history });
    metrics.storeWriteCount += 1;
    broadcastHistory(BrowserWindow, history);
  }

  const results = ids.map((id) => resultsById.get(id) || failureResult(id, '导入状态未知。'));
  metrics.durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
  console.log(`[ObsidianImport] ${ids.length} record(s), ${groups.size} file(s), ${metrics.durationMs}ms`, metrics);

  if (options.scheduleFavicons !== false && successful.length) {
    scheduleFaviconCache(app, BrowserWindow, vaultPath, successful.map((item) => item.record));
  }

  return {
    ok: results.every((item) => item.ok || item.duplicate),
    successCount: results.filter((item) => item.ok).length,
    duplicateCount: results.filter((item) => item.duplicate).length,
    failureCount: results.filter((item) => !item.ok && !item.duplicate).length,
    results,
    metrics,
  };
}

function saveManyClipsFast(app, BrowserWindow, payload, options = {}) {
  return enqueueImport(() => importTransaction(app, BrowserWindow, payload, options));
}

async function saveClipToObsidianFast(app, BrowserWindow, payload, options = {}) {
  const result = await enqueueImport(() => importTransaction(app, BrowserWindow, payload, options));
  const item = result.results[0];
  if (!item?.ok) {
    const error = new Error(item?.error || '导入 Obsidian 失败。');
    if (item?.duplicate) error.code = 'DUPLICATE_RECORD';
    throw error;
  }
  return {
    ok: true,
    path: item.path,
    relativePath: item.relativePath,
    metrics: result.metrics,
  };
}

module.exports = {
  enqueueImport,
  readStore,
  writeStore,
  readImportIndex,
  writeImportIndex,
  findCachedFavicon,
  writeTargetGroup,
  importTransaction,
  saveClipToObsidianFast,
  saveManyClipsFast,
};
