/**
 * POST /api/billing/webhook — payment provider webhook.
 *
 * This route is unauthenticated *by design* (the provider cannot hold a session)
 * and therefore never trusts the request body: the signature is verified against
 * the raw bytes with the configured webhook secret, and the event id is unique so
 * replays cannot double-apply. Until that verification passes, no subscription
 * state changes.
 */
import { NextResponse } from 'next/server'
import { PaymentError, handleWebhook } from '@/lib/payments'
import { createLogger } from '@/lib/observability/logger'

export const dynamic = 'force-dynamic'

const log = createLogger({ component: 'billing-webhook' })

export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get('stripe-signature')

  try {
    const outcome = await handleWebhook({ rawBody, signature })
    log.info('payment webhook processed', { eventType: outcome.eventType, duplicate: outcome.duplicate, applied: outcome.applied })
    return NextResponse.json({ received: true, duplicate: outcome.duplicate, applied: outcome.applied, message: outcome.message })
  } catch (error) {
    if (error instanceof PaymentError) {
      const status = error.code === 'invalid_signature' ? 400 : error.code === 'not_configured' ? 501 : 400
      log.warn('payment webhook rejected', { code: error.code, message: error.message })
      return NextResponse.json({ received: false, error: { code: error.code, message: error.message } }, { status })
    }
    const message = error instanceof Error ? error.message : 'webhook failed'
    log.error('payment webhook failed', error)
    return NextResponse.json({ received: false, error: { code: 'internal_error', message } }, { status: 500 })
  }
}
