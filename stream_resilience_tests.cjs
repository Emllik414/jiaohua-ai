'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isTransientNetworkError,
  isStreamingChatRequest,
  buildContinuationBody,
  stripContinuationOverlap,
  fetchWithRetry,
  createResilientFetch,
} = require('./electron/stream-resilience.cjs');

function sseDelta(text) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

function responseFromParts(parts, options = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let index = 0;
      const pump = () => {
        if (index >= parts.length) {
          if (options.error) controller.error(options.error);
          else controller.close();
          return;
        }
        controller.enqueue(encoder.encode(parts[index++]));
        queueMicrotask(pump);
      };
      pump();
    },
  });
  return new Response(stream, {
    status: options.status || 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function collectAnswer(raw) {
  let answer = '';
  for (const line of String(raw || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    const parsed = JSON.parse(payload);
    answer += parsed?.choices?.[0]?.delta?.content || '';
  }
  return answer;
}

function streamingInit(signal) {
  return {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'test-model',
      stream: true,
      messages: [
        { role: 'system', content: 'Be helpful.' },
        { role: 'user', content: 'Say hello.' },
      ],
    }),
  };
}

test('only wraps OpenAI-compatible streaming chat requests', () => {
  assert.equal(isStreamingChatRequest('https://api.example.com/v1/chat/completions', streamingInit()), true);
  assert.equal(isStreamingChatRequest('https://api.example.com/v1/responses', streamingInit()), false);
  const nonStream = streamingInit();
  nonStream.body = JSON.stringify({ messages: [], stream: false });
  assert.equal(isStreamingChatRequest('https://api.example.com/v1/chat/completions', nonStream), false);
});

test('recognizes common interrupted connection errors', () => {
  const reset = new Error('socket terminated by the other side');
  reset.code = 'ECONNRESET';
  assert.equal(isTransientNetworkError(reset), true);
  assert.equal(isTransientNetworkError(new Error('invalid JSON response')), false);
});

test('builds a continuation request without changing the original body', () => {
  const original = JSON.parse(streamingInit().body);
  const next = buildContinuationBody(original, 'Hello ');
  assert.equal(original.messages.length, 2);
  assert.equal(next.messages.length, 4);
  assert.deepEqual(next.messages[2], { role: 'assistant', content: 'Hello ' });
  assert.match(next.messages[3].content, /只输出尚未生成/);
  assert.equal(next.stream, true);
});

test('removes repeated text at the resume boundary', () => {
  assert.equal(stripContinuationOverlap('The answer is hello world', 'hello world and more'), ' and more');
  assert.equal(stripContinuationOverlap('abc', 'different'), 'different');
});

test('retries a transient failure before response headers', async () => {
  let calls = 0;
  const originalFetch = async () => {
    calls += 1;
    if (calls === 1) {
      const error = new Error('fetch failed');
      error.cause = { code: 'UND_ERR_SOCKET' };
      throw error;
    }
    return new Response('ok', { status: 200 });
  };
  const response = await fetchWithRetry(originalFetch, 'https://example.com', { method: 'POST' }, { maxRetries: 1 });
  assert.equal(await response.text(), 'ok');
  assert.equal(calls, 2);
});

test('continues after a mid-stream connection reset and keeps one coherent answer', async () => {
  let calls = 0;
  let continuationBody = null;
  const reset = new Error('connection interrupted');
  reset.code = 'ECONNRESET';

  const originalFetch = async (_input, init) => {
    calls += 1;
    if (calls === 1) {
      return responseFromParts([sseDelta('Hello ')], { error: reset });
    }
    continuationBody = JSON.parse(init.body);
    return responseFromParts([sseDelta('world.'), 'data: [DONE]\n\n']);
  };

  const resilientFetch = createResilientFetch(originalFetch, { maxRetries: 1, idleTimeoutMs: 1000 });
  const response = await resilientFetch('https://api.example.com/v1/chat/completions', streamingInit());
  const raw = await response.text();

  assert.equal(collectAnswer(raw), 'Hello world.');
  assert.equal(calls, 2);
  assert.equal(continuationBody.messages.at(-2).role, 'assistant');
  assert.equal(continuationBody.messages.at(-2).content, 'Hello ');
  assert.match(continuationBody.messages.at(-1).content, /网络中断/);
});

test('preserves partial output when all reconnect attempts fail', async () => {
  let calls = 0;
  const reset = new Error('stream interrupted');
  reset.code = 'ECONNRESET';

  const originalFetch = async () => {
    calls += 1;
    if (calls === 1) return responseFromParts([sseDelta('Partial answer')], { error: reset });
    throw reset;
  };

  const resilientFetch = createResilientFetch(originalFetch, { maxRetries: 1, idleTimeoutMs: 1000 });
  const response = await resilientFetch('https://api.example.com/v1/chat/completions', streamingInit());
  const raw = await response.text();

  assert.equal(collectAnswer(raw), 'Partial answer');
  assert.match(raw, /\[DONE\]/);
  assert.equal(calls, 2);
});

test('does not retry an explicit user abort', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const originalFetch = async () => {
    calls += 1;
    throw new Error('should not be called');
  };
  await assert.rejects(
    fetchWithRetry(originalFetch, 'https://example.com', { signal: controller.signal }, { maxRetries: 2 }),
    (error) => error?.name === 'AbortError'
  );
  assert.equal(calls, 0);
});
