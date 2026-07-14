'use strict';

const fs = require('fs');
const path = require('path');
const { ensureClipperTemplate } = require('./obsidian-clipper.cjs');

let installed = false;

function install() {
  if (installed) return;
  installed = true;
  const { app, ipcMain } = require('electron');
  const registerHandler = ipcMain.handle.bind(ipcMain);

  function storeFile() {
    return path.join(app.getPath('userData'), 'data', 'store.json');
  }

  function persistFromInitialData(data, templates) {
    const file = storeFile();
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
    const next = {
      ...(existing || {}),
      settings: data.settings,
      skills: data.skills,
      history: data.history,
      conversations: data.conversations,
      activeConversationId: data.activeConversationId,
      obsidianTemplates: templates,
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  }

  ipcMain.handle = function handleWithClipperInitialData(channel, listener) {
    if (channel === 'app:get-initial-data') {
      return registerHandler(channel, async (...args) => {
        const data = await listener(...args);
        const result = ensureClipperTemplate({ ...data, obsidianTemplates: data?.obsidianTemplates || [] });
        if (!result.changed) return data;
        const templates = result.store.obsidianTemplates;
        persistFromInitialData(data, templates);
        console.log('[SourceClipper] persisted compact template on first data load');
        return { ...data, obsidianTemplates: templates };
      });
    }
    return registerHandler(channel, listener);
  };

  console.log('[SourceClipper] initial-data runtime installed');
}

module.exports = { install };
