const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, 'electron', 'main.cjs'), 'utf8');
const rendererSource = fs.readFileSync(path.join(__dirname, 'src', 'App.tsx'), 'utf8');

test('appearance changes are persisted by the main process', () => {
  const handlerStart = mainSource.indexOf("ipcMain.handle('appearance:set'");
  const handlerEnd = mainSource.indexOf('// ─── Hotkey config IPC', handlerStart);
  const handler = mainSource.slice(handlerStart, handlerEnd);

  assert.ok(handlerStart >= 0, 'appearance IPC handler should exist');
  assert.match(handler, /nativeTheme\.themeSource = normalized/);
  assert.match(handler, /writeAppearanceMode\(normalized\)/);
});

test('saved native appearance is restored before the main window is created', () => {
  const readyStart = mainSource.indexOf('app.whenReady().then(() => {');
  const readyEnd = mainSource.indexOf("app.on('window-all-closed'", readyStart);
  const startup = mainSource.slice(readyStart, readyEnd);
  const restoreIndex = startup.indexOf('nativeTheme.themeSource = readAppearanceMode()');
  const createWindowIndex = startup.indexOf('createMainWindow()');

  assert.ok(readyStart >= 0, 'ready handler should exist');
  assert.ok(restoreIndex >= 0, 'saved appearance should be restored at startup');
  assert.ok(createWindowIndex >= 0, 'main window should be created at startup');
  assert.ok(restoreIndex < createWindowIndex, 'appearance must be restored before BrowserWindow creation');
});

test('legacy renderer-only appearance is migrated to the main process', () => {
  const bootstrapStart = rendererSource.indexOf('function useAppearanceBootstrap()');
  const bootstrapEnd = rendererSource.indexOf('function MainView()', bootstrapStart);
  const bootstrap = rendererSource.slice(bootstrapStart, bootstrapEnd);

  assert.ok(bootstrapStart >= 0, 'appearance bootstrap should exist');
  assert.match(bootstrap, /desktopApi\.setAppearance\(getStoredAppearance\(\)\)/);
});
