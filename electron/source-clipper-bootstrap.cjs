'use strict';

const { app } = require('electron');
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  try {
    require('./source-restore-bridge.cjs').install();
  } catch (error) {
    console.error('[SourceRestore] install failed; source links still open normally', error);
  }

  try {
    require('./source-obsidian-runtime.cjs').install();
  } catch (error) {
    console.error('[SourceClipper] install failed; core application continues', error);
  }

  require('./pronunciation-bootstrap.cjs');
}
