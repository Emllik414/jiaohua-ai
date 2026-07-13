const { contextBridge, ipcRenderer } = require('electron');

// ─────────────────────────────────────────────────────────────────
//  Inline shortcut-dialog controller (formerly
//  electron/skill-shortcut-dialog-bridge.cjs).  The sandboxed
//  preload cannot `require` local CommonJS files, so we carry the
//  logic directly inside preload.cjs instead.
// ─────────────────────────────────────────────────────────────────

function _escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, function (char) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char];
  });
}

function _formatShortcut(shortcut) {
  if (!shortcut || !shortcut.value) return '未设置';
  return shortcut.value
    .replace('WheelUp', '滚轮上')
    .replace('WheelDown', '滚轮下')
    .replace('MouseMiddle', '滚轮中键')
    .replace('MouseX1', '侧键 1')
    .replace('MouseX2', '侧键 2')
    .replace(/\+/g, ' + ');
}

function _modifierParts(event) {
  var parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');
  return parts;
}

function _ensureStyles() {
  if (document.getElementById('skill-shortcut-direct-dialog-styles')) return;
  var style = document.createElement('style');
  style.id = 'skill-shortcut-direct-dialog-styles';
  style.textContent = [
    '.skill-shortcut-direct-overlay{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;background:rgba(15,23,42,.38);backdrop-filter:blur(10px)}',
    '.skill-shortcut-direct-dialog{width:min(560px,calc(100vw - 48px));max-height:calc(100vh - 48px);overflow:hidden;border-radius:28px;background:#fff;color:#0f172a;box-shadow:0 28px 90px rgba(15,23,42,.32);display:flex;flex-direction:column}',
    '.skill-shortcut-direct-header{min-height:82px;padding:0 26px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(15,23,42,.08)}',
    '.skill-shortcut-direct-header small{display:block;color:#64748b;font-size:12px;font-weight:760}',
    '.skill-shortcut-direct-header h2{margin:3px 0 0;font-size:22px;letter-spacing:-.03em}',
    '.skill-shortcut-direct-close{width:42px;height:42px;border:0;border-radius:50%;background:#f1f5f9;color:#64748b;font-size:24px;cursor:pointer}',
    '.skill-shortcut-direct-body{padding:22px 26px;overflow-y:auto;display:grid;gap:16px}',
    '.skill-shortcut-direct-skill{padding:14px;border:1px solid rgba(15,23,42,.08);border-radius:18px;background:#f8fafc;display:grid;gap:4px}',
    '.skill-shortcut-direct-skill strong{font-size:15px}',
    '.skill-shortcut-direct-skill span{color:#64748b;font-size:12px;line-height:1.5}',
    '.skill-shortcut-direct-current{min-height:48px;padding:0 14px;border-radius:16px;display:flex;align-items:center;justify-content:space-between;background:#eff6ff;color:#315b9f;font-size:13px}',
    '.skill-shortcut-direct-current b{color:#1d4ed8;font-size:14px}',
    '.skill-shortcut-direct-capture{min-height:176px;padding:22px;border:1.5px dashed #cbd5e1;border-radius:22px;outline:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;text-align:center;cursor:pointer;background:#fbfdff}',
    '.skill-shortcut-direct-capture.active,.skill-shortcut-direct-capture:focus{border-color:#2563eb;background:#f5f9ff;box-shadow:0 0 0 5px rgba(37,99,235,.08)}',
    '.skill-shortcut-direct-capture i{width:52px;height:52px;border-radius:18px;display:grid;place-items:center;background:#eaf2ff;color:#2563eb;font-style:normal;font-size:24px}',
    '.skill-shortcut-direct-capture strong{font-size:16px}',
    '.skill-shortcut-direct-capture span{max-width:410px;color:#64748b;font-size:12.5px;line-height:1.55}',
    '.skill-shortcut-direct-rules{padding:12px 14px;border-radius:16px;background:#f8fafc;color:#52637a;font-size:12.5px;line-height:1.7}',
    '.skill-shortcut-direct-error{display:none;padding:9px 12px;border-radius:12px;background:#fef2f2;color:#dc2626;font-size:13px}',
    '.skill-shortcut-direct-error.show{display:block}',
    '.skill-shortcut-direct-footer{min-height:74px;padding:0 26px;border-top:1px solid rgba(15,23,42,.08);background:#f8fafc;display:flex;align-items:center;gap:10px}',
    '.skill-shortcut-direct-footer .spacer{flex:1}',
    '.skill-shortcut-direct-footer button{height:38px;padding:0 14px;border-radius:14px;border:1px solid rgba(15,23,42,.09);background:#fff;color:#334155;font-weight:760;cursor:pointer}',
    '.skill-shortcut-direct-footer button.primary{border:0;background:#111827;color:#fff;padding:0 18px}',
    '.skill-shortcut-direct-footer button.danger{color:#dc2626}',
    '.skill-shortcut-direct-footer button:disabled{opacity:.48;cursor:not-allowed}',
    'html[data-appearance="dark"] .skill-shortcut-direct-dialog{background:#111827;color:#f8fafc}',
    'html[data-appearance="dark"] .skill-shortcut-direct-header,html[data-appearance="dark"] .skill-shortcut-direct-footer{border-color:rgba(255,255,255,.08);background:#0f172a}',
    'html[data-appearance="dark"] .skill-shortcut-direct-skill,html[data-appearance="dark"] .skill-shortcut-direct-rules{border-color:rgba(255,255,255,.08);background:#172033}',
    'html[data-appearance="dark"] .skill-shortcut-direct-capture{border-color:#475569;background:#0f172a}',
    'html[data-appearance="dark"] .skill-shortcut-direct-footer button{border-color:rgba(255,255,255,.10);background:#172033;color:#e2e8f0}',
  ].join('\n');
  document.head.appendChild(style);
}

async function _loadSkill(skillId) {
  var _a, _b;
  var initialData, shortcutState;
  try {
    var results = await Promise.all([
      ipcRenderer.invoke('app:get-initial-data'),
      ipcRenderer.invoke('skill-shortcuts:get-state'),
    ]);
    initialData = results[0];
    shortcutState = results[1];
  } catch (_e) {
    initialData = null;
    shortcutState = null;
  }
  var skills = ((_a = initialData === null || initialData === void 0 ? void 0 : initialData.skills) !== null && _a !== void 0 ? _a : ((_b = shortcutState === null || shortcutState === void 0 ? void 0 : shortcutState.skills) !== null && _b !== void 0 ? _b : []));
  var skill = skills.find(function (item) { return String(item.id) === String(skillId); });
  if (!skill) throw new Error('没有找到对应技能。');
  return {
    skill: skill,
    shortcut: ((shortcutState === null || shortcutState === void 0 ? void 0 : shortcutState.bindings)
      ? shortcutState.bindings[skill.id]
      : null) || skill.shortcut || null,
  };
}

function _renderErrorDialog(message) {
  if (!document.body) {
    console.error('[Preload] cannot render error dialog — document.body is null');
    return;
  }
  _ensureStyles();
  var existing = document.querySelector('.skill-shortcut-direct-overlay');
  if (existing) existing.remove();
  var overlay = document.createElement('div');
  overlay.className = 'skill-shortcut-direct-overlay';
  overlay.innerHTML =
    '<section class="skill-shortcut-direct-dialog">' +
    '<header class="skill-shortcut-direct-header"><div><small>技能快捷键</small><h2>无法打开设置</h2></div><button class="skill-shortcut-direct-close">×</button></header>' +
    '<div class="skill-shortcut-direct-body"><div class="skill-shortcut-direct-error show">' + _escapeHtml(message) + '</div></div>' +
    '<footer class="skill-shortcut-direct-footer"><span class="spacer"></span><button class="primary">关闭</button></footer>' +
    '</section>';
  document.body.appendChild(overlay);
  var close = function () { overlay.remove(); };
  var closeBtn = overlay.querySelector('.skill-shortcut-direct-close');
  if (closeBtn) closeBtn.addEventListener('click', close);
  var primaryBtn = overlay.querySelector('.primary');
  if (primaryBtn) primaryBtn.addEventListener('click', close);
  overlay.addEventListener('mousedown', function (event) { if (event.target === overlay) close(); });
}

function _renderShortcutDialog(skill, existingShortcut) {
  if (!document.body) {
    console.error('[Preload] cannot render shortcut dialog — document.body is null');
    return;
  }
  _ensureStyles();
  var existing = document.querySelector('.skill-shortcut-direct-overlay');
  if (existing) existing.remove();

  var draft = existingShortcut || null;
  var recording = true;
  var busy = false;

  var overlay = document.createElement('div');
  overlay.className = 'skill-shortcut-direct-overlay';
  overlay.innerHTML =
    '<section class="skill-shortcut-direct-dialog" role="dialog" aria-modal="true" aria-label="设置技能快捷键">' +
    '<header class="skill-shortcut-direct-header"><div><small>技能快捷键</small><h2>设置快捷键</h2></div><button class="skill-shortcut-direct-close" aria-label="关闭">×</button></header>' +
    '<div class="skill-shortcut-direct-body">' +
    '<div class="skill-shortcut-direct-skill"><strong>' + _escapeHtml(skill.name) + '</strong><span>划词后工具条仍会正常弹出，按快捷键可直接执行这个技能。</span></div>' +
    '<div class="skill-shortcut-direct-current"><span>当前快捷键</span><b></b></div>' +
    '<div class="skill-shortcut-direct-capture active" tabindex="0"><i>⌨</i><strong>正在录制快捷键…</strong><span>按键盘组合、滚轮中键、侧键 1、侧键 2，或带修饰键的滚轮方向。</span></div>' +
    '<div class="skill-shortcut-direct-rules">键盘快捷键必须包含 Ctrl、Alt、Shift 或 Meta。<br>滚轮上/下必须搭配修饰键；滚轮中键和两个侧键可以单独使用。<br>快捷键只在有效划词工具条出现期间生效。</div>' +
    '<div class="skill-shortcut-direct-error"></div>' +
    '</div>' +
    '<footer class="skill-shortcut-direct-footer"><button class="danger clear">清除快捷键</button><span class="spacer"></span><button class="cancel">取消</button><button class="primary save">保存</button></footer>' +
    '</section>';
  document.body.appendChild(overlay);

  var capture    = overlay.querySelector('.skill-shortcut-direct-capture');
  var current    = overlay.querySelector('.skill-shortcut-direct-current b');
  var errorBox   = overlay.querySelector('.skill-shortcut-direct-error');
  var saveButton = overlay.querySelector('.save');
  var clearBtn   = overlay.querySelector('.clear');

  var setError = function (msg) {
    if (msg === undefined) msg = '';
    errorBox.textContent = msg;
    errorBox.classList.toggle('show', Boolean(msg));
  };

  var render = function () {
    current.textContent = _formatShortcut(draft);
    capture.classList.toggle('active', recording);
    capture.querySelector('strong').textContent = recording ? '正在录制快捷键…' : '点击这里重新录制';
    saveButton.disabled = busy || !draft;
    clearBtn.disabled = busy || !existingShortcut;
  };

  var accept = function (shortcut) {
    draft = shortcut;
    recording = false;
    setError('');
    render();
  };

  var close = function () { overlay.remove(); };

  capture.addEventListener('click', function () {
    recording = true;
    setError('');
    render();
    capture.focus();
  });

  capture.addEventListener('keydown', function (event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') { recording = false; render(); return; }
    if (['Control', 'Alt', 'Shift', 'Meta'].indexOf(event.key) !== -1) return;
    var modifiers = _modifierParts(event);
    var key = '';
    if (/^[a-z0-9]$/i.test(event.key)) key = event.key.toUpperCase();
    else if (/^F(?:[1-9]|1[0-2])$/i.test(event.key)) key = event.key.toUpperCase();
    if (!key) { setError('请使用字母、数字或 F1–F12。'); return; }
    if (modifiers.length === 0) { setError('键盘快捷键必须包含 Ctrl、Alt、Shift 或 Meta。'); return; }
    accept({ kind: 'keyboard', value: modifiers.concat([key]).join('+') });
  });

  capture.addEventListener('wheel', function (event) {
    event.preventDefault();
    event.stopPropagation();
    var modifiers = _modifierParts(event);
    if (modifiers.length === 0) { setError('滚轮方向必须搭配 Ctrl、Alt、Shift 或 Meta。'); return; }
    accept({ kind: 'mouse', value: modifiers.concat([event.deltaY < 0 ? 'WheelUp' : 'WheelDown']).join('+') });
  }, { passive: false });

  var captureMouse = function (event) {
    if ([1, 3, 4].indexOf(event.button) === -1) return;
    event.preventDefault();
    event.stopPropagation();
    var token = event.button === 1 ? 'MouseMiddle' : event.button === 3 ? 'MouseX1' : 'MouseX2';
    accept({ kind: 'mouse', value: _modifierParts(event).concat([token]).join('+') });
  };
  capture.addEventListener('mousedown', captureMouse, true);
  capture.addEventListener('mouseup', function (event) {
    if ([1, 3, 4].indexOf(event.button) !== -1) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  capture.addEventListener('auxclick', captureMouse, true);
  capture.addEventListener('contextmenu', function (event) { event.preventDefault(); });

  var closeBtn = overlay.querySelector('.skill-shortcut-direct-close');
  if (closeBtn) closeBtn.addEventListener('click', close);
  var cancelBtn = overlay.querySelector('.cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', close);
  overlay.addEventListener('mousedown', function (event) { if (event.target === overlay) close(); });

  saveButton.addEventListener('click', function () {
    if (!draft || busy) return;
    busy = true; render(); setError('');
    ipcRenderer.invoke('skill-shortcuts:set', { skillId: skill.id, shortcut: draft })
      .then(function (result) {
        if (!(result === null || result === void 0 ? void 0 : result.ok)) {
          setError((result === null || result === void 0 ? void 0 : result.error) || '快捷键保存失败。');
          return;
        }
        existingShortcut = result.shortcut;
        close();
        window.dispatchEvent(new Event('focus'));
      })
      .catch(function (error) {
        setError(error instanceof Error ? error.message : String(error));
      })
      .finally(function () {
        busy = false;
        if (overlay.isConnected) render();
      });
  });

  clearBtn.addEventListener('click', function () {
    if (busy) return;
    busy = true; render(); setError('');
    ipcRenderer.invoke('skill-shortcuts:clear', { skillId: skill.id })
      .then(function (result) {
        if (!(result === null || result === void 0 ? void 0 : result.ok)) {
          setError((result === null || result === void 0 ? void 0 : result.error) || '快捷键清除失败。');
          return;
        }
        existingShortcut = null;
        close();
        window.dispatchEvent(new Event('focus'));
      })
      .catch(function (error) {
        setError(error instanceof Error ? error.message : String(error));
      })
      .finally(function () {
        busy = false;
        if (overlay.isConnected) render();
      });
  });

  render();
  window.setTimeout(function () { capture.focus(); }, 0);
}

async function openSkillShortcutDialog(skillId) {
  // Only operate on the main window (check route from location).
  try {
    var route = new URLSearchParams(window.location.search).get('route') || 'main';
    if (route !== 'main') {
      return { ok: false, error: '快捷键设置只能在主窗口中打开。' };
    }
  } catch (_e) {
    // If location is unavailable, assume main and continue.
  }

  try {
    var _a = await _loadSkill(skillId);
    var skill = _a.skill;
    var shortcut = _a.shortcut;
    _renderShortcutDialog(skill, shortcut);
    return { ok: true };
  } catch (error) {
    var message = error instanceof Error ? error.message : String(error);
    console.error('[Preload] openSkillShortcutDialog failed', error);
    _renderErrorDialog(message);
    return { ok: false, error: message };
  }
}

// ─────────────────────────────────────────────────────────────────
//  desktopApi – core IPC bridge (must be the first thing exposed)
// ─────────────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld('desktopApi', {
  getInitialData: function () { return ipcRenderer.invoke('app:get-initial-data'); },
  saveSettings: function (settings) { return ipcRenderer.invoke('settings:save', settings); },
  saveSkill: function (skill) { return ipcRenderer.invoke('skills:save', skill); },
  reorderSkills: function (skillIds) { return ipcRenderer.invoke('skills:reorder', skillIds); },
  deleteSkill: function (skillId) { return ipcRenderer.invoke('skills:delete', skillId); },
  validateSkillShortcut: function (skillId, shortcut) { return ipcRenderer.invoke('skill-shortcuts:validate', { skillId: skillId, shortcut: shortcut }); },
  setSkillShortcut: function (skillId, shortcut) { return ipcRenderer.invoke('skill-shortcuts:set', { skillId: skillId, shortcut: shortcut }); },
  clearSkillShortcut: function (skillId) { return ipcRenderer.invoke('skill-shortcuts:clear', { skillId: skillId }); },
  getSkillShortcutState: function () { return ipcRenderer.invoke('skill-shortcuts:get-state'); },
  openSkillShortcutDialog: openSkillShortcutDialog,
  runSkill: function (skillId, selection) { return ipcRenderer.invoke('skill:run', { skillId: skillId, selection: selection }); },
  copyText: function (text, options) { return ipcRenderer.invoke('clipboard:write', { text: text, options: options }); },

  /* ───── 对话管理 ───── */
  getConversations: function () { return ipcRenderer.invoke('conversations:list'); },
  createConversation: function (title) { return ipcRenderer.invoke('conversations:create', title); },
  renameConversation: function (id, title) { return ipcRenderer.invoke('conversations:rename', { id: id, title: title }); },
  deleteConversation: function (id, deleteRecords) { return ipcRenderer.invoke('conversations:delete', { id: id, deleteRecords: deleteRecords }); },
  pinConversation: function (id) { return ipcRenderer.invoke('conversations:pin', id); },
  setActiveConversation: function (id) { return ipcRenderer.invoke('conversations:set-active', id); },

  /* ───── Obsidian 模板系统 ───── */
  getObsidianTemplates: function () { return ipcRenderer.invoke('obsidian:templates:list'); },
  saveObsidianTemplate: function (template) { return ipcRenderer.invoke('obsidian:templates:save', template); },
  deleteObsidianTemplate: function (templateId) { return ipcRenderer.invoke('obsidian:templates:delete', templateId); },
  previewObsidianTemplate: function (templateId, recordId, record) { return ipcRenderer.invoke('obsidian:template:preview', { templateId: templateId, recordId: recordId, record: record }); },
  saveToObsidianNote: function (templateId, recordId, record) { return ipcRenderer.invoke('obsidian:note:save', { templateId: templateId, recordId: recordId, record: record }); },
  saveManyToObsidian: function (templateId, recordIds) { return ipcRenderer.invoke('obsidian:notes:save-many', { templateId: templateId, recordIds: recordIds }); },
  listVaultNotes: function () { return ipcRenderer.invoke('obsidian:vault:list-notes'); },
  checkVaultPath: function (relativePath) { return ipcRenderer.invoke('obsidian:vault:check-path', relativePath); },

  deleteHistory: function (recordIds) { return ipcRenderer.invoke('history:delete', recordIds); },
  clearHistory: function () { return ipcRenderer.invoke('history:clear'); },
  chooseHistoryExportDirectory: function () { return ipcRenderer.invoke('history-export:choose-directory'); },
  exportHistory: function (options) { return ipcRenderer.invoke('history-export:write', options); },
  speak: function (text, options) { return ipcRenderer.invoke('tts:speak', text, options); },
  stopSpeak: function () { return ipcRenderer.invoke('tts:stop'); },
  onTtsState: function (callback) {
    var listener = function (_event, payload) { callback(payload); };
    ipcRenderer.on('tts:state', listener);
    return function () { ipcRenderer.removeListener('tts:state', listener); };
  },
  showMain: function () { return ipcRenderer.invoke('window:show-main'); },
  closeCurrent: function () { return ipcRenderer.invoke('window:close-current'); },
  rendererLog: function (msg) { return ipcRenderer.send('renderer-log', msg); },
  setAppearance: function (mode) { return ipcRenderer.invoke('appearance:set', mode); },
  onAppearanceChanged: function (callback) {
    var listener = function (_event, mode) { callback(mode); };
    ipcRenderer.on('appearance:changed', listener);
    return function () { ipcRenderer.removeListener('appearance:changed', listener); };
  },
  hideToolbar: function () { return ipcRenderer.invoke('toolbar:hide'); },
  resizeToolbar: function (expanded) { return ipcRenderer.invoke('toolbar:resize', expanded); },
  toggleToolbarMore: function (anchor) { return ipcRenderer.invoke('toolbar-more:toggle', anchor); },
  hideToolbarMore: function () { return ipcRenderer.invoke('toolbar-more:hide'); },
  getToolbarBounds: function () { return ipcRenderer.invoke('toolbar:get-bounds'); },
  setToolbarSize: function (size) { return ipcRenderer.invoke('toolbar:set-size', size); },
  setToolbarPosition: function (pos) { return ipcRenderer.invoke('toolbar:set-position', pos); },
  setToolbarPointerInside: function (inside) { return ipcRenderer.invoke('toolbar:pointer-inside', inside); },
  setToolbarMorePointerInside: function (inside) { return ipcRenderer.invoke('toolbar-more:pointer-inside', inside); },
  setResultPointerInside: function (inside) { return ipcRenderer.invoke('result:pointer-inside', inside); },
  lockResultInteraction: function (duration) { return ipcRenderer.invoke('result:interaction', duration); },
  setResultState: function (state) { return ipcRenderer.invoke('result:set-state', state); },
  closeResult: function (reason) { return ipcRenderer.invoke('result:close', reason); },
  getResultBounds: function () { return ipcRenderer.invoke('result:get-bounds'); },
  setResultPosition: function (pos) { return ipcRenderer.invoke('result:set-position', pos); },
  resizeResult: function (height) { return ipcRenderer.invoke('result:resize', height); },
  resizeResultBox: function (size) { return ipcRenderer.invoke('result:resize-box', size); },
  onSelectionReady: function (callback) {
    var listener = function (_event, payload) { callback(payload); };
    ipcRenderer.on('selection:ready', listener);
    return function () { ipcRenderer.removeListener('selection:ready', listener); };
  },
  onResultReady: function (callback) {
    var listener = function (_event, payload) { callback(payload); };
    ipcRenderer.on('result:ready', listener);
    return function () { ipcRenderer.removeListener('result:ready', listener); };
  },
  onResultUpdate: function (callback) {
    var listener = function (_event, payload) { callback(payload); };
    ipcRenderer.on('result:update', listener);
    return function () { ipcRenderer.removeListener('result:update', listener); };
  },
  onResultReset: function (callback) {
    var listener = function () { callback(); };
    ipcRenderer.on('result:reset', listener);
    return function () { ipcRenderer.removeListener('result:reset', listener); };
  },
  onHistoryChanged: function (callback) {
    var listener = function (_event, payload) { callback(payload); };
    ipcRenderer.on('history:changed', listener);
    return function () { ipcRenderer.removeListener('history:changed', listener); };
  },
  onConfirmSelection: function (callback) {
    var listener = function (_event, payload) { callback(payload); };
    ipcRenderer.on('result:confirm-selection', listener);
    return function () { ipcRenderer.removeListener('result:confirm-selection', listener); };
  },
  onToolbarShow: function (callback) {
    var listener = function () { callback(); };
    ipcRenderer.on('toolbar:show', listener);
    return function () { ipcRenderer.removeListener('toolbar:show', listener); };
  },
  onToolbarHide: function (callback) {
    var listener = function () { callback(); };
    ipcRenderer.on('toolbar:hide', listener);
    return function () { ipcRenderer.removeListener('toolbar:hide', listener); };
  },
  onToolbarMoreState: function (callback) {
    var listener = function (_event, payload) { callback(payload); };
    ipcRenderer.on('toolbar-more:state', listener);
    return function () { ipcRenderer.removeListener('toolbar-more:state', listener); };
  },
  onSkillsUpdated: function (callback) {
    var listener = function (_event, payload) { callback(payload); };
    ipcRenderer.on('skills:updated', listener);
    return function () { ipcRenderer.removeListener('skills:updated', listener); };
  },
  confirmSelection: function (skillId, selectedText) { return ipcRenderer.invoke('result:confirm-selection-action', { skillId: skillId, selectedText: selectedText }); },
  cancelSelection: function () { return ipcRenderer.invoke('result:cancel-selection'); },

  /* ───── 快捷键配置 ───── */
  getHotkeyConfig: function () { return ipcRenderer.invoke('hotkey:get-config'); },
  saveHotkeyConfig: function (config) { return ipcRenderer.invoke('hotkey:save-config', config); },

  /* ───── Provider 配置 ───── */
  getProviderConfig: function () { return ipcRenderer.invoke('provider:get-config'); },
  saveProviderConfig: function (updates) { return ipcRenderer.invoke('provider:save-config', updates); },
  getProviderPresets: function () { return ipcRenderer.invoke('provider:get-presets'); },
  testProviderConnection: function (providerId) { return ipcRenderer.invoke('provider:test-connection', { providerId: providerId }); },
});
