/**
 * Compliance policy tests.
 *
 * The policy module is the last line of defence: it decides whether an action
 * may run at all, and whether a human must decide first. These tests pin the
 * contract that every caller depends on (allowed=false means "do not execute").
 */
import { describe, expect, it } from 'vitest'
import { evaluateAction, inspectContent, sanitizeClaims, POLICY_RULES } from '../src/lib/compliance/policy'

describe('compliance policy', () => {
  it('permanently disables every prohibited action class', () => {
    const prohibited = ['financial_trade', 'crypto_mining', 'scrape_private_data', 'bypass_captcha', 'bypass_paywall', 'bulk_scrape', 'post_review'] as const

    for (const actionType of prohibited) {
      const decision = evaluateAction({ actionType, automationLevel: 'autonomous_low_risk' })
      expect(decision.allowed, actionType).toBe(false)
      expect(decision.requiresApproval, actionType).toBe(false)
      expect(decision.risk, actionType).toBe('prohibited')
      expect(decision.reason.toLowerCase(), actionType).toContain('permanently disabled')
    }
  })

  it('fails closed for an unknown action name', () => {
    // @ts-expect-error deliberately invalid action name
    const decision = evaluateAction({ actionType: 'delete_everything', automationLevel: 'autonomous_low_risk' })
    expect(decision.allowed).toBe(false)
    expect(decision.violations).toContain('unrecognised_action')
  })

  it('requires human approval for high-risk actions even at the most autonomous level', () => {
    for (const actionType of ['publish_content', 'send_marketing_email', 'make_purchase', 'run_ad_campaign', 'delete_data'] as const) {
      const decision = evaluateAction({ actionType, automationLevel: 'autonomous_low_risk' })
      expect(decision.allowed, actionType).toBe(false)
      expect(decision.requiresApproval, actionType).toBe(true)
    }
  })

  it('allows a low-risk scan with no cost at the autonomous level', () => {
    const decision = evaluateAction({ actionType: 'research_scan', automationLevel: 'autonomous_low_risk', estimatedCostCents: 0 })
    expect(decision.allowed).toBe(true)
    expect(decision.requiresApproval).toBe(false)
    expect(decision.violations).toEqual([])
  })

  it('stops approval-required operators on everything that is not low risk', () => {
    const allowed = evaluateAction({ actionType: 'clean_data', automationLevel: 'approval_required', estimatedCostCents: 5 })
    expect(allowed.allowed).toBe(true)

    const blocked = evaluateAction({ actionType: 'send_transactional_email', automationLevel: 'approval_required', estimatedCostCents: 5 })
    expect(blocked.allowed).toBe(false)
    expect(blocked.requiresApproval).toBe(true)
  })

  it('never recommends a cost that exceeds the action ceiling', () => {
    const decision = evaluateAction({ actionType: 'research_scan', automationLevel: 'autonomous_low_risk', estimatedCostCents: 5000 })
    expect(decision.allowed).toBe(false)
    expect(decision.requiresApproval).toBe(true)
    expect(decision.reason).toContain('50.00')
  })

  it('refuses recommendation-only operators with a description instead of an execution', () => {
    const decision = evaluateAction({ actionType: 'research_scan', automationLevel: 'recommend_only' })
    expect(decision.allowed).toBe(false)
    expect(decision.requiresApproval).toBe(true)
    expect(decision.reason).toContain('recommendation only')
  })

  it('blocks payloads that reference credentials, captchas or fake accounts', () => {
    const decision = evaluateAction({
      actionType: 'research_scan',
      automationLevel: 'autonomous_low_risk',
      payload: { target: 'https://example.com', bypassCaptcha: true },
    })
    expect(decision.allowed).toBe(false)
    expect(decision.violations.join(' ')).toContain('captcha')
  })

  it('keeps a reason and label on every rule and flags prohibited claims in content', () => {
    for (const [action, rule] of Object.entries(POLICY_RULES)) {
      expect(rule.reason.length, action).toBeGreaterThan(10)
      expect(rule.label.length, action).toBeGreaterThan(3)
    }

    const clean = inspectContent('A plain product description with no promises about income.')
    expect(clean.clean).toBe(true)

    const dirty = inspectContent('This system guarantees income while you do nothing.')
    expect(dirty.clean).toBe(false)
    expect(dirty.violations.length).toBeGreaterThan(0)

    const sanitized = sanitizeClaims('This system guarantees income while you do nothing.')
    expect(sanitized.changed.length).toBeGreaterThan(0)
    expect(sanitized.content).not.toContain('guarantees income')
    // The scanner is deliberately stricter than the rewriter: any remaining
    // mention of a guarantee keeps the text flagged for human review, so a
    // sanitised draft can never be published silently.
    expect(inspectContent(sanitized.content).clean).toBe(false)
    expect(inspectContent(sanitized.content).violations).toContain('guarantee claim')
  })
})
