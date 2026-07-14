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
  importRecords,
} = require('./electron/source-obsidian-runtime.cjs');

const {
  CLIPPER_TEMPLATE,
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

function makeRuntimeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jiaohua-import-'));
  const userData = path.join(root, 'user-data');
  const vault = path.join(root, 'vault');
  fs.mkdirSync(path.join(userData, 'data'), { recursive: true });
  fs.mkdirSync(vault, { recursive: true });
  const history = [1, 2, 3].map((number) => ({
    id: `rec-${number}`,
    createdAt: `2026-07-14T09:3${number}:00.000Z`,
    selectedText: `selection ${number}`,
    answerMarkdown: `answer ${number}`,
    skillId: 'translate',
    skillName: '翻译',
    sourceLocation: {
      type: 'web',
      url: `https://example.com/article#${number}`,
      normalizedUrl: `https://example.com/article#${number}`,
      hostname: 'example.com',
      siteName: 'Example',
      title: 'Example article',
      capturedAt: `2026-07-14T09:3${number}:00.000Z`,
    },
  }));
  const store = {
    settings: { obsidian: { vaultPath: vault } },
    obsidianTemplates: [CLIPPER_TEMPLATE],
    history,
  };
  const storePath = path.join(userData, 'data', 'store.json');
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
  return {
    root,
    userData,
    vault,
    storePath,
    app: { getPath: (name) => name === 'userData' ? userData : root },
    BrowserWindow: { getAllWindows: () => [] },
  };
}

test('imports a batch into one note and persists history/index once as one transaction', async () => {
  const fixture = makeRuntimeFixture();
  try {
    const result = await importRecords(fixture.app, fixture.BrowserWindow, {
      templateId: CLIPPER_TEMPLATE.id,
      recordIds: ['rec-1', 'rec-2', 'rec-3'],
    });

    assert.equal(result.successCount, 3);
    assert.equal(result.failureCount, 0);
    assert.equal(result.duplicateCount, 0);
    const note = fs.readFileSync(path.join(fixture.vault, 'AI划词', '学习剪藏.md'), 'utf8');
    assert.match(note, /selection 1/);
    assert.match(note, /selection 2/);
    assert.match(note, /selection 3/);
    assert.equal((note.match(/## selection/g) || []).length, 3);

    const index = readImportIndex(fixture.vault);
    assert.equal(hasImportedRecord(index, 'rec-1'), true);
    assert.equal(hasImportedRecord(index, 'rec-2'), true);
    assert.equal(hasImportedRecord(index, 'rec-3'), true);

    const store = JSON.parse(fs.readFileSync(fixture.storePath, 'utf8'));
    assert.equal(store.history.every((record) => record.savedToObsidian === true), true);
    assert.equal(store.history.every((record) => record.obsidianPath.endsWith('学习剪藏.md')), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('skips an already imported batch without appending duplicate content', async () => {
  const fixture = makeRuntimeFixture();
  try {
    const first = await importRecords(fixture.app, fixture.BrowserWindow, {
      templateId: CLIPPER_TEMPLATE.id,
      recordIds: ['rec-1', 'rec-2'],
    });
    assert.equal(first.successCount, 2);
    const target = path.join(fixture.vault, 'AI划词', '学习剪藏.md');
    const before = fs.readFileSync(target, 'utf8');

    const second = await importRecords(fixture.app, fixture.BrowserWindow, {
      templateId: CLIPPER_TEMPLATE.id,
      recordIds: ['rec-1', 'rec-2'],
    });
    assert.equal(second.successCount, 0);
    assert.equal(second.duplicateCount, 2);
    assert.equal(fs.readFileSync(target, 'utf8'), before);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
