const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const main = fs.readFileSync('electron/main.cjs', 'utf8');
const helper = fs.readFileSync('tools/clipboard-helper.cs', 'utf8');
const engine = fs.readFileSync('electron/selection-engine.cjs', 'utf8');

test('clipboard capture restores only while it still owns the clipboard', () => {
  assert.match(helper, /sequenceBeforeRestore == sequenceAfter/);
  assert.match(helper, /WriteClipboardTextSafe\(previousText/);
  assert.match(helper, /clipboard_changed_by_other_owner/);
});

test('clipboard captures are serialized and stale queued captures are skipped', () => {
  assert.match(engine, /clipboardV2Tail = Promise\.resolve\(\)/);
  assert.match(engine, /await previous/);
  assert.match(engine, /superseded_before_clipboard_capture/);
});

test('an older result run cannot publish or save under the newer run id', () => {
  assert.match(main, /const thisAbortController = new AbortController\(\)/);
  assert.match(main, /currentRunId !== thisRunId/);
  assert.match(main, /result:update', \{ \.\.\.record, runId: thisRunId \}/);
  assert.doesNotMatch(main, /callModelStreaming\([\s\S]{0,800}currentAbortController\.signal, currentRunId\)/);
  assert.match(main, /callbackRunId !== thisRunId/);
});
