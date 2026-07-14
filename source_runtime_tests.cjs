const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseSelectionBody,
  sourceSnapshotForSelection,
  readImportIndex,
  migrateTargetMarkers,
} = require('./electron/source-obsidian-runtime.cjs');

const {
  recordMarker,
  hasImportedRecord,
} = require('./electron/obsidian-clipper.cjs');

test('parses browser selection payloads', () => {
  const result = parseSelectionBody(JSON.stringify({
    text: 'out of the blue',
    sourceLocation: { type: 'web', url: 'https://example.com' },
  }));
  assert.equal(result.text, 'out of the blue');
  assert.equal(result.sourceLocation.type, 'web');
});

test('rejects invalid selection JSON', () => {
  assert.equal(parseSelectionBody('{bad json'), null);
  assert.equal(parseSelectionBody('null'), null);
});

test('does not return a source snapshot before browser selection capture', () => {
  assert.equal(sourceSnapshotForSelection('not captured'), null);
});

test('moves note markers into the hidden Vault import index', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'jiaohua-vault-'));
  try {
    const relativePath = 'AI划词/学习记录.md';
    const target = path.join(vault, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const before = `${recordMarker('rec-1')}\n## 原文\nhello`;
    fs.writeFileSync(target, before, 'utf8');

    const result = migrateTargetMarkers(vault, target, relativePath, before, readImportIndex(vault));
    assert.equal(result.existing, '## 原文\nhello');
    assert.equal(fs.readFileSync(target, 'utf8'), '## 原文\nhello');
    assert.equal(hasImportedRecord(readImportIndex(vault), 'rec-1'), true);
    assert.equal(fs.existsSync(path.join(vault, '.jiaohua', 'import-index.json')), true);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});