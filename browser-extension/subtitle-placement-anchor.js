(function () {
  'use strict';

  if (window.top !== window) return;

  const VERSION = '1.0.0-subtitle-placement-anchor';
  if (window.__JIAOHUA_SUBTITLE_PLACEMENT_ANCHOR__ === VERSION) return;
  window.__JIAOHUA_SUBTITLE_PLACEMENT_ANCHOR__ = VERSION;

  const nativeFetch = window.fetch.bind(window);
  let lastPointer = null;

  document.addEventListener('pointerdown', (event) => {
    lastPointer = {
      downX: event.clientX,
      downY: event.clientY,
      upX: event.clientX,
      upY: event.clientY,
      target: event.target instanceof Element ? event.target : null,
      at: Date.now(),
    };
  }, true);

  document.addEventListener('pointerup', (event) => {
    if (!lastPointer) return;
    lastPointer.upX = event.clientX;
    lastPointer.upY = event.clientY;
    lastPointer.target = event.target instanceof Element ? event.target : lastPointer.target;
    lastPointer.at = Date.now();
  }, true);

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function rectObject(rect) {
    if (!rect) return null;
    const x = Number(rect.left ?? rect.x);
    const y = Number(rect.top ?? rect.y);
    const width = Number(rect.width);
    const height = Number(rect.height);
    if (![x, y, width, height].every(Number.isFinite) || width <= 1 || height <= 1) return null;
    return { x, y, width, height };
  }

  function safeRect(element) {
    if (!(element instanceof Element) || !element.isConnected) return null;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0.03) return null;
    return rectObject(element.getBoundingClientRect());
  }

  function signature(element) {
    if (!(element instanceof Element)) return '';
    return [
      element.tagName,
      element.id,
      typeof element.className === 'string' ? element.className : '',
      element.getAttribute('data-testid') || '',
      element.getAttribute('data-name') || '',
      element.getAttribute('role') || '',
      element.getAttribute('aria-label') || '',
    ].join(' ').toLowerCase();
  }

  function looksLikeSubtitleElement(element) {
    const value = signature(element);
    return /(subtitle|caption|ytp-caption|cue|trancy|tracy|language.?reactor|dual.?sub|bilingual|immersive.?translate|translated-text|original-text|jiaohua-selectable-caption)/.test(value);
  }

  function currentVideoRect() {
    const videos = Array.from(document.querySelectorAll('video'))
      .map((video) => ({ video, rect: safeRect(video) }))
      .filter((item) => item.rect)
      .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));
    return videos[0]?.rect || null;
  }

  function nearVideo(rect, videoRect) {
    if (!videoRect) return rect.y >= window.innerHeight * 0.3;
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    return centerX >= videoRect.x - 100 &&
      centerX <= videoRect.x + videoRect.width + 100 &&
      centerY >= videoRect.y + videoRect.height * 0.35 &&
      centerY <= videoRect.y + videoRect.height + 140;
  }

  function compactSubtitleRect(rect, videoRect) {
    if (!rect || !nearVideo(rect, videoRect)) return false;
    const maxWidth = videoRect ? Math.max(420, videoRect.width * 1.08) : window.innerWidth * 0.96;
    const maxHeight = videoRect ? Math.max(150, videoRect.height * 0.36) : Math.max(150, window.innerHeight * 0.28);
    return rect.width <= maxWidth && rect.height <= maxHeight;
  }

  function selectionElement() {
    const selection = window.getSelection?.();
    const nodes = [selection?.anchorNode, selection?.focusNode];
    for (const node of nodes) {
      const element = node instanceof Element ? node : node?.parentElement;
      if (element) return element;
    }

    if (lastPointer && Date.now() - lastPointer.at < 1200) {
      const points = [
        [lastPointer.upX, lastPointer.upY],
        [lastPointer.downX, lastPointer.downY],
      ];
      for (const [x, y] of points) {
        const element = document.elementFromPoint(x, y);
        if (element) return element;
      }
      if (lastPointer.target) return lastPointer.target;
    }
    return null;
  }

  function subtitleGroupRect() {
    const start = selectionElement();
    if (!start) return null;

    const videoRect = currentVideoRect();
    let element = start;
    let best = null;

    for (let depth = 0; element && depth < 9; depth += 1) {
      const rect = safeRect(element);
      const text = normalizeText(element.innerText || element.textContent || '');
      if (rect && text && text.length <= 900 && compactSubtitleRect(rect, videoRect) && looksLikeSubtitleElement(element)) {
        if (!best || rect.height > best.rect.height || (rect.height === best.rect.height && rect.width > best.rect.width)) {
          best = { element, rect };
        }
      }
      element = element.parentElement;
    }

    if (!best) return null;
    return best.rect;
  }

  function viewportToScreen(rect) {
    if (!rect) return null;
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

  function selectionLooksLikeSubtitle(data) {
    if (data?.metadata?.subtitleOverlayDetected) return true;
    const element = selectionElement();
    if (!element) return false;
    let current = element;
    for (let depth = 0; current && depth < 7; depth += 1) {
      if (looksLikeSubtitleElement(current)) return true;
      current = current.parentElement;
    }
    return false;
  }

  function enhanceSelectionBody(body) {
    if (typeof body !== 'string') return body;
    let data;
    try {
      data = JSON.parse(body);
    } catch (_) {
      return body;
    }

    if (!data || !selectionLooksLikeSubtitle(data)) return body;
    const groupViewportRect = subtitleGroupRect();
    const groupScreenRect = viewportToScreen(groupViewportRect);
    if (!groupScreenRect) return body;

    data.metadata = {
      ...(data.metadata || {}),
      subtitleOverlayDetected: true,
      selectedTextRect: data.rect || null,
      subtitlePlacementRect: groupScreenRect,
      placementMethod: 'subtitle-container-anchor',
    };

    // Existing desktop positioning already chooses above/below and clamps to the
    // active display. Feeding it the entire subtitle block prevents the toolbar
    // and result card from attaching to only one selected word and covering the
    // remaining subtitle lines.
    data.rect = groupScreenRect;
    return JSON.stringify(data);
  }

  window.fetch = function patchedFetch(input, init) {
    try {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      if (url.includes('127.0.0.1:17321/selection') && init?.method === 'POST') {
        init = { ...init, body: enhanceSelectionBody(init.body) };
      }
    } catch (_) {}
    return nativeFetch(input, init);
  };
})();
