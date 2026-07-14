'use strict';

const { app } = require('electron');
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  // Obsidian source links now use direct http/https URLs. Remove the obsolete
  // custom protocol association and prevent older runtime code from restoring it.
  try { app.removeAsDefaultProtocolClient('jiaohua'); } catch (_) {}
  const originalSetAsDefaultProtocolClient = app.setAsDefaultProtocolClient.bind(app);
  app.setAsDefaultProtocolClient = function setProtocolClient(protocol, ...args) {
    if (String(protocol || '').toLowerCase() === 'jiaohua') return false;
    return originalSetAsDefaultProtocolClient(protocol, ...args);
  };

  try {
    require('./source-restore-bridge.cjs').install();
  } catch (error) {
    console.error('[SourceRestore] install failed; source links still open normally', error);
  }

  try {
    require('./source-obsidian-runtime.cjs').install();
    require('./clipper-initial-data-runtime.cjs').install();
    require('./clipper-template-bootstrap.cjs').install();
  } catch (error) {
    console.error('[SourceClipper] install failed; core application continues', error);
  }

  require('./pronunciation-bootstrap.cjs');
}