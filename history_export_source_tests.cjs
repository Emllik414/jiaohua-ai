const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sourceDetails,
  renderMarkdown,
  renderText,
  renderWord,
} = require('./electron/history-export.cjs');

function record() {
  return {
    id: 'rec-1',
    createdAt: '2026-07-14T09:30:00.000Z',
    skillName: '翻译',
    selectedText: 'out of the blue',
    answerMarkdown: '**突然地**，出乎意料地。',
    model: 'model-x',
    sourceApp: 'Chrome',
    sourceLocation: {
      type: 'subtitle',
      url: 'https://www.youtube.com/watch?v=abc',
      hostname: 'www.youtube.com',
      title: 'How to Speak English Naturally',
      siteName: 'YouTube',
      videoTime: '8:32',
      video: { platform: 'youtube', currentTime: 512 },
    },
  };
}

test('describes a saved source location', () => {
  const source = sourceDetails(record());
  assert.equal(source.site, 'YouTube');
  assert.equal(source.time, '8:32');
  assert.match(source.url, /t=512s/);
});

test('includes sources in Markdown and text exports', () => {
  const markdown = renderMarkdown([record()], 'Export');
  assert.match(markdown, /原始位置：\[YouTube · How to Speak English Naturally · 8:32\]/);
  assert.match(markdown, /youtube\.com/);

  const text = renderText([record()], 'Export');
  assert.match(text, /原始位置：YouTube · 8:32/);
  assert.match(text, /来源链接：https:\/\/www\.youtube\.com/);
});

test('renders a Word document with an external source hyperlink', async () => {
  const buffer = await renderWord([record()], 'Export');
  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length > 500);
});
