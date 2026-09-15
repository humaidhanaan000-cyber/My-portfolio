/**
 * Category blueprints.
 *
 * Deterministic business knowledge used when no AI provider is configured (and
 * as the grounded baseline when one is). Values are deliberately conservative
 * industry-typical ranges, and every consumer labels them as estimates.
 */

export type CategoryBlueprint = {
  customer: string
  businessModel: string
  monetization: (priceCents: number, currency: string) => string
  solution: (title: string) => string
  acquisition: string
  operatingModel: string
  tech: string[]
  setupMultiplier: number
  monthlyMultiplier: number
  pricePointCents: number
  conversionRate: number
  visitorsPerMonth: [number, number]
  timeToRevenueDays: [number, number]
  costBreakdown: (setupCents: number, monthlyCents: number, currency: string) => { item: string; cents: number }[]
}

const genericCostBreakdown = (setupCents: number, monthlyCents: number) => [
  { item: 'Domain and DNS', cents: Math.round(setupCents * 0.05) },
  { item: 'Build tools / templates', cents: Math.round(setupCents * 0.35) },
  { item: 'Initial content production', cents: Math.round(setupCents * 0.45) },
  { item: 'Reserve', cents: Math.round(setupCents * 0.15) },
  { item: 'Hosting and infrastructure', cents: Math.round(monthlyCents * 0.3) },
  { item: 'AI/API automation', cents: Math.round(monthlyCents * 0.25) },
  { item: 'Analytics and email tooling', cents: Math.round(monthlyCents * 0.2) },
  { item: 'Marketing experiments', cents: Math.round(monthlyCents * 0.25) },
]

const BLUEPRINTS: Record<string, CategoryBlueprint> = {
  saas_opportunity: {
    customer: 'Small teams (2–20 people) in the affected industry who currently solve this with spreadsheets or manual process.',
    businessModel: 'Self-serve SaaS subscription with a free entry tier and a paid tier per workspace.',
    monetization: (price, currency) => `Subscription at approximately ${(price / 100).toFixed(0)} ${currency}/month per workspace, billed monthly with an annual discount.`,
    solution: (title) => `A focused web application that solves "${title}" end-to-end for one narrow workflow, deployable in under two weeks and priced below the cost of the manual alternative.`,
    acquisition: 'SEO for the specific problem phrasing, presence in the two communities where the audience already asks about this, plus a free tool that funnels into the product.',
    operatingModel: 'Mostly automated: onboarding, billing and usage metering are self-serve. Weekly manual review of support and churn.',
    tech: ['Next.js front-end', 'PostgreSQL', 'Hosted on a single container initially', 'Stripe billing', 'Transactional email provider'],
    setupMultiplier: 0.6,
    monthlyMultiplier: 0.22,
    pricePointCents: 2900,
    conversionRate: 0.02,
    visitorsPerMonth: [400, 3000],
    timeToRevenueDays: [21, 60],
    costBreakdown: genericCostBreakdown,
  },
  digital_product: {
    customer: 'Individual practitioners who need a ready-made artefact rather than a custom service.',
    businessModel: 'One-off digital download with an optional bundle or update subscription.',
    monetization: (price, currency) => `One-off purchase at ${(price / 100).toFixed(0)} ${currency} per copy, with a bundle tier at roughly 2.5×.`,
    solution: (title) => `A polished, immediately usable digital product (template/toolkit/guide) that removes the blank-page problem for "${title}".`,
    acquisition: 'Marketplace listings, a single well-optimised landing page, and content that demonstrates the result rather than describing it.',
    operatingModel: 'Fully automated delivery after build. Maintenance limited to periodic updates.',
    tech: ['Landing page (static)', 'Payment link', 'File delivery via object storage', 'Email delivery'],
    setupMultiplier: 0.35,
    monthlyMultiplier: 0.06,
    pricePointCents: 3900,
    conversionRate: 0.025,
    visitorsPerMonth: [300, 2500],
    timeToRevenueDays: [7, 30],
    costBreakdown: genericCostBreakdown,
  },
  content_opportunity: {
    customer: 'Readers and practitioners in the niche who need practical, specific guidance.',
    businessModel: 'Audience-first: newsletter sponsorship, affiliate revenue and a paid tier.',
    monetization: (price, currency) => `Free tier plus paid subscription at ${(price / 100).toFixed(0)} ${currency}/month once the list passes ~1,000 engaged readers; sponsorship from 2,000.`,
    solution: (title) => `A focused publication covering "${title}" with original, verifiable analysis rather than recycled takes.`,
    acquisition: 'Cross-posting to relevant communities, search-optimised evergreen articles, and guest appearances on adjacent newsletters.',
    operatingModel: 'Semi-automated: AI assists with drafts and research, a human edits before publishing.',
    tech: ['Static site or newsletter platform', 'Analytics', 'Email list provider'],
    setupMultiplier: 0.15,
    monthlyMultiplier: 0.05,
    pricePointCents: 700,
    conversionRate: 0.03,
    visitorsPerMonth: [500, 5000],
    timeToRevenueDays: [45, 150],
    costBreakdown: genericCostBreakdown,
  },
  affiliate_opportunity: {
    customer: 'Buyers already searching with commercial intent for a specific solution.',
    businessModel: 'Affiliate commissions on genuinely recommended products, plus optional sponsored placements.',
    monetization: (_price, currency) => `Commission-based: 10–30% of referred sales (varies by programme) paid in ${currency}, disclosed on every page.`,
    solution: (title) => `An independent comparison resource for "${title}" that states trade-offs honestly and discloses affiliate relationships.`,
    acquisition: 'Long-tail commercial-intent search terms and community answers where the recommendation is genuinely useful.',
    operatingModel: 'Automated content maintenance plus monthly review of broken links and programme terms.',
    tech: ['Static site', 'Affiliate programme integrations', 'Analytics', 'Link monitoring'],
    setupMultiplier: 0.2,
    monthlyMultiplier: 0.08,
    pricePointCents: 2500,
    conversionRate: 0.015,
    visitorsPerMonth: [600, 6000],
    timeToRevenueDays: [60, 180],
    costBreakdown: genericCostBreakdown,
  },
  lead_generation: {
    customer: 'Local or niche service businesses that need a predictable flow of qualified enquiries.',
    businessModel: 'Retainer or per-lead pricing with a defined volume commitment.',
    monetization: (price, currency) => `${(price / 100).toFixed(0)} ${currency} per qualified lead, or a monthly retainer covering a defined volume.`,
    solution: (title) => `A narrowly targeted lead pipeline for "${title}" including the landing asset, qualification criteria and handover process.`,
    acquisition: 'Local search, targeted outreach to complementary businesses, and referral partnerships.',
    operatingModel: 'Partly automated sourcing and qualification; human verification before handover.',
    tech: ['Landing page', 'CRM/pipeline tool', 'Form handling', 'Email automation'],
    setupMultiplier: 0.25,
    monthlyMultiplier: 0.18,
    pricePointCents: 4500,
    conversionRate: 0.04,
    visitorsPerMonth: [200, 1500],
    timeToRevenueDays: [14, 60],
    costBreakdown: genericCostBreakdown,
  },
  public_business_request: {
    customer: 'The exact organisation or maintainer who published the request.',
    businessModel: 'Fixed-scope project or maintenance retainer after delivery.',
    monetization: (price, currency) => `Fixed-scope quote around ${(price / 100).toFixed(0)} ${currency} for the initial delivery, with an optional retainer.`,
    solution: (title) => `A scoped, time-boxed delivery against the published request "${title}", with a written definition of done.`,
    acquisition: 'Direct response to the public request with a concrete plan and timeline.',
    operatingModel: 'Human-led delivery with AI assistance; automate only the repetitive parts.',
    tech: ['Depends on the request — typically the requester\'s existing stack'],
    setupMultiplier: 0.05,
    monthlyMultiplier: 0.03,
    pricePointCents: 15000,
    conversionRate: 0.08,
    visitorsPerMonth: [20, 200],
    timeToRevenueDays: [7, 45],
    costBreakdown: genericCostBreakdown,
  },
  freelance_opportunity: {
    customer: 'Employers and agencies hiring for the specific skill the posting requires.',
    businessModel: 'Contract or part-time engagement billed hourly or monthly.',
    monetization: (price, currency) => `Contract rate around ${(price / 100).toFixed(0)} ${currency}/hour, or a monthly minimum engagement.`,
    solution: (title) => `A specialised service offering mapped directly to the recurring demand seen in "${title}".`,
    acquisition: 'Applications to a curated subset of postings, plus a portfolio page that proves the specific skill.',
    operatingModel: 'Human delivery; automation limited to sourcing, screening and invoicing.',
    tech: ['Portfolio site', 'Invoicing', 'Time tracking'],
    setupMultiplier: 0.08,
    monthlyMultiplier: 0.04,
    pricePointCents: 6000,
    conversionRate: 0.05,
    visitorsPerMonth: [50, 400],
    timeToRevenueDays: [7, 30],
    costBreakdown: genericCostBreakdown,
  },
  local_business: {
    customer: 'Businesses and residents within a defined geographic area.',
    businessModel: 'Recurring local service with a clear per-visit or monthly price.',
    monetization: (price, currency) => `Local service pricing from ${(price / 100).toFixed(0)} ${currency} per engagement with a monthly plan option.`,
    solution: (title) => `A locally focused service addressing "${title}" with visible proof of work in the area.`,
    acquisition: 'Local search optimisation, community groups, and partnerships with adjacent local businesses.',
    operatingModel: 'Human delivery with automations for scheduling and follow-up.',
    tech: ['Local landing page', 'Booking', 'Review collection', 'Simple CRM'],
    setupMultiplier: 0.3,
    monthlyMultiplier: 0.2,
    pricePointCents: 9900,
    conversionRate: 0.06,
    visitorsPerMonth: [100, 800],
    timeToRevenueDays: [14, 60],
    costBreakdown: genericCostBreakdown,
  },
  underserved_market: {
    customer: 'A segment repeatedly described in the source data as poorly served by current options.',
    businessModel: 'Narrow, well-priced offering for a specific segment, expanded only after product-market fit.',
    monetization: (price, currency) => `Entry pricing around ${(price / 100).toFixed(0)} ${currency}, raised after the first ten validated customers.`,
    solution: (title) => `A deliberately narrow solution for "${title}" that the incumbent generalist tools handle badly.`,
    acquisition: 'Go where that segment already gathers and speak to the exact frustration.',
    operatingModel: 'Lean, founder-operated with automation for delivery and reporting.',
    tech: ['Lean web stack', 'Analytics', 'Payment provider', 'Email'],
    setupMultiplier: 0.4,
    monthlyMultiplier: 0.15,
    pricePointCents: 4900,
    conversionRate: 0.025,
    visitorsPerMonth: [200, 1500],
    timeToRevenueDays: [21, 75],
    costBreakdown: genericCostBreakdown,
  },
  partnership: {
    customer: 'An established operator with an existing audience or customer base.',
    businessModel: 'Revenue share or co-marketing agreement with a clear written scope.',
    monetization: (_price, currency) => `Revenue-share (typically 20–40%) or fixed co-marketing fee in ${currency}, documented before work begins.`,
    solution: (title) => `A partnership proposition for "${title}" where both sides bring distribution and delivery respectively.`,
    acquisition: 'Direct, specific outreach with a written proposal and one clear ask.',
    operatingModel: 'Human relationship management; automation for reporting and fulfilment.',
    tech: ['Shared analytics', 'Reporting dashboard', 'Contract and invoicing tooling'],
    setupMultiplier: 0.1,
    monthlyMultiplier: 0.06,
    pricePointCents: 5000,
    conversionRate: 0.05,
    visitorsPerMonth: [50, 500],
    timeToRevenueDays: [30, 120],
    costBreakdown: genericCostBreakdown,
  },
  emerging_niche: {
    customer: 'Early adopters actively searching for information and tooling in a fast-moving area.',
    businessModel: 'Content plus tooling: build audience first, monetise with a paid tool or sponsorship.',
    monetization: (price, currency) => `Paid tier or sponsorship from ${(price / 100).toFixed(0)} ${currency}/month once monthly readers exceed ~2,000.`,
    solution: (title) => `The definitive resource for "${title}" — updated continuously while the niche is still forming.`,
    acquisition: 'Publish where the niche discusses daily; be first with accurate analysis.',
    operatingModel: 'Automated research and drafting with editorial review.',
    tech: ['Static site or newsletter', 'Search analytics', 'Email list'],
    setupMultiplier: 0.15,
    monthlyMultiplier: 0.05,
    pricePointCents: 900,
    conversionRate: 0.03,
    visitorsPerMonth: [400, 4000],
    timeToRevenueDays: [45, 150],
    costBreakdown: genericCostBreakdown,
  },
  useful_tool: {
    customer: 'People who repeatedly perform the manual task the tool automates.',
    businessModel: 'Free utility that converts into a paid plan for heavier usage.',
    monetization: (price, currency) => `Free tier plus paid plan at ${(price / 100).toFixed(0)} ${currency}/month for volume and integrations.`,
    solution: (title) => `A single-purpose tool that solves "${title}" in under a minute with no signup required to try it.`,
    acquisition: 'Product-led: searchable utility pages, shareable outputs, and community answers.',
    operatingModel: 'Fully automated; costs scale with usage and are metered.',
    tech: ['Serverless function', 'Simple UI', 'Usage metering', 'Payment provider'],
    setupMultiplier: 0.3,
    monthlyMultiplier: 0.12,
    pricePointCents: 1900,
    conversionRate: 0.02,
    visitorsPerMonth: [500, 5000],
    timeToRevenueDays: [14, 60],
    costBreakdown: genericCostBreakdown,
  },
  other: {
    customer: 'The most specific reachable segment implied by the opportunity description.',
    businessModel: 'Direct offering with a validated price before any build spend.',
    monetization: (price, currency) => `Validated pricing starting around ${(price / 100).toFixed(0)} ${currency}; confirm with five prospective customers before building.`,
    solution: (title) => `A minimum viable offering for "${title}" that can be delivered within four weeks.`,
    acquisition: 'Direct conversations with ten people in the target segment.',
    operatingModel: 'Manual first, automate only what repeats.',
    tech: ['Minimal viable stack: landing page, payment link, delivery mechanism'],
    setupMultiplier: 0.3,
    monthlyMultiplier: 0.12,
    pricePointCents: 2900,
    conversionRate: 0.025,
    visitorsPerMonth: [200, 2000],
    timeToRevenueDays: [14, 90],
    costBreakdown: genericCostBreakdown,
  },
}

export function scoreOpportunityFallbackCategory(category: string): CategoryBlueprint {
  return BLUEPRINTS[category] ?? BLUEPRINTS.other!
}

export function allBlueprints(): { category: string; blueprint: CategoryBlueprint }[] {
  return Object.entries(BLUEPRINTS).map(([category, blueprint]) => ({ category, blueprint }))
}

/** Sanity ceiling for any projection the platform produces. */
export const PROJECTION_CEILING_MULTIPLIER = 6

/** Guard against a generated plan that implies implausible returns. */
export function projectionSanityCheck(input: {
  monthlyRevenueHighCents: number
  monthlyCostCents: number
  setupCents: number
}): { ok: boolean; message?: string } {
  const annualised = input.monthlyRevenueHighCents * 12
  const invested = input.setupCents + input.monthlyCostCents * 3
  if (invested <= 0) return { ok: true }
  const ratio = annualised / invested
  if (ratio > PROJECTION_CEILING_MULTIPLIER * 4) {
    return {
      ok: false,
      message: `Optimistic scenario implies ${ratio.toFixed(1)}× return on the first quarter's spend. Flagged as unrealistic for display.`,
    }
  }
  return { ok: true }
}
