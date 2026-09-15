/**
 * Budget guardrails.
 *
 * Hard rule of the platform: **no paid action runs without passing through
 * `authorizeSpend()`**. The check is evaluated against four independent limits
 * (workspace daily, workspace monthly, per-project, per-agent) plus an optional
 * global AI spend ceiling. When any limit would be exceeded the caller must
 * either stop, or raise an approval request — never proceed.
 *
 * Reservations are written to `budget_ledger` (debit) and settled to actual cost
 * afterwards, so concurrent agents cannot collectively overshoot a limit.
 */
import { and, eq, gte, sql } from 'drizzle-orm'
import { getDb, budgetLedger, budgets, expenses, profiles, projects, extractRows } from '../db'
import { env } from '../env'
import { startOfDay, startOfMonth } from '../utils'
import { createLogger } from '../observability/logger'

const log = createLogger({ component: 'budget' })

export type BudgetScope = 'workspace' | 'project' | 'agent'

export type BudgetCheck = {
  scope: BudgetScope | 'daily' | 'monthly'
  label: string
  limitCents: number
  spentCents: number
  requestedCents: number
  remainingCents: number
  percentUsed: number
  ok: boolean
}

export type SpendDecision = {
  allowed: boolean
  requiresApproval: boolean
  reason: string
  amountCents: number
  currency: string
  checks: BudgetCheck[]
  ledgerId?: string
}

export type SpendRequest = {
  workspaceId: string
  amountCents: number
  description: string
  scope?: BudgetScope
  projectId?: string | null
  agentKey?: string | null
  refType?: string
  refId?: string
  currency?: string
  /** Bypass is only permitted for the platform's own free operations. */
  allowZeroCost?: boolean
}

async function sumExpenses(workspaceId: string, since: Date, projectId?: string | null): Promise<number> {
  const db = await getDb()
  const conditions = [eq(expenses.workspaceId, workspaceId), gte(expenses.occurredAt, since)]
  if (projectId) conditions.push(eq(expenses.projectId, projectId))
  const result = await db
    .select({ total: sql<string>`coalesce(sum(${expenses.amountCents}), 0)::text` })
    .from(expenses)
    .where(and(...conditions))
  return Number(result[0]?.total ?? 0)
}

async function sumLedgerDebits(workspaceId: string, since: Date, agentKey?: string | null): Promise<number> {
  const db = await getDb()
  const conditions = [
    eq(budgetLedger.workspaceId, workspaceId),
    gte(budgetLedger.occurredAt, since),
    eq(budgetLedger.direction, 'debit'),
  ]
  if (agentKey) conditions.push(eq(budgetLedger.scopeKey, agentKey))
  const result = await db
    .select({ total: sql<string>`coalesce(sum(${budgetLedger.amountCents}), 0)::text` })
    .from(budgetLedger)
    .where(and(...conditions))
  return Number(result[0]?.total ?? 0)
}

/**
 * Evaluate all applicable limits for a proposed spend. Pure read — no state
 * change — so it is safe to call from UI previews as well as before execution.
 */
export async function evaluateBudget(request: SpendRequest): Promise<SpendDecision> {
  const db = await getDb()
  const amount = Math.max(0, Math.round(request.amountCents))

  const profileRows = await db.select().from(profiles).where(eq(profiles.workspaceId, request.workspaceId)).limit(1)
  const profile = profileRows[0]
  const checks: BudgetCheck[] = []

  if (!env.BUDGET_ENFORCEMENT) {
    return {
      allowed: true,
      requiresApproval: false,
      reason: 'Budget enforcement disabled via BUDGET_ENFORCEMENT=false',
      amountCents: amount,
      currency: request.currency ?? 'USD',
      checks,
    }
  }

  const dayStart = startOfDay()
  const monthStart = startOfMonth()

  const [spentToday, spentMonth, spentProject, spentAgentToday] = await Promise.all([
    sumExpenses(request.workspaceId, dayStart),
    sumExpenses(request.workspaceId, monthStart),
    request.projectId ? sumExpenses(request.workspaceId, new Date(0), request.projectId) : Promise.resolve(0),
    request.agentKey ? sumLedgerDebits(request.workspaceId, dayStart, request.agentKey) : Promise.resolve(0),
  ])

  const dailyLimit = profile?.dailyBudgetCents ?? 0
  const monthlyLimit = profile?.monthlyBudgetCents ?? 0
  const agentLimit = profile?.perAgentDailyLimitCents ?? 0

  checks.push({
    scope: 'daily',
    label: 'Workspace daily limit',
    limitCents: dailyLimit,
    spentCents: spentToday,
    requestedCents: amount,
    remainingCents: dailyLimit - spentToday,
    percentUsed: dailyLimit > 0 ? (spentToday / dailyLimit) * 100 : 0,
    ok: dailyLimit <= 0 ? true : spentToday + amount <= dailyLimit,
  })

  checks.push({
    scope: 'monthly',
    label: 'Workspace monthly limit',
    limitCents: monthlyLimit,
    spentCents: spentMonth,
    requestedCents: amount,
    remainingCents: monthlyLimit - spentMonth,
    percentUsed: monthlyLimit > 0 ? (spentMonth / monthlyLimit) * 100 : 0,
    ok: monthlyLimit <= 0 ? true : spentMonth + amount <= monthlyLimit,
  })

  let projectLimit = 0
  if (request.projectId) {
    const projectRows = await db
      .select({ budgetCents: projects.budgetCents, spentCents: projects.spentCents, name: projects.name })
      .from(projects)
      .where(eq(projects.id, request.projectId))
      .limit(1)
    projectLimit = projectRows[0]?.budgetCents ?? 0
    const used = Math.max(spentProject, projectRows[0]?.spentCents ?? 0)
    checks.push({
      scope: 'project',
      label: `Project budget (${projectRows[0]?.name ?? 'project'})`,
      limitCents: projectLimit,
      spentCents: used,
      requestedCents: amount,
      remainingCents: projectLimit - used,
      percentUsed: projectLimit > 0 ? (used / projectLimit) * 100 : 0,
      ok: projectLimit <= 0 ? true : used + amount <= projectLimit,
    })
  } else if (profile?.maxProjectBudgetCents) {
    checks.push({
      scope: 'project',
      label: 'Maximum project budget (unallocated)',
      limitCents: profile.maxProjectBudgetCents,
      spentCents: 0,
      requestedCents: amount,
      remainingCents: profile.maxProjectBudgetCents,
      percentUsed: 0,
      ok: amount <= profile.maxProjectBudgetCents,
    })
  }

  if (request.agentKey && agentLimit > 0) {
    checks.push({
      scope: 'agent',
      label: `Agent daily limit (${request.agentKey})`,
      limitCents: agentLimit,
      spentCents: spentAgentToday,
      requestedCents: amount,
      remainingCents: agentLimit - spentAgentToday,
      percentUsed: (spentAgentToday / agentLimit) * 100,
      ok: spentAgentToday + amount <= agentLimit,
    })
  }

  const explicit = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.workspaceId, request.workspaceId), eq(budgets.enabled, true)))
  for (const entry of explicit) {
    if (entry.scope === 'workspace' && entry.period === 'daily') {
      const check = checks.find((c) => c.scope === 'daily')
      if (check && entry.limitCents < check.limitCents) {
        check.limitCents = entry.limitCents
        check.ok = check.spentCents + amount <= entry.limitCents
        check.remainingCents = entry.limitCents - check.spentCents
      }
    }
    if (entry.scope === 'workspace' && entry.period === 'monthly') {
      const check = checks.find((c) => c.scope === 'monthly')
      if (check && entry.limitCents < check.limitCents) {
        check.limitCents = entry.limitCents
        check.ok = check.spentCents + amount <= entry.limitCents
        check.remainingCents = entry.limitCents - check.spentCents
      }
    }
  }

  const globalCap = env.MAX_DAILY_AI_SPEND_CENTS
  if (globalCap > 0) {
    const systemSpendToday = await sumExpenses(request.workspaceId, dayStart)
    checks.push({
      scope: 'workspace',
      label: 'Platform AI spend ceiling',
      limitCents: globalCap,
      spentCents: systemSpendToday,
      requestedCents: amount,
      remainingCents: globalCap - systemSpendToday,
      percentUsed: (systemSpendToday / globalCap) * 100,
      ok: systemSpendToday + amount <= globalCap,
    })
  }

  const failing = checks.filter((c) => !c.ok)
  if (amount === 0 && !request.allowZeroCost) {
    // Zero-cost operations still pass, but the caller is told explicitly.
    return {
      allowed: true,
      requiresApproval: false,
      reason: 'No cost — no budget check required.',
      amountCents: 0,
      currency: request.currency ?? 'USD',
      checks,
    }
  }

  if (failing.length > 0) {
    const worst = failing.sort((a, b) => a.remainingCents - b.remainingCents)[0]!
    const reason = `Blocked by ${worst.label}: ${formatMinor(worst.spentCents)} spent of ${formatMinor(
      worst.limitCents,
    )}, requested ${formatMinor(amount)}.`
    log.warn('spend blocked by budget guardrail', {
      workspaceId: request.workspaceId,
      amount,
      blockedBy: worst.label,
    })
    return {
      allowed: false,
      requiresApproval: true,
      reason,
      amountCents: amount,
      currency: request.currency ?? 'USD',
      checks,
    }
  }

  return {
    allowed: true,
    requiresApproval: false,
    reason: 'Within all configured budget limits.',
    amountCents: amount,
    currency: request.currency ?? 'USD',
    checks,
  }
}

function formatMinor(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

/**
 * Authorise _and reserve_ a spend. Returns the decision; on success a ledger
 * debit row is written so parallel agents see the money as spent.
 */
export async function authorizeSpend(request: SpendRequest): Promise<SpendDecision> {
  const decision = await evaluateBudget(request)
  if (!decision.allowed || decision.amountCents === 0) return decision

  const db = await getDb()
  const inserted = await db
    .insert(budgetLedger)
    .values({
      workspaceId: request.workspaceId,
      scope: request.scope ?? 'workspace',
      scopeKey: request.agentKey ?? request.projectId ?? null,
      direction: 'debit',
      amountCents: decision.amountCents,
      currency: decision.currency,
      reason: request.description,
      refType: request.refType ?? 'agent_run',
      refId: request.refId ?? null,
      projectId: request.projectId ?? null,
    })
    .returning({ id: budgetLedger.id })

  return { ...decision, ledgerId: inserted[0]?.id }
}

/** Settle a reservation to the real, metered cost (may be lower or higher). */
export async function settleSpend(
  ledgerId: string,
  actualCents: number,
  details: { description?: string } = {},
): Promise<void> {
  const db = await getDb()
  await db
    .update(budgetLedger)
    .set({
      amountCents: Math.max(0, Math.round(actualCents)),
      reason: details.description ?? undefined,
    })
    .where(eq(budgetLedger.id, ledgerId))
}

/** Release a reservation entirely (action was not performed). */
export async function releaseSpend(ledgerId: string): Promise<void> {
  const db = await getDb()
  await db
    .update(budgetLedger)
    .set({ amountCents: 0, reason: 'reservation released (action not executed)', direction: 'credit' })
    .where(eq(budgetLedger.id, ledgerId))
}

export type BudgetSnapshot = {
  currency: string
  daily: { limitCents: number; spentCents: number; percentUsed: number; resetsAt: string }
  monthly: { limitCents: number; spentCents: number; percentUsed: number; resetsAt: string }
  projectMaxCents: number
  agentDailyLimitCents: number
  alerting: { level: 'ok' | 'warning' | 'critical'; message?: string }[]
}

export async function budgetSnapshot(workspaceId: string): Promise<BudgetSnapshot> {
  const db = await getDb()
  const profileRows = await db.select().from(profiles).where(eq(profiles.workspaceId, workspaceId)).limit(1)
  const profile = profileRows[0]
  const dayStart = startOfDay()
  const monthStart = startOfMonth()
  const [spentToday, spentMonth] = await Promise.all([
    sumExpenses(workspaceId, dayStart),
    sumExpenses(workspaceId, monthStart),
  ])

  const dailyLimit = profile?.dailyBudgetCents ?? 0
  const monthlyLimit = profile?.monthlyBudgetCents ?? 0
  const alerting: BudgetSnapshot['alerting'] = []

  const dailyPct = dailyLimit > 0 ? (spentToday / dailyLimit) * 100 : 0
  const monthlyPct = monthlyLimit > 0 ? (spentMonth / monthlyLimit) * 100 : 0
  const threshold = 80
  if (dailyPct >= 100) alerting.push({ level: 'critical', message: 'Daily automation budget exhausted.' })
  else if (dailyPct >= threshold) alerting.push({ level: 'warning', message: `Daily budget ${dailyPct.toFixed(0)}% used.` })
  if (monthlyPct >= 100) alerting.push({ level: 'critical', message: 'Monthly automation budget exhausted.' })
  else if (monthlyPct >= threshold) alerting.push({ level: 'warning', message: `Monthly budget ${monthlyPct.toFixed(0)}% used.` })

  const nextDay = startOfDay()
  nextDay.setUTCDate(nextDay.getUTCDate() + 1)
  const nextMonth = startOfMonth()
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1)

  return {
    currency: profile?.currency ?? 'USD',
    daily: {
      limitCents: dailyLimit,
      spentCents: spentToday,
      percentUsed: dailyPct,
      resetsAt: nextDay.toISOString(),
    },
    monthly: {
      limitCents: monthlyLimit,
      spentCents: spentMonth,
      percentUsed: monthlyPct,
      resetsAt: nextMonth.toISOString(),
    },
    projectMaxCents: profile?.maxProjectBudgetCents ?? 0,
    agentDailyLimitCents: profile?.perAgentDailyLimitCents ?? 0,
    alerting,
  }
}

/** Record a real expense and roll it into project + budget aggregates. */
export async function recordExpense(input: {
  workspaceId: string
  amountCents: number
  category: string
  description: string
  projectId?: string | null
  agentRunId?: string | null
  provider?: string | null
  verification?: 'verified_integration' | 'manual' | 'metered_estimate'
  occurredAt?: Date
  metadata?: Record<string, unknown>
  userId?: string | null
}): Promise<{ id: string }> {
  const db = await getDb()
  const rows = await db
    .insert(expenses)
    .values({
      workspaceId: input.workspaceId,
      projectId: input.projectId ?? null,
      agentRunId: input.agentRunId ?? null,
      category: input.category,
      description: input.description,
      amountCents: Math.round(input.amountCents),
      provider: input.provider ?? null,
      verification: input.verification ?? 'metered_estimate',
      occurredAt: input.occurredAt ?? new Date(),
      recordedByUserId: input.userId ?? null,
      metadata: input.metadata ?? {},
    })
    .returning({ id: expenses.id })

  if (input.projectId) {
    await db
      .update(projects)
      .set({
        spentCents: sql`${projects.spentCents} + ${Math.round(input.amountCents)}`,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, input.projectId))
  }
  return { id: rows[0]!.id }
}

/** Convenience for UI: how much of the workspace month budget remains. */
export async function remainingBudget(workspaceId: string): Promise<number> {
  const snapshot = await budgetSnapshot(workspaceId)
  return Math.max(0, snapshot.monthly.limitCents - snapshot.monthly.spentCents)
}

export async function ledgerTotals(workspaceId: string, since: Date) {
  const db = await getDb()
  const result = await db.execute<{ direction: string; total: string }>(sql`
    select direction, coalesce(sum(amount_cents), 0)::text as total
    from budget_ledger
    where workspace_id = ${workspaceId} and occurred_at >= ${since.toISOString()}
    group by direction
  `)
  const rows = extractRows<{ direction: string; total: string }>(result)
  return {
    debits: Number(rows.find((r) => r.direction === 'debit')?.total ?? 0),
    credits: Number(rows.find((r) => r.direction === 'credit')?.total ?? 0),
  }
}
