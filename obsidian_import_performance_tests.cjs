const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const {
  saveClipToObsidianFast,
  saveManyClipsFast,
} = require('./electron/obsidian-import-engine.cjs');

function fakeBrowserWindow() {
  return { getAllWindows: () => [] };
}

async function createFixture({ count = 1, existing = '' } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'jiaohua-import-performance-'));
  const userData = path.join(root, 'user-data');
  const vaultPath = path.join(root, 'vault');
  const target = path.join(vaultPath, 'AI划词', '学习记录.md');
  await fsp.mkdir(path.dirname(target), { recursive: true });
  if (existing) await fsp.writeFile(target, existing, 'utf8');

  const history = Array.from({ length: count }, (_, index) => ({
    id: `rec-${index + 1}`,
    createdAt: '2026-07-14T09:30:00.000Z',
    selectedText: `selection ${index + 1}`,
    answerMarkdown: `answer ${index + 1}`,
    skillId: 'translate',
    skillName: '翻译',
    sourceLocation: {
      type: 'web',
      url: `https://example.com/article?id=${index + 1}`,
      normalizedUrl: `https://example.com/article?id=${index + 1}`,
      hostname: 'example.com',
      siteName: 'Example',
      title: `Article ${index + 1}`,
      capturedAt: '2026-07-14T09:29:58.000Z',
    },
  }));

  const store = {
    settings: { obsidian: { vaultPath } },
    history,
    obsidianTemplates: [{
      id: 'test-template',
      name: 'Test Template',
      saveBehavior: 'append_to_existing_note_bottom',
      targetNotePath: 'AI划词/学习记录.md',
      contentTemplate: '## {{selection}}\n\n{{source_line}}\n\n{{ai_result}}',
    }],
  };

  const storePath = path.join(userData, 'data', 'store.json');
  await fsp.mkdir(path.dirname(storePath), { recursive: true });
  await fsp.writeFile(storePath, JSON.stringify(store, null, 2), 'utf8');

  return {
    root,
    userData,
    vaultPath,
    target,
    history,
    app: { getPath: (name) => name === 'userData' ? userData : root },
    BrowserWindow: fakeBrowserWindow(),
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  };
}

test('batch import writes one target, one index, and one store update', async () => {
  const fixture = await createFixture({ count: 20 });
  try {
    const result = await saveManyClipsFast(
      fixture.app,
      fixture.BrowserWindow,
      { templateId: 'test-template', recordIds: fixture.history.map((item) => item.id) },
      { scheduleFavicons: false },
    );

    assert.equal(result.successCount, 20);
    assert.equal(result.failureCount, 0);
    assert.equal(result.metrics.storeReadCount, 1);
    assert.equal(result.metrics.storeWriteCount, 1);
    assert.equal(result.metrics.indexReadCount, 1);
    assert.equal(result.metrics.indexWriteCount, 1);
    assert.equal(result.metrics.targetGroupCount, 1);
    assert.equal(result.metrics.targetReadCount, 1);
    assert.equal(result.metrics.targetWriteCount, 1);

    const markdown = await fsp.readFile(fixture.target, 'utf8');
    assert.match(markdown, /selection 1/);
    assert.match(markdown, /selection 20/);

    const index = JSON.parse(await fsp.readFile(path.join(fixture.vaultPath, '.jiaohua', 'import-index.json'), 'utf8'));
    assert.equal(Object.keys(index.records).length, 20);

    const store = JSON.parse(await fsp.readFile(path.join(fixture.userData, 'data', 'store.json'), 'utf8'));
    assert.equal(store.history.filter((item) => item.savedToObsidian).length, 20);
  } finally {
    await fixture.cleanup();
  }
});

test('duplicate batch skips target and history writes', async () => {
  const fixture = await createFixture({ count: 5 });
  try {
    const payload = { templateId: 'test-template', recordIds: fixture.history.map((item) => item.id) };
    await saveManyClipsFast(fixture.app, fixture.BrowserWindow, payload, { scheduleFavicons: false });
    const second = await saveManyClipsFast(fixture.app, fixture.BrowserWindow, payload, { scheduleFavicons: false });

    assert.equal(second.successCount, 0);
    assert.equal(second.duplicateCount, 5);
    assert.equal(second.metrics.targetGroupCount, 0);
    assert.equal(second.metrics.targetReadCount, 0);
    assert.equal(second.metrics.targetWriteCount, 0);
    assert.equal(second.metrics.storeWriteCount, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('bottom import appends instead of rewriting an existing clean note', async () => {
  const fixture = await createFixture({ count: 3, existing: '# Existing note\n' });
  try {
    const result = await saveManyClipsFast(
      fixture.app,
      fixture.BrowserWindow,
      { templateId: 'test-template', recordIds: fixture.history.map((item) => item.id) },
      { scheduleFavicons: false },
    );

    assert.equal(result.successCount, 3);
    assert.equal(result.metrics.targetAppendCount, 1);
    assert.equal(result.metrics.targetRewriteCount, 0);
    const markdown = await fsp.readFile(fixture.target, 'utf8');
    assert.ok(markdown.startsWith('# Existing note'));
  } finally {
    await fixture.cleanup();
  }
});

test('favicon network latency does not block the note import', async () => {
  const fixture = await createFixture({ count: 1 });
  const originalFetch = global.fetch;
  try {
    const storePath = path.join(fixture.userData, 'data', 'store.json');
    const store = JSON.parse(await fsp.readFile(storePath, 'utf8'));
    store.history[0].sourceLocation.faviconUrl = 'https://example.com/favicon.png';
    await fsp.writeFile(storePath, JSON.stringify(store, null, 2), 'utf8');

    let fetchStarted = false;
    global.fetch = async () => {
      fetchStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        ok: true,
        headers: {
          get(name) {
            if (String(name).toLowerCase() === 'content-type') return 'image/png';
            if (String(name).toLowerCase() === 'content-length') return '4';
            return '';
          },
        },
        arrayBuffer: async () => Uint8Array.from([137, 80, 78, 71]).buffer,
      };
    };

    const started = Date.now();
    const result = await saveClipToObsidianFast(
      fixture.app,
      fixture.BrowserWindow,
      { templateId: 'test-template', recordId: 'rec-1' },
    );
    const elapsed = Date.now() - started;

    assert.equal(result.ok, true);
    assert.ok(elapsed < 250, `import waited ${elapsed}ms for favicon`);
    await new Promise((resolve) => setTimeout(resolve, 380));
    assert.equal(fetchStarted, true);
  } finally {
    global.fetch = originalFetch;
    await fixture.cleanup();
  }
});
