const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeWord,
  parseDictionaryPayload,
  mergePronunciationData,
  dictionaryWordFromUrl,
} = require('./electron/pronunciation-live-runtime.cjs');

test('normalizes dictionary lookup keys', () => {
  assert.equal(normalizeWord(' Example '), 'example');
});

test('extracts US and GB IPA from dictionary payload', () => {
  const result = parseDictionaryPayload([{ phonetics: [
    { text: '/ɪɡˈzæmpəl/', audio: 'https://cdn/example-us.mp3' },
    { text: '/ɪɡˈzɑːmpəl/', audio: 'https://cdn/example-uk.mp3' },
  ] }]);
  assert.equal(result.us_ipa, '/ɪɡˈzæmpəl/');
  assert.equal(result.gb_ipa, '/ɪɡˈzɑːmpəl/');
});

test('merges late IPA without changing the pronunciation text', () => {
  const result = mergePronunciationData(
    { mode: 'word', text: 'example', us_ipa: '', gb_ipa: '' },
    { us_ipa: '/us/', gb_ipa: '/gb/' },
  );
  assert.deepEqual(result, {
    mode: 'word',
    text: 'example',
    us_ipa: '/us/',
    gb_ipa: '/gb/',
  });
});

test('recognizes only dictionary API URLs', () => {
  assert.equal(
    dictionaryWordFromUrl('https://api.dictionaryapi.dev/api/v2/entries/en/hello%20world'),
    'hello world',
  );
  assert.equal(dictionaryWordFromUrl('https://example.com/api/v2/entries/en/hello'), '');
});
