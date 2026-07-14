'use strict';

const fs = require('fs');
const path = require('path');
const {
  ensureClipperTemplate,
  migrateLegacyRecordMarkers,
} = require('./obsidian-clipper.cjs');

let installed = false;

function migrateExistingNotes(store) {
  const files = new Set();
  for (const record of Array.isArray(store?.history) ? store.history : []) {
    if (record?.obsidianPath) files.add(path.resolve(String(record.obsidianPath)));
  }

  let changedCount = 0;
  for (const file of files) {
    try {
      if (!fs.existsSync(file) || path.extname(file).toLowerCase() !== '.md') continue;
      const before = fs.readFileSync(file, 'utf8');
      const after = migrateLegacyRecordMarkers(before);
      if (after === before) continue;
      fs.writeFileSync(file, after, 'utf8');
      changedCount += 1;
    } catch (error) {
      console.warn('[SourceClipper] legacy note marker migration skipped', file, error?.message || error);
    }
  }
  return changedCount;
}

function install() {
  if (installed) return;
  installed = true;
  const { app } = require('electron');

  function ensure() {
    const file = path.join(app.getPath('userData'), 'data', 'store.json');
    try {
      if (!fs.existsSync(file)) return false;
      const store = JSON.parse(fs.readFileSync(file, 'utf8'));
      const result = ensureClipperTemplate(store);
      if (result.changed) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(result.store, null, 2), 'utf8');
        console.log('[SourceClipper] ensured compact template after migration');
      }
      const migratedNotes = migrateExistingNotes(result.store || store);
      if (migratedNotes > 0) console.log(`[SourceClipper] migrated legacy markers in ${migratedNotes} Obsidian note(s)`);
      return result.changed || migratedNotes > 0;
    } catch (error) {
      console.warn('[SourceClipper] template post-migration check failed', error?.message || error);
      return false;
    }
  }

  app.whenReady().then(() => {
    setTimeout(ensure, 250);
    setTimeout(ensure, 1800);
  });
}

module.exports = { migrateExistingNotes, install };