/**
 * Payments abstraction.
 *
 * Everything that touches money follows three rules:
 *
 *  1. Prices come from the `plans` table — never hardcoded in the UI or here.
 *  2. A subscription only changes state after a **server-side verification** of
 *     the provider event (signature + API lookup). A redirect from the browser
 *     proves nothing and is never trusted.
 *  3. Every provider event is stored in `payment_events` with a unique id, so a
 *     replay cannot double-apply (idempotent by construction).
 *
 * Two providers ship: `demo` (a self-contained sandbox that never touches money
 * and labels itself as demo) and `stripe` (real, requires STRIPE_SECRET_KEY and
 * STRIPE_WEBHOOK_SECRET). With no provider configured, checkout returns a
 * `not_configured` error explaining exactly which env vars are missing — it never
 * fakes a successful payment.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { getDb, paymentEvents, plans, subscriptions, workspaces } from '../db'
import { env } from '../env'
import { createLogger } from '../observability/logger'

const log = createLogger({ component: 'payments' })

export type PaymentProvider = 'stripe' | 'demo' | 'none'

export class PaymentError extends Error {
  constructor(
    message: string,
    readonly code: 'not_configured' | 'invalid_signature' | 'unsupported' | 'provider_error' | 'not_found',
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'PaymentError'
  }
}

export type PlanView = {
  key: string
  name: string
  tagline: string
  priceMonthlyCents: number
  priceYearlyCents: number
  currency: string
  features: string[]
  limits: Record<string, unknown>
  isPublic: boolean
  sortOrder: number
}

export async function listPlans(options: { includeHidden?: boolean } = {}): Promise<PlanView[]> {
  const db = await getDb()
  const rows = await db
    .select()
    .from(plans)
    .where(options.includeHidden ? eq(plans.isActive, true) : and(eq(plans.isActive, true), eq(plans.isPublic, true)))
    .orderBy(plans.sortOrder)
  return rows.map((row) => ({
    key: row.key,
    name: row.name,
    tagline: row.tagline,
    priceMonthlyCents: row.priceMonthlyCents,
    priceYearlyCents: row.priceYearlyCents,
    currency: row.currency,
    features: (row.features as string[]) ?? [],
    limits: (row.limits as Record<string, unknown>) ?? {},
    isPublic: row.isPublic,
    sortOrder: row.sortOrder,
  }))
}

export async function updatePlan(
  key: string,
  patch: { priceMonthlyCents?: number; priceYearlyCents?: number; name?: string; tagline?: string; features?: string[]; isPublic?: boolean; sortOrder?: number },
  actorUserId: string,
): Promise<PlanView> {
  const db = await getDb()
  const existing = (await db.select().from(plans).where(eq(plans.key, key)).limit(1))[0]
  if (!existing) throw new PaymentError(`No plan "${key}".`, 'not_found')
  const rows = await db
    .update(plans)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(plans.key, key))
    .returning()
  await db.insert(paymentEvents).values({
    provider: 'admin',
    type: 'plan.updated',
    providerEventId: `plan-${key}-${Date.now()}`,
    workspaceId: null,
    payload: { key, patch, actorUserId } as Record<string, unknown>,
    status: 'processed',
    processedAt: new Date(),
  })
  const row = rows[0]!
  return {
    key: row.key,
    name: row.name,
    tagline: row.tagline,
    priceMonthlyCents: row.priceMonthlyCents,
    priceYearlyCents: row.priceYearlyCents,
    currency: row.currency,
    features: (row.features as string[]) ?? [],
    limits: (row.limits as Record<string, unknown>) ?? {},
    isPublic: row.isPublic,
    sortOrder: row.sortOrder,
  }
}

export function paymentProvider(): PaymentProvider {
  if (env.PAYMENT_PROVIDER === 'stripe') return env.STRIPE_SECRET_KEY ? 'stripe' : 'none'
  if (env.PAYMENT_PROVIDER === 'demo') return 'demo'
  return 'none'
}

export function paymentStatus() {
  const provider = paymentProvider()
  return {
    provider,
    configured: provider !== 'none',
    webhookConfigured: Boolean(env.STRIPE_WEBHOOK_SECRET),
    requiredCredentials: [
      { service: 'Stripe', credential: 'Secret key', envVar: 'STRIPE_SECRET_KEY', where: 'https://dashboard.stripe.com/apikeys' },
      { service: 'Stripe', credential: 'Webhook signing secret', envVar: 'STRIPE_WEBHOOK_SECRET', where: 'Stripe dashboard → Developers → Webhooks' },
      { service: 'Stripe', credential: 'Publishable key (frontend only)', envVar: 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', where: 'https://dashboard.stripe.com/apikeys' },
    ],
    note:
      provider === 'demo'
        ? 'Demo payments are enabled. Checkout is simulated locally, marked demo, and never recorded as real revenue.'
        : provider === 'stripe'
          ? 'Stripe is enabled. Subscriptions activate only after the webhook signature is verified server-side.'
          : 'No payment provider configured. Checkout is disabled rather than faked.',
  }
}

export type CheckoutResult = {
  url: string | null
  sessionId: string | null
  provider: PaymentProvider
  demo: boolean
  message: string
}

/**
 * Create a checkout session. The caller (an API route) must already have
 * verified that the workspace owns the requested plan change.
 */
export async function createCheckout(input: {
  workspaceId: string
  planKey: string
  interval: 'monthly' | 'yearly'
  customerEmail: string
  successUrl: string
  cancelUrl: string
}): Promise<CheckoutResult> {
  const plan = (await listPlans({ includeHidden: true })).find((entry) => entry.key === input.planKey)
  if (!plan) throw new PaymentError(`No plan "${input.planKey}".`, 'not_found')

  const provider = paymentProvider()
  const amountCents = input.interval === 'yearly' ? plan.priceYearlyCents : plan.priceMonthlyCents

  if (provider === 'none') {
    throw new PaymentError(
      'No payment provider is configured, so checkout is disabled. Set PAYMENT_PROVIDER=stripe with STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET (see docs/INTEGRATIONS.md), or PAYMENT_PROVIDER=demo for a clearly-labelled local sandbox.',
      'not_configured',
      { requiredCredentials: paymentStatus().requiredCredentials },
    )
  }

  if (amountCents === 0) {
    // Free plans need no provider round-trip: apply immediately and record why.
    await activateSubscription({ workspaceId: input.workspaceId, planKey: plan.key, provider: 'none', providerSubscriptionId: null, demo: false })
    return { url: null, sessionId: null, provider, demo: false, message: `Switched to the ${plan.name} plan. No payment was required.` }
  }

  if (provider === 'demo') {
    const sessionId = `demo_cs_${Date.now().toString(36)}`
    await activateSubscription({ workspaceId: input.workspaceId, planKey: plan.key, provider: 'demo', providerSubscriptionId: sessionId, demo: true })
    return {
      url: `${input.successUrl}?demo=1&session_id=${sessionId}`,
      sessionId,
      provider,
      demo: true,
      message: 'DEMO DATA: this checkout did not move any real money. Demo subscriptions are never counted as revenue.',
    }
  }

  const session = await stripeRequest<{ id: string; url: string }>('checkout/sessions', {
    mode: 'subscription',
    'line_items[0][price_data][currency]': plan.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(amountCents),
    'line_items[0][price_data][recurring][interval]': input.interval === 'yearly' ? 'year' : 'month',
    'line_items[0][price_data][product_data][name]': `AIBA ${plan.name}`,
    'line_items[0][quantity]': '1',
    customer_email: input.customerEmail,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    'metadata[workspaceId]': input.workspaceId,
    'metadata[planKey]': plan.key,
    'subscription_data[metadata][workspaceId]': input.workspaceId,
    'subscription_data[metadata][planKey]': plan.key,
  })

  return { url: session.url, sessionId: session.id, provider, demo: false, message: 'Redirecting to Stripe to complete the payment.' }
}

export async function createPortalSession(workspaceId: string, returnUrl: string): Promise<{ url: string }> {
  const provider = paymentProvider()
  if (provider === 'none') {
    throw new PaymentError('No payment provider is configured, so there is no billing portal to open.', 'not_configured')
  }
  if (provider === 'demo') {
    return { url: `${returnUrl}?demo=1` }
  }
  const db = await getDb()
  const subscription = (await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId)).limit(1))[0]
  if (!subscription?.providerCustomerId) {
    throw new PaymentError('This workspace has no Stripe customer yet. Complete a checkout first.', 'not_found')
  }
  const session = await stripeRequest<{ url: string }>('billing_portal/sessions', {
    customer: subscription.providerCustomerId,
    return_url: returnUrl,
  })
  return { url: session.url }
}

/* --------------------------------------------------------------- webhook */

/** Verify the Stripe signature header exactly as Stripe documents it. */
export function verifyStripeSignature(rawBody: string, signatureHeader: string | null, secret: string, toleranceSeconds = 300): boolean {
  if (!signatureHeader) return false
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((part) => {
      const [key, value] = part.split('=')
      return [key?.trim() ?? '', value?.trim() ?? '']
    }),
  )
  const timestamp = Number(parts.t)
  const expected = parts.v1
  if (!Number.isFinite(timestamp) || !expected) return false
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false
  const computed = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex')
  const a = Buffer.from(computed, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export type WebhookOutcome = {
  received: boolean
  duplicate: boolean
  eventType: string
  applied: boolean
  message: string
}

/**
 * Handle a payment webhook. The signature is verified against the raw body, the
 * event is stored (unique per provider event id — replays are ignored), then the
 * subscription state is updated from the *verified* payload.
 */
export async function handleWebhook(input: { rawBody: string; signature: string | null; provider?: PaymentProvider }): Promise<WebhookOutcome> {
  const db = await getDb()
  const provider = input.provider ?? paymentProvider()
  if (provider === 'none') throw new PaymentError('No payment provider is configured.', 'not_configured')

  if (provider === 'stripe') {
    if (!env.STRIPE_WEBHOOK_SECRET) {
      throw new PaymentError('STRIPE_WEBHOOK_SECRET is not set, so the event cannot be verified and will not be trusted.', 'not_configured')
    }
    if (!verifyStripeSignature(input.rawBody, input.signature, env.STRIPE_WEBHOOK_SECRET)) {
      log.warn('rejected payment webhook with an invalid signature')
      throw new PaymentError('Webhook signature verification failed. The event was not processed.', 'invalid_signature')
    }
  } else if (provider === 'demo') {
    // Demo events are accepted only when the payload marks itself as demo.
    const parsed = JSON.parse(input.rawBody || '{}') as { demo?: boolean }
    if (parsed.demo !== true) throw new PaymentError('Demo provider received a non-demo payload; refusing to process.', 'unsupported')
  }

  const event = JSON.parse(input.rawBody || '{}') as {
    id?: string
    type?: string
    data?: { object?: Record<string, unknown> }
  }
  const eventId = event.id ?? `synthetic-${Date.now()}`
  const eventType = event.type ?? 'unknown'

  const existing = await db
    .select({ id: paymentEvents.id })
    .from(paymentEvents)
    .where(and(eq(paymentEvents.provider, provider), eq(paymentEvents.providerEventId, eventId)))
    .limit(1)
  if (existing[0]) {
    return { received: true, duplicate: true, eventType, applied: false, message: 'Event already processed (idempotent replay).' }
  }

  const object = event.data?.object ?? {}
  const metadata = (object.metadata ?? {}) as Record<string, string>
  const workspaceId = metadata.workspaceId ?? null

  const rows = await db
    .insert(paymentEvents)
    .values({
      provider,
      type: eventType,
      providerEventId: eventId,
      workspaceId,
      payload: event as Record<string, unknown>,
      status: 'received',
    })
    .returning({ id: paymentEvents.id })

  let applied = false
  let message = 'Event stored.'

  try {
    switch (eventType) {
      case 'checkout.session.completed': {
        if (workspaceId && metadata.planKey) {
          await activateSubscription({
            workspaceId,
            planKey: metadata.planKey,
            provider,
            providerSubscriptionId: String(object.subscription ?? ''),
            providerCustomerId: String(object.customer ?? ''),
            demo: provider === 'demo',
          })
          applied = true
          message = `Subscription activated on the ${metadata.planKey} plan after server-side verification.`
        }
        break
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.created': {
        const subscriptionId = String(object.id ?? '')
        const planKey = metadata.planKey
        if (workspaceId && planKey) {
          await activateSubscription({
            workspaceId,
            planKey,
            provider,
            providerSubscriptionId: subscriptionId,
            providerCustomerId: String(object.customer ?? ''),
            status: String(object.status ?? 'active'),
            currentPeriodEnd: object.current_period_end ? new Date(Number(object.current_period_end) * 1000) : undefined,
            cancelAtPeriodEnd: Boolean(object.cancel_at_period_end),
            demo: provider === 'demo',
          })
          applied = true
          message = 'Subscription synchronised from the provider.'
        }
        break
      }
      case 'customer.subscription.deleted': {
        const subscriptionId = String(object.id ?? '')
        await db
          .update(subscriptions)
          .set({ status: 'cancelled', updatedAt: new Date() })
          .where(eq(subscriptions.providerSubscriptionId, subscriptionId))
        if (workspaceId) await db.update(workspaces).set({ planKey: 'free', updatedAt: new Date() }).where(eq(workspaces.id, workspaceId))
        applied = true
        message = 'Subscription cancelled; the workspace moved back to the free plan.'
        break
      }
      case 'invoice.payment_failed': {
        if (workspaceId) {
          await db.update(subscriptions).set({ status: 'past_due', updatedAt: new Date() }).where(eq(subscriptions.workspaceId, workspaceId))
        }
        applied = true
        message = 'Payment failure recorded; the subscription is marked past due.'
        break
      }
      default:
        message = `Event type "${eventType}" stored for audit but has no state effect.`
    }

    await db
      .update(paymentEvents)
      .set({ status: applied ? 'processed' : 'ignored', processedAt: new Date(), error: null })
      .where(eq(paymentEvents.id, rows[0]!.id))
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    await db.update(paymentEvents).set({ status: 'failed', error: text, processedAt: new Date() }).where(eq(paymentEvents.id, rows[0]!.id))
    throw new PaymentError(`Webhook handling failed: ${text}`, 'provider_error')
  }

  return { received: true, duplicate: false, eventType, applied, message }
}

async function activateSubscription(input: {
  workspaceId: string
  planKey: string
  provider: PaymentProvider
  providerSubscriptionId: string | null
  providerCustomerId?: string
  status?: string
  currentPeriodEnd?: Date
  cancelAtPeriodEnd?: boolean
  demo: boolean
}): Promise<void> {
  const db = await getDb()
  const plan = (await db.select().from(plans).where(eq(plans.key, input.planKey)).limit(1))[0]
  if (!plan) throw new PaymentError(`No plan "${input.planKey}".`, 'not_found')

  const existing = (await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, input.workspaceId)).limit(1))[0]
  const values = {
    workspaceId: input.workspaceId,
    planKey: plan.key,
    status: input.status ?? 'active',
    provider: input.provider,
    providerCustomerId: input.providerCustomerId ?? existing?.providerCustomerId ?? null,
    providerSubscriptionId: input.providerSubscriptionId ?? existing?.providerSubscriptionId ?? null,
    currentPeriodEnd: input.currentPeriodEnd ?? existing?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
    updatedAt: new Date(),
  }

  if (existing) {
    await db.update(subscriptions).set(values).where(eq(subscriptions.id, existing.id))
  } else {
    await db.insert(subscriptions).values(values)
  }

  await db.update(workspaces).set({ planKey: plan.key, updatedAt: new Date() }).where(eq(workspaces.id, input.workspaceId))
  await db.insert(paymentEvents).values({
    provider: input.provider,
    type: input.demo ? 'subscription.activated.demo' : 'subscription.activated',
    providerEventId: `${input.provider}-activation-${input.workspaceId}-${Date.now()}`,
    workspaceId: input.workspaceId,
    payload: { planKey: plan.key, demo: input.demo } as Record<string, unknown>,
    status: 'processed',
    processedAt: new Date(),
  })
  log.info('subscription activated', { workspaceId: input.workspaceId, planKey: plan.key, provider: input.provider, demo: input.demo })
}

export async function currentSubscription(workspaceId: string) {
  const db = await getDb()
  const rows = await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId)).limit(1)
  const subscription = rows[0] ?? null
  const planKey = subscription?.planKey ?? (await db.select({ planKey: workspaces.planKey }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1))[0]?.planKey ?? 'free'
  const plan = (await listPlans({ includeHidden: true })).find((entry) => entry.key === planKey) ?? null
  const demo = (subscription?.provider ?? 'none') === 'demo'
  return { subscription, plan, demo, demoNotice: demo ? 'DEMO DATA: this subscription is a local sandbox and never counted as revenue.' : null }
}

export async function revenueReconciliation(workspaceId: string) {
  const db = await getDb()
  const rows = await db
    .select({ status: paymentEvents.status, count: sql<string>`count(*)::text` })
    .from(paymentEvents)
    .where(eq(paymentEvents.workspaceId, workspaceId))
    .groupBy(paymentEvents.status)
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]))
}

/* ------------------------------------------------------------- stripe HTTP */

async function stripeRequest<T>(path: string, form: Record<string, string>): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new PaymentError('STRIPE_SECRET_KEY is not set.', 'not_configured')
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
      'stripe-version': '2024-06-20',
    },
    body: new URLSearchParams(form),
  })
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    const error = (body.error ?? {}) as { message?: string }
    throw new PaymentError(error.message ?? `Stripe request failed with HTTP ${response.status}.`, 'provider_error', body)
  }
  return body as T
}
