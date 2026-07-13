'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeShortcut,
  validateSkillShortcut,
  isMouseShortcut,
  formatShortcut,
  encodeMouseBindings,
} = require('./electron/skill-shortcut-utils.cjs');

test('normalizes keyboard modifiers into a stable order', () => {
  assert.deepEqual(normalizeShortcut({ kind: 'keyboard', value: 'shift+alt+t' }), {
    kind: 'keyboard',
    value: 'Alt+Shift+T',
  });
});

test('supports middle and side mouse buttons with modifiers', () => {
  assert.deepEqual(normalizeShortcut('MouseMiddle'), { kind: 'mouse', value: 'MouseMiddle' });
  assert.deepEqual(normalizeShortcut('alt+xbutton1'), { kind: 'mouse', value: 'Alt+MouseX1' });
  assert.deepEqual(normalizeShortcut('ctrl+shift+mousex2'), { kind: 'mouse', value: 'Ctrl+Shift+MouseX2' });
});

test('requires a modifier for wheel direction shortcuts', () => {
  assert.throws(() => normalizeShortcut('WheelUp'), /必须搭配/);
  assert.deepEqual(normalizeShortcut('Alt+WheelDown'), { kind: 'mouse', value: 'Alt+WheelDown' });
});

test('rejects plain keyboard keys and reserved shortcuts', () => {
  assert.throws(() => normalizeShortcut('T'), /必须包含/);
  assert.throws(() => normalizeShortcut('Alt+F4'), /高危/);
});

test('detects conflicts with selection shortcut and other skills', () => {
  const skills = [
    { id: 'translate', name: '翻译', shortcut: { kind: 'mouse', value: 'Alt+WheelUp' } },
  ];
  assert.equal(validateSkillShortcut('Alt+Q', {
    skillId: 'explain',
    selectionHotkey: 'Alt+Q',
    skills,
  }).ok, false);
  const duplicate = validateSkillShortcut('Alt+WheelUp', {
    skillId: 'explain',
    selectionHotkey: 'Alt+Q',
    skills,
  });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /翻译/);
});

test('formats and serializes mouse shortcuts', () => {
  assert.equal(formatShortcut('Ctrl+MouseX2'), 'Ctrl + 侧键 2');
  assert.equal(isMouseShortcut('Ctrl+MouseX2'), true);
  const encoded = encodeMouseBindings([
    { id: 'translate', enabled: true, shortcut: { kind: 'mouse', value: 'Alt+WheelUp' } },
    { id: 'disabled', enabled: false, shortcut: { kind: 'mouse', value: 'MouseX1' } },
    { id: 'keyboard', enabled: true, shortcut: { kind: 'keyboard', value: 'Ctrl+1' } },
  ]);
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), 'Alt+WheelUp\ttranslate');
});
