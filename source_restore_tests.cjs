const test = require('node:test');
const assert = require('node:assert/strict');

const {
  comparableUrl,
  samePage,
  queueRestore,
  currentRestoreFor,
} = require('./electron/source-restore-bridge.cjs');

test('ignores video time parameters when comparing pages', () => {
  assert.equal(
    comparableUrl('https://www.youtube.com/watch?v=abc&t=512s'),
    comparableUrl('https://www.youtube.com/watch?v=abc&t=8s'),
  );
});

test('matches the same YouTube video only', () => {
  assert.equal(samePage(
    'https://www.youtube.com/watch?v=abc&t=512s',
    'https://www.youtube.com/watch?v=abc',
  ), true);
  assert.equal(samePage(
    'https://www.youtube.com/watch?v=abc',
    'https://www.youtube.com/watch?v=xyz',
  ), false);
});

test('matches ordinary page despite text fragment', () => {
  assert.equal(samePage(
    'https://example.com/article#:~:text=hello',
    'https://example.com/article',
  ), true);
});

test('queues and returns a restore only for its page', () => {
  const queued = queueRestore({
    id: 'rec-1',
    sourceLocation: {
      type: 'web',
      url: 'https://example.com/article',
      anchor: { selectedText: 'hello', scrollRatio: 0.4 },
    },
  });
  assert.ok(queued.id);
  assert.equal(currentRestoreFor('https://example.com/article')?.recordId, 'rec-1');
  assert.equal(currentRestoreFor('https://example.com/other'), null);
});
