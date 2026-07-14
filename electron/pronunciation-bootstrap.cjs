'use strict';

const Module = require('module');

try {
  require('./pronunciation-live-runtime.cjs').install();
} catch (error) {
  console.error('[PronunciationLive] install failed; core application continues', error);
}

const bootstrapPath = require.resolve('./bootstrap.cjs');
const mainPath = require.resolve('./main.cjs');
const originalLoad = Module._load;
let runtimeInstalled = false;

Module._load = function loadWithPronunciationHistory(request, parent, isMain) {
  let resolved = '';
  try {
    resolved = Module._resolveFilename(request, parent, isMain);
  } catch (_) {}

  if (!runtimeInstalled && parent?.filename === bootstrapPath && resolved === mainPath) {
    runtimeInstalled = true;
    require('./pronunciation-history-runtime.cjs').install();
  }

  return originalLoad.apply(this, arguments);
};

try {
  require(bootstrapPath);
} finally {
  Module._load = originalLoad;
}

if (!runtimeInstalled) {
  console.error('[PronunciationHistory] bootstrap hook did not run; core application continues without the history patch');
}
