/**
 * POST /api/notifications/alerts/[id] — acknowledge or resolve a monitoring alert.
 */
import { z } from 'zod'
import { ok, parseBody, withApi } from '@/lib/api/http'
import { activeAlerts, resolveAlert } from '@/lib/notifications'
import { ApiError } from '@/lib/api/http'

export const dynamic = 'force-dynamic'

const schema = z.object({ resolve: z.boolean().default(true) })

export const GET = withApi(async (ctx) => {
  const alerts = await activeAlerts(ctx.session.workspaceId)
  const alert = alerts.find((entry) => entry.id === ctx.params.id)
  if (!alert) throw new ApiError('not_found', 'Alert not found or already resolved.')
  return ok(alert)
})

export const POST = withApi(async (ctx) => {
  const input = await parseBody(ctx.request, schema)
  if (!input.resolve) throw new ApiError('validation_error', 'Only resolve=true is supported.')
  const resolved = await resolveAlert(ctx.session.workspaceId, ctx.params.id!, ctx.session.id)
  if (!resolved) throw new ApiError('not_found', 'Alert not found or already resolved.')
  return ok({ resolved: true, id: ctx.params.id })
})
