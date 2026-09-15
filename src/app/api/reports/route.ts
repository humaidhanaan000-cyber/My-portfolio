/**
 * GET  /api/reports — stored daily and weekly reports.
 * POST /api/reports — generate one now (real analysis of real data).
 */
import { z } from 'zod'
import { ok, parseBody, withApi } from '@/lib/api/http'
import { generateAndStoreReport, listReports, latestReport } from '@/lib/reports'

export const dynamic = 'force-dynamic'

export const GET = withApi(async (ctx) => {
  const limit = Math.min(50, Math.max(1, Number(ctx.searchParams.get('limit') ?? 20)))
  const period = ctx.searchParams.get('period')
  const [reports, daily, weekly] = await Promise.all([
    listReports(ctx.session.workspaceId, limit),
    period === 'daily' ? latestReport(ctx.session.workspaceId, 'daily') : Promise.resolve(null),
    period === 'weekly' ? latestReport(ctx.session.workspaceId, 'weekly') : Promise.resolve(null),
  ])
  return ok({ reports, latest: daily ?? weekly })
})

const schema = z.object({ period: z.enum(['daily', 'weekly']), useAi: z.boolean().default(true) })

export const POST = withApi(async (ctx) => {
  const { period, useAi } = await parseBody(ctx.request, schema)
  const report = await generateAndStoreReport(ctx.session.workspaceId, period, { useAi })
  return ok(report)
})
