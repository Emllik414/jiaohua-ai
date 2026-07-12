(function () {
  'use strict';

  const HOST = location.hostname.toLowerCase();
  const IS_YOUTUBE = HOST === 'youtube.com' || HOST.endsWith('.youtube.com');
  if (!IS_YOUTUBE || window.top !== window) return;

  const VERSION = '1.0.0-native-cc-word-highlight';
  const OVERLAY_TEXT_SELECTOR = '#jiaohua-selectable-caption-overlay .jiaohua-caption-text';
  const NATIVE_WINDOW_SELECTOR = '.ytp-caption-window-container';
  const NATIVE_SEGMENT_SELECTOR = '.ytp-caption-segment';
  const STYLE_ID = 'jiaohua-native-cc-word-highlight-style';

  if (window.__JIAOHUA_NATIVE_CC_WORD_HIGHLIGHT__ === VERSION) return;
  window.__JIAOHUA_NATIVE_CC_WORD_HIGHLIGHT__ = VERSION;

  let previousWords = [];
  let currentText = '';
  let activeWordIndex = -1;
  let spokenThrough = -1;
  let scheduled = false;
  let applying = false;
  let lastRenderedText = '';
  let lastRenderedWordCount = 0;

  installStyle();

  function installStyle() {
    document.getElementById(STYLE_ID)?.remove();
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      ${OVERLAY_TEXT_SELECTOR} .jiaohua-caption-word {
        color: inherit;
        transition: color 90ms linear, text-shadow 90ms linear, opacity 90ms linear;
      }
      ${OVERLAY_TEXT_SELECTOR}[data-word-highlight="true"] .jiaohua-caption-word {
        color: rgba(255, 255, 255, .62);
      }
      ${OVERLAY_TEXT_SELECTOR}[data-word-highlight="true"] .jiaohua-caption-word.is-spoken {
        color: #fff;
      }
      ${OVERLAY_TEXT_SELECTOR}[data-word-highlight="true"] .jiaohua-caption-word.is-active {
        color: #ffd54a;
        text-shadow: 0 0 .28em rgba(255, 213, 74, .58), 0 1px 2px rgba(0, 0, 0, .9);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function currentNativeText() {
    const windows = Array.from(document.querySelectorAll(NATIVE_WINDOW_SELECTOR));
    for (const captionWindow of windows) {
      if (!captionWindow?.isConnected) continue;
      const rect = captionWindow.getBoundingClientRect();
      const style = getComputedStyle(captionWindow);
      if (rect.width <= 1 || rect.height <= 1 || style.display === 'none' || style.visibility === 'hidden') continue;

      const text = normalizeText(
        Array.from(captionWindow.querySelectorAll(NATIVE_SEGMENT_SELECTOR))
          .map((segment) => segment.textContent || '')
          .join(' '),
      );
      if (text) return text;
    }
    return '';
  }

  function segmentText(text) {
    if (!text) return [];

    try {
      if (typeof Intl?.Segmenter === 'function') {
        const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
        return Array.from(segmenter.segment(text), (item) => ({
          text: item.segment,
          isWord: Boolean(item.isWordLike),
        }));
      }
    } catch (_) {}

    const pieces = String(text).match(/\s+|[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*|[\u3400-\u9fff]|[^\s]/g) || [];
    return pieces.map((piece) => ({
      text: piece,
      isWord: /[A-Za-z0-9\u3400-\u9fff]/.test(piece),
    }));
  }

  function wordList(parts) {
    return parts
      .filter((part) => part.isWord)
      .map((part) => normalizeText(part.text).toLocaleLowerCase());
  }

  function longestSuffixPrefixOverlap(previous, next) {
    const limit = Math.min(previous.length, next.length);
    for (let size = limit; size > 0; size -= 1) {
      let matches = true;
      for (let index = 0; index < size; index += 1) {
        if (previous[previous.length - size + index] !== next[index]) {
          matches = false;
          break;
        }
      }
      if (matches) return size;
    }
    return 0;
  }

  function inferProgress(nextWords) {
    if (!nextWords.length) return { active: -1, spoken: -1 };

    if (!previousWords.length) {
      // A one- or two-word first update is usually a live CC build-up. A complete
      // sentence appearing at once has no trustworthy word timing, so keep it plain.
      if (nextWords.length <= 2) {
        return { active: nextWords.length - 1, spoken: nextWords.length - 2 };
      }
      return { active: -1, spoken: -1 };
    }

    const overlap = longestSuffixPrefixOverlap(previousWords, nextWords);
    const appended = nextWords.length - overlap;
    const directAppend = overlap === previousWords.length && appended > 0;
    const rollingAppend = overlap >= 2 && appended > 0 && overlap / Math.min(previousWords.length, nextWords.length) >= 0.5;

    if (directAppend || rollingAppend) {
      return { active: nextWords.length - 1, spoken: nextWords.length - 2 };
    }

    // Corrections, replacements and full-sentence captions do not expose reliable
    // per-word timing. Do not fabricate a karaoke cursor for those cases.
    return { active: -1, spoken: -1 };
  }

  function selectionInside(element) {
    if (!element) return false;
    const selection = window.getSelection?.();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
    return element.contains(selection.anchorNode) || element.contains(selection.focusNode);
  }

  function renderOverlay(textElement, text, parts) {
    const words = wordList(parts);
    const needsRebuild = lastRenderedText !== text || lastRenderedWordCount !== words.length ||
      textElement.querySelectorAll('.jiaohua-caption-word').length !== words.length;

    if (needsRebuild && selectionInside(textElement)) return;

    applying = true;
    try {
      if (needsRebuild) {
        const fragment = document.createDocumentFragment();
        let wordIndex = 0;
        for (const part of parts) {
          if (!part.isWord) {
            fragment.appendChild(document.createTextNode(part.text));
            continue;
          }

          const span = document.createElement('span');
          span.className = 'jiaohua-caption-word';
          span.dataset.wordIndex = String(wordIndex);
          span.textContent = part.text;
          fragment.appendChild(span);
          wordIndex += 1;
        }
        textElement.replaceChildren(fragment);
        lastRenderedText = text;
        lastRenderedWordCount = words.length;
      }

      const reliable = activeWordIndex >= 0 && activeWordIndex < words.length;
      if (reliable) textElement.dataset.wordHighlight = 'true';
      else delete textElement.dataset.wordHighlight;

      const spans = textElement.querySelectorAll('.jiaohua-caption-word');
      spans.forEach((span, index) => {
        span.classList.toggle('is-spoken', reliable && index <= spokenThrough);
        span.classList.toggle('is-active', reliable && index === activeWordIndex);
      });
    } finally {
      applying = false;
    }
  }

  function sync() {
    scheduled = false;
    if (applying) return;

    const textElement = document.querySelector(OVERLAY_TEXT_SELECTOR);
    if (!textElement) return;

    const nativeText = currentNativeText();
    const overlayText = normalizeText(textElement.textContent || '');
    const nextText = nativeText || overlayText;
    if (!nextText || overlayText !== nextText) return;

    const parts = segmentText(nextText);
    const nextWords = wordList(parts);

    if (nextText !== currentText) {
      const progress = inferProgress(nextWords);
      activeWordIndex = progress.active;
      spokenThrough = progress.spoken;
      previousWords = nextWords;
      currentText = nextText;
    }

    renderOverlay(textElement, nextText, parts);
  }

  function scheduleSync() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(sync);
  }

  const observer = new MutationObserver((mutations) => {
    if (applying) return;
    const relevant = mutations.some((mutation) => {
      const target = mutation.target instanceof Element ? mutation.target : mutation.target?.parentElement;
      return target?.closest?.(NATIVE_WINDOW_SELECTOR) || target?.closest?.(OVERLAY_TEXT_SELECTOR) ||
        Array.from(mutation.addedNodes || []).some((node) =>
          node instanceof Element && (node.matches?.(OVERLAY_TEXT_SELECTOR) || node.querySelector?.(OVERLAY_TEXT_SELECTOR)),
        );
    });
    if (relevant) scheduleSync();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  document.addEventListener('selectionchange', () => {
    if (!selectionInside(document.querySelector(OVERLAY_TEXT_SELECTOR))) scheduleSync();
  });

  document.addEventListener('fullscreenchange', scheduleSync);
  window.addEventListener('resize', scheduleSync, { passive: true });

  function bindVideoReset() {
    const video = document.querySelector('video');
    if (!video || video.dataset.jiaohuaWordHighlightBound === 'true') return;
    video.dataset.jiaohuaWordHighlightBound = 'true';
    video.addEventListener('seeking', () => {
      previousWords = [];
      currentText = '';
      activeWordIndex = -1;
      spokenThrough = -1;
      scheduleSync();
    });
  }

  const bindTimer = setInterval(bindVideoReset, 1000);
  window.addEventListener('pagehide', () => clearInterval(bindTimer), { once: true });
  bindVideoReset();
  scheduleSync();
})();
