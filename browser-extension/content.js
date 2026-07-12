(function () {
  'use strict';
  // ????? Content script stability: version guard + AbortController ?????
  var VERSION = '1.6.0-selectable-video-captions';
  if (window.__AISEL_BOOTSTRAPPED__ === VERSION) return;
  if (typeof window.__AISEL_CLEANUP__ === 'function') {
    try { window.__AISEL_CLEANUP__(); } catch (_) {}
  }
  window.__AISEL_BOOTSTRAPPED__ = VERSION;
  var ac = new AbortController();
  var signal = ac.signal;
  if (window.__AISEL_ABORT_CONTROLLER__) window.__AISEL_ABORT_CONTROLLER__.abort();
  window.__AISEL_ABORT_CONTROLLER__ = ac;
  // ??????????????????????????????????????????????????????????????????????

  const RECEIVER = 'http://127.0.0.1:17321/selection';
  const TOKEN = 'aisel-local-bridge-v1';
  var BRIDGE_URL = 'http://127.0.0.1:17321';
  var bridgeOnline = true;
  var bridgeLastOkAt = Date.now();
  var bridgeFailCount = 0;
  var lastSelection = null;
  const DEBUG_PREFIX = '[AISel SubtitleOverlayProvider]';
  let mouseDown = null;
  let lastEditableSelection = null;

  console.log(DEBUG_PREFIX, 'content script loaded', location.href);

  const dot = document.createElement('div');
  dot.id = '__aisel__';
  dot.style.cssText = 'position:fixed;top:6px;right:6px;width:8px;height:8px;background:lime;border-radius:50%;z-index:2147483647;pointer-events:none;display:none';
  document.documentElement.appendChild(dot);

  document.addEventListener('mousedown', (event) => {
    mouseDown = {
      x: event.clientX,
      y: event.clientY,
      target: event.target,
      targetText: describeNode(event.target),
      pathClasses: pathClassList(event),
      elementFromPoint: describeNode(document.elementFromPoint(event.clientX, event.clientY)),
    };
    console.log(DEBUG_PREFIX, 'mouseDown target', mouseDown.targetText);
    console.log(DEBUG_PREFIX, 'mouseDown composedPath className list', mouseDown.pathClasses);
    console.log(DEBUG_PREFIX, 'elementFromPoint(mouseDown)', mouseDown.elementFromPoint);
  }, { capture: true, signal });


  function rememberEditableSelection(reason, event) {
    try {
      const point = event ? { x: event.clientX, y: event.clientY } : null;
      const el = findEditableSelectionElement(event || null, point, point);
      if (!el) return null;
      const result = resolveEditableSelectionFromElement(el);
      if (result && result.text) {
        lastEditableSelection = { result, at: Date.now(), reason };
        console.log(DEBUG_PREFIX, 'cached editable selection', reason, result.metadata && result.metadata.method, result.text.length);
        return result;
      }
    } catch (err) {
      console.log(DEBUG_PREFIX, 'rememberEditableSelection error', err && err.message);
    }
    return null;
  }

  document.addEventListener('select', (event) => {
    rememberEditableSelection('select-event', event);
  }, { capture: true, signal });

  document.addEventListener('selectionchange', () => {
    // `selectionchange` also fires for input/textarea selections in Chromium.
    // Caching it makes CJK search boxes more reliable because some sites move
    // focus or wrap the input during mouseup.
    rememberEditableSelection('selectionchange', null);
  }, { capture: true, signal });

  document.addEventListener('mouseup', (event) => {
    if (!mouseDown) return;
    const eventTarget = asElement(event.target);
    if (eventTarget && eventTarget.closest('.jiaohua-caption-drag-handle')) {
      mouseDown = null;
      return;
    }
    const dx = Math.abs(event.clientX - mouseDown.x);
    const dy = Math.abs(event.clientY - mouseDown.y);
    if (dx < 6 && dy < 6) {
      mouseDown = null;
      return;
    }
    const down = mouseDown;
    const up = { x: event.clientX, y: event.clientY, target: event.target };
    mouseDown = null;

    console.log(DEBUG_PREFIX, 'mouseUp target', describeNode(event.target));
    console.log(DEBUG_PREFIX, 'mouseUp composedPath className list', pathClassList(event));
    console.log(DEBUG_PREFIX, 'elementFromPoint(mouseUp)', describeNode(document.elementFromPoint(up.x, up.y)));
    setTimeout(() => pick(down, up, event), 30);
  }, { capture: true, signal });

  function pick(down, up, event) {
    const editableResult = resolveEditableSelection(down, up, event) || freshCachedEditableSelection();
    if (editableResult && editableResult.text) {
      console.log(DEBUG_PREFIX, 'detected browser selection', editableResult.metadata && editableResult.metadata.method || 'editable-selection');
      send(editableResult);
      return;
    }

    const selectionResult = resolveWindowSelection(down, up);
    let blockedWindowSelection = null;
    if (selectionResult && selectionResult.text) {
      console.log(DEBUG_PREFIX, 'detected browser selection', 'window-selection');
      send(selectionResult);
      return;
    }
    if (selectionResult && selectionResult.metadata && selectionResult.metadata.error) {
      blockedWindowSelection = selectionResult;
    }

    const adapters = [
      new YouTubeNativeCaptionAdapter(),
      new TrancyCaptionAdapter(),
      new GenericSubtitleOverlayAdapter(),
    ];

    for (const adapter of adapters) {
      const container = adapter.find(event, down, up);
      if (!container) continue;
      const result = adapter.resolve(container, down, up);
      logSubtitleResult(adapter.name, container, result);
      if (result && result.text) {
        send(result);
        return;
      }
      if (result && result.metadata && result.metadata.error) {
        send(result);
        return;
      }
    }

    if (blockedWindowSelection) {
      console.log(DEBUG_PREFIX, 'detected blocked browser selection', 'window-selection');
      send(blockedWindowSelection);
    } else {
      console.log(DEBUG_PREFIX, 'no browser selection result');
    }
  }

  class YouTubeNativeCaptionAdapter {
    constructor() { this.name = 'youtube-native-caption'; }

    find(event, down, up) {
      const target = asElement(event.target);
      const direct = closestAny(target, ['.ytp-caption-segment', '.ytp-caption-window-container']);
      if (direct) return direct.closest('.ytp-caption-window-container') || direct;
      return findSubtitleOverlayElement(event, up, { nativeOnly: true });
    }

    resolve(container, down, up) {
      return resolveGenericSubtitleOverlaySelection(container, down, up, {
        adapter: this.name,
        method: 'youtube-native-token-hit-test',
      });
    }
  }

  class TrancyCaptionAdapter {
    constructor() { this.name = 'trancy-caption'; }

    find(event, down, up) {
      const fromPath = findInComposedPath(event, (node) => isTrancyLikeElement(node) && isSubtitleCandidate(node));
      if (fromPath) return ensureTextLineContainer(refineTextContainer(fromPath));
      const downEl = document.elementFromPoint(down.x, down.y);
      const upEl = document.elementFromPoint(up.x, up.y);
      const fromPoint = [downEl, upEl]
        .map((node) => findAncestor(node, (el) => isTrancyLikeElement(el) && isSubtitleCandidate(el), 8))
        .find(Boolean);
      return fromPoint ? ensureTextLineContainer(refineTextContainer(fromPoint)) : null;
    }

    resolve(container, down, up) {
      return resolveGenericSubtitleOverlaySelection(container, down, up, {
        adapter: this.name,
        method: 'trancy-subtitle-token-hit-test',
      });
    }
  }

  class GenericSubtitleOverlayAdapter {
    constructor() { this.name = 'generic-subtitle-overlay'; }

    find(event, down, up) {
      if (!shouldUseGenericSubtitleOverlay(event, down, up)) return null;
      const fromDrag = findSubtitleOverlayByDragArea(down, up);
      if (fromDrag) return fromDrag;
      return findSubtitleOverlayElement(event, up, { nativeOnly: false }) ||
        findSubtitleOverlayElement(event, down, { nativeOnly: false });
    }

    resolve(container, down, up) {
      return resolveGenericSubtitleOverlaySelection(container, down, up, {
        adapter: this.name,
        method: 'generic-subtitle-token-hit-test',
      });
    }
  }

  function shouldUseGenericSubtitleOverlay(event, down, up) {
    const subtitleHit = findInComposedPath(event, (el) => {
      const signature = `${el.tagName || ''} ${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`.toLowerCase();
      return /(subtitle|caption|subtitles|captions|ytp-caption|cue|danmaku|trancy|immersive-translate|bilingual)/.test(signature);
    });
    if (subtitleHit) return true;

    const video = document.querySelector('video');
    if (!video) return false;
    const rect = video.getBoundingClientRect();
    if (!rect || rect.width < 160 || rect.height < 90) return false;
    const drag = dragRect(down, up, 18, 22);
    const dragCenterX = (drag.left + drag.right) / 2;
    const dragCenterY = (drag.top + drag.bottom) / 2;
    const inVideoX = dragCenterX >= rect.left - 24 && dragCenterX <= rect.right + 24;
    const inSubtitleBand = dragCenterY >= rect.top + rect.height * 0.45 && dragCenterY <= rect.bottom + 140;
    return inVideoX && inSubtitleBand;
  }

  function findSubtitleOverlayElement(event, mousePoint, options = {}) {
    const target = asElement(event.target);
    const native = closestAny(target, ['.ytp-caption-segment', '.ytp-caption-window-container']);
    if (native) return native.closest('.ytp-caption-window-container') || native;
    if (options.nativeOnly) return null;

    const pathHit = findInComposedPath(event, isSubtitleCandidate);
    if (pathHit) return refineTextContainer(pathHit);

    const pointElement = deepElementFromPoint(mousePoint.x, mousePoint.y);
    const ancestorHit = findAncestor(pointElement, isSubtitleCandidate, 8);
    if (ancestorHit) return refineTextContainer(ancestorHit);

    const bottomHit = Array.from(document.querySelectorAll('div, span, p'))
      .filter(isSubtitleCandidate)
      .sort((a, b) => subtitleScore(b, mousePoint) - subtitleScore(a, mousePoint))[0];
    return bottomHit ? refineTextContainer(bottomHit) : null;
  }

  function findSubtitleOverlayByDragArea(down, up) {
    const drag = dragRect(down, up, 18, 22);
    const candidates = Array.from(document.querySelectorAll('div, span, p, font, strong, em'))
      .filter((el) => {
        if (!isSubtitleCandidate(el)) return false;
        const rect = safeRect(el);
        if (!rect) return false;
        return rectIntersects(rect, drag) || pointNearRect(down, rect, 28) || pointNearRect(up, rect, 28);
      })
      .map((el) => {
        const refined = refineTextContainer(el);
        const rect = safeRect(refined || el);
        return { el: refined || el, score: subtitleDragScore(rect, drag, down, up) };
      })
      .filter((item) => item.el && Number.isFinite(item.score))
      .sort((a, b) => b.score - a.score);
    if (candidates[0]) {
      console.log(DEBUG_PREFIX, 'drag-area subtitle candidate', describeNode(candidates[0].el), candidates[0].score);
      return candidates[0].el;
    }
    return null;
  }

  function preferOriginalTextContainer(container) {
    if (!container) return container;
    const cls = String(container.className || '').toLowerCase();
    // Only reroute when the current container is a translation
    if (!/(^| )translated-text( |$)/.test(cls) && !/(^| )translation( |$)/.test(cls)) return container;
    // Look for sibling .original-text within the same parent
    const parent = container.parentElement;
    if (!parent) return container;
    const original = parent.querySelector('.original-text');
    if (original && isSubtitleCandidate(original)) {
      console.log(DEBUG_PREFIX, 'preferOriginalTextContainer: switching from translated-text to original-text',
        outerHTMLPreview(original));
      return original;
    }
    return container;
  }

  function ensureTextLineContainer(el) {
    // When the found element is a single word span (e.g. subtitle-word),
    // walk up to the line-level container (e.g. original-text) so token
    // hit-testing has access to all words in the line, not just one.
    if (!el) return el;
    const cls = String(el.className || '').toLowerCase();
    if (/(^| )subtitle-word( |$)/.test(cls)) {
      const line = el.closest('.original-text, .translated-text, .caption-line');
      if (line) {
        console.log(DEBUG_PREFIX, 'ensureTextLineContainer: walking up from word span to line', outerHTMLPreview(line));
        return line;
      }
    }
    return el;
  }

  function resolveGenericSubtitleOverlaySelection(container, down, up, opts) {
    // Prefer English original-text over translated-text (Trancy bilingual mode).
    // When Trancy shows bilingual subtitles, the translated-text div (e.g. Chinese)
    // and original-text div (English) are siblings. Always resolve the English one.
    container = preferOriginalTextContainer(container);

    const fullText = normalizeText(readVisibleText(container));
    const containerRect = safeRect(container);
    const metadataBase = {
      site: location.hostname,
      adapter: opts.adapter,
      method: opts.method,
      subtitleOverlayDetected: true,
      containerPreview: outerHTMLPreview(container),
    };

    if (!fullText || !containerRect) {
      return inaccessibleResult(metadataBase, 'third_party_extension_dom_not_accessible');
    }

    const tokens = collectTokenRects(container, fullText);
    const selectedTokens = tokens.filter((token) => token.selected || tokenIntersectsDrag(token.rect, down, up, containerRect));
    const preciseText = composeTokenText(selectedTokens);
    const rect = selectedTokens.length ? mergeRects(selectedTokens.map((token) => token.rect)) : rectToObj(containerRect);

    console.log(DEBUG_PREFIX, 'fullText', fullText);
    console.log(DEBUG_PREFIX, 'tokens', tokens.map((token) => ({ index: token.index, text: token.text, rect: token.rect })));
    console.log(DEBUG_PREFIX, 'selectedTokens', selectedTokens.map((token) => token.text));
    console.log(DEBUG_PREFIX, 'preciseText', preciseText);

    if (preciseText && preciseText.length < fullText.length) {
      return {
        text: preciseText,
        fullText,
        source: 'browser',
        confidence: 0.9,
        rect: viewportRectToScreenRect(rect),
        url: location.href,
        title: document.title,
        metadata: {
          ...metadataBase,
          tokenCount: tokens.length,
          selectedTokenCount: selectedTokens.length,
          selectedTokens: selectedTokens.map((token) => token.text),
        },
      };
    }

    // All tokens selected is valid when the container is a single subtitle line
    // (e.g. Trancy original-text div). Don't treat it as an error.
    if (preciseText && selectedTokens.length === tokens.length && tokens.length >= 2) {
      return {
        text: preciseText,
        fullText,
        source: 'browser',
        confidence: 0.88,
        rect: viewportRectToScreenRect(rect),
        url: location.href,
        title: document.title,
        metadata: { ...metadataBase, tokenCount: tokens.length, selectedTokenCount: selectedTokens.length },
      };
    }

    if (preciseText && tokens.length <= 2) {
      return {
        text: preciseText,
        fullText,
        source: 'browser',
        confidence: 0.86,
        rect: viewportRectToScreenRect(rect),
        url: location.href,
        title: document.title,
        metadata: metadataBase,
      };
    }

    return {
      text: '',
      fullText,
      source: 'browser',
      confidence: 0.2,
      rect: viewportRectToScreenRect(rectToObj(containerRect)),
      url: location.href,
      title: document.title,
      error: 'subtitle_overlay_precise_selection_failed',
      metadata: {
        ...metadataBase,
        needsManualSelection: false,
        lowConfidenceWarning: true,
        error: 'subtitle_overlay_precise_selection_failed',
        tokenCount: tokens.length,
      },
    };
  }

  function collectTokenRects(container, fullText) {
    const spanTokens = collectElementTokenRects(container);
    if (spanTokens.length) return spanTokens;
    return collectRangeTokenRects(container, fullText);
  }

  function collectElementTokenRects(container) {
    const elements = Array.from(container.querySelectorAll('span, b, i, em, strong, ruby, rt'))
      .filter((el) => isVisible(el) && normalizeText(el.textContent || '').length > 0);
    const tokenItems = [];
    for (const el of elements) {
      const text = normalizeText(el.textContent || '');
      const rect = safeRect(el);
      if (!rect) continue;
      const parts = tokenize(text);
      if (parts.length === 1) {
        tokenItems.push({ text: parts[0], rect });
      } else {
        const subRects = rangeRectsForText(el, text);
        tokenItems.push(...subRects);
      }
    }
    return normalizeTokenItems(tokenItems);
  }

  function collectRangeTokenRects(container, fullText) {
    return normalizeTokenItems(rangeRectsForText(container, fullText));
  }

  function rangeRectsForText(root, sourceText) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return normalizeText(node.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const out = [];
    let node;
    while ((node = walker.nextNode())) {
      const value = node.nodeValue || '';
      const regex = /[A-Za-z0-9]+(?:['\u2019-][A-Za-z0-9]+)*|[\u4e00-\u9fff]|[^\s]/g;
      let match;
      while ((match = regex.exec(value))) {
        const range = document.createRange();
        try {
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          const rect = range.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            out.push({ text: match[0], rect });
          }
        } catch (_) {
          // ignore range errors from detached nodes
        } finally {
          range.detach();
        }
      }
    }
    if (!out.length && sourceText) {
      const rect = safeRect(root);
      return tokenize(sourceText).map((text) => ({ text, rect }));
    }
    return out;
  }

  function normalizeTokenItems(items) {
    return items
      .filter((item) => item && item.text && item.rect && item.rect.width > 0 && item.rect.height > 0)
      .map((item, index) => ({
        index,
        text: item.text,
        rect: rectToObj(item.rect),
        selected: false,
      }));
  }

  function composeTokenText(tokens) {
    const ordered = [...(tokens || [])].sort((a, b) => a.index - b.index);
    let output = '';
    let prev = null;
    for (const token of ordered) {
      const text = normalizeText(token.text);
      if (!text) continue;
      if (!output) {
        output = text;
        prev = token;
        continue;
      }
      // Never add space before standalone punctuation or contractions
      const isPunct = /^[.,!?;:'")\]}']$/.test(text);
      const isContraction = /^'[a-zA-Z]+$/.test(text); // 's, 'm, 're, 'll, 've, 'd
      const joinWithoutSpace = isPunct || isContraction || shouldJoinToken(prev, token);
      output += joinWithoutSpace ? text : ' ' + text;
      prev = token;
    }
    return normalizeText(output);
  }

  function shouldJoinToken(prev, current) {
    if (!prev || !current) return false;
    const a = normalizeText(prev.text);
    const b = normalizeText(current.text);
    if (!a || !b) return false;
    if (/^['’][A-Za-z]+$/.test(b)) return true;
    if (!/^[A-Za-z]+$/.test(a) || !/^[A-Za-z]+$/.test(b)) return false;

    const pr = rectLike(prev.rect);
    const cr = rectLike(current.rect);
    const sameLine = Math.abs(((pr.top + pr.bottom) / 2) - ((cr.top + cr.bottom) / 2)) <= Math.max(8, Math.min(pr.height, cr.height) * 0.45);
    if (!sameLine) return false;
    const gap = cr.left - pr.right;
    const tinyVisualGap = gap >= -2 && gap <= Math.max(4, Math.min(pr.height, cr.height) * 0.18);

    // Handles subtitle renderers that split one word into letter spans:
    // "O" + "n" should become "On", while "Come" + "On" keeps a space.
    // Both tokens must be single-character to trigger the join — otherwise
    // adjacent words like "I" + "spoke" get incorrectly merged into "Ispoke".
    return tinyVisualGap && a.length === 1 && b.length === 1;
  }

  function tokenIntersectsDrag(rect, down, up, containerRect) {
    const left = Math.min(down.x, up.x) - 3;
    const right = Math.max(down.x, up.x) + 3;
    const top = Math.min(down.y, up.y) - 8;
    const bottom = Math.max(down.y, up.y) + 8;
    const drag = { left, right, top, bottom };
    const tokenRect = rectLike(rect);
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    if (cx >= left && cx <= right && cy >= top && cy <= bottom) return true;

    const mostlyHorizontal = Math.abs(up.x - down.x) > Math.abs(up.y - down.y);
    if (mostlyHorizontal && cy >= containerRect.top - 8 && cy <= containerRect.bottom + 8) {
      const overlapX = Math.max(0, Math.min(tokenRect.right, drag.right) - Math.max(tokenRect.left, drag.left));
      const overlapRatio = overlapX / Math.max(1, tokenRect.width);
      if (overlapRatio >= 0.35) return true;
      return cx >= left && cx <= right;
    }
    return false;
  }

  function dragRect(down, up, padX = 0, padY = 0) {
    return {
      left: Math.min(down.x, up.x) - padX,
      right: Math.max(down.x, up.x) + padX,
      top: Math.min(down.y, up.y) - padY,
      bottom: Math.max(down.y, up.y) + padY,
    };
  }

  function rectLike(rect) {
    return {
      left: rect.left ?? rect.x,
      right: (rect.left ?? rect.x) + rect.width,
      top: rect.top ?? rect.y,
      bottom: (rect.top ?? rect.y) + rect.height,
      width: rect.width,
      height: rect.height,
    };
  }

  function rectIntersects(a, b) {
    const ra = rectLike(a);
    return ra.left <= b.right && ra.right >= b.left && ra.top <= b.bottom && ra.bottom >= b.top;
  }

  function rectOverlapArea(a, b) {
    const ra = rectLike(a);
    const x = Math.max(0, Math.min(ra.right, b.right) - Math.max(ra.left, b.left));
    const y = Math.max(0, Math.min(ra.bottom, b.bottom) - Math.max(ra.top, b.top));
    return x * y;
  }

  function pointNearRect(point, rect, pad = 0) {
    const r = rectLike(rect);
    return point.x >= r.left - pad && point.x <= r.right + pad && point.y >= r.top - pad && point.y <= r.bottom + pad;
  }

  function subtitleDragScore(rect, drag, down, up) {
    if (!rect) return -Infinity;
    const r = rectLike(rect);
    const overlap = rectOverlapArea(r, drag);
    const dragCenterX = (drag.left + drag.right) / 2;
    const dragCenterY = (drag.top + drag.bottom) / 2;
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    const distance = Math.hypot(cx - dragCenterX, cy - dragCenterY);
    const video = document.querySelector('video');
    let bandBoost = 0;
    if (video) {
      const vr = video.getBoundingClientRect();
      if (cy >= vr.top + vr.height * 0.45 && cy <= vr.bottom + 120) bandBoost = 500;
    }
    return overlap * 20 - distance + bandBoost;
  }


  function resolveEditableSelection(down, up, event) {
    const el = findEditableSelectionElement(event, down, up);
    if (!el) return null;
    return resolveEditableSelectionFromElement(el);
  }

  function resolveEditableSelectionFromElement(el) {
    if (!el) return null;

    if (isTextInputElement(el) || el.tagName === 'TEXTAREA') {
      return resolveTextControlSelection(el);
    }

    // contenteditable normally works through window.getSelection().
    // Keep this as a focused fallback for custom editors that expose a textbox role.
    if (isContentEditableElement(el)) {
      const sel = window.getSelection();
      const text = (sel && !sel.isCollapsed) ? normalizeText(sel.toString()) : '';
      if (!text) return null;
      const rect = selectionRectFromWindowSelection(sel) || rectToObj(el.getBoundingClientRect());
      return {
        text,
        fullText: text,
        source: 'browser',
        confidence: text.length <= 120 ? 0.93 : 0.86,
        rect: viewportRectToScreenRect(rect),
        url: location.href,
        title: document.title,
        metadata: {
          site: location.hostname,
          method: 'contenteditable-selection',
          elementTag: String(el.tagName || '').toLowerCase(),
          role: el.getAttribute('role') || '',
          editable: true,
          cjkSafe: containsCjk(text),
        },
      };
    }

    return null;
  }

  function freshCachedEditableSelection() {
    if (!lastEditableSelection || !lastEditableSelection.result) return null;
    if (Date.now() - lastEditableSelection.at > 1200) return null;
    return lastEditableSelection.result;
  }

  function resolveTextControlSelection(el) {
    if (!el || typeof el.selectionStart !== 'number' || typeof el.selectionEnd !== 'number') return null;
    if (isPasswordLikeInput(el)) return null;

    const start = Math.min(el.selectionStart, el.selectionEnd);
    const end = Math.max(el.selectionStart, el.selectionEnd);
    if (end <= start) return null;

    const rawValue = String(el.value || '');
    const rawText = rawValue.slice(start, end);
    const text = normalizeText(rawText);
    if (!text) return null;

    const rect = estimateTextControlSelectionRect(el, start, end) || rectToObj(el.getBoundingClientRect());
    const tag = String(el.tagName || '').toLowerCase();
    const type = String(el.getAttribute('type') || '').toLowerCase();

    return {
      text,
      fullText: text,
      source: 'browser',
      confidence: text.length <= 120 ? 0.96 : 0.9,
      rect: viewportRectToScreenRect(rect),
      url: location.href,
      title: document.title,
      metadata: {
        site: location.hostname,
        method: tag === 'textarea' ? 'editable-textarea-selection' : 'editable-input-selection',
        elementTag: tag,
        inputType: type,
        selectionStart: start,
        selectionEnd: end,
        editable: true,
        cjkSafe: containsCjk(text),
      },
    };
  }

  function findEditableSelectionElement(event, down, up) {
    const candidates = [
      getDeepActiveElement(document),
      asElement(event && event.target),
      (up && Number.isFinite(up.x) && Number.isFinite(up.y)) ? deepElementFromPoint(up.x, up.y) : null,
      (down && Number.isFinite(down.x) && Number.isFinite(down.y)) ? deepElementFromPoint(down.x, down.y) : null,
    ].filter(Boolean);

    for (const node of candidates) {
      const el = findEditableAncestor(node);
      if (el) return el;
    }
    return null;
  }

  function getDeepActiveElement(root) {
    let active = root && root.activeElement;
    for (let i = 0; active && active.shadowRoot && active.shadowRoot.activeElement && i < 6; i++) {
      active = active.shadowRoot.activeElement;
    }
    return active || null;
  }

  function findEditableAncestor(node) {
    let el = asElement(node);
    for (let i = 0; el && i < 8; i++) {
      if (isTextInputElement(el) || el.tagName === 'TEXTAREA' || isContentEditableElement(el)) return el;
      if (el.querySelector) {
        const nested = el.querySelector('input[type="text"], input[type="search"], input:not([type]), textarea, [contenteditable="true"], [role="textbox"]');
        if (nested && (isTextInputElement(nested) || nested.tagName === 'TEXTAREA' || isContentEditableElement(nested))) return nested;
      }
      el = el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
    }
    return null;
  }

  function isTextInputElement(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    const type = String(el.getAttribute('type') || 'text').toLowerCase();
    return [
      'text', 'search', 'url', 'email', 'tel', 'number', 'password'
    ].includes(type);
  }

  function isPasswordLikeInput(el) {
    return el && el.tagName === 'INPUT' && String(el.getAttribute('type') || '').toLowerCase() === 'password';
  }

  function isContentEditableElement(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const role = String(el.getAttribute && el.getAttribute('role') || '').toLowerCase();
    return role === 'textbox' && String(el.getAttribute('contenteditable') || '').toLowerCase() !== 'false';
  }

  function selectionRectFromWindowSelection(sel) {
    try {
      if (!sel || sel.rangeCount <= 0) return null;
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) return rectToObj(r);
    } catch (_) {}
    return null;
  }

  function estimateTextControlSelectionRect(el, start, end) {
    const base = safeRect(el);
    if (!base) return null;

    // For textarea and complex styled inputs, an element-level rect is safer than
    // an inaccurate tiny rect. It still anchors the toolbar to the search/input box.
    if (el.tagName === 'TEXTAREA') return rectToObj(base);

    try {
      const style = getComputedStyle(el);
      const mirror = document.createElement('div');
      const before = document.createElement('span');
      const selected = document.createElement('span');

      const copyProps = [
        'boxSizing', 'width', 'height', 'fontFamily', 'fontSize', 'fontWeight',
        'fontStyle', 'letterSpacing', 'textTransform', 'paddingLeft',
        'paddingRight', 'paddingTop', 'paddingBottom', 'borderLeftWidth',
        'borderRightWidth', 'borderTopWidth', 'borderBottomWidth'
      ];
      mirror.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;white-space:pre;overflow:hidden;';
      for (const prop of copyProps) mirror.style[prop] = style[prop];
      mirror.textContent = '';
      before.textContent = String(el.value || '').slice(0, start).replace(/ /g, '\u00a0');
      selected.textContent = String(el.value || '').slice(start, end).replace(/ /g, '\u00a0') || '\u00a0';
      mirror.appendChild(before);
      mirror.appendChild(selected);
      document.body.appendChild(mirror);

      const beforeRect = before.getBoundingClientRect();
      const selectedRect = selected.getBoundingClientRect();
      const scrollLeft = Number(el.scrollLeft || 0);

      const x = base.left + (beforeRect.width || 0) - scrollLeft + parseFloat(style.paddingLeft || '0');
      const y = base.top;
      const width = Math.max(20, Math.min(base.width, selectedRect.width || 20));
      const height = base.height;

      mirror.remove();

      if (Number.isFinite(x) && Number.isFinite(width)) {
        return rectToObj({
          left: Math.max(base.left, Math.min(x, base.right - 8)),
          top: y,
          width: Math.min(width, base.right - Math.max(base.left, x)),
          height,
        });
      }
    } catch (_) {}

    return rectToObj(base);
  }


  function resolveWindowSelection(down, up) {
    const sel = window.getSelection();
    const text = (sel && !sel.isCollapsed) ? normalizeText(sel.toString()) : '';
    if (!text) return null;
    let rect;
    try {
      if (sel.rangeCount > 0) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        if (r.width > 0) rect = rectToObj(r);
      }
    } catch (_) {}

    if (isLikelyVideoSubtitleSelection(text, rect, down, up)) {
      console.log(DEBUG_PREFIX, 'window-selection blockedFullSubtitleLine', { text, rect, down, up });
      return {
        text: '',
        fullText: text,
        source: 'browser',
        confidence: 0.2,
        rect: viewportRectToScreenRect(rect),
        url: location.href,
        title: document.title,
        error: 'subtitle_window_selection_full_line_blocked',
        metadata: {
          site: location.hostname,
          method: 'window-selection-blocked-full-line',
          subtitleOverlayDetected: true,
          needsManualSelection: false,
          lowConfidenceWarning: true,
          error: 'subtitle_window_selection_full_line_blocked',
        },
      };
    }

    return {
      text,
      fullText: text,
      source: 'browser',
      confidence: text.length <= 30 ? 0.94 : 0.82,
      rect: viewportRectToScreenRect(rect),
      url: location.href,
      title: document.title,
      metadata: { site: location.hostname, method: 'window-selection' },
    };
  }

  function isLikelyVideoSubtitleSelection(text, rect, down, up) {
    if (!rect || !text || !down || !up) return false;
    const words = tokenize(text).length;
    if (words <= 2) return false;
    const video = document.querySelector('video');
    const dragWidth = Math.abs(up.x - down.x);
    const selectedWidth = rect.width || 0;
    if (selectedWidth > 0 && dragWidth > selectedWidth * 0.7) return false;
    if (!video) return location.hostname.includes('youtube') && dragWidth < selectedWidth * 0.55;
    const vr = video.getBoundingClientRect();
    const cy = rect.y + rect.height / 2;
    const nearSubtitleBand = cy >= vr.top + vr.height * 0.45 && cy <= vr.bottom + 100;
    return nearSubtitleBand && dragWidth < selectedWidth * 0.65;
  }

  function inaccessibleResult(metadata, error) {
    return {
      text: '',
      fullText: '',
      source: 'browser',
      confidence: 0.2,
      error,
      url: location.href,
      title: document.title,
      metadata: {
        ...metadata,
        error,
        subtitleOverlayDetected: true,
        needsManualSelection: false,
        lowConfidenceWarning: true,
      },
    };
  }

  function isSubtitleCandidate(node) {
    const el = asElement(node);
    if (!el || isExcludedElement(el) || !isVisible(el)) return false;
    const text = normalizeText(readVisibleText(el));
    if (!text || text.length > 300) return false;
    const rect = safeRect(el);
    if (!rect || rect.width <= 20 || rect.height <= 10) return false;
    if (!isInVideoArea(rect)) return false;
    return true;
  }

  function isTrancyLikeElement(node) {
    const el = asElement(node);
    if (!el) return false;
    const value = `${el.id || ''} ${el.className || ''} ${el.getAttribute('data-testid') || ''} ${el.getAttribute('data-name') || ''}`.toLowerCase();
    return /trancy|tracy|language.?reactor|dual.?sub|subtitle|caption|translation|transcript|lr-|lln/.test(value);
  }

  function isExcludedElement(el) {
    if (!el || !el.closest) return true;
    if (el.closest('button,input,textarea,select,a[href],ytd-comments,ytd-watch-metadata,.ytp-chrome-bottom,.ytp-control,.ytp-title,.ytp-progress-bar,.ytp-gradient-bottom,.ytp-settings-menu,.ytp-popup')) return true;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (['button', 'menu', 'menuitem', 'slider', 'progressbar'].includes(role)) return true;
    return false;
  }

  function isInVideoArea(rect) {
    const video = document.querySelector('video');
    if (!video) return rect.top > window.innerHeight * 0.35;
    const vr = video.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const insideX = cx >= vr.left - 80 && cx <= vr.right + 80;
    const insideY = cy >= vr.top && cy <= vr.bottom + 80;
    const lowerPreferred = cy >= vr.top + vr.height * 0.45;
    return insideX && insideY && lowerPreferred;
  }

  function subtitleScore(el, mousePoint) {
    const rect = safeRect(el);
    if (!rect) return -Infinity;
    const video = document.querySelector('video');
    const bottomScore = video ? (rect.top - video.getBoundingClientRect().top) : rect.top;
    const centerX = rect.left + rect.width / 2;
    const mouseDistance = Math.abs(centerX - mousePoint.x) + Math.abs((rect.top + rect.height / 2) - mousePoint.y);
    return bottomScore - mouseDistance * 0.1;
  }

  function refineTextContainer(el) {
    if (!el) return null;
    let best = el;
    for (let i = 0; i < 4; i++) {
      const children = Array.from(best.children || []).filter(isSubtitleCandidate);
      if (!children.length) break;
      // Third-party subtitle overlays often wrap every word in its own span.
      // Picking the shortest child makes drags on "I think that 's it" collapse
      // to tiny tokens like "'s". Only descend through a single wrapper; keep a
      // multi-token row intact so token rect hit-testing can decide precisely.
      if (children.length !== 1) break;
      const childText = normalizeText(readVisibleText(children[0]));
      const bestText = normalizeText(readVisibleText(best));
      if (!childText || childText === bestText) {
        best = children[0];
      } else {
        break;
      }
    }
    return best;
  }

  function findInComposedPath(event, predicate) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    for (const node of path) {
      const el = asElement(node);
      if (el && predicate(el)) return el;
    }
    return null;
  }

  function findAncestor(node, predicate, maxDepth) {
    let el = asElement(node);
    for (let i = 0; el && i < maxDepth; i++) {
      if (predicate(el)) return el;
      el = el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
    }
    return null;
  }

  function deepElementFromPoint(x, y) {
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return null;
    let el = document.elementFromPoint(x, y);
    for (let i = 0; el && i < 4; i++) {
      if (el.shadowRoot) {
        const inner = el.shadowRoot.elementFromPoint(x, y);
        if (inner && inner !== el) {
          el = inner;
          continue;
        }
      }
      break;
    }
    return el;
  }

  function closestAny(el, selectors) {
    if (!el || !el.closest) return null;
    for (const selector of selectors) {
      const hit = el.closest(selector);
      if (hit) return hit;
    }
    return null;
  }

  function readVisibleText(el) {
    if (!el) return '';
    return el.innerText || el.textContent || '';
  }

  function isVisible(el) {
    const rect = safeRect(el);
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0.05;
  }

  function safeRect(el) {
    if (!el || !el.getBoundingClientRect) return null;
    const rect = el.getBoundingClientRect();
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return null;
    return rect;
  }

  function rectToObj(rect) {
    return {
      x: Math.round(rect.left ?? rect.x),
      y: Math.round(rect.top ?? rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }

  function viewportRectToScreenRect(rect) {
    if (!rect) return rect;
    const borderX = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
    const chromeY = Math.max(0, window.outerHeight - window.innerHeight - borderX);
    const screenLeft = Number(window.screenX ?? window.screenLeft ?? 0);
    const screenTop = Number(window.screenY ?? window.screenTop ?? 0);
    return {
      x: Math.round(screenLeft + borderX + rect.x),
      y: Math.round(screenTop + chromeY + rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }

  function mergeRects(rects) {
    const x = Math.min(...rects.map((r) => r.x));
    const y = Math.min(...rects.map((r) => r.y));
    const right = Math.max(...rects.map((r) => r.x + r.width));
    const bottom = Math.max(...rects.map((r) => r.y + r.height));
    return { x, y, width: right - x, height: bottom - y };
  }

  function tokenize(text) {
    // Pattern order matters: contractions like 's, 'm, 're must match
    // before the [^\s] catch-all, otherwise ' gets split as a lone token.
    return Array.from(normalizeText(text).matchAll(/[A-Za-z0-9]+(?:['\u2019-][A-Za-z0-9]+)*|'[A-Za-z]+|[\u4e00-\u9fff]|[^\s]/g)).map((m) => m[0]);
  }

  function containsCjk(text) {
    return /[㐀-鿿豈-﫿]/.test(String(text || ''));
  }

  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function outerHTMLPreview(el) {
    try { return (el.outerHTML || '').slice(0, 300); } catch (_) { return ''; }
  }

  function pathClassList(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    return path.slice(0, 12).map(describeNode);
  }

  function describeNode(node) {
    const el = asElement(node);
    if (!el) return String(node && node.nodeName || '');
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().replace(/\s+/g, '.')}` : '';
    return `${el.tagName ? el.tagName.toLowerCase() : 'node'}${id}${cls}`;
  }

  function asElement(node) {
    if (!node) return null;
    if (node.nodeType === Node.ELEMENT_NODE) return node;
    if (node.parentElement) return node.parentElement;
    return null;
  }

  function logSubtitleResult(adapterName, container, result) {
    console.log(DEBUG_PREFIX, 'detected subtitle adapter', adapterName);
    console.log(DEBUG_PREFIX, 'subtitle container outerHTML first 300', outerHTMLPreview(container));
    if (!result) return;
    console.log(DEBUG_PREFIX, 'fullText', result.fullText || '');
    console.log(DEBUG_PREFIX, 'preciseText', result.text || '');
  }

  function send(data) {
    data.token = TOKEN;
    lastSelection = data;
    doSend(data);
  }

  // Video sites often render captions in draggable, non-selectable layers.
  // Mirror live captions into a selectable overlay instead:
  // the caption text keeps native browser selection while the separate handle
  // owns moving the overlay. The native CC remains the source of truth and is
  // only made transparent while the mirror is healthy and visible.
  function createSelectableCaptionController() {
    const isYouTube = /(^|\.)youtube\.com$/i.test(location.hostname);
    const isBilibili = /(^|\.)bilibili\.com$/i.test(location.hostname);
    if (!isYouTube && !isBilibili) return null;

    const STYLE_ID = 'jiaohua-selectable-caption-style';
    const OVERLAY_ID = 'jiaohua-selectable-caption-overlay';
    const ACTIVE_CLASS = 'jiaohua-selectable-caption-active';
    let overlay = null;
    let textElement = null;
    let player = null;
    let observer = null;
    let resizeObserver = null;
    let syncQueued = false;
    let userMoved = false;
    let disposed = false;
    let enabled = true;

    document.getElementById(OVERLAY_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
    document.documentElement.classList.remove(ACTIVE_CLASS);

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      html.${ACTIVE_CLASS} .html5-video-player .ytp-caption-window-container {
        opacity: 0 !important;
      }
      html.${ACTIVE_CLASS} .bpx-player-video-area .bpx-player-subtitle-wrap {
        opacity: 0 !important;
      }
      #${OVERLAY_ID} {
        position: absolute;
        z-index: 35;
        display: none;
        width: max-content;
        max-width: min(86%, 960px);
        transform: translateX(-50%);
        pointer-events: none;
        text-align: center;
        font-family: Arial, Helvetica, sans-serif;
        line-height: 1.32;
        filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .9));
      }
      #${OVERLAY_ID} .jiaohua-caption-drag-handle {
        display: flex;
        width: 42px;
        height: 25px;
        position: absolute;
        left: 50%;
        top: -33px;
        margin-left: -21px;
        align-items: center;
        justify-content: center;
        border-radius: 14px;
        background: rgba(20, 20, 20, .88);
        color: #fff;
        cursor: grab;
        pointer-events: auto;
        user-select: none;
        -webkit-user-select: none;
        touch-action: none;
        font-size: 15px;
        letter-spacing: 2px;
        opacity: 0;
        visibility: hidden;
        transform: translateY(5px);
        transition: opacity .14s ease, transform .14s ease, visibility .14s;
      }
      #${OVERLAY_ID}:hover .jiaohua-caption-drag-handle,
      #${OVERLAY_ID}:focus-within .jiaohua-caption-drag-handle {
        opacity: 1;
        visibility: visible;
        transform: translateY(0);
      }
      #${OVERLAY_ID} .jiaohua-caption-drag-handle:active { cursor: grabbing; }
      #${OVERLAY_ID} .jiaohua-caption-text {
        display: block;
        width: max-content;
        max-width: 100%;
        padding: .12em .28em .16em;
        border-radius: .22em;
        background: rgba(8, 8, 8, .32);
        color: #fff;
        cursor: text;
        pointer-events: auto;
        user-select: text !important;
        -webkit-user-select: text !important;
        box-decoration-break: clone;
        -webkit-box-decoration-break: clone;
        white-space: normal;
        text-wrap: balance;
      }
      #${OVERLAY_ID} .jiaohua-caption-text::selection {
        background: #2f7cf6;
        color: #fff;
      }
    `;
    (document.head || document.documentElement).appendChild(style);

    function hasVisibleBox(node) {
      if (!node || !node.isConnected) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function captionState() {
      if (isYouTube) {
        const windows = Array.from(document.querySelectorAll('.ytp-caption-window-container'))
          .filter((node) => node.id !== OVERLAY_ID && hasVisibleBox(node));
        const segments = windows.flatMap((node) => Array.from(node.querySelectorAll('.ytp-caption-segment')))
          .filter(hasVisibleBox);
        const text = normalizeText(segments.map((node) => node.textContent || '').join(' '));
        return { text, anchor: windows[0] || segments[0] || null };
      }

      const candidates = Array.from(document.querySelectorAll(
        '.bpx-player-subtitle-wrap .bili-subtitle-x-subtitle-panel-text, ' +
        '.bpx-player-subtitle-wrap [class*="subtitle-panel-text"]',
      )).filter(hasVisibleBox);
      const text = normalizeText(candidates.map((node) => node.textContent || '').join(' '));
      return {
        text: text === '字幕样式测试' ? '' : text,
        anchor: candidates[0] || null,
      };
    }

    function findPlayer() {
      return isYouTube
        ? document.querySelector('.html5-video-player')
        : document.querySelector('.bpx-player-video-area, .bpx-player-container');
    }

    function ensureOverlay(nextPlayer) {
      if (overlay && player === nextPlayer && overlay.isConnected) return;
      overlay?.remove();
      resizeObserver?.disconnect();
      player = nextPlayer;
      userMoved = false;

      overlay = document.createElement('div');
      overlay.id = OVERLAY_ID;
      overlay.setAttribute('role', 'region');
      overlay.setAttribute('aria-label', '饺滑可划词字幕');
      const handle = document.createElement('div');
      handle.className = 'jiaohua-caption-drag-handle';
      handle.title = '拖动字幕';
      handle.setAttribute('aria-label', '拖动字幕');
      handle.textContent = '⠿';
      textElement = document.createElement('span');
      textElement.className = 'jiaohua-caption-text';
      overlay.append(handle, textElement);
      player.appendChild(overlay);
      installDragHandle(handle);

      resizeObserver = new ResizeObserver(() => {
        if (!userMoved) queueSync();
        else clampOverlayToPlayer();
      });
      resizeObserver.observe(player);
    }

    function installDragHandle(handle) {
      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || !overlay || !player) return;
        event.preventDefault();
        event.stopPropagation();
        userMoved = true;
        const playerRect = player.getBoundingClientRect();
        const overlayRect = overlay.getBoundingClientRect();
        const offsetX = event.clientX - overlayRect.left;
        const offsetY = event.clientY - overlayRect.top;
        handle.setPointerCapture(event.pointerId);

        const move = (moveEvent) => {
          moveEvent.preventDefault();
          const halfWidth = overlayRect.width / 2;
          const nextCenterX = moveEvent.clientX - playerRect.left - offsetX + halfWidth;
          const nextTop = moveEvent.clientY - playerRect.top - offsetY;
          setOverlayPosition(nextCenterX, nextTop);
        };
        const finish = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', finish);
          handle.removeEventListener('pointercancel', finish);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', finish);
        handle.addEventListener('pointercancel', finish);
      });
    }

    function setOverlayPosition(centerX, top) {
      if (!overlay || !player) return;
      const maxX = Math.max(24, player.clientWidth - 24);
      const maxTop = Math.max(0, player.clientHeight - overlay.offsetHeight);
      overlay.style.left = `${Math.max(24, Math.min(maxX, centerX))}px`;
      overlay.style.top = `${Math.max(0, Math.min(maxTop, top))}px`;
      overlay.style.bottom = 'auto';
    }

    function clampOverlayToPlayer() {
      if (!overlay || !player) return;
      const rect = overlay.getBoundingClientRect();
      const playerRect = player.getBoundingClientRect();
      setOverlayPosition(
        rect.left - playerRect.left + rect.width / 2,
        rect.top - playerRect.top,
      );
    }

    function positionFromNative(anchor) {
      if (!overlay || !player || !anchor || userMoved) return;
      const nativeRect = anchor.getBoundingClientRect();
      const playerRect = player.getBoundingClientRect();
      setOverlayPosition(
        nativeRect.left - playerRect.left + nativeRect.width / 2,
        Math.max(12, nativeRect.top - playerRect.top - 32),
      );
    }

    function sync() {
      syncQueued = false;
      if (disposed) return;
      const nextPlayer = findPlayer();
      const state = captionState();
      if (!enabled || !nextPlayer || !state.text || !state.anchor) {
        if (overlay) overlay.style.display = 'none';
        document.documentElement.classList.remove(ACTIVE_CLASS);
        return;
      }

      ensureOverlay(nextPlayer);
      if (textElement.textContent !== state.text) textElement.textContent = state.text;
      const nativeStyle = getComputedStyle(state.anchor.querySelector('.ytp-caption-segment') || state.anchor);
      const nativeSize = Number.parseFloat(nativeStyle.fontSize);
      const baseSize = Number.isFinite(nativeSize) ? nativeSize * .82 : player.clientHeight * .036;
      const availableWidth = Math.min(player.clientWidth * .86, 960);
      const hasCjk = /[\u3400-\u9fff]/.test(state.text);
      const estimatedWidth = state.text.length * baseSize * (hasCjk ? .98 : .53);
      const fitScale = estimatedWidth > availableWidth ? Math.max(.78, availableWidth / estimatedWidth) : 1;
      overlay.style.fontSize = `${Math.max(15, Math.min(32, baseSize * fitScale))}px`;
      overlay.style.display = 'block';
      positionFromNative(state.anchor);
      document.documentElement.classList.add(ACTIVE_CLASS);
    }

    function queueSync() {
      if (syncQueued || disposed) return;
      syncQueued = true;
      requestAnimationFrame(sync);
    }

    observer = new MutationObserver(queueSync);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    window.addEventListener('resize', queueSync, { signal });
    document.addEventListener('fullscreenchange', queueSync, { signal });
    queueSync();

    const onStorageChanged = (changes, areaName) => {
      if (areaName !== 'sync' || !changes.selectableCaptionsEnabled) return;
      enabled = changes.selectableCaptionsEnabled.newValue !== false;
      queueSync();
    };
    try {
      chrome.storage.sync.get({ selectableCaptionsEnabled: true }, (stored) => {
        enabled = stored.selectableCaptionsEnabled !== false;
        queueSync();
      });
      chrome.storage.onChanged.addListener(onStorageChanged);
    } catch (_) {}

    return function cleanup() {
      disposed = true;
      observer?.disconnect();
      resizeObserver?.disconnect();
      overlay?.remove();
      style.remove();
      document.documentElement.classList.remove(ACTIVE_CLASS);
      try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch (_) {}
    };
  }

  const cleanupSelectableCaptions = createSelectableCaptionController();
  window.__AISEL_CLEANUP__ = function () {
    try { ac.abort(); } catch (_) {}
    try { cleanupSelectableCaptions?.(); } catch (_) {}
  };

  function doSend(data, attempt) {
    if (typeof attempt === 'undefined') attempt = 0;
    if (!bridgeOnline && attempt > 0) {
      console.log('[AISel] bridge offline, selection queued');
      return;
    }
    var delays = [300, 800, 1500, 3000];
    dot.style.background = 'cyan';
    fetch(BRIDGE_URL + '/selection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
      .then(function (response) {
        dot.style.background = response.ok ? 'lime' : 'red';
        if (!response.ok) {
          console.log('[AISel] sendToElectron fail', response.status);
          if (attempt < delays.length) setTimeout(function() { doSend(data, attempt + 1); }, delays[attempt]);
        }
      })
      .catch(function (error) {
        dot.style.background = 'red';
        console.log('[AISel] sendToElectron error', error && error.message);
        if (attempt < delays.length) setTimeout(function() { doSend(data, attempt + 1); }, delays[attempt]);
      });
  }

  // ????? Bridge health monitor (3s interval) ?????
  function checkHealth() {
    fetch(BRIDGE_URL + '/health')
      .then(function (res) {
        if (res.ok) {
          if (!bridgeOnline) {
            console.log('[AISel] bridge restored');
            if (lastSelection) doSend(lastSelection);
          }
          bridgeOnline = true;
          bridgeLastOkAt = Date.now();
          bridgeFailCount = 0;
          updateDot();
        } else {
          onHealthFail();
        }
      })
      .catch(function () { onHealthFail(); });
  }

  function onHealthFail() {
    bridgeOnline = false;
    bridgeFailCount++;
    updateDot();
  }

  function updateDot(color) {
    if (!color) {
      dot.style.background = bridgeOnline ? 'lime' : 'red';
    } else {
      dot.style.background = color;
    }
  }

  setInterval(checkHealth, 3000);

  // ????? Runtime ping (background.js alive check) ?????
  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (msg && msg.type === 'AISEL_PING') {
        sendResponse({
          type: 'AISEL_PONG',
          version: VERSION,
          href: location.href,
          bridgeOnline: bridgeOnline,
        });
      }
    });
  } catch (e) {
    console.log('[AISel] chrome.runtime not available for ping');
  }

  // ????? Page lifecycle recovery ?????
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) checkHealth();
  }, { signal: signal });

  window.addEventListener('pageshow', function (event) {
    if (event.persisted) checkHealth();
  }, { signal: signal });

  window.addEventListener('focus', function () {
    checkHealth();
  }, { signal: signal });

  // ????? SPA navigation detection ?????
  window.addEventListener('popstate', function () {
    setTimeout(checkHealth, 100);
  }, { signal: signal });

  var origPushState = history.pushState;
  history.pushState = function () {
    origPushState.apply(this, arguments);
    setTimeout(checkHealth, 100);
  };

  var origReplaceState = history.replaceState;
  history.replaceState = function () {
    origReplaceState.apply(this, arguments);
    setTimeout(checkHealth, 100);
  };

})();
