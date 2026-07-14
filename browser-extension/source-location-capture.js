(function () {
  'use strict';

  const VERSION = '1.1.1-source-location';
  const RESTORE_ENDPOINT = 'http://127.0.0.1:17322/restore';
  const TOKEN = 'aisel-local-bridge-v1';
  if (window.__JIAOHUA_SOURCE_LOCATION_CAPTURE__ === VERSION) return;
  window.__JIAOHUA_SOURCE_LOCATION_CAPTURE__ = VERSION;

  const originalFetch = window.fetch.bind(window);
  let lastAnchor = null;
  let lastAppliedRestoreId = '';
  let restorePolling = false;
  let restorePollUntil = Date.now() + 16000;

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function safeUrl(value) {
    try {
      const url = new URL(String(value || ''), location.href);
      return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
    } catch (_) {
      return '';
    }
  }

  function faviconUrl() {
    for (const selector of [
      'link[rel="icon"]',
      'link[rel="shortcut icon"]',
      'link[rel="apple-touch-icon"]',
      'link[rel="apple-touch-icon-precomposed"]',
    ]) {
      const href = document.querySelector(selector)?.getAttribute('href');
      const resolved = safeUrl(href);
      if (resolved) return resolved;
    }
    return safeUrl('/favicon.ico');
  }

  function elementFingerprint(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    if (!element) return '';
    const parts = [];
    let current = element;
    for (let depth = 0; current && depth < 4; depth += 1) {
      let part = String(current.tagName || '').toLowerCase();
      if (!part) break;
      if (current.id && !/\d{4,}/.test(current.id)) {
        parts.unshift(`${part}#${current.id}`);
        break;
      }
      const classes = Array.from(current.classList || [])
        .filter((name) => name && name.length < 48 && !/\d{4,}/.test(name))
        .slice(0, 2);
      if (classes.length) part += `.${classes.join('.')}`;
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(' > ').slice(0, 240);
  }

  function contextFromWindowSelection(selectedText) {
    try {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
      const range = selection.getRangeAt(0);
      const common = range.commonAncestorContainer;
      const element = common.nodeType === Node.ELEMENT_NODE ? common : common.parentElement;
      const root = element?.closest?.('p, li, blockquote, article, section, td, th, div') || element;
      const text = normalizeText(root?.innerText || root?.textContent || '');
      const needle = normalizeText(selectedText || selection.toString());
      const index = text.toLowerCase().indexOf(needle.toLowerCase());
      return {
        selectedText: needle,
        prefixText: index >= 0 ? text.slice(Math.max(0, index - 100), index) : '',
        suffixText: index >= 0 ? text.slice(index + needle.length, index + needle.length + 100) : '',
        elementFingerprint: elementFingerprint(common),
      };
    } catch (_) {
      return null;
    }
  }

  function contextFromInput(selectedText) {
    try {
      const element = document.activeElement;
      if (!element || !('value' in element)) return null;
      const start = Number(element.selectionStart);
      const end = Number(element.selectionEnd);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
      const value = String(element.value || '');
      return {
        selectedText: normalizeText(selectedText || value.slice(start, end)),
        prefixText: normalizeText(value.slice(Math.max(0, start - 100), start)),
        suffixText: normalizeText(value.slice(end, end + 100)),
        elementFingerprint: elementFingerprint(element),
      };
    } catch (_) {
      return null;
    }
  }

  function captureAnchor(selectedText) {
    const context = contextFromWindowSelection(selectedText) || contextFromInput(selectedText);
    if (!context?.selectedText) return lastAnchor;
    const documentHeight = Math.max(
      document.documentElement?.scrollHeight || 0,
      document.body?.scrollHeight || 0,
      window.innerHeight || 0,
    );
    const scrollRange = Math.max(1, documentHeight - window.innerHeight);
    lastAnchor = {
      ...context,
      scrollY: window.scrollY,
      scrollRatio: Math.max(0, Math.min(1, window.scrollY / scrollRange)),
      frameUrl: safeUrl(location.href),
      at: Date.now(),
    };
    return lastAnchor;
  }

  document.addEventListener('selectionchange', () => {
    const text = normalizeText(window.getSelection()?.toString() || '');
    if (text) captureAnchor(text);
  }, true);
  document.addEventListener('mouseup', () => {
    const text = normalizeText(window.getSelection()?.toString() || '');
    if (text) captureAnchor(text);
  }, true);

  function isSubtitlePayload(data) {
    const method = String(data?.metadata?.method || '').toLowerCase();
    const adapter = String(data?.metadata?.adapter || '').toLowerCase();
    return Boolean(
      data?.metadata?.subtitleOverlayDetected ||
      /subtitle|caption/.test(method) ||
      /subtitle|caption/.test(adapter)
    );
  }

  function platformForHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (host.endsWith('youtube.com') || host === 'youtu.be') return 'youtube';
    if (host.endsWith('bilibili.com')) return 'bilibili';
    return 'html5';
  }

  function sourceLocationFor(data) {
    const selectedText = normalizeText(data?.text || '');
    const anchor = captureAnchor(selectedText) || {
      selectedText,
      prefixText: '',
      suffixText: '',
      elementFingerprint: '',
      scrollY: window.scrollY,
      scrollRatio: 0,
      frameUrl: safeUrl(location.href),
    };
    const url = safeUrl(data?.url || location.href);
    let hostname = '';
    try { hostname = new URL(url).hostname; } catch (_) {}
    const subtitle = isSubtitlePayload(data);
    const video = subtitle ? document.querySelector('video') : null;
    const currentTime = Number(video?.currentTime);
    const duration = Number(video?.duration);

    return {
      type: subtitle ? 'subtitle' : 'web',
      capturedAt: new Date().toISOString(),
      url,
      normalizedUrl: url,
      title: normalizeText(data?.title || document.title),
      hostname,
      faviconUrl: faviconUrl(),
      video: subtitle && video ? {
        platform: platformForHost(hostname),
        currentTime: Number.isFinite(currentTime) ? currentTime : 0,
        duration: Number.isFinite(duration) ? duration : undefined,
        paused: Boolean(video.paused),
      } : undefined,
      anchor: {
        selectedText: anchor?.selectedText || selectedText,
        prefixText: anchor?.prefixText || '',
        suffixText: anchor?.suffixText || '',
        elementFingerprint: anchor?.elementFingerprint || '',
        scrollY: anchor?.scrollY,
        scrollRatio: anchor?.scrollRatio,
        frameUrl: anchor?.frameUrl || url,
      },
    };
  }

  window.fetch = function fetchWithSourceLocation(input, init) {
    try {
      const requestUrl = typeof input === 'string' ? input : input?.url;
      if (/^http:\/\/127\.0\.0\.1:17321\/selection(?:\?|$)/.test(String(requestUrl || '')) && init?.body) {
        const parsed = typeof init.body === 'string' ? JSON.parse(init.body) : null;
        if (parsed && typeof parsed === 'object') {
          parsed.sourceLocation = sourceLocationFor(parsed);
          init = { ...init, body: JSON.stringify(parsed) };
        }
      }
    } catch (_) {}
    return originalFetch(input, init);
  };

  function ensureRestoreStyles() {
    if (document.getElementById('jiaohua-source-restore-style')) return;
    const style = document.createElement('style');
    style.id = 'jiaohua-source-restore-style';
    style.textContent = `
      ::highlight(jiaohua-source-highlight) {
        background: rgba(255, 214, 74, .72);
        color: inherit;
      }
      [data-jiaohua-source-flash="true"] {
        outline: 3px solid rgba(255, 188, 50, .85) !important;
        outline-offset: 5px !important;
        border-radius: 4px !important;
        transition: outline-color .7s ease !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function safeQuery(selector) {
    if (!selector) return null;
    try { return document.querySelector(selector); }
    catch (_) { return null; }
  }

  function blockScore(element, anchor) {
    const text = normalizeText(element?.innerText || element?.textContent || '').toLowerCase();
    const selected = normalizeText(anchor?.selectedText || '').toLowerCase();
    if (!selected || !text.includes(selected)) return -1;
    let score = selected.length * 4;
    const prefix = normalizeText(anchor?.prefixText || '').toLowerCase().slice(-48);
    const suffix = normalizeText(anchor?.suffixText || '').toLowerCase().slice(0, 48);
    if (prefix && text.includes(prefix)) score += 80;
    if (suffix && text.includes(suffix)) score += 80;
    return score - Math.min(100, Math.max(0, text.length - selected.length) / 10);
  }

  function findCandidateBlock(anchor) {
    const fingerprint = safeQuery(anchor?.elementFingerprint);
    if (fingerprint && blockScore(fingerprint, anchor) >= 0) return fingerprint;
    const elements = Array.from(document.querySelectorAll('p, li, blockquote, td, th, h1, h2, h3, h4, article, section'));
    let best = null;
    let bestScore = -1;
    for (const element of elements) {
      const score = blockScore(element, anchor);
      if (score > bestScore) { best = element; bestScore = score; }
    }
    return best;
  }

  function findTextRange(root, selectedText) {
    const needle = normalizeText(selectedText).toLowerCase();
    if (!root || !needle) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|INPUT)$/i.test(parent.tagName)) return NodeFilter.FILTER_REJECT;
        return normalizeText(node.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      const value = String(node.nodeValue || '');
      const index = value.toLowerCase().indexOf(needle);
      if (index >= 0) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + needle.length);
        return range;
      }
    }
    return null;
  }

  function highlightAnchor(anchor) {
    const element = findCandidateBlock(anchor);
    if (!element) return false;
    element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    ensureRestoreStyles();
    const range = findTextRange(element, anchor?.selectedText || '');
    if (range && window.CSS?.highlights && typeof window.Highlight === 'function') {
      try {
        CSS.highlights.set('jiaohua-source-highlight', new Highlight(range));
        setTimeout(() => CSS.highlights.delete('jiaohua-source-highlight'), 5000);
        return true;
      } catch (_) {}
    }
    element.setAttribute('data-jiaohua-source-flash', 'true');
    setTimeout(() => element.removeAttribute('data-jiaohua-source-flash'), 4500);
    return true;
  }

  function restoreScrollRatio(anchor) {
    const ratio = Number(anchor?.scrollRatio);
    if (!Number.isFinite(ratio)) return false;
    const documentHeight = Math.max(
      document.documentElement?.scrollHeight || 0,
      document.body?.scrollHeight || 0,
      window.innerHeight || 0,
    );
    const maxScroll = Math.max(0, documentHeight - window.innerHeight);
    window.scrollTo({ top: maxScroll * Math.max(0, Math.min(1, ratio)), behavior: 'smooth' });
    return true;
  }

  function restoreVideo(sourceLocation, attempt) {
    const video = document.querySelector('video');
    const seconds = Number(sourceLocation?.video?.currentTime);
    if (video && Number.isFinite(seconds)) {
      try {
        video.currentTime = Math.max(0, seconds - 1.5);
        video.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return true;
      } catch (_) {}
    }
    if (attempt < 12) setTimeout(() => restoreVideo(sourceLocation, attempt + 1), 500);
    return false;
  }

  function applyRestore(restore) {
    if (!restore?.id || restore.id === lastAppliedRestoreId) return;
    lastAppliedRestoreId = restore.id;
    const sourceLocation = restore.sourceLocation || {};
    if (sourceLocation.type === 'video' || sourceLocation.type === 'subtitle') {
      restoreVideo(sourceLocation, 0);
      return;
    }
    setTimeout(() => {
      if (!highlightAnchor(sourceLocation.anchor || {})) restoreScrollRatio(sourceLocation.anchor || {});
    }, 350);
  }

  async function pollRestore() {
    if (window.top !== window || restorePolling || document.hidden || Date.now() > restorePollUntil) return;
    restorePolling = true;
    try {
      const endpoint = `${RESTORE_ENDPOINT}?token=${encodeURIComponent(TOKEN)}&url=${encodeURIComponent(location.href)}`;
      const response = await originalFetch(endpoint, { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      if (data?.restore) applyRestore(data.restore);
    } catch (_) {
      // The desktop app can be closed; source capture remains fully functional.
    } finally {
      restorePolling = false;
    }
  }

  function startRestoreBurst(durationMs = 16000) {
    restorePollUntil = Math.max(restorePollUntil, Date.now() + durationMs);
    void pollRestore();
  }

  const originalPushState = history.pushState.bind(history);
  history.pushState = function sourceAwarePushState() {
    const result = originalPushState(...arguments);
    startRestoreBurst();
    return result;
  };
  const originalReplaceState = history.replaceState.bind(history);
  history.replaceState = function sourceAwareReplaceState() {
    const result = originalReplaceState(...arguments);
    startRestoreBurst();
    return result;
  };

  setTimeout(() => startRestoreBurst(), 300);
  setInterval(() => { if (Date.now() <= restorePollUntil) void pollRestore(); }, 1800);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) startRestoreBurst(); });
  window.addEventListener('focus', () => startRestoreBurst());
  window.addEventListener('pageshow', () => startRestoreBurst());
  window.addEventListener('popstate', () => startRestoreBurst());
  window.addEventListener('hashchange', () => startRestoreBurst());

  console.log('[JiaoHua SourceLocation] installed', VERSION);
})();
