'use strict';

const { app } = require('electron');
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  // Install before main.cjs is loaded so all AI streaming fetch calls receive
  // transient-network retry, idle detection, continuation, and partial preservation.
  try {
    require('./stream-resilience.cjs').install();
  } catch (error) {
    console.error('[StreamResilience] install failed; core application continues', error);
  }

  // Intercept the later Obsidian IPC registrations before source-obsidian-runtime
  // captures ipcMain.handle. This keeps all source features while replacing only
  // the slow single/batch import handlers with the transactional fast engine.
  try {
    require('./obsidian-import-performance-runtime.cjs').install();
  } catch (error) {
    console.error('[ObsidianImportFast] install failed; legacy import remains available', error);
  }

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
