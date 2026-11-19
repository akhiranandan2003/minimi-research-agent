import test from 'node:test';
import assert from 'node:assert/strict';
import { queryConversationHistory } from '../src/services/memory-query.js';

function createSupabase(responses) {
  const calls = [];
  const supabase = {
    from(table) {
      const response = responses[calls.length];
      const call = { table, filters: [] };
      const query = {
        select(columns) { call.columns = columns; return query; },
        eq(column, value) { call.filters.push({ column, value }); return query; },
        textSearch(column, value, options) { call.search = { column, value, options }; return query; },
        order(column, options) { call.order = { column, options }; return query; },
        limit(value) { call.limit = value; return query; },
        then(resolve, reject) { return Promise.resolve(response).then(resolve, reject); },
      };
      calls.push(call);
      return query;
    },
  };
  return { supabase, calls };
}

const ownerId = 'authenticated-user-1';
const conversationId = '8d6a8c8a-6d72-4b45-9e9e-b4a5a32d1234';

test('history combines recent rows with older topic matches, scopes both reads, deduplicates, and sorts bigint IDs exactly', async () => {
  const sameTimestamp = '2026-11-18T10:00:00.000Z';
  const recentRows = [
    { id: '9007199254740993', role: 'assistant', content: 'Newest answer', created_at: sameTimestamp, metadata: {} },
    { id: '9007199254740992', role: 'user', content: 'Newest question', created_at: sameTimestamp, metadata: {} },
  ];
  const relevantRows = [
    { id: '100', role: 'user', content: 'Older visa eligibility details', created_at: '2026-01-01T10:00:00Z', metadata: {} },
    { id: '101', role: 'assistant', content: 'Earlier visa screening answer', created_at: '2026-02-01T10:00:00Z', metadata: {} },
    recentRows[0],
  ];
  const { supabase, calls } = createSupabase([
    { data: recentRows, error: null },
    { data: relevantRows, error: null },
  ]);

  const history = await queryConversationHistory(
    supabase,
    ownerId,
    conversationId,
    2,
    'What did I tell you earlier about the visa eligibility project?',
  );

  assert.deepEqual(history.map((row) => row.id), [
    '100',
    '101',
    '9007199254740992',
    '9007199254740993',
  ]);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.table, 'messages');
    assert.equal(call.columns, 'id, role, content, created_at, metadata');
    assert.deepEqual(call.filters, [
      { column: 'user_id', value: ownerId },
      { column: 'conversation_id', value: conversationId },
    ]);
  }
  assert.deepEqual(calls[0].order, { column: 'created_at', options: { ascending: false } });
  assert.equal(calls[0].limit, 2);
  assert.deepEqual(calls[1].search, {
    column: 'content',
    value: '"visa" OR "eligibility" OR "project"',
    options: { type: 'websearch', config: 'english' },
  });
  assert.equal(calls[1].limit, 30);
});

test('history-only wording with no useful search terms performs only the recent scoped query', async () => {
  const rows = [
    { id: '2', role: 'assistant', content: 'Stored answer', created_at: '2026-11-18T10:01:00Z' },
    { id: '1', role: 'user', content: 'Stored question', created_at: '2026-11-18T10:00:00Z' },
  ];
  const { supabase, calls } = createSupabase([{ data: rows, error: null }]);

  const history = await queryConversationHistory(
    supabase,
    ownerId,
    conversationId,
    40,
    'What did I say earlier?',
  );

  assert.deepEqual(history.map((row) => row.id), ['1', '2']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].search, undefined);
  assert.equal(calls[0].limit, 40);
});

test('full-text lookup errors preserve recent history instead of failing the chat', async () => {
  const rows = [
    { id: '5', role: 'assistant', content: 'Recent stored answer', created_at: '2026-11-18T10:00:00Z' },
  ];
  const { supabase, calls } = createSupabase([
    { data: rows, error: null },
    { data: null, error: { message: 'simulated full-text index error' } },
  ]);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);

  try {
    const history = await queryConversationHistory(
      supabase,
      ownerId,
      conversationId,
      40,
      'Find my earlier visa eligibility discussion',
    );
    assert.deepEqual(history, rows);
    assert.equal(calls.length, 2);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].join(' '), /Full-text history lookup failed/);
    assert.doesNotMatch(warnings[0].join(' '), /secret|token|password/i);
  } finally {
    console.warn = originalWarn;
  }
});

test('a failure in the primary recent-history query is surfaced clearly', async () => {
  const { supabase } = createSupabase([
    { data: null, error: { message: 'database unavailable' } },
  ]);

  await assert.rejects(
    queryConversationHistory(supabase, ownerId, conversationId, 40, 'Earlier discussion'),
    /Could not retrieve conversation history: database unavailable/,
  );
});
