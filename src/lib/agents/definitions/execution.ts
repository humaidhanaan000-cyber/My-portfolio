/**
 * AGENT 7 — EXECUTION AGENT
 *
 * The only component allowed to change the outside world — and it only acts on
 * actions a human has already approved. Every execution writes an audit record
 * before and after, and actions AIBA can never perform on the operator's behalf
 * (creating accounts, making purchases, running ad campaigns, executing trades)
 * are handed back to the human explicitly instead of being simulated.
 */
import { z } from 'zod'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb, approvals, auditLogs, contentAssets, projects, projectEvents, revenueTransactions, tasks } from '../../db'
import { evaluateAction, type ActionType } from '../../compliance/policy'
import { recordExpense } from '../../budget'
import { markApprovalExecuted, markApprovalFailed } from '../../approvals'
import { notify } from '../../notifications'
import type { AgentDefinition, AgentOutput } from '../types'

export const executionInputSchema = z.object({
  approvalId: z.string().uuid(),
})
export type ExecutionInput = z.infer<typeof executionInputSchema>

export type ExecutionOutput = {
  approvalId: string
  actionType: string
  outcome: 'executed' | 'handed_to_operator' | 'noop'
  detail: string
  sideEffects: string[]
  followUps: string[]
}

/** Actions that must be performed by the human in their own provider account. */
const OPERATOR_ONLY: ActionType[] = ['create_account', 'make_purchase', 'run_ad_campaign', 'financial_trade', 'send_marketing_email']

export const executionAgent: AgentDefinition<ExecutionInput, ExecutionOutput> = {
  key: 'execution',
  name: 'Execution Agent',
  description: 'Executes approved actions, records audit trails and hands operator-only actions back to the human.',
  category: 'execution',
  policyAction: 'update_project',
  estimatedCostCents: 0,
  modelTier: 'cheap',
  timeoutSeconds: 300,
  cadenceMinutes: 0,
  requiresWorkspace: true,
  inputSchema: executionInputSchema,

  async run(input, ctx): Promise<AgentOutput<ExecutionOutput>> {
    const db = await getDb()
    const approval = (
      await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.id, input.approvalId), eq(approvals.workspaceId, ctx.workspaceId)))
        .limit(1)
    )[0]
    if (!approval) throw new Error(`Approval ${input.approvalId} not found`)
    if (approval.status !== 'approved' && approval.status !== 'executed') {
      throw new Error(`Approval ${approval.id} is "${approval.status}" — only approved actions may execute.`)
    }

    const actionType = approval.actionType as ActionType
    const payload = (approval.payload ?? {}) as Record<string, unknown>
    const sideEffects: string[] = []
    const followUps: string[] = []

    // For audit, record the decision context *before* touching anything.
    await db.insert(auditLogs).values({
      workspaceId: ctx.workspaceId,
      actorType: 'agent',
      actorKey: 'execution',
      action: 'execution.started',
      entityType: 'approval',
      entityId: approval.id,
      after: { actionType, payload } as Record<string, unknown>,
    })

    if (OPERATOR_ONLY.includes(actionType)) {
      await db
        .update(approvals)
        .set({
          status: 'executed',
          executedAt: new Date(),
          executionResult: {
            outcome: 'handed_to_operator',
            message: 'AIBA does not perform this class of action. Approval recorded; the operator completes it in their own account.',
          } as Record<string, unknown>,
          updatedAt: new Date(),
        })
        .where(eq(approvals.id, approval.id))
      await notify({
        workspaceId: ctx.workspaceId,
        type: 'system',
        severity: 'info',
        title: `Action for you: ${approval.title}`,
        body: 'AIBA has marked this approved. This action type is performed by you directly — the platform never creates accounts, purchases, ad campaigns or trades on your behalf.',
        link: '/dashboard/approvals',
        dedupeKey: `operator-action:${approval.id}`,
      })
      return {
        data: {
          approvalId: approval.id,
          actionType,
          outcome: 'handed_to_operator',
          detail: 'Recorded as operator-executed. No automated action was taken.',
          sideEffects: [],
          followUps: ['Complete this action in your own provider account.'],
        },
        summary: `Approval "${approval.title}" is operator-only; recorded without automation.`,
      }
    }

    // Policy is re-evaluated at execution time. A human approval satisfies the
    // "requires approval" outcome, so only prohibitively-classified actions or
    // payload violations can stop execution here.
    const spendAmount =
      actionType === 'spend_money' ? Number(payload.amountCents ?? approval.expectedCostCents) : 0
    const policy = evaluateAction({
      actionType,
      automationLevel: 'autonomous_low_risk',
      estimatedCostCents: spendAmount,
      payload,
    })
    if (policy.risk === 'prohibited' || policy.violations.length > 0) {
      await markApprovalFailed(approval.id, policy.reason)
      throw new Error(`Execution refused by policy: ${policy.reason}`)
    }

    try {
      switch (actionType) {
        case 'create_project': {
          const projectId = String(payload.projectId ?? approval.projectId ?? '')
          if (!projectId) throw new Error('No project in approval payload')
          await db
            .update(projects)
            .set({ status: 'BUILDING', progress: 25, updatedAt: new Date(), launchedAt: null })
            .where(and(eq(projects.id, projectId), eq(projects.workspaceId, ctx.workspaceId)))
          sideEffects.push('Project moved to BUILDING')

          await db.insert(projectEvents).values({
            workspaceId: ctx.workspaceId,
            projectId,
            type: 'approved',
            actor: 'execution',
            message: `Build approved by user. Launch plan released (${Array.isArray(payload.launchPlan) ? payload.launchPlan.length : 0} phases).`,
            data: { approvalId: approval.id },
          })

          const { enqueue } = await import('../../queue')
          await enqueue('agent.product', { projectId, useAi: true }, { queue: 'creation', priority: 3, workspaceId: ctx.workspaceId, dedupeKey: `product:${projectId}` })
          await enqueue('agent.content', { projectId, useAi: true }, { queue: 'creation', priority: 4, workspaceId: ctx.workspaceId, dedupeKey: `content:${projectId}` })
          followUps.push('Product and content generation queued.')
          break
        }

        case 'publish_content':
        case 'update_website_page': {
          const assetIds = (payload.assetIds as string[] | undefined) ?? []
          const projectId = approval.projectId ?? (payload.projectId as string | undefined) ?? null

          if (assetIds.length === 0) {
            sideEffects.push('Nothing to publish: no asset ids in the approval payload')
            break
          }

          const assets = await db
            .select()
            .from(contentAssets)
            .where(and(eq(contentAssets.workspaceId, ctx.workspaceId), inArray(contentAssets.id, assetIds)))

          // A publishing integration must be explicitly configured. Without one,
          // AIBA will not pretend to publish — it marks the assets approved and
          // exports them for the operator.
          const { getPublishTarget } = await import('../../integrations')
          const target = await getPublishTarget(ctx.workspaceId)

          if (!target.configured) {
            for (const asset of assets) {
              await db
                .update(contentAssets)
                .set({ status: 'approved', updatedAt: new Date(), metadata: { ...(asset.metadata as Record<string, unknown>), publishBlocked: 'no_integration' } })
                .where(eq(contentAssets.id, asset.id))
            }
            sideEffects.push(`${assets.length} asset(s) approved for publishing`)
            followUps.push(
              'No publishing integration is configured. Assets are marked approved and available as a Markdown export on the project page. Configure a publishing integration (see docs/INTEGRATIONS.md) to push them automatically.',
            )
            if (projectId) {
              await db.insert(projectEvents).values({
                workspaceId: ctx.workspaceId,
                projectId,
                type: 'publish_pending_integration',
                actor: 'execution',
                message: `${assets.length} asset(s) approved but not published: no publishing integration configured.`,
              })
            }
            break
          }

          const published: string[] = []
          for (const asset of assets) {
            const result = await target.publish(asset)
            if (result.ok) {
              published.push(asset.id)
              await db
                .update(contentAssets)
                .set({
                  status: 'published',
                  publishedUrl: result.url ?? null,
                  publishedAt: new Date(),
                  updatedAt: new Date(),
                  metadata: { ...(asset.metadata as Record<string, unknown>), publishedVia: target.name },
                })
                .where(eq(contentAssets.id, asset.id))
            } else {
              await db
                .update(contentAssets)
                .set({ metadata: { ...(asset.metadata as Record<string, unknown>), publishError: result.error } })
                .where(eq(contentAssets.id, asset.id))
              followUps.push(`Publishing failed for "${asset.title}": ${result.error}`)
            }
          }
          sideEffects.push(`${published.length}/${assets.length} asset(s) published via ${target.name}`)
          if (projectId && published.length > 0) {
            await db.insert(projectEvents).values({
              workspaceId: ctx.workspaceId,
              projectId,
              type: 'content_published',
              actor: 'execution',
              message: `${published.length} asset(s) published via ${target.name}.`,
            })
          }
          break
        }

        case 'spend_money': {
          const amountCents = Number(payload.amountCents ?? approval.expectedCostCents)
          if (!Number.isFinite(amountCents) || amountCents <= 0) throw new Error('Invalid spend amount in approval payload')
          await recordExpense({
            workspaceId: ctx.workspaceId,
            amountCents,
            category: String(payload.category ?? 'other'),
            description: String(payload.description ?? approval.title),
            projectId: approval.projectId ?? null,
            verification: 'manual',
            metadata: { approvalId: approval.id, approvedBy: approval.decidedByUserId },
          })
          sideEffects.push(`Expense of ${(amountCents / 100).toFixed(2)} recorded`)
          break
        }

        case 'delete_data': {
          const entity = String(payload.entity ?? '')
          const entityId = String(payload.entityId ?? '')
          if (entity === 'opportunity') {
            const { opportunities } = await import('../../db')
            await db.update(opportunities).set({ deletedAt: new Date() }).where(and(eq(opportunities.id, entityId), eq(opportunities.workspaceId, ctx.workspaceId)))
          } else if (entity === 'project') {
            await db.update(projects).set({ deletedAt: new Date() }).where(and(eq(projects.id, entityId), eq(projects.workspaceId, ctx.workspaceId)))
          } else if (entity === 'content_asset') {
            await db.update(contentAssets).set({ deletedAt: new Date() }).where(and(eq(contentAssets.id, entityId), eq(contentAssets.workspaceId, ctx.workspaceId)))
          } else {
            throw new Error(`Unsupported entity for deletion: ${entity}`)
          }
          sideEffects.push(`Soft-deleted ${entity} ${entityId}`)
          break
        }

        case 'send_transactional_email': {
          const { sendTransactionalEmail } = await import('../../notifications')
          const result = await sendTransactionalEmail({
            to: String(payload.to ?? ''),
            subject: String(payload.subject ?? approval.title),
            body: String(payload.body ?? approval.reason),
          })
          sideEffects.push(`Transactional email dispatched (${result})`)
          break
        }

        case 'update_project': {
          const projectId = String(payload.projectId ?? approval.projectId ?? '')
          const status = payload.status ? String(payload.status) : undefined
          const progress = typeof payload.progress === 'number' ? payload.progress : undefined
          if (!projectId) throw new Error('No project specified')
          await db
            .update(projects)
            .set({ ...(status ? { status } : {}), ...(progress !== undefined ? { progress } : {}), updatedAt: new Date() })
            .where(and(eq(projects.id, projectId), eq(projects.workspaceId, ctx.workspaceId)))
          sideEffects.push(`Project ${projectId} updated${status ? ` → ${status}` : ''}`)
          break
        }

        case 'system_maintenance': {
          const operation = String(payload.operation ?? '')
          if (operation === 'recalculate_project_profit') {
            const projectId = String(payload.projectId ?? '')
            const { recalculateProjectFinancials } = await import('../../analytics')
            await recalculateProjectFinancials(projectId)
            sideEffects.push('Project financials recalculated')
          } else {
            sideEffects.push(`Maintenance operation "${operation || 'unspecified'}" acknowledged`)
          }
          break
        }

        default: {
          // Unknown but policy-allowed action: record it and complete the linked tasks.
          const projectId = approval.projectId
          if (projectId) {
            await db.insert(projectEvents).values({
              workspaceId: ctx.workspaceId,
              projectId,
              type: 'action_executed',
              actor: 'execution',
              message: `Approved action "${actionType}" executed: ${approval.title}`,
            })
          }
          sideEffects.push(`Recorded execution of "${actionType}"`)
        }
      }

      // Release any associated tasks.
      if (approval.projectId) {
        const relatedTasks = await db
          .select()
          .from(tasks)
          .where(and(eq(tasks.projectId, approval.projectId), inArray(tasks.status, ['todo', 'blocked'])))
        for (const task of relatedTasks) {
          if (task.requiresApproval && new RegExp(actionType.replace(/_/g, ' '), 'i').test(task.title.replace(/_/g, ' '))) {
            await db.update(tasks).set({ status: 'done', finishedAt: new Date() }).where(eq(tasks.id, task.id))
          }
        }
      }

      await db.insert(auditLogs).values({
        workspaceId: ctx.workspaceId,
        actorType: 'agent',
        actorKey: 'execution',
        action: 'execution.completed',
        entityType: 'approval',
        entityId: approval.id,
        after: { actionType, sideEffects, followUps } as Record<string, unknown>,
      })

      await markApprovalExecuted(approval.id, {
        outcome: 'executed',
        actionType,
        sideEffects,
        followUps,
        executedAt: new Date().toISOString(),
      })

      return {
        data: { approvalId: approval.id, actionType, outcome: 'executed', detail: sideEffects.join('; ') || 'Action recorded', sideEffects, followUps },
        summary: `Executed approved action "${approval.title}" (${sideEffects.length} side effect(s)).`,
        notes: sideEffects,
        warnings: followUps,
        metrics: { sideEffects: sideEffects.length },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await markApprovalFailed(approval.id, message)
      await db.insert(auditLogs).values({
        workspaceId: ctx.workspaceId,
        actorType: 'agent',
        actorKey: 'execution',
        action: 'execution.failed',
        entityType: 'approval',
        entityId: approval.id,
        after: { error: message } as Record<string, unknown>,
      })
      await notify({
        workspaceId: ctx.workspaceId,
        type: 'system_error',
        severity: 'critical',
        title: `Execution failed: ${approval.title}`,
        body: message,
        link: '/dashboard/approvals',
        dedupeKey: `exec-failed:${approval.id}`,
      })
      throw error
    }
  },
}

/** Convert a verified payment into a revenue transaction (server-side only). */
export async function recordVerifiedRevenue(input: {
  workspaceId: string
  grossCents: number
  feeCents: number
  currency: string
  source: string
  provider: string
  providerTransactionId: string
  projectId?: string | null
  occurredAt?: Date
  metadata?: Record<string, unknown>
}): Promise<{ id: string; created: boolean }> {
  const db = await getDb()
  const existing = await db
    .select({ id: revenueTransactions.id })
    .from(revenueTransactions)
    .where(and(eq(revenueTransactions.provider, input.provider), eq(revenueTransactions.providerTransactionId, input.providerTransactionId)))
    .limit(1)
  if (existing[0]) return { id: existing[0].id, created: false }

  const rows = await db
    .insert(revenueTransactions)
    .values({
      workspaceId: input.workspaceId,
      projectId: input.projectId ?? null,
      source: input.source,
      provider: input.provider,
      providerTransactionId: input.providerTransactionId,
      description: `${input.source} payment`,
      grossCents: input.grossCents,
      feeCents: input.feeCents,
      netCents: input.grossCents - input.feeCents,
      currency: input.currency,
      status: 'confirmed',
      verification: 'verified_integration',
      occurredAt: input.occurredAt ?? new Date(),
      metadata: input.metadata ?? {},
    })
    .returning({ id: revenueTransactions.id })

  const { recalculateProjectFinancials } = await import('../../analytics')
  if (input.projectId) await recalculateProjectFinancials(input.projectId)

  await notify({
    workspaceId: input.workspaceId,
    type: 'revenue_recorded',
    severity: 'success',
    title: `Revenue recorded: ${(input.grossCents / 100).toFixed(2)} ${input.currency}`,
    body: `Verified ${input.provider} transaction ${input.providerTransactionId}.`,
    link: '/dashboard/revenue',
    dedupeKey: `revenue:${input.providerTransactionId}`,
  })

  return { id: rows[0]!.id, created: true }
}
