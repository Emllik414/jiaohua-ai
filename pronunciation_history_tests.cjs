const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pickConversationId,
  migratePronunciationHistory,
  patchPronunciationRecord,
} = require('./electron/pronunciation-history-runtime.cjs');

test('prefers active conversation and falls back to first conversation', () => {
  assert.equal(pickConversationId({
    activeConversationId: 'conv_active',
    conversations: [{ id: 'conv_first' }],
  }), 'conv_active');

  assert.equal(pickConversationId({
    activeConversationId: '',
    conversations: [{ id: 'conv_first' }],
  }), 'conv_first');
});

test('migrates only orphan pronunciation records', () => {
  const regular = { id: 'regular', conversationId: '', answerMarkdown: 'ok' };
  const assigned = {
    id: 'assigned',
    conversationId: 'conv_old',
    pronunciationData: { text: 'word' },
  };
  const orphan = {
    id: 'orphan',
    pronunciationData: { text: 'hello' },
  };

  const result = migratePronunciationHistory({
    activeConversationId: 'conv_active',
    conversations: [{ id: 'conv_active' }],
    history: [regular, assigned, orphan],
  });

  assert.equal(result.changed, true);
  assert.equal(result.count, 1);
  assert.equal(result.store.history[0], regular);
  assert.equal(result.store.history[1], assigned);
  assert.equal(result.store.history[2].conversationId, 'conv_active');
});

test('does nothing when no conversation exists', () => {
  const store = {
    activeConversationId: '',
    conversations: [],
    history: [{ id: 'orphan', pronunciationData: { text: 'hello' } }],
  };
  const result = migratePronunciationHistory(store);
  assert.equal(result.changed, false);
  assert.equal(result.store, store);
});

test('patches persisted pronunciation record and returned record', () => {
  const record = {
    id: 'pron-1',
    pronunciationData: { text: 'hello' },
  };
  const store = {
    activeConversationId: 'conv_active',
    conversations: [{ id: 'conv_active' }],
    history: [{ ...record, status: 'completed' }],
  };

  const result = patchPronunciationRecord(store, record);
  assert.equal(result.found, true);
  assert.equal(result.changed, true);
  assert.equal(result.record.conversationId, 'conv_active');
  assert.equal(result.store.history[0].conversationId, 'conv_active');
});

test('preserves an existing conversation assignment', () => {
  const record = {
    id: 'pron-1',
    conversationId: 'conv_existing',
    pronunciationData: { text: 'hello' },
  };
  const store = {
    activeConversationId: 'conv_active',
    conversations: [{ id: 'conv_active' }],
    history: [{ ...record }],
  };

  const result = patchPronunciationRecord(store, record);
  assert.equal(result.changed, false);
  assert.equal(result.record.conversationId, 'conv_existing');
  assert.equal(result.store, store);
});
