(function () {
  'use strict';

  const VERSION = '1.0.0-source-location';
  if (window.__JIAOHUA_SOURCE_LOCATION_CAPTURE__ === VERSION) return;
  window.__JIAOHUA_SOURCE_LOCATION_CAPTURE__ = VERSION;

  const originalFetch = window.fetch.bind(window);
  let lastAnchor = null;

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
    const candidates = [
      'link[rel="icon"]',
      'link[rel="shortcut icon"]',
      'link[rel="apple-touch-icon"]',
      'link[rel="apple-touch-icon-precomposed"]',
    ];
    for (const selector of candidates) {
      const node = document.querySelector(selector);
      const href = node && node.getAttribute('href');
      const resolved = safeUrl(href);
      if (resolved) return resolved;
    }
    return safeUrl('/favicon.ico');
  }

  function elementFingerprint(node) {
    const element = node && node.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    if (!element) return '';
    const parts = [];
    let current = element;
    for (let depth = 0; current && depth < 4; depth += 1) {
      let part = String(current.tagName || '').toLowerCase();
      if (!part) break;
      if (current.id && !/\d{4,}/.test(current.id)) {
        part += `#${current.id}`;
        parts.unshift(part);
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
      const root = (range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement)?.closest?.('p, li, blockquote, article, section, td, th, div')
        || range.commonAncestorContainer.parentElement;
      const text = normalizeText(root?.innerText || root?.textContent || '');
      const needle = normalizeText(selectedText || selection.toString());
      const index = text.toLowerCase().indexOf(needle.toLowerCase());
      return {
        selectedText: needle,
        prefixText: index >= 0 ? text.slice(Math.max(0, index - 100), index) : '',
        suffixText: index >= 0 ? text.slice(index + needle.length, index + needle.length + 100) : '',
        elementFingerprint: elementFingerprint(range.commonAncestorContainer),
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

  console.log('[JiaoHua SourceLocation] installed', VERSION);
})();
