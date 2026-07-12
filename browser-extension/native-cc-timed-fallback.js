(function () {
  'use strict';

  const host = location.hostname.toLowerCase();
  if (!(host === 'youtube.com' || host.endsWith('.youtube.com')) || window.top !== window) return;

  const VERSION = '1.0.0-native-cc-timed-fallback';
  const TEXT_SELECTOR = '#jiaohua-selectable-caption-overlay .jiaohua-caption-text';
  const WORD_SELECTOR = '.jiaohua-caption-word';
  if (window.__JIAOHUA_NATIVE_CC_TIMED_FALLBACK__ === VERSION) return;
  window.__JIAOHUA_NATIVE_CC_TIMED_FALLBACK__ = VERSION;

  let sentence = '';
  let observedStart = 0;
  let timings = [];
  let timingSource = '';
  let frame = 0;
  let boundVideo = null;

  function normalize(value) {
    return String(value || '')
      .replace(/<\/?(?:c|v|lang)(?:\.[^ >]+| [^>]*)?>/gi, '')
      .replace(/<\d{1,2}:\d{2}(?::\d{2})?\.\d{3}>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function comparable(value) {
    return normalize(value).toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
  }

  function wordData(textElement) {
    return Array.from(textElement.querySelectorAll(WORD_SELECTOR)).map((span) => {
      const suffix = span.nextSibling?.nodeType === Node.TEXT_NODE ? span.nextSibling.nodeValue || '' : '';
      return {
        span,
        text: normalize(span.textContent),
        key: normalize(span.textContent).toLocaleLowerCase(),
        suffix,
      };
    }).filter((item) => item.text);
  }

  function weight(word) {
    const length = Array.from(word.text).length;
    let value = 0.72 + Math.min(1.9, Math.sqrt(Math.max(1, length)) * 0.42);
    if (/[,，、;；:]\s*$/.test(word.suffix)) value += 0.5;
    if (/[.!?。！？]\s*$/.test(word.suffix)) value += 0.7;
    if (/[-—…]\s*$/.test(word.suffix)) value += 0.35;
    return value;
  }

  function estimatedDuration(words) {
    const total = words.reduce((sum, word) => sum + weight(word), 0);
    return Math.max(1.15, Math.min(8.5, total * 0.27));
  }

  function distribute(words, start, end) {
    if (!words.length) return [];
    const safeEnd = Number.isFinite(end) && end > start ? end : start + estimatedDuration(words);
    const lead = Math.min(0.16, Math.max(0, (safeEnd - start) * 0.04));
    const tail = Math.min(0.2, Math.max(0, (safeEnd - start) * 0.05));
    const contentStart = start + lead;
    const contentEnd = Math.max(contentStart + 0.15, safeEnd - tail);
    const weights = words.map(weight);
    const total = weights.reduce((sum, value) => sum + value, 0) || words.length;
    let cursor = contentStart;
    return words.map((word, index) => {
      const duration = (contentEnd - contentStart) * weights[index] / total;
      const item = {
        key: word.key,
        start: cursor,
        end: index === words.length - 1 ? contentEnd : cursor + duration,
      };
      cursor += duration;
      return item;
    });
  }

  function cueMatches(cue, text) {
    const a = comparable(cue?.text);
    const b = comparable(text);
    if (!a || !b) return false;
    if (a === b) return true;
    if (!a.includes(b) && !b.includes(a)) return false;
    return Math.min(a.length, b.length) / Math.max(a.length, b.length) >= 0.72;
  }

  function matchingCue(video, text) {
    const now = Number(video.currentTime || 0);
    let best = null;
    for (const track of Array.from(video.textTracks || [])) {
      let cues = [];
      try {
        cues = track.activeCues?.length ? Array.from(track.activeCues) : Array.from(track.cues || []);
      } catch (_) {}
      for (const cue of cues) {
        if (now < Number(cue.startTime) - 0.25 || now > Number(cue.endTime) + 0.25) continue;
        if (!cueMatches(cue, text)) continue;
        const duration = Number(cue.endTime) - Number(cue.startTime);
        if (!best || duration < best.duration) best = { cue, duration };
      }
    }
    return best?.cue || null;
  }

  function parseTimestamp(value) {
    const match = String(value || '').match(/^(?:(\d{1,2}):)?(\d{2}):(\d{2}\.\d{3})$/);
    if (!match) return null;
    return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }

  function tokenize(value) {
    try {
      if (typeof Intl?.Segmenter === 'function') {
        const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
        return Array.from(segmenter.segment(normalize(value)))
          .filter((item) => item.isWordLike)
          .map((item) => normalize(item.segment).toLocaleLowerCase());
      }
    } catch (_) {}
    return (normalize(value).match(/[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*|[\u3400-\u9fff]/g) || [])
      .map((item) => item.toLocaleLowerCase());
  }

  function taggedTimings(cue, words) {
    const raw = String(cue?.text || '');
    const regex = /<(\d{1,2}:\d{2}(?::\d{2})?\.\d{3})>/g;
    if (!regex.test(raw)) return null;
    regex.lastIndex = 0;

    const chunks = [];
    let start = Number(cue.startTime);
    let cursor = 0;
    let match;
    while ((match = regex.exec(raw))) {
      const text = normalize(raw.slice(cursor, match.index));
      if (text) chunks.push({ start, keys: tokenize(text) });
      const parsed = parseTimestamp(match[1]);
      if (parsed != null) start = parsed;
      cursor = match.index + match[0].length;
    }
    const tail = normalize(raw.slice(cursor));
    if (tail) chunks.push({ start, keys: tokenize(tail) });

    const flattened = chunks.flatMap((chunk) => chunk.keys);
    if (flattened.length !== words.length) return null;
    const matches = flattened.filter((key, index) => key === words[index].key).length;
    if (matches / Math.max(1, words.length) < 0.8) return null;

    const result = [];
    let offset = 0;
    chunks.forEach((chunk, index) => {
      const count = chunk.keys.length;
      const group = words.slice(offset, offset + count);
      const end = chunks[index + 1]?.start ?? Number(cue.endTime);
      result.push(...distribute(group, chunk.start, end));
      offset += count;
    });
    return result.length === words.length ? result : null;
  }

  function buildTimings(video, textElement, words) {
    const cue = matchingCue(video, textElement.textContent || '');
    if (cue) {
      const tagged = taggedTimings(cue, words);
      if (tagged) return { source: 'cue-word-tags', items: tagged };
      const start = Number(cue.startTime);
      const end = Number(cue.endTime);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        return { source: 'cue-duration', items: distribute(words, start, end) };
      }
    }
    return {
      source: 'observed-estimate',
      items: distribute(words, observedStart, observedStart + estimatedDuration(words)),
    };
  }

  function reset() {
    sentence = '';
    timings = [];
    timingSource = '';
    observedStart = 0;
  }

  function bindVideo(video) {
    if (!video || video === boundVideo) return;
    boundVideo = video;
    video.addEventListener('seeking', reset);
    video.addEventListener('seeked', reset);
    video.addEventListener('loadedmetadata', reset);
  }

  function tick() {
    const textElement = document.querySelector(TEXT_SELECTOR);
    const video = document.querySelector('video');
    if (!textElement || !video) return;
    bindVideo(video);

    // The original progressive-CC highlighter has trustworthy timing. Do not override it.
    if (textElement.dataset.wordHighlight === 'true' && textElement.dataset.wordHighlightSource !== 'timed') return;

    const words = wordData(textElement);
    const nextSentence = normalize(textElement.textContent || '');
    if (!nextSentence || !words.length) return;

    if (nextSentence !== sentence || timings.length !== words.length) {
      sentence = nextSentence;
      observedStart = Number(video.currentTime || 0);
      const built = buildTimings(video, textElement, words);
      timings = built.items;
      timingSource = built.source;
    } else if (timingSource === 'observed-estimate') {
      const built = buildTimings(video, textElement, words);
      if (built.source !== 'observed-estimate') {
        timings = built.items;
        timingSource = built.source;
      }
    }

    if (timings.length !== words.length) return;
    const now = Number(video.currentTime || 0);
    let active = timings.findIndex((item) => now >= item.start && now < item.end);
    if (active < 0) active = now < timings[0].start ? 0 : timings.length - 1;

    textElement.dataset.wordHighlight = 'true';
    textElement.dataset.wordHighlightSource = 'timed';
    textElement.dataset.wordTimingSource = timingSource;
    words.forEach((word, index) => {
      word.span.classList.toggle('is-spoken', index < active);
      word.span.classList.toggle('is-active', index === active);
    });
  }

  function loop() {
    tick();
    frame = requestAnimationFrame(loop);
  }

  const observer = new MutationObserver(() => {
    const textElement = document.querySelector(TEXT_SELECTOR);
    if (!textElement) return;
    if (normalize(textElement.textContent || '') !== sentence) reset();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  window.addEventListener('pagehide', () => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
  }, { once: true });

  frame = requestAnimationFrame(loop);
})();
