/**
 * Rate limiting.
 *
 * Uses Redis counters when Redis is configured (works across replicas) and an
 * in-process sliding window otherwise. Applied to authentication, state-changing
 * APIs and expensive agent triggers.
 */
import { getRedis, key } from '../queue/redis'
import { env } from '../env'

type Bucket = { count: number; resetAt: number }
const memory = new Map<string, Bucket>()

// Periodically drop expired in-memory buckets so a long-running process cannot leak.
setInterval(() => {
  const now = Date.now()
  for (const [bucketKey, bucket] of memory) {
    if (bucket.resetAt < now) memory.delete(bucketKey)
  }
}, 60_000).unref?.()

export type RateLimitResult = {
  allowed: boolean
  remaining: number
  limit: number
  resetAt: number
  retryAfterSeconds: number
}

export async function rateLimit(
  identifier: string,
  options: { limit?: number; windowMs?: number } = {},
): Promise<RateLimitResult> {
  const limit = options.limit ?? env.RATE_LIMIT_MAX_API
  const windowMs = options.windowMs ?? env.RATE_LIMIT_WINDOW_MS
  const now = Date.now()
  const redis = await getRedis()

  if (redis) {
    try {
      const redisKey = key('ratelimit', identifier)
      const results = await redis
        .multi()
        .incr(redisKey)
        .pttl(redisKey)
        .exec()
      const count = Number((results?.[0]?.[1] as number) ?? 1)
      let ttl = Number((results?.[1]?.[1] as number) ?? -1)
      if (ttl < 0) {
        await redis.pexpire(redisKey, windowMs)
        ttl = windowMs
      }
      const resetAt = now + ttl
      return {
        allowed: count <= limit,
        remaining: Math.max(0, limit - count),
        limit,
        resetAt,
        retryAfterSeconds: Math.ceil(ttl / 1000),
      }
    } catch {
      // fall through to the in-process limiter
    }
  }

  const existing = memory.get(identifier)
  if (!existing || existing.resetAt < now) {
    memory.set(identifier, { count: 1, resetAt: now + windowMs })
    return { allowed: true, remaining: limit - 1, limit, resetAt: now + windowMs, retryAfterSeconds: 0 }
  }
  existing.count++
  const allowed = existing.count <= limit
  return {
    allowed,
    remaining: Math.max(0, limit - existing.count),
    limit,
    resetAt: existing.resetAt,
    retryAfterSeconds: allowed ? 0 : Math.ceil((existing.resetAt - now) / 1000),
  }
}

export function clientIdentifier(headers: Headers, scope: string, extra?: string): string {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const ip = forwarded || headers.get('x-real-ip') || 'unknown'
  return [scope, extra ?? ip].join(':')
}

export function resetRateLimits(): void {
  memory.clear()
}
