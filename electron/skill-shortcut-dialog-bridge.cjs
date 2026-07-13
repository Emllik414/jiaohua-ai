'use strict';

let installed = false;
let controller = null;

function install({ ipcRenderer }) {
  if (installed) return controller;
  installed = true;

  const route = (() => {
    try { return new URLSearchParams(window.location.search).get('route') || 'main'; }
    catch (_) { return 'main'; }
  })();

  if (route !== 'main') {
    controller = {
      open: async () => ({ ok: false, error: '快捷键设置只能在主窗口中打开。' }),
    };
    return controller;
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[char]);
  }

  function formatShortcut(shortcut) {
    if (!shortcut?.value) return '未设置';
    return shortcut.value
      .replace('WheelUp', '滚轮上')
      .replace('WheelDown', '滚轮下')
      .replace('MouseMiddle', '滚轮中键')
      .replace('MouseX1', '侧键 1')
      .replace('MouseX2', '侧键 2')
      .replace(/\+/g, ' + ');
  }

  function modifierParts(event) {
    const parts = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Meta');
    return parts;
  }

  function ensureStyles() {
    if (document.getElementById('skill-shortcut-direct-dialog-styles')) return;
    const style = document.createElement('style');
    style.id = 'skill-shortcut-direct-dialog-styles';
    style.textContent = `
      .skill-shortcut-direct-overlay{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;background:rgba(15,23,42,.38);backdrop-filter:blur(10px)}
      .skill-shortcut-direct-dialog{width:min(560px,calc(100vw - 48px));max-height:calc(100vh - 48px);overflow:hidden;border-radius:28px;background:#fff;color:#0f172a;box-shadow:0 28px 90px rgba(15,23,42,.32);display:flex;flex-direction:column}
      .skill-shortcut-direct-header{min-height:82px;padding:0 26px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(15,23,42,.08)}
      .skill-shortcut-direct-header small{display:block;color:#64748b;font-size:12px;font-weight:760}.skill-shortcut-direct-header h2{margin:3px 0 0;font-size:22px;letter-spacing:-.03em}.skill-shortcut-direct-close{width:42px;height:42px;border:0;border-radius:50%;background:#f1f5f9;color:#64748b;font-size:24px;cursor:pointer}
      .skill-shortcut-direct-body{padding:22px 26px;overflow-y:auto;display:grid;gap:16px}.skill-shortcut-direct-skill{padding:14px;border:1px solid rgba(15,23,42,.08);border-radius:18px;background:#f8fafc;display:grid;gap:4px}.skill-shortcut-direct-skill strong{font-size:15px}.skill-shortcut-direct-skill span{color:#64748b;font-size:12px;line-height:1.5}
      .skill-shortcut-direct-current{min-height:48px;padding:0 14px;border-radius:16px;display:flex;align-items:center;justify-content:space-between;background:#eff6ff;color:#315b9f;font-size:13px}.skill-shortcut-direct-current b{color:#1d4ed8;font-size:14px}
      .skill-shortcut-direct-capture{min-height:176px;padding:22px;border:1.5px dashed #cbd5e1;border-radius:22px;outline:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;text-align:center;cursor:pointer;background:#fbfdff}.skill-shortcut-direct-capture.active,.skill-shortcut-direct-capture:focus{border-color:#2563eb;background:#f5f9ff;box-shadow:0 0 0 5px rgba(37,99,235,.08)}.skill-shortcut-direct-capture i{width:52px;height:52px;border-radius:18px;display:grid;place-items:center;background:#eaf2ff;color:#2563eb;font-style:normal;font-size:24px}.skill-shortcut-direct-capture strong{font-size:16px}.skill-shortcut-direct-capture span{max-width:410px;color:#64748b;font-size:12.5px;line-height:1.55}
      .skill-shortcut-direct-rules{padding:12px 14px;border-radius:16px;background:#f8fafc;color:#52637a;font-size:12.5px;line-height:1.7}.skill-shortcut-direct-error{display:none;padding:9px 12px;border-radius:12px;background:#fef2f2;color:#dc2626;font-size:13px}.skill-shortcut-direct-error.show{display:block}
      .skill-shortcut-direct-footer{min-height:74px;padding:0 26px;border-top:1px solid rgba(15,23,42,.08);background:#f8fafc;display:flex;align-items:center;gap:10px}.skill-shortcut-direct-footer .spacer{flex:1}.skill-shortcut-direct-footer button{height:38px;padding:0 14px;border-radius:14px;border:1px solid rgba(15,23,42,.09);background:#fff;color:#334155;font-weight:760;cursor:pointer}.skill-shortcut-direct-footer button.primary{border:0;background:#111827;color:#fff;padding:0 18px}.skill-shortcut-direct-footer button.danger{color:#dc2626}.skill-shortcut-direct-footer button:disabled{opacity:.48;cursor:not-allowed}
      html[data-appearance='dark'] .skill-shortcut-direct-dialog{background:#111827;color:#f8fafc}html[data-appearance='dark'] .skill-shortcut-direct-header,html[data-appearance='dark'] .skill-shortcut-direct-footer{border-color:rgba(255,255,255,.08);background:#0f172a}html[data-appearance='dark'] .skill-shortcut-direct-skill,html[data-appearance='dark'] .skill-shortcut-direct-rules{border-color:rgba(255,255,255,.08);background:#172033}html[data-appearance='dark'] .skill-shortcut-direct-capture{border-color:#475569;background:#0f172a}html[data-appearance='dark'] .skill-shortcut-direct-footer button{border-color:rgba(255,255,255,.10);background:#172033;color:#e2e8f0}
    `;
    document.head.appendChild(style);
  }

  async function loadSkill(skillId) {
    const [initialData, shortcutState] = await Promise.all([
      ipcRenderer.invoke('app:get-initial-data'),
      ipcRenderer.invoke('skill-shortcuts:get-state'),
    ]);
    const skills = initialData?.skills || shortcutState?.skills || [];
    const skill = skills.find((item) => String(item.id) === String(skillId));
    if (!skill) throw new Error('没有找到对应技能。');
    return {
      skill,
      shortcut: shortcutState?.bindings?.[skill.id] || skill.shortcut || null,
    };
  }

  function renderErrorDialog(message) {
    ensureStyles();
    document.querySelector('.skill-shortcut-direct-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'skill-shortcut-direct-overlay';
    overlay.innerHTML = `
      <section class="skill-shortcut-direct-dialog">
        <header class="skill-shortcut-direct-header"><div><small>技能快捷键</small><h2>无法打开设置</h2></div><button class="skill-shortcut-direct-close">×</button></header>
        <div class="skill-shortcut-direct-body"><div class="skill-shortcut-direct-error show">${escapeHtml(message)}</div></div>
        <footer class="skill-shortcut-direct-footer"><span class="spacer"></span><button class="primary">关闭</button></footer>
      </section>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.skill-shortcut-direct-close')?.addEventListener('click', close);
    overlay.querySelector('.primary')?.addEventListener('click', close);
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) close(); });
  }

  function renderDialog(skill, existingShortcut) {
    ensureStyles();
    document.querySelector('.skill-shortcut-direct-overlay')?.remove();

    let draft = existingShortcut || null;
    let recording = true;
    let busy = false;

    const overlay = document.createElement('div');
    overlay.className = 'skill-shortcut-direct-overlay';
    overlay.innerHTML = `
      <section class="skill-shortcut-direct-dialog" role="dialog" aria-modal="true" aria-label="设置技能快捷键">
        <header class="skill-shortcut-direct-header"><div><small>技能快捷键</small><h2>设置快捷键</h2></div><button class="skill-shortcut-direct-close" aria-label="关闭">×</button></header>
        <div class="skill-shortcut-direct-body">
          <div class="skill-shortcut-direct-skill"><strong>${escapeHtml(skill.name)}</strong><span>划词后工具条仍会正常弹出，按快捷键可直接执行这个技能。</span></div>
          <div class="skill-shortcut-direct-current"><span>当前快捷键</span><b></b></div>
          <div class="skill-shortcut-direct-capture active" tabindex="0"><i>⌨</i><strong>正在录制快捷键…</strong><span>按键盘组合、滚轮中键、侧键 1、侧键 2，或带修饰键的滚轮方向。</span></div>
          <div class="skill-shortcut-direct-rules">键盘快捷键必须包含 Ctrl、Alt、Shift 或 Meta。<br>滚轮上/下必须搭配修饰键；滚轮中键和两个侧键可以单独使用。<br>快捷键只在有效划词工具条出现期间生效。</div>
          <div class="skill-shortcut-direct-error"></div>
        </div>
        <footer class="skill-shortcut-direct-footer"><button class="danger clear">清除快捷键</button><span class="spacer"></span><button class="cancel">取消</button><button class="primary save">保存</button></footer>
      </section>`;
    document.body.appendChild(overlay);

    const capture = overlay.querySelector('.skill-shortcut-direct-capture');
    const current = overlay.querySelector('.skill-shortcut-direct-current b');
    const errorBox = overlay.querySelector('.skill-shortcut-direct-error');
    const saveButton = overlay.querySelector('.save');
    const clearButton = overlay.querySelector('.clear');

    const setError = (message = '') => {
      errorBox.textContent = message;
      errorBox.classList.toggle('show', Boolean(message));
    };
    const render = () => {
      current.textContent = formatShortcut(draft);
      capture.classList.toggle('active', recording);
      capture.querySelector('strong').textContent = recording ? '正在录制快捷键…' : '点击这里重新录制';
      saveButton.disabled = busy || !draft;
      clearButton.disabled = busy || !existingShortcut;
    };
    const accept = (shortcut) => {
      draft = shortcut;
      recording = false;
      setError('');
      render();
    };
    const close = () => overlay.remove();

    capture.addEventListener('click', () => {
      recording = true;
      setError('');
      render();
      capture.focus();
    });
    capture.addEventListener('keydown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        recording = false;
        render();
        return;
      }
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;
      const modifiers = modifierParts(event);
      const key = /^[a-z0-9]$/i.test(event.key)
        ? event.key.toUpperCase()
        : /^F(?:[1-9]|1[0-2])$/i.test(event.key)
          ? event.key.toUpperCase()
          : '';
      if (!key) {
        setError('请使用字母、数字或 F1–F12。');
        return;
      }
      if (modifiers.length === 0) {
        setError('键盘快捷键必须包含 Ctrl、Alt、Shift 或 Meta。');
        return;
      }
      accept({ kind: 'keyboard', value: [...modifiers, key].join('+') });
    });
    capture.addEventListener('wheel', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const modifiers = modifierParts(event);
      if (modifiers.length === 0) {
        setError('滚轮方向必须搭配 Ctrl、Alt、Shift 或 Meta。');
        return;
      }
      accept({ kind: 'mouse', value: [...modifiers, event.deltaY < 0 ? 'WheelUp' : 'WheelDown'].join('+') });
    }, { passive: false });

    const captureMouse = (event) => {
      if (![1, 3, 4].includes(event.button)) return;
      event.preventDefault();
      event.stopPropagation();
      const token = event.button === 1 ? 'MouseMiddle' : event.button === 3 ? 'MouseX1' : 'MouseX2';
      accept({ kind: 'mouse', value: [...modifierParts(event), token].join('+') });
    };
    capture.addEventListener('mousedown', captureMouse, true);
    capture.addEventListener('mouseup', (event) => {
      if ([1, 3, 4].includes(event.button)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
    capture.addEventListener('auxclick', captureMouse, true);
    capture.addEventListener('contextmenu', (event) => event.preventDefault());

    overlay.querySelector('.skill-shortcut-direct-close')?.addEventListener('click', close);
    overlay.querySelector('.cancel')?.addEventListener('click', close);
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) close(); });

    saveButton.addEventListener('click', async () => {
      if (!draft || busy) return;
      busy = true;
      render();
      setError('');
      try {
        const result = await ipcRenderer.invoke('skill-shortcuts:set', { skillId: skill.id, shortcut: draft });
        if (!result?.ok) {
          setError(result?.error || '快捷键保存失败。');
          return;
        }
        existingShortcut = result.shortcut;
        close();
        window.dispatchEvent(new Event('focus'));
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      } finally {
        busy = false;
        if (overlay.isConnected) render();
      }
    });

    clearButton.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      render();
      setError('');
      try {
        const result = await ipcRenderer.invoke('skill-shortcuts:clear', { skillId: skill.id });
        if (!result?.ok) {
          setError(result?.error || '快捷键清除失败。');
          return;
        }
        existingShortcut = null;
        close();
        window.dispatchEvent(new Event('focus'));
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      } finally {
        busy = false;
        if (overlay.isConnected) render();
      }
    });

    render();
    window.setTimeout(() => capture.focus(), 0);
  }

  async function open(skillId) {
    try {
      const { skill, shortcut } = await loadSkill(skillId);
      renderDialog(skill, shortcut);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      renderErrorDialog(message);
      return { ok: false, error: message };
    }
  }

  controller = { open };
  return controller;
}

module.exports = { install };
