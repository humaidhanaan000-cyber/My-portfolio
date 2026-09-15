/**
 * Token generation, API-key hashing and signed-payload helpers.
 * Nothing here is reversible: all stored secrets are one-way hashes.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { env } from '../env'

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(`${token}:${env.AUTH_SECRET}`).digest('hex')
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export function hmac(payload: string, secret = env.AUTH_SECRET): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

export function signPayload(payload: unknown, ttlMs = 3600_000): string {
  const body = { data: payload, exp: Date.now() + ttlMs, nonce: randomBytes(8).toString('hex') }
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url')
  return `${encoded}.${hmac(encoded)}`
}

export function verifyPayload<T>(token: string): T | null {
  const [encoded, signature] = token.split('.')
  if (!encoded || !signature) return null
  if (!constantTimeEqual(hmac(encoded), signature)) return null
  try {
    const body = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { data: T; exp: number }
    if (body.exp < Date.now()) return null
    return body.data
  } catch {
    return null
  }
}

/** Session cookie name — `__Host-` prefix in production for cookie-tossing protection. */
export const SESSION_COOKIE = env.COOKIE_SECURE ? '__Host-aiba_session' : 'aiba_session'
export const CSRF_COOKIE = env.COOKIE_SECURE ? '__Host-aiba_csrf' : 'aiba_csrf'
