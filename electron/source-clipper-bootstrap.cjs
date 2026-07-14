'use strict';

try {
  require('./source-obsidian-runtime.cjs').install();
} catch (error) {
  console.error('[SourceClipper] install failed; core application continues', error);
}

require('./pronunciation-bootstrap.cjs');
