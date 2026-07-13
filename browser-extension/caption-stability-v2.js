(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document && root.Node) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const VERSION = '2.0.0-caption-stability';
  const OVERLAY_ID = 'jiaohua-selectable-caption-overlay';
  const TEXT_SELECTOR = `#${OVERLAY_ID} .jiaohua-caption-text`;
  const HANDLE_SELECTOR = `#${OVERLAY_ID} .jiaohua-caption-drag-handle`;
  const STYLE_ID = 'jiaohua-caption-stability-v2-style';
  const VISIBLE_ATTRIBUTE = 'data-jiaohua-caption-v2-visible';
  const STABLE_ATTRIBUTE = 'data-jiaohua-caption-stable';
  const MANUAL_ATTRIBUTE = 'data-jiaohua-caption-manual';
  const ACTIVE_CLASS = 'jiaohua-selectable-caption-active';

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function containsCjk(value) {
    return /[\u3400-\u9fff]/.test(String(value || ''));
  }

  function wordTokens(value) {
    const text = normalizeText(value);
    if (!text) return [];
    if (containsCjk(text)) return Array.from(text).filter((char) => !/\s/.test(char));
    return text.match(/[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*|[^\sA-Za-z0-9]/g) || [];
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

  function endsClause(value) {
    return /[,;:，；：、—…][”’"')\]}】》]*$/.test(normalizeText(value));
  }

  function normalizeWord(value) {
    return String(value || '').toLowerCase().replace(/^[^a-z0-9\u3400-\u9fff]+|[^a-z0-9\u3400-\u9fff]+$/g, '');
  }

  function lexicalWords(value) {
    if (containsCjk(value)) return Array.from(normalizeText(value)).filter((char) => /[\u3400-\u9fff]/.test(char));
    return (normalizeText(value).match(/[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*/g) || []).map(normalizeWord).filter(Boolean);
  }

  function suffixPrefixOverlap(previous, next) {
    const left = lexicalWords(previous);
    const right = lexicalWords(next);
    const limit = Math.min(left.length, right.length);
    for (let size = limit; size >= 1; size -= 1) {
      let matches = true;
      for (let index = 0; index < size; index += 1) {
        if (left[left.length - size + index] !== right[index]) {
          matches = false;
          break;
        }
      }
      if (matches) return size;
    }
    return 0;
  }

  function relatedCaption(previous, next) {
    const left = normalizeText(previous);
    const right = normalizeText(next);
    if (!left || !right) return false;
    if (left.startsWith(right) || right.startsWith(left)) return true;
    const overlap = suffixPrefixOverlap(left, right);
    const shorter = Math.max(1, Math.min(countWords(left), countWords(right)));
    return overlap >= 2 && overlap / shorter >= 0.45;
  }

  function createPolicy(hostname) {
    const host = String(hostname || '').toLowerCase();
    const bilibili = host === 'bilibili.com' || host.endsWith('.bilibili.com');
    return bilibili
      ? {
          sentenceMs: 45,
          clauseMs: 90,
          quietMs: 150,
          cueSwitchMs: 90,
          maxWaitMs: 480,
          blankGraceMs: 240,
          disableAfterMs: 900,
          minWords: 3,
          idealMinWords: 5,
          idealMaxWords: 11,
          maxWords: 16,
          maxCjk: 28,
        }
      : {
          sentenceMs: 80,
          clauseMs: 150,
          quietMs: 320,
          cueSwitchMs: 140,
          maxWaitMs: 900,
          blankGraceMs: 320,
          disableAfterMs: 1200,
          minWords: 4,
          idealMinWords: 6,
          idealMaxWords: 12,
          maxWords: 16,
          maxCjk: 30,
        };
  }

  function nextCommitDelay(state, rawText, now) {
    const text = normalizeText(rawText);
    const policy = state.policy;
    const startedAt = state.pendingSince || now;
    const elapsed = Math.max(0, now - startedAt);
    const remaining = Math.max(0, policy.maxWaitMs - elapsed);
    if (remaining === 0) return 0;
    if (endsSentence(text)) return Math.min(policy.sentenceMs, remaining);
    if (endsClause(text) && countWords(text) >= policy.minWords) return Math.min(policy.clauseMs, remaining);
    if (countWords(text) < policy.minWords) return remaining;
    if (state.cueSwitched) return Math.min(policy.cueSwitchMs, remaining);
    return Math.min(policy.quietMs, remaining);
  }

  function trimDisplayWindow(value, policy) {
    const text = normalizeText(value);
    if (!text) return '';

    if (containsCjk(text)) {
      const chars = Array.from(text);
      if (chars.length <= policy.maxCjk) return text;
      const tail = chars.slice(-policy.maxCjk).join('');
      const boundary = tail.search(/[。！？；，]/);
      return normalizeText(boundary >= 0 && boundary < Math.floor(tail.length * 0.45) ? tail.slice(boundary + 1) : tail);
    }

    const words = text.split(/\s+/).filter(Boolean);
    if (words.length <= policy.maxWords) return text;
    const tail = words.slice(-policy.maxWords);
    for (let index = 0; index < Math.min(6, tail.length - policy.idealMinWords); index += 1) {
      if (/[.!?;:,]$/.test(tail[index])) return tail.slice(index + 1).join(' ');
    }
    return tail.join(' ');
  }

  function defaultMeasure(value) {
    let width = 0;
    for (const char of String(value || '')) {
      if (/\s/.test(char)) width += 0.34;
      else if (/[ilI1'’.,:;]/.test(char)) width += 0.32;
      else if (/[MW@#%]/.test(char)) width += 0.92;
      else if (/[\u3400-\u9fff]/.test(char)) width += 1;
      else width += 0.58;
    }
    return width;
  }

  function splitUnits(text) {
    if (containsCjk(text)) return Array.from(text);
    return text.split(/\s+/).filter(Boolean);
  }

  function joinUnits(units, cjk) {
    return cjk ? units.join('') : units.join(' ');
  }

  function boundaryScore(units, index, cjk) {
    const before = units[index - 1] || '';
    const after = units[index] || '';
    let score = 0;
    if (/[.!?。！？][”’"')\]}】》]*$/.test(before)) score += 260;
    else if (/[,;:，；：、—…][”’"')\]}】》]*$/.test(before)) score += 150;

    if (!cjk && /^(?:but|because|although|though|when|while|if|so|which|that|and)$/i.test(normalizeWord(after))) {
      score += index >= 4 ? 90 : 20;
    }
    return score;
  }

  function layoutCaption(value, options) {
    const text = normalizeText(value);
    if (!text) return { text: '', display: '', breakIndex: null };

    const cjk = containsCjk(text);
    const units = splitUnits(text);
    const measure = typeof options?.measure === 'function' ? options.measure : defaultMeasure;
    const maxWidth = Math.max(1, Number(options?.maxWidth) || (cjk ? 18 : 28));
    const fullWidth = measure(text);
    if (fullWidth <= maxWidth || units.length < 4) {
      return { text, display: text, breakIndex: null };
    }

    const previous = options?.previous;
    if (previous && previous.breakIndex && text.startsWith(previous.text)) {
      const index = previous.breakIndex;
      if (index > 0 && index < units.length) {
        const first = joinUnits(units.slice(0, index), cjk);
        const second = joinUnits(units.slice(index), cjk);
        if (measure(first) <= maxWidth * 1.02 && measure(second) <= maxWidth * 1.1) {
          return { text, display: `${first}\n${second}`, breakIndex: index };
        }
      }
    }

    const minUnits = cjk ? Math.max(5, Math.floor(units.length * 0.25)) : Math.max(3, Math.floor(units.length * 0.22));
    let best = null;
    for (let index = minUnits; index <= units.length - minUnits; index += 1) {
      const first = joinUnits(units.slice(0, index), cjk);
      const second = joinUnits(units.slice(index), cjk);
      const firstWidth = measure(first);
      const secondWidth = measure(second);
      const overflow = Math.max(0, firstWidth - maxWidth) + Math.max(0, secondWidth - maxWidth);
      const balance = Math.abs(firstWidth - secondWidth);
      const score = boundaryScore(units, index, cjk) - overflow * 90 - balance * 1.4;
      if (!best || score > best.score) best = { index, first, second, score };
    }

    if (!best) return { text, display: text, breakIndex: null };
    return { text, display: `${best.first}\n${best.second}`, breakIndex: best.index };
  }

  function install(win) {
    const host = String(win.location?.hostname || '').toLowerCase();
    const supported = host === 'youtube.com' || host.endsWith('.youtube.com') ||
      host === 'bilibili.com' || host.endsWith('.bilibili.com');
    if (!supported || win.top !== win) return;
    if (win.__JIAOHUA_CAPTION_STABILITY_V2__ === VERSION) return;
    win.__JIAOHUA_CAPTION_STABILITY_V2__ = VERSION;

    const doc = win.document;
    const nativeTextContent = Object.getOwnPropertyDescriptor(win.Node.prototype, 'textContent');
    if (!nativeTextContent?.get || !nativeTextContent?.set) return;

    const state = {
      policy: createPolicy(host),
      rawText: '',
      previousRaw: '',
      committedRaw: '',
      committedDisplay: '',
      pendingSince: 0,
      lastChangeAt: 0,
      cueSwitched: false,
      layout: null,
    };

    let overlay = null;
    let textElement = null;
    let player = null;
    let video = null;
    let commitTimer = 0;
    let blankTimer = 0;
    let disableTimer = 0;
    let documentObserver = null;
    let overlayObserver = null;
    let playerResizeObserver = null;
    let videoResizeObserver = null;
    let canvasContext = null;
    let applyingText = false;

    function clearTimer(name) {
      const id = name === 'commit' ? commitTimer : name === 'blank' ? blankTimer : disableTimer;
      if (id) win.clearTimeout(id);
      if (name === 'commit') commitTimer = 0;
      else if (name === 'blank') blankTimer = 0;
      else disableTimer = 0;
    }

    function setVisible(visible) {
      if (visible) {
        doc.documentElement.setAttribute(VISIBLE_ATTRIBUTE, 'true');
        doc.documentElement.setAttribute(STABLE_ATTRIBUTE, 'true');
      } else {
        doc.documentElement.removeAttribute(VISIBLE_ATTRIBUTE);
        doc.documentElement.removeAttribute(STABLE_ATTRIBUTE);
      }
    }

    function installStyle() {
      if (doc.getElementById(STYLE_ID)) return;
      const style = doc.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        html.${ACTIVE_CLASS}:not([${VISIBLE_ATTRIBUTE}="true"]) body .html5-video-player .ytp-caption-window-container,
        html.${ACTIVE_CLASS}:not([${VISIBLE_ATTRIBUTE}="true"]) body .bpx-player-video-area .bpx-player-subtitle-wrap {
          opacity: 1 !important;
        }
        html.${ACTIVE_CLASS}:not([${VISIBLE_ATTRIBUTE}="true"]) #${OVERLAY_ID} .jiaohua-caption-text {
          visibility: hidden !important;
        }
        html[${VISIBLE_ATTRIBUTE}="true"] body .html5-video-player .ytp-caption-window-container,
        html[${VISIBLE_ATTRIBUTE}="true"] body .bpx-player-video-area .bpx-player-subtitle-wrap {
          opacity: 0 !important;
        }
        html[${VISIBLE_ATTRIBUTE}="true"] #${OVERLAY_ID} {
          display: flex !important;
          width: min(86%, 960px) !important;
          max-width: min(86%, 960px) !important;
          min-height: 2.72em !important;
          align-items: flex-end !important;
          justify-content: center !important;
          text-align: center !important;
          font-size: var(--jiaohua-caption-font-size, 22px) !important;
          line-height: 1.32 !important;
          pointer-events: none !important;
          transition: none !important;
        }
        html[${VISIBLE_ATTRIBUTE}="true"] #${OVERLAY_ID}:not([${MANUAL_ATTRIBUTE}="true"]) {
          left: 50% !important;
          right: auto !important;
          top: auto !important;
          bottom: var(--jiaohua-caption-bottom, 7.5%) !important;
          transform: translateX(-50%) !important;
        }
        #${OVERLAY_ID} .jiaohua-caption-text {
          display: inline-block !important;
          width: auto !important;
          max-width: 100% !important;
          min-width: 0 !important;
          white-space: pre-line !important;
          text-wrap: wrap !important;
          overflow-wrap: normal !important;
          word-break: normal !important;
          transition: none !important;
          transform: none !important;
        }
      `;
      (doc.head || doc.documentElement).appendChild(style);
    }

    function findPlayer() {
      return host.includes('youtube')
        ? doc.querySelector('.html5-video-player')
        : doc.querySelector('.bpx-player-video-area, .bpx-player-container');
    }

    function findVideo(nextPlayer) {
      return nextPlayer?.querySelector('video') || doc.querySelector('video');
    }

    function updateFontSize() {
      if (!overlay || !player) return;
      const videoRect = video?.getBoundingClientRect?.();
      const playerRect = player.getBoundingClientRect?.();
      const height = videoRect?.height > 1 ? videoRect.height : playerRect?.height;
      if (!Number.isFinite(height) || height <= 1) return;
      const size = clamp(height * 0.036, 16, 32);
      overlay.style.setProperty('--jiaohua-caption-font-size', `${size.toFixed(2)}px`);
    }

    function bindResizeTargets() {
      const nextPlayer = findPlayer();
      const nextVideo = findVideo(nextPlayer);
      if (nextPlayer === player && nextVideo === video) return;

      playerResizeObserver?.disconnect();
      videoResizeObserver?.disconnect();
      player = nextPlayer;
      video = nextVideo;

      if (player) {
        playerResizeObserver = new win.ResizeObserver(updateFontSize);
        playerResizeObserver.observe(player);
      }
      if (video) {
        videoResizeObserver = new win.ResizeObserver(updateFontSize);
        videoResizeObserver.observe(video);
      }
      updateFontSize();
    }

    function measureFactory() {
      if (!canvasContext) {
        const canvas = doc.createElement('canvas');
        canvasContext = canvas.getContext('2d');
      }
      if (!canvasContext) return defaultMeasure;
      const style = textElement ? win.getComputedStyle(textElement) : null;
      canvasContext.font = style?.font || `${overlay?.style.getPropertyValue('--jiaohua-caption-font-size') || '22px'} Arial`;
      return (value) => canvasContext.measureText(String(value || '')).width;
    }

    function maxLineWidth() {
      const playerWidth = player?.clientWidth || win.innerWidth || 800;
      return Math.max(180, Math.min(playerWidth * 0.78, 880));
    }

    function nativeSetText(value) {
      if (!textElement?.isConnected) return;
      applyingText = true;
      try {
        nativeTextContent.set.call(textElement, value);
      } finally {
        applyingText = false;
      }
    }

    function commit() {
      clearTimer('commit');
      if (!textElement?.isConnected) return;
      const raw = normalizeText(state.rawText);
      if (!raw) return;

      const phrase = trimDisplayWindow(raw, state.policy);
      const layout = layoutCaption(phrase, {
        measure: measureFactory(),
        maxWidth: maxLineWidth(),
        previous: state.layout,
      });

      if (layout.display !== state.committedDisplay) nativeSetText(layout.display);
      state.committedRaw = raw;
      state.committedDisplay = layout.display;
      state.layout = layout;
      state.pendingSince = 0;
      state.cueSwitched = false;
      setVisible(Boolean(layout.display));
      updateFontSize();
    }

    function scheduleCommit() {
      clearTimer('commit');
      if (!state.rawText || !textElement?.isConnected) return;
      const now = Date.now();
      const delay = nextCommitDelay(state, state.rawText, now);
      commitTimer = win.setTimeout(commit, delay);
    }

    function handleBlank() {
      clearTimer('commit');
      if (!state.committedDisplay) {
        setVisible(false);
        return;
      }

      clearTimer('blank');
      clearTimer('disable');
      blankTimer = win.setTimeout(() => {
        blankTimer = 0;
        if (state.rawText) return;
        nativeSetText('');
        state.committedDisplay = '';
        state.layout = null;
        setVisible(true);
      }, state.policy.blankGraceMs);

      disableTimer = win.setTimeout(() => {
        disableTimer = 0;
        if (state.rawText) return;
        state.committedRaw = '';
        state.committedDisplay = '';
        state.pendingSince = 0;
        state.layout = null;
        setVisible(false);
      }, state.policy.disableAfterMs);
    }

    function acceptRaw(value) {
      const raw = normalizeText(value);
      const now = Date.now();
      if (raw === state.rawText) return;

      clearTimer('blank');
      clearTimer('disable');
      state.previousRaw = state.rawText;
      state.rawText = raw;
      state.lastChangeAt = now;

      if (!raw) {
        handleBlank();
        return;
      }

      const wasRelated = relatedCaption(state.previousRaw || state.committedRaw, raw);
      state.cueSwitched = Boolean((state.previousRaw || state.committedRaw) && !wasRelated);
      if (!state.pendingSince || state.cueSwitched) state.pendingSince = now;
      scheduleCommit();
    }

    function unbindTextElement() {
      if (!textElement) return;
      try { delete textElement.textContent; } catch (_) {}
      textElement = null;
    }

    function bindTextElement(nextTextElement) {
      if (!nextTextElement || nextTextElement === textElement) return;
      unbindTextElement();
      textElement = nextTextElement;

      const initial = normalizeText(nativeTextContent.get.call(textElement));
      Object.defineProperty(textElement, 'textContent', {
        configurable: true,
        enumerable: nativeTextContent.enumerable,
        get() {
          return nativeTextContent.get.call(this);
        },
        set(value) {
          if (applyingText) {
            nativeTextContent.set.call(this, value);
            return;
          }
          acceptRaw(value);
        },
      });

      if (initial) {
        nativeSetText('');
        acceptRaw(initial);
      }
    }

    function bindOverlay(nextOverlay) {
      if (!nextOverlay || nextOverlay === overlay) return;
      overlayObserver?.disconnect();
      overlay = nextOverlay;
      overlay.removeAttribute(MANUAL_ATTRIBUTE);
      bindTextElement(overlay.querySelector('.jiaohua-caption-text'));
      bindResizeTargets();

      overlayObserver = new win.MutationObserver(() => {
        bindTextElement(overlay?.querySelector('.jiaohua-caption-text'));
        updateFontSize();
      });
      overlayObserver.observe(overlay, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    }

    function scan() {
      bindOverlay(doc.getElementById(OVERLAY_ID));
      bindResizeTargets();
    }

    installStyle();
    scan();

    documentObserver = new win.MutationObserver(scan);
    documentObserver.observe(doc.documentElement, { childList: true, subtree: true });

    doc.addEventListener('pointerdown', (event) => {
      const target = event.target instanceof win.Element ? event.target : null;
      if (!target?.closest(HANDLE_SELECTOR)) return;
      const currentOverlay = doc.getElementById(OVERLAY_ID);
      if (currentOverlay) currentOverlay.setAttribute(MANUAL_ATTRIBUTE, 'true');
    }, true);

    win.addEventListener('resize', updateFontSize, { passive: true });
    doc.addEventListener('fullscreenchange', updateFontSize);

    win.addEventListener('pagehide', () => {
      clearTimer('commit');
      clearTimer('blank');
      clearTimer('disable');
      documentObserver?.disconnect();
      overlayObserver?.disconnect();
      playerResizeObserver?.disconnect();
      videoResizeObserver?.disconnect();
      unbindTextElement();
      setVisible(false);
      doc.getElementById(STYLE_ID)?.remove();
    }, { once: true });
  }

  return {
    normalizeText,
    containsCjk,
    countWords,
    endsSentence,
    endsClause,
    suffixPrefixOverlap,
    relatedCaption,
    createPolicy,
    nextCommitDelay,
    trimDisplayWindow,
    defaultMeasure,
    layoutCaption,
    install,
  };
});
