const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadCaptionApi() {
  const filename = path.join(__dirname, 'browser-extension', 'caption-stability-v2.js');
  const code = fs.readFileSync(filename, 'utf8');
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    setTimeout,
    clearTimeout,
    AbortController,
  };
  vm.runInNewContext(code, sandbox, { filename });
  return sandbox.module.exports;
}

const {
  normalizeText,
  suffixPrefixOverlap,
  relatedCaption,
  createPolicy,
  nextCommitDelay,
  trimDisplayWindow,
  layoutCaption,
  computeContainedVideoRect,
  clampBottomRatio,
  bottomRatioToPlayerBottom,
  dragBottomRatio,
} = loadCaptionApi();

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
  const previous = {
    text: 'I really wanted to tell you what happened',
    display: 'I really wanted to\ntell you what happened',
    breakIndex: 4,
  };

  const grown = layoutCaption(
    'I really wanted to tell you what happened today',
    { maxWidth: 16, previous },
  );
  assert.equal(grown.breakIndex, previous.breakIndex);
});

test('keeps short captions on one line', () => {
  const result = layoutCaption('Thank you.', { maxWidth: 40 });
  assert.equal(result.display, 'Thank you.');
  assert.equal(result.breakIndex, null);
});

test('calculates actual video content when the element has side bars', () => {
  const rect = { left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500 };
  const content = computeContainedVideoRect(rect, 4, 3);
  assert.equal(Math.round(content.width), 667);
  assert.equal(Math.round(content.left), 167);
  assert.equal(content.height, 500);
});

test('vertical dragging changes only the bottom ratio', () => {
  const initial = 0.2;
  assert.equal(dragBottomRatio(initial, 40, 400, 40), 0.1);
  assert.ok(Math.abs(dragBottomRatio(initial, -40, 400, 40) - 0.3) < 1e-9);
});

test('zoom keeps the same relative vertical position', () => {
  const playerA = { bottom: 800 };
  const contentA = { bottom: 800, height: 600 };
  const playerB = { bottom: 600 };
  const contentB = { bottom: 600, height: 450 };
  const ratio = 0.12;
  assert.equal(bottomRatioToPlayerBottom(ratio, contentA, playerA), 72);
  assert.equal(bottomRatioToPlayerBottom(ratio, contentB, playerB), 54);
});

test('clamps captions so the whole block remains inside the video', () => {
  assert.equal(clampBottomRatio(-1, 500, 50), 0.03);
  assert.ok(clampBottomRatio(1, 500, 100) <= 0.76);
});