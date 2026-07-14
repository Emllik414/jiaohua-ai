(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document && root.Node) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const VERSION = '2.2.0-caption-stability';
  const OVERLAY_ID = 'jiaohua-selectable-caption-overlay';
  const TEXT_SELECTOR = `#${OVERLAY_ID} .jiaohua-caption-text`;
  const HANDLE_SELECTOR = `#${OVERLAY_ID} .jiaohua-caption-drag-handle`;
  const STYLE_ID = 'jiaohua-caption-stability-v2-style';
  const VISIBLE_ATTRIBUTE = 'data-jiaohua-caption-v2-visible';
  const STABLE_ATTRIBUTE = 'data-jiaohua-caption-stable';
  const MANUAL_ATTRIBUTE = 'data-jiaohua-caption-manual';
  const HANDLE_VISIBLE_ATTRIBUTE = 'data-jiaohua-handle-visible';
  const DRAGGING_ATTRIBUTE = 'data-jiaohua-dragging';
  const ACTIVE_CLASS = 'jiaohua-selectable-caption-active';

  function clamp(value, min, max) {
    return Math.min(Math.max(Number(value) || 0, min), max);
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function containsCjk(value) {
    return /[\u3400-\u9fff]/.test(String(value || ''));
  }

  function lexicalWords(value) {
    const text = normalizeText(value).toLowerCase();
    if (!text) return [];
    if (containsCjk(text)) return Array.from(text).filter((char) => !/\s/.test(char));
    return text.match(/[a-z0-9]+(?:['’\-][a-z0-9]+)*/g) || [];
  }

  function countWords(value) {
    return lexicalWords(value).length;
  }

  function endsSentence(value) {
    return /[.!?。！？][”’"')\]}】》]*$/.test(normalizeText(value));
  }

  function endsClause(value) {
    return /[,;:，；：、—…][”’"')\]}】》]*$/.test(normalizeText(value));
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
          selectionReleaseMs: 180,
          handleHideMs: 650,
          minWords: 3,
          idealMinWords: 5,
          idealMaxWords: 11,
          maxWords: 16,
          maxCjk: 28,
          defaultBottomRatio: 0.075,
        }
      : {
          sentenceMs: 80,
          clauseMs: 150,
          quietMs: 320,
          cueSwitchMs: 140,
          maxWaitMs: 900,
          blankGraceMs: 320,
          disableAfterMs: 1200,
          selectionReleaseMs: 240,
          handleHideMs: 650,
          minWords: 4,
          idealMinWords: 6,
          idealMaxWords: 12,
          maxWords: 16,
          maxCjk: 30,
          defaultBottomRatio: 0.075,
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

    if (!cjk && /^(?:but|because|although|though|when|while|if|so|which|that|and)$/i.test(normalizeText(after))) {
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

  function computeContainedVideoRect(rect, intrinsicWidth, intrinsicHeight) {
    if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) return null;
    const sourceWidth = Number(intrinsicWidth);
    const sourceHeight = Number(intrinsicHeight);
    if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        right: Number.isFinite(rect.right) ? rect.right : rect.left + rect.width,
        bottom: Number.isFinite(rect.bottom) ? rect.bottom : rect.top + rect.height,
      };
    }

    const sourceRatio = sourceWidth / sourceHeight;
    const boxRatio = rect.width / rect.height;
    if (boxRatio > sourceRatio) {
      const width = rect.height * sourceRatio;
      return {
        left: rect.left + (rect.width - width) / 2,
        top: rect.top,
        width,
        height: rect.height,
        right: rect.left + (rect.width + width) / 2,
        bottom: rect.top + rect.height,
      };
    }

    const height = rect.width / sourceRatio;
    return {
      left: rect.left,
      top: rect.top + (rect.height - height) / 2,
      width: rect.width,
      height,
      right: rect.left + rect.width,
      bottom: rect.top + (rect.height + height) / 2,
    };
  }

  function clampBottomRatio(ratio, contentHeight, overlayHeight, topMarginRatio = 0.04, bottomMarginRatio = 0.03) {
    const height = Math.max(1, Number(contentHeight) || 1);
    const overlay = Math.max(0, Number(overlayHeight) || 0);
    const min = clamp(bottomMarginRatio, 0, 0.45);
    const max = Math.max(min, 1 - clamp(topMarginRatio, 0, 0.45) - overlay / height);
    return clamp(ratio, min, max);
  }

  function bottomRatioToPlayerBottom(ratio, contentRect, playerRect) {
    if (!contentRect || !playerRect) return 0;
    return Math.max(0, (playerRect.bottom - contentRect.bottom) + clamp(ratio, 0, 1) * contentRect.height);
  }

  function dragBottomRatio(startRatio, deltaY, contentHeight, overlayHeight) {
    const height = Math.max(1, Number(contentHeight) || 1);
    return clampBottomRatio(Number(startRatio) - Number(deltaY || 0) / height, height, overlayHeight);
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
      locked: false,
      dragging: false,
      manualBottomRatio: null,
    };

    let overlay = null;
    let textElement = null;
    let handleElement = null;
    let player = null;
    let video = null;
    let commitTimer = 0;
    let blankTimer = 0;
    let disableTimer = 0;
    let selectionReleaseTimer = 0;
    let handleHideTimer = 0;
    let documentObserver = null;
    let overlayObserver = null;
    let playerResizeObserver = null;
    let videoResizeObserver = null;
    let interactionAbort = null;
    let canvasContext = null;
    let applyingText = false;

    function clearTimer(name) {
      const id = name === 'commit' ? commitTimer
        : name === 'blank' ? blankTimer
          : name === 'disable' ? disableTimer
            : name === 'selection' ? selectionReleaseTimer
              : handleHideTimer;
      if (id) win.clearTimeout(id);
      if (name === 'commit') commitTimer = 0;
      else if (name === 'blank') blankTimer = 0;
      else if (name === 'disable') disableTimer = 0;
      else if (name === 'selection') selectionReleaseTimer = 0;
      else handleHideTimer = 0;
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
          left: 50% !important;
          right: auto !important;
          top: auto !important;
          bottom: var(--jiaohua-caption-bottom-px, 7.5%) !important;
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
        #${OVERLAY_ID} .jiaohua-caption-drag-handle {
          display: block !important;
          position: absolute !important;
          left: 50% !important;
          top: var(--jiaohua-caption-handle-top, -34px) !important;
          width: 58px !important;
          height: 38px !important;
          margin-left: -29px !important;
          padding: 0 !important;
          border: 0 !important;
          border-radius: 18px !important;
          background: transparent !important;
          color: transparent !important;
          cursor: ns-resize !important;
          pointer-events: auto !important;
          touch-action: none !important;
          user-select: none !important;
          -webkit-user-select: none !important;
          opacity: 0 !important;
          visibility: hidden !important;
          transform: none !important;
          transition: opacity .12s ease, visibility .12s ease !important;
          z-index: 3 !important;
        }
        #${OVERLAY_ID} .jiaohua-caption-drag-handle::before {
          content: '↕';
          position: absolute;
          left: 8px;
          top: 5px;
          width: 42px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 14px;
          background: rgba(20, 20, 20, .88);
          color: #fff;
          font-size: 16px;
          line-height: 1;
          box-shadow: 0 1px 4px rgba(0, 0, 0, .42);
        }
        #${OVERLAY_ID}[${HANDLE_VISIBLE_ATTRIBUTE}="true"] .jiaohua-caption-drag-handle,
        #${OVERLAY_ID}[${DRAGGING_ATTRIBUTE}="true"] .jiaohua-caption-drag-handle {
          opacity: 1 !important;
          visibility: visible !important;
        }
        #${OVERLAY_ID}[${DRAGGING_ATTRIBUTE}="true"] .jiaohua-caption-drag-handle {
          cursor: grabbing !important;
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

    function geometry() {
      if (!player) return null;
      const playerRect = player.getBoundingClientRect();
      const rawVideoRect = video?.getBoundingClientRect?.() || playerRect;
      const contentRect = computeContainedVideoRect(rawVideoRect, video?.videoWidth, video?.videoHeight) || rawVideoRect;
      if (!(contentRect.height > 1) || !(playerRect.height > 1)) return null;
      return { playerRect, contentRect };
    }

    function updateHandlePosition() {
      if (!overlay || !textElement) return;
      const textTop = Number(textElement.offsetTop) || 0;
      overlay.style.setProperty('--jiaohua-caption-handle-top', `${Math.round(textTop - 34)}px`);
    }

    function applyVerticalPosition() {
      if (!overlay || !player) return;
      const box = geometry();
      if (!box) return;
      const requested = state.manualBottomRatio ?? state.policy.defaultBottomRatio;
      const ratio = clampBottomRatio(requested, box.contentRect.height, overlay.offsetHeight);
      if (state.manualBottomRatio !== null) state.manualBottomRatio = ratio;
      const bottomPx = bottomRatioToPlayerBottom(ratio, box.contentRect, box.playerRect);
      overlay.style.setProperty('--jiaohua-caption-bottom-px', `${bottomPx.toFixed(2)}px`);
      if (state.manualBottomRatio === null) overlay.removeAttribute(MANUAL_ATTRIBUTE);
      else overlay.setAttribute(MANUAL_ATTRIBUTE, 'true');
      updateHandlePosition();
    }

    function updateFontAndPosition() {
      if (!overlay || !player) return;
      const box = geometry();
      if (!box) return;
      const size = clamp(box.contentRect.height * 0.036, 16, 32);
      overlay.style.setProperty('--jiaohua-caption-font-size', `${size.toFixed(2)}px`);
      applyVerticalPosition();
    }

    function bindResizeTargets() {
      const nextPlayer = findPlayer();
      const nextVideo = findVideo(nextPlayer);
      if (nextPlayer === player && nextVideo === video) {
        updateFontAndPosition();
        return;
      }

      playerResizeObserver?.disconnect();
      videoResizeObserver?.disconnect();
      player = nextPlayer;
      video = nextVideo;

      if (player) {
        playerResizeObserver = new win.ResizeObserver(updateFontAndPosition);
        playerResizeObserver.observe(player);
      }
      if (video) {
        videoResizeObserver = new win.ResizeObserver(updateFontAndPosition);
        videoResizeObserver.observe(video);
      }
      updateFontAndPosition();
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
      const box = geometry();
      const width = box?.contentRect.width || player?.clientWidth || win.innerWidth || 800;
      return Math.max(180, Math.min(width * 0.78, 880));
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
      if (state.locked || !textElement?.isConnected) return;
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
      updateFontAndPosition();
    }

    function scheduleCommit() {
      clearTimer('commit');
      if (state.locked || !state.rawText || !textElement?.isConnected) return;
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
        if (state.rawText || state.locked) return;
        nativeSetText('');
        state.committedDisplay = '';
        state.layout = null;
        setVisible(true);
        updateFontAndPosition();
      }, state.policy.blankGraceMs);

      disableTimer = win.setTimeout(() => {
        disableTimer = 0;
        if (state.rawText || state.locked) return;
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

    function lockSelection() {
      state.locked = true;
      clearTimer('selection');
      clearTimer('commit');
    }

    function unlockSelectionSoon() {
      if (!state.locked) return;
      clearTimer('selection');
      selectionReleaseTimer = win.setTimeout(() => {
        selectionReleaseTimer = 0;
        state.locked = false;
        if (state.rawText) scheduleCommit();
        else handleBlank();
      }, state.policy.selectionReleaseMs);
    }

    function showHandle() {
      clearTimer('handle');
      overlay?.setAttribute(HANDLE_VISIBLE_ATTRIBUTE, 'true');
    }

    function hideHandleSoon() {
      clearTimer('handle');
      if (state.dragging) return;
      handleHideTimer = win.setTimeout(() => {
        handleHideTimer = 0;
        if (!state.dragging) overlay?.removeAttribute(HANDLE_VISIBLE_ATTRIBUTE);
      }, state.policy.handleHideMs);
    }

    function startVerticalDrag(event) {
      if (event.button !== 0 || !overlay || !player || !handleElement) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      showHandle();

      const box = geometry();
      if (!box) return;
      state.dragging = true;
      overlay.setAttribute(DRAGGING_ATTRIBUTE, 'true');
      const startY = event.clientY;
      const startRatio = clampBottomRatio(
        state.manualBottomRatio ?? state.policy.defaultBottomRatio,
        box.contentRect.height,
        overlay.offsetHeight,
      );
      state.manualBottomRatio = startRatio;
      applyVerticalPosition();

      try { handleElement.setPointerCapture(event.pointerId); } catch (_) {}

      const move = (moveEvent) => {
        moveEvent.preventDefault();
        moveEvent.stopImmediatePropagation();
        const currentBox = geometry();
        if (!currentBox) return;
        state.manualBottomRatio = dragBottomRatio(
          startRatio,
          moveEvent.clientY - startY,
          currentBox.contentRect.height,
          overlay.offsetHeight,
        );
        applyVerticalPosition();
      };

      const finish = (finishEvent) => {
        finishEvent?.preventDefault?.();
        finishEvent?.stopImmediatePropagation?.();
        state.dragging = false;
        overlay?.removeAttribute(DRAGGING_ATTRIBUTE);
        try { handleElement?.releasePointerCapture(event.pointerId); } catch (_) {}
        handleElement?.removeEventListener('pointermove', move, true);
        handleElement?.removeEventListener('pointerup', finish, true);
        handleElement?.removeEventListener('pointercancel', finish, true);
        hideHandleSoon();
      };

      handleElement.addEventListener('pointermove', move, true);
      handleElement.addEventListener('pointerup', finish, true);
      handleElement.addEventListener('pointercancel', finish, true);
    }

    function bindInteractions() {
      interactionAbort?.abort();
      interactionAbort = new win.AbortController();
      const options = { signal: interactionAbort.signal };

      handleElement = overlay?.querySelector(HANDLE_SELECTOR) || null;
      if (handleElement) {
        handleElement.textContent = '';
        handleElement.addEventListener('pointerdown', startVerticalDrag, { capture: true, signal: interactionAbort.signal });
        handleElement.addEventListener('pointerenter', showHandle, options);
        handleElement.addEventListener('pointerleave', hideHandleSoon, options);
      }
      if (textElement) {
        textElement.addEventListener('pointerenter', showHandle, options);
        textElement.addEventListener('pointerleave', hideHandleSoon, options);
      }
      updateHandlePosition();
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
      interactionAbort?.abort();
      overlay = nextOverlay;
      bindTextElement(overlay.querySelector('.jiaohua-caption-text'));
      bindResizeTargets();
      bindInteractions();
      updateFontAndPosition();

      overlayObserver = new win.MutationObserver(() => {
        const nextText = overlay?.querySelector('.jiaohua-caption-text');
        if (nextText !== textElement) {
          bindTextElement(nextText);
          bindInteractions();
        }
        updateFontAndPosition();
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

    doc.addEventListener('mousedown', (event) => {
      const target = event.target instanceof win.Element ? event.target : null;
      if (target?.closest(TEXT_SELECTOR) && !target.closest(HANDLE_SELECTOR)) lockSelection();
    }, true);
    doc.addEventListener('mouseup', unlockSelectionSoon, true);
    doc.addEventListener('dragend', unlockSelectionSoon, true);

    win.addEventListener('resize', updateFontAndPosition, { passive: true });
    win.visualViewport?.addEventListener('resize', updateFontAndPosition, { passive: true });
    doc.addEventListener('fullscreenchange', updateFontAndPosition);

    win.addEventListener('pagehide', () => {
      clearTimer('commit');
      clearTimer('blank');
      clearTimer('disable');
      clearTimer('selection');
      clearTimer('handle');
      documentObserver?.disconnect();
      overlayObserver?.disconnect();
      playerResizeObserver?.disconnect();
      videoResizeObserver?.disconnect();
      interactionAbort?.abort();
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
    computeContainedVideoRect,
    clampBottomRatio,
    bottomRatioToPlayerBottom,
    dragBottomRatio,
    install,
  };
});
