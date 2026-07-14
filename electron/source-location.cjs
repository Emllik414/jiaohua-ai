'use strict';

const TRACKING_KEYS = new Set([
  'fbclid', 'gclid', 'dclid', 'mc_cid', 'mc_eid', 'ref', 'ref_src',
]);
const SECRET_KEY_RE = /(token|auth|session|secret|password|passwd|api[_-]?key|access[_-]?key)/i;

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    return '';
  }
  if (!['http:', 'https:'].includes(url.protocol)) return '';

  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith('utm_') || TRACKING_KEYS.has(lower)) {
      url.searchParams.delete(key);
      continue;
    }
    if (SECRET_KEY_RE.test(lower)) {
      url.searchParams.set(key, '[redacted]');
    }
  }
  return url.toString();
}

function sourceSiteName(location) {
  const hostname = String(location?.hostname || '').toLowerCase();
  const platform = String(location?.video?.platform || '').toLowerCase();
  if (platform === 'youtube' || hostname.endsWith('youtube.com') || hostname === 'youtu.be') return 'YouTube';
  if (platform === 'bilibili' || hostname.endsWith('bilibili.com')) return 'Bilibili';
  if (hostname) return hostname.replace(/^www\./, '');
  return location?.type === 'desktop' ? '桌面应用' : '网页';
}

function sourceIcon(location) {
  const site = sourceSiteName(location);
  if (site === 'YouTube') return '▶';
  if (site === 'Bilibili') return '📺';
  if (location?.type === 'video' || location?.type === 'subtitle') return '▶';
  if (location?.type === 'desktop') return '▣';
  return '🌐';
}

function formatVideoTime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '';
  const rounded = Math.floor(value);
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = rounded % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function detectPlatform(urlValue, hostnameValue) {
  const hostname = String(hostnameValue || '').toLowerCase();
  if (hostname.endsWith('youtube.com') || hostname === 'youtu.be') return 'youtube';
  if (hostname.endsWith('bilibili.com')) return 'bilibili';
  try {
    const parsed = new URL(urlValue);
    return detectPlatform('', parsed.hostname);
  } catch (_) {
    return 'html5';
  }
}

function buildOpenUrl(location, options = {}) {
  const raw = cleanUrl(location?.normalizedUrl || location?.url || '');
  if (!raw) return '';
  const seconds = Number(location?.video?.currentTime);
  const leadSeconds = Number.isFinite(Number(options.leadSeconds)) ? Number(options.leadSeconds) : 1.5;
  const seekSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds - leadSeconds)) : null;
  const platform = String(location?.video?.platform || detectPlatform(raw, location?.hostname));

  try {
    const url = new URL(raw);
    if (seekSeconds !== null && (location?.type === 'video' || location?.type === 'subtitle')) {
      if (platform === 'youtube') {
        url.searchParams.set('t', `${seekSeconds}s`);
      } else if (platform === 'bilibili') {
        url.searchParams.set('t', String(seekSeconds));
      } else {
        url.hash = `t=${seekSeconds}`;
      }
      return url.toString();
    }

    const selected = normalizeText(location?.anchor?.selectedText || '');
    if (selected && selected.length <= 180) {
      const prefix = normalizeText(location?.anchor?.prefixText || '').slice(-48);
      const suffix = normalizeText(location?.anchor?.suffixText || '').slice(0, 48);
      const textDirective = prefix || suffix
        ? `${prefix ? `${encodeURIComponent(prefix)}-,` : ''}${encodeURIComponent(selected)}${suffix ? `,-${encodeURIComponent(suffix)}` : ''}`
        : encodeURIComponent(selected);
      url.hash = `:~:text=${textDirective}`;
    }
    return url.toString();
  } catch (_) {
    return raw;
  }
}

function normalizeSourceLocation(input) {
  if (!input || typeof input !== 'object') return null;
  const normalizedUrl = cleanUrl(input.normalizedUrl || input.url || '');
  if (!normalizedUrl && input.type !== 'desktop') return null;
  let hostname = String(input.hostname || '').trim();
  if (!hostname && normalizedUrl) {
    try { hostname = new URL(normalizedUrl).hostname; } catch (_) {}
  }

  const type = ['web', 'video', 'subtitle', 'desktop'].includes(input.type) ? input.type : 'web';
  const result = {
    type,
    capturedAt: input.capturedAt || new Date().toISOString(),
    url: normalizedUrl,
    normalizedUrl,
    title: normalizeText(input.title || ''),
    hostname,
    faviconUrl: cleanUrl(input.faviconUrl || ''),
  };

  if (input.video && typeof input.video === 'object') {
    const currentTime = Number(input.video.currentTime);
    const duration = Number(input.video.duration);
    result.video = {
      platform: String(input.video.platform || detectPlatform(normalizedUrl, hostname)),
      currentTime: Number.isFinite(currentTime) && currentTime >= 0 ? currentTime : 0,
      duration: Number.isFinite(duration) && duration >= 0 ? duration : undefined,
      paused: Boolean(input.video.paused),
    };
  }

  if (input.anchor && typeof input.anchor === 'object') {
    const ratio = Number(input.anchor.scrollRatio);
    result.anchor = {
      selectedText: normalizeText(input.anchor.selectedText || ''),
      prefixText: normalizeText(input.anchor.prefixText || '').slice(-100),
      suffixText: normalizeText(input.anchor.suffixText || '').slice(0, 100),
      elementFingerprint: normalizeText(input.anchor.elementFingerprint || '').slice(0, 240),
      scrollY: Number.isFinite(Number(input.anchor.scrollY)) ? Number(input.anchor.scrollY) : undefined,
      scrollRatio: Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : undefined,
      frameUrl: cleanUrl(input.anchor.frameUrl || ''),
    };
  }

  return result;
}

function attachRecordLinks(record, sourceLocation) {
  const location = normalizeSourceLocation(sourceLocation);
  if (!record || !record.id || !location) return record;
  return {
    ...record,
    sourceLocation: {
      ...location,
      openUrl: buildOpenUrl(location),
      siteName: sourceSiteName(location),
      icon: sourceIcon(location),
      videoTime: formatVideoTime(location?.video?.currentTime),
    },
  };
}

function sourceMatchesSelection(payload, selection) {
  const a = normalizeText(payload?.text || payload?.sourceLocation?.anchor?.selectedText || '').toLowerCase();
  const b = normalizeText(selection || '').toLowerCase();
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

module.exports = {
  normalizeText,
  cleanUrl,
  sourceSiteName,
  sourceIcon,
  formatVideoTime,
  detectPlatform,
  buildOpenUrl,
  normalizeSourceLocation,
  attachRecordLinks,
  sourceMatchesSelection,
};