(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document && root.Node) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const TEXT_SELECTOR = '#jiaohua-selectable-caption-overlay .jiaohua-caption-text';
  const ACTIVE_CLASS = 'jiaohua-selectable-caption-active';
  const STABLE_ATTRIBUTE = 'data-jiaohua-caption-stable';
  const STYLE_ID = 'jiaohua-caption-stabilizer-style';
  const VERSION = '1.0.0-caption-text-stabilizer';

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function containsCjk(value) {
    return /[\u3400-\u9fff]/.test(String(value || ''));
  }

  function countWords(value) {
    const text = normalizeText(value);
    if (!text) return 0;
    if (containsCjk(text)) {
      return Array.from(text).filter((char) => /[\u3400-\u9fff]/.test(char)).length;
    }
    return (text.match(/[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*/g) || []).length;
  }

  function endsSentence(value) {
    return /[.!?。！？][”’"')\]}】》]*$/.test(normalizeText(value));
  }

  function isMeaningfulChunk(value) {
    const text = normalizeText(value);
    if (!text) return false;
    if (endsSentence(text)) return true;
    return containsCjk(text) ? countWords(text) >= 6 : countWords(text) >= 3;
  }

  function boundaryCandidates(text, cjk) {
    const candidates = [];
    const length = text.length;
    const min = cjk ? 6 : Math.max(10, Math.floor(length * 0.24));
    const max = length - min;
    if (max <= min) return candidates;

    for (let index = min; index <= max; index += 1) {
      const before = text[index - 1] || '';
      const after = text[index] || '';
      let score = 0;

      if (/[.!?。！？]/.test(before)) score = 100;
      else if (/[,;:，；：、—…]/.test(before)) score = 82;
      else if (/\s/.test(before) || /\s/.test(after)) score = 36;
      else if (cjk) score = 14;
      else continue;

      const tail = text.slice(index).trimStart();
      if (/^(?:but|and|because|so|although|though|when|while|if|which|that)\b/i.test(tail)) {
        score = Math.max(score, 68);
      }
      candidates.push({ index, score });
    }
    return candidates;
  }

  function formatCaption(value, options) {
    const text = normalizeText(value);
    if (!text) return '';

    const cjk = containsCjk(text);
    const maxLine = Number(options?.maxLineLength) || (cjk ? 22 : 42);
    if (text.length <= maxLine) return text;

    const midpoint = text.length / 2;
    const candidates = boundaryCandidates(text, cjk);
    if (!candidates.length) {
      const index = Math.max(1, Math.min(text.length - 1, Math.round(midpoint)));
      return `${text.slice(0, index).trim()}\n${text.slice(index).trim()}`;
    }

    candidates.sort((a, b) => {
      const aDistance = Math.abs(a.index - midpoint);
      const bDistance = Math.abs(b.index - midpoint);
      const aScore = a.score - aDistance * 1.35;
      const bScore = b.score - bDistance * 1.35;
      return bScore - aScore;
    });

    const split = candidates[0].index;
    const first = text.slice(0, split).trim();
    const second = text.slice(split).trim();
    if (!first || !second) return text;
    return `${first}\n${second}`;
  }

  function createTimingPolicy(hostname) {
    const host = String(hostname || '').toLowerCase();
    const bilibili = host === 'bilibili.com' || host.endsWith('.bilibili.com');
    return bilibili
      ? { debounceMs: 100, completeMs: 55, maxWaitMs: 320, releaseMs: 180 }
      : { debounceMs: 220, completeMs: 70, maxWaitMs: 600, releaseMs: 240 };
  }

  function createState(options) {
    const policy = { ...createTimingPolicy(options?.hostname), ...(options?.policy || {}) };
    return {
      policy,
      rawText: '',
      committedRaw: '',
      committedDisplay: '',
      pendingSince: 0,
      lastChangeAt: 0,
      locked: false,
    };
  }

  function nextDelay(state, rawText, now) {
    const text = normalizeText(rawText);
    const started = state.pendingSince || now;
    const elapsed = Math.max(0, now - started);
    const remainingMax = Math.max(0, state.policy.maxWaitMs - elapsed);
    if (remainingMax === 0) return 0;
    if (endsSentence(text)) return Math.min(state.policy.completeMs, remainingMax);
    if (isMeaningfulChunk(text) && !state.committedRaw) {
      return Math.min(Math.max(90, Math.floor(state.policy.debounceMs * 0.65)), remainingMax);
    }
    return Math.min(state.policy.debounceMs, remainingMax);
  }

  function install(win) {
    const host = String(win.location?.hostname || '').toLowerCase();
    const supported = host === 'youtube.com' || host.endsWith('.youtube.com') ||
      host === 'bilibili.com' || host.endsWith('.bilibili.com');
    if (!supported || win.top !== win) return;
    if (win.__JIAOHUA_CAPTION_TEXT_STABILIZER__ === VERSION) return;
    win.__JIAOHUA_CAPTION_TEXT_STABILIZER__ = VERSION;

    const doc = win.document;
    const descriptor = Object.getOwnPropertyDescriptor(win.Node.prototype, 'textContent');
    if (!descriptor?.get || !descriptor?.set) return;

    const state = createState({ hostname: win.location?.hostname });
    let timer = 0;
    let releaseTimer = 0;
    let applying = false;
    let targetElement = null;

    function isCaptionTextNode(node) {
      return Boolean(node && node.nodeType === win.Node.ELEMENT_NODE && node.matches?.(TEXT_SELECTOR));
    }

    function installStyle() {
      if (doc.getElementById(STYLE_ID)) return;
      const style = doc.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        #jiaohua-selectable-caption-overlay .jiaohua-caption-text {
          white-space: pre-line !important;
          text-wrap: wrap !important;
          overflow-wrap: normal !important;
          word-break: normal !important;
        }
        html.${ACTIVE_CLASS}:not([${STABLE_ATTRIBUTE}="true"]) body .html5-video-player .ytp-caption-window-container,
        html.${ACTIVE_CLASS}:not([${STABLE_ATTRIBUTE}="true"]) body .bpx-player-video-area .bpx-player-subtitle-wrap {
          opacity: 1 !important;
        }
        html.${ACTIVE_CLASS}:not([${STABLE_ATTRIBUTE}="true"]) #jiaohua-selectable-caption-overlay .jiaohua-caption-text {
          visibility: hidden !important;
        }
      `;
      (doc.head || doc.documentElement).appendChild(style);
    }

    function setStableFlag(stable) {
      if (stable) doc.documentElement.setAttribute(STABLE_ATTRIBUTE, 'true');
      else doc.documentElement.removeAttribute(STABLE_ATTRIBUTE);
    }

    function originalSet(node, value) {
      applying = true;
      try {
        descriptor.set.call(node, value);
      } finally {
        applying = false;
      }
    }

    function selectionInside(node) {
      const selection = win.getSelection?.();
      if (!node || !selection || selection.isCollapsed || !selection.rangeCount) return false;
      return node.contains(selection.anchorNode) || node.contains(selection.focusNode);
    }

    function clearTimer() {
      if (timer) win.clearTimeout(timer);
      timer = 0;
    }

    function commit() {
      clearTimer();
      if (state.locked || !targetElement?.isConnected) return;
      const raw = normalizeText(state.rawText);
      if (!raw) {
        state.committedRaw = '';
        state.committedDisplay = '';
        state.pendingSince = 0;
        originalSet(targetElement, '');
        setStableFlag(false);
        return;
      }

      const display = formatCaption(raw);
      if (state.committedDisplay !== display) originalSet(targetElement, display);
      state.committedRaw = raw;
      state.committedDisplay = display;
      state.pendingSince = 0;
      setStableFlag(true);
    }

    function schedule() {
      clearTimer();
      if (state.locked || !targetElement?.isConnected) return;
      const now = Date.now();
      const delay = nextDelay(state, state.rawText, now);
      timer = win.setTimeout(commit, delay);
    }

    function accept(node, value) {
      targetElement = node;
      installStyle();
      const raw = normalizeText(value);
      const now = Date.now();

      if (!raw) {
        state.rawText = '';
        state.pendingSince = now;
        state.lastChangeAt = now;
        commit();
        return;
      }

      if (raw === state.rawText) return;
      state.rawText = raw;
      state.lastChangeAt = now;
      if (!state.pendingSince) state.pendingSince = now;
      schedule();
    }

    Object.defineProperty(win.Node.prototype, 'textContent', {
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value) {
        if (!applying && isCaptionTextNode(this)) {
          accept(this, value);
          return;
        }
        descriptor.set.call(this, value);
      },
    });

    function lockFromEvent(event) {
      const element = event.target instanceof win.Element ? event.target.closest(TEXT_SELECTOR) : null;
      if (!element) return;
      targetElement = element;
      state.locked = true;
      if (releaseTimer) win.clearTimeout(releaseTimer);
      clearTimer();
    }

    function unlockSoon() {
      if (!state.locked) return;
      if (releaseTimer) win.clearTimeout(releaseTimer);
      releaseTimer = win.setTimeout(() => {
        state.locked = false;
        releaseTimer = 0;
        schedule();
      }, state.policy.releaseMs);
    }

    doc.addEventListener('mousedown', lockFromEvent, true);
    doc.addEventListener('mouseup', unlockSoon, true);
    doc.addEventListener('dragend', unlockSoon, true);

    const observer = new win.MutationObserver(() => {
      const nextTarget = doc.querySelector(TEXT_SELECTOR);
      if (nextTarget && nextTarget !== targetElement) {
        targetElement = nextTarget;
        const current = normalizeText(descriptor.get.call(nextTarget));
        if (current) accept(nextTarget, current);
      }
      if (!nextTarget) {
        targetElement = null;
        state.rawText = '';
        state.committedRaw = '';
        state.committedDisplay = '';
        state.pendingSince = 0;
        setStableFlag(false);
      } else if (!state.committedDisplay && !selectionInside(nextTarget)) {
        setStableFlag(false);
      }
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true });

    const activeClassObserver = new win.MutationObserver(() => {
      if (doc.documentElement.classList.contains(ACTIVE_CLASS)) return;
      clearTimer();
      state.rawText = '';
      state.committedRaw = '';
      state.committedDisplay = '';
      state.pendingSince = 0;
      setStableFlag(false);
    });
    activeClassObserver.observe(doc.documentElement, { attributes: true, attributeFilter: ['class'] });

    win.addEventListener('pagehide', () => {
      clearTimer();
      if (releaseTimer) win.clearTimeout(releaseTimer);
      observer.disconnect();
      activeClassObserver.disconnect();
      setStableFlag(false);
      try {
        Object.defineProperty(win.Node.prototype, 'textContent', descriptor);
      } catch (_) {}
    }, { once: true });
  }

  return {
    normalizeText,
    containsCjk,
    countWords,
    endsSentence,
    isMeaningfulChunk,
    formatCaption,
    createTimingPolicy,
    createState,
    nextDelay,
    install,
  };
});