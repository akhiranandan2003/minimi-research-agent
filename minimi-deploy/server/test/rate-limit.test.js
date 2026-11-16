import test from 'node:test';
import assert from 'node:assert/strict';
import { createUserRateLimiter } from '../src/middleware/rate-limit.js';

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('rate limiter caps a user within the window and returns Retry-After', () => {
  let now = 1_000;
  const limit = createUserRateLimiter({ windowMs: 60_000, maxRequests: 2, now: () => now });
  const req = { user: { id: 'user-1' } };
  let nextCount = 0;

  for (let i = 0; i < 2; i += 1) {
    const res = responseRecorder();
    limit(req, res, () => { nextCount += 1; });
    assert.equal(res.statusCode, 200);
  }

  const blocked = responseRecorder();
  limit(req, blocked, () => { nextCount += 1; });
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['Retry-After'], '60');
  assert.match(blocked.body.error, /Too many messages/);
  assert.equal(nextCount, 2);

  now += 60_001;
  const reset = responseRecorder();
  limit(req, reset, () => { nextCount += 1; });
  assert.equal(reset.statusCode, 200);
  assert.equal(nextCount, 3);
});

test('rate limiter keeps separate users in separate buckets', () => {
  const limit = createUserRateLimiter({ windowMs: 1000, maxRequests: 1, now: () => 100 });
  const first = responseRecorder();
  const second = responseRecorder();

  limit({ user: { id: 'user-a' } }, first, () => {});
  limit({ user: { id: 'user-b' } }, second, () => {});

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
});
