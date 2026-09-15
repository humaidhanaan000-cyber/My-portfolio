'use client'

/**
 * Five-step onboarding wizard.
 *
 * Each step writes to the server immediately, so a refresh or an interruption
 * never loses progress. The final step sets the automation level, which defaults
 * to "approval required" — the safest option — and can only be changed by the
 * operator, never by an agent.
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Card, ErrorNote, Field, Input, Select, Switch } from '@/components/ui'
import { ApiClientError, api } from '@/lib/client/api'
import { AUTOMATION_LEVELS, AUTOMATION_LEVEL_LABELS, RISK_TOLERANCES } from '@/lib/utils'

type Profile = {
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

const STEPS = ['profile', 'risk', 'budget', 'monetization', 'automation'] as const
type StepKey = (typeof STEPS)[number]

const STEP_LABELS: Record<StepKey, string> = {
  profile: 'Your profile',
  risk: 'Risk tolerance',
  budget: 'Budget limits',
  monetization: 'Monetization',
  automation: 'Automation level',
}

const MONETIZATION_OPTIONS = [
  'subscription',
  'one_time_payment',
  'affiliate',
  'lead_generation',
  'services',
  'digital_products',
  'licensing',
  'advertising',
  'marketplace_fees',
]

export function OnboardingWizard({ initialProfile, initialStep }: { initialProfile: Profile | null; initialStep: string }) {
  const router = useRouter()
  const [step, setStep] = useState<StepKey>((STEPS as readonly string[]).includes(initialStep) ? (initialStep as StepKey) : 'profile')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  const [profile, setProfile] = useState({
    legalName: initialProfile?.legalName ?? '',
    country: initialProfile?.country ?? 'US',
    currency: initialProfile?.currency ?? 'USD',
    timezone: initialProfile?.timezone ?? 'UTC',
    interests: (initialProfile?.interests ?? []).join(', '),
    skills: (initialProfile?.skills ?? []).join(', '),
    industries: (initialProfile?.industries ?? []).join(', '),
    businessModels: (initialProfile?.businessModels ?? []).join(', '),
  })
  const [risk, setRisk] = useState(initialProfile?.riskTolerance ?? 'balanced')
  const [budget, setBudget] = useState({
    dailyBudgetCents: initialProfile?.dailyBudgetCents ?? 500,
    monthlyBudgetCents: initialProfile?.monthlyBudgetCents ?? 5000,
    maxProjectBudgetCents: initialProfile?.maxProjectBudgetCents ?? 20000,
    perAgentDailyLimitCents: initialProfile?.perAgentDailyLimitCents ?? 2000,
  })
  const [monetization, setMonetization] = useState<string[]>(initialProfile?.monetizationPreferences ?? [])
  const [threshold, setThreshold] = useState(initialProfile?.scoreThreshold ?? 70)
  const [automation, setAutomation] = useState(initialProfile?.automationLevel ?? 'approval_required')
  const [notify, setNotify] = useState({
    email: initialProfile?.notifyEmail ?? true,
    browser: initialProfile?.notifyBrowser ?? true,
    telegram: initialProfile?.notifyTelegram ?? false,
  })

  const stepIndex = STEPS.indexOf(step)

  function list(value: string): string[] {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 30)
  }

  async function save(target: StepKey, finish = false) {
    setPending(true)
    setError(null)
    try {
      const body: Record<string, unknown> = { step: finish ? 'complete' : target }
      if (target === 'profile') {
        body.profile = {
          legalName: profile.legalName || undefined,
          country: profile.country,
          currency: profile.currency,
          timezone: profile.timezone,
          interests: list(profile.interests),
          skills: list(profile.skills),
          industries: list(profile.industries),
          businessModels: list(profile.businessModels),
        }
      }
      if (target === 'risk') body.risk = { riskTolerance: risk }
      if (target === 'budget') body.budget = budget
      if (target === 'monetization') body.monetization = { monetizationPreferences: monetization, scoreThreshold: threshold }
      if (target === 'automation') body.automation = { automationLevel: automation, notifyEmail: notify.email, notifyBrowser: notify.browser, notifyTelegram: notify.telegram }

      await api.post('/api/onboarding', body)
      setSaved(STEP_LABELS[target])

      if (finish) {
        router.replace('/dashboard')
        router.refresh()
        return
      }
      const next = STEPS[Math.min(stepIndex + 1, STEPS.length - 1)]!
      setStep(next)
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'Could not save this step.')
    } finally {
      setPending(false)
    }
  }

  async function requestBrowserPermission() {
    if (typeof window === 'undefined' || !('Notification' in window)) return
    const permission = await Notification.requestPermission()
    setNotify((current) => ({ ...current, browser: permission === 'granted' }))
  }

  return (
    <div className="mx-auto max-w-2xl">
      <ol className="mb-8 flex flex-wrap gap-2">
        {STEPS.map((entry, index) => (
          <li key={entry} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setStep(entry)}
              className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                entry === step ? 'border-accent-500 bg-accent-50 text-accent-800' : index < stepIndex ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-ink-200 bg-white text-ink-500'
              }`}
            >
              <span className="tabular">{index + 1}</span>
              {STEP_LABELS[entry]}
            </button>
            {index < STEPS.length - 1 ? <span className="text-ink-300">→</span> : null}
          </li>
        ))}
      </ol>

      {error ? <div className="mb-4"><ErrorNote message={error} /></div> : null}
      {saved ? (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          {saved} saved. Your settings apply to the next agent run.
        </div>
      ) : null}

      <Card>
        {step === 'profile' ? (
          <div className="space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-ink-900">Tell AIBA who it is working for</h2>
              <p className="mt-1 text-xs text-ink-500">
                Interests and skills shape which opportunities the analysis agent favours. Everything is editable later in Settings.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Legal or display name">
                <Input value={profile.legalName} onChange={(event) => setProfile({ ...profile, legalName: event.target.value })} placeholder="Alex Morgan" />
              </Field>
              <Field label="Country" hint="Two-letter code, e.g. US, GB, LK.">
                <Input maxLength={2} value={profile.country} onChange={(event) => setProfile({ ...profile, country: event.target.value.toUpperCase() })} />
              </Field>
              <Field label="Currency">
                <Select value={profile.currency} onChange={(event) => setProfile({ ...profile, currency: event.target.value })}>
                  {['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'INR', 'LKR', 'SGD', 'AED', 'JPY', 'BRL', 'ZAR'].map((code) => (
                    <option key={code} value={code}>{code}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Timezone" hint="Used for schedule evaluation and daily limits.">
                <Input value={profile.timezone} onChange={(event) => setProfile({ ...profile, timezone: event.target.value })} placeholder="UTC" />
              </Field>
            </div>
            <Field label="Interests" hint="Comma separated. Example: automation, health, logistics.">
              <Input value={profile.interests} onChange={(event) => setProfile({ ...profile, interests: event.target.value })} />
            </Field>
            <Field label="Skills" hint="Comma separated. These influence realism checks on difficulty.">
              <Input value={profile.skills} onChange={(event) => setProfile({ ...profile, skills: event.target.value })} />
            </Field>
            <Field label="Industries you understand" hint="Comma separated.">
              <Input value={profile.industries} onChange={(event) => setProfile({ ...profile, industries: event.target.value })} />
            </Field>
            <Field label="Business models you prefer" hint="Comma separated, e.g. saas, marketplace, affiliate.">
              <Input value={profile.businessModels} onChange={(event) => setProfile({ ...profile, businessModels: event.target.value })} />
            </Field>
            <div className="flex justify-end">
              <Button onClick={() => save('profile')} loading={pending}>Save and continue</Button>
            </div>
          </div>
        ) : null}

        {step === 'risk' ? (
          <div className="space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-ink-900">How much risk should AIBA score for?</h2>
              <p className="mt-1 text-xs text-ink-500">
                This is applied to the risk dimension of every opportunity score. It does not change what the agents are allowed to do —
                that is the automation level in step five.
              </p>
            </div>
            <div className="grid gap-3">
              {RISK_TOLERANCES.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setRisk(option)}
                  className={`rounded-xl border p-4 text-left transition-colors ${
                    risk === option ? 'border-accent-500 bg-accent-50' : 'border-ink-200 bg-white hover:border-ink-300'
                  }`}
                >
                  <p className="text-sm font-medium text-ink-900 capitalize">{option}</p>
                  <p className="mt-1 text-xs text-ink-600">
                    {option === 'conservative'
                      ? 'Prefers proven demand, low startup cost and fast time to revenue. Penalises anything speculative.'
                      : option === 'aggressive'
                        ? 'Accepts higher cost, longer payback and more competitive spaces if the upside is larger.'
                        : 'Balanced weighting between expected upside and downside.'}
                  </p>
                </button>
              ))}
            </div>
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep('profile')}>Back</Button>
              <Button onClick={() => save('risk')} loading={pending}>Save and continue</Button>
            </div>
          </div>
        ) : null}

        {step === 'budget' ? (
          <div className="space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-ink-900">Set the hard limits</h2>
              <p className="mt-1 text-xs text-ink-500">
                These are ceilings, not targets. Every paid action checks the remaining budget first; if a limit would be exceeded, the
                action stops and raises an approval request instead of spending.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Daily limit (USD cents)" hint={centsHint(budget.dailyBudgetCents)}>
                <Input type="number" min={0} value={budget.dailyBudgetCents} onChange={(event) => setBudget({ ...budget, dailyBudgetCents: Number(event.target.value) })} />
              </Field>
              <Field label="Monthly limit (USD cents)" hint={centsHint(budget.monthlyBudgetCents)}>
                <Input type="number" min={0} value={budget.monthlyBudgetCents} onChange={(event) => setBudget({ ...budget, monthlyBudgetCents: Number(event.target.value) })} />
              </Field>
              <Field label="Maximum per project (USD cents)" hint={centsHint(budget.maxProjectBudgetCents)}>
                <Input type="number" min={0} value={budget.maxProjectBudgetCents} onChange={(event) => setBudget({ ...budget, maxProjectBudgetCents: Number(event.target.value) })} />
              </Field>
              <Field label="Per agent, per day (USD cents)" hint={centsHint(budget.perAgentDailyLimitCents)}>
                <Input type="number" min={0} value={budget.perAgentDailyLimitCents} onChange={(event) => setBudget({ ...budget, perAgentDailyLimitCents: Number(event.target.value) })} />
              </Field>
            </div>
            <p className="rounded-lg border border-ink-200 bg-ink-50 px-3 py-2 text-xs text-ink-600">
              A limit of 0 means &quot;not configured&quot; for that scope, which leaves the other limits in force. Setting a daily limit of 0
              and a monthly limit of 0 disables new paid work entirely — agents will keep asking for approval.
            </p>
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep('risk')}>Back</Button>
              <Button onClick={() => save('budget')} loading={pending}>Save and continue</Button>
            </div>
          </div>
        ) : null}

        {step === 'monetization' ? (
          <div className="space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-ink-900">How should projects make money?</h2>
              <p className="mt-1 text-xs text-ink-500">
                Opportunities whose business model is missing from this list are scored lower, so the research agent focuses on what you
                are actually willing to run.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {MONETIZATION_OPTIONS.map((option) => {
                const active = monetization.includes(option)
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setMonetization(active ? monetization.filter((entry) => entry !== option) : [...monetization, option])}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                      active ? 'border-accent-500 bg-accent-50 text-accent-800' : 'border-ink-200 bg-white text-ink-600 hover:border-ink-300'
                    }`}
                  >
                    {option.replace(/_/g, ' ')}
                  </button>
                )
              })}
            </div>
            <Field label="Score threshold" hint="Opportunities below this score are kept but not escalated to strategy. Typically 65–80.">
              <Input type="number" min={0} max={100} value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} />
            </Field>
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep('budget')}>Back</Button>
              <Button onClick={() => save('monetization')} loading={pending} disabled={monetization.length === 0}>Save and continue</Button>
            </div>
          </div>
        ) : null}

        {step === 'automation' ? (
          <div className="space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-ink-900">Choose your automation level</h2>
              <p className="mt-1 text-xs text-ink-500">
                This decides what AIBA may do without asking. Public, paid and irreversible actions always require approval, at every
                level.
              </p>
            </div>
            <div className="grid gap-3">
              {AUTOMATION_LEVELS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setAutomation(option)}
                  className={`rounded-xl border p-4 text-left transition-colors ${
                    automation === option ? 'border-accent-500 bg-accent-50' : 'border-ink-200 bg-white hover:border-ink-300'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-ink-900">{AUTOMATION_LEVEL_LABELS[option]}</p>
                    {option === 'approval_required' ? <span className="text-[11px] font-medium text-accent-700">Recommended</span> : null}
                  </div>
                  <p className="mt-1 text-xs text-ink-600">
                    {option === 'recommend_only'
                      ? 'AIBA researches, scores and drafts, then stops. You perform every action yourself.'
                      : option === 'approval_required'
                        ? 'Low-risk internal steps run automatically. Creating projects, publishing, spending and launching wait for your approval.'
                        : 'Low-risk internal steps run automatically, including creating project containers. Spending, publishing, launching and account actions still require approval.'}
                  </p>
                </button>
              ))}
            </div>

            <div className="rounded-xl border border-ink-200 bg-white p-4">
              <p className="text-xs font-semibold text-ink-800">Notification channels</p>
              <Switch
                checked={notify.email}
                onChange={(value) => setNotify({ ...notify, email: value })}
                label="Email"
                description="Approval requests, budget stops, launch results and reports."
              />
              <Switch
                checked={notify.browser}
                onChange={(value) => {
                  if (value) void requestBrowserPermission()
                  else setNotify({ ...notify, browser: false })
                }}
                label="Browser notifications"
                description="Shown while the dashboard is open. Requires browser permission."
              />
              <Switch
                checked={notify.telegram}
                onChange={(value) => setNotify({ ...notify, telegram: value })}
                label="Telegram"
                description="Requires TELEGRAM_BOT_TOKEN on the server and your chat id in Settings."
              />
            </div>

            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep('monetization')}>Back</Button>
              <Button onClick={() => save('automation', true)} loading={pending}>Finish setup</Button>
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  )
}

function centsHint(cents: number): string {
  return `$${(cents / 100).toFixed(2)} per ${cents === 0 ? '— disabled' : 'period'}`
}
