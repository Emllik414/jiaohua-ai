'use strict';

const path = require('path');
const {
  sourceSiteName,
  sourceIcon,
  formatVideoTime,
} = require('./source-location.cjs');

const CLIPPER_TEMPLATE_ID = 'jiaohua_clipper_compact';
const CLIPPER_TEMPLATE = {
  id: CLIPPER_TEMPLATE_ID,
  name: '学习剪藏（简洁来源）',
  saveBehavior: 'append_to_existing_note_bottom',
  targetNotePath: 'AI划词/学习剪藏.md',
  contentTemplate: [
    '<!-- jiaohua-record:{{record_id}} -->',
    '## {{selection_title}}',
    '',
    '{{source_line}}',
    '',
    '> {{selection}}',
    '',
    '{{ai_result}}',
  ].join('\n'),
};

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

function buildSourceLine(record) {
  const location = record?.sourceLocation;
  if (!location?.url) return '';
  const site = markdownEscapeInline(location.siteName || sourceSiteName(location));
  const time = location.videoTime || formatVideoTime(location?.video?.currentTime);
  const icon = location.faviconVaultPath
    ? `![[${location.faviconVaultPath}|16]]`
    : (location.icon || sourceIcon(location));
  const deepLink = location.deepLink || `jiaohua://source/${encodeURIComponent(String(record.id || ''))}`;
  return `> [!source] ${icon} ${site} · [回到原处](${deepLink})${time ? ` · ${time}` : ''}`;
}

function buildClipperContext(record) {
  const date = new Date(record?.createdAt || Date.now());
  const location = record?.sourceLocation || {};
  const captured = new Date(location.capturedAt || record?.createdAt || Date.now());
  const sourceUrl = location.normalizedUrl || location.url || '';
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
    source_deep_link: String(location.deepLink || ''),
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

function renderClipperTemplate(template, record) {
  return renderTemplate(template.contentTemplate, buildClipperContext(record));
}

function ensureClipperTemplate(store) {
  if (!store || typeof store !== 'object') return { store, changed: false };
  const templates = Array.isArray(store.obsidianTemplates) ? store.obsidianTemplates : [];
  if (templates.some((template) => template.id === CLIPPER_TEMPLATE_ID)) {
    return { store, changed: false };
  }
  const now = new Date().toISOString();
  const template = { ...CLIPPER_TEMPLATE, createdAt: now, updatedAt: now };
  return {
    changed: true,
    store: { ...store, obsidianTemplates: [...templates, template] },
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

function recordMarker(recordId) {
  return `<!-- jiaohua-record:${String(recordId || '')} -->`;
}

function containsRecord(existing, recordId) {
  return String(existing || '').includes(recordMarker(recordId));
}

module.exports = {
  CLIPPER_TEMPLATE_ID,
  CLIPPER_TEMPLATE,
  selectionTitle,
  buildSourceLine,
  buildClipperContext,
  renderTemplate,
  renderClipperTemplate,
  ensureClipperTemplate,
  resolveTargetPath,
  recordMarker,
  containsRecord,
};
