const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sanitizeFileName, exportHistoryRecords } = require('./electron/history-export.cjs');

const records = [{
  id: 'record-1',
  createdAt: '2026-07-11T12:00:00.000Z',
  skillName: '翻译',
  selectedText: 'Hello',
  answerMarkdown: '**你好**',
  model: 'deepseek-chat',
  sourceApp: 'Chrome',
}];

test('Windows-invalid filename characters are sanitized', () => {
  assert.equal(sanitizeFileName('报告: 7/11?'), '报告_ 7_11_');
  assert.equal(sanitizeFileName('CON'), '_CON');
});

test('same-name exports receive numeric suffixes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jiaohua-export-'));
  try {
    const first = await exportHistoryRecords({ records, format: 'markdown', fileName: '历史', directory });
    const second = await exportHistoryRecords({ records, format: 'markdown', fileName: '历史', directory });
    assert.equal(path.basename(first), '历史.md');
    assert.equal(path.basename(second), '历史 (1).md');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Markdown, TXT and Word exports contain real format data', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jiaohua-export-'));
  try {
    const markdown = await exportHistoryRecords({ records, format: 'markdown', fileName: 'Markdown', directory });
    const txt = await exportHistoryRecords({ records, format: 'txt', fileName: 'Text', directory });
    const word = await exportHistoryRecords({ records, format: 'word', fileName: 'Word', directory });
    assert.match(fs.readFileSync(markdown, 'utf8'), /### AI 结果/);
    assert.match(fs.readFileSync(txt, 'utf8'), /AI 结果：/);
    assert.doesNotMatch(fs.readFileSync(txt, 'utf8'), /\*\*你好\*\*/);
    assert.equal(fs.readFileSync(word).subarray(0, 2).toString('ascii'), 'PK');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
