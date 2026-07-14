'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeFastIndex,
  hasImportedFast,
  markImportedFast,
  hasMigratedPath,
  markMigratedPath,
  importRecordsFast,
} = require('./electron/obsidian-import-performance-runtime.cjs');
const { CLIPPER_TEMPLATE } = require('./electron/obsidian-clipper.cjs');

function makeRecord(number) {
  return {
    id: `rec-${number}`,
    createdAt: `2026-07-14T09:${String(number % 60).padStart(2, '0')}:00.000Z`,
    selectedText: `selection ${number}`,
    answerMarkdown: `answer ${number}`,
    skillId: 'translate',
    skillName: '翻译',
    sourceLocation: {
      type: 'web',
      url: `https://example.com/article/${number}`,
      normalizedUrl: `https://example.com/article/${number}`,
      hostname: 'example.com',
      siteName: 'Example',
      title: `Example article ${number}`,
      capturedAt: `2026-07-14T09:${String(number % 60).padStart(2, '0')}:00.000Z`,
    },
  };
}

function makeFixture(count = 20) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jiaohua-fast-import-'));
  const userData = path.join(root, 'user-data');
  const vault = path.join(root, 'vault');
  fs.mkdirSync(path.join(userData, 'data'), { recursive: true });
  fs.mkdirSync(vault, { recursive: true });
  const history = Array.from({ length: count }, (_, index) => makeRecord(index + 1));
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

test('fast index uses direct lookup and in-place updates while preserving migration state', () => {
  const index = normalizeFastIndex({
    version: 1,
    records: { old: { importedAt: 'earlier', paths: ['old.md'] } },
    migratedPaths: { 'AI划词/old.md': 'earlier' },
  });
  assert.equal(hasImportedFast(index, 'old'), true);
  assert.equal(hasMigratedPath(index, 'AI划词/old.md'), true);
  assert.equal(markImportedFast(index, 'new', 'AI划词/new.md', 'now'), true);
  assert.equal(hasImportedFast(index, 'new'), true);
  assert.equal(markMigratedPath(index, 'AI划词/new.md', 'now'), true);
  assert.equal(hasMigratedPath(index, 'AI划词/new.md'), true);
  assert.equal(markMigratedPath(index, 'AI划词/new.md', 'later'), false);
});

test('imports a large batch into one note in one transaction', async () => {
  const fixture = makeFixture(120);
  try {
    const ids = Array.from({ length: 120 }, (_, index) => `rec-${index + 1}`);
    const result = await importRecordsFast(fixture.app, fixture.BrowserWindow, {
      templateId: CLIPPER_TEMPLATE.id,
      recordIds: ids,
    });

    assert.equal(result.successCount, 120);
    assert.equal(result.failureCount, 0);
    assert.equal(result.duplicateCount, 0);
    assert.equal(typeof result.durationMs, 'number');
    assert.equal(typeof result.timings.loadMs, 'number');
    assert.equal(typeof result.timings.prepareMs, 'number');
    assert.equal(typeof result.timings.writeNotesMs, 'number');
    assert.equal(typeof result.timings.persistMs, 'number');

    const notePath = path.join(fixture.vault, 'AI划词', '学习剪藏.md');
    const note = fs.readFileSync(notePath, 'utf8');
    assert.equal((note.match(/^## selection /gm) || []).length, 120);

    const indexPath = path.join(fixture.vault, '.jiaohua', 'import-index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    assert.equal(Object.keys(index.records).length, 120);
    assert.equal(Boolean(index.migratedPaths['AI划词/学习剪藏.md']), true);

    const store = JSON.parse(fs.readFileSync(fixture.storePath, 'utf8'));
    assert.equal(store.history.every((record) => record.savedToObsidian), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('subsequent bottom append uses file stat and does not reread the whole Markdown note', async () => {
  const fixture = makeFixture(2);
  try {
    const first = await importRecordsFast(fixture.app, fixture.BrowserWindow, {
      templateId: CLIPPER_TEMPLATE.id,
      recordIds: ['rec-1'],
    });
    assert.equal(first.successCount, 1);

    const notePath = path.join(fixture.vault, 'AI划词', '学习剪藏.md');
    fs.appendFileSync(notePath, `\n${'existing large content '.repeat(20000)}`, 'utf8');

    const originalReadFile = fs.promises.readFile;
    let markdownReadCount = 0;
    fs.promises.readFile = async function countedReadFile(file, ...args) {
      if (path.resolve(String(file)) === path.resolve(notePath)) markdownReadCount += 1;
      return originalReadFile.call(this, file, ...args);
    };

    try {
      const second = await importRecordsFast(fixture.app, fixture.BrowserWindow, {
        templateId: CLIPPER_TEMPLATE.id,
        recordIds: ['rec-2'],
      });
      assert.equal(second.successCount, 1);
      assert.equal(markdownReadCount, 0);
    } finally {
      fs.promises.readFile = originalReadFile;
    }

    const note = fs.readFileSync(notePath, 'utf8');
    assert.match(note, /selection 1/);
    assert.match(note, /selection 2/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('duplicate batch is rejected before any Markdown read or write', async () => {
  const fixture = makeFixture(3);
  try {
    const ids = ['rec-1', 'rec-2', 'rec-3'];
    const first = await importRecordsFast(fixture.app, fixture.BrowserWindow, {
      templateId: CLIPPER_TEMPLATE.id,
      recordIds: ids,
    });
    assert.equal(first.successCount, 3);

    const notePath = path.join(fixture.vault, 'AI划词', '学习剪藏.md');
    const before = fs.readFileSync(notePath, 'utf8');
    const second = await importRecordsFast(fixture.app, fixture.BrowserWindow, {
      templateId: CLIPPER_TEMPLATE.id,
      recordIds: ids,
    });

    assert.equal(second.successCount, 0);
    assert.equal(second.duplicateCount, 3);
    assert.equal(fs.readFileSync(notePath, 'utf8'), before);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
