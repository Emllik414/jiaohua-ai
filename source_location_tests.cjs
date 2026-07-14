const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanUrl,
  formatVideoTime,
  buildOpenUrl,
  normalizeSourceLocation,
  attachRecordLinks,
  sourceMatchesSelection,
} = require('./electron/source-location.cjs');

test('cleans tracking parameters and redacts secret values', () => {
  const cleaned = cleanUrl('https://example.com/read?id=7&utm_source=test&token=secret&fbclid=x');
  const url = new URL(cleaned);
  assert.equal(url.searchParams.get('id'), '7');
  assert.equal(url.searchParams.has('utm_source'), false);
  assert.equal(url.searchParams.has('fbclid'), false);
  assert.equal(url.searchParams.get('token'), '[redacted]');
});

test('rejects unsafe schemes', () => {
  assert.equal(cleanUrl('file:///c:/secret.txt'), '');
  assert.equal(cleanUrl('chrome://settings'), '');
  assert.equal(cleanUrl('javascript:alert(1)'), '');
});

test('formats video time', () => {
  assert.equal(formatVideoTime(512.9), '8:32');
  assert.equal(formatVideoTime(3672), '1:01:12');
  assert.equal(formatVideoTime(-1), '');
});

test('builds YouTube and Bilibili seek links with lead-in', () => {
  const youtube = buildOpenUrl({
    type: 'subtitle',
    url: 'https://www.youtube.com/watch?v=abc',
    hostname: 'www.youtube.com',
    video: { platform: 'youtube', currentTime: 512.4 },
  });
  assert.equal(new URL(youtube).searchParams.get('t'), '510s');

  const exactYoutube = buildOpenUrl({
    type: 'subtitle',
    url: 'https://www.youtube.com/watch?v=abc',
    hostname: 'www.youtube.com',
    video: { platform: 'youtube', currentTime: 512.4 },
  }, { leadSeconds: 0 });
  assert.equal(new URL(exactYoutube).searchParams.get('t'), '512s');

  const bilibili = buildOpenUrl({
    type: 'subtitle',
    url: 'https://www.bilibili.com/video/BV1xx',
    hostname: 'www.bilibili.com',
    video: { platform: 'bilibili', currentTime: 12 },
  });
  assert.equal(new URL(bilibili).searchParams.get('t'), '10');
});

test('builds browser text fragment for ordinary web selections', () => {
  const result = buildOpenUrl({
    type: 'web',
    url: 'https://example.com/article',
    anchor: {
      selectedText: 'cognitive load',
      prefixText: 'reduce unnecessary',
      suffixText: 'for the user',
    },
  });
  assert.match(result, /#:~:text=/);
  assert.match(decodeURIComponent(result), /cognitive load/);
});

test('normalizes source location and limits context size', () => {
  const result = normalizeSourceLocation({
    type: 'web',
    url: 'https://example.com/?utm_campaign=x',
    title: '  Example   page ',
    anchor: {
      selectedText: 'word',
      prefixText: 'a'.repeat(140),
      suffixText: 'b'.repeat(140),
      scrollRatio: 1.5,
    },
  });
  assert.equal(result.title, 'Example page');
  assert.equal(result.anchor.prefixText.length, 100);
  assert.equal(result.anchor.suffixText.length, 100);
  assert.equal(result.anchor.scrollRatio, 1);
  assert.equal(new URL(result.url).searchParams.has('utm_campaign'), false);
});

test('attaches a browser open link without a custom protocol deep link', () => {
  const record = attachRecordLinks({ id: 'record 1', selectedText: 'hello' }, {
    type: 'web',
    url: 'https://example.com',
    hostname: 'example.com',
    anchor: { selectedText: 'hello' },
  });
  assert.equal(Object.hasOwn(record.sourceLocation, 'deepLink'), false);
  assert.match(record.sourceLocation.openUrl, /^https:\/\/example\.com/);
  assert.equal(record.sourceLocation.siteName, 'example.com');
});

test('matches equivalent selection payloads', () => {
  assert.equal(sourceMatchesSelection({ text: 'out of the blue' }, 'out of the blue'), true);
  assert.equal(sourceMatchesSelection({ text: 'a longer selected phrase' }, 'selected phrase'), true);
  assert.equal(sourceMatchesSelection({ text: 'apple' }, 'orange'), false);
});