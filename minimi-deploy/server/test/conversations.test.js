import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createConversation,
  getConversation,
  listConversations,
  touchConversation,
} from '../src/services/conversations.js';

const userId = 'user-123';
const conversationId = '8d6a8c8a-6d72-4b45-9e9e-b4a5a32d1234';

test('conversation list is owner-scoped, newest-first, and bounded', async () => {
  const calls = [];
  const rows = [{ id: conversationId, title: 'My research', updated_at: '2026-11-17T10:00:00Z' }];
  const query = {
    select(value) { calls.push(['select', value]); return this; },
    eq(column, value) { calls.push(['eq', column, value]); return this; },
    order(column, options) { calls.push(['order', column, options]); return this; },
    limit(value) { calls.push(['limit', value]); return Promise.resolve({ data: rows, error: null }); },
  };
  const supabase = { from(table) { assert.equal(table, 'conversations'); return query; } };

  const result = await listConversations(supabase, userId, 500);

  assert.deepEqual(result, rows);
  assert.ok(calls.some((call) => call[0] === 'eq' && call[1] === 'user_id' && call[2] === userId));
  assert.ok(calls.some((call) => call[0] === 'order' && call[1] === 'updated_at' && call[2].ascending === false));
  assert.ok(calls.some((call) => call[0] === 'limit' && call[1] === 100));
});

test('conversation creation persists an authenticated owner and returns the stored row', async () => {
  let inserted;
  const supabase = {
    from(table) {
      assert.equal(table, 'conversations');
      return {
        insert(row) {
          inserted = row;
          return {
            select() {
              return { single: async () => ({ data: { ...row, created_at: 'now', updated_at: 'now' }, error: null }) };
            },
          };
        },
      };
    },
  };

  const result = await createConversation(supabase, userId);

  assert.equal(inserted.user_id, userId);
  assert.equal(inserted.title, 'New chat');
  assert.match(inserted.id, /^[0-9a-f-]{36}$/i);
  assert.equal(result.id, inserted.id);
});

test('conversation lookup filters by both owner and conversation ID', async () => {
  const filters = [];
  const expected = { id: conversationId, title: 'My research' };
  const query = {
    select() { return this; },
    eq(column, value) { filters.push([column, value]); return this; },
    maybeSingle: async () => ({ data: expected, error: null }),
  };
  const supabase = { from: (table) => { assert.equal(table, 'conversations'); return query; } };

  assert.deepEqual(await getConversation(supabase, userId, conversationId), expected);
  assert.deepEqual(filters, [['user_id', userId], ['id', conversationId]]);
});

test('first message names a new conversation and activity update remains owner-scoped', async () => {
  const filters = [];
  let update;
  const query = {
    select() { return this; },
    eq(column, value) { filters.push([column, value]); return this; },
    maybeSingle: async () => ({ data: { id: conversationId, title: 'New chat' }, error: null }),
    update(value) { update = value; return this; },
  };
  const supabase = { from: (table) => { assert.equal(table, 'conversations'); return query; } };

  assert.equal(await touchConversation(supabase, userId, conversationId, '  Compare   Node.js releases  '), true);
  assert.equal(update.title, 'Compare Node.js releases');
  assert.ok(Number.isFinite(Date.parse(update.updated_at)));
  assert.ok(filters.some(([column, value]) => column === 'user_id' && value === userId));
  assert.ok(filters.some(([column, value]) => column === 'id' && value === conversationId));
});

test('touching an unknown or another user conversation returns false without writing', async () => {
  let updated = false;
  const query = {
    select() { return this; },
    eq() { return this; },
    maybeSingle: async () => ({ data: null, error: null }),
    update() { updated = true; return this; },
  };
  const supabase = { from: () => query };

  assert.equal(await touchConversation(supabase, userId, conversationId, 'Hello'), false);
  assert.equal(updated, false);
});

test('conversation services reject missing authenticated context', async () => {
  await assert.rejects(listConversations(null, null), /Authenticated database context/);
  await assert.rejects(createConversation(null, userId), /Authenticated database context/);
});
