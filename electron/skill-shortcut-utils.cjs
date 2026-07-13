'use strict';

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];
const MODIFIER_ALIASES = new Map([
  ['CTRL', 'Ctrl'],
  ['CONTROL', 'Ctrl'],
  ['ALT', 'Alt'],
  ['OPTION', 'Alt'],
  ['SHIFT', 'Shift'],
  ['META', 'Meta'],
  ['WIN', 'Meta'],
  ['WINDOWS', 'Meta'],
  ['SUPER', 'Meta'],
  ['COMMAND', 'Meta'],
  ['CMD', 'Meta'],
]);

const MOUSE_TOKEN_ALIASES = new Map([
  ['WHEELUP', 'WheelUp'],
  ['WHEELDOWN', 'WheelDown'],
  ['MOUSEMIDDLE', 'MouseMiddle'],
  ['MIDDLE', 'MouseMiddle'],
  ['MBUTTON', 'MouseMiddle'],
  ['MOUSEX1', 'MouseX1'],
  ['X1', 'MouseX1'],
  ['XBUTTON1', 'MouseX1'],
  ['MOUSEX2', 'MouseX2'],
  ['X2', 'MouseX2'],
  ['XBUTTON2', 'MouseX2'],
]);

const RESERVED_SHORTCUTS = new Set([
  'Alt+F4',
  'Alt+Tab',
  'Ctrl+Shift+Escape',
  'Ctrl+Alt+Delete',
  'Meta+L',
  'Meta+D',
  'Meta+R',
  'Meta+E',
]);

function normalizeKeyboardToken(token) {
  const upper = String(token || '').trim().toUpperCase();
  if (/^[A-Z0-9]$/.test(upper)) return upper;
  if (/^F(?:[1-9]|1[0-2])$/.test(upper)) return upper;
  if (upper === 'ESCAPE' || upper === 'ESC') return 'Escape';
  return '';
}

function normalizeShortcut(input) {
  if (!input) return null;
  const rawValue = typeof input === 'string' ? input : input.value;
  if (!rawValue || typeof rawValue !== 'string') {
    throw new Error('快捷键格式无效。');
  }

  const rawParts = rawValue.split('+').map((part) => part.trim()).filter(Boolean);
  if (rawParts.length === 0) throw new Error('快捷键不能为空。');

  const modifiers = new Set();
  let token = '';
  for (const part of rawParts) {
    const modifier = MODIFIER_ALIASES.get(part.toUpperCase());
    if (modifier) {
      modifiers.add(modifier);
      continue;
    }
    if (token) throw new Error('快捷键只能包含一个主按键或鼠标动作。');
    const mouseToken = MOUSE_TOKEN_ALIASES.get(part.toUpperCase());
    token = mouseToken || normalizeKeyboardToken(part);
    if (!token) throw new Error(`不支持的快捷键按键：${part}`);
  }

  if (!token) throw new Error('请按下一个字母、数字、功能键或鼠标按键。');
  const isMouse = MOUSE_TOKEN_ALIASES.has(token.toUpperCase()) || ['WheelUp', 'WheelDown', 'MouseMiddle', 'MouseX1', 'MouseX2'].includes(token);
  const kind = isMouse ? 'mouse' : 'keyboard';

  if (kind === 'keyboard' && modifiers.size === 0) {
    throw new Error('键盘快捷键必须包含 Ctrl、Alt、Shift 或 Meta。');
  }
  if ((token === 'WheelUp' || token === 'WheelDown') && modifiers.size === 0) {
    throw new Error('滚轮方向必须搭配 Ctrl、Alt、Shift 或 Meta。');
  }

  const orderedModifiers = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
  const value = [...orderedModifiers, token].join('+');
  if (RESERVED_SHORTCUTS.has(value)) {
    throw new Error(`不允许使用系统高危快捷键：${value}`);
  }

  if (typeof input === 'object' && input.kind && input.kind !== kind) {
    throw new Error('快捷键类型与按键内容不一致。');
  }

  return { kind, value };
}

function normalizedValue(input) {
  try {
    return normalizeShortcut(input)?.value || '';
  } catch (_) {
    return '';
  }
}

function validateSkillShortcut(input, options = {}) {
  let shortcut;
  try {
    shortcut = normalizeShortcut(input);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!shortcut) return { ok: true, shortcut: null };

  const selectionHotkey = normalizedValue(options.selectionHotkey);
  if (selectionHotkey && selectionHotkey === shortcut.value) {
    return { ok: false, error: '该组合已被“划词快捷键”使用。' };
  }

  const skills = Array.isArray(options.skills) ? options.skills : [];
  const skillId = String(options.skillId || '');
  for (const skill of skills) {
    if (!skill || String(skill.id) === skillId || !skill.shortcut) continue;
    const otherValue = normalizedValue(skill.shortcut);
    if (otherValue && otherValue === shortcut.value) {
      return { ok: false, error: `该快捷键已被“${skill.name || '其他技能'}”技能使用。` };
    }
  }

  return { ok: true, shortcut };
}

function isMouseShortcut(input) {
  try {
    return normalizeShortcut(input)?.kind === 'mouse';
  } catch (_) {
    return false;
  }
}

function formatShortcut(input) {
  const normalized = normalizeShortcut(input);
  if (!normalized) return '';
  return normalized.value
    .replace('WheelUp', '滚轮上')
    .replace('WheelDown', '滚轮下')
    .replace('MouseMiddle', '滚轮中键')
    .replace('MouseX1', '侧键 1')
    .replace('MouseX2', '侧键 2')
    .replace(/\+/g, ' + ');
}

function encodeMouseBindings(skills) {
  const lines = [];
  for (const skill of Array.isArray(skills) ? skills : []) {
    if (!skill || skill.enabled === false || !skill.shortcut) continue;
    let shortcut;
    try { shortcut = normalizeShortcut(skill.shortcut); } catch (_) { continue; }
    if (!shortcut || shortcut.kind !== 'mouse') continue;
    lines.push(`${shortcut.value}\t${String(skill.id)}`);
  }
  return Buffer.from(lines.join('\n'), 'utf8').toString('base64');
}

module.exports = {
  MODIFIER_ORDER,
  RESERVED_SHORTCUTS,
  normalizeShortcut,
  validateSkillShortcut,
  isMouseShortcut,
  formatShortcut,
  encodeMouseBindings,
};
