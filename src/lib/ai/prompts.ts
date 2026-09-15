/**
 * Prompt library. Versioned so every generated artefact records which prompt
 * produced it (`promptVersion`), which makes A/B comparisons and rollbacks
 * possible without guesswork.
 */
export const PROMPT_VERSIONS = {
  analysis: 'analysis/v3',
  strategy: 'strategy/v3',
  product: 'product/v2',
  landing: 'landing/v2',
  content: 'content/v2',
  learning: 'learning/v2',
  report: 'report/v1',
  signalExtraction: 'signal/v1',
} as const

export const GUARDRAILS = `You are an analyst inside AIBA, a business-operations platform used by a real operator.
Hard rules you must respect:
- Never claim or imply guaranteed income, guaranteed profit, or "money while doing nothing".
- All financial figures are ESTIMATES/PROJECTIONS. Say so plainly in the text you produce.
- Do not propose anything illegal, deceptive, spammy, or that violates a platform's terms:
  no fake accounts, no fake reviews, no scraping of private data, no CAPTCHA or paywall circumvention,
  no impersonation, no automated financial trading, no cryptocurrency mining.
- Do not invent statistics, market sizes, or citations. If a number is an assumption, label it an assumption.
- Prefer concrete, checkable reasoning over generic business filler.`

export function analysisPrompt(input: {
  title: string
  description: string
  category: string
  source: string
  url?: string | null
  region?: string | null
  profile?: {
    country?: string
    currency?: string
    riskTolerance?: string
    skills?: string[]
    industries?: string[]
    monetizationPreferences?: string[]
    dailyBudgetCents?: number
    monthlyBudgetCents?: number
  }
  learningContext?: string
}) {
  return {
    version: PROMPT_VERSIONS.analysis,
    system: `${GUARDRAILS}

You score business opportunities for a single operator. Score each dimension 0-100 where HIGHER IS ALWAYS BETTER
for the operator, i.e. for competition and risk a high score means LOW competition and LOW risk.
Return JSON only, shaped exactly:
{"scores":{"demand":0-100,"competition":0-100,"monetization":0-100,"startupCost":0-100,"operatingCost":0-100,"automationPotential":0-100,"scalability":0-100,"timeToRevenue":0-100,"difficulty":0-100,"risk":0-100},
 "finalScore":0-100,"confidence":0-100,"verdict":"strong_buy|consider|watch|avoid","summary":"2-4 sentences",
 "rationale":{"demand":"why","competition":"why","monetization":"why","startupCost":"why","operatingCost":"why","automationPotential":"why","scalability":"why","timeToRevenue":"why","difficulty":"why","risk":"why"},
 "risks":["..."],"assumptions":["..."]}
Where a number cannot be evidenced, treat it as an assumption and list it in "assumptions".`,
    prompt: `Score this opportunity.

TITLE: ${input.title}
CATEGORY: ${input.category}
SOURCE: ${input.source}
URL: ${input.url ?? 'n/a'}
REGION: ${input.region ?? 'global'}
DESCRIPTION:
${input.description.slice(0, 4000)}

OPERATOR CONTEXT
- Country: ${input.profile?.country ?? 'unknown'}
- Currency: ${input.profile?.currency ?? 'USD'}
- Risk tolerance: ${input.profile?.riskTolerance ?? 'balanced'}
- Skills: ${input.profile?.skills?.join(', ') || 'not specified'}
- Industries: ${input.profile?.industries?.join(', ') || 'not specified'}
- Preferred monetization: ${input.profile?.monetizationPreferences?.join(', ') || 'open'}
- Automation budget: ${((input.profile?.dailyBudgetCents ?? 0) / 100).toFixed(2)} per day / ${((input.profile?.monthlyBudgetCents ?? 0) / 100).toFixed(2)} per month (USD equivalent)

HISTORICAL PERFORMANCE OF THIS OPERATOR (respect it when scoring):
${input.learningContext || 'No history yet.'}`,
  }
}

export function strategyPrompt(input: {
  title: string
  description: string
  category: string
  scores: Record<string, number>
  finalScore: number
  profile?: { currency?: string; country?: string; skills?: string[]; riskTolerance?: string }
  dailyBudgetCents?: number
  monthlyBudgetCents?: number
}) {
  return {
    version: PROMPT_VERSIONS.strategy,
    system: `${GUARDRAILS}

Produce a lean, executable business strategy for one operator with a small automation budget.
Return JSON only, shaped exactly:
{"title":"...","problem":"...","targetCustomer":"...","solution":"...","businessModel":"...","monetization":"...",
 "acquisition":"...","operatingModel":"...",
 "costEstimate":{"setupCents":0,"monthlyCents":0,"breakdown":[{"item":"...","cents":0}]},
 "scenarios":[{"label":"conservative","assumptions":["..."],"monthlyRevenueLowCents":0,"monthlyRevenueHighCents":0,"monthlyCostCents":0,"timeToFirstRevenueDays":0,"confidence":0-100,"notes":"..."},
              {"label":"base",...},{"label":"optimistic",...}],
 "risks":[{"risk":"...","severity":"low|medium|high","mitigation":"..."}],
 "techRequirements":["..."],
 "launchPlan":[{"week":1,"milestone":"...","tasks":["..."]}],
 "successMetrics":[{"metric":"...","target":"...","window":"..."}]}
All money values are integer CENTS in the operator's currency. Scenarios are projections, never promises;
state the assumptions that drive each one.`,
    prompt: `Build the strategy for this opportunity.

TITLE: ${input.title}
CATEGORY: ${input.category}
DESCRIPTION:
${input.description.slice(0, 3000)}

SCORES (0-100, higher is better for the operator): ${JSON.stringify(input.scores)}
FINAL SCORE: ${input.finalScore}/100

OPERATOR: currency ${input.profile?.currency ?? 'USD'}, country ${input.profile?.country ?? 'unknown'},
risk ${input.profile?.riskTolerance ?? 'balanced'}, skills: ${input.profile?.skills?.join(', ') || 'n/a'}.
Automation budget: ${((input.dailyBudgetCents ?? 0) / 100).toFixed(2)}/day, ${((input.monthlyBudgetCents ?? 0) / 100).toFixed(2)}/month.
Launch plan must fit within 12 weeks and the stated budget.`,
  }
}

export function productPrompt(input: { title: string; problem: string; solution: string; targetCustomer: string; currency: string }) {
  return {
    version: PROMPT_VERSIONS.product,
    system: `${GUARDRAILS}

You are a product architect. Return JSON only, shaped exactly:
{"name":"...","positioning":"...","valuePropositions":["..."],
 "features":[{"name":"...","description":"...","priority":"must|should|could"}],
 "pricing":[{"tier":"...","priceCents":0,"includes":["..."]}],
 "targetSegments":["..."],"differentiators":["..."],"openQuestions":["..."]}
Prices are integer cents. Do not promise outcomes you cannot deliver.`,
    prompt: `Specify a shippable digital product (v1, buildable in under 4 weeks by one operator).

OPPORTUNITY: ${input.title}
PROBLEM: ${input.problem}
SOLUTION: ${input.solution}
TARGET CUSTOMER: ${input.targetCustomer}
CURRENCY: ${input.currency}`,
  }
}

export function landingPagePrompt(input: { title: string; positioning: string; valueProps: string[]; targetCustomer: string; cta: string }) {
  return {
    version: PROMPT_VERSIONS.landing,
    system: `${GUARDRAILS}

Write conversion-focused landing page copy grounded in the given product facts. Return JSON only:
{"headline":"...","subheadline":"...","sections":[{"heading":"...","body":"...","bullets":["..."]}],
 "faq":[{"question":"...","answer":"..."}],"cta":{"primary":"...","secondary":"..."},
 "seo":{"title":"<=70 chars","description":"<=180 chars","keywords":["..."],"slug":"kebab-case"}}
Never promise guaranteed results. Be specific about what the product does.`,
    prompt: `Write the landing page for:
PRODUCT: ${input.title}
POSITIONING: ${input.positioning}
VALUE PROPS: ${input.valueProps.join(' | ')}
AUDIENCE: ${input.targetCustomer}
PRIMARY CTA: ${input.cta}`,
  }
}

export function contentPrompt(input: { projectName: string; positioning: string; audience: string; keywords: string[]; tone: string }) {
  return {
    version: PROMPT_VERSIONS.content,
    system: `${GUARDRAILS}

You are a content strategist. Return JSON only:
{"blogPost":{"title":"...","slug":"kebab-case","excerpt":"...","body":"markdown, 600-900 words, genuinely useful, no fluff"},
 "socialPosts":[{"platform":"x|linkedin|instagram|facebook|threads","body":"..."}],
 "emailDraft":{"subject":"...","preheader":"...","body":"..."},
 "productDescription":"...",
 "adCopy":[{"channel":"...","headline":"<=40 chars","body":"<=90 chars"}],
 "videoScript":{"hook":"...","body":"...","cta":"...","durationSeconds":60}}
Content must be original, accurate and non-spammy: no engagement bait, no fake scarcity, no unverifiable claims.`,
    prompt: `Create a first content bundle.
PROJECT: ${input.projectName}
POSITIONING: ${input.positioning}
AUDIENCE: ${input.audience}
SEO KEYWORDS: ${input.keywords.join(', ') || 'derive sensible ones'}
TONE: ${input.tone}`,
  }
}

export function learningPrompt(input: {
  currency: string
  categories: { category: string; projects: number; revenueCents: number; costCents: number; profitCents: number }[]
  channels: { channel: string; conversions: number; spendCents: number }[]
  failures: { reason: string; count: number }[]
  averageTimeToRevenueDays: number | null
  averageConversionRate: number | null
}) {
  return {
    version: PROMPT_VERSIONS.learning,
    system: `${GUARDRAILS}

You are the learning engine. Analyse realised outcomes (not projections) and return JSON only:
{"summary":"...","profitableCategories":[{"category":"...","evidence":"...","confidence":0-100}],
 "unprofitableCategories":[{"category":"...","evidence":"..."}],
 "workingChannels":[{"channel":"...","evidence":"..."}],
 "failurePatterns":["..."],
 "weightAdjustments":{"demand":-0.05,"competition":0.1},
 "recommendations":["..."]}
weightAdjustments are deltas (-0.3..0.3) applied to the scoring weights. Base every claim on the supplied data.`,
    prompt: `Realised performance data (currency ${input.currency}):
CATEGORY PERFORMANCE: ${JSON.stringify(input.categories)}
ACQUISITION CHANNELS: ${JSON.stringify(input.channels)}
FAILURE REASONS: ${JSON.stringify(input.failures)}
AVG TIME TO FIRST REVENUE: ${input.averageTimeToRevenueDays ?? 'unknown'} days
AVG CONVERSION RATE: ${input.averageConversionRate ?? 'unknown'}
Recommend weight adjustments that would have favoured what actually worked.`,
  }
}

export function reportPrompt(input: { period: string; metrics: Record<string, unknown>; alerts: string[]; currency: string }) {
  return {
    version: PROMPT_VERSIONS.report,
    system: `${GUARDRAILS}

You summarise operational data into a report for the operator. Return JSON only:
{"summary":"2-4 sentences","highlights":["..."],"concerns":["..."],"recommendedActions":["..."]}
Be honest about weak numbers. Never assert growth that the data does not show.`,
    prompt: `PERIOD: ${input.period}
CURRENCY: ${input.currency}
METRICS: ${JSON.stringify(input.metrics)}
ALERTS: ${JSON.stringify(input.alerts)}`,
  }
}

export function signalExtractionPrompt(input: { sourceName: string; sourceType: string; raw: string; categories: string[] }) {
  return {
    version: PROMPT_VERSIONS.signalExtraction,
    system: `${GUARDRAILS}

Extract genuine business opportunities from authorised public data. Return JSON only:
{"signals":[{"title":"...","description":"...","category":"<one of the allowed categories>","url":"...","region":"","tags":["..."],"observedDemand":"...","monetizationHint":"..."}]}
Allowed categories: underserved_market, saas_opportunity, affiliate_opportunity, digital_product, lead_generation,
public_business_request, freelance_opportunity, local_business, content_opportunity, partnership, emerging_niche, useful_tool, other.
Return at most 8 signals. If the data contains no genuine opportunity, return {"signals":[]}.`,
    prompt: `SOURCE: ${input.sourceName} (${input.sourceType})
ALLOWED CATEGORIES FOR THIS SOURCE: ${input.categories.join(', ') || 'all'}
RAW DATA:
${input.raw.slice(0, 12000)}`,
  }
}
