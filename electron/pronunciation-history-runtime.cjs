'use strict';

const fs = require('fs');
const path = require('path');

let installed = false;

function pickConversationId(store) {
  if (!store || typeof store !== 'object') return '';
  const active = String(store.activeConversationId || '').trim();
  if (active) return active;
  const first = Array.isArray(store.conversations) ? store.conversations[0] : null;
  return String(first?.id || '').trim();
}

function migratePronunciationHistory(store) {
  if (!store || typeof store !== 'object' || !Array.isArray(store.history)) {
    return { store, changed: false, count: 0 };
  }

  const conversationId = pickConversationId(store);
  if (!conversationId) return { store, changed: false, count: 0 };

  let count = 0;
  const history = store.history.map((record) => {
    if (!record || !record.pronunciationData || String(record.conversationId || '').trim()) {
      return record;
    }
    count += 1;
    return { ...record, conversationId };
  });

  return {
    store: count > 0 ? { ...store, history } : store,
    changed: count > 0,
    count,
  };
}

function patchPronunciationRecord(store, record) {
  if (!store || typeof store !== 'object' || !record || !record.pronunciationData) {
    return { store, record, changed: false, found: false };
  }

  const conversationId = String(record.conversationId || '').trim() || pickConversationId(store);
  const patchedRecord = conversationId ? { ...record, conversationId } : record;
  const history = Array.isArray(store.history) ? store.history : [];
  let found = false;
  let changed = false;

  const nextHistory = history.map((item) => {
    if (!item || String(item.id || '') !== String(record.id || '')) return item;
    found = true;
    const currentConversationId = String(item.conversationId || '').trim();
    if (currentConversationId || !conversationId) return item;
    changed = true;
    return { ...item, conversationId };
  });

  return {
    store: changed ? { ...store, history: nextHistory } : store,
    record: patchedRecord,
    changed,
    found,
  };
}

function install() {
  if (installed) return;
  installed = true;

  const { app, BrowserWindow, ipcMain } = require('electron');
  const registerHandler = ipcMain.handle.bind(ipcMain);

  function storeFile() {
    return path.join(app.getPath('userData'), 'data', 'store.json');
  }

  function readStore() {
    try {
      return JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    } catch (_) {
      return null;
    }
  }

  function writeStore(store) {
    const file = storeFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(store, null, 2), 'utf8');
  }

  function routeFromUrl(url) {
    try {
      return new URL(String(url || '')).searchParams.get('route') || 'main';
    } catch (_) {
      return 'main';
    }
  }

  function broadcastHistory(history) {
    if (!Array.isArray(history)) return;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win || win.isDestroyed()) continue;
      const route = routeFromUrl(win.webContents.getURL());
      if (route !== 'main') continue;
      try {
        win.webContents.send('history:changed', history);
      } catch (error) {
        console.error('[PronunciationHistory] history broadcast failed', error);
      }
    }
  }

  function migrateDiskStore() {
    const store = readStore();
    if (!store) return { changed: false, count: 0, store: null };
    const migrated = migratePronunciationHistory(store);
    if (migrated.changed) {
      writeStore(migrated.store);
      console.log('[PronunciationHistory] migrated orphan records=' + migrated.count);
    }
    return migrated;
  }

  ipcMain.handle = function handleWithPronunciationHistory(channel, listener) {
    if (channel === 'app:get-initial-data') {
      return registerHandler(channel, async (...args) => {
        const data = await listener(...args);
        const migratedData = migratePronunciationHistory(data);
        if (migratedData.changed) {
          const diskMigration = migrateDiskStore();
          const history = diskMigration.store?.history || migratedData.store.history;
          return { ...migratedData.store, history };
        }
        return data;
      });
    }

    if (channel === 'skill:run') {
      return registerHandler(channel, async (...args) => {
        const result = await listener(...args);
        if (!result || !result.id) return result;

        let store = readStore();
        if (!store || !Array.isArray(store.history)) return result;

        let nextResult = result;
        if (result.pronunciationData) {
          const patched = patchPronunciationRecord(store, result);
          store = patched.store;
          nextResult = patched.record;
          if (patched.changed) writeStore(store);
        }

        const persisted = store.history.some((item) => String(item?.id || '') === String(result.id));
        if (persisted) broadcastHistory(store.history);
        return nextResult;
      });
    }

    return registerHandler(channel, listener);
  };

  app.whenReady().then(() => {
    try {
      migrateDiskStore();
    } catch (error) {
      console.error('[PronunciationHistory] startup migration failed', error);
    }
  });

  console.log('[PronunciationHistory] installed');
}

module.exports = {
  pickConversationId,
  migratePronunciationHistory,
  patchPronunciationRecord,
  install,
};
