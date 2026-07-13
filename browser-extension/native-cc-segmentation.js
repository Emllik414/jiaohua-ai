(function () {
  'use strict';

  const HOST = location.hostname.toLowerCase();
  const IS_YOUTUBE = HOST === 'youtube.com' || HOST.endsWith('.youtube.com');
  if (!IS_YOUTUBE || window.top !== window) return;

  const VERSION = '2.0.0-native-cc-segmentation';
  const SELECTOR = '.ytp-caption-window-container';
  const SWITCH_GRACE_MS = 180;
  const ACTIVE_FRESH_MS = 260;
  if (window.__JIAOHUA_NATIVE_CC_SEGMENTATION__ === VERSION) return;
  window.__JIAOHUA_NATIVE_CC_SEGMENTATION__ = VERSION;

  const originalQuerySelectorAll = document.querySelectorAll.bind(document);
  const changedAt = new WeakMap();
  let activeWindow = null;
  let activeChosenAt = 0;

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function captionText(node) {
    if (!node || !node.isConnected) return '';
    return normalizeText(Array.from(node.querySelectorAll('.ytp-caption-segment'))
      .map((segment) => segment.textContent || '')
      .filter(Boolean)
      .join(' '));
  }

  function lexicalWords(value) {
    return (normalizeText(value).toLowerCase().match(/[a-z0-9]+(?:['’\-][a-z0-9]+)*/g) || []);
  }

  function overlapRatio(leftValue, rightValue) {
    const left = lexicalWords(leftValue);
    const right = lexicalWords(rightValue);
    const limit = Math.min(left.length, right.length);
    if (!limit) return 0;
    for (let size = limit; size >= 1; size -= 1) {
      let matches = true;
      for (let index = 0; index < size; index += 1) {
        if (left[left.length - size + index] !== right[index]) {
          matches = false;
          break;
        }
      }
      if (matches) return size / limit;
    }
    return 0;
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

  function chooseNewest(candidates) {
    return candidates.slice().sort((a, b) => {
      if (a.changed !== b.changed) return b.changed - a.changed;
      return b.index - a.index;
    })[0] || null;
  }

  function selectCurrentNativeWindow(nodes) {
    const now = Date.now();
    const candidates = Array.from(nodes)
      .filter(isUsableCaptionWindow)
      .map((node, index) => ({
        node,
        index,
        text: captionText(node),
        changed: changedAt.get(node) || 0,
      }));

    if (!candidates.length) {
      activeWindow = null;
      activeChosenAt = 0;
      return [];
    }

    const current = candidates.find((item) => item.node === activeWindow) || null;
    const newest = chooseNewest(candidates);

    if (current && newest && current.node !== newest.node) {
      const withinSwitchGrace = now - activeChosenAt < SWITCH_GRACE_MS;
      const currentFresh = now - current.changed < ACTIVE_FRESH_MS;
      const related = overlapRatio(current.text, newest.text) >= 0.45 ||
        current.text.startsWith(newest.text) || newest.text.startsWith(current.text);

      if (withinSwitchGrace || (currentFresh && related)) {
        return [current.node];
      }
    }

    const selected = newest || current || candidates[candidates.length - 1];
    if (selected.node !== activeWindow) {
      activeWindow = selected.node;
      activeChosenAt = now;
    }
    return [selected.node];
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
          if (node.matches?.(SELECTOR)) changedAt.set(node, now);
          for (const caption of node.querySelectorAll(SELECTOR)) changedAt.set(caption, now);
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
