/**
 * Opportunity scoring engine.
 *
 * Deterministic and explainable by design: the same input always produces the
 * same score, and every dimension carries a written rationale that the UI shows
 * to the user. The AI analysis agent uses this as its baseline and may adjust
 * it; the learning agent adjusts the weights from realised outcomes.
 *
 * All ten dimensions are oriented so that **higher is better for the operator**
 * (i.e. "competition" scores high when competition is low, "risk" scores high
 * when risk is low).
 */
import type { RawSignal, SourceCategory } from './sources'

export const SCORE_DIMENSIONS = [
  'demand',
  'competition',
  'monetization',
  'startupCost',
  'operatingCost',
  'automationPotential',
  'scalability',
  'timeToRevenue',
  'difficulty',
  'risk',
] as const

export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number]

export type ScoreWeights = Record<ScoreDimension, number>

/** Default weights sum to 1.0. The learning agent nudges these over time. */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  demand: 0.2,
  competition: 0.12,
  monetization: 0.18,
  startupCost: 0.08,
  operatingCost: 0.07,
  automationPotential: 0.12,
  scalability: 0.08,
  timeToRevenue: 0.05,
  difficulty: 0.05,
  risk: 0.05,
}

export type ScoreBreakdown = Record<ScoreDimension, number>

export type ScoringProfile = {
  currency?: string
  country?: string
  riskTolerance?: string
  skills?: string[]
  industries?: string[]
  monetizationPreferences?: string[]
  businessModels?: string[]
  dailyBudgetCents?: number
  monthlyBudgetCents?: number
  maxOperatingCostCentsMonth?: number
  minTimeToRevenueDays?: number
  scoreThreshold?: number
}

export type LearningAdjustments = {
  weights?: Partial<ScoreWeights>
  categoryBias?: Record<string, number>
  sourceBias?: Record<string, number>
  keywordBiases?: Record<string, number>
  /** Human-readable notes explaining why weights moved. */
  notes?: string[]
}

export type ScoreInput = {
  title: string
  description: string
  category: string
  sourceName?: string
  sourceReliability?: number
  url?: string | null
  region?: string | null
  profile?: ScoringProfile
  learning?: LearningAdjustments
}

export type ScoreResult = {
  scores: ScoreBreakdown
  finalScore: number
  confidence: number
  verdict: 'strong_buy' | 'consider' | 'watch' | 'avoid'
  summary: string
  rationale: Record<string, string>
  weights: ScoreWeights
  appliedAdjustments: string[]
  engine: 'heuristic'
}

/* --------------------------------------------------------------- taxonomies */

const MONETIZATION_STRONG = [
  'subscription',
  'recurring',
  'saas',
  'mrr',
  'pricing',
  'paid',
  'license',
  'licence',
  'retainer',
  'annual',
  'enterprise',
  'commission',
  'affiliate',
  'marketplace',
  'per seat',
  'revenue',
  'budget',
  'paid plan',
  'invoice',
]
const MONETIZATION_WEAK = ['free', 'volunteer', 'hobby', 'unpaid', 'open source only', 'no budget', 'for exposure']

const DEMAND_SIGNALS = [
  'looking for',
  'need a',
  'need an',
  'willing to pay',
  'recommend',
  'struggling',
  'frustrat',
  'urgent',
  'deadline',
  'can\'t find',
  'cannot find',
  'alternative to',
  'hiring',
  'request',
  'help wanted',
  'how do you',
  'best way to',
  'manual process',
  'spreadsheet',
  'wasting time',
  'hours a week',
  'every week',
]

const COMPETITION_SIGNALS_HIGH = ['dominated', 'saturated', 'many competitors', 'crowded', 'red ocean', 'well served']
const COMPETITION_SIGNALS_LOW = ['no existing', 'underserved', 'nobody', 'nothing exists', 'gap', 'niche', 'specific', 'local', 'regional']

const LOW_STARTUP_COST = ['no code', 'nocode', 'api', 'template', 'existing tool', 'open source', 'free tier', 'cloud', 'serverless', 'newsletter', 'landing page', 'marketplace listing']
const HIGH_STARTUP_COST = ['hardware', 'inventory', 'licence', 'license fee', 'physical product', 'warehouse', 'manufactur', 'patent', 'compliance certification', 'iso ', 'medical device', 'banking licence']

const LOW_OPERATING_COST = ['automated', 'self-serve', 'one-time build', 'static site', 'content', 'community', 'affiliate', 'passive', 'template']
const HIGH_OPERATING_COST = ['24/7 support', 'call center', 'call centre', 'manual fulfilment', 'physical delivery', 'field service', 'on-site', 'staffed', 'per-transaction fee', 'human review']

const AUTOMATION_SIGNALS = ['automate', 'automation', 'api', 'integration', 'workflow', 'script', 'bot', 'cron', 'scheduled', 'self-serve', 'saas', 'digital', 'template', 'generator']
const MANUAL_SIGNALS = ['consulting only', 'bespoke', 'white glove', 'hands-on', 'phone calls', 'in-person', 'door to door', 'manual labour', 'manual labor']

const SCALABILITY_SIGNALS = ['digital', 'software', 'content', 'course', 'newsletter', 'template', 'marketplace', 'api', 'global', 'repeatable', 'productized']
const POOR_SCALABILITY_SIGNALS = ['1:1', 'one on one', 'custom project', 'local only', 'single client', 'hourly', 'time-based']

const FAST_REVENUE_SIGNALS = ['pre-sale', 'presale', 'immediately', 'this week', 'already paying', 'existing customers', 'quick win', 'service', 'freelance', 'consulting', 'template sale', 'affiliate']
const SLOW_REVENUE_SIGNALS = ['year', 'long sales cycle', 'enterprise sales', 'regulatory approval', 'clinical', 'grant', 'seed round', 'funding']

const RISK_SIGNALS_HIGH = [
  'legal',
  'regulation',
  'regulatory',
  'licence required',
  'license required',
  'compliance',
  'gdpr',
  'hipaa',
  'financial advice',
  'medical',
  'crypto',
  'gambling',
  'trading',
  'securities',
  'insurance',
  'credit',
  'lending',
  'minor',
  'children',
  'health data',
  'personal data',
]
const RISK_SIGNALS_LOW = ['b2b', 'internal tool', 'public data', 'newsletter', 'informational', 'directory', 'template', 'printable']

/** Category priors encode average difficulty/cost/time observed across the market. */
const CATEGORY_PRIORS: Record<string, { startup: number; operating: number; timeToRevenue: number; scalability: number; automation: number; risk: number }> = {
  saas_opportunity: { startup: 55, operating: 55, timeToRevenue: 45, scalability: 85, automation: 82, risk: 62 },
  digital_product: { startup: 80, operating: 80, timeToRevenue: 65, scalability: 80, automation: 78, risk: 78 },
  content_opportunity: { startup: 85, operating: 70, timeToRevenue: 45, scalability: 78, automation: 72, risk: 82 },
  affiliate_opportunity: { startup: 88, operating: 68, timeToRevenue: 55, scalability: 74, automation: 70, risk: 68 },
  lead_generation: { startup: 72, operating: 62, timeToRevenue: 68, scalability: 66, automation: 64, risk: 70 },
  freelance_opportunity: { startup: 92, operating: 60, timeToRevenue: 88, scalability: 32, automation: 38, risk: 80 },
  public_business_request: { startup: 78, operating: 62, timeToRevenue: 76, scalability: 45, automation: 55, risk: 72 },
  underserved_market: { startup: 62, operating: 58, timeToRevenue: 52, scalability: 70, automation: 66, risk: 64 },
  local_business: { startup: 60, operating: 50, timeToRevenue: 62, scalability: 40, automation: 45, risk: 70 },
  partnership: { startup: 82, operating: 72, timeToRevenue: 50, scalability: 68, automation: 50, risk: 58 },
  emerging_niche: { startup: 66, operating: 64, timeToRevenue: 48, scalability: 72, automation: 68, risk: 52 },
  useful_tool: { startup: 70, operating: 66, timeToRevenue: 58, scalability: 76, automation: 74, risk: 72 },
  other: { startup: 62, operating: 60, timeToRevenue: 55, scalability: 60, automation: 60, risk: 60 },
}

/* ------------------------------------------------------------------- engine */

function contains(haystack: string, needles: string[]): string[] {
  return needles.filter((needle) => haystack.includes(needle))
}

function bump(base: number, delta: number, min = 0, max = 100): number {
  return Math.round(Math.min(max, Math.max(min, base + delta)))
}

export function scoreOpportunity(input: ScoreInput): ScoreResult {
  const text = `${input.title} ${input.description}`.toLowerCase()
  const titleText = input.title.toLowerCase()
  const profile = input.profile ?? {}
  const learning = input.learning ?? {}
  const applied: string[] = []

  const categoryPriors = CATEGORY_PRIORS[input.category] ?? CATEGORY_PRIORS.other!

  /* demand ---------------------------------------------------------------- */
  const demandHits = contains(text, DEMAND_SIGNALS)
  const demandInTitle = contains(titleText, DEMAND_SIGNALS)
  let demand = 45
  demand += Math.min(28, demandHits.length * 6)
  demand += demandInTitle.length * 6
  if (/\?$/.test(input.title.trim())) demand += 3
  if (/\b(paying|pay for|budget of|\$\d|[0-9]+\s?(usd|eur|gbp))\b/i.test(text)) demand += 8
  demand = bump(demand, 0)

  /* competition (higher = less competitive) ------------------------------- */
  let competition = 52
  const crowded = contains(text, COMPETITION_SIGNALS_HIGH)
  const openSpace = contains(text, COMPETITION_SIGNALS_LOW)
  competition += openSpace.length * 7
  competition -= crowded.length * 12
  if (/\b(alternative to|better than)\b/i.test(text)) competition -= 4
  if (input.region && input.region.length > 2 && input.region.toLowerCase() !== 'global') competition += 6
  if (categoryPriors.scalability > 78) competition -= 4 // popular categories attract builders
  competition = bump(competition, 0)

  /* monetization ---------------------------------------------------------- */
  let monetization = 42
  const strongMon = contains(text, MONETIZATION_STRONG)
  const weakMon = contains(text, MONETIZATION_WEAK)
  monetization += Math.min(30, strongMon.length * 6)
  monetization -= weakMon.length * 10
  const prefs = (profile.monetizationPreferences ?? []).map((p) => p.toLowerCase())
  const prefMatch = prefs.filter((pref) => text.includes(pref.split(' ')[0] ?? '')).length
  monetization += Math.min(12, prefMatch * 4)
  monetization = bump(monetization, 0)

  /* startup cost (higher = cheaper to start) ------------------------------ */
  let startupCost = categoryPriors.startup
  startupCost += contains(text, LOW_STARTUP_COST).length * 5
  startupCost -= contains(text, HIGH_STARTUP_COST).length * 14
  if ((profile.monthlyBudgetCents ?? 0) > 0 && (profile.monthlyBudgetCents ?? 0) < 5000) startupCost -= 8
  startupCost = bump(startupCost, 0)

  /* operating cost (higher = cheaper to run) ------------------------------ */
  let operatingCost = categoryPriors.operating
  operatingCost += contains(text, LOW_OPERATING_COST).length * 5
  operatingCost -= contains(text, HIGH_OPERATING_COST).length * 12
  operatingCost = bump(operatingCost, 0)

  /* automation potential -------------------------------------------------- */
  let automationPotential = categoryPriors.automation
  automationPotential += contains(text, AUTOMATION_SIGNALS).length * 5
  automationPotential -= contains(text, MANUAL_SIGNALS).length * 10
  automationPotential = bump(automationPotential, 0)

  /* scalability ----------------------------------------------------------- */
  let scalability = categoryPriors.scalability
  scalability += contains(text, SCALABILITY_SIGNALS).length * 4
  scalability -= contains(text, POOR_SCALABILITY_SIGNALS).length * 10
  scalability = bump(scalability, 0)

  /* time to revenue (higher = faster) ------------------------------------- */
  let timeToRevenue = categoryPriors.timeToRevenue
  timeToRevenue += contains(text, FAST_REVENUE_SIGNALS).length * 7
  timeToRevenue -= contains(text, SLOW_REVENUE_SIGNALS).length * 12
  if (profile.minTimeToRevenueDays && profile.minTimeToRevenueDays > 90) timeToRevenue += 5
  timeToRevenue = bump(timeToRevenue, 0)

  /* difficulty (higher = easier) ------------------------------------------ */
  let difficulty = 55
  const longText = input.description.length
  if (longText > 800) difficulty += 4 // more context = clearer scope
  if (longText < 120) difficulty -= 8 // vague = harder to execute
  difficulty -= contains(text, ['platform', 'hardware', 'hard science', 'robotics']).length * 8
  difficulty += contains(text, ['template', 'directory', 'newsletter', 'landing page', 'widget', 'extension']).length * 8
  difficulty = bump(difficulty, 0)

  /* risk (higher = safer) ------------------------------------------------- */
  let risk = categoryPriors.risk
  const highRiskHits = contains(text, RISK_SIGNALS_HIGH)
  risk -= highRiskHits.length * 12
  risk += contains(text, RISK_SIGNALS_LOW).length * 5
  if (profile.riskTolerance === 'aggressive') risk += 3
  if (profile.riskTolerance === 'conservative') risk -= 8
  risk = bump(risk, 0)

  const scores: ScoreBreakdown = {
    demand: bump(demand, 0),
    competition: bump(competition, 0),
    monetization: bump(monetization, 0),
    startupCost: bump(startupCost, 0),
    operatingCost: bump(operatingCost, 0),
    automationPotential: bump(automationPotential, 0),
    scalability: bump(scalability, 0),
    timeToRevenue: bump(timeToRevenue, 0),
    difficulty: bump(difficulty, 0),
    risk: bump(risk, 0),
  }

  /* weights + learning adjustments ---------------------------------------- */
  const weights: ScoreWeights = { ...DEFAULT_WEIGHTS }
  if (learning.weights) {
    for (const [dimension, delta] of Object.entries(learning.weights)) {
      if (dimension in weights && typeof delta === 'number') {
        weights[dimension as ScoreDimension] = Math.max(0.01, weights[dimension as ScoreDimension] + delta)
      }
    }
    applied.push('Learning engine adjusted score weights from realised results.')
  }

  // Profile-driven weighting: match the operator's stated interests/skills.
  const skills = (profile.skills ?? []).map((s) => s.toLowerCase())
  const industries = (profile.industries ?? []).map((s) => s.toLowerCase())
  const skillMatch = skills.filter((skill) => text.includes(skill)).length
  const industryMatch = industries.filter((industry) => text.includes(industry)).length
  if (skillMatch > 0) {
    weights.difficulty += 0.02 * Math.min(3, skillMatch)
    applied.push(`Operator has ${skillMatch} matching skill(s) — execution difficulty weighted favourably.`)
  }
  if (industryMatch > 0) {
    weights.demand += 0.02 * Math.min(3, industryMatch)
    applied.push(`Opportunity is inside ${industryMatch} preferred industr(y/ies).`)
  }
  if (profile.riskTolerance === 'conservative') {
    weights.risk += 0.06
    weights.difficulty += 0.03
    weights.scalability -= 0.03
    applied.push('Conservative risk profile: risk and difficulty weighted higher.')
  } else if (profile.riskTolerance === 'aggressive') {
    weights.risk -= 0.03
    weights.timeToRevenue += 0.03
    applied.push('Aggressive risk profile: speed-to-revenue weighted higher than risk.')
  }

  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0)
  for (const key of SCORE_DIMENSIONS) weights[key] = weights[key] / totalWeight

  let finalScore = SCORE_DIMENSIONS.reduce((acc, dimension) => acc + scores[dimension] * weights[dimension], 0)

  const categoryBias = learning.categoryBias?.[input.category]
  if (typeof categoryBias === 'number' && categoryBias !== 0) {
    finalScore += categoryBias
    applied.push(`Historical results for "${input.category}" adjusted the score by ${categoryBias > 0 ? '+' : ''}${categoryBias.toFixed(1)}.`)
  }
  if (input.sourceName && learning.sourceBias?.[input.sourceName]) {
    const bias = learning.sourceBias[input.sourceName]!
    finalScore += bias
    applied.push(`Source reliability history (${input.sourceName}) adjusted the score by ${bias > 0 ? '+' : ''}${bias.toFixed(1)}.`)
  }
  const reliability = input.sourceReliability ?? 70
  finalScore += (reliability - 70) / 20
  if (reliability < 60) applied.push(`Lower-trust source (reliability ${reliability}/100) reduced the score slightly.`)

  finalScore = Math.round(Math.min(100, Math.max(0, finalScore)) * 100) / 100

  /* confidence ------------------------------------------------------------ */
  let confidence = 45
  if (input.description.length > 300) confidence += 12
  if (input.url) confidence += 5
  if (reliability >= 80) confidence += 10
  if (demandHits.length >= 3) confidence += 8
  if (input.learning?.notes?.length) confidence += 6
  if (highRiskHits.length > 0) confidence -= 8
  confidence = bump(confidence, 0, 10, 95)

  const verdict: ScoreResult['verdict'] =
    finalScore >= 80 ? 'strong_buy' : finalScore >= 65 ? 'consider' : finalScore >= 50 ? 'watch' : 'avoid'

  const rationale: Record<string, string> = {
    demand: demandHits.length
      ? `Demand language detected (${demandHits.length} signal(s)): ${demandHits.slice(0, 4).join(', ')}.`
      : 'No explicit demand language. Score reflects the category baseline only — treat as an assumption until validated with real prospect conversations.',
    competition: crowded.length
      ? `Competitive pressure detected: ${crowded.slice(0, 3).join(', ')}.`
      : openSpace.length
        ? `Differentiation signals present: ${openSpace.slice(0, 3).join(', ')}.`
        : 'Competition assessed from category norms; no direct evidence in the source text.',
    monetization: strongMon.length
      ? `Monetisation vocabulary present: ${strongMon.slice(0, 5).join(', ')}.`
      : 'No clear monetisation vocabulary found; a pricing hypothesis would need to be tested.',
    startupCost: `Category baseline ${categoryPriors.startup}/100 (higher = cheaper). ${contains(text, HIGH_STARTUP_COST).length ? `Cost-raising factors: ${contains(text, HIGH_STARTUP_COST).slice(0, 3).join(', ')}.` : 'No major cost-raising factors found.'}`,
    operatingCost: `Category baseline ${categoryPriors.operating}/100. ${contains(text, HIGH_OPERATING_COST).length ? `Ongoing-cost factors: ${contains(text, HIGH_OPERATING_COST).slice(0, 3).join(', ')}.` : 'No heavy ongoing-cost factors found.'}`,
    automationPotential: contains(text, AUTOMATION_SIGNALS).length
      ? `Automation vocabulary present: ${contains(text, AUTOMATION_SIGNALS).slice(0, 4).join(', ')}.`
      : 'Automation potential inferred from the business model rather than explicit signals.',
    scalability: `Category baseline ${categoryPriors.scalability}/100 (higher = scales without proportional effort).`,
    timeToRevenue: contains(text, FAST_REVENUE_SIGNALS).length
      ? `Fast-revenue indicators: ${contains(text, FAST_REVENUE_SIGNALS).slice(0, 3).join(', ')}.`
      : 'No fast-revenue indicators; the modelled time-to-revenue is a projection.',
    difficulty: longText < 120
      ? 'The source description is thin, which increases delivery uncertainty.'
      : 'Scope clarity is reasonable for a v1 build.',
    risk: highRiskHits.length
      ? `Risk factors present: ${highRiskHits.slice(0, 4).join(', ')}. Legal/regulatory review recommended before investing.`
      : 'No obvious legal or regulatory risk signals detected in the source text.',
  }

  const summary = buildSummary(input, scores, finalScore, verdict)

  return {
    scores,
    finalScore,
    confidence,
    verdict,
    summary,
    rationale,
    weights,
    appliedAdjustments: applied,
    engine: 'heuristic',
  }
}

function buildSummary(input: ScoreInput, scores: ScoreBreakdown, finalScore: number, verdict: string): string {
  const strongest = SCORE_DIMENSIONS.slice().sort((a, b) => scores[b] - scores[a])[0]!
  const weakest = SCORE_DIMENSIONS.slice().sort((a, b) => scores[a] - scores[b])[0]!
  const label: Record<ScoreDimension, string> = {
    demand: 'observed demand',
    competition: 'competitive openness',
    monetization: 'monetisation clarity',
    startupCost: 'low startup cost',
    operatingCost: 'low operating cost',
    automationPotential: 'automation potential',
    scalability: 'scalability',
    timeToRevenue: 'time to revenue',
    difficulty: 'execution feasibility',
    risk: 'risk profile',
  }
  return `"${input.title}" scores ${finalScore}/100 (${verdict.replace('_', ' ')}). Its strongest dimension is ${label[strongest]} (${scores[strongest]}/100); the weakest is ${label[weakest]} (${scores[weakest]}/100). All figures are estimates derived from the source text and category benchmarks — validate them before committing budget.`
}

/** Convert a collected signal into the shape the scorer expects. */
export function signalToScoreInput(signal: RawSignal, options: {
  sourceName: string
  sourceReliability: number
  profile?: ScoringProfile
  learning?: LearningAdjustments
}): ScoreInput {
  return {
    title: signal.title,
    description: signal.description,
    category: signal.category,
    sourceName: options.sourceName,
    sourceReliability: options.sourceReliability,
    url: signal.url,
    region: signal.region,
    profile: options.profile,
    learning: options.learning,
  }
}

/** Blend an AI-reported breakdown with the deterministic baseline. */
export function blendScores(heuristic: ScoreResult, ai: { scores: ScoreBreakdown; finalScore: number; confidence?: number }, aiWeight = 0.6): ScoreResult {
  const blended = {} as ScoreBreakdown
  for (const dimension of SCORE_DIMENSIONS) {
    const aiValue = ai.scores[dimension]
    blended[dimension] =
      typeof aiValue === 'number' && Number.isFinite(aiValue)
        ? Math.round(heuristic.scores[dimension] * (1 - aiWeight) + clampPercent(aiValue) * aiWeight)
        : heuristic.scores[dimension]
  }
  const finalScore =
    Math.round(
      (heuristic.finalScore * (1 - aiWeight) + clampPercent(ai.finalScore) * aiWeight) * 100,
    ) / 100
  return {
    ...heuristic,
    scores: blended,
    finalScore,
    confidence: Math.min(95, Math.round(heuristic.confidence * 0.5 + clampPercent(ai.confidence ?? heuristic.confidence) * 0.5)),
    verdict: finalScore >= 80 ? 'strong_buy' : finalScore >= 65 ? 'consider' : finalScore >= 50 ? 'watch' : 'avoid',
    engine: 'heuristic',
  }
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

/** Detect when a scoring model has drifted to an unrealistic distribution. */
export function scoringSanityCheck(finalScores: number[]): { ok: boolean; message?: string } {
  if (finalScores.length < 5) return { ok: true }
  const mean = finalScores.reduce((a, b) => a + b, 0) / finalScores.length
  if (mean > 92) return { ok: false, message: `Average score ${mean.toFixed(1)} is implausibly high — check scoring inputs.` }
  if (mean < 20) return { ok: false, message: `Average score ${mean.toFixed(1)} is implausibly low — check scoring inputs.` }
  return { ok: true }
}

export type { SourceCategory }
