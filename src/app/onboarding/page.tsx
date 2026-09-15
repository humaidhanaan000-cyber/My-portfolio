import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getSession } from '@/lib/auth'
import { getDb, profiles } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { OnboardingWizard } from '@/components/onboarding/wizard'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Set up your workspace',
  robots: { index: false, follow: false },
}

type ProfileShape = {
  legalName: string | null
  country: string
  currency: string
  timezone: string
  interests: string[]
  skills: string[]
  industries: string[]
  businessModels: string[]
  monetizationPreferences: string[]
  riskTolerance: string
  automationLevel: string
  dailyBudgetCents: number
  monthlyBudgetCents: number
  maxProjectBudgetCents: number
  perAgentDailyLimitCents: number
  scoreThreshold: number
  notifyEmail: boolean
  notifyBrowser: boolean
  notifyTelegram: boolean
}

export default async function OnboardingPage() {
  const session = await getSession().catch(() => null)
  if (!session) redirect('/login?next=/onboarding')

  const db = await getDb()
  const row = (await db.select().from(profiles).where(eq(profiles.workspaceId, session.workspaceId)).limit(1))[0]
  const profile: ProfileShape | null = row
    ? {
        legalName: row.legalName,
        country: row.country,
        currency: row.currency,
        timezone: row.timezone,
        interests: row.interests,
        skills: row.skills,
        industries: row.industries,
        businessModels: row.businessModels,
        monetizationPreferences: row.monetizationPreferences,
        riskTolerance: row.riskTolerance,
        automationLevel: row.automationLevel,
        dailyBudgetCents: row.dailyBudgetCents,
        monthlyBudgetCents: row.monthlyBudgetCents,
        maxProjectBudgetCents: row.maxProjectBudgetCents,
        perAgentDailyLimitCents: row.perAgentDailyLimitCents,
        scoreThreshold: row.scoreThreshold,
        notifyEmail: row.notifyEmail,
        notifyBrowser: row.notifyBrowser,
        notifyTelegram: row.notifyTelegram,
      }
    : null

  const step = !profile ? 'profile' : !profile.interests.length ? 'profile' : !profile.monetizationPreferences.length ? 'monetization' : 'automation'

  return (
    <div className="min-h-screen bg-ink-50 px-4 py-10">
      <header className="mx-auto mb-8 flex max-w-2xl items-center justify-between">
        <div>
          <Link href="/" className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-ink-900 text-xs font-bold text-accent-300">AI</span>
            <span className="text-sm font-semibold tracking-tight text-ink-900">AIBA</span>
          </Link>
          <h1 className="mt-3 text-lg font-semibold tracking-tight text-ink-900">Set up your workspace</h1>
          <p className="text-xs text-ink-500">Five short steps. Everything here can be changed later in Settings.</p>
        </div>
        <Link href="/dashboard" className="text-xs font-medium text-ink-500 underline hover:text-ink-800">
          Skip to dashboard
        </Link>
      </header>
      <OnboardingWizard initialProfile={profile} initialStep={step} />
    </div>
  )
}
