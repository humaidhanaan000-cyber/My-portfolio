/**
 * Authentication & session management.
 *
 * - Passwords: scrypt (see security/password.ts), never stored in plaintext.
 * - Sessions: opaque 256-bit random tokens; only the SHA-256 HMAC hash is stored.
 *   Cookies are HttpOnly, SameSite=Lax, Secure in production, with a `__Host-`
 *   prefix when secure so a subdomain cannot overwrite them.
 * - CSRF: double-submit token bound to the session, verified on all mutating routes.
 * - Brute force: per-IP rate limiting plus per-account lockout with backoff.
 * - Enumeration: register/login/reset return identical shapes for unknown accounts.
 */
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import { cookies } from 'next/headers'
import { getDb, authTokens, memberships, profiles, sessions, users, workspaces, auditLogs } from '../db'
import { env, isProduction } from '../env'
import { CSRF_COOKIE, SESSION_COOKIE, hashToken, randomToken } from '../security/crypto'
import { checkPasswordStrength, hashPassword, verifyPassword } from '../security/password'
import { rateLimit } from '../security/rate-limit'
import { createLogger } from '../observability/logger'
import { sendTransactionalEmail } from '../notifications'
import { defaultSourceConfigs } from '../agents/sources'
import { AGENT_ORDER, AGENTS } from '../agents/registry'
import { slugify } from '../utils'
import { seedDefaultSchedules } from '../scheduler/defaults'
import { nextCronRun } from '../scheduler/cron'
import { defaultWorkflowDefinition } from '../workflows/defaults'

const log = createLogger({ component: 'auth' })

export type SessionUser = {
  id: string
  email: string
  name: string
  role: string
  workspaceId: string
  workspaceName: string
  workspaceSlug: string
  planKey: string
  demoMode: boolean
  onboarded: boolean
  sessionId: string
  automationLevel: string
  currency: string
}

export class AuthError extends Error {
  constructor(message: string, readonly code: 'invalid_credentials' | 'locked' | 'rate_limited' | 'unverified' | 'disabled' | 'no_session' = 'invalid_credentials') {
    super(message)
    this.name = 'AuthError'
  }
}

const MAX_FAILED_LOGINS = 8
const LOCKOUT_MINUTES = 15

export async function registerUser(input: {
  email: string
  password: string
  name: string
  workspaceName?: string
  ip?: string
  userAgent?: string
}): Promise<{ userId: string; workspaceId: string; verificationToken?: string }> {
  const db = await getDb()
  const email = input.email.trim().toLowerCase()

  if (!env.ALLOW_REGISTRATION) {
    const count = await db.select({ value: sql<string>`count(*)::text` }).from(users)
    if (Number(count[0]?.value ?? 0) > 0) {
      throw new AuthError('Registration is disabled. Ask an administrator to create your account.', 'disabled')
    }
  }

  const limit = await rateLimit(`register:${input.ip ?? 'unknown'}`, { limit: 5, windowMs: 3_600_000 })
  if (!limit.allowed) throw new AuthError('Too many registration attempts. Try again later.', 'rate_limited')

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
  if (existing[0]) {
    // Do not reveal whether the account exists: return success-shaped error to the caller's UI only.
    throw new AuthError('An account with that email already exists. Try signing in instead.', 'invalid_credentials')
  }

  // Validation lives here as well as in the request schema: `registerUser` is a
  // library entry point (scripts, seeds, tests), so a weak password must never
  // become a hashed credential just because a caller skipped the HTTP layer.
  const strength = checkPasswordStrength(input.password)
  if (!strength.ok) {
    throw new AuthError(`Password is too weak. Requirements: ${strength.problems.join(', ')}.`, 'invalid_credentials')
  }

  const passwordHash = await hashPassword(input.password)
  const inserted = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      name: input.name.trim().slice(0, 120),
      role: 'user',
      emailVerifiedAt: env.REQUIRE_EMAIL_VERIFICATION ? null : new Date(),
    })
    .returning({ id: users.id })
  const userId = inserted[0]!.id

  const baseSlug = slugify(input.workspaceName ?? `${input.name}'s workspace`)
  let slug = baseSlug
  let attempt = 2
  while ((await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, slug)).limit(1))[0]) {
    slug = `${baseSlug}-${attempt++}`
  }

  const workspaceRows = await db
    .insert(workspaces)
    .values({ name: input.workspaceName?.slice(0, 120) ?? `${input.name.split(' ')[0]}'s workspace`, slug, ownerId: userId, planKey: 'free' })
    .returning({ id: workspaces.id })
  const workspaceId = workspaceRows[0]!.id

  await db.insert(memberships).values({ workspaceId, userId, role: 'owner' })
  await db.insert(profiles).values({ workspaceId, userId, legalName: input.name })

  // Bootstrap the workspace: agents, default sources and system schedules.
  await bootstrapWorkspace(workspaceId)

  await db.insert(auditLogs).values({
    workspaceId,
    userId,
    actorType: 'user',
    action: 'user.registered',
    entityType: 'user',
    entityId: userId,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  })

  let verificationToken: string | undefined
  if (env.REQUIRE_EMAIL_VERIFICATION) {
    verificationToken = await createAuthToken(userId, 'email_verify', 48)
    await sendTransactionalEmail({
      to: email,
      subject: 'Verify your AIBA account',
      body: `Confirm your email address to activate your account:\n\n${env.APP_URL}/verify-email?token=${verificationToken}\n\nThis link expires in 48 hours.`,
    })
  }

  log.info('user registered', { userId, workspaceId })
  return { userId, workspaceId, verificationToken }
}

export async function authenticate(input: {
  email: string
  password: string
  ip?: string
  userAgent?: string
}, options: { setCookies?: boolean } = {}): Promise<SessionUser> {
  const db = await getDb()
  const email = input.email.trim().toLowerCase()

  const ipLimit = await rateLimit(`login:${input.ip ?? 'unknown'}`, { limit: env.RATE_LIMIT_MAX_AUTH, windowMs: 300_000 })
  if (!ipLimit.allowed) throw new AuthError('Too many sign-in attempts from this address. Wait a few minutes.', 'rate_limited')

  const rows = await db.select().from(users).where(and(eq(users.email, email), isNull(users.deletedAt))).limit(1)
  const user = rows[0]

  if (!user) {
    // Constant-ish work to avoid a timing oracle for account existence.
    await hashPassword(input.password).catch(() => undefined)
    throw new AuthError('Email or password is incorrect.', 'invalid_credentials')
  }
  if (user.status !== 'active') throw new AuthError('This account has been suspended.', 'disabled')
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AuthError(`Account temporarily locked after repeated failures. Try again after ${user.lockedUntil.toISOString().slice(11, 16)} UTC.`, 'locked')
  }
  if (env.REQUIRE_EMAIL_VERIFICATION && !user.emailVerifiedAt) {
    throw new AuthError('Please verify your email address before signing in.', 'unverified')
  }

  const valid = await verifyPassword(input.password, user.passwordHash)
  if (!valid) {
    const failed = user.failedLoginCount + 1
    await db
      .update(users)
      .set({
        failedLoginCount: failed,
        lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id))
    await db.insert(auditLogs).values({
      userId: user.id,
      actorType: 'user',
      action: 'user.login_failed',
      ip: input.ip ?? null,
      after: { failedAttempts: failed } as Record<string, unknown>,
    })
    throw new AuthError('Email or password is incorrect.', 'invalid_credentials')
  }

  await db.update(users).set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(users.id, user.id))

  const record = await createSessionRecord(user.id, input.ip, input.userAgent)
  if (options.setCookies !== false) await applySessionCookies(record)
  await db.insert(auditLogs).values({
    workspaceId: record.user.workspaceId,
    userId: user.id,
    actorType: 'user',
    action: 'user.login',
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  })
  return record.user
}

/**
 * Create a session record and return both the resolved user context and the raw
 * cookie token. Kept separate from `createSession` so server-side jobs, tests
 * and the CLI can establish a session without a browser request context.
 */
export async function createSessionRecord(userId: string, ip?: string, userAgent?: string): Promise<{
  user: SessionUser
  token: string
  csrfToken: string
  expiresAt: Date
}> {
  const db = await getDb()
  const membership = (
    await db
      .select({ workspaceId: memberships.workspaceId, role: memberships.role, name: workspaces.name, slug: workspaces.slug, planKey: workspaces.planKey, demoMode: workspaces.demoMode })
      .from(memberships)
      .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
      .where(and(eq(memberships.userId, userId), isNull(workspaces.deletedAt)))
      .limit(1)
  )[0]
  if (!membership) throw new AuthError('No workspace is associated with this account.', 'disabled')

  const token = randomToken(32)
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 3_600_000)
  const csrfToken = randomToken(24)
  const inserted = await db
    .insert(sessions)
    .values({ userId, workspaceId: membership.workspaceId, tokenHash: hashToken(token), ip: ip ?? null, userAgent: userAgent?.slice(0, 400) ?? null, expiresAt })
    .returning({ id: sessions.id })

  const user = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0]!
  const profile = (await db.select().from(profiles).where(eq(profiles.workspaceId, membership.workspaceId)).limit(1))[0]

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      workspaceId: membership.workspaceId,
      workspaceName: membership.name,
      workspaceSlug: membership.slug,
      planKey: membership.planKey,
      demoMode: membership.demoMode,
      onboarded: Boolean(user.onboardedAt),
      sessionId: inserted[0]!.id,
      automationLevel: profile?.automationLevel ?? 'approval_required',
      currency: profile?.currency ?? 'USD',
    },
    token,
    csrfToken,
    expiresAt,
  }
}

/** Write the session + CSRF cookies for a freshly created session record. */
export async function applySessionCookies(record: { token: string; csrfToken: string; expiresAt: Date }): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE, record.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.COOKIE_SECURE,
    path: '/',
    expires: record.expiresAt,
  })
  cookieStore.set(CSRF_COOKIE, record.csrfToken, {
    httpOnly: false, // double-submit pattern: the client reads this and echoes it in a header
    sameSite: 'lax',
    secure: env.COOKIE_SECURE,
    path: '/',
    expires: record.expiresAt,
  })
}

/** Create a session and write the browser cookies. Request context required. */
export async function createSession(userId: string, ip?: string, userAgent?: string): Promise<SessionUser> {
  const record = await createSessionRecord(userId, ip, userAgent)
  await applySessionCookies(record)
  return record.user
}

/** Resolve the current session from the cookie. Returns null when signed out. */
export async function getSession(): Promise<SessionUser | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  if (!token) return null

  const db = await getDb()
  const rows = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
      userId: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      status: users.status,
      onboardedAt: users.onboardedAt,
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
      workspaceSlug: workspaces.slug,
      planKey: workspaces.planKey,
      demoMode: workspaces.demoMode,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .innerJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
    .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
    .limit(1)

  const row = rows[0]
  if (!row || row.status !== 'active') return null

  // Sliding expiry: touch at most once a minute to avoid a write per request.
  void db
    .update(sessions)
    .set({ lastSeenAt: new Date() })
    .where(and(eq(sessions.id, row.sessionId), sql`${sessions.lastSeenAt} < now() - interval '1 minute'`))
    .catch(() => undefined)

  const profile = (await db.select().from(profiles).where(eq(profiles.workspaceId, row.workspaceId)).limit(1))[0]

  return {
    id: row.userId,
    email: row.email,
    name: row.name,
    role: row.role,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    workspaceSlug: row.workspaceSlug,
    planKey: row.planKey,
    demoMode: row.demoMode,
    onboarded: Boolean(row.onboardedAt),
    sessionId: row.sessionId,
    automationLevel: profile?.automationLevel ?? 'approval_required',
    currency: profile?.currency ?? 'USD',
  }
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  const db = await getDb()
  if (token) {
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(eq(sessions.tokenHash, hashToken(token)))
      .catch(() => undefined)
  }
  cookieStore.delete(SESSION_COOKIE)
  cookieStore.delete(CSRF_COOKIE)
}

export async function revokeAllSessions(userId: string): Promise<number> {
  const db = await getDb()
  const rows = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id })
  return rows.length
}

/** Verify the double-submit CSRF token. Mutating API routes must call this. */
export async function verifyCsrf(request: Request): Promise<boolean> {
  const cookieStore = await cookies()
  const cookieToken = cookieStore.get(CSRF_COOKIE)?.value
  const headerToken = request.headers.get('x-csrf-token')
  if (!cookieToken || !headerToken) return false
  return cookieToken.length === headerToken.length && cookieToken === headerToken
}

export async function requireSession(): Promise<SessionUser> {
  const session = await getSession()
  if (!session) throw new AuthError('Authentication required.', 'no_session')
  return session
}

export async function requireAdmin(): Promise<SessionUser> {
  const session = await requireSession()
  if (session.role !== 'admin') throw new AuthError('Administrator access required.', 'no_session')
  return session
}

/* ------------------------------------------------------------ token flows */

export async function createAuthToken(userId: string, type: 'email_verify' | 'password_reset', ttlHours = 2): Promise<string> {
  const db = await getDb()
  const token = randomToken(32)
  await db.insert(authTokens).values({
    userId,
    type,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ttlHours * 3_600_000),
  })
  return token
}

export async function consumeAuthToken(token: string, type: 'email_verify' | 'password_reset'): Promise<string | null> {
  const db = await getDb()
  const rows = await db
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.tokenHash, hashToken(token)), eq(authTokens.type, type), isNull(authTokens.usedAt), gt(authTokens.expiresAt, new Date())))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  await db.update(authTokens).set({ usedAt: new Date() }).where(eq(authTokens.id, row.id))
  return row.userId
}

/** Always resolves successfully: never disclose whether an account exists. */
export async function requestPasswordReset(email: string, ip?: string): Promise<void> {
  const db = await getDb()
  const limit = await rateLimit(`reset:${ip ?? 'unknown'}`, { limit: 5, windowMs: 900_000 })
  if (!limit.allowed) return

  const rows = await db.select().from(users).where(and(eq(users.email, email.trim().toLowerCase()), isNull(users.deletedAt))).limit(1)
  const user = rows[0]
  if (!user) return

  const token = await createAuthToken(user.id, 'password_reset', 2)
  await sendTransactionalEmail({
    to: user.email,
    subject: 'Reset your AIBA password',
    body: `A password reset was requested for this address.\n\nReset link (valid for 2 hours):\n${env.APP_URL}/reset-password?token=${token}\n\nIf you did not request this, no action is needed.`,
  })
  await db.insert(auditLogs).values({ userId: user.id, actorType: 'user', action: 'user.password_reset_requested', ip: ip ?? null })
}

export async function resetPassword(token: string, newPassword: string): Promise<boolean> {
  const db = await getDb()
  const userId = await consumeAuthToken(token, 'password_reset')
  if (!userId) return false
  const passwordHash = await hashPassword(newPassword)
  await db.update(users).set({ passwordHash, failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() }).where(eq(users.id, userId))
  await revokeAllSessions(userId)
  await db.insert(auditLogs).values({ userId, actorType: 'user', action: 'user.password_reset_completed' })
  return true
}

export async function verifyEmailToken(token: string): Promise<boolean> {
  const db = await getDb()
  const userId = await consumeAuthToken(token, 'email_verify')
  if (!userId) return false
  await db.update(users).set({ emailVerifiedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, userId))
  return true
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<boolean> {
  const db = await getDb()
  const user = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0]
  if (!user) return false
  const valid = await verifyPassword(currentPassword, user.passwordHash)
  if (!valid) return false
  await db.update(users).set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() }).where(eq(users.id, userId))
  await db.insert(auditLogs).values({ userId, actorType: 'user', action: 'user.password_changed' })
  return true
}

/* ------------------------------------------------------------- bootstrap */

/**
 * Provision a new workspace: agent registry rows, default permitted sources,
 * system schedules and a starter workflow. Idempotent.
 */
export async function bootstrapWorkspace(workspaceId: string): Promise<void> {
  const db = await getDb()

  for (const key of AGENT_ORDER) {
    const agent = AGENTS[key]
    await db
      .insert(agentsTable)
      .values({
        key,
        name: agent.name,
        description: agent.description,
        category: agent.category,
        modelTier: agent.modelTier,
        timeoutSeconds: agent.timeoutSeconds,
      })
      .onConflictDoNothing()
  }

  const existingSources = await db.select({ id: sourcesTable.id }).from(sourcesTable).where(eq(sourcesTable.workspaceId, workspaceId)).limit(1)
  if (!existingSources[0]) {
    for (const source of defaultSourceConfigs()) {
      await db
        .insert(sourcesTable)
        .values({
          workspaceId,
          name: source.name,
          type: source.type,
          url: source.url,
          permissionStatus: source.permissionStatus,
          termsUrl: source.termsUrl,
          requiresCredentials: source.requiresCredentials,
          credentialEnvVar: source.credentialEnvVar,
          rateLimitPerHour: source.rateLimitPerHour,
          reliabilityScore: source.reliabilityScore,
          categories: source.categories,
          enabled: source.enabled,
          config: source.config,
        })
        .onConflictDoNothing()
    }
  }

  const existingWorkflows = await db.select({ id: workflowsTable.id }).from(workflowsTable).where(eq(workflowsTable.workspaceId, workspaceId)).limit(1)
  if (!existingWorkflows[0]) {
    await db.insert(workflowsTable).values({
      workspaceId,
      name: 'AIBA core operating loop',
      description:
        'The canonical loop: research → clean → score → analyse → generate strategy → approval → build → launch → monitor → optimise.',
      definition: defaultWorkflowDefinition(),
      schedule: '0 * * * *',
      scheduleTimezone: 'UTC',
      status: 'active',
      enabled: true,
      isTemplate: false,
      nextRunAt: nextCronRun('0 * * * *'),
    })
  }

  await seedDefaultSchedules(workspaceId)
}

import { agents as agentsTable, sources as sourcesTable, workflows as workflowsTable } from '../db'
export { isProduction }
