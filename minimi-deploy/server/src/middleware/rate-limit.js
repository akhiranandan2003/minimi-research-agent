export function createUserRateLimiter({ windowMs = 60_000, maxRequests = 20, now = Date.now } = {}) {
  if (!Number.isFinite(windowMs) || windowMs < 1) throw new TypeError('windowMs must be a positive number.');
  if (!Number.isInteger(maxRequests) || maxRequests < 1) throw new TypeError('maxRequests must be a positive integer.');

  const buckets = new Map();

  return function limitUserRequests(req, res, next) {
    const key = req.user?.id || req.ip || 'unknown';
    const currentTime = now();
    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= currentTime) {
      bucket = { count: 0, resetAt: currentTime + windowMs };
      buckets.set(key, bucket);
    }

    if (bucket.count >= maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - currentTime) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many messages. Please wait before trying again.' });
    }

    bucket.count += 1;

    // Bound memory use if this process sees many short-lived identities.
    if (buckets.size > 5000) {
      for (const [identity, entry] of buckets) {
        if (entry.resetAt <= currentTime) buckets.delete(identity);
      }
    }

    return next();
  };
}
