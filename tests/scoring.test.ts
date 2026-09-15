/**
 * Opportunity scoring tests.
 *
 * Scoring decides what the whole system spends its attention — and money — on,
 * so these tests hold it to three promises: every dimension is produced, the
 * weights used are recorded with the result, and risk tolerance genuinely
 * changes the outcome.
 */
import { describe, expect, it } from 'vitest'
import { SCORE_DIMENSIONS, scoreOpportunity, blendScores, scoringSanityCheck } from '../src/lib/agents/scoring'
import { projectionSanityCheck, PROJECTION_CEILING_MULTIPLIER } from '../src/lib/agents/heuristics'

const STRONG = {
  title: 'Subscription invoicing for independent consultants',
  description:
    'Recurring monthly subscription invoicing tool for freelance consultants. Clear pricing at 29 per month, low operating cost, existing demand from a growing audience, a software product with an API and automation, launchable within a few weeks.',
  category: 'saas',
  sourceName: 'Fixture source',
  sourceReliability: 0.9,
}

const WEAK = {
  title: 'Generic advice blog',
  description: 'Some thoughts about productivity and mindset. No pricing, no audience, no product, unclear who would pay.',
  category: 'content',
  sourceName: 'Fixture source',
  sourceReliability: 0.9,
}

describe('opportunity scoring', () => {
  it('produces a score for every dimension with a final score inside 0–100', () => {
    const result = scoreOpportunity({ ...STRONG, profile: { riskTolerance: 'balanced' } })

    for (const dimension of SCORE_DIMENSIONS) {
      expect(result.scores[dimension], dimension).toBeTypeOf('number')
      expect(result.scores[dimension], dimension).toBeGreaterThanOrEqual(0)
      expect(result.scores[dimension], dimension).toBeLessThanOrEqual(100)
    }
    expect(result.finalScore).toBeGreaterThanOrEqual(0)
    expect(result.finalScore).toBeLessThanOrEqual(100)
    expect(result.engine).toBe('heuristic')
  })

  it('records the weights it used and explains each score', () => {
    const result = scoreOpportunity({ ...STRONG, profile: { riskTolerance: 'balanced' } })

    expect(Object.keys(result.weights).sort()).toEqual([...SCORE_DIMENSIONS].sort())
    const weightTotal = Object.values(result.weights).reduce((sum, value) => sum + value, 0)
    expect(weightTotal).toBeGreaterThan(0.5)
    expect(Object.keys(result.rationale).length).toBe(SCORE_DIMENSIONS.length)
    expect(result.summary.length).toBeGreaterThan(20)
  })

  it('ranks a well-specified recurring product above a vague idea', () => {
    const strong = scoreOpportunity({ ...STRONG, profile: { riskTolerance: 'balanced' } })
    const weak = scoreOpportunity({ ...WEAK, profile: { riskTolerance: 'balanced' } })
    expect(strong.finalScore).toBeGreaterThan(weak.finalScore)
  })

  it('lets risk tolerance change the weighting, not just the wording', () => {
    const conservative = scoreOpportunity({ ...STRONG, profile: { riskTolerance: 'conservative' } })
    const aggressive = scoreOpportunity({ ...STRONG, profile: { riskTolerance: 'aggressive' } })

    expect(conservative.weights).not.toEqual(aggressive.weights)
    expect(conservative.weights.risk).toBeGreaterThan(aggressive.weights.risk)
  })

  it('is deterministic for identical input', () => {
    const first = scoreOpportunity({ ...STRONG, profile: { riskTolerance: 'balanced' } })
    const second = scoreOpportunity({ ...STRONG, profile: { riskTolerance: 'balanced' } })
    expect(second.finalScore).toBe(first.finalScore)
    expect(second.scores).toEqual(first.scores)
  })

  it('weights an opportunity higher when it matches the operator profile', () => {
    const unaligned = scoreOpportunity({ ...STRONG, profile: { riskTolerance: 'balanced', skills: ['welding'], industries: ['construction'] } })
    const aligned = scoreOpportunity({ ...STRONG, profile: { riskTolerance: 'balanced', skills: ['saas', 'api', 'automation'], industries: ['software'] } })

    expect(aligned.weights.difficulty).toBeGreaterThan(unaligned.weights.difficulty)
    expect(aligned.weights.demand).toBeGreaterThan(unaligned.weights.demand)
    expect(aligned.appliedAdjustments.join(' ')).toContain('matching skill')
    expect(aligned.appliedAdjustments.join(' ')).toContain('preferred industr')
  })

  it('applies bounded learning adjustments and explains them', () => {
    const base = scoreOpportunity({ ...STRONG, profile: { riskTolerance: 'balanced' } })
    const adjusted = scoreOpportunity({
      ...STRONG,
      profile: { riskTolerance: 'balanced' },
      learning: { weights: { demand: 1.4 }, categoryBias: { saas: 5 }, notes: ['Recent saas projects outperformed their projection.'] },
    })

    expect(adjusted.appliedAdjustments.length).toBeGreaterThan(0)
    expect(adjusted.appliedAdjustments.join(' ').toLowerCase()).toContain('saas')
    expect(adjusted.weights).not.toEqual(base.weights)
    // Every weight stays a normalised share, so no single dimension can dominate.
    const total = Object.values(adjusted.weights).reduce((sum, value) => sum + value, 0)
    expect(total).toBeCloseTo(1, 5)
    // An explicit learning weight override does change the balance, and the
    // learning agent is what keeps those overrides inside a sane band.
    expect(adjusted.weights.demand).toBeGreaterThan(base.weights.demand)
    // The category bias is a bounded nudge, not a rewrite of the result.
    expect(Math.abs(adjusted.finalScore - base.finalScore)).toBeLessThan(20)
  })

  it('gives every verdict label a coherent score band', () => {
    const verdicts = [STRONG, WEAK, { ...WEAK, title: 'Ambiguous opportunity', description: 'Maybe useful for someone, unclear demand and no pricing.' }].map(
      (input) => scoreOpportunity({ ...input, profile: { riskTolerance: 'balanced' } }),
    )
    for (const result of verdicts) {
      expect(['strong_buy', 'consider', 'watch', 'avoid']).toContain(result.verdict)
      // Confidence is reported on the same 0–100 scale as the scores.
      expect(result.confidence).toBeGreaterThan(0)
      expect(result.confidence).toBeLessThanOrEqual(100)
    }
  })

  it('blends AI scores with the heuristic result instead of replacing it', () => {
    const heuristic = scoreOpportunity({ ...STRONG, profile: { riskTolerance: 'balanced' } })
    const breakdown = Object.fromEntries(SCORE_DIMENSIONS.map((dimension) => [dimension, 20])) as Record<(typeof SCORE_DIMENSIONS)[number], number>
    const blended = blendScores(heuristic, { scores: breakdown, finalScore: 20, confidence: 0.5 }, 0.6)

    expect(blended.finalScore).toBeLessThan(heuristic.finalScore)
    expect(blended.finalScore).toBeGreaterThan(20)
    expect(blended.engine).toBe('heuristic')
  })

  it('flags statistically suspicious score distributions', () => {
    expect(scoringSanityCheck([72, 61, 55, 80]).ok).toBe(true)

    const tooHigh = scoringSanityCheck([95, 96, 97, 98, 99])
    expect(tooHigh.ok).toBe(false)
    expect(tooHigh.message).toBeTruthy()
  })

  it('refuses projections that exceed the honesty ceiling', () => {
    const plausible = projectionSanityCheck({ monthlyRevenueHighCents: 50_000, monthlyCostCents: 5_000, setupCents: 10_000 })
    expect(plausible.ok).toBe(true)

    // 500,000 cents a month against a 1,000 cent outlay implies a 3,000× annual
    // return — far past the ceiling, so it is flagged rather than displayed.
    const absurd = projectionSanityCheck({ monthlyRevenueHighCents: 500_000, monthlyCostCents: 1_000, setupCents: 0 })
    expect(absurd.ok).toBe(false)
    expect(absurd.message).toContain('unrealistic')
    expect(PROJECTION_CEILING_MULTIPLIER).toBeGreaterThan(1)
  })
})
