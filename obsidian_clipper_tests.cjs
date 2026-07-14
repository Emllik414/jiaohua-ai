const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CLIPPER_TEMPLATE_ID,
  CLIPPER_TEMPLATE_STATE_KEY,
  CLIPPER_TEMPLATE,
  TEMPLATE_VARIABLE_KEYS,
  buildSourceLine,
  buildClipperContext,
  renderClipperTemplate,
  ensureClipperTemplate,
  markClipperTemplateDismissed,
  resolveTargetPath,
  recordMarker,
  legacyRecordMarker,
  extractRecordIds,
  stripRecordMarkers,
  normalizeImportIndex,
  hasImportedRecord,
  markImportedRecord,
} = require('./electron/obsidian-clipper.cjs');

function sampleRecord() {
  return {
    id: 'rec-1',
    createdAt: '2026-07-14T09:30:00.000Z',
    selectedText: 'out of the blue',
    answerMarkdown: '突然地；出乎意料地。',
    skillId: 'translate',
    skillName: '翻译',
    model: 'model-x',
    sourceLocation: {
      type: 'subtitle',
      url: 'https://www.youtube.com/watch?v=abc',
      normalizedUrl: 'https://www.youtube.com/watch?v=abc',
      hostname: 'www.youtube.com',
      siteName: 'YouTube',
      title: 'How to Speak English Naturally',
      icon: '▶',
      videoTime: '8:32',
      video: { platform: 'youtube', currentTime: 512 },
      capturedAt: '2026-07-14T09:29:58.000Z',
    },
  };
}

test('builds one compact source line with a direct YouTube URL', () => {
  const line = buildSourceLine(sampleRecord());
  assert.match(line, /\[!source\]/);
  assert.match(line, /YouTube/);
  assert.ok(line.includes('https://www.youtube.com/watch?v=abc&t=512s'));
  assert.doesNotMatch(line, /jiaohua:\/\//);
  assert.match(line, /8:32/);
  assert.equal(line.split('\n').length, 1);
});

test('prefers local favicon when available', () => {
  const record = sampleRecord();
  record.sourceLocation.faviconVaultPath = '.jiaohua/favicons/youtube.com.png';
  const line = buildSourceLine(record);
  assert.match(line, /!\[\[\.jiaohua\/favicons\/youtube\.com\.png\|16\]\]/);
});

test('exposes exactly 27 variables and replaces deep link with source open URL', () => {
  const context = buildClipperContext(sampleRecord());
  assert.equal(TEMPLATE_VARIABLE_KEYS.length, 27);
  assert.equal(new Set(TEMPLATE_VARIABLE_KEYS).size, 27);
  assert.deepEqual(Object.keys(context), TEMPLATE_VARIABLE_KEYS);
  assert.equal(Object.hasOwn(context, 'source_deep_link'), false);
  assert.equal(context.record_id, 'rec-1');
  assert.equal(context.selection_title, 'out of the blue');
  assert.equal(context.source_site, 'YouTube');
  assert.equal(context.video_seconds, '512');
  assert.equal(context.video_time, '8:32');
  assert.match(context.source_open_url, /^https:\/\/www\.youtube\.com\/watch/);
  assert.equal(new URL(context.source_open_url).searchParams.get('t'), '512s');
  assert.match(context.source_line, /How to Speak English Naturally/);
});

test('renders clean Markdown without any internal record marker', () => {
  const markdown = renderClipperTemplate(CLIPPER_TEMPLATE, sampleRecord());
  assert.match(markdown, /^## out of the blue/m);
  assert.match(markdown, /\[!source\]/);
  assert.match(markdown, /> out of the blue/);
  assert.match(markdown, /突然地/);
  assert.doesNotMatch(markdown, /jiaohua:\/\//);
  assert.doesNotMatch(markdown, /jiaohua-record/i);
  assert.doesNotMatch(markdown, /<details>/);
  assert.doesNotMatch(markdown, /使用模型|创建时间|来源信息/);
});

test('strips markers even when a custom template still contains them', () => {
  const template = {
    ...CLIPPER_TEMPLATE,
    contentTemplate: '%% jiaohua-record:{{record_id}} %%\n## 原文\n{{selection}}',
  };
  const markdown = renderClipperTemplate(template, sampleRecord());
  assert.equal(markdown, '## 原文\nout of the blue');
});

test('seeds bundled template once and respects deletion permanently', () => {
  const first = ensureClipperTemplate({ obsidianTemplates: [] });
  assert.equal(first.changed, true);
  assert.equal(first.store.obsidianTemplates[0].id, CLIPPER_TEMPLATE_ID);
  assert.deepEqual(first.store[CLIPPER_TEMPLATE_STATE_KEY], { seeded: true, dismissed: false });

  const deleted = markClipperTemplateDismissed({
    ...first.store,
    obsidianTemplates: first.store.obsidianTemplates.filter((item) => item.id !== CLIPPER_TEMPLATE_ID),
  });
  const afterRestart = ensureClipperTemplate(deleted);
  assert.equal(afterRestart.changed, false);
  assert.equal(afterRestart.store.obsidianTemplates.some((item) => item.id === CLIPPER_TEMPLATE_ID), false);
  assert.deepEqual(afterRestart.store[CLIPPER_TEMPLATE_STATE_KEY], { seeded: true, dismissed: true });
});

test('does not inject bundled template when an existing user already has custom templates', () => {
  const result = ensureClipperTemplate({
    obsidianTemplates: [{ id: 'custom', name: '我的模板', contentTemplate: '{{selection}}' }],
  });
  assert.equal(result.changed, true);
  assert.equal(result.store.obsidianTemplates.length, 1);
  assert.equal(result.store.obsidianTemplates[0].id, 'custom');
  assert.deepEqual(result.store[CLIPPER_TEMPLATE_STATE_KEY], { seeded: true, dismissed: true });
  const next = ensureClipperTemplate(result.store);
  assert.equal(next.changed, false);
});

test('migrates old bundled template by removing markers and deep links', () => {
  const old = {
    obsidianTemplates: [{
      ...CLIPPER_TEMPLATE,
      contentTemplate: '<!-- jiaohua-record:{{record_id}} -->\n[来源]({{source_deep_link}})',
    }],
  };
  const migrated = ensureClipperTemplate(old);
  assert.equal(migrated.changed, true);
  assert.match(migrated.store.obsidianTemplates[0].contentTemplate, /\{\{source_open_url\}\}/);
  assert.doesNotMatch(migrated.store.obsidianTemplates[0].contentTemplate, /source_deep_link|jiaohua-record/);
});

test('resolves target inside vault and blocks traversal', () => {
  const context = buildClipperContext(sampleRecord());
  const result = resolveTargetPath('/tmp/test-vault', CLIPPER_TEMPLATE, context);
  assert.equal(result.relativePath, 'AI划词/学习剪藏.md');
  assert.throws(() => resolveTargetPath('/tmp/test-vault', { ...CLIPPER_TEMPLATE, targetNotePath: '../escape.md' }, context));
});

test('extracts and removes both historical marker formats', () => {
  const content = `${recordMarker('rec-1')}\ntext\n${legacyRecordMarker('rec-2')}\nmore`;
  assert.deepEqual(extractRecordIds(content), ['rec-1', 'rec-2']);
  const cleaned = stripRecordMarkers(content);
  assert.equal(cleaned, 'text\nmore');
  assert.doesNotMatch(cleaned, /jiaohua-record/);
});

test('tracks duplicate records in an external import index', () => {
  const empty = normalizeImportIndex(null);
  assert.equal(hasImportedRecord(empty, 'rec-1'), false);
  const marked = markImportedRecord(empty, 'rec-1', 'AI划词/学习记录.md', '2026-07-14T09:30:00.000Z');
  assert.equal(hasImportedRecord(marked, 'rec-1'), true);
  assert.deepEqual(marked.records['rec-1'].paths, ['AI划词/学习记录.md']);
  const repeated = markImportedRecord(marked, 'rec-1', 'AI划词/学习记录.md');
  assert.deepEqual(repeated.records['rec-1'].paths, ['AI划词/学习记录.md']);
});