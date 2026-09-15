/**
 * Default subscription catalogue.
 *
 * These are the *seed* values only. Prices shown to customers are always read
 * from the `plans` table, and an administrator can change any price from the
 * admin panel (`PATCH /api/billing/plans`) without a deploy — nothing in the
 * request path hardcodes a price.
 */
import { eq } from 'drizzle-orm'
import { getDb, plans } from '../db'

export type PlanSeed = {
  key: string
  name: string
  tagline: string
  priceMonthlyCents: number
  priceYearlyCents: number
  features: string[]
  limits: Record<string, number>
  sortOrder: number
}

export const PLAN_CATALOGUE: PlanSeed[] = [
  {
    key: 'free',
    name: 'Free',
    tagline: 'Explore the engine and run your first research cycles.',
    priceMonthlyCents: 0,
    priceYearlyCents: 0,
    features: [
      'Limited opportunities per month',
      'Basic opportunity scoring',
      'Manual approval workflow',
      'Dashboard and alerts',
      'Manual revenue and expense tracking',
    ],
    limits: { opportunitiesPerMonth: 100, analysesPerMonth: 25, projects: 1, members: 1, workflows: 1, agentRunsPerDay: 50 },
    sortOrder: 1,
  },
  {
    key: 'pro',
    name: 'Pro',
    tagline: 'For a single operator running several experiments in parallel.',
    priceMonthlyCents: 4900,
    priceYearlyCents: 49000,
    features: [
      'Higher opportunity and analysis limits',
      'Strategy and product asset generation',
      'Workflow automation with scheduling',
      'Content drafting and versioning',
      'Advanced analytics and learning engine',
      'Email, browser and webhook notifications',
    ],
    limits: { opportunitiesPerMonth: 2000, analysesPerMonth: 500, projects: 10, members: 2, workflows: 10, agentRunsPerDay: 1000 },
    sortOrder: 2,
  },
  {
    key: 'business',
    name: 'Business',
    tagline: 'For teams operating a portfolio of ventures with audit requirements.',
    priceMonthlyCents: 19900,
    priceYearlyCents: 199000,
    features: [
      'Highest limits with priority agent queue',
      'Multiple projects and team members',
      'Full audit log and approval history',
      'Custom schedules and integrations',
      'Exportable financial reporting',
    ],
    limits: { opportunitiesPerMonth: 20000, analysesPerMonth: 5000, projects: 100, members: 25, workflows: 100, agentRunsPerDay: 10000 },
    sortOrder: 3,
  },
]

/** Idempotent upsert of the catalogue — safe to run on every deploy. */
export async function seedPlanCatalogue(): Promise<number> {
  const db = await getDb()
  for (const plan of PLAN_CATALOGUE) {
    const existing = await db.select({ id: plans.id }).from(plans).where(eq(plans.key, plan.key)).limit(1)
    if (existing[0]) {
      await db.update(plans).set({ ...plan, updatedAt: new Date() }).where(eq(plans.id, existing[0].id))
    } else {
      await db.insert(plans).values({
        ...plan,
        features: plan.features as unknown as string[],
        limits: plan.limits as unknown as Record<string, number>,
      })
    }
  }
  return PLAN_CATALOGUE.length
}
