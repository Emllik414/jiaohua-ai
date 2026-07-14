'use strict';

const path = require('path');
const {
  sourceSiteName,
  sourceIcon,
  formatVideoTime,
  buildOpenUrl,
} = require('./source-location.cjs');

const CLIPPER_TEMPLATE_ID = 'jiaohua_clipper_compact';
const CLIPPER_TEMPLATE_STATE_KEY = 'sourceClipperTemplateState';
const IMPORT_INDEX_RELATIVE_PATH = '.jiaohua/import-index.json';

const CLIPPER_TEMPLATE = {
  id: CLIPPER_TEMPLATE_ID,
  name: '学习剪藏（简洁来源）',
  saveBehavior: 'append_to_existing_note_bottom',
  targetNotePath: 'AI划词/学习剪藏.md',
  contentTemplate: [
    '## {{selection_title}}',
    '',
    '{{source_line}}',
    '',
    '> {{selection}}',
    '',
    '{{ai_result}}',
  ].join('\n'),
};

const TEMPLATE_VARIABLE_KEYS = [
  'record_id',
  'selection',
  'selection_short',
  'selection_title',
  'ai_result',
  'answer',
  'skill_name',
  'skill_id',
  'model',
  'date',
  'time',
  'captured_at',
  'source_app',
  'source_type',
  'source_site',
  'source_title',
  'source_title_yaml',
  'source_url',
  'source_open_url',
  'source_host',
  'source_icon',
  'source_favicon',
  'source_line',
  'video_time',
  'video_seconds',
  'selection_context',
  'history_space',
];

function pad2(value) {
  return String(value).padStart(2, '0');
}

function yamlEscape(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
}

function markdownEscapeInline(value) {
  return String(value || '').replace(/([\\`*_[\]<>])/g, '\\$1').replace(/\r?\n/g, ' ');
}

function selectionTitle(record) {
  const text = String(record?.selectedText || '').replace(/\s+/g, ' ').trim();
  return text.length > 54 ? `${text.slice(0, 53)}…` : (text || 'AI 划词记录');
}

function compactSourceTitle(location, site) {
  const title = String(location?.title || '').replace(/\s+/g, ' ').trim();
  const value = title || site || '打开来源';
  return markdownEscapeInline(value.length > 64 ? `${value.slice(0, 63)}…` : value);
}

function sourceOpenUrl(location) {
  return buildOpenUrl(location, { leadSeconds: 0 });
}

function buildSourceLine(record) {
  const location = record?.sourceLocation;
  if (!location?.url) return '';
  const site = markdownEscapeInline(location.siteName || sourceSiteName(location));
  const title = compactSourceTitle(location, site);
  const time = location.videoTime || formatVideoTime(location?.video?.currentTime);
  const icon = location.faviconVaultPath
    ? `![[${location.faviconVaultPath}|16]]`
    : (location.icon || sourceIcon(location));
  const openUrl = sourceOpenUrl(location);
  return openUrl
    ? `> [!source] ${icon} ${site} · [${title}](${openUrl})${time ? ` · ${time}` : ''}`
    : `> [!source] ${icon} ${site}${time ? ` · ${time}` : ''}`;
}

function buildClipperContext(record) {
  const date = new Date(record?.createdAt || Date.now());
  const location = record?.sourceLocation || {};
  const captured = new Date(location.capturedAt || record?.createdAt || Date.now());
  const sourceUrl = location.normalizedUrl || location.url || '';
  const openUrl = sourceOpenUrl(location);
  const videoSeconds = Number(location?.video?.currentTime);
  const videoTime = location.videoTime || formatVideoTime(videoSeconds);
  const selected = String(record?.selectedText || '');
  return {
    record_id: String(record?.id || ''),
    selection: selected,
    selection_short: selected.replace(/\s+/g, ' ').trim().slice(0, 28),
    selection_title: selectionTitle(record),
    ai_result: String(record?.answerMarkdown || ''),
    answer: String(record?.answerMarkdown || ''),
    skill_name: String(record?.skillName || record?.skillId || 'AI划词'),
    skill_id: String(record?.skillId || ''),
    model: String(record?.model || ''),
    date: `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    time: `${pad2(date.getHours())}:${pad2(date.getMinutes())}`,
    captured_at: `${captured.getFullYear()}-${pad2(captured.getMonth() + 1)}-${pad2(captured.getDate())} ${pad2(captured.getHours())}:${pad2(captured.getMinutes())}`,
    source_app: String(record?.sourceApp || 'Windows'),
    source_type: String(location.type || 'desktop'),
    source_site: String(location.siteName || sourceSiteName(location)),
    source_title: String(location.title || record?.windowTitle || ''),
    source_title_yaml: yamlEscape(location.title || record?.windowTitle || ''),
    source_url: String(sourceUrl),
    source_open_url: String(openUrl),
    source_host: String(location.hostname || ''),
    source_icon: String(location.icon || sourceIcon(location)),
    source_favicon: String(location.faviconVaultPath || ''),
    source_line: buildSourceLine(record),
    video_time: videoTime,
    video_seconds: Number.isFinite(videoSeconds) ? String(Math.floor(videoSeconds)) : '',
    selection_context: [location?.anchor?.prefixText, selected, location?.anchor?.suffixText].filter(Boolean).join(' '),
    history_space: '',
  };
}

function renderTemplate(template, context) {
  return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => context[key] ?? '');
}

function recordMarker(recordId) {
  return `%% jiaohua-record:${String(recordId || '')} %%`;
}

function legacyRecordMarker(recordId) {
  return `<!-- jiaohua-record:${String(recordId || '')} -->`;
}

function extractRecordIds(value) {
  const text = String(value || '');
  const ids = new Set();
  for (const match of text.matchAll(/%%\s*jiaohua-record:([^%\r\n]+?)\s*%%/gi)) {
    const id = String(match[1] || '').trim();
    if (id) ids.add(id);
  }
  for (const match of text.matchAll(/<!--\s*jiaohua-record:([^>]+?)\s*-->/gi)) {
    const id = String(match[1] || '').trim();
    if (id) ids.add(id);
  }
  return [...ids];
}

function stripRecordMarkers(value) {
  return String(value || '')
    .replace(/^[ \t]*%%\s*jiaohua-record:[^%\r\n]+?\s*%%[ \t]*(?:\r?\n|$)/gim, '')
    .replace(/^[ \t]*<!--\s*jiaohua-record:[^>]+?\s*-->[ \t]*(?:\r?\n|$)/gim, '')
    .replace(/^\s*\r?\n/, '');
}

function renderClipperTemplate(template, record) {
  return stripRecordMarkers(renderTemplate(template.contentTemplate, buildClipperContext(record))).trim();
}

function normalizedTemplateState(store) {
  const raw = store?.[CLIPPER_TEMPLATE_STATE_KEY];
  return {
    seeded: Boolean(raw?.seeded),
    dismissed: Boolean(raw?.dismissed),
  };
}

function setTemplateState(store, state) {
  return {
    ...store,
    [CLIPPER_TEMPLATE_STATE_KEY]: {
      seeded: Boolean(state?.seeded),
      dismissed: Boolean(state?.dismissed),
    },
  };
}

function markClipperTemplateDismissed(store) {
  return setTemplateState(store, { seeded: true, dismissed: true });
}

function markClipperTemplateAvailable(store) {
  return setTemplateState(store, { seeded: true, dismissed: false });
}

function migrateBuiltInTemplate(template) {
  if (!template || template.id !== CLIPPER_TEMPLATE_ID) return { template, changed: false };
  const contentTemplate = stripRecordMarkers(String(template.contentTemplate || ''))
    .replace(/\{\{source_deep_link\}\}/g, '{{source_open_url}}')
    .trim();
  if (contentTemplate === String(template.contentTemplate || '').trim()) return { template, changed: false };
  return {
    changed: true,
    template: { ...template, contentTemplate, updatedAt: new Date().toISOString() },
  };
}

function ensureClipperTemplate(store) {
  if (!store || typeof store !== 'object') return { store, changed: false };
  const templates = Array.isArray(store.obsidianTemplates) ? store.obsidianTemplates : [];
  const state = normalizedTemplateState(store);
  let changed = false;
  let found = false;

  const migrated = templates.map((template) => {
    if (template?.id !== CLIPPER_TEMPLATE_ID) return template;
    found = true;
    const result = migrateBuiltInTemplate(template);
    if (result.changed) changed = true;
    return result.template;
  });

  let nextState = state;
  if (found) {
    if (!state.seeded || state.dismissed) {
      nextState = { seeded: true, dismissed: false };
      changed = true;
    }
  } else if (state.seeded || state.dismissed) {
    nextState = { seeded: true, dismissed: true };
  } else if (templates.length === 0) {
    const now = new Date().toISOString();
    migrated.push({ ...CLIPPER_TEMPLATE, createdAt: now, updatedAt: now });
    nextState = { seeded: true, dismissed: false };
    changed = true;
  } else {
    // Existing users who already have their own templates and removed the bundled
    // clipper template should not have it injected again on every data read.
    nextState = { seeded: true, dismissed: true };
    changed = true;
  }

  const stateChanged = nextState.seeded !== state.seeded || nextState.dismissed !== state.dismissed;
  if (stateChanged) changed = true;
  if (!changed) return { changed: false, store };

  return {
    changed: true,
    store: setTemplateState({ ...store, obsidianTemplates: migrated }, nextState),
  };
}

function resolveTargetPath(vaultPath, template, context) {
  const rendered = renderTemplate(template.targetNotePath || CLIPPER_TEMPLATE.targetNotePath, context)
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^[/\\]+/, '');
  const normalized = rendered.toLowerCase().endsWith('.md') ? rendered : `${rendered}.md`;
  const root = path.resolve(vaultPath);
  const target = path.resolve(root, normalized);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('保存路径必须在 Obsidian Vault 内。');
  return { target, relativePath: relative.replace(/\\/g, '/') };
}

function migrateLegacyRecordMarkers(existing) {
  return stripRecordMarkers(existing);
}

function containsRecord(existing, recordId) {
  return extractRecordIds(existing).includes(String(recordId || ''));
}

function normalizeImportIndex(value) {
  const records = {};
  if (Array.isArray(value?.recordIds)) {
    for (const id of value.recordIds) {
      const key = String(id || '').trim();
      if (key) records[key] = { importedAt: '', paths: [] };
    }
  }
  if (value?.records && typeof value.records === 'object') {
    for (const [id, entry] of Object.entries(value.records)) {
      const key = String(id || '').trim();
      if (!key) continue;
      records[key] = {
        importedAt: String(entry?.importedAt || ''),
        paths: [...new Set(Array.isArray(entry?.paths) ? entry.paths.map((item) => String(item || '')).filter(Boolean) : [])],
      };
    }
  }
  return { version: 1, records };
}

function hasImportedRecord(index, recordId) {
  const key = String(recordId || '').trim();
  return Boolean(key && normalizeImportIndex(index).records[key]);
}

function markImportedRecord(index, recordId, relativePath, importedAt = new Date().toISOString()) {
  const normalized = normalizeImportIndex(index);
  const key = String(recordId || '').trim();
  if (!key) return normalized;
  const previous = normalized.records[key] || { importedAt: '', paths: [] };
  const pathValue = String(relativePath || '').trim();
  normalized.records[key] = {
    importedAt: previous.importedAt || String(importedAt || ''),
    paths: [...new Set([...previous.paths, ...(pathValue ? [pathValue] : [])])],
  };
  return normalized;
}

module.exports = {
  CLIPPER_TEMPLATE_ID,
  CLIPPER_TEMPLATE_STATE_KEY,
  IMPORT_INDEX_RELATIVE_PATH,
  CLIPPER_TEMPLATE,
  TEMPLATE_VARIABLE_KEYS,
  selectionTitle,
  compactSourceTitle,
  sourceOpenUrl,
  buildSourceLine,
  buildClipperContext,
  renderTemplate,
  renderClipperTemplate,
  normalizedTemplateState,
  setTemplateState,
  markClipperTemplateDismissed,
  markClipperTemplateAvailable,
  migrateBuiltInTemplate,
  ensureClipperTemplate,
  resolveTargetPath,
  recordMarker,
  legacyRecordMarker,
  extractRecordIds,
  stripRecordMarkers,
  migrateLegacyRecordMarkers,
  containsRecord,
  normalizeImportIndex,
  hasImportedRecord,
  markImportedRecord,
};