// background.js - MV3 service worker with Edge/Chrome recovery
const VERSION = '1.4.1';
const PING_TIMEOUT_MS = 800;
const ALARM_NAME = 'aisel-scan-tabs';
const ALARM_PERIOD_MINUTES = 1;

const SKIPPED_SCHEMES = [
  'chrome://',
  'edge://',
  'brave://',
  'about:',
  'chrome-extension://',
  'edge-extension://',
  'file://',
  'moz-extension://',
];
const SKIPPED_HOSTS = [
  'chrome.google.com',
  'chromewebstore.google.com',
  'microsoftedge.microsoft.com',
];

const aliveTabs = new Map();

function isInjectableUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (SKIPPED_SCHEMES.some((scheme) => url.startsWith(scheme))) return false;

  try {
    if (SKIPPED_HOSTS.includes(new URL(url).hostname)) return false;
  } catch (_) {
    return false;
  }

  return url.startsWith('http://') || url.startsWith('https://');
}

async function pingTab(tabId) {
  let timer;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), PING_TIMEOUT_MS);
    });
    const response = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'AISEL_PING' }),
      timeout,
    ]);

    if (response && response.type === 'AISEL_PONG') {
      aliveTabs.set(tabId, {
        lastConfirmedAt: Date.now(),
        href: response.href || '',
      });
      return true;
    }
  } catch (_) {
    // A missing receiver is expected on tabs opened before the extension loaded.
  } finally {
    clearTimeout(timer);
  }

  aliveTabs.delete(tabId);
  return false;
}

async function injectTab(tabId) {
  try {
    // Inject files in the same order as manifest.json. The unified stability
    // controller runs after content.js so it can take ownership of the created
    // caption node without patching Node.prototype globally.
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [
        'native-cc-segmentation.js',
        'subtitle-placement-anchor.js',
        'content.js',
        'caption-stability-v2.js',
      ],
      world: 'ISOLATED',
    });
    return true;
  } catch (error) {
    const message = String(error?.message || error || '');
    if (
      !message.includes('Cannot access') &&
      !message.includes('frame is not') &&
      !message.includes('The extensions gallery cannot be scripted')
    ) {
      console.warn('[AISel-BG] inject fail tab', tabId, message);
    }
    return false;
  }
}

async function ensureTab(tab) {
  if (!tab?.id || !isInjectableUrl(tab.url)) return;
  const alive = await pingTab(tab.id);
  if (!alive) await injectTab(tab.id);
}

async function scanTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(ensureTab));
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
  void scanTabs();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
  void scanTabs();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void scanTabs();
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') void ensureTab(tab);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) {
    chrome.tabs.get(details.tabId).then(ensureTab).catch(() => {});
  }
});

void scanTabs();

console.log('[AISel-BG] service worker', VERSION);
