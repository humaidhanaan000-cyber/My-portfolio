/**
 * POST /api/agents/:key/run — trigger an agent run now.
 *
 * The run goes through the same runtime as scheduled runs: policy evaluation,
 * budget authorisation, durable job record, memory write. If the action needs
 * approval, the route returns 403 with the approval id instead of running.
 */
import { z } from 'zod'
import { ok, parseBody, withApi, ApiError } from '@/lib/api/http'
import { getAgent, runAgentByKey } from '@/lib/agents/registry'
import { AGENT_ORDERSchemaTag } from '@/lib/agents/labels'
import { enqueue } from '@/lib/queue'

export const dynamic = 'force-dynamic'

const schema = z.object({
  input: z.record(z.unknown()).default({}),
  useAi: z.boolean().default(true),
  /** Run asynchronously through the queue (recommended for long agents). */
  async: z.boolean().default(false),
})

export const GET = withApi(async () => {
  return ok({ agents: AGENT_ORDERSchemaTag() })
})

export const POST = withApi(
  async (ctx) => {
    const key = ctx.params.key!
    const agent = getAgent(key)
    if (!agent) throw new ApiError('not_found', `Unknown agent "${key}".`)
    const input = await parseBody(ctx.request, schema)

    if (input.async) {
      const { id } = await enqueue(`agent.${key}`, { ...input.input, workspaceId: ctx.session.workspaceId, useAi: input.useAi }, {
        queue: 'agents',
        priority: 4,
        workspaceId: ctx.session.workspaceId,
      })
      return ok({ queued: true, jobId: id, agent: key })
    }

    const outcome = await runAgentByKey(key, { ...input.input, useAi: input.useAi }, {
      workspaceId: ctx.session.workspaceId,
      triggeredBy: 'user',
      userId: ctx.session.id,
      approveImmediately: true,
    })

    if (outcome.status === 'awaiting_approval') {
      throw new ApiError('policy_blocked', outcome.policy.reason, {
        approvalId: outcome.approvalId,
        hint: 'Approve the request in the Approval Center to release this action.',
      })
    }

    return ok({
      agent: key,
      runId: outcome.runId,
      status: outcome.status,
      summary: outcome.output?.summary,
      data: outcome.output?.data,
      warnings: outcome.output?.warnings,
      notes: outcome.output?.notes,
      costCents: outcome.costCents,
      durationMs: outcome.durationMs,
      error: outcome.error,
      policy: outcome.policy,
    })
  },
  { rateLimit: { limit: 20, windowMs: 60_000, scope: 'agent-run' } },
)
