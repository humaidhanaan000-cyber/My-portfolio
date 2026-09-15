/** GET /api/billing — the workspace's subscription, invoices and payment events. */
import { desc, eq } from 'drizzle-orm'
import { getDb, paymentEvents } from '@/lib/db'
import { ok, withApi } from '@/lib/api/http'
import { currentSubscription, listPlans, paymentStatus } from '@/lib/payments'

export const dynamic = 'force-dynamic'

export const GET = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const [subscription, plans, events] = await Promise.all([
    currentSubscription(workspaceId),
    listPlans({ includeHidden: true }),
    db.select().from(paymentEvents).where(eq(paymentEvents.workspaceId, workspaceId)).orderBy(desc(paymentEvents.createdAt)).limit(25),
  ])
  return ok({
    ...subscription,
    plans,
    provider: paymentStatus(),
    events,
    note: 'Subscriptions activate only after the payment provider event is verified server-side. Browser redirects are never trusted.',
  })
})
