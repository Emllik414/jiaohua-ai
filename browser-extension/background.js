// background.js - MV3 service worker with Edge/Chrome recovery
const VERSION = '1.3.4';
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
    // Inject the extension files directly into the isolated world. The previous
    // inline <script> approach could be blocked by page CSP in Edge.
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [
        'native-cc-segmentation.js',
        'subtitle-placement-anchor.js',
        'caption-text-stabilizer.js',
        'content.js',
        'caption-layout-controller.js',
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

async function ensureTabAlive(tabId, url) {
  if (!tabId || !isInjectableUrl(url)) return false;
  if (await pingTab(tabId)) return true;
  if (!(await injectTab(tabId))) return false;

  // executeScript resolves after injection; ping once more to verify the
  // content script really started instead of assuming success.
  const alive = await pingTab(tabId);
  if (!alive) {
    console.warn('[AISel-BG] content script did not answer after injection', tabId);
  }
  return alive;
}

async function scanAllTabs() {
  try {
    const tabs = await chrome.tabs.query({
      url: ['http://*/*', 'https://*/*'],
    });
    await Promise.allSettled(
      tabs
        .filter((tab) => tab.id && tab.url && isInjectableUrl(tab.url))
        .map((tab) => ensureTabAlive(tab.id, tab.url)),
    );
  } catch (error) {
    console.warn('[AISel-BG] scan tabs failed', error?.message || error);
  }
}

async function ensureAlarm() {
  try {
    const alarm = await chrome.alarms.get(ALARM_NAME);
    if (!alarm) {
      chrome.alarms.create(ALARM_NAME, {
        periodInMinutes: ALARM_PERIOD_MINUTES,
      });
    }
  } catch (error) {
    console.warn('[AISel-BG] alarm setup failed', error?.message || error);
  }
}

async function initialize(reason) {
  console.log(`[AISel-BG] initialize ${reason} v${VERSION}`);
  await ensureAlarm();
  await scanAllTabs();
}

chrome.runtime.onInstalled.addListener(() => {
  initialize('installed').catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  initialize('startup').catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    scanAllTabs().catch(() => {});
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && isInjectableUrl(tab.url)) {
    ensureTabAlive(tabId, tab.url).catch(() => {});
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url && isInjectableUrl(tab.url)) {
      await ensureTabAlive(tabId, tab.url);
    }
  } catch (_) {}
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0 && isInjectableUrl(details.url)) {
    ensureTabAlive(details.tabId, details.url).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  aliveTabs.delete(tabId);
});

// Also run once whenever Edge/Chrome wakes this service worker after reload.
initialize('worker-wakeup').catch(() => {});
console.log(`[AISel-BG] ready v${VERSION}`);