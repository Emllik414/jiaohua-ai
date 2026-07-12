(function () {
  'use strict';

  const HOST = location.hostname.toLowerCase();
  const IS_YOUTUBE = HOST === 'youtube.com' || HOST.endsWith('.youtube.com');
  const IS_BILIBILI = HOST === 'bilibili.com' || HOST.endsWith('.bilibili.com');
  if (!IS_YOUTUBE && !IS_BILIBILI) return;
  if (window.top !== window) return;

  const OVERLAY_ID = 'jiaohua-selectable-caption-overlay';
  const HANDLE_SELECTOR = '.jiaohua-caption-drag-handle';
  const VERSION = '1.1.0-caption-layout-controller';

  if (window.__JIAOHUA_CAPTION_LAYOUT_CONTROLLER__ === VERSION) return;
  window.__JIAOHUA_CAPTION_LAYOUT_CONTROLLER__ = VERSION;

  let overlay = null;
  let player = null;
  let manualPosition = null;
  let dragging = false;
  let applying = false;
  let scheduled = false;
  let overlayObserver = null;
  let playerResizeObserver = null;
  let videoResizeObserver = null;
  let lastPlayerRect = null;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function usableRect(node) {
    if (!node || !node.isConnected || typeof node.getBoundingClientRect !== 'function') return null;
    const rect = node.getBoundingClientRect();
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return null;
    if (rect.width <= 1 || rect.height <= 1) return null;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return null;
    return rect;
  }

  function findPlayer() {
    return IS_YOUTUBE
      ? document.querySelector('.html5-video-player')
      : document.querySelector('.bpx-player-video-area, .bpx-player-container');
  }

  function findVideo(nextPlayer) {
    return nextPlayer?.querySelector('video') || document.querySelector('video');
  }

  function setImportant(node, property, value) {
    const current = node.style.getPropertyValue(property);
    const priority = node.style.getPropertyPriority(property);
    if (current === value && priority === 'important') return;
    node.style.setProperty(property, value, 'important');
  }

  function setNormal(node, property, value) {
    node.style.setProperty(property, value, '');
  }

  function relativePositionFromRect(subjectRect, playerRect) {
    return {
      x: clamp(
        (subjectRect.left + subjectRect.width / 2 - playerRect.left) / Math.max(1, playerRect.width),
        0.04,
        0.96,
      ),
      y: clamp(
        (subjectRect.top - playerRect.top) / Math.max(1, playerRect.height),
        0,
        0.96,
      ),
    };
  }

  function defaultBottomPosition() {
    const playerRect = usableRect(player);
    const overlayRect = usableRect(overlay);
    if (!playerRect || !overlayRect) return null;

    const videoRect = usableRect(findVideo(player));
    if (!videoRect) return { x: 0.5, y: 0.78 };

    const visibleLeft = Math.max(playerRect.left, videoRect.left);
    const visibleRight = Math.min(playerRect.right, videoRect.right);
    const visibleTop = Math.max(playerRect.top, videoRect.top);
    const visibleBottom = Math.min(playerRect.bottom, videoRect.bottom);

    if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) {
      return { x: 0.5, y: 0.78 };
    }

    const videoHeight = visibleBottom - visibleTop;
    const bottomInset = clamp(videoHeight * 0.075, 30, 72);
    const centerX = (visibleLeft + visibleRight) / 2;
    const top = visibleBottom - overlayRect.height - bottomInset;

    return {
      x: clamp((centerX - playerRect.left) / Math.max(1, playerRect.width), 0.04, 0.96),
      y: clamp((top - playerRect.top) / Math.max(1, playerRect.height), 0, 0.92),
    };
  }

  function applyPosition(position) {
    if (!overlay || !player || !position || dragging) return;
    const playerRect = usableRect(player);
    const overlayRect = usableRect(overlay);
    if (!playerRect || !overlayRect) return;

    const maxY = Math.max(0, 1 - overlayRect.height / Math.max(1, playerRect.height));
    const x = clamp(position.x, 0.04, 0.96);
    const y = clamp(position.y, 0, maxY);

    applying = true;
    try {
      setImportant(overlay, 'left', `${(x * 100).toFixed(4)}%`);
      setImportant(overlay, 'top', `${(y * 100).toFixed(4)}%`);
      setImportant(overlay, 'bottom', 'auto');
      setImportant(overlay, 'transform', 'translateX(-50%)');
    } finally {
      applying = false;
    }
  }

  function bind(nextPlayer, nextOverlay) {
    const changed = player !== nextPlayer || overlay !== nextOverlay;

    overlayObserver?.disconnect();
    playerResizeObserver?.disconnect();
    videoResizeObserver?.disconnect();

    player = nextPlayer;
    overlay = nextOverlay;
    if (changed) manualPosition = null;

    playerResizeObserver = new ResizeObserver(syncSoon);
    playerResizeObserver.observe(player);

    const video = findVideo(player);
    if (video) {
      videoResizeObserver = new ResizeObserver(syncSoon);
      videoResizeObserver.observe(video);
    }

    overlayObserver = new MutationObserver(() => {
      if (applying || dragging) return;
      syncNow();
    });
    overlayObserver.observe(overlay, {
      attributes: true,
      attributeFilter: ['style', 'class'],
    });
  }

  function syncNow() {
    scheduled = false;
    if (dragging) return;

    const nextPlayer = findPlayer();
    const nextOverlay = document.getElementById(OVERLAY_ID);
    if (!nextPlayer || !nextOverlay || nextOverlay.style.display === 'none') return;

    if (player !== nextPlayer || overlay !== nextOverlay) bind(nextPlayer, nextOverlay);

    applyPosition(manualPosition || defaultBottomPosition());
    lastPlayerRect = usableRect(player);
  }

  function syncSoon() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(syncNow);
  }

  function releaseAuthoritativeStylesForDrag() {
    if (!overlay || !player) return;
    const overlayRect = usableRect(overlay);
    const playerRect = usableRect(player);
    if (!overlayRect || !playerRect) return;

    applying = true;
    try {
      setNormal(overlay, 'left', `${overlayRect.left - playerRect.left + overlayRect.width / 2}px`);
      setNormal(overlay, 'top', `${overlayRect.top - playerRect.top}px`);
      setNormal(overlay, 'bottom', 'auto');
      setNormal(overlay, 'transform', 'translateX(-50%)');
    } finally {
      applying = false;
    }
  }

  function rememberManualPosition() {
    if (!overlay || !player) return;
    const overlayRect = usableRect(overlay);
    const playerRect = usableRect(player);
    if (!overlayRect || !playerRect) return;
    manualPosition = relativePositionFromRect(overlayRect, playerRect);
  }

  document.addEventListener('pointerdown', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest(HANDLE_SELECTOR)) return;

    const nextPlayer = findPlayer();
    const nextOverlay = document.getElementById(OVERLAY_ID);
    if (nextPlayer && nextOverlay && (player !== nextPlayer || overlay !== nextOverlay)) {
      bind(nextPlayer, nextOverlay);
    }

    dragging = true;
    releaseAuthoritativeStylesForDrag();
  }, true);

  function finishDrag() {
    if (!dragging) return;
    requestAnimationFrame(() => {
      rememberManualPosition();
      dragging = false;
      syncNow();
    });
  }

  document.addEventListener('pointerup', finishDrag, true);
  document.addEventListener('pointercancel', finishDrag, true);

  const documentObserver = new MutationObserver(() => {
    if (dragging) return;
    syncNow();
  });

  documentObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  window.addEventListener('resize', syncSoon, { passive: true });
  window.addEventListener('scroll', syncSoon, { passive: true, capture: true });
  document.addEventListener('fullscreenchange', syncSoon);

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncSoon, { passive: true });
    window.visualViewport.addEventListener('scroll', syncSoon, { passive: true });
  }

  setInterval(() => {
    const nextPlayer = findPlayer();
    const rect = usableRect(nextPlayer);
    if (!rect) return;

    if (!lastPlayerRect ||
        Math.abs(rect.width - lastPlayerRect.width) > 0.5 ||
        Math.abs(rect.height - lastPlayerRect.height) > 0.5 ||
        Math.abs(rect.left - lastPlayerRect.left) > 0.5 ||
        Math.abs(rect.top - lastPlayerRect.top) > 0.5) {
      syncSoon();
    }
  }, 400);

  syncSoon();
})();
