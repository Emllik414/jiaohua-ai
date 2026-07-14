const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CLIPPER_TEMPLATE_ID,
  CLIPPER_TEMPLATE,
  buildSourceLine,
  buildClipperContext,
  renderClipperTemplate,
  ensureClipperTemplate,
  resolveTargetPath,
  recordMarker,
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
      deepLink: 'jiaohua://source/rec-1',
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

test('builds one compact source line', () => {
  const line = buildSourceLine(sampleRecord());
  assert.match(line, /\[!source\]/);
  assert.match(line, /YouTube/);
  assert.match(line, /回到原处/);
  assert.match(line, /8:32/);
  assert.equal(line.split('\n').length, 1);
});

test('prefers local favicon when available', () => {
  const record = sampleRecord();
  record.sourceLocation.faviconVaultPath = '.jiaohua/favicons/youtube.com.png';
  const line = buildSourceLine(record);
  assert.match(line, /!\[\[\.jiaohua\/favicons\/youtube\.com\.png\|16\]\]/);
});

test('builds full template variable context', () => {
  const context = buildClipperContext(sampleRecord());
  assert.equal(context.record_id, 'rec-1');
  assert.equal(context.selection_title, 'out of the blue');
  assert.equal(context.source_site, 'YouTube');
  assert.equal(context.video_seconds, '512');
  assert.equal(context.video_time, '8:32');
  assert.match(context.source_line, /回到原处/);
});

test('renders only title, source, selection and answer', () => {
  const markdown = renderClipperTemplate(CLIPPER_TEMPLATE, sampleRecord());
  assert.match(markdown, new RegExp(recordMarker('rec-1')));
  assert.match(markdown, /^## out of the blue/m);
  assert.match(markdown, /\[!source\]/);
  assert.match(markdown, /> out of the blue/);
  assert.match(markdown, /突然地/);
  assert.doesNotMatch(markdown, /<details>/);
  assert.doesNotMatch(markdown, /使用模型|创建时间|来源信息/);
});

test('adds clipper template only once', () => {
  const first = ensureClipperTemplate({ obsidianTemplates: [] });
  assert.equal(first.changed, true);
  assert.equal(first.store.obsidianTemplates[0].id, CLIPPER_TEMPLATE_ID);
  const second = ensureClipperTemplate(first.store);
  assert.equal(second.changed, false);
  assert.equal(second.store.obsidianTemplates.length, 1);
});

test('resolves target inside vault and blocks traversal', () => {
  const context = buildClipperContext(sampleRecord());
  const result = resolveTargetPath('/tmp/test-vault', CLIPPER_TEMPLATE, context);
  assert.equal(result.relativePath, 'AI划词/学习剪藏.md');
  assert.throws(() => resolveTargetPath('/tmp/test-vault', { ...CLIPPER_TEMPLATE, targetNotePath: '../escape.md' }, context));
});

test('detects duplicate record markers', () => {
  const existing = `text\n${recordMarker('rec-1')}\nmore`;
  assert.equal(containsRecord(existing, 'rec-1'), true);
  assert.equal(containsRecord(existing, 'rec-2'), false);
});
