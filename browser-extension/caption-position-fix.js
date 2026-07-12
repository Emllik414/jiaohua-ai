(function () {
  'use strict';

  const HOST = location.hostname.toLowerCase();
  const IS_YOUTUBE = HOST === 'youtube.com' || HOST.endsWith('.youtube.com');
  const IS_BILIBILI = HOST === 'bilibili.com' || HOST.endsWith('.bilibili.com');
  if (!IS_YOUTUBE && !IS_BILIBILI) return;
  if (window.top !== window) return;

  const OVERLAY_ID = 'jiaohua-selectable-caption-overlay';
  const HANDLE_SELECTOR = '.jiaohua-caption-drag-handle';
  const VERSION = '1.0.0-caption-position-fix';

  if (window.__JIAOHUA_CAPTION_POSITION_FIX__ === VERSION) return;
  window.__JIAOHUA_CAPTION_POSITION_FIX__ = VERSION;

  let overlay = null;
  let player = null;
  let manualPosition = null;
  let dragging = false;
  let scheduled = false;
  let applying = false;
  let overlayObserver = null;
  let playerResizeObserver = null;
  let lastPlayerRect = null;

  const changedAt = new WeakMap();

  function playerElement() {
    return IS_YOUTUBE
      ? document.querySelector('.html5-video-player')
      : document.querySelector('.bpx-player-video-area, .bpx-player-container');
  }

  function captionWindows() {
    if (IS_YOUTUBE) {
      return Array.from(document.querySelectorAll('.ytp-caption-window-container'))
        .filter((node) => node.id !== OVERLAY_ID);
    }

    return Array.from(document.querySelectorAll(
      '.bpx-player-subtitle-wrap .bili-subtitle-x-subtitle-panel-text, ' +
      '.bpx-player-subtitle-wrap [class*="subtitle-panel-text"]',
    ));
  }

  function visibleText(node) {
    return String(node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function usableRect(node) {
    if (!node?.isConnected) return null;
    const rect = node.getBoundingClientRect();
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return null;
    if (rect.width <= 1 || rect.height <= 1) return null;

    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return null;
    return rect;
  }

  function intersectsPlayer(rect, playerRect) {
    return rect.right >= playerRect.left &&
      rect.left <= playerRect.right &&
      rect.bottom >= playerRect.top &&
      rect.top <= playerRect.bottom;
  }

  function activeNativeCaption(nextPlayer) {
    const playerRect = usableRect(nextPlayer);
    if (!playerRect) return null;

    const candidates = captionWindows()
      .map((node, domIndex) => {
        const rect = usableRect(node);
        const text = visibleText(node);
        if (!rect || !text || !intersectsPlayer(rect, playerRect)) return null;

        const centerY = (rect.top + rect.bottom) / 2;
        const normalizedY = (centerY - playerRect.top) / Math.max(1, playerRect.height);
        return {
          node,
          rect,
          text,
          domIndex,
          changed: changedAt.get(node) || 0,
          lowerScore: normalizedY,
        };
      })
      .filter(Boolean);

    if (!candidates.length) return null;

    candidates.sort((a, b) => {
      const recencyDelta = b.changed - a.changed;
      if (Math.abs(recencyDelta) > 120) return recencyDelta;
      const verticalDelta = b.lowerScore - a.lowerScore;
      if (Math.abs(verticalDelta) > 0.02) return verticalDelta;
      return b.domIndex - a.domIndex;
    });

    return candidates[0];
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function ratiosFromRects(subjectRect, playerRect) {
    const x = (subjectRect.left + subjectRect.width / 2 - playerRect.left) /
      Math.max(1, playerRect.width);
    const y = (subjectRect.top - playerRect.top) /
      Math.max(1, playerRect.height);
    return { x: clamp(x, 0.04, 0.96), y: clamp(y, 0, 0.94) };
  }

  function sameCssValue(current, next) {
    const currentNumber = Number.parseFloat(current);
    const nextNumber = Number.parseFloat(next);
    if (!Number.isFinite(currentNumber) || !Number.isFinite(nextNumber)) return current === next;
    return Math.abs(currentNumber - nextNumber) < 0.02;
  }

  function setImportantStyle(node, property, value) {
    const current = node.style.getPropertyValue(property);
    const priority = node.style.getPropertyPriority(property);
    if (sameCssValue(current, value) && priority === 'important') return;
    node.style.setProperty(property, value, 'important');
  }

  function applyRatios(position) {
    if (!overlay || !player || dragging) return;
    const playerRect = usableRect(player);
    const overlayRect = usableRect(overlay);
    if (!playerRect || !overlayRect) return;

    const maxY = Math.max(0, 1 - overlayRect.height / Math.max(1, playerRect.height));
    const x = clamp(position.x, 0.04, 0.96);
    const y = clamp(position.y, 0, maxY);

    applying = true;
    try {
      setImportantStyle(overlay, 'left', `${(x * 100).toFixed(4)}%`);
      setImportantStyle(overlay, 'top', `${(y * 100).toFixed(4)}%`);
      setImportantStyle(overlay, 'bottom', 'auto');
    } finally {
      applying = false;
    }
  }

  function nativePosition() {
    const active = activeNativeCaption(player);
    const playerRect = usableRect(player);
    if (!playerRect) return null;

    if (active?.rect) {
      // Match the native subtitle position exactly. The old controller subtracted
      // 32 px here, which could clamp the mirrored caption to the player top.
      return ratiosFromRects(active.rect, playerRect);
    }

    // Safe fallback: centered in the lower part of the player, never at the top.
    return { x: 0.5, y: 0.76 };
  }

  function syncNow() {
    scheduled = false;
    if (dragging) return;

    const nextPlayer = playerElement();
    const nextOverlay = document.getElementById(OVERLAY_ID);

    if (!nextPlayer || !nextOverlay || nextOverlay.style.display === 'none') return;

    if (player !== nextPlayer || overlay !== nextOverlay) {
      bindElements(nextPlayer, nextOverlay);
    }

    const position = manualPosition || nativePosition();
    if (position) applyRatios(position);
    lastPlayerRect = player.getBoundingClientRect();
  }

  function scheduleSync() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(syncNow);
    });
  }

  function bindElements(nextPlayer, nextOverlay) {
    const playerChanged = player && player !== nextPlayer;
    const overlayChanged = overlay && overlay !== nextOverlay;

    playerResizeObserver?.disconnect();
    overlayObserver?.disconnect();

    player = nextPlayer;
    overlay = nextOverlay;

    if (playerChanged || overlayChanged) {
      manualPosition = null;
    }

    playerResizeObserver = new ResizeObserver(scheduleSync);
    playerResizeObserver.observe(player);

    overlayObserver = new MutationObserver((mutations) => {
      if (applying || dragging) return;
      if (mutations.some((mutation) => mutation.attributeName === 'style')) {
        scheduleSync();
      }
    });
    overlayObserver.observe(overlay, { attributes: true, attributeFilter: ['style'] });
  }

  function rememberManualPosition() {
    if (!overlay || !player) return;
    const overlayRect = usableRect(overlay);
    const playerRect = usableRect(player);
    if (!overlayRect || !playerRect) return;
    manualPosition = ratiosFromRects(overlayRect, playerRect);
  }

  document.addEventListener('pointerdown', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest(HANDLE_SELECTOR)) return;
    dragging = true;
  }, true);

  document.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    requestAnimationFrame(() => {
      rememberManualPosition();
      scheduleSync();
    });
  }, true);

  document.addEventListener('pointercancel', () => {
    if (!dragging) return;
    dragging = false;
    scheduleSync();
  }, true);

  const documentObserver = new MutationObserver((mutations) => {
    const now = Date.now();
    for (const mutation of mutations) {
      const target = mutation.target instanceof Element
        ? mutation.target
        : mutation.target?.parentElement;
      const caption = target?.closest?.(
        IS_YOUTUBE
          ? '.ytp-caption-window-container'
          : '.bpx-player-subtitle-wrap [class*="subtitle"]',
      );
      if (caption && caption.id !== OVERLAY_ID) changedAt.set(caption, now);
    }
    scheduleSync();
  });

  documentObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  window.addEventListener('resize', scheduleSync, { passive: true });
  window.addEventListener('scroll', scheduleSync, { passive: true, capture: true });
  document.addEventListener('fullscreenchange', scheduleSync);

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', scheduleSync, { passive: true });
    window.visualViewport.addEventListener('scroll', scheduleSync, { passive: true });
  }

  // YouTube can resize the player without firing a normal window resize event
  // (theatre mode, side panels, control transitions). This low-cost safety check
  // only schedules work when the visual player rectangle actually changed.
  setInterval(() => {
    const nextPlayer = playerElement();
    const rect = nextPlayer?.getBoundingClientRect();
    if (!rect) return;

    if (!lastPlayerRect ||
        Math.abs(rect.width - lastPlayerRect.width) > 0.5 ||
        Math.abs(rect.height - lastPlayerRect.height) > 0.5 ||
        Math.abs(rect.left - lastPlayerRect.left) > 0.5 ||
        Math.abs(rect.top - lastPlayerRect.top) > 0.5) {
      scheduleSync();
    }
  }, 500);

  scheduleSync();
})();
