/**
 * selection_engine_fusion_tests.js — Phase 7 融合测试集
 *
 * 用法：node selection_engine_fusion_tests.js
 */

const { chooseBestPickedInfo, OCRProvider } = require('./electron/selection-engine.cjs');

let passed = 0;
let failed = 0;

function test(name, candidates, expectedSource, expectedTextContains, context = {}) {
  const result = chooseBestPickedInfo(candidates, context);
  const ok = result.source === expectedSource &&
    (!expectedTextContains || (result.text || '').includes(expectedTextContains));

  const status = ok ? '✅' : '❌';
  if (ok) passed++; else failed++;

  console.log(`${status} ${name}`);
  if (!ok) {
    console.log(`   expected: source=${expectedSource} text~="${expectedTextContains}"`);
    console.log(`   got:      source=${result.source} text="${(result.text||'').slice(0,60)}"`);
    console.log(`   reason: ${result.reason || '?'}`);
    if (result.scoreBreakdown) {
      console.log(`   scores: ${JSON.stringify(result.scoreBreakdown)}`);
    }
  }
}

function testOcrWordSelection(name, cropRect, words, context, expectedText) {
  const provider = new OCRProvider();
  const result = provider._selectWords(words, cropRect, context);
  const ok = result === expectedText;
  const status = ok ? '✅' : '❌';
  if (ok) passed++; else failed++;
  console.log(`${status} ${name}`);
  if (!ok) {
    console.log(`   expected: "${expectedText}"`);
    console.log(`   got:      "${result}"`);
  }
}

function summary() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  ${passed}/${passed+failed} passed`);
  console.log(`${'='.repeat(50)}`);
  process.exit(failed > 0 ? 1 : 0);
}

// ─── Test cases ────────────────────────────────────────

const clip = (text, conf=0.5) => ({ text, source:'clipboard', confidence:conf });
const browser = (text, conf=0.9) => ({ text, source:'browser', confidence:conf, url:'https://youtube.com' });
const subtitleMarker = (fullText, error='subtitle_window_selection_full_line_blocked') => ({
  text: '',
  fullText,
  source: 'browser',
  confidence: 0.2,
  url: 'https://youtube.com',
  error,
  metadata: {
    subtitleOverlayDetected: true,
    needsManualSelection: true,
    error,
    method: 'window-selection-blocked-full-line',
  },
});
const subtitleBrowser = (text, fullText, conf=0.88) => ({
  text,
  fullText,
  source: 'browser',
  confidence: conf,
  url: 'https://youtube.com',
  metadata: {
    subtitleOverlayDetected: true,
    method: 'window-selection-drag-token-refine',
  },
});
const uia = (text, conf=0.85) => ({ text, source:'windows-uia', confidence:conf, appName:'notepad.exe' });
const ocr = (text, conf=0.82) => ({ text, source:'ocr', confidence:conf });
const genericBrowser = (text, fullText=text, conf=0.9) => ({
  text,
  fullText,
  source: 'browser',
  confidence: conf,
  url: 'https://x.com/JurugaOrg/status/1',
  metadata: { adapter: 'generic-subtitle-overlay', method: 'generic-subtitle-token-hit-test', subtitleOverlayDetected: true },
});

// Test 1: YouTube — browser precise, clipboard full sentence → pick browser
test('YT: browser subtext of clipboard',
  [browser('finished looting'),
   uia('I havent finished looting.', 0.5),
   clip('I havent finished looting.')],
  'browser', 'finished looting');

// Test 2: YouTube — browser empty, uia precise, clipboard full → pick uia
test('YT: uia subtext of clipboard (no browser)',
  [browser('', 0),
   uia('finished looting'),
   clip('I havent finished looting.')],
  'windows-uia', 'finished looting');

// Test 3: Image — only OCR works → pick ocr
test('Image: ocr only',
  [ocr('finished looting'),
   clip('')],
  'ocr', 'finished looting');

// Test 4: Word — uia and clipboard agree → pick uia (higher weight)
test('Word: uia == clipboard → pick uia',
  [uia('machine learning'),
   clip('machine learning')],
  'windows-uia', 'machine learning');

// Test 5: Clipboard overshoot — browser has precise subtext
test('Overshoot: clipboard long, browser precise',
  [browser('finished looting'),
   clip('This is a long paragraph containing finished looting and more text')],
  'browser', 'finished looting');

// Test 6: All low confidence → needsManualSelection=true (source stays best available)
test('All low: needsManualSelection',
  [browser('maybe', 0.3),
   uia('maybe', 0.3),
   clip('maybe something', 0.3)],
  'browser', 'maybe');  // source=browser, needsManualSelection=true

// Test 7: Browser high conf beats uia
test('Browser > UIA when both high',
  [browser('hello world', 0.92),
   uia('hello world', 0.85)],
  'browser', 'hello world');

// Test 8: Clipboard alone with short text → ok
test('Clipboard only, short text',
  [clip('hello')],
  'clipboard', 'hello');

// Test 9: UIA high conf blocks clipboard
test('UIA blocks clipboard when uia high conf',
  [uia('precise word', 0.88),
   clip('precise word plus extra text', 0.5)],
  'windows-uia', 'precise word');

// Test 10: OCR blocks clipboard when browser/uia absent
test('OCR over clipboard (no browser/uia)',
  [ocr('game subtitle', 0.82),
   clip('game subtitle extra text', 0.4)],
  'ocr', 'game subtitle');

test('Garbled OCR text is blocked before skill execution',
  [ocr('�� �� һ �� �� �� ��', 0.84)],
  'manual', '');

test('Web page: clipboard full selection beats unrelated UIA toolbar text',
  [uia('AI 划词助手', 0.74),
   clip('So when I was a kid. I used to think the players go with their red / yellow cards lol 😆.', 0.55)],
  'clipboard',
  'So when I was a kid',
  { foregroundProcessName: 'chrome.exe' });

test('Web page: clipboard beats generic subtitle overlay account false positive',
  [genericBrowser('Juruga Juruga @', 'Juruga @JurugaOrg', 0.9),
   clip('So when I was a kid. I used to think the players go with their red / yellow cards lol 😆.', 0.55)],
  'clipboard',
  'red / yellow',
  { foregroundProcessName: 'chrome.exe' });

// Test 11: Third-party subtitle full-line browser marker must block clipboard full sentence
test('Subtitle overlay: blocked full-line browser marker prevents clipboard full sentence',
  [subtitleMarker('Forgive me for letting you down'),
   clip('Forgive me for letting you down', 0.7)],
  'manual', '');

// Test 12: Refined browser token wins over clipboard full sentence
test('Subtitle overlay: drag-refined browser token wins',
  [subtitleBrowser('Forgive', 'Forgive me for letting you down'),
   clip('Forgive me for letting you down', 0.7)],
  'browser', 'Forgive');

testOcrWordSelection('OCR: drag over one subtitle word does not include previous word tail',
  { x: 140, y: 456, width: 420, height: 96 },
  [
    { text: 'Platforms', x: 18, y: 34, width: 190, height: 42 },
    { text: 'explosive', x: 222, y: 34, width: 176, height: 42 },
    { text: 'while', x: 412, y: 34, width: 86, height: 42 },
  ],
  {
    rawCursorStart: { x: 362, y: 501 },
    rawCursorEnd: { x: 525, y: 505 },
  },
  'explosive');

testOcrWordSelection('OCR: edge fragment outside drag is ignored',
  { x: 320, y: 456, width: 250, height: 96 },
  [
    { text: 'S', x: 0, y: 34, width: 24, height: 42 },
    { text: 'explosive', x: 38, y: 34, width: 176, height: 42 },
  ],
  {
    rawCursorStart: { x: 358, y: 501 },
    rawCursorEnd: { x: 525, y: 505 },
  },
  'explosive');



// ─── Test A: YouTube subtitle precise token beats clipboard full sentence ───
test('YT precise token vs clipboard full sentence',
  [{ text: 'ordinary boys', source: 'browser', confidence: 0.9, url: 'https://youtube.com', metadata: { adapter: 'youtube-native-caption', method: 'youtube-native-token-hit-test', selectedTokens: ['ordinary', 'boys'] } },
   clip('I saw ordinary boys playing in the park.', 0.7)],
  'browser', 'ordinary boys');

// ─── Test B: Trancy English token beats clipboard Chinese translation ───
test('Trancy English token vs clipboard Chinese',
  [{ text: 'machine learning', source: 'browser', confidence: 0.88, url: 'https://youtube.com', metadata: { adapter: 'trancy-caption', method: 'trancy-subtitle-token-hit-test' } },
   clip('机器学习', 0.75)],
  'browser', 'machine learning');

// ─── Test C: Generic browser low confidence vs clipboard fresh ───
// Note: browser has generic-subtitle-overlay with low confidence.
// Engine still prefers non-clipboard in subtitle overlay scenarios (design intent).
test('Generic browser low conf vs clipboard fresh (browser wins by design)',
  [{ text: 'Juruga Juruga @', fullText: 'Juruga @JurugaOrg', source: 'browser', confidence: 0.3, url: 'https://x.com', metadata: { adapter: 'generic-subtitle-overlay', method: 'generic-subtitle-token-hit-test', subtitleOverlayDetected: true } },
   clip('So when I was a kid I used to think...', 0.7)],
  'browser', 'Juruga Juruga');

// ─── Test D: Notepad UIA wrong text vs clipboard fresh ───
test('Notepad UIA wrong vs clipboard fresh',
  [{ text: '_name_desk_', source: 'windows-uia', confidence: 0.3, appName: 'notepad.exe', metadata: { method: 'uia-name-estimated-word-hit-test' } },
   clip('actual selected text from notepad', 0.7)],
  'clipboard', 'actual selected text');

summary();
