import test from 'node:test';
import assert from 'node:assert/strict';
import { saveMessage } from '../src/services/memory.js';

test('message writes include the authenticated owner and conversation identifiers', async () => {
  let inserted;
  const supabase = {
    from(table) {
      assert.equal(table, 'messages');
      return {
        insert(row) {
          inserted = row;
          return { error: null };
        },
      };
    },
  };

  await saveMessage(supabase, {
    userId: 'auth-user-1',
    conversationId: 'conversation-1',
    role: 'user',
    content: 'Remember this',
    metadata: { source: 'test' },
  });

  assert.deepEqual(inserted, {
    user_id: 'auth-user-1',
    conversation_id: 'conversation-1',
    role: 'user',
    content: 'Remember this',
    metadata: { source: 'test' },
  });
});

test('message writes reject missing authenticated database context', async () => {
  await assert.rejects(
    saveMessage(null, { conversationId: 'conversation-1', role: 'user', content: 'No owner' }),
    /Authenticated database context is required/,
  );
});
