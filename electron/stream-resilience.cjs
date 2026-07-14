'use strict';

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_IDLE_TIMEOUT_MS = 45000;
const RETRY_DELAYS_MS = [350, 1000, 2200];

function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  error.code = 20;
  return error;
}

function wait(ms, signal) {
  if (!ms) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal?.removeEventListener?.('abort', onAbort);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function isAbortError(error, signal) {
  return Boolean(signal?.aborted || error?.name === 'AbortError' || error?.code === 20 || error?.type === 'aborted');
}

function isTransientStatus(status) {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function isTransientNetworkError(error) {
  if (!error) return false;
  const code = String(error.code || error.cause?.code || '').toUpperCase();
  const message = String(error.message || error.cause?.message || error).toLowerCase();
  return [
    'ECONNRESET',
    'ECONNREFUSED',
    'EPIPE',
    'ETIMEDOUT',
    'ENETDOWN',
    'ENETUNREACH',
    'EAI_AGAIN',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
  ].includes(code) || /terminated|fetch failed|socket|connection|network|timed?\s*out|stream.*(closed|interrupted)|other side closed/.test(message);
}

function parseJsonBody(init) {
  if (!init || typeof init.body !== 'string') return null;
  try {
    const parsed = JSON.parse(init.body);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return String(input?.url || input || '');
}

function isStreamingChatRequest(input, init) {
  const body = parseJsonBody(init);
  if (!body || body.stream !== true || !Array.isArray(body.messages)) return false;
  const url = requestUrl(input).toLowerCase();
  return /\/chat\/completions(?:\?|$)/.test(url);
}

function retryDelay(attempt) {
  return RETRY_DELAYS_MS[Math.min(Math.max(0, attempt), RETRY_DELAYS_MS.length - 1)];
}

function retryAfterMs(response, attempt) {
  const value = response?.headers?.get?.('retry-after');
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5000);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 5000);
  }
  return retryDelay(attempt);
}

function cloneInit(init, body) {
  return {
    ...(init || {}),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function buildContinuationBody(originalBody, emittedText) {
  const body = JSON.parse(JSON.stringify(originalBody || {}));
  const messages = Array.isArray(body.messages) ? body.messages : [];
  body.stream = true;
  body.messages = [
    ...messages,
    { role: 'assistant', content: String(emittedText || '') },
    {
      role: 'user',
      content: '上一次回答因网络中断。请从中断处继续，只输出尚未生成的后续内容；不要重复、改写或总结已经输出的内容。',
    },
  ];
  return body;
}

function extractDelta(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const value = payload?.choices?.[0]?.delta?.content ?? payload?.choices?.[0]?.message?.content ?? '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((part) => typeof part === 'string' ? part : String(part?.text || '')).join('');
  }
  return '';
}

function encodeDelta(delta) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: String(delta || '') } }] })}\n\n`;
}

function longestSuffixPrefixOverlap(existing, continuation, maxWindow = 600) {
  const left = String(existing || '').slice(-maxWindow);
  const right = String(continuation || '').slice(0, maxWindow);
  const max = Math.min(left.length, right.length);
  for (let size = max; size >= 1; size -= 1) {
    if (left.slice(-size) === right.slice(0, size)) return size;
  }
  return 0;
}

function stripContinuationOverlap(existing, continuation) {
  const text = String(continuation || '');
  if (!text) return '';
  const overlap = longestSuffixPrefixOverlap(existing, text);
  return overlap >= 4 ? text.slice(overlap) : text;
}

async function readWithIdleTimeout(reader, timeoutMs, signal) {
  if (signal?.aborted) throw abortError();
  let timer;
  let onAbort;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('AI stream idle timeout');
      error.code = 'STREAM_IDLE_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortError());
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), timeout, aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

async function fetchWithRetry(originalFetch, input, init, options = {}) {
  const signal = init?.signal;
  const maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : DEFAULT_MAX_RETRIES;
  let attempt = 0;
  while (true) {
    if (signal?.aborted) throw abortError();
    try {
      const response = await originalFetch(input, init);
      if (!isTransientStatus(response.status) || attempt >= maxRetries) return response;
      try { await response.body?.cancel?.(); } catch (_) {}
      await wait(retryAfterMs(response, attempt), signal);
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      if (!isTransientNetworkError(error) || attempt >= maxRetries) throw error;
      await wait(retryDelay(attempt), signal);
    }
    attempt += 1;
  }
}

async function consumeSseResponse(response, handlers, options = {}) {
  if (!response?.body) return { doneMarker: false, text: '' };
  const signal = options.signal;
  const idleTimeoutMs = options.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let doneMarker = false;

  const processLine = (line) => {
    const trimmed = String(line || '').trim();
    if (!trimmed.startsWith('data:')) return;
    const raw = trimmed.slice(5).trim();
    if (!raw) return;
    if (raw === '[DONE]') {
      doneMarker = true;
      return;
    }
    try {
      const delta = extractDelta(JSON.parse(raw));
      if (!delta) return;
      text += delta;
      handlers.onDelta?.(delta);
    } catch (_) {}
  };

  try {
    while (!doneMarker) {
      const { value, done } = await readWithIdleTimeout(reader, idleTimeoutMs, signal);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) processLine(line);
    }
    buffer += decoder.decode();
    if (buffer) processLine(buffer);
    return { doneMarker, text };
  } finally {
    try { reader.releaseLock?.(); } catch (_) {}
  }
}

function responseFromStream(stream, response) {
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function createResilientSseResponse(originalFetch, input, init, initialResponse, options = {}) {
  const encoder = new TextEncoder();
  const originalBody = parseJsonBody(init);
  const signal = init?.signal;
  const maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : DEFAULT_MAX_RETRIES;
  const idleTimeoutMs = options.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS;

  const stream = new ReadableStream({
    async start(controller) {
      let emittedText = '';
      let response = initialResponse;
      let retry = 0;
      let continuationMode = false;

      const emit = (delta) => {
        if (!delta) return;
        emittedText += delta;
        controller.enqueue(encoder.encode(encodeDelta(delta)));
      };

      while (true) {
        let continuationText = '';
        try {
          const result = await consumeSseResponse(response, {
            onDelta(delta) {
              if (continuationMode) continuationText += delta;
              else emit(delta);
            },
          }, { signal, idleTimeoutMs });

          if (continuationMode && continuationText) {
            emit(stripContinuationOverlap(emittedText, continuationText));
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        } catch (error) {
          if (isAbortError(error, signal)) {
            controller.error(error);
            return;
          }
          const transient = isTransientNetworkError(error) || error?.code === 'STREAM_IDLE_TIMEOUT';
          if (!transient || retry >= maxRetries) {
            if (emittedText) {
              console.warn('[StreamResilience] retries exhausted; preserving partial answer', {
                retries: retry,
                length: emittedText.length,
                error: String(error?.message || error),
              });
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            } else {
              controller.error(error);
            }
            return;
          }
        }

        await wait(retryDelay(retry), signal).catch((error) => {
          throw error;
        });
        retry += 1;
        continuationMode = emittedText.length > 0;
        const nextBody = continuationMode
          ? buildContinuationBody(originalBody, emittedText)
          : originalBody;
        const nextInit = cloneInit(init, nextBody);
        try {
          response = await fetchWithRetry(originalFetch, input, nextInit, { maxRetries: 0 });
          if (!response.ok || !response.body) {
            const statusError = new Error(`AI stream reconnect failed: HTTP ${response.status}`);
            statusError.code = isTransientStatus(response.status) ? 'STREAM_RETRYABLE_STATUS' : 'STREAM_FATAL_STATUS';
            throw statusError;
          }
          console.warn('[StreamResilience] AI stream reconnected', {
            retry,
            continuation: continuationMode,
            preservedLength: emittedText.length,
          });
        } catch (error) {
          if (isAbortError(error, signal)) {
            controller.error(error);
            return;
          }
          if (retry >= maxRetries) {
            if (emittedText) {
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            } else {
              controller.error(error);
            }
            return;
          }
          response = null;
          continue;
        }
      }
    },
    cancel(reason) {
      if (!signal?.aborted) console.log('[StreamResilience] consumer cancelled stream', String(reason || ''));
    },
  });

  return responseFromStream(stream, initialResponse);
}

function createResilientFetch(originalFetch, options = {}) {
  if (typeof originalFetch !== 'function') throw new TypeError('originalFetch must be a function');
  return async function resilientFetch(input, init) {
    if (!isStreamingChatRequest(input, init)) return originalFetch(input, init);
    const response = await fetchWithRetry(originalFetch, input, init, options);
    if (!response.ok || !response.body) return response;
    return createResilientSseResponse(originalFetch, input, init, response, options);
  };
}

let installed = false;
let originalFetch = null;

function install(options = {}) {
  if (installed) return true;
  if (typeof globalThis.fetch !== 'function') {
    console.warn('[StreamResilience] global fetch is unavailable; runtime not installed');
    return false;
  }
  originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = createResilientFetch(originalFetch, options);
  installed = true;
  console.log('[StreamResilience] installed');
  return true;
}

function uninstall() {
  if (!installed || !originalFetch) return false;
  globalThis.fetch = originalFetch;
  originalFetch = null;
  installed = false;
  return true;
}

module.exports = {
  DEFAULT_MAX_RETRIES,
  DEFAULT_IDLE_TIMEOUT_MS,
  isTransientStatus,
  isTransientNetworkError,
  isStreamingChatRequest,
  buildContinuationBody,
  extractDelta,
  longestSuffixPrefixOverlap,
  stripContinuationOverlap,
  fetchWithRetry,
  consumeSseResponse,
  createResilientSseResponse,
  createResilientFetch,
  install,
  uninstall,
};