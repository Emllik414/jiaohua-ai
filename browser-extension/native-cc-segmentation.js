(function () {
  'use strict';

  const HOST = location.hostname.toLowerCase();
  const IS_YOUTUBE = HOST === 'youtube.com' || HOST.endsWith('.youtube.com');
  if (!IS_YOUTUBE || window.top !== window) return;

  const VERSION = '1.0.0-native-cc-segmentation';
  const SELECTOR = '.ytp-caption-window-container';
  if (window.__JIAOHUA_NATIVE_CC_SEGMENTATION__ === VERSION) return;
  window.__JIAOHUA_NATIVE_CC_SEGMENTATION__ = VERSION;

  const originalQuerySelectorAll = document.querySelectorAll.bind(document);
  const changedAt = new WeakMap();

  function captionText(node) {
    if (!node || !node.isConnected) return '';
    return Array.from(node.querySelectorAll('.ytp-caption-segment'))
      .map((segment) => String(segment.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  function isUsableCaptionWindow(node) {
    if (!node || !node.isConnected || !captionText(node)) return false;
    const rect = node.getBoundingClientRect();
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return false;
    if (rect.width <= 1 || rect.height <= 1) return false;
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function markCaption(node, timestamp) {
    const element = node instanceof Element ? node : node?.parentElement;
    const caption = element?.closest?.(SELECTOR);
    if (caption) changedAt.set(caption, timestamp);
  }

  function selectCurrentNativeWindow(nodes) {
    const candidates = Array.from(nodes)
      .filter(isUsableCaptionWindow)
      .map((node, index) => ({
        node,
        index,
        changed: changedAt.get(node) || 0,
      }));

    if (candidates.length <= 1) return candidates.map((item) => item.node);

    candidates.sort((a, b) => {
      if (a.changed !== b.changed) return b.changed - a.changed;
      return b.index - a.index;
    });

    return [candidates[0].node];
  }

  Object.defineProperty(document, 'querySelectorAll', {
    configurable: true,
    value(selector) {
      const result = originalQuerySelectorAll(selector);
      if (selector !== SELECTOR) return result;
      return selectCurrentNativeWindow(result);
    },
  });

  const observer = new MutationObserver((mutations) => {
    const now = Date.now();
    for (const mutation of mutations) {
      markCaption(mutation.target, now);
      for (const node of mutation.addedNodes || []) {
        markCaption(node, now);
        if (node instanceof Element) {
          for (const caption of node.querySelectorAll(SELECTOR)) {
            changedAt.set(caption, now);
          }
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
})();
