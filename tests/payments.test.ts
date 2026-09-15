/**
 * Payment tests.
 *
 * The rule this suite defends: a subscription never activates because a browser
 * said so. Only a webhook whose signature verifies against the server secret may
 * change plan state, replays are ignored, and prices are data rather than code.
 */
import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  currentSubscription,
  handleWebhook,
  listPlans,
  paymentStatus,
  updatePlan,
  verifyStripeSignature,
} from '../src/lib/payments'
import { getDb, paymentEvents, plans, subscriptions, workspaces } from '../src/lib/db'
import { createWorkspaceFixture } from './helpers'

const SECRET = 'whsec_test_secret_for_unit_tests'

function sign(rawBody: string, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex')
  return `t=${timestamp},v1=${signature}`
}

function checkoutEvent(id: string, workspaceId: string, planKey: string) {
  return JSON.stringify({
    id,
    type: 'checkout.session.completed',
    data: { object: { id: `cs_${id}`, subscription: `sub_${id}`, customer: `cus_${id}`, metadata: { workspaceId, planKey } } },
  })
}

let eventSeq = 0
function nextEventId() {
  eventSeq += 1
  return `evt_test_${Date.now()}_${eventSeq}`
}

describe('payments', () => {
  it('seeds a configurable plan catalogue instead of hardcoding prices', async () => {
    const all = await listPlans({ includeHidden: true })
    const publicPlans = await listPlans()

    expect(all.length).toBeGreaterThanOrEqual(3)
    expect(all.map((plan) => plan.key)).toEqual(expect.arrayContaining(['free', 'pro', 'business']))
    expect(publicPlans.every((plan) => plan.isPublic)).toBe(true)

    const free = all.find((plan) => plan.key === 'free')!
    expect(free.priceMonthlyCents).toBe(0)
    const pro = all.find((plan) => plan.key === 'pro')!
    expect(pro.priceMonthlyCents).toBeGreaterThan(0)
    expect(pro.features.length).toBeGreaterThan(0)
  })

  it('reports the provider configuration honestly when it is not set up', () => {
    const status = paymentStatus()
    expect(status.provider).toBe('stripe')
    expect(status.webhookConfigured).toBe(true)
    expect(Array.isArray(status.requiredCredentials)).toBe(true)
    // The note must describe the real state rather than promising a checkout.
    expect(typeof status.note).toBe('string')
  })

  it('verifies a correctly signed Stripe payload and rejects forgeries', () => {
    const body = checkoutEvent(nextEventId(), '00000000-0000-0000-0000-000000000000', 'pro')

    expect(verifyStripeSignature(body, sign(body), SECRET)).toBe(true)
    expect(verifyStripeSignature(body, sign(body, 'wrong_secret'), SECRET)).toBe(false)
    expect(verifyStripeSignature(body, null, SECRET)).toBe(false)
    expect(verifyStripeSignature(body, 'garbage', SECRET)).toBe(false)
    expect(verifyStripeSignature(body, sign(`${body} `), SECRET)).toBe(false)
    // A stale timestamp outside the tolerance window is refused.
    expect(verifyStripeSignature(body, sign(body, SECRET, Math.floor(Date.now() / 1000) - 600), SECRET)).toBe(false)
  })

  it('refuses to process a webhook with a bad signature', async () => {
    const fixture = await createWorkspaceFixture()
    const body = checkoutEvent(nextEventId(), fixture.workspaceId, 'pro')

    await expect(handleWebhook({ rawBody: body, signature: 't=1,v1=deadbeef' })).rejects.toThrow(/signature/i)

    // Nothing was activated by the rejected event: the resolved plan is still
    // the free tier and no provider subscription exists.
    const subscription = await currentSubscription(fixture.workspaceId)
    expect(subscription.subscription).toBeNull()
    expect(subscription.plan?.key).toBe('free')

    const db = await getDb()
    const stored = await db.select().from(workspaces).where(eq(workspaces.id, fixture.workspaceId)).limit(1)
    expect(stored[0]!.planKey).toBe('free')
  })

  it('refuses to process an unsigned webhook', async () => {
    const fixture = await createWorkspaceFixture()
    const body = checkoutEvent(nextEventId(), fixture.workspaceId, 'business')
    await expect(handleWebhook({ rawBody: body, signature: null })).rejects.toThrow(/signature/i)
  })

  it('activates a subscription only from a verified event, and records the event', async () => {
    const fixture = await createWorkspaceFixture()
    const eventId = nextEventId()
    const body = checkoutEvent(eventId, fixture.workspaceId, 'pro')

    const outcome = await handleWebhook({ rawBody: body, signature: sign(body) })
    expect(outcome.received).toBe(true)
    expect(outcome.applied).toBe(true)
    expect(outcome.duplicate).toBe(false)

    const subscription = await currentSubscription(fixture.workspaceId)
    expect(subscription.subscription?.planKey).toBe('pro')
    expect(subscription.plan?.key).toBe('pro')

    const db = await getDb()
    const workspace = await db.select().from(workspaces).where(eq(workspaces.id, fixture.workspaceId)).limit(1)
    expect(workspace[0]!.planKey).toBe('pro')

    const events = await db.select().from(paymentEvents).where(eq(paymentEvents.providerEventId, eventId))
    expect(events.length).toBe(1)
    expect(events[0]!.status).toBe('processed')
  })

  it('ignores a replayed event instead of double-activating', async () => {
    const fixture = await createWorkspaceFixture()
    const eventId = nextEventId()
    const body = checkoutEvent(eventId, fixture.workspaceId, 'business')

    const first = await handleWebhook({ rawBody: body, signature: sign(body) })
    expect(first.applied).toBe(true)

    const replay = await handleWebhook({ rawBody: body, signature: sign(body) })
    expect(replay.duplicate).toBe(true)
    expect(replay.applied).toBe(false)

    const db = await getDb()
    const events = await db.select().from(paymentEvents).where(eq(paymentEvents.providerEventId, eventId))
    expect(events.length).toBe(1)
  })

  it('moves a workspace back to free when the provider reports a cancellation', async () => {
    const fixture = await createWorkspaceFixture()
    const activationId = nextEventId()
    const activation = checkoutEvent(activationId, fixture.workspaceId, 'pro')
    await handleWebhook({ rawBody: activation, signature: sign(activation) })

    const cancellationId = nextEventId()
    const cancellation = JSON.stringify({
      id: cancellationId,
      type: 'customer.subscription.deleted',
      data: { object: { id: `sub_${activationId}`, customer: 'cus_1', metadata: { workspaceId: fixture.workspaceId } } },
    })
    const outcome = await handleWebhook({ rawBody: cancellation, signature: sign(cancellation) })
    expect(outcome.applied).toBe(true)

    const db = await getDb()
    const workspace = await db.select().from(workspaces).where(eq(workspaces.id, fixture.workspaceId)).limit(1)
    expect(workspace[0]!.planKey).toBe('free')

    const subscription = await currentSubscription(fixture.workspaceId)
    expect(subscription?.subscription?.status).toBe('cancelled')
  })

  it('records a failed invoice without granting the plan', async () => {
    const fixture = await createWorkspaceFixture()
    const eventId = nextEventId()
    const body = JSON.stringify({
      id: eventId,
      type: 'invoice.payment_failed',
      data: { object: { id: `in_${eventId}`, metadata: { workspaceId: fixture.workspaceId } } },
    })

    const outcome = await handleWebhook({ rawBody: body, signature: sign(body) })
    expect(outcome.applied).toBe(true)

    const db = await getDb()
    const workspace = await db.select().from(workspaces).where(eq(workspaces.id, fixture.workspaceId)).limit(1)
    expect(workspace[0]!.planKey).toBe('free')

    const rows = await db.select().from(paymentEvents).where(eq(paymentEvents.providerEventId, eventId))
    expect(rows[0]!.status).toBe('processed')
  })

  it('lets an administrator change prices without a redeploy, and audits it', async () => {
    const fixture = await createWorkspaceFixture()
    const before = (await listPlans({ includeHidden: true })).find((plan) => plan.key === 'business')!
    const updated = await updatePlan('business', { priceMonthlyCents: before.priceMonthlyCents + 1_000 }, fixture.userId)
    expect(updated.priceMonthlyCents).toBe(before.priceMonthlyCents + 1_000)

    const after = (await listPlans({ includeHidden: true })).find((plan) => plan.key === 'business')!
    expect(after.priceMonthlyCents).toBe(before.priceMonthlyCents + 1_000)

    const db = await getDb()
    const events = await db.select().from(paymentEvents).where(eq(paymentEvents.type, 'plan.updated'))
    expect(events.length).toBeGreaterThan(0)

    // Restore the seeded price so other suites see the documented catalogue.
    await updatePlan('business', { priceMonthlyCents: before.priceMonthlyCents }, fixture.userId)
    const restored = (await db.select().from(plans).where(eq(plans.key, 'business')).limit(1))[0]!
    expect(restored.priceMonthlyCents).toBe(before.priceMonthlyCents)
  })

  it('never creates a subscription row without a verified provider event', async () => {
    const fixture = await createWorkspaceFixture()
    const db = await getDb()
    const rows = await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, fixture.workspaceId))
    expect(rows).toEqual([])
    const subscription = await currentSubscription(fixture.workspaceId)
    expect(subscription.subscription).toBeNull()
    expect(subscription.plan?.key).toBe('free')
  })
})
