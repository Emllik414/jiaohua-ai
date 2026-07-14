'use strict';

const { attachRecordLinks } = require('./source-location.cjs');
const sourceRuntime = require('./source-obsidian-runtime.cjs');
const {
  saveClipToObsidianFast,
  saveManyClipsFast,
} = require('./obsidian-import-engine.cjs');

let installed = false;
let handlersInstalled = false;

function enrichRecord(record) {
  if (!record || record.sourceLocation) return record;
  const snapshot = sourceRuntime.sourceSnapshotForSelection(record.selectedText, { allowLatest: true });
  return snapshot ? attachRecordLinks(record, snapshot) : record;
}

function install() {
  if (installed) return;
  installed = true;

  const { app, BrowserWindow, ipcMain } = require('electron');
  const rawHandle = ipcMain.__jiaohuaRawHandle;
  if (typeof rawHandle !== 'function') {
    console.error('[ObsidianImportPerformance] raw IPC handler is unavailable');
    return;
  }

  const replaceHandlers = () => {
    if (handlersInstalled) return;
    handlersInstalled = true;

    ipcMain.removeHandler('obsidian:note:save');
    rawHandle('obsidian:note:save', (_event, payload) => saveClipToObsidianFast(
      app,
      BrowserWindow,
      payload,
      { enrichRecord },
    ));

    ipcMain.removeHandler('obsidian:notes:save-many');
    rawHandle('obsidian:notes:save-many', (_event, payload) => saveManyClipsFast(
      app,
      BrowserWindow,
      payload,
      { enrichRecord },
    ));

    console.log('[ObsidianImportPerformance] fast handlers installed');
  };

  app.whenReady().then(() => setImmediate(replaceHandlers));
}

module.exports = { install, enrichRecord };
