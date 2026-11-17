// Pages Functions do not currently expose the Workers Rate Limiting binding in
// their documented binding set. This small in-isolate fallback is deliberately
// best-effort: it helps with bursts on a warm instance but is not a global,
// persistent, or strict limit. For production, add a Cloudflare WAF rate-limit
// rule for POST /api/send as described in README.md.
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 10;
const MAX_BUCKETS = 10_000;
const buckets = new Map();

export function allowRequest(ipAddress, now = Date.now()) {
  const key = typeof ipAddress === "string" && ipAddress.trim() ? ipAddress.trim() : "unknown";
  let bucket = buckets.get(key);

  if (!bucket || now - bucket.startedAt >= WINDOW_MS) {
    bucket = { startedAt: now, count: 0 };
  }

  bucket.count += 1;
  buckets.set(key, bucket);

  if (buckets.size > MAX_BUCKETS) {
    for (const [bucketKey, value] of buckets) {
      if (now - value.startedAt >= WINDOW_MS) buckets.delete(bucketKey);
    }
    while (buckets.size > MAX_BUCKETS) buckets.delete(buckets.keys().next().value);
  }

  return {
    allowed: bucket.count <= MAX_REQUESTS,
    retryAfter: Math.max(1, Math.ceil((WINDOW_MS - (now - bucket.startedAt)) / 1000)),
  };
}
