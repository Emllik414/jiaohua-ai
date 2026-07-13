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
  let refreshPromise = null;
  let decorateFrame = 0;
  let recoveryTimer = 0;

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

  function injectStyles() {
    if (document.getElementById('skill-shortcut-native-styles')) return;
    const style = document.createElement('style');
    style.id = 'skill-shortcut-native-styles';
    style.textContent = `
      .skill-row.skill-row-has-shortcut{grid-template-columns:24px 32px minmax(0,1fr) auto auto 40px}
      .skill-shortcut-badge-native{max-width:190px;height:28px;padding:0 10px;border-radius:999px;display:inline-flex;align-items:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid rgba(37,99,235,.14);background:rgba(37,99,235,.08);color:#2563eb;font-size:12px;font-weight:780}
      .skill-shortcut-overlay-native{position:fixed;inset:0;z-index:5000;display:grid;place-items:center;background:rgba(15,23,42,.36);backdrop-filter:blur(10px)}
      .skill-shortcut-dialog-native{width:min(560px,calc(100vw - 48px));max-height:calc(100vh - 48px);overflow:hidden;border-radius:28px;background:#fff;color:#0f172a;box-shadow:0 28px 90px rgba(15,23,42,.30);display:flex;flex-direction:column}
      .skill-shortcut-dialog-native header{min-height:82px;padding:0 26px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(15,23,42,.07)}
      .skill-shortcut-dialog-native header small{display:block;color:#64748b;font-size:12px;font-weight:760}.skill-shortcut-dialog-native header h2{margin:3px 0 0;font-size:22px;letter-spacing:-.03em}.skill-shortcut-close-native{width:42px;height:42px;border:0;border-radius:50%;background:#f1f5f9;color:#64748b;font-size:24px;cursor:pointer}
      .skill-shortcut-body-native{padding:22px 26px;overflow-y:auto;display:grid;gap:16px}.skill-shortcut-skill-native{padding:14px;border:1px solid rgba(15,23,42,.07);border-radius:18px;background:#f8fafc;display:grid;gap:4px}.skill-shortcut-skill-native strong{font-size:15px}.skill-shortcut-skill-native span{color:#64748b;font-size:12px;line-height:1.5}
      .skill-shortcut-current-native{min-height:48px;padding:0 14px;border-radius:16px;display:flex;align-items:center;justify-content:space-between;background:#eff6ff;color:#315b9f;font-size:13px}.skill-shortcut-current-native b{color:#1d4ed8;font-size:14px}
      .skill-shortcut-capture-native{min-height:176px;padding:22px;border:1.5px dashed #cbd5e1;border-radius:22px;outline:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;text-align:center;cursor:pointer;background:#fbfdff}.skill-shortcut-capture-native.active,.skill-shortcut-capture-native:focus{border-color:#2563eb;background:#f5f9ff;box-shadow:0 0 0 5px rgba(37,99,235,.08)}.skill-shortcut-capture-native i{width:52px;height:52px;border-radius:18px;display:grid;place-items:center;background:#eaf2ff;color:#2563eb;font-style:normal;font-size:24px}.skill-shortcut-capture-native strong{font-size:16px}.skill-shortcut-capture-native span{max-width:410px;color:#64748b;font-size:12.5px;line-height:1.55}
      .skill-shortcut-rules-native{padding:12px 14px;border-radius:16px;background:#f8fafc;color:#52637a;font-size:12.5px;line-height:1.7}.skill-shortcut-error-native{display:none;padding:9px 12px;border-radius:12px;background:#fef2f2;color:#dc2626;font-size:13px}.skill-shortcut-error-native.show{display:block}
      .skill-shortcut-footer-native{min-height:74px;padding:0 26px;border-top:1px solid rgba(15,23,42,.07);background:#f8fafc;display:flex;align-items:center;gap:10px}.skill-shortcut-footer-native .spacer{flex:1}.skill-shortcut-footer-native button{height:38px;padding:0 14px;border-radius:14px;border:1px solid rgba(15,23,42,.08);background:#fff;color:#334155;font-weight:760;cursor:pointer}.skill-shortcut-footer-native button.primary{border:0;background:#111827;color:#fff;padding:0 18px}.skill-shortcut-footer-native button.danger{color:#dc2626}.skill-shortcut-footer-native button:disabled{opacity:.48;cursor:not-allowed}
      html[data-appearance='dark'] .skill-shortcut-dialog-native{background:#111827;color:#f8fafc}html[data-appearance='dark'] .skill-shortcut-dialog-native header,html[data-appearance='dark'] .skill-shortcut-footer-native{border-color:rgba(255,255,255,.08);background:#0f172a}html[data-appearance='dark'] .skill-shortcut-skill-native,html[data-appearance='dark'] .skill-shortcut-rules-native{border-color:rgba(255,255,255,.08);background:#172033}html[data-appearance='dark'] .skill-shortcut-capture-native{border-color:#475569;background:#0f172a}html[data-appearance='dark'] .skill-shortcut-footer-native button{border-color:rgba(255,255,255,.10);background:#172033;color:#e2e8f0}
      @media(max-width:820px){.skill-row.skill-row-has-shortcut{grid-template-columns:24px 32px minmax(0,1fr) auto 40px}.skill-shortcut-badge-native{display:none}}
    `;
    document.head.appendChild(style);
  }

  async function refreshState() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = Promise.all([
      ipcRenderer.invoke('app:get-initial-data'),
      ipcRenderer.invoke('skill-shortcuts:get-state'),
    ]).then(([data, shortcutState]) => {
      skills = [...(data?.skills || shortcutState?.skills || [])]
        .sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0));
      bindings = shortcutState?.bindings || {};
      queueDecorate();
      document.documentElement.dataset.skillShortcutUi = 'ready';
    }).catch((error) => {
      console.warn('[SkillShortcutUI] state load failed', error);
      document.documentElement.dataset.skillShortcutUi = 'error';
    }).finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  function queueDecorate() {
    if (decorateFrame) return;
    decorateFrame = window.requestAnimationFrame(() => {
      decorateFrame = 0;
      decorateSkillRows();
    });
  }

  function skillForRow(row, index, usedIds) {
    const name = String(row.querySelector('.skill-row-name')?.textContent || '').trim();
    const exact = skills.find((skill) => !usedIds.has(String(skill.id)) && String(skill.name || '').trim() === name);
    const fallback = skills[index] && !usedIds.has(String(skills[index].id)) ? skills[index] : null;
    const skill = exact || fallback || null;
    if (skill) usedIds.add(String(skill.id));
    return skill;
  }

  function renderShortcutBadge(row, skill) {
    const existing = row.querySelector('.skill-shortcut-badge-native');
    const shortcut = skill ? bindings[skill.id] : null;
    if (!shortcut) {
      existing?.remove();
      row.classList.remove('skill-row-has-shortcut');
      return;
    }

    const badge = existing || document.createElement('span');
    badge.className = 'skill-shortcut-badge-native';
    badge.textContent = formatShortcut(shortcut);
    badge.title = formatShortcut(shortcut);
    if (!existing) {
      const pill = row.querySelector('.pill');
      if (pill) row.insertBefore(badge, pill);
      else row.appendChild(badge);
    }
    row.classList.add('skill-row-has-shortcut');
  }

  function normalizeSkillMenu(row, menu, skill, index) {
    const directChildren = Array.from(menu.children);
    const menuItems = directChildren.filter((node) => node.classList.contains('skill-menu-item'));
    const editItem = menuItems.find((node) => node.textContent?.trim() === '编辑技能') || null;
    const deleteItem = menuItems.find((node) => node.textContent?.trim() === '删除技能') || null;

    for (const child of directChildren) {
      if (child === editItem || child === deleteItem) continue;
      child.remove();
    }

    let shortcutItem = menu.querySelector('.skill-shortcut-menu-item-native');
    if (!shortcutItem) {
      shortcutItem = document.createElement('div');
      shortcutItem.className = 'skill-menu-item skill-shortcut-menu-item-native';
      shortcutItem.textContent = '设置快捷键';
      shortcutItem.setAttribute('role', 'button');
      shortcutItem.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      shortcutItem.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const currentSkillId = row.dataset.skillShortcutId || '';
        const currentSkill = skills.find((item) => String(item.id) === currentSkillId)
          || skillForRow(row, index, new Set());
        if (!currentSkill) {
          void refreshState().then(() => {
            const retrySkill = skills.find((item) => String(item.name || '').trim() === String(row.querySelector('.skill-row-name')?.textContent || '').trim());
            if (retrySkill) openShortcutDialog(retrySkill);
            else showSetupError('没有找到对应技能，请重新打开技能管理页面。');
          });
          return;
        }
        openShortcutDialog(currentSkill);
      });
    }

    if (editItem) menu.appendChild(editItem);
    menu.appendChild(shortcutItem);
    if (deleteItem) {
      const separator = document.createElement('div');
      separator.className = 'skill-menu-sep skill-shortcut-menu-sep-native';
      menu.appendChild(separator);
      menu.appendChild(deleteItem);
    }
    menu.dataset.skillShortcutNormalized = '1';
  }

  function decorateSkillRows() {
    const rows = Array.from(document.querySelectorAll('.skill-row'));
    const usedIds = new Set();
    rows.forEach((row, index) => {
      const skill = skillForRow(row, index, usedIds);
      if (skill) row.dataset.skillShortcutId = String(skill.id);
      renderShortcutBadge(row, skill);
      const menu = row.querySelector('.skill-menu');
      if (menu) normalizeSkillMenu(row, menu, skill, index);
    });
  }

  function showSetupError(message) {
    const existing = document.querySelector('.skill-shortcut-overlay-native');
    existing?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'skill-shortcut-overlay-native';
    overlay.innerHTML = `<section class="skill-shortcut-dialog-native"><header><div><small>技能快捷键</small><h2>无法打开设置</h2></div><button class="skill-shortcut-close-native">×</button></header><div class="skill-shortcut-body-native"><div class="skill-shortcut-error-native show">${escapeHtml(message)}</div></div><footer class="skill-shortcut-footer-native"><span class="spacer"></span><button class="primary">关闭</button></footer></section>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.skill-shortcut-close-native')?.addEventListener('click', close);
    overlay.querySelector('.primary')?.addEventListener('click', close);
  }

  function openShortcutDialog(skill) {
    document.querySelector('.skill-shortcut-overlay-native')?.remove();
    let draft = bindings[skill.id] || null;
    let recording = true;
    let busy = false;

    const overlay = document.createElement('div');
    overlay.className = 'skill-shortcut-overlay-native';
    overlay.innerHTML = `
      <section class="skill-shortcut-dialog-native" role="dialog" aria-modal="true" aria-label="设置技能快捷键">
        <header><div><small>技能快捷键</small><h2>设置快捷键</h2></div><button class="skill-shortcut-close-native" aria-label="关闭">×</button></header>
        <div class="skill-shortcut-body-native">
          <div class="skill-shortcut-skill-native"><strong>${escapeHtml(skill.name)}</strong><span>划词后工具条仍会正常弹出，按快捷键可直接执行这个技能。</span></div>
          <div class="skill-shortcut-current-native"><span>当前快捷键</span><b></b></div>
          <div class="skill-shortcut-capture-native active" tabindex="0"><i>⌨</i><strong>正在录制快捷键…</strong><span>按键盘组合、滚轮中键、侧键 1、侧键 2，或带修饰键的滚轮方向。</span></div>
          <div class="skill-shortcut-rules-native">键盘快捷键必须包含 Ctrl、Alt、Shift 或 Meta。<br>滚轮上/下必须搭配修饰键；滚轮中键和两个侧键可以单独使用。<br>快捷键只在有效划词工具条出现期间生效。</div>
          <div class="skill-shortcut-error-native"></div>
        </div>
        <footer class="skill-shortcut-footer-native"><button class="danger clear">清除快捷键</button><span class="spacer"></span><button class="cancel">取消</button><button class="primary save">保存</button></footer>
      </section>`;
    document.body.appendChild(overlay);

    const capture = overlay.querySelector('.skill-shortcut-capture-native');
    const current = overlay.querySelector('.skill-shortcut-current-native b');
    const errorBox = overlay.querySelector('.skill-shortcut-error-native');
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

    overlay.querySelector('.skill-shortcut-close-native')?.addEventListener('click', close);
    overlay.querySelector('.cancel')?.addEventListener('click', close);
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) close();
    });

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
        bindings[skill.id] = result.shortcut;
        close();
        await refreshState();
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
        delete bindings[skill.id];
        close();
        await refreshState();
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

  function start() {
    injectStyles();
    void refreshState();
    observer = new MutationObserver(queueDecorate);
    observer.observe(document.body, { childList: true, subtree: true });
    recoveryTimer = window.setInterval(decorateSkillRows, 700);

    const onSkillsUpdated = () => { void refreshState(); };
    const onFocus = () => { void refreshState(); };
    ipcRenderer.on('skills:updated', onSkillsUpdated);
    window.addEventListener('focus', onFocus);
    window.addEventListener('beforeunload', () => {
      observer?.disconnect();
      if (decorateFrame) window.cancelAnimationFrame(decorateFrame);
      if (recoveryTimer) window.clearInterval(recoveryTimer);
      ipcRenderer.removeListener('skills:updated', onSkillsUpdated);
      window.removeEventListener('focus', onFocus);
    }, { once: true });
  }

  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

module.exports = { install };
