/**
 * Database and authentication tests.
 *
 * Covers real registration, session resolution, lockout, password reset and
 * email verification against the migrated schema — no mocked persistence.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  authenticate,
  changePassword,
  createAuthToken,
  createSessionRecord,
  registerUser,
  requestPasswordReset,
  resetPassword,
  verifyEmailToken,
} from '../src/lib/auth'
import { getDb, authTokens, memberships, users } from '../src/lib/db'
import { checkPasswordStrength } from '../src/lib/security/password'
import { resetRateLimits } from '../src/lib/security/rate-limit'

let seq = 0
function nextEmail(label: string) {
  seq += 1
  return `${label}-${Date.now()}-${seq}@example.test`
}
function nextIp() {
  seq += 1
  return `10.${(seq % 200) + 1}.${(seq % 250) + 1}.${(seq % 250) + 2}`
}

async function userByEmail(email: string) {
  const db = await getDb()
  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1)
  return rows[0]
}

beforeEach(() => {
  // The rate limiter is deliberately aggressive; clear the in-process window so
  // each test starts from a clean slate (the limiter itself is tested in the
  // security suite).
  resetRateLimits()
})

describe('database & auth', () => {
  it('registers a user, hashes the password and provisions a workspace', async () => {
    const email = nextEmail('register')
    const result = await registerUser({ email, password: 'Fixture-password-1', name: 'Fixture Operator', ip: nextIp() })

    expect(result.workspaceId).toBeTruthy()

    const row = await userByEmail(email)
    expect(row).toBeDefined()
    expect(row!.passwordHash).not.toContain('Fixture-password-1')
    expect(row!.passwordHash.startsWith('scrypt$')).toBe(true)

    const db = await getDb()
    const membership = await db.select().from(memberships).where(eq(memberships.userId, result.userId)).limit(1)
    expect(membership[0]!.workspaceId).toBe(result.workspaceId)
    expect(membership[0]!.role).toBe('owner')
  })

  it('rejects weak passwords with actionable reasons', async () => {
    await expect(registerUser({ email: nextEmail('weak'), password: 'short', name: 'Weak', ip: nextIp() })).rejects.toThrow(/too weak/i)
    const strength = checkPasswordStrength('alllowercaseletters')
    expect(strength.ok).toBe(false)
    expect(strength.problems.length).toBeGreaterThan(0)
  })

  it('refuses to register an email that already exists', async () => {
    const email = nextEmail('duplicate')
    await registerUser({ email, password: 'Fixture-password-2', name: 'First', ip: nextIp() })
    await expect(registerUser({ email, password: 'Fixture-password-2', name: 'Second', ip: nextIp() })).rejects.toThrow(/already exists/i)
  })

  it('authenticates with the correct password and rejects the wrong one', async () => {
    const email = nextEmail('auth')
    const created = await registerUser({ email, password: 'Fixture-password-3', name: 'Auth', ip: nextIp() })

    const user = await authenticate({ email, password: 'Fixture-password-3', ip: nextIp() }, { setCookies: false })
    expect(user.id).toBe(created.userId)
    expect(user.workspaceId).toBe(created.workspaceId)
    expect(user.role).toBeTruthy()

    await expect(authenticate({ email, password: 'Fixture-password-3-wrong', ip: nextIp() }, { setCookies: false })).rejects.toThrow(/incorrect/i)
  })

  it('records failed attempts and locks the account after repeated failures', async () => {
    const email = nextEmail('lockout')
    const created = await registerUser({ email, password: 'Fixture-password-4', name: 'Lockout', ip: nextIp() })

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await authenticate({ email, password: 'definitely-wrong-password', ip: nextIp() }, { setCookies: false }).catch(() => undefined)
    }

    const row = await userByEmail(email)
    expect(row!.failedLoginCount).toBeGreaterThanOrEqual(8)
    expect(row!.lockedUntil).not.toBeNull()

    await expect(authenticate({ email, password: 'Fixture-password-4', ip: nextIp() }, { setCookies: false })).rejects.toThrow(/locked/i)

    // Clearing the lock proves the stored hash was never damaged by failures.
    const db = await getDb()
    await db.update(users).set({ lockedUntil: null }).where(eq(users.id, created.userId))
    const unlocked = await authenticate({ email, password: 'Fixture-password-4', ip: nextIp() }, { setCookies: false })
    expect(unlocked.id).toBe(created.userId)
  })

  it('issues single-use tokens for email verification and password reset', async () => {
    const email = nextEmail('tokens')
    const created = await registerUser({ email, password: 'Fixture-password-5', name: 'Tokens', ip: nextIp() })

    const verifyToken = await createAuthToken(created.userId, 'email_verify')
    expect(await verifyEmailToken(verifyToken)).toBe(true)
    expect(await verifyEmailToken(verifyToken)).toBe(false)

    const resetToken = await createAuthToken(created.userId, 'password_reset')
    expect(await resetPassword(resetToken, 'Rewritten-password-5')).toBe(true)
    expect(await resetPassword(resetToken, 'Rewritten-password-5-again')).toBe(false)

    const db = await getDb()
    const stored = await db.select().from(authTokens).where(eq(authTokens.userId, created.userId))
    expect(stored.length).toBeGreaterThanOrEqual(2)
    // Tokens are stored hashed, never in plain text, and marked as consumed.
    expect(stored.every((row) => row.usedAt !== null)).toBe(true)
    // Only a salted hash of each token is persisted — never the raw value.
    expect(stored.some((row) => row.tokenHash === verifyToken || row.tokenHash === resetToken)).toBe(false)
  })

  it('resets a password and blocks the previous password afterwards', async () => {
    const email = nextEmail('reset')
    const created = await registerUser({ email, password: 'Fixture-password-6', name: 'Reset', ip: nextIp() })

    await requestPasswordReset(email, nextIp())
    const token = await createAuthToken(created.userId, 'password_reset')
    expect(await resetPassword(token, 'Brand-new-password-6')).toBe(true)

    await expect(authenticate({ email, password: 'Fixture-password-6', ip: nextIp() }, { setCookies: false })).rejects.toThrow(/incorrect/i)
    const after = await authenticate({ email, password: 'Brand-new-password-6', ip: nextIp() }, { setCookies: false })
    expect(after.id).toBe(created.userId)
  })

  it('does not disclose whether an account exists when a reset is requested', async () => {
    await expect(requestPasswordReset(nextEmail('missing'), nextIp())).resolves.toBeUndefined()
  })

  it('changes a password only when the current one is supplied, and issues a session', async () => {
    const email = nextEmail('change')
    const created = await registerUser({ email, password: 'Fixture-password-7', name: 'Change', ip: nextIp() })

    expect(await changePassword(created.userId, 'not-the-password', 'New-password-7-abc')).toBe(false)
    expect(await changePassword(created.userId, 'Fixture-password-7', 'New-password-7-abc')).toBe(true)

    const session = await createSessionRecord(created.userId, nextIp(), 'vitest')
    expect(session.user.workspaceId).toBe(created.workspaceId)
    expect(session.token).toBeTruthy()
    expect(session.csrfToken).toBeTruthy()
    expect(session.token).not.toBe(session.csrfToken)
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })
})
