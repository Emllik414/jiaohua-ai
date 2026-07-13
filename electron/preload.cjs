const { contextBridge, ipcRenderer } = require('electron');

const skillShortcutDialog = require('./skill-shortcut-dialog-bridge.cjs').install({ ipcRenderer });

contextBridge.exposeInMainWorld('desktopApi', {
  getInitialData: () => ipcRenderer.invoke('app:get-initial-data'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  saveSkill: (skill) => ipcRenderer.invoke('skills:save', skill),
  reorderSkills: (skillIds) => ipcRenderer.invoke('skills:reorder', skillIds),
  deleteSkill: (skillId) => ipcRenderer.invoke('skills:delete', skillId),
  validateSkillShortcut: (skillId, shortcut) => ipcRenderer.invoke('skill-shortcuts:validate', { skillId, shortcut }),
  setSkillShortcut: (skillId, shortcut) => ipcRenderer.invoke('skill-shortcuts:set', { skillId, shortcut }),
  clearSkillShortcut: (skillId) => ipcRenderer.invoke('skill-shortcuts:clear', { skillId }),
  getSkillShortcutState: () => ipcRenderer.invoke('skill-shortcuts:get-state'),
  openSkillShortcutDialog: (skillId) => skillShortcutDialog.open(skillId),
  runSkill: (skillId, selection) => ipcRenderer.invoke('skill:run', { skillId, selection }),
  copyText: (text, options) => ipcRenderer.invoke('clipboard:write', { text, options }),

  /* ───── 对话管理 ───── */
  getConversations: () => ipcRenderer.invoke('conversations:list'),
  createConversation: (title) => ipcRenderer.invoke('conversations:create', title),
  renameConversation: (id, title) => ipcRenderer.invoke('conversations:rename', { id, title }),
  deleteConversation: (id, deleteRecords) => ipcRenderer.invoke('conversations:delete', { id, deleteRecords }),
  pinConversation: (id) => ipcRenderer.invoke('conversations:pin', id),
  setActiveConversation: (id) => ipcRenderer.invoke('conversations:set-active', id),

  /* ───── Obsidian 模板系统 ───── */
  getObsidianTemplates: () => ipcRenderer.invoke('obsidian:templates:list'),
  saveObsidianTemplate: (template) => ipcRenderer.invoke('obsidian:templates:save', template),
  deleteObsidianTemplate: (templateId) => ipcRenderer.invoke('obsidian:templates:delete', templateId),
  previewObsidianTemplate: (templateId, recordId, record) => ipcRenderer.invoke('obsidian:template:preview', { templateId, recordId, record }),
  saveToObsidianNote: (templateId, recordId, record) => ipcRenderer.invoke('obsidian:note:save', { templateId, recordId, record }),
  saveManyToObsidian: (templateId, recordIds) => ipcRenderer.invoke('obsidian:notes:save-many', { templateId, recordIds }),
  listVaultNotes: () => ipcRenderer.invoke('obsidian:vault:list-notes'),
  checkVaultPath: (relativePath) => ipcRenderer.invoke('obsidian:vault:check-path', relativePath),

  deleteHistory: (recordIds) => ipcRenderer.invoke('history:delete', recordIds),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  chooseHistoryExportDirectory: () => ipcRenderer.invoke('history-export:choose-directory'),
  exportHistory: (options) => ipcRenderer.invoke('history-export:write', options),
  speak: (text, options) => ipcRenderer.invoke('tts:speak', text, options),
  stopSpeak: () => ipcRenderer.invoke('tts:stop'),
  onTtsState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('tts:state', listener);
    return () => ipcRenderer.removeListener('tts:state', listener);
  },
  showMain: () => ipcRenderer.invoke('window:show-main'),
  closeCurrent: () => ipcRenderer.invoke('window:close-current'),
  rendererLog: (msg) => ipcRenderer.send('renderer-log', msg),
  setAppearance: (mode) => ipcRenderer.invoke('appearance:set', mode),
  onAppearanceChanged: (callback) => {
    const listener = (_event, mode) => callback(mode);
    ipcRenderer.on('appearance:changed', listener);
    return () => ipcRenderer.removeListener('appearance:changed', listener);
  },
  hideToolbar: () => ipcRenderer.invoke('toolbar:hide'),
  resizeToolbar: (expanded) => ipcRenderer.invoke('toolbar:resize', expanded),
  toggleToolbarMore: (anchor) => ipcRenderer.invoke('toolbar-more:toggle', anchor),
  hideToolbarMore: () => ipcRenderer.invoke('toolbar-more:hide'),
  getToolbarBounds: () => ipcRenderer.invoke('toolbar:get-bounds'),
  setToolbarSize: (size) => ipcRenderer.invoke('toolbar:set-size', size),
  setToolbarPosition: (pos) => ipcRenderer.invoke('toolbar:set-position', pos),
  setToolbarPointerInside: (inside) => ipcRenderer.invoke('toolbar:pointer-inside', inside),
  setToolbarMorePointerInside: (inside) => ipcRenderer.invoke('toolbar-more:pointer-inside', inside),
  setResultPointerInside: (inside) => ipcRenderer.invoke('result:pointer-inside', inside),
  lockResultInteraction: (duration) => ipcRenderer.invoke('result:interaction', duration),
  setResultState: (state) => ipcRenderer.invoke('result:set-state', state),
  closeResult: (reason) => ipcRenderer.invoke('result:close', reason),
  getResultBounds: () => ipcRenderer.invoke('result:get-bounds'),
  setResultPosition: (pos) => ipcRenderer.invoke('result:set-position', pos),
  resizeResult: (height) => ipcRenderer.invoke('result:resize', height),
  resizeResultBox: (size) => ipcRenderer.invoke('result:resize-box', size),
  onSelectionReady: (callback) => {
    // callback receives { pickedInfo: PickedInfo, selection: string, skills: Skill[] }
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('selection:ready', listener);
    return () => ipcRenderer.removeListener('selection:ready', listener);
  },
  onResultReady: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('result:ready', listener);
    return () => ipcRenderer.removeListener('result:ready', listener);
  },
  onResultUpdate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('result:update', listener);
    return () => ipcRenderer.removeListener('result:update', listener);
  },
  onResultReset: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('result:reset', listener);
    return () => ipcRenderer.removeListener('result:reset', listener);
  },
  onHistoryChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('history:changed', listener);
    return () => ipcRenderer.removeListener('history:changed', listener);
  },
  onConfirmSelection: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('result:confirm-selection', listener);
    return () => ipcRenderer.removeListener('result:confirm-selection', listener);
  },
  onToolbarShow: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('toolbar:show', listener);
    return () => ipcRenderer.removeListener('toolbar:show', listener);
  },
  onToolbarHide: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('toolbar:hide', listener);
    return () => ipcRenderer.removeListener('toolbar:hide', listener);
  },
  onToolbarMoreState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('toolbar-more:state', listener);
    return () => ipcRenderer.removeListener('toolbar-more:state', listener);
  },
  onSkillsUpdated: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('skills:updated', listener);
    return () => ipcRenderer.removeListener('skills:updated', listener);
  },
  confirmSelection: (skillId, selectedText) => ipcRenderer.invoke('result:confirm-selection-action', { skillId, selectedText }),
  cancelSelection: () => ipcRenderer.invoke('result:cancel-selection'),

  /* ───── 快捷键配置 ───── */
  getHotkeyConfig: () => ipcRenderer.invoke('hotkey:get-config'),
  saveHotkeyConfig: (config) => ipcRenderer.invoke('hotkey:save-config', config),

  /* ───── Provider 配置 ───── */
  getProviderConfig: () => ipcRenderer.invoke('provider:get-config'),
  saveProviderConfig: (updates) => ipcRenderer.invoke('provider:save-config', updates),
  getProviderPresets: () => ipcRenderer.invoke('provider:get-presets'),
  testProviderConnection: (providerId) => ipcRenderer.invoke('provider:test-connection', { providerId }),
});

// Keep the existing badge/menu enhancer for compatibility with older builds.
require('./skill-shortcut-ui-preload.cjs').install({ ipcRenderer });
