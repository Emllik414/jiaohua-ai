'use strict';

const fs = require('fs');
const path = require('path');

let installed = false;

function normalizeWord(value) {
  return String(value || '').trim().toLowerCase();
}

function parseDictionaryPayload(payload) {
  if (!Array.isArray(payload) || payload.length === 0) return { us_ipa: '', gb_ipa: '' };
  const entry = payload[0] || {};
  let usIpa = '';
  let gbIpa = '';
  for (const phonetic of entry.phonetics || []) {
    const audio = String(phonetic?.audio || '').toLowerCase();
    const text = String(phonetic?.text || '').trim();
    if (!usIpa && text && (audio.includes('-us') || audio.includes('_us'))) usIpa = text;
    if (!gbIpa && text && (audio.includes('-uk') || audio.includes('_uk') || audio.includes('-gb'))) gbIpa = text;
  }
  for (const phonetic of entry.phonetics || []) {
    const audio = String(phonetic?.audio || '').toLowerCase();
    const text = String(phonetic?.text || '').trim();
    if (!usIpa && text && !audio.includes('-uk') && !audio.includes('_uk') && !audio.includes('-gb')) usIpa = text;
    if (!gbIpa && text && (audio.includes('-uk') || audio.includes('_uk') || audio.includes('-gb'))) gbIpa = text;
  }
  return { us_ipa: usIpa, gb_ipa: gbIpa };
}

function mergePronunciationData(current, ipa) {
  const base = current && typeof current === 'object' ? current : {};
  const next = ipa && typeof ipa === 'object' ? ipa : {};
  return {
    ...base,
    us_ipa: String(next.us_ipa || base.us_ipa || ''),
    gb_ipa: String(next.gb_ipa || base.gb_ipa || ''),
  };
}

function dictionaryWordFromUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.hostname !== 'api.dictionaryapi.dev') return '';
    const marker = '/api/v2/entries/en/';
    const index = url.pathname.indexOf(marker);
    if (index < 0) return '';
    return decodeURIComponent(url.pathname.slice(index + marker.length));
  } catch (_) {
    return '';
  }
}

function install() {
  if (installed) return;
  installed = true;

  const { app, BrowserWindow } = require('electron');
  const originalFetch = global.fetch.bind(global);
  const lookups = new Map();
  const sessions = new Map();
  const attached = new WeakSet();

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

  function broadcastHistory(history) {
    if (!Array.isArray(history)) return;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win || win.isDestroyed()) continue;
      try { win.webContents.send('history:changed', history); } catch (_) {}
    }
  }

  function persistIpa(recordId, ipa) {
    if (!recordId || (!ipa?.us_ipa && !ipa?.gb_ipa)) return false;
    const store = readStore();
    if (!store || !Array.isArray(store.history)) return false;
    let changed = false;
    store.history = store.history.map((record) => {
      if (!record || String(record.id || '') !== String(recordId)) return record;
      const merged = mergePronunciationData(record.pronunciationData, ipa);
      if (
        merged.us_ipa === String(record.pronunciationData?.us_ipa || '') &&
        merged.gb_ipa === String(record.pronunciationData?.gb_ipa || '')
      ) return record;
      changed = true;
      return { ...record, pronunciationData: merged };
    });
    if (changed) {
      writeStore(store);
      broadcastHistory(store.history);
    }
    return changed;
  }

  function startLookup(word) {
    const key = normalizeWord(word);
    if (!key) return Promise.resolve({ us_ipa: '', gb_ipa: '' });
    if (lookups.has(key)) return lookups.get(key);

    const promise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      try {
        const response = await originalFetch(
          `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.trim())}`,
          { signal: controller.signal },
        );
        if (!response.ok) return { us_ipa: '', gb_ipa: '' };
        return parseDictionaryPayload(await response.json());
      } catch (_) {
        return { us_ipa: '', gb_ipa: '' };
      } finally {
        clearTimeout(timer);
      }
    })();

    lookups.set(key, promise);
    promise.finally(() => {
      setTimeout(() => lookups.delete(key), 30000);
    });
    return promise;
  }

  global.fetch = async function pronunciationAwareFetch(input, init) {
    const url = typeof input === 'string' ? input : String(input?.url || '');
    const word = dictionaryWordFromUrl(url);
    if (!word) return originalFetch(input, init);

    void startLookup(word);
    if (typeof Response === 'function') {
      return new Response('[]', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return {
      ok: true,
      status: 200,
      json: async () => [],
      text: async () => '[]',
    };
  };

  function attach(win) {
    if (!win || win.isDestroyed() || attached.has(win)) return;
    attached.add(win);
    const originalSend = win.webContents.send.bind(win.webContents);

    async function enrich(session) {
      const ipa = await startLookup(session.text);
      const current = sessions.get(win.id);
      if (!current || current.runId !== session.runId || current.recordId !== session.recordId) return;
      if (!ipa.us_ipa && !ipa.gb_ipa) return;

      current.ipa = ipa;
      current.record = {
        ...current.record,
        pronunciationData: mergePronunciationData(current.record.pronunciationData, ipa),
      };
      if (!win.isDestroyed()) originalSend('result:update', current.record);
      if (current.record.status === 'completed' || current.record.status === 'failed') {
        persistIpa(current.recordId, ipa);
      }
    }

    win.webContents.send = function sendWithPronunciationLive(channel, payload, ...rest) {
      let nextPayload = payload;

      if (channel === 'result:ready' && payload?.pronunciationData) {
        const session = {
          runId: String(payload.runId || ''),
          recordId: String(payload.id || ''),
          text: String(payload.pronunciationData.text || payload.selectedText || ''),
          ipa: { us_ipa: '', gb_ipa: '' },
          record: payload,
        };
        sessions.set(win.id, session);
        void enrich(session);
      } else if (channel === 'result:update' && payload?.pronunciationData) {
        const session = sessions.get(win.id);
        if (session && (!session.runId || !payload.runId || session.runId === String(payload.runId))) {
          nextPayload = {
            ...payload,
            pronunciationData: mergePronunciationData(payload.pronunciationData, session.ipa),
          };
          session.record = nextPayload;
          session.recordId = String(nextPayload.id || session.recordId || '');
          if (nextPayload.status === 'completed' || nextPayload.status === 'failed') {
            persistIpa(session.recordId, session.ipa);
          }
        }
      } else if (channel === 'result:reset') {
        sessions.delete(win.id);
      }

      return originalSend(channel, nextPayload, ...rest);
    };

    win.once('closed', () => sessions.delete(win.id));
  }

  app.on('browser-window-created', (_event, win) => attach(win));
  for (const win of BrowserWindow.getAllWindows()) attach(win);

  app.once('before-quit', () => {
    global.fetch = originalFetch;
  });

  console.log('[PronunciationLive] installed');
}

module.exports = {
  normalizeWord,
  parseDictionaryPayload,
  mergePronunciationData,
  dictionaryWordFromUrl,
  install,
};
