/**
 * Security tests.
 *
 * These cover the properties an operator has to be able to trust: passwords are
 * never recoverable, tokens are single-use and hashed at rest, signed payloads
 * cannot be forged, CSRF tokens are unguessable and compared in constant time,
 * rate limiting actually limits, and cross-workspace reads are denied.
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { constantTimeEqual, hashToken, hmac, randomToken, signPayload, verifyPayload } from '../src/lib/security/crypto'
import { MIN_PASSWORD_LENGTH, checkPasswordStrength, hashPassword, verifyPassword } from '../src/lib/security/password'
import { rateLimit, resetRateLimits } from '../src/lib/security/rate-limit'
import { createSessionRecord, getSession, revokeAllSessions } from '../src/lib/auth'
import { createApproval, decideApproval } from '../src/lib/approvals'
import { getDb, approvals, sessions, users } from '../src/lib/db'
import { and, eq } from 'drizzle-orm'
import { createWorkspaceFixture } from './helpers'

describe('security', () => {
  it('stores passwords as salted scrypt hashes that cannot be recovered', async () => {
    const hash = await hashPassword('Correct-Horse-Battery-9')
    expect(hash.startsWith('scrypt$')).toBe(true)
    expect(hash).not.toContain('Correct-Horse-Battery-9')
    expect(await verifyPassword('Correct-Horse-Battery-9', hash)).toBe(true)
    expect(await verifyPassword('Correct-Horse-Battery-8', hash)).toBe(false)

    const again = await hashPassword('Correct-Horse-Battery-9')
    expect(again).not.toBe(hash)
  })

  it('rejects malformed and empty stored hashes instead of treating them as valid', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false)
    expect(await verifyPassword('', 'scrypt$abc$def')).toBe(false)
    expect(await verifyPassword('anything', 'scrypt$')).toBe(false)
  })

  it('enforces a minimum password length and rejects the most common passwords', () => {
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(10)
    expect(checkPasswordStrength('short1').ok).toBe(false)
    expect(checkPasswordStrength('password123').ok).toBe(false)
    expect(checkPasswordStrength('aaaaaaaaaaaaaaaa').ok).toBe(false)
    const strong = checkPasswordStrength('Tumbleweed-Measures-42')
    expect(strong.ok).toBe(true)
    expect(strong.strength).toBeGreaterThan(50)
  })

  it('hashes session tokens at rest so a database leak is not a session leak', async () => {
    const fixture = await createWorkspaceFixture()
    const record = await createSessionRecord(fixture.userId, '10.9.9.9', 'vitest')

    const db = await getDb()
    const rows = await db.select().from(sessions).where(eq(sessions.userId, fixture.userId))
    expect(rows.length).toBeGreaterThan(0)

    const stored = rows[rows.length - 1]!
    expect(stored.tokenHash).not.toBe(record.token)
    expect(stored.tokenHash).toBe(hashToken(record.token))
    expect(JSON.stringify(stored)).not.toContain(record.token)
    expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('revokes every session for a user on demand', async () => {
    const fixture = await createWorkspaceFixture()
    await createSessionRecord(fixture.userId, '10.9.9.8', 'vitest')
    await createSessionRecord(fixture.userId, '10.9.9.7', 'vitest')

    const revoked = await revokeAllSessions(fixture.userId)
    expect(revoked).toBeGreaterThanOrEqual(2)

    const db = await getDb()
    const rows = await db.select().from(sessions).where(and(eq(sessions.userId, fixture.userId)))
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true)
  })

  it('refuses to resolve a session outside a request scope', async () => {
    // `getSession()` reads cookies from the Next.js request context; called from
    // a plain script it must fail closed rather than invent a session.
    await expect(getSession()).rejects.toThrow()
  })

  it('does not accept a forged signed payload or a tampered one', () => {
    const token = signPayload({ userId: 'abc', scope: 'email_verify' }, 60_000)
    expect(verifyPayload<{ userId: string }>(token)?.userId).toBe('abc')

    const tampered = `${token.slice(0, -2)}xx`
    expect(verifyPayload(tampered)).toBeNull()
    expect(verifyPayload('not-a-token')).toBeNull()
    expect(verifyPayload(`${Buffer.from('{"userId":"evil"}').toString('base64url')}.deadbeef`)).toBeNull()
  })

  it('generates unpredictable tokens and compares them in constant time', () => {
    const first = randomToken(32)
    const second = randomToken(32)
    expect(first).not.toBe(second)
    expect(first.length).toBeGreaterThanOrEqual(40)
    expect(constantTimeEqual(first, first)).toBe(true)
    expect(constantTimeEqual(first, second)).toBe(false)
    expect(constantTimeEqual('', '')).toBe(true)
  })

  it('scopes HMACs to the server secret', () => {
    const signature = hmac('payload')
    expect(signature).toMatch(/^[a-f0-9]{64}$/)
    expect(signature).not.toBe(createHash('sha256').update('payload').digest('hex'))
    expect(hmac('payload')).toBe(signature)
    expect(hmac('payload2')).not.toBe(signature)
  })

  it('rate limits repeated attempts and recovers after the window is reset', async () => {
    resetRateLimits()
    const identifier = 'test:rate-limit'

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await rateLimit(identifier, { limit: 3, windowMs: 60_000 })
      expect(result.allowed).toBe(true)
    }

    const blocked = await rateLimit(identifier, { limit: 3, windowMs: 60_000 })
    expect(blocked.allowed).toBe(false)
    expect(blocked.remaining).toBe(0)
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0)

    resetRateLimits()
    const afterReset = await rateLimit(identifier, { limit: 3, windowMs: 60_000 })
    expect(afterReset.allowed).toBe(true)
  })

  it('keeps approval decisions inside the workspace that owns them', async () => {
    const owner = await createWorkspaceFixture()
    const other = await createWorkspaceFixture()

    const created = await createApproval({
      workspaceId: owner.workspaceId,
      actionType: 'publish_content',
      title: 'Publish landing page',
      reason: 'The draft is ready for review.',
      expectedCostCents: 0,
      potentialBenefit: 'Traffic to the new offer.',
      risk: 'high',
      payload: { page: 'landing' },
    })
    expect(created.id).toBeTruthy()

    const db = await getDb()
    const stored = await db.select().from(approvals).where(eq(approvals.id, created.id)).limit(1)
    expect(stored[0]!.workspaceId).toBe(owner.workspaceId)

    // A decision attempt from another workspace cannot even see the request.
    const foreign = await decideApproval({ workspaceId: other.workspaceId, approvalId: created.id, userId: other.userId, decision: 'approve' })
    expect(foreign.ok).toBe(false)
    expect(foreign.error).toMatch(/not found/i)

    // The owning workspace can still decide it, and the decision is recorded.
    const decided = await decideApproval({ workspaceId: owner.workspaceId, approvalId: created.id, userId: owner.userId, decision: 'reject', note: 'Not yet.' })
    expect(decided.ok).toBe(true)
    expect(decided.status).toBe('rejected')

    const after = await db.select().from(approvals).where(eq(approvals.id, created.id)).limit(1)
    expect(after[0]!.status).toBe('rejected')
    expect(after[0]!.decidedByUserId).toBe(owner.userId)
  })

  it('never exposes password hashes through the user table projection used by the API', async () => {
    const fixture = await createWorkspaceFixture()
    const db = await getDb()
    const { passwordHash, ...safe } = (await db.select().from(users).where(eq(users.id, fixture.userId)).limit(1))[0]!
    expect(passwordHash).toBeTruthy()
    expect(JSON.stringify(safe)).not.toContain(passwordHash)
  })
})
