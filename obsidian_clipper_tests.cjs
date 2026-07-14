const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CLIPPER_TEMPLATE_ID,
  CLIPPER_TEMPLATE,
  TEMPLATE_VARIABLE_KEYS,
  buildSourceLine,
  buildClipperContext,
  renderClipperTemplate,
  ensureClipperTemplate,
  resolveTargetPath,
  recordMarker,
  legacyRecordMarker,
  migrateLegacyRecordMarkers,
  containsRecord,
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
  assert.match(line, /https:\/\/www\.youtube\.com\/watch\?v=abc&amp;?/i);
  assert.match(line, /t=512s/);
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

test('renders only title, direct source, selection and answer', () => {
  const markdown = renderClipperTemplate(CLIPPER_TEMPLATE, sampleRecord());
  assert.match(markdown, new RegExp(recordMarker('rec-1').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(markdown, /^## out of the blue/m);
  assert.match(markdown, /\[!source\]/);
  assert.match(markdown, /> out of the blue/);
  assert.match(markdown, /突然地/);
  assert.doesNotMatch(markdown, /jiaohua:\/\//);
  assert.doesNotMatch(markdown, /<!--\s*jiaohua-record/);
  assert.doesNotMatch(markdown, /<details>/);
  assert.doesNotMatch(markdown, /使用模型|创建时间|来源信息/);
});

test('adds clipper template once and migrates its old marker and variable', () => {
  const first = ensureClipperTemplate({ obsidianTemplates: [] });
  assert.equal(first.changed, true);
  assert.equal(first.store.obsidianTemplates[0].id, CLIPPER_TEMPLATE_ID);
  const old = {
    ...first.store,
    obsidianTemplates: [{
      ...first.store.obsidianTemplates[0],
      contentTemplate: '<!-- jiaohua-record:{{record_id}} -->\n[来源]({{source_deep_link}})',
    }],
  };
  const migrated = ensureClipperTemplate(old);
  assert.equal(migrated.changed, true);
  assert.match(migrated.store.obsidianTemplates[0].contentTemplate, /%% jiaohua-record:\{\{record_id\}\} %%/);
  assert.match(migrated.store.obsidianTemplates[0].contentTemplate, /\{\{source_open_url\}\}/);
  assert.doesNotMatch(migrated.store.obsidianTemplates[0].contentTemplate, /source_deep_link/);
  const second = ensureClipperTemplate(migrated.store);
  assert.equal(second.changed, false);
  assert.equal(second.store.obsidianTemplates.length, 1);
});

test('resolves target inside vault and blocks traversal', () => {
  const context = buildClipperContext(sampleRecord());
  const result = resolveTargetPath('/tmp/test-vault', CLIPPER_TEMPLATE, context);
  assert.equal(result.relativePath, 'AI划词/学习剪藏.md');
  assert.throws(() => resolveTargetPath('/tmp/test-vault', { ...CLIPPER_TEMPLATE, targetNotePath: '../escape.md' }, context));
});

test('detects both new and legacy duplicate markers and migrates old notes', () => {
  const current = `text\n${recordMarker('rec-1')}\nmore`;
  const legacy = `text\n${legacyRecordMarker('rec-1')}\nmore`;
  assert.equal(containsRecord(current, 'rec-1'), true);
  assert.equal(containsRecord(legacy, 'rec-1'), true);
  assert.equal(containsRecord(current, 'rec-2'), false);
  const migrated = migrateLegacyRecordMarkers(legacy);
  assert.match(migrated, /%% jiaohua-record:rec-1 %%/);
  assert.doesNotMatch(migrated, /<!--/);
});