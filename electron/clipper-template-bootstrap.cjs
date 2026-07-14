'use strict';

const fs = require('fs');
const path = require('path');
const {
  IMPORT_INDEX_RELATIVE_PATH,
  ensureClipperTemplate,
  extractRecordIds,
  stripRecordMarkers,
  normalizeImportIndex,
  markImportedRecord,
} = require('./obsidian-clipper.cjs');

let installed = false;

function indexFile(vaultPath) {
  return path.join(vaultPath, ...IMPORT_INDEX_RELATIVE_PATH.split('/'));
}

function readIndex(vaultPath) {
  try {
    return normalizeImportIndex(JSON.parse(fs.readFileSync(indexFile(vaultPath), 'utf8')));
  } catch (_) {
    return normalizeImportIndex(null);
  }
}

function writeIndex(vaultPath, index) {
  const file = indexFile(vaultPath);
  const temporary = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify(normalizeImportIndex(index), null, 2), 'utf8');
  fs.renameSync(temporary, file);
}

function relativeVaultPath(vaultPath, file) {
  const relative = path.relative(path.resolve(vaultPath), path.resolve(file));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
  return relative.replace(/\\/g, '/');
}

function migrateExistingNotes(store) {
  const vaultPath = String(store?.settings?.obsidian?.vaultPath || '').trim();
  if (!vaultPath) return { changedNotes: 0, indexedRecords: 0 };

  const records = Array.isArray(store?.history) ? store.history : [];
  const files = new Set();
  let index = readIndex(vaultPath);
  const beforeCount = Object.keys(index.records).length;

  for (const record of records) {
    if (record?.obsidianPath) files.add(path.resolve(String(record.obsidianPath)));
    if (record?.savedToObsidian && record?.id) {
      index = markImportedRecord(index, record.id, record.obsidianPath ? relativeVaultPath(vaultPath, record.obsidianPath) : '');
    }
  }

  let changedNotes = 0;
  for (const file of files) {
    try {
      if (!fs.existsSync(file) || path.extname(file).toLowerCase() !== '.md') continue;
      const before = fs.readFileSync(file, 'utf8');
      const ids = extractRecordIds(before);
      const relative = relativeVaultPath(vaultPath, file);
      for (const id of ids) index = markImportedRecord(index, id, relative);
      const after = stripRecordMarkers(before);
      if (after === before) continue;
      fs.writeFileSync(file, after, 'utf8');
      changedNotes += 1;
    } catch (error) {
      console.warn('[SourceClipper] note marker cleanup skipped', file, error?.message || error);
    }
  }

  const indexedRecords = Object.keys(index.records).length;
  if (indexedRecords !== beforeCount || changedNotes > 0) writeIndex(vaultPath, index);
  return { changedNotes, indexedRecords: Math.max(0, indexedRecords - beforeCount) };
}

function install() {
  if (installed) return;
  installed = true;
  const { app } = require('electron');

  function prepare() {
    const file = path.join(app.getPath('userData'), 'data', 'store.json');
    try {
      if (!fs.existsSync(file)) return false;
      const store = JSON.parse(fs.readFileSync(file, 'utf8'));
      const result = ensureClipperTemplate(store);
      if (result.changed) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(result.store, null, 2), 'utf8');
        console.log('[SourceClipper] updated template installation state');
      }
      const migration = migrateExistingNotes(result.store || store);
      if (migration.changedNotes > 0) {
        console.log(`[SourceClipper] removed visible markers from ${migration.changedNotes} Obsidian note(s)`);
      }
      if (migration.indexedRecords > 0) {
        console.log(`[SourceClipper] indexed ${migration.indexedRecords} existing Obsidian import(s)`);
      }
      return result.changed || migration.changedNotes > 0 || migration.indexedRecords > 0;
    } catch (error) {
      console.warn('[SourceClipper] template and note migration failed', error?.message || error);
      return false;
    }
  }

  app.whenReady().then(() => {
    setTimeout(prepare, 600);
  });
}

module.exports = { migrateExistingNotes, install };