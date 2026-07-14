'use strict';

const fs = require('fs');
const path = require('path');
const { ensureClipperTemplate } = require('./obsidian-clipper.cjs');

let installed = false;

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
      if (!result.changed) return false;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(result.store, null, 2), 'utf8');
      console.log('[SourceClipper] ensured compact template after migration');
      return true;
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

module.exports = { install };
