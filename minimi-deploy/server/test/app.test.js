import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

const conversationId = '8d6a8c8a-6d72-4b45-9e9e-b4a5a32d1234';
const userId = 'authenticated-user';

function authenticate(req, res, next) {
  if (req.headers.authorization !== 'Bearer test-token') {
    return res.status(401).json({ error: 'Sign in to continue.' });
  }
  req.user = { id: userId };
  req.supabase = { scopedTo: userId };
  return next();
}

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  try {
    await callback('http://127.0.0.1:' + address.port);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

const headers = { Authorization: 'Bearer test-token' };

test('protected conversation routes reject requests without a verified session', async () => {
  let called = false;
  const app = createApp({
    authenticate,
    listConversations: async () => { called = true; return []; },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(baseUrl + '/api/conversations');
    assert.equal(response.status, 401);
    assert.equal(called, false);
  });
});

test('conversation listing uses the authenticated user-scoped database client', async () => {
  const expected = [{ id: conversationId, title: 'Research', updated_at: '2026-11-18T04:00:00Z' }];
  const app = createApp({
    authenticate,
    listConversations: async (supabase, ownerId, limit) => {
      assert.equal(supabase.scopedTo, userId);
      assert.equal(ownerId, userId);
      assert.equal(limit, 50);
      return expected;
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(baseUrl + '/api/conversations', { headers });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).conversations, expected);
  });
});

test('history endpoint verifies ownership before reading stored messages', async () => {
  let historyRead = false;
  const app = createApp({
    authenticate,
    getConversation: async (supabase, ownerId, id) => {
      assert.equal(supabase.scopedTo, userId);
      assert.equal(ownerId, userId);
      assert.equal(id, conversationId);
      return null;
    },
    getConversationHistory: async () => { historyRead = true; return []; },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(baseUrl + '/api/conversations/' + conversationId + '/messages', { headers });
    assert.equal(response.status, 404);
    assert.equal(historyRead, false);
  });
});

test('history endpoint returns actual stored message rows and source metadata', async () => {
  const rows = [{
    role: 'assistant',
    content: 'The documented release is in November [1].',
    created_at: '2026-11-18T04:00:00Z',
    metadata: { sources: [{ citation: 1, title: 'Release notes', url: 'https://example.com/release' }] },
  }];
  const app = createApp({
    authenticate,
    getConversation: async (_supabase, ownerId, id) => ownerId === userId && id === conversationId ? { id } : null,
    getConversationHistory: async (supabase, ownerId, id, limit) => {
      assert.equal(supabase.scopedTo, userId);
      assert.equal(ownerId, userId);
      assert.equal(id, conversationId);
      assert.equal(limit, 100);
      return rows;
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(baseUrl + '/api/conversations/' + conversationId + '/messages', { headers });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).messages, [{
      role: 'assistant',
      content: rows[0].content,
      createdAt: rows[0].created_at,
      sources: rows[0].metadata.sources,
    }]);
  });
});

test('chat rejects a conversation not owned by the authenticated user', async () => {
  let agentCalled = false;
  const app = createApp({
    authenticate,
    rateLimitChat: (_req, _res, next) => next(),
    touchConversation: async (supabase, ownerId, id) => {
      assert.equal(supabase.scopedTo, userId);
      assert.equal(ownerId, userId);
      assert.equal(id, conversationId);
      return false;
    },
    runAgent: async () => { agentCalled = true; return { answer: 'unexpected' }; },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(baseUrl + '/api/chat', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, message: 'Hello' }),
    });
    assert.equal(response.status, 404);
    assert.equal(agentCalled, false);
  });
});

test('chat derives user identity from verified auth, never from request JSON', async () => {
  let received;
  const app = createApp({
    authenticate,
    rateLimitChat: (_req, _res, next) => next(),
    touchConversation: async (_supabase, ownerId, id, message) => {
      assert.equal(ownerId, userId);
      assert.equal(id, conversationId);
      assert.equal(message, 'Compare these releases');
      return true;
    },
    runAgent: async (input) => {
      received = input;
      return { answer: 'Here is the comparison.', sources: [] };
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(baseUrl + '/api/chat', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId,
        message: 'Compare these releases',
        userId: 'attacker-controlled-user',
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { answer: 'Here is the comparison.', sources: [] });
    assert.equal(received.userId, userId);
    assert.equal(received.supabase.scopedTo, userId);
    assert.equal(received.message, 'Compare these releases');
    assert.equal('userId' in received, true);
  });
});

test('chat validates payload before checking conversation or invoking the agent', async () => {
  let touched = false;
  let agentCalled = false;
  const app = createApp({
    authenticate,
    rateLimitChat: (_req, _res, next) => next(),
    touchConversation: async () => { touched = true; return true; },
    runAgent: async () => { agentCalled = true; return { answer: 'unexpected' }; },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(baseUrl + '/api/chat', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'not-a-uuid', message: '   ' }),
    });
    assert.equal(response.status, 400);
    assert.equal(touched, false);
    assert.equal(agentCalled, false);
  });
});
