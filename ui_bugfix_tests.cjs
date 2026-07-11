const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, ...parts), 'utf8');
const appSource = read('src', 'App.tsx');
const cssSource = read('src', 'App.css');
const mainSource = read('electron', 'main.cjs');

test('history template picker is compact, scrollbar-free, and has a scroll affordance', () => {
  assert.match(cssSource, /\.history-template-options\s*\{[\s\S]*?max-height:\s*min\(160px/);
  assert.match(cssSource, /\.history-template-options::\-webkit-scrollbar\s*\{[^}]*display:\s*none/);
  assert.match(cssSource, /scrollbar-width:\s*none/);
  assert.match(appSource, /history-template-scroll-hint/);
  assert.match(appSource, /templateCanScrollDown/);
  assert.match(appSource, /templateOptionsRef\.current\?\.scrollTo/);
});

test('stream toggle is shown only for the adapter that currently parses streaming events', () => {
  assert.match(appSource, /supportsStreaming\s*=\s*preset\.apiType\s*===\s*'openai-compatible-chat'/);
  assert.match(appSource, /\{supportsStreaming\s*\?\s*\(/);
  assert.match(mainSource, /stream:\s*provider\.apiType\s*===\s*'openai-compatible-chat'\s*&&\s*provider\.stream/);
  assert.match(mainSource, /if \(p\.stream !== undefined\) existing\.stream = p\.stream/);
  assert.match(mainSource, /body = \{ model, messages:[\s\S]*?stream \}/);
});

test('result records snapshot the skill icon and live skill updates reach the result window', () => {
  const snapshots = mainSource.match(/skillIconKey:\s*skill\.iconKey\s*\|\|\s*getIconKeyFromLegacy/g) || [];
  assert.equal(snapshots.length, 3);
  assert.match(mainSource, /resultWindow\.webContents\.send\('skills:updated', payload\)/);
  assert.match(appSource, /skillIconKey=\{normalizeIconKey\(record\.skillIconKey\)\}/);
  assert.match(appSource, /onSkillsUpdated\(\(payload\)[\s\S]*?current\.skillId/);
});

