const { app, BrowserWindow, clipboard, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ONBOARDING_STATE_FILE = 'browser-extension-onboarding.json';

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function extensionSourceDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'browser-extension')
    : path.join(__dirname, '..', 'browser-extension');
}

function extensionTargetDir() {
  return path.join(app.getPath('userData'), 'browser-extension');
}

function onboardingStatePath() {
  return path.join(app.getPath('userData'), ONBOARDING_STATE_FILE);
}

function manifestVersion(directory) {
  const manifest = readJson(path.join(directory, 'manifest.json'), null);
  return manifest && typeof manifest.version === 'string' ? manifest.version : '';
}

function ensureStableExtensionBundle() {
  const source = extensionSourceDir();
  const target = extensionTargetDir();
  const sourceManifest = path.join(source, 'manifest.json');

  if (!fs.existsSync(sourceManifest)) {
    throw new Error(`浏览器插件资源不存在：${sourceManifest}`);
  }

  const sourceVersion = manifestVersion(source);
  const targetVersion = manifestVersion(target);
  if (!fs.existsSync(target) || !sourceVersion || targetVersion !== sourceVersion) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, force: true });
  }

  return {
    directory: target,
    manifestPath: path.join(target, 'manifest.json'),
    version: sourceVersion || manifestVersion(target) || 'unknown',
  };
}

function firstVisibleWindow() {
  return BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.isVisible()) || null;
}

async function showMessage(options) {
  const parent = firstVisibleWindow();
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

function browserCandidates() {
  const programFiles = process.env.PROGRAMFILES || '';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  return [
    {
      name: 'Microsoft Edge',
      url: 'edge://extensions/',
      paths: [
        path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ],
    },
    {
      name: 'Google Chrome',
      url: 'chrome://extensions/',
      paths: [
        path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ],
    },
  ];
}

function openBrowserExtensionManager() {
  for (const browser of browserCandidates()) {
    const executable = browser.paths.find((candidate) => candidate && fs.existsSync(candidate));
    if (!executable) continue;
    try {
      const child = spawn(executable, [browser.url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref();
      return browser;
    } catch (_) {}
  }
  return null;
}

function installationText(extensionDirectory) {
  return [
    '饺滑浏览器插件安装步骤',
    '',
    '1. Edge 地址栏输入：edge://extensions/',
    '   Chrome 地址栏输入：chrome://extensions/',
    '2. 开启“开发人员模式”或“开发者模式”。',
    '3. 点击“加载解压缩的扩展”或“加载已解压的扩展程序”。',
    `4. 选择插件目录：${extensionDirectory}`,
    '5. 刷新普通网页后，重新划选文字测试。',
    '',
    '注意：edge://、chrome://、浏览器扩展商店等受保护页面不能运行普通扩展。',
  ].join('\n');
}

async function showInstallationSteps(bundle) {
  const instructions = installationText(bundle.directory);
  const result = await showMessage({
    type: 'info',
    title: '浏览器插件安装步骤',
    message: '请在 Edge 或 Chrome 中加载饺滑浏览器插件',
    detail: instructions,
    buttons: ['打开插件目录', '复制安装步骤', '关闭'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });

  if (result.response === 0) {
    shell.showItemInFolder(bundle.manifestPath);
  } else if (result.response === 1) {
    clipboard.writeText(instructions);
  }
}

async function runBrowserExtensionOnboarding() {
  let bundle;
  try {
    bundle = ensureStableExtensionBundle();
  } catch (error) {
    await showMessage({
      type: 'error',
      title: '浏览器插件资源缺失',
      message: '未能准备浏览器插件文件',
      detail: String(error && error.message ? error.message : error),
      buttons: ['关闭'],
      noLink: true,
    });
    return;
  }

  const stateFile = onboardingStatePath();
  const state = readJson(stateFile, {});
  if (state.confirmedExtensionVersion === bundle.version) return;

  const result = await showMessage({
    type: 'info',
    title: '首次使用：安装浏览器插件',
    message: '还差一步，安装浏览器插件后网页划词会更准确',
    detail: '软件已经把插件导出到稳定目录。点击“立即安装”后，会打开 Edge 或 Chrome 的扩展管理页，并定位插件文件夹。整个过程不需要联网，也不会自动修改浏览器。',
    buttons: ['立即安装', '查看安装步骤', '稍后提醒', '我已安装'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });

  const nextState = {
    ...state,
    extensionVersion: bundle.version,
    appVersion: app.getVersion(),
    lastPromptAt: new Date().toISOString(),
  };

  if (result.response === 0) {
    const browser = openBrowserExtensionManager();
    shell.showItemInFolder(bundle.manifestPath);
    if (!browser) {
      clipboard.writeText('edge://extensions/');
    }
    writeJson(stateFile, { ...nextState, lastAction: 'install' });
    await showInstallationSteps(bundle);
    return;
  }

  if (result.response === 1) {
    writeJson(stateFile, { ...nextState, lastAction: 'instructions' });
    await showInstallationSteps(bundle);
    return;
  }

  if (result.response === 3) {
    writeJson(stateFile, {
      ...nextState,
      confirmedExtensionVersion: bundle.version,
      confirmedAt: new Date().toISOString(),
      lastAction: 'confirmed',
    });
    return;
  }

  writeJson(stateFile, { ...nextState, lastAction: 'remind-later' });
}

// Install controllers before main.cjs registers IPC handlers and creates windows.
require('./result-window-stability.cjs').install();
require('./skill-shortcut-runtime.cjs').install();

// Keep the existing application logic unchanged. This wrapper only adds
// browser-extension delivery and first-run onboarding around it.
require('./main.cjs');

app.whenReady().then(() => {
  setTimeout(() => {
    void runBrowserExtensionOnboarding();
  }, 1800);
});
