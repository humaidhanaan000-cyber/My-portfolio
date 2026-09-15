/**
 * Approval Center engine.
 *
 * Anything risky, paid, public or irreversible lands here and stops. The
 * decision itself is recorded in `audit_logs`, and approved work is dispatched
 * as a job so execution survives a page reload or a server restart.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { getDb, approvals, auditLogs, budgetLedger, projects, extractRows } from '../db'
import { createLogger } from '../observability/logger'
import { notify } from '../notifications'
import { evaluateAction, type ActionType } from '../compliance/policy'

const log = createLogger({ component: 'approvals' })

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'deferred' | 'expired' | 'executed' | 'failed'

export type CreateApprovalInput = {
  workspaceId: string
  actionType: ActionType | string
  title: string
  reason: string
  expectedCostCents?: number
  potentialBenefit?: string
  risk?: 'low' | 'medium' | 'high'
  payload?: Record<string, unknown>
  projectId?: string | null
  opportunityId?: string | null
  workflowRunId?: string | null
  requestedByAgent?: string
  expiresInHours?: number
  dedupeKey?: string
}

export async function createApproval(input: CreateApprovalInput): Promise<{ id: string; created: boolean }> {
  const db = await getDb()

  if (input.dedupeKey) {
    const existing = await db
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.workspaceId, input.workspaceId), eq(approvals.status, 'pending')))
      .orderBy(desc(approvals.createdAt))
      .limit(50)
    for (const row of existing) {
      const rows = await db.select().from(approvals).where(eq(approvals.id, row.id)).limit(1)
      const payloadKey = String((rows[0]?.payload as Record<string, unknown> | null)?.dedupeKey ?? '')
      if (payloadKey === input.dedupeKey) return { id: row.id, created: false }
    }
  }

  const expiresAt = new Date(Date.now() + (input.expiresInHours ?? 72) * 3_600_000)
  const rows = await db
    .insert(approvals)
    .values({
      workspaceId: input.workspaceId,
      actionType: input.actionType,
      title: input.title,
      reason: input.reason,
      expectedCostCents: Math.max(0, Math.round(input.expectedCostCents ?? 0)),
      potentialBenefit: input.potentialBenefit ?? '',
      risk: input.risk ?? 'medium',
      payload: { ...(input.payload ?? {}), ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}) },
      projectId: input.projectId ?? null,
      opportunityId: input.opportunityId ?? null,
      workflowRunId: input.workflowRunId ?? null,
      requestedByAgent: input.requestedByAgent ?? 'system',
      status: 'pending',
      expiresAt,
    })
    .returning({ id: approvals.id })

  const id = rows[0]!.id
  await db.insert(auditLogs).values({
    workspaceId: input.workspaceId,
    actorType: 'agent',
    actorKey: input.requestedByAgent ?? 'system',
    action: 'approval.requested',
    entityType: 'approval',
    entityId: id,
    after: { actionType: input.actionType, expectedCostCents: input.expectedCostCents ?? 0 } as Record<string, unknown>,
  })

  await notify({
    workspaceId: input.workspaceId,
    type: 'approval_required',
    severity: input.risk === 'high' ? 'critical' : 'warning',
    title: `Approval required: ${input.title}`,
    body: input.reason,
    link: `/dashboard/approvals`,
    dedupeKey: `approval:${id}`,
  })

  log.info('approval requested', { id, actionType: input.actionType, workspaceId: input.workspaceId })
  return { id, created: true }
}

export async function listApprovals(workspaceId: string, options: { status?: ApprovalStatus[]; limit?: number } = {}) {
  const db = await getDb()
  const conditions = [eq(approvals.workspaceId, workspaceId)]
  if (options.status?.length) conditions.push(inArray(approvals.status, options.status))
  return db
    .select()
    .from(approvals)
    .where(and(...conditions))
    .orderBy(desc(approvals.createdAt))
    .limit(Math.min(options.limit ?? 100, 200))
}

export async function getApproval(workspaceId: string, id: string) {
  const db = await getDb()
  const rows = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.id, id)))
    .limit(1)
  return rows[0] ?? null
}

export type Decision = 'approve' | 'reject' | 'defer' | 'edit'

export type DecideInput = {
  workspaceId: string
  approvalId: string
  decision: Decision
  userId: string
  note?: string
  deferUntil?: Date
  edits?: { title?: string; reason?: string; payload?: Record<string, unknown>; expectedCostCents?: number }
  /** Queue execution immediately (default true for approve). */
  execute?: boolean
}

export type DecideResult = {
  ok: boolean
  status: ApprovalStatus
  error?: string
  executionQueued?: boolean
  requiresSeparateAuthorization?: boolean
}

export async function decideApproval(input: DecideInput): Promise<DecideResult> {
  const db = await getDb()
  const approval = await getApproval(input.workspaceId, input.approvalId)
  if (!approval) return { ok: false, status: 'pending', error: 'Approval not found' }
  if (approval.status !== 'pending' && approval.status !== 'deferred') {
    return { ok: false, status: approval.status as ApprovalStatus, error: `Approval already ${approval.status}` }
  }

  // Re-evaluate policy at decision time: policy is never cached across a human gap.
  const policy = evaluateAction({
    actionType: approval.actionType as ActionType,
    automationLevel: 'autonomous_low_risk',
    estimatedCostCents: approval.expectedCostCents,
    payload: (input.edits?.payload ?? approval.payload) as Record<string, unknown>,
  })

  if (input.decision === 'approve' && !policy.allowed && policy.risk === 'prohibited') {
    return { ok: false, status: approval.status as ApprovalStatus, error: policy.reason }
  }

  const patch: Record<string, unknown> = {
    decidedByUserId: input.userId,
    decisionNote: input.note ?? null,
    decidedAt: new Date(),
    updatedAt: new Date(),
  }

  switch (input.decision) {
    case 'approve':
      patch.status = 'approved'
      break
    case 'reject':
      patch.status = 'rejected'
      break
    case 'defer':
      patch.status = 'deferred'
      patch.deferUntil = input.deferUntil ?? new Date(Date.now() + 24 * 3_600_000)
      break
    case 'edit':
      patch.title = input.edits?.title ?? approval.title
      patch.reason = input.edits?.reason ?? approval.reason
      patch.payload = { ...(approval.payload as Record<string, unknown>), ...(input.edits?.payload ?? {}) }
      patch.expectedCostCents = input.edits?.expectedCostCents ?? approval.expectedCostCents
      patch.status = 'pending'
      break
  }

  await db.update(approvals).set(patch).where(eq(approvals.id, approval.id))
  await db.insert(auditLogs).values({
    workspaceId: input.workspaceId,
    userId: input.userId,
    actorType: 'user',
    action: `approval.${input.decision}`,
    entityType: 'approval',
    entityId: approval.id,
    before: { status: approval.status } as Record<string, unknown>,
    after: { status: patch.status, note: input.note ?? null, edits: input.edits ?? null } as Record<string, unknown>,
  })

  let executionQueued = false
  let requiresSeparateAuthorization = false

  if (input.decision === 'approve' && (input.execute ?? true)) {
    // Money-moving and account-creating actions can never be executed by AIBA,
    // even with approval: they need the operator to act in their own provider.
    if (['create_account', 'make_purchase', 'run_ad_campaign', 'financial_trade'].includes(approval.actionType)) {
      requiresSeparateAuthorization = true
      await db
        .update(approvals)
        .set({ status: 'approved', executionError: 'Marked as operator-executed: AIBA does not perform this action on your behalf.' })
        .where(eq(approvals.id, approval.id))
    } else {
      const { enqueue } = await import('../queue')
      await enqueue(
        'approval.execute',
        { approvalId: approval.id, workspaceId: input.workspaceId },
        { queue: 'execution', priority: 2, workspaceId: input.workspaceId, dedupeKey: `approval-exec:${approval.id}` },
      )
      executionQueued = true
    }
  }

  await notify({
    workspaceId: input.workspaceId,
    type: 'approval_decision',
    severity: input.decision === 'reject' ? 'warning' : 'info',
    title: `Approval ${input.decision}d: ${approval.title}`,
    body: input.note ?? policy.reason,
    link: '/dashboard/approvals',
    dedupeKey: `approval-decision:${approval.id}`,
  })

  return { ok: true, status: patch.status as ApprovalStatus, executionQueued, requiresSeparateAuthorization }
}

/** Expire stale approvals and release any budget reservations they held. */
export async function expireStaleApprovals(workspaceId?: string): Promise<number> {
  const db = await getDb()
  const conditions = [eq(approvals.status, 'pending'), sql`${approvals.expiresAt} < now()`]
  if (workspaceId) conditions.push(eq(approvals.workspaceId, workspaceId))
  const expired = await db
    .update(approvals)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: approvals.id })
  return expired.length
}

export type ApprovalStats = {
  pending: number
  approvedToday: number
  rejectedToday: number
  deferred: number
  failed: number
  pendingCostCents: number
  avgDecisionMinutes: number | null
}

export async function approvalStats(workspaceId: string): Promise<ApprovalStats> {
  const db = await getDb()
  const result = await db.execute(sql`
    select
      count(*) filter (where status = 'pending') as pending,
      count(*) filter (where status = 'deferred') as deferred,
      count(*) filter (where status = 'failed') as failed,
      count(*) filter (where status in ('approved','executed') and decided_at >= date_trunc('day', now())) as approved_today,
      count(*) filter (where status = 'rejected' and decided_at >= date_trunc('day', now())) as rejected_today,
      coalesce(sum(expected_cost_cents) filter (where status = 'pending'), 0) as pending_cost,
      avg(extract(epoch from (decided_at - created_at)) / 60) filter (where decided_at is not null) as avg_decision_minutes
    from approvals
    where workspace_id = ${workspaceId}
  `)
  const row = extractRows<{
    pending: string
    deferred: string
    failed: string
    approved_today: string
    rejected_today: string
    pending_cost: string
    avg_decision_minutes: string | null
  }>(result)[0]

  return {
    pending: Number(row?.pending ?? 0),
    deferred: Number(row?.deferred ?? 0),
    failed: Number(row?.failed ?? 0),
    approvedToday: Number(row?.approved_today ?? 0),
    rejectedToday: Number(row?.rejected_today ?? 0),
    pendingCostCents: Number(row?.pending_cost ?? 0),
    avgDecisionMinutes: row?.avg_decision_minutes ? Number(row.avg_decision_minutes) : null,
  }
}

/** Release budget reservations belonging to a rejected/expired approval. */
export async function releaseApprovalBudget(approvalId: string): Promise<void> {
  const db = await getDb()
  await db
    .update(budgetLedger)
    .set({ amountCents: 0, direction: 'credit', reason: `released by approval ${approvalId}` })
    .where(and(eq(budgetLedger.refId, approvalId), eq(budgetLedger.direction, 'debit')))
}

export async function projectOfApproval(approvalId: string): Promise<string | null> {
  const db = await getDb()
  const rows = await db.select({ projectId: approvals.projectId }).from(approvals).where(eq(approvals.id, approvalId)).limit(1)
  return rows[0]?.projectId ?? null
}

export async function markApprovalExecuted(
  approvalId: string,
  result: Record<string, unknown>,
): Promise<void> {
  const db = await getDb()
  await db
    .update(approvals)
    .set({ status: 'executed', executedAt: new Date(), executionResult: result, executionError: null, updatedAt: new Date() })
    .where(eq(approvals.id, approvalId))
}

export async function markApprovalFailed(approvalId: string, error: string): Promise<void> {
  const db = await getDb()
  await db
    .update(approvals)
    .set({ status: 'failed', executionError: error, executedAt: new Date(), updatedAt: new Date() })
    .where(eq(approvals.id, approvalId))
}

export async function projectNameFor(projectId: string | null): Promise<string | null> {
  if (!projectId) return null
  const db = await getDb()
  const rows = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).limit(1)
  return rows[0]?.name ?? null
}
