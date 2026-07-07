// background.js - service worker with auto-reinjection
const VERSION = '1.2.0';
const PING_TIMEOUT = 800;
const SCAN_INTERVAL = 5000;
const SKIPPED_SCHEMES = ['chrome://', 'edge://', 'brave://', 'about:', 'chrome-extension://', 'file://', 'moz-extension://'];
const SKIPPED_HOSTS = ['chrome.google.com', 'chromewebstore.google.com'];

const aliveTabs = new Map();

chrome.runtime.onInstalled.addListener(() => {
  console.log('[AISel-BG] v' + VERSION);
  setInterval(scanAllTabs, SCAN_INTERVAL);
});

function getContentScriptSource() {
  return fetch(chrome.runtime.getURL('content.js')).then(r => r.text()).catch(e => { console.error(e); return null; });
}

async function pingTab(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'AISEL_PING' });
    if (response && response.type === 'AISEL_PONG') {
      aliveTabs.set(tabId, { lastConfirmedAt: Date.now(), href: response.href || '' });
      return true;
    }
  } catch (e) {}
  aliveTabs.delete(tabId);
  return false;
}

function isInjectableUrl(url) {
  if (!url || typeof url !== 'string') return false;
  for (const scheme of SKIPPED_SCHEMES) { if (url.startsWith(scheme)) return false; }
  try { if (SKIPPED_HOSTS.includes(new URL(url).hostname)) return false; } catch (e) { return false; }
  return url.startsWith('http://') || url.startsWith('https://');
}

async function injectTab(tabId) {
  try {
    const src = await getContentScriptSource();
    if (!src) return false;
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (code) => {
        const s = document.createElement('script');
        s.textContent = code;
        s.id = '__aisel_content_script_loader';
        const old = document.getElementById('__aisel_content_script_loader');
        if (old) old.remove();
        (document.head || document.documentElement).appendChild(s);
        s.remove();
      },
      args: [src],
      world: 'ISOLATED',
    });
    return true;
  } catch (e) {
    if (!e.message?.includes('Cannot access') && !e.message?.includes('frame is not')) {
      console.warn('[AISel-BG] inject fail tab', tabId, e.message);
    }
    return false;
  }
}

async function ensureTabAlive(tabId, url) {
  if (!isInjectableUrl(url)) return;
  if (await pingTab(tabId)) return;
  if (await injectTab(tabId)) {
    aliveTabs.set(tabId, { lastConfirmedAt: Date.now(), href: url });
  }
}

async function scanAllTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    for (const tab of tabs) {
      if (tab.id && tab.url && isInjectableUrl(tab.url)) {
        await ensureTabAlive(tab.id, tab.url);
      }
    }
  } catch (e) {}
}

chrome.tabs.onUpdated.addListener((tabId, ci, tab) => {
  if (tab.url && isInjectableUrl(tab.url) && ci.status === 'complete') {
    ensureTabAlive(tabId, tab.url);
  }
});

chrome.tabs.onActivated.addListener((ai) => {
  chrome.tabs.get(ai.tabId, (tab) => {
    if (!chrome.runtime.lastError && tab.url && isInjectableUrl(tab.url)) {
      ensureTabAlive(ai.tabId, tab.url);
    }
  });
});

chrome.webNavigation?.onHistoryStateUpdated?.addListener((d) => {
  if (d.frameId === 0 && isInjectableUrl(d.url)) ensureTabAlive(d.tabId, d.url);
});

chrome.tabs.onRemoved.addListener((tabId) => aliveTabs.delete(tabId));

console.log('[AISel-BG] ready v' + VERSION);
