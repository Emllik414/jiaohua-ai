'use strict';

const electron = require('electron');
const floatingLayout = require('./floating-layout.cjs');

const RESULT_WIDTH = 380;
const RESULT_NORMAL_MIN_HEIGHT = 300;
const RESULT_MAX_HEIGHT = 640;
const SESSION_MARGIN = 8;
const SESSION_GAP = 8;

let installed = false;

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function routeFromUrl(url) {
  try {
    return new URL(String(url)).searchParams.get('route') || '';
  } catch (_) {
    return String(url || '').includes('route=result') ? 'result' : '';
  }
}

function install() {
  if (installed) return;
  installed = true;

  const { BrowserWindow, ipcMain, screen } = electron;
  const resultWindows = new WeakSet();
  const sessions = new WeakMap();
  const resizeOverrides = new WeakMap();
  let lastResultCandidate = null;

  const originalChooseAttachedPosition = floatingLayout.chooseAttachedPosition;
  floatingLayout.chooseAttachedPosition = function patchedChooseAttachedPosition(anchorRect, windowSize, workArea, options = {}) {
    const positioned = originalChooseAttachedPosition(anchorRect, windowSize, workArea, options);
    if (Math.round(Number(windowSize?.width) || 0) === RESULT_WIDTH) {
      const gap = Number.isFinite(Number(options.gap)) ? Number(options.gap) : SESSION_GAP;
      const margin = Number.isFinite(Number(options.margin)) ? Number(options.margin) : SESSION_MARGIN;
      lastResultCandidate = {
        at: Date.now(),
        anchorRect: { ...anchorRect },
        workArea: { ...workArea },
        positioned: { ...positioned },
        gap,
        margin,
      };
    }
    return positioned;
  };

  const originalLoadURL = BrowserWindow.prototype.loadURL;
  BrowserWindow.prototype.loadURL = function patchedLoadURL(url, ...args) {
    if (routeFromUrl(url) === 'result') {
      resultWindows.add(this);
      try { this.setMinimumSize(RESULT_WIDTH, 1); } catch (_) {}
    }
    return originalLoadURL.call(this, url, ...args);
  };

  function buildSession(candidate, requestedBounds) {
    const { anchorRect, workArea, positioned, gap, margin } = candidate;
    const side = positioned.side;
    const workLeft = workArea.x + margin;
    const workRight = workArea.x + workArea.width - margin;
    const workTop = workArea.y + margin;
    const workBottom = workArea.y + workArea.height - margin;
    const fixedEdge = side === 'above'
      ? anchorRect.y - gap
      : anchorRect.y + anchorRect.height + gap;
    const availableHeight = side === 'above'
      ? fixedEdge - workTop
      : workBottom - fixedEdge;
    const heightLimit = Math.max(1, Math.floor(Math.min(RESULT_MAX_HEIGHT, availableHeight)));
    const height = Math.max(1, Math.min(Math.ceil(requestedBounds.height), heightLimit));
    const x = clamp(Math.round(requestedBounds.x), workLeft, workRight - RESULT_WIDTH);
    const y = side === 'above' ? fixedEdge - height : fixedEdge;
    return {
      side,
      workArea: { ...workArea },
      margin,
      fixedEdge,
      heightLimit,
      x,
      y,
      height,
      userMoved: false,
      createdAt: Date.now(),
    };
  }

  function candidateMatches(candidate, requested) {
    if (!candidate || Date.now() - candidate.at > 2500) return false;
    const positioned = candidate.positioned;
    return Math.abs(Number(requested.x) - Number(positioned.x)) <= 4 &&
      Math.abs(Number(requested.y) - Number(positioned.y)) <= 4 &&
      Math.abs(Number(requested.width) - RESULT_WIDTH) <= 2;
  }

  function captureResizeRequest(win, desiredHeight) {
    const desired = Math.ceil(Number(desiredHeight));
    if (!win || !resultWindows.has(win) || !Number.isFinite(desired) || desired <= 0) return;
    resizeOverrides.set(win, {
      desired,
      expiresAt: Date.now() + 1800,
    });
  }

  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = function patchedHandle(channel, listener) {
    if (channel !== 'result:resize' && channel !== 'result:resize-box') {
      return originalHandle(channel, listener);
    }
    return originalHandle(channel, async (event, payload) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const desired = channel === 'result:resize-box' ? payload?.height : payload;
      captureResizeRequest(win, desired);
      const response = await listener(event, payload);
      const session = win ? sessions.get(win) : null;
      return {
        ...(response && typeof response === 'object' ? response : {}),
        heightLimit: session?.heightLimit,
        fixedSide: session?.side,
      };
    });
  };

  const originalSetBounds = BrowserWindow.prototype.setBounds;
  BrowserWindow.prototype.setBounds = function patchedSetBounds(nextBounds, animate = false) {
    if (!resultWindows.has(this)) {
      return originalSetBounds.call(this, nextBounds, animate);
    }

    const current = this.getBounds();
    const requested = {
      x: Number.isFinite(Number(nextBounds?.x)) ? Math.round(Number(nextBounds.x)) : current.x,
      y: Number.isFinite(Number(nextBounds?.y)) ? Math.round(Number(nextBounds.y)) : current.y,
      width: Number.isFinite(Number(nextBounds?.width)) ? Math.round(Number(nextBounds.width)) : current.width,
      height: Number.isFinite(Number(nextBounds?.height)) ? Math.round(Number(nextBounds.height)) : current.height,
    };

    if (candidateMatches(lastResultCandidate, requested)) {
      const session = buildSession(lastResultCandidate, requested);
      sessions.set(this, session);
      resizeOverrides.delete(this);
      lastResultCandidate = null;
      try { this.setMinimumSize(RESULT_WIDTH, 1); } catch (_) {}
      return originalSetBounds.call(this, {
        x: session.x,
        y: session.y,
        width: RESULT_WIDTH,
        height: session.height,
      }, false);
    }

    const session = sessions.get(this);
    const positionChanged = Math.abs(requested.x - current.x) >= 2 || Math.abs(requested.y - current.y) >= 2;
    const heightChanged = Math.abs(requested.height - current.height) >= 2;

    // A pure position change comes from the user's result-card drag. Once moved,
    // automatic attachment is disabled and future growth is limited by the
    // remaining screen space below the manually chosen top edge.
    if (positionChanged && !heightChanged) {
      if (session) session.userMoved = true;
      resizeOverrides.delete(this);
      return originalSetBounds.call(this, requested, false);
    }

    const override = resizeOverrides.get(this);
    if (override && override.expiresAt >= Date.now() && heightChanged) {
      if (session && !session.userMoved) {
        const normalMinimum = Math.min(RESULT_NORMAL_MIN_HEIGHT, session.heightLimit);
        const height = Math.max(1, Math.min(Math.max(override.desired, normalMinimum), session.heightLimit));
        const y = session.side === 'above' ? session.fixedEdge - height : session.fixedEdge;
        return originalSetBounds.call(this, {
          x: session.x,
          y,
          width: RESULT_WIDTH,
          height,
        }, false);
      }

      const display = screen.getDisplayMatching(current);
      const workBottom = display.workArea.y + display.workArea.height - SESSION_MARGIN;
      const heightLimit = Math.max(1, Math.min(RESULT_MAX_HEIGHT, workBottom - current.y));
      const normalMinimum = Math.min(RESULT_NORMAL_MIN_HEIGHT, heightLimit);
      const height = Math.max(1, Math.min(Math.max(override.desired, normalMinimum), heightLimit));
      return originalSetBounds.call(this, {
        x: current.x,
        y: current.y,
        width: RESULT_WIDTH,
        height,
      }, false);
    }

    // Suppress the native bounds animation even for legacy calls. A single
    // atomic update avoids the 6px staircase that made upward growth jitter.
    return originalSetBounds.call(this, requested, false);
  };

  console.log('[ResultWindowStability] installed');
}

module.exports = { install };
