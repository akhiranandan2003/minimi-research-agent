import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthMiddleware } from '../src/middleware/auth.js';

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('auth middleware verifies the bearer token and attaches a user-scoped database client', async () => {
  const supabase = { auth: { getUser: async (token) => ({ data: { user: { id: 'user-123', email: 'user@example.com' } }, error: null, token }) } };
  const middleware = createAuthMiddleware({ createClient: (token) => {
    assert.equal(token, 'valid.jwt.token');
    return supabase;
  } });
  const req = { headers: { authorization: 'Bearer valid.jwt.token' } };
  const res = responseRecorder();
  let nextCalled = false;

  await middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(req.supabase, supabase);
  assert.deepEqual(req.user, { id: 'user-123', email: 'user@example.com' });
  assert.equal(res.statusCode, 200);
});

test('auth middleware rejects missing, malformed, and invalid tokens without calling next', async () => {
  const middleware = createAuthMiddleware({ createClient: () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: new Error('invalid') }) },
  }) });

  for (const authorization of [undefined, 'Basic abc', 'Bearer invalid']) {
    const req = { headers: authorization ? { authorization } : {} };
    const res = responseRecorder();
    let nextCalled = false;
    await middleware(req, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
    assert.match(res.body.error, /Sign in|invalid or expired/);
  }
});

test('auth middleware hides token-verification provider errors', async () => {
  const middleware = createAuthMiddleware({ createClient: () => { throw new Error('secret provider detail'); } });
  const req = { headers: { authorization: 'Bearer valid.jwt.token' } };
  const res = responseRecorder();

  await middleware(req, res, () => assert.fail('next must not be called'));

  assert.equal(res.statusCode, 401);
  assert.doesNotMatch(JSON.stringify(res.body), /secret provider detail/);
});
