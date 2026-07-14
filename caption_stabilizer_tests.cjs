const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadCaptionStabilizerApi() {
  const filename = path.join(__dirname, 'browser-extension', 'caption-text-stabilizer.js');
  const code = fs.readFileSync(filename, 'utf8');
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(code, sandbox, { filename });
  return sandbox.module.exports;
}

const {
  normalizeText,
  endsSentence,
  isMeaningfulChunk,
  formatCaption,
  createState,
  nextDelay,
} = loadCaptionStabilizerApi();

test('normalizes whitespace without changing punctuation', () => {
  assert.equal(normalizeText('  I   think\nwe should leave.  '), 'I think we should leave.');
});

test('detects sentence endings in English and Chinese', () => {
  assert.equal(endsSentence('Are you ready?'), true);
  assert.equal(endsSentence('我们现在走。'), true);
  assert.equal(endsSentence('I think we should'), false);
});

test('does not treat one or two English words as a meaningful initial chunk', () => {
  assert.equal(isMeaningfulChunk('I'), false);
  assert.equal(isMeaningfulChunk('I think'), false);
  assert.equal(isMeaningfulChunk('I think we'), true);
});

test('formats a long English caption into two balanced phrase lines', () => {
  const result = formatCaption('I really wanted to tell you what happened, but I did not know how to explain it');
  const lines = result.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /happened,$/);
  assert.ok(lines[0].split(/\s+/).length >= 4);
  assert.ok(lines[1].split(/\s+/).length >= 4);
});

test('formats a long Chinese caption into two non-empty lines', () => {
  const result = formatCaption('我一直想告诉你发生了什么，但是我不知道应该怎么解释这件事情');
  const lines = result.split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].length >= 6);
  assert.ok(lines[1].length >= 6);
});

test('uses a short delay for terminal punctuation', () => {
  const state = createState({ hostname: 'www.youtube.com' });
  state.pendingSince = 1000;
  const delay = nextDelay(state, 'I think we should leave.', 1020);
  assert.equal(delay, 70);
});

test('holds one-word captions until the maximum wait', () => {
  const state = createState({ hostname: 'www.youtube.com' });
  state.pendingSince = 1000;
  assert.equal(nextDelay(state, 'I', 1000), 600);
});

test('caps progressive caption waiting at the maximum delay', () => {
  const state = createState({ hostname: 'www.youtube.com' });
  state.pendingSince = 1000;
  const delay = nextDelay(state, 'I think', 1590);
  assert.equal(delay, 10);
});

test('uses faster stabilization on Bilibili', () => {
  const state = createState({ hostname: 'www.bilibili.com' });
  state.pendingSince = 1000;
  assert.equal(nextDelay(state, '这是一条完整字幕', 1010), 90);
});