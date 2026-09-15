/**
 * GET   /api/jobs — the job queue view (admin surface).
 * POST  /api/jobs — retry or cancel a job.
 * The queue is durable: jobs survive restarts and are claimed with row locks.
 */
import { z } from 'zod'
import { ok, parseBody, withApi } from '@/lib/api/http'
import { cancelJob, listJobs, queueStats, retryJob } from '@/lib/queue'
import type { JobStatus } from '@/lib/queue/types'

export const dynamic = 'force-dynamic'

const STATUSES: JobStatus[] = ['queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled']

export const GET = withApi(
  async (ctx) => {
    const limit = Math.min(200, Math.max(1, Number(ctx.searchParams.get('limit') ?? 50)))
    const statusParam = ctx.searchParams.getAll('status').flatMap((value) => value.split(',')).filter((value): value is JobStatus => STATUSES.includes(value as JobStatus))
    const queue = ctx.searchParams.get('queue') ?? undefined
    const scope = ctx.searchParams.get('scope')

    const [jobs, stats] = await Promise.all([
      listJobs({
        status: statusParam.length ? statusParam : undefined,
        queue,
        limit,
        workspaceId: scope === 'platform' ? undefined : ctx.session.workspaceId,
      }),
      queueStats(),
    ])

    const counts = await listJobs({ limit: 200, workspaceId: scope === 'platform' ? undefined : ctx.session.workspaceId })
    const byStatus = counts.reduce<Record<string, number>>((acc, job) => {
      acc[job.status] = (acc[job.status] ?? 0) + 1
      return acc
    }, {})

    return ok({ jobs, stats, byStatus })
  },
  { admin: true },
)

const schema = z.object({ jobId: z.string().uuid(), action: z.enum(['retry', 'cancel']) })

export const POST = withApi(
  async (ctx) => {
    const input = await parseBody(ctx.request, schema)
    const okResult = input.action === 'retry' ? await retryJob(input.jobId) : await cancelJob(input.jobId)
    return ok({ jobId: input.jobId, action: input.action, applied: okResult })
  },
  { admin: true },
)
