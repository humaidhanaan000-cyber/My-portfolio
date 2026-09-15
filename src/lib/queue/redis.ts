/**
 * Optional Redis connection used for fast cross-process job dispatch and
 * distributed locks. The database remains the source of truth for job state;
 * Redis only shortens latency between "job enqueued" and "worker wakes up".
 * When REDIS_URL=memory the platform runs in single-process mode with no
 * external dependency — still fully functional, just not horizontally scaled.
 */
import type { Redis } from 'ioredis'
import { env } from '../env'
import { logger } from '../observability/logger'

let client: Redis | null = null
let subscriber: Redis | null = null
let available = false

export function redisEnabled(): boolean {
  return env.REDIS_URL !== 'memory' && env.REDIS_URL !== ''
}

async function createClient(role: 'client' | 'subscriber'): Promise<Redis | null> {
  if (!redisEnabled()) return null
  try {
    const { default: RedisClient } = await import('ioredis')
    const instance = new RedisClient(env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: false,
      retryStrategy: (times) => Math.min(times * 200, 5000),
      connectionName: `aiba-${role}`,
    })
    instance.on('error', (error: Error) => {
      logger.warn('redis connection error', { role, message: error.message })
      available = false
    })
    instance.on('ready', () => {
      available = true
      logger.info('redis connected', { role })
    })
    return instance
  } catch (error) {
    logger.warn('redis unavailable, continuing without it', {
      message: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

export async function getRedis(): Promise<Redis | null> {
  if (!redisEnabled()) return null
  client ??= await createClient('client')
  return client
}

export async function getRedisSubscriber(): Promise<Redis | null> {
  if (!redisEnabled()) return null
  subscriber ??= await createClient('subscriber')
  return subscriber
}

export function key(...parts: string[]): string {
  return [env.QUEUE_PREFIX, ...parts].join(':')
}

/** Best-effort publish; never throws into the request path. */
export async function publish(channel: string, message: string): Promise<void> {
  const redis = await getRedis()
  if (!redis || !available) return
  try {
    await redis.publish(key(channel), message)
  } catch {
    /* ignored — DB polling still delivers the job */
  }
}

/**
 * Distributed mutex used by the scheduler and by cross-worker singleton jobs.
 * Returns a release function, or null when the lock is held elsewhere.
 */
export async function acquireLock(name: string, ttlMs: number): Promise<(() => Promise<void>) | null> {
  const redis = await getRedis()
  if (!redis || !available) return null
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  try {
    const result = await redis.set(key('lock', name), token, 'PX', ttlMs, 'NX')
    if (result !== 'OK') return null
    return async () => {
      try {
        const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`
        await redis.eval(script, 1, key('lock', name), token)
      } catch {
        /* lock expires on its own */
      }
    }
  } catch {
    return null
  }
}

export async function pingRedis(): Promise<{ configured: boolean; ok: boolean; latencyMs: number; error?: string }> {
  if (!redisEnabled()) return { configured: false, ok: true, latencyMs: 0 }
  const started = Date.now()
  try {
    const redis = await getRedis()
    if (!redis) return { configured: true, ok: false, latencyMs: Date.now() - started, error: 'client unavailable' }
    await redis.ping()
    return { configured: true, ok: true, latencyMs: Date.now() - started }
  } catch (error) {
    return {
      configured: true,
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function closeRedis(): Promise<void> {
  try {
    await client?.quit()
    await subscriber?.quit()
  } catch {
    /* shutdown best effort */
  }
  client = null
  subscriber = null
}
