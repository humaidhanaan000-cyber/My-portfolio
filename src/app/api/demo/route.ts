/**
 * Demo data control.
 *
 * Demo rows are written with `demo = true` and the `demo` revenue provider, so
 * they are structurally unable to mix with real revenue. Clearing demo data
 * removes only demo rows.
 */
import { z } from 'zod'
import { ok, parseBody, withApi, ApiError } from '@/lib/api/http'
import { clearDemoData, seedWorkspaceDemoData } from '@/lib/demo/seed'
import { getDb, workspaces } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'

export const GET = withApi(async (ctx) => {
  const db = await getDb()
  const workspace = (await db.select({ demoMode: workspaces.demoMode }).from(workspaces).where(eq(workspaces.id, ctx.session.workspaceId)).limit(1))[0]
  return ok({
    demoMode: workspace?.demoMode ?? false,
    enabled: env.DEMO_MODE_ENABLED,
    notice: 'DEMO DATA is stored with an explicit demo flag and can never be added to real revenue figures.',
  })
})

const schema = z.object({ action: z.enum(['seed', 'clear']), force: z.boolean().default(false) })

export const POST = withApi(
  async (ctx) => {
    const input = await parseBody(ctx.request, schema)
    if (!env.DEMO_MODE_ENABLED) {
      throw new ApiError('forbidden', 'Demo data is disabled on this deployment (DEMO_MODE_ENABLED=false).')
    }
    if (input.action === 'clear') {
      await clearDemoData(ctx.session.workspaceId)
      return ok({ cleared: true })
    }
    const result = await seedWorkspaceDemoData(ctx.session.workspaceId, { force: input.force })
    return ok({ ...result, notice: 'All generated rows are marked DEMO DATA.' })
  },
  { rateLimit: { limit: 5, windowMs: 60_000, scope: 'demo' } },
)
