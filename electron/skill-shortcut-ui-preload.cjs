'use strict';

let installed = false;

function install({ ipcRenderer }) {
  if (installed) return;
  installed = true;

  const route = (() => {
    try { return new URLSearchParams(window.location.search).get('route') || 'main'; }
    catch (_) { return 'main'; }
  })();
  if (route !== 'main') return;

  let skills = [];
  let bindings = {};
  let observer = null;
  let decorateQueued = false;

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[char]);
  }

  function modifierParts(event) {
    const parts = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Meta');
    return parts;
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

  function injectStyles() {
    if (document.getElementById('skill-shortcut-injected-styles')) return;
    const style = document.createElement('style');
    style.id = 'skill-shortcut-injected-styles';
    style.textContent = `
      .skill-shortcut-badge-injected{max-width:190px;height:28px;padding:0 10px;border-radius:999px;display:inline-flex;align-items:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid rgba(37,99,235,.14);background:rgba(37,99,235,.08);color:#2563eb;font-size:12px;font-weight:780}
      .skill-shortcut-overlay{position:fixed;inset:0;z-index:3000;display:grid;place-items:center;background:rgba(15,23,42,.34);backdrop-filter:blur(9px)}
      .skill-shortcut-dialog{width:min(560px,calc(100vw - 48px));max-height:calc(100vh - 48px);overflow:hidden;border-radius:28px;background:#fff;color:#0f172a;box-shadow:0 28px 90px rgba(15,23,42,.30);display:flex;flex-direction:column}
      .skill-shortcut-dialog header{min-height:82px;padding:0 26px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(15,23,42,.07)}
      .skill-shortcut-dialog header small{display:block;color:#64748b;font-size:12px;font-weight:760}.skill-shortcut-dialog header h2{margin:3px 0 0;font-size:22px;letter-spacing:-.03em}.skill-shortcut-close{width:42px;height:42px;border:0;border-radius:50%;background:#f1f5f9;color:#64748b;font-size:24px;cursor:pointer}
      .skill-shortcut-body-injected{padding:22px 26px;overflow-y:auto;display:grid;gap:16px}.skill-shortcut-skill-injected{padding:14px;border:1px solid rgba(15,23,42,.07);border-radius:18px;background:#f8fafc;display:grid;gap:4px}.skill-shortcut-skill-injected strong{font-size:15px}.skill-shortcut-skill-injected span{color:#64748b;font-size:12px;line-height:1.5}
      .skill-shortcut-current-injected{min-height:48px;padding:0 14px;border-radius:16px;display:flex;align-items:center;justify-content:space-between;background:#eff6ff;color:#315b9f;font-size:13px}.skill-shortcut-current-injected b{color:#1d4ed8;font-size:14px}
      .skill-shortcut-capture-injected{min-height:176px;padding:22px;border:1.5px dashed #cbd5e1;border-radius:22px;outline:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;text-align:center;cursor:pointer;background:#fbfdff}.skill-shortcut-capture-injected.active,.skill-shortcut-capture-injected:focus{border-color:#2563eb;background:#f5f9ff;box-shadow:0 0 0 5px rgba(37,99,235,.08)}.skill-shortcut-capture-injected i{width:52px;height:52px;border-radius:18px;display:grid;place-items:center;background:#eaf2ff;color:#2563eb;font-style:normal;font-size:24px}.skill-shortcut-capture-injected strong{font-size:16px}.skill-shortcut-capture-injected span{max-width:400px;color:#64748b;font-size:12.5px;line-height:1.55}
      .skill-shortcut-rules-injected{padding:12px 14px;border-radius:16px;background:#f8fafc;color:#52637a;font-size:12.5px;line-height:1.7}.skill-shortcut-error-injected{display:none;padding:9px 12px;border-radius:12px;background:#fef2f2;color:#dc2626;font-size:13px}.skill-shortcut-error-injected.show{display:block}
      .skill-shortcut-footer-injected{min-height:74px;padding:0 26px;border-top:1px solid rgba(15,23,42,.07);background:#f8fafc;display:flex;align-items:center;gap:10px}.skill-shortcut-footer-injected .spacer{flex:1}.skill-shortcut-footer-injected button{height:38px;padding:0 14px;border-radius:14px;border:1px solid rgba(15,23,42,.08);background:#fff;color:#334155;font-weight:760;cursor:pointer}.skill-shortcut-footer-injected button.primary{border:0;background:#111827;color:#fff;padding:0 18px}.skill-shortcut-footer-injected button.danger{color:#dc2626}.skill-shortcut-footer-injected button:disabled{opacity:.48;cursor:not-allowed}
      html[data-appearance='dark'] .skill-shortcut-dialog{background:#111827;color:#f8fafc}html[data-appearance='dark'] .skill-shortcut-dialog header,html[data-appearance='dark'] .skill-shortcut-footer-injected{border-color:rgba(255,255,255,.08);background:#0f172a}html[data-appearance='dark'] .skill-shortcut-skill-injected,html[data-appearance='dark'] .skill-shortcut-rules-injected{border-color:rgba(255,255,255,.08);background:#172033}html[data-appearance='dark'] .skill-shortcut-capture-injected{border-color:#475569;background:#0f172a}html[data-appearance='dark'] .skill-shortcut-footer-injected button{border-color:rgba(255,255,255,.10);background:#172033;color:#e2e8f0}
      @media(max-width:820px){.skill-shortcut-badge-injected{display:none}}
    `;
    document.head.appendChild(style);
  }

  async function refreshState() {
    try {
      const [data, state] = await Promise.all([
        ipcRenderer.invoke('app:get-initial-data'),
        ipcRenderer.invoke('skill-shortcuts:get-state'),
      ]);
      skills = [...(data?.skills || state?.skills || [])].sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0));
      bindings = state?.bindings || {};
      queueDecorate();
    } catch (error) {
      console.warn('[SkillShortcutUI] state load failed', error);
    }
  }

  function queueDecorate() {
    if (decorateQueued) return;
    decorateQueued = true;
    requestAnimationFrame(() => {
      decorateQueued = false;
      decorateRows();
    });
  }

  function decorateRows() {
    const rows = Array.from(document.querySelectorAll('.skill-row'));
    rows.forEach((row, index) => {
      const skill = skills[index];
      if (!skill) return;
      row.dataset.skillShortcutId = String(skill.id);
      let badge = row.querySelector('.skill-shortcut-badge-injected');
      const shortcut = bindings[skill.id];
      if (shortcut) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'skill-shortcut-badge-injected';
          const pill = row.querySelector('.pill');
          if (pill) row.insertBefore(badge, pill);
          else row.appendChild(badge);
        }
        badge.textContent = formatShortcut(shortcut);
        badge.title = formatShortcut(shortcut);
      } else if (badge) {
        badge.remove();
      }

      const menu = row.querySelector('.skill-menu');
      if (menu && !menu.querySelector('.skill-shortcut-menu-item-injected')) {
        const item = document.createElement('div');
        item.className = 'skill-menu-item skill-shortcut-menu-item-injected';
        item.textContent = '设置快捷键';
        item.addEventListener('mousedown', (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        item.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          openDialog(skill);
        });
        const first = menu.querySelector('.skill-menu-item');
        if (first?.nextSibling) menu.insertBefore(item, first.nextSibling);
        else menu.appendChild(item);
      }
    });
  }

  function openDialog(skill) {
    document.querySelector('.skill-shortcut-overlay')?.remove();
    let draft = bindings[skill.id] || null;
    let recording = true;
    let busy = false;

    const overlay = document.createElement('div');
    overlay.className = 'skill-shortcut-overlay';
    overlay.innerHTML = `
      <section class="skill-shortcut-dialog" role="dialog" aria-modal="true" aria-label="设置技能快捷键">
        <header><div><small>技能快捷键</small><h2>设置快捷键</h2></div><button class="skill-shortcut-close" aria-label="关闭">×</button></header>
        <div class="skill-shortcut-body-injected">
          <div class="skill-shortcut-skill-injected"><strong>${escapeHtml(skill.name)}</strong><span>划词后工具条仍会正常弹出，按快捷键可直接执行这个技能。</span></div>
          <div class="skill-shortcut-current-injected"><span>当前快捷键</span><b></b></div>
          <div class="skill-shortcut-capture-injected active" tabindex="0"><i>⌨</i><strong>正在录制快捷键…</strong><span>按键盘组合、滚轮中键、侧键 1、侧键 2，或带修饰键的滚轮方向。</span></div>
          <div class="skill-shortcut-rules-injected">键盘快捷键必须包含 Ctrl、Alt、Shift 或 Meta。<br>滚轮上/下必须搭配修饰键；滚轮中键和两个侧键可以单独使用。<br>快捷键只在有效划词工具条出现期间生效。</div>
          <div class="skill-shortcut-error-injected"></div>
        </div>
        <footer class="skill-shortcut-footer-injected"><button class="danger clear">清除快捷键</button><span class="spacer"></span><button class="cancel">取消</button><button class="primary save">保存</button></footer>
      </section>`;
    document.body.appendChild(overlay);

    const capture = overlay.querySelector('.skill-shortcut-capture-injected');
    const current = overlay.querySelector('.skill-shortcut-current-injected b');
    const errorBox = overlay.querySelector('.skill-shortcut-error-injected');
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
      clearButton.disabled = busy || !bindings[skill.id];
    };
    const accept = (shortcut) => {
      draft = shortcut;
      recording = false;
      setError('');
      render();
    };
    const close = () => overlay.remove();

    capture.addEventListener('click', () => { recording = true; setError(''); render(); capture.focus(); });
    capture.addEventListener('keydown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') { recording = false; render(); return; }
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;
      const modifiers = modifierParts(event);
      const key = /^[a-z0-9]$/i.test(event.key) ? event.key.toUpperCase() : /^F(?:[1-9]|1[0-2])$/i.test(event.key) ? event.key.toUpperCase() : '';
      if (!key) { setError('请使用字母、数字或 F1–F12。'); return; }
      if (modifiers.length === 0) { setError('键盘快捷键必须包含 Ctrl、Alt、Shift 或 Meta。'); return; }
      accept({ kind: 'keyboard', value: [...modifiers, key].join('+') });
    });
    capture.addEventListener('wheel', (event) => {
      event.preventDefault(); event.stopPropagation();
      const modifiers = modifierParts(event);
      if (modifiers.length === 0) { setError('滚轮方向必须搭配 Ctrl、Alt、Shift 或 Meta。'); return; }
      accept({ kind: 'mouse', value: [...modifiers, event.deltaY < 0 ? 'WheelUp' : 'WheelDown'].join('+') });
    }, { passive: false });
    const captureMouse = (event) => {
      if (![1, 3, 4].includes(event.button)) return;
      event.preventDefault(); event.stopPropagation();
      const token = event.button === 1 ? 'MouseMiddle' : event.button === 3 ? 'MouseX1' : 'MouseX2';
      accept({ kind: 'mouse', value: [...modifierParts(event), token].join('+') });
    };
    capture.addEventListener('mousedown', captureMouse, true);
    capture.addEventListener('mouseup', (event) => { if ([1, 3, 4].includes(event.button)) { event.preventDefault(); event.stopPropagation(); } }, true);
    capture.addEventListener('auxclick', captureMouse, true);
    capture.addEventListener('contextmenu', (event) => event.preventDefault());

    overlay.querySelector('.skill-shortcut-close').addEventListener('click', close);
    overlay.querySelector('.cancel').addEventListener('click', close);
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) close(); });
    saveButton.addEventListener('click', async () => {
      if (!draft || busy) return;
      busy = true; render(); setError('');
      try {
        const result = await ipcRenderer.invoke('skill-shortcuts:set', { skillId: skill.id, shortcut: draft });
        if (!result?.ok) { setError(result?.error || '快捷键保存失败。'); return; }
        bindings[skill.id] = result.shortcut;
        close();
        await refreshState();
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      } finally { busy = false; render(); }
    });
    clearButton.addEventListener('click', async () => {
      if (busy) return;
      busy = true; render(); setError('');
      try {
        const result = await ipcRenderer.invoke('skill-shortcuts:clear', { skillId: skill.id });
        if (!result?.ok) { setError(result?.error || '快捷键清除失败。'); return; }
        delete bindings[skill.id];
        close();
        await refreshState();
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      } finally { busy = false; render(); }
    });

    render();
    setTimeout(() => capture.focus(), 0);
  }

  function start() {
    injectStyles();
    refreshState();
    observer = new MutationObserver(queueDecorate);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('beforeunload', () => observer?.disconnect(), { once: true });
  }

  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

module.exports = { install };
