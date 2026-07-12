const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, 'src', 'App.tsx'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, 'electron', 'main.cjs'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, 'electron', 'preload.cjs'), 'utf8');

test('history header keeps the five required actions in order', () => {
  const start = appSource.indexOf('<div className="history-batch-actions">');
  const end = appSource.indexOf('</div>\n          </div>', start);
  const actions = appSource.slice(start, end);
  const labels = ['选择', '删除', '全部折叠', '导出', '导入 Obsidian'];
  let previous = -1;
  labels.forEach((label) => {
    const index = actions.indexOf(label);
    assert.ok(index > previous, `${label} should appear in the required order`);
    previous = index;
  });
});

test('export and batch Obsidian APIs cross the context-isolated preload boundary', () => {
  assert.match(preloadSource, /history-export:choose-directory/);
  assert.match(preloadSource, /history-export:write/);
  assert.match(preloadSource, /obsidian:notes:save-many/);
  assert.match(mainSource, /ipcMain\.handle\('history-export:choose-directory'/);
  assert.match(mainSource, /ipcMain\.handle\('history-export:write'/);
  assert.match(mainSource, /ipcMain\.handle\('obsidian:notes:save-many'/);
});

test('conversation changes clear selection and transient history UI', () => {
  const historyStart = appSource.indexOf('function HistoryPanel(');
  const historyEnd = appSource.indexOf('function HistoryExportDrawer(', historyStart);
  const historyPanel = appSource.slice(historyStart, historyEnd);
  const effect = historyPanel.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[activeConversationId\]\)/)?.[0] || '';
  assert.match(effect, /setSelectedIds\(new Set\(\)\)/);
  assert.match(effect, /setTplOpen\(false\)/);
  assert.match(effect, /setExportOpen\(false\)/);
  assert.match(historyPanel, /operationConversationRef\.current !== operationConversationId/);
});
