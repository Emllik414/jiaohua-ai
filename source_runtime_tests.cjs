const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSelectionBody,
  protocolRecordId,
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

test('extracts record ids from Obsidian deep links', () => {
  assert.equal(protocolRecordId('jiaohua://source/rec-123'), 'rec-123');
  assert.equal(protocolRecordId('jiaohua://source/record%20one'), 'record one');
  assert.equal(protocolRecordId('https://example.com/source/rec-123'), '');
});
