/**
 * GET /api/dashboard/status — the compact, authenticated status the dashboard
 * chrome polls. It is the same `systemStatus()` the command centre uses, so the
 * pill in the header can never disagree with the page.
 */
import { ok, withApi } from '@/lib/api/http'
import { systemStatus } from '@/lib/agents/orchestrator'

export const dynamic = 'force-dynamic'

export const GET = withApi(async (ctx) => ok(await systemStatus(ctx.session.workspaceId)))
