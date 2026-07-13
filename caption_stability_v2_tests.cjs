const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeText,
  suffixPrefixOverlap,
  relatedCaption,
  createPolicy,
  nextCommitDelay,
  trimDisplayWindow,
  layoutCaption,
} = require('./browser-extension/caption-stability-v2.js');

test('normalizes whitespace without changing punctuation', () => {
  assert.equal(normalizeText('  I   think\nwe should leave.  '), 'I think we should leave.');
});

test('detects rolling-window overlap', () => {
  assert.equal(
    suffixPrefixOverlap('I think we should leave now', 'we should leave now because it is late'),
    4,
  );
  assert.equal(
    relatedCaption('I think we should leave now', 'we should leave now because it is late'),
    true,
  );
});

test('distinguishes unrelated caption cues', () => {
  assert.equal(relatedCaption('I think we should leave', 'The next morning was quiet'), false);
});

test('waits for a meaningful English phrase but commits sentence endings quickly', () => {
  const policy = createPolicy('www.youtube.com');
  const start = 1000;
  const shortState = { policy, pendingSince: start, cueSwitched: false };
  assert.equal(nextCommitDelay(shortState, 'I think', start + 100), 800);

  const sentenceState = { policy, pendingSince: start, cueSwitched: false };
  assert.equal(nextCommitDelay(sentenceState, 'I think we should leave.', start + 100), 80);
});

test('uses a shorter delay for a complete replacement cue', () => {
  const policy = createPolicy('www.youtube.com');
  const state = { policy, pendingSince: 1000, cueSwitched: true };
  assert.equal(nextCommitDelay(state, 'The next morning was quiet', 1050), 140);
});

test('limits long English display windows without duplicating rolling text', () => {
  const policy = createPolicy('www.youtube.com');
  const result = trimDisplayWindow(
    'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen',
    policy,
  );
  assert.ok(result.split(/\s+/).length <= 16);
  assert.equal(result.endsWith('seventeen eighteen'), true);
});

test('prefers punctuation when splitting two visual lines', () => {
  const result = layoutCaption(
    'I wanted to tell you, but I did not know how to explain it',
    { maxWidth: 20 },
  );
  assert.match(result.display, /,\n(?:but|\s*but)/i);
});

test('keeps a previous valid line break while a phrase grows', () => {
  const first = layoutCaption('I really wanted to tell you what happened', { maxWidth: 16 });
  assert.notEqual(first.breakIndex, null);

  const grown = layoutCaption(
    'I really wanted to tell you what happened but I could not',
    { maxWidth: 16, previous: first },
  );
  assert.equal(grown.breakIndex, first.breakIndex);
});

test('keeps short captions on one line', () => {
  const result = layoutCaption('Thank you.', { maxWidth: 40 });
  assert.equal(result.display, 'Thank you.');
  assert.equal(result.breakIndex, null);
});
