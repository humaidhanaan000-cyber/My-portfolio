/** Zod contracts for every structured model response. */
import { z } from 'zod'

const score = z.number().min(0).max(100)

export const scoreBreakdownSchema = z.object({
  demand: score,
  competition: score,
  monetization: score,
  startupCost: score,
  operatingCost: score,
  automationPotential: score,
  scalability: score,
  timeToRevenue: score,
  difficulty: score,
  risk: score,
})

export const analysisSchema = z.object({
  scores: scoreBreakdownSchema,
  finalScore: score,
  confidence: z.number().min(0).max(100).default(65),
  verdict: z.enum(['strong_buy', 'consider', 'watch', 'avoid']),
  summary: z.string().min(10).max(1200),
  rationale: z.record(z.string()).default({}),
  risks: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
})
export type AnalysisOutput = z.infer<typeof analysisSchema>

export const scenarioSchema = z.object({
  label: z.enum(['conservative', 'base', 'optimistic']),
  assumptions: z.array(z.string()).default([]),
  monthlyRevenueLowCents: z.number().int().min(0),
  monthlyRevenueHighCents: z.number().int().min(0),
  monthlyCostCents: z.number().int().min(0),
  timeToFirstRevenueDays: z.number().int().min(0),
  confidence: z.number().min(0).max(100).default(50),
  notes: z.string().default(''),
})

export const strategySchema = z.object({
  title: z.string().min(3).max(200),
  problem: z.string().min(10),
  targetCustomer: z.string().min(10),
  solution: z.string().min(10),
  businessModel: z.string().min(3),
  monetization: z.string().min(3),
  acquisition: z.string().min(10),
  operatingModel: z.string().min(10),
  costEstimate: z.object({
    setupCents: z.number().int().min(0),
    monthlyCents: z.number().int().min(0),
    breakdown: z.array(z.object({ item: z.string(), cents: z.number().int().min(0) })).default([]),
  }),
  scenarios: z.array(scenarioSchema).min(1).max(3),
  risks: z.array(z.object({ risk: z.string(), severity: z.enum(['low', 'medium', 'high']), mitigation: z.string() })).default([]),
  techRequirements: z.array(z.string()).default([]),
  launchPlan: z.array(z.object({ week: z.number().int().min(1).max(52), milestone: z.string(), tasks: z.array(z.string()).default([]) })).default([]),
  successMetrics: z.array(z.object({ metric: z.string(), target: z.string(), window: z.string() })).default([]),
})
export type StrategyOutput = z.infer<typeof strategySchema>

export const productSpecSchema = z.object({
  name: z.string(),
  positioning: z.string(),
  valuePropositions: z.array(z.string()).min(1),
  features: z.array(z.object({ name: z.string(), description: z.string(), priority: z.enum(['must', 'should', 'could']) })).min(1),
  pricing: z.array(z.object({ tier: z.string(), priceCents: z.number().int().min(0), includes: z.array(z.string()) })).min(1),
  targetSegments: z.array(z.string()).min(1),
  differentiators: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
})
export type ProductSpecOutput = z.infer<typeof productSpecSchema>

export const landingPageSchema = z.object({
  headline: z.string().min(5).max(120),
  subheadline: z.string().min(10).max(300),
  sections: z.array(z.object({ heading: z.string(), body: z.string(), bullets: z.array(z.string()).default([]) })).min(2),
  faq: z.array(z.object({ question: z.string(), answer: z.string() })).min(3),
  cta: z.object({ primary: z.string(), secondary: z.string().default('') }),
  seo: z.object({
    title: z.string().max(70),
    description: z.string().max(180),
    keywords: z.array(z.string()).default([]),
    slug: z.string(),
  }),
})
export type LandingPageOutput = z.infer<typeof landingPageSchema>

export const contentBundleSchema = z.object({
  blogPost: z.object({ title: z.string(), slug: z.string(), excerpt: z.string(), body: z.string() }),
  socialPosts: z.array(z.object({ platform: z.enum(['x', 'linkedin', 'instagram', 'facebook', 'threads']), body: z.string() })).min(1),
  emailDraft: z.object({ subject: z.string(), preheader: z.string().default(''), body: z.string() }),
  productDescription: z.string(),
  adCopy: z.array(z.object({ channel: z.string(), headline: z.string(), body: z.string() })),
  videoScript: z.object({ hook: z.string(), body: z.string(), cta: z.string(), durationSeconds: z.number().int().min(15).max(600) }),
})
export type ContentBundleOutput = z.infer<typeof contentBundleSchema>

export const researchSignalSchema = z.object({
  title: z.string().min(5),
  description: z.string().min(10),
  category: z.enum([
    'underserved_market',
    'saas_opportunity',
    'affiliate_opportunity',
    'digital_product',
    'lead_generation',
    'public_business_request',
    'freelance_opportunity',
    'local_business',
    'content_opportunity',
    'partnership',
    'emerging_niche',
    'useful_tool',
    'other',
  ]),
  url: z.string().default(''),
  region: z.string().default(''),
  tags: z.array(z.string()).default([]),
  observedDemand: z.string().default(''),
  monetizationHint: z.string().default(''),
})

export const learningDigestSchema = z.object({
  summary: z.string().min(20),
  profitableCategories: z.array(z.object({ category: z.string(), evidence: z.string(), confidence: z.number().min(0).max(100) })).default([]),
  unprofitableCategories: z.array(z.object({ category: z.string(), evidence: z.string() })).default([]),
  workingChannels: z.array(z.object({ channel: z.string(), evidence: z.string() })).default([]),
  failurePatterns: z.array(z.string()).default([]),
  weightAdjustments: z.record(z.number()).default({}),
  recommendations: z.array(z.string()).default([]),
})
export type LearningDigest = z.infer<typeof learningDigestSchema>

export const dailyReportSchema = z.object({
  summary: z.string(),
  highlights: z.array(z.string()).default([]),
  concerns: z.array(z.string()).default([]),
  recommendedActions: z.array(z.string()).default([]),
})
