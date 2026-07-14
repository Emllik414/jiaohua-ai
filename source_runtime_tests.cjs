const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSelectionBody,
  sourceSnapshotForSelection,
} = require('./electron/source-obsidian-runtime.cjs');

test('parses browser selection payloads', () => {
  const result = parseSelectionBody(JSON.stringify({
    text: 'out of the blue',
    sourceLocation: { type: 'web', url: 'https://example.com' },
  }));
  assert.equal(result.text, 'out of the blue');
  assert.equal(result.sourceLocation.type, 'web');
});

test('rejects invalid selection JSON', () => {
  assert.equal(parseSelectionBody('{bad json'), null);
  assert.equal(parseSelectionBody('null'), null);
});

test('does not return a source snapshot before browser selection capture', () => {
  assert.equal(sourceSnapshotForSelection('not captured'), null);
});