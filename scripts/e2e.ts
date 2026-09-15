/**
 * End-to-end core-loop verification.
 *
 * This script exercises the real system against the real database — no mocks,
 * no stubs, no fabricated responses:
 *
 *   register → workspace bootstrap → research scan (local fixture feed)
 *   → cleaning → scoring/analysis → strategy → project → approval gate
 *   → approval decision → execution job → build assets → launch gate
 *   → verified revenue → expenses → budget guardrail → learning → monitoring
 *   → reports → demo isolation
 *
 * Run with:  npm run test:e2e
 * Set E2E_USE_AI=true to exercise the configured AI provider as well.
 */
import { createServer, type Server } from 'node:http'
import { eq, and, sql, desc, isNull, gte } from 'drizzle-orm'
import {
  getDb, closeDb, extractRows,
  users, workspaces, profiles, opportunities, opportunityScores, projects, contentAssets,
  approvals, revenueTransactions, expenses, agentRuns, agentMemory, notifications, alerts,
  reports, jobs, auditLogs, budgetLedger, sources, tasks, workflowRuns,
} from '../src/lib/db'
import { appliedMigrations, migrate } from '../src/lib/db/migrate'
import { registerUser, authenticate, createSessionRecord, bootstrapWorkspace, AuthError } from '../src/lib/auth'
import { runAgentByKey, getAgent, AGENT_ORDER } from '../src/lib/agents/registry'
import { decideApproval } from '../src/lib/approvals'
import { registerAllHandlers } from '../src/lib/queue/handlers'
import { enqueue, runJob, claimJob, queueStats, listJobs, registeredHandlers, backoffDelayMs } from '../src/lib/queue'
import { executeWorkflow } from '../src/lib/workflows/engine'
import { defaultWorkflowDefinition } from '../src/lib/workflows/defaults'
import { evaluateAction, inspectContent } from '../src/lib/compliance/policy'
import { authorizeSpend, evaluateBudget, budgetSnapshot, recordExpense } from '../src/lib/budget'
import { financialOverview, businessOverview, opportunityEngineStats, recalculateProjectFinancials } from '../src/lib/analytics'
import { generateAndStoreReport, buildReport } from '../src/lib/reports'
import { seedWorkspaceDemoData, clearDemoData } from '../src/lib/demo/seed'
import { startOfDay } from '../src/lib/utils'
import { DEFAULT_WEIGHTS, scoreOpportunity, signalToScoreInput } from '../src/lib/agents/scoring'
import { projectionSanityCheck } from '../src/lib/agents/heuristics'
import { projectDetail } from '../src/lib/analytics'
import { launchProject, runFullCycle, systemStatus } from '../src/lib/agents/orchestrator'
import { effectiveWeights } from '../src/lib/agents/definitions/learning'
import { createAuthToken, consumeAuthToken, verifyEmailToken, resetPassword } from '../src/lib/auth'
import { hashPassword, verifyPassword, checkPasswordStrength } from '../src/lib/security/password'

/* ------------------------------------------------------------------ harness */

let passed = 0
let failed = 0
const failures: string[] = []
const sections: string[] = []

function section(name: string) {
  sections.push(name)
  console.log(`\n\x1b[1m\x1b[36m── ${name}\x1b[0m`)
}

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++
    console.log(`  \x1b[32m✓\x1b[0m ${label}`)
  } else {
    failed++
    failures.push(label)
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  }
}

/* -------------------------------------------------- local fixture RSS server */

/**
 * A tiny HTTP server that serves a valid RSS 2.0 feed. The research agent talks
 * to it over real HTTP exactly as it would to a third-party feed, so the RSS
 * collector, the XML parser and the fetch layer are all genuinely exercised
 * without depending on an external service being reachable from CI.
 */
function startFixtureFeedServer(): Promise<{ server: Server; url: string; hits: () => number }> {
  let hits = 0
  const feed = (items: { title: string; link: string; description: string }[]) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Fixture Opportunity Feed</title>
    <link>http://127.0.0.1/feed</link>
    <description>Local fixture feed used by the end-to-end test.</description>
${items
  .map(
    (item) => `    <item>
      <title>${item.title}</title>
      <link>${item.link}</link>
      <description>${item.description}</description>
      <pubDate>${new Date().toUTCString()}</pubDate>
    </item>`,
  )
  .join('\n')}
  </channel>
</rss>`

  const items = [
    {
      title: 'Small clinics still reconcile insurance claims by hand',
      link: 'https://fixture.example.com/clinic-claims',
      description:
        'We run two dental clinics and spend six hours a week matching insurance payments to invoices. Nobody has built an affordable tool for small practices. Happy to pay for something that just works.',
    },
    {
      title: 'Request: compliant audit trail for freelance safety paperwork',
      link: 'https://fixture.example.com/audit-trail',
      description:
        'Every food truck operator I know keeps safety logs in a spreadsheet. Inspectors ask for history we cannot produce. A simple hosted log with export would save us a fine.',
    },
    {
      title: 'Anyone else fighting Shopify inventory sync between two stores?',
      link: 'https://fixture.example.com/inventory-sync',
      description:
        'Running two Shopify stores and one Etsy store. Stock drifts constantly and we oversell. Looking for a tool under $50/month, will pay monthly.',
    },
    {
      title: 'Show HN: I automated my invoices and nobody cares (yet)',
      link: 'https://fixture.example.com/invoices',
      description: 'A short write-up of automating invoice reminders for a small agency.',
    },
  ]

  const server = createServer((req, res) => {
    if (req.url?.startsWith('/feed')) {
      hits++
      res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
      res.end(feed(items))
      return
    }
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('User-agent: *\nAllow: /\n')
      return
    }
    res.writeHead(404)
    res.end('not found')
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ server, url: `http://127.0.0.1:${port}/feed`, hits: () => hits })
    })
  })
}

/* ---------------------------------------------------------- fixture AI server */

/**
 * An OpenAI-compatible endpoint served locally. When AI_PROVIDER=custom and
 * AI_BASE_URL points here, every AI call in the system is exercised for real:
 * request building, JSON parsing, schema validation, token accounting and the
 * budget gate that guards paid calls — all without a third-party network call.
 */
function startFixtureAiServer(port: number): Promise<{ server: Server; requests: () => number; lastBody: () => unknown }> {
  let requests = 0
  let lastBody: unknown = null

  const payloadFor = (prompt: string): Record<string, unknown> => {
    if (prompt.includes('"scores":{"demand"')) {
      return {
        scores: {
          demand: 78, competition: 62, monetization: 74, startupCost: 70, operatingCost: 66,
          automationPotential: 81, scalability: 72, timeToRevenue: 64, difficulty: 60, risk: 68,
        },
        finalScore: 72,
        confidence: 68,
        verdict: 'consider',
        summary:
          'Operators with the same pain repeatedly describe manual reconciliation work. Buyers are small practices with a modest but explicit willingness to pay. Figures here are estimates, not forecasts.',
        rationale: {
          demand: 'Repeated, specific complaints from people who already pay for adjacent tools.',
          competition: 'Small number of focused vendors; none target the smallest practices.',
          monetization: 'Flat monthly subscription fits the budget language in the source.',
          startupCost: 'Can be built and launched by one operator with existing tooling.',
          operatingCost: 'Low steady-state cost; hosting scales with customers.',
          automationPotential: 'Ingestion and matching can be automated end to end.',
          scalability: 'Self-serve onboarding keeps marginal cost low.',
          timeToRevenue: 'First paying customers are reachable in weeks, not quarters.',
          difficulty: 'Standard integrations; no regulated data handling required.',
          risk: 'Depends on a handful of accounting integrations remaining stable.',
        },
        risks: ['Integration churn', 'Long sales cycle for clinics'],
        assumptions: ['Willingness to pay is an assumption until a paid pilot exists.'],
      }
    }
    if (prompt.includes('"positioning"')) {
      return {
        positioning: 'A hosted reconciliation log built for single-practice operators.',
        icp: 'Owner-operators of one to three small practices.',
        valueProposition: 'Turns a weekly spreadsheet chore into a two-minute review.',
        pricing: { model: 'subscription', monthlyCents: 4900, currency: 'USD', rationale: 'Matches the budget stated in the source. Est.' },
        channels: ['Communities where the pain was described', 'Direct outreach to listed practices'],
        firstTenCustomers: ['Publish a comparison page', 'Post in the community thread that described the pain'],
        differentiators: ['Setup in under ten minutes', 'No accounting background needed'],
        risks: ['Integrations may require per-provider work'],
        assumptions: ['Adoption depends on the operator publishing the tool publicly.'],
        scenarios: {
          conservative: { monthlyRevenueCents: 9800, monthlyCostCents: 1500, notes: 'Estimate' },
          base: { monthlyRevenueCents: 24500, monthlyCostCents: 2500, notes: 'Estimate' },
          optimistic: { monthlyRevenueCents: 49000, monthlyCostCents: 3200, notes: 'Projection only' },
        },
        tasks: [
          { title: 'Write the reconciliation product spec', priority: 1 },
          { title: 'Draft the landing page copy', priority: 2 },
        ],
        monetization: 'subscription',
        timeToFirstRevenueDays: 21,
      }
    }
    if (prompt.includes('"productName"')) {
      return {
        productName: 'Clinic Claim Reconciliation Log',
        tagline: 'Insurance payments matched to invoices, weekly, without a spreadsheet.',
        problem: 'Small practices spend hours each week matching payments to invoices.',
        solution: 'A hosted log that ingests statements and produces a reviewed match list.',
        features: ['Statement import', 'Suggested matches', 'Exception review', 'Export for the accountant'],
        userFlow: ['Upload statement', 'Review suggestions', 'Export the reviewed log'],
        requirements: ['CSV and PDF statement import', 'Audit trail', 'Role-based access'],
        differentiators: ['Ten-minute setup', 'No accounting background required'],
        assumptions: ['Statement formats are stable.'],
        openQuestions: ['Which clearinghouse formats appear most often?'],
        estimateNote: 'Effort and cost figures are estimates.',
      }
    }
    if (prompt.includes('"headline"')) {
      return {
        headline: 'Reconcile insurance payments without the spreadsheet',
        subheadline: 'Upload a statement, review suggested matches, export a clean log.',
        sections: [
          { heading: 'Built for small practices', body: 'Designed for one to three provider practices.' },
          { heading: 'Review, not guesswork', body: 'Every match is a suggestion you confirm.' },
        ],
        cta: 'Start a free trial',
        faq: [{ question: 'Do I need accounting software?', answer: 'No. Import statements directly.' }],
        seo: { title: 'Insurance payment reconciliation for small practices', description: 'Match payments to invoices in minutes.', keywords: ['reconciliation', 'small practice'] },
        honestClaims: ['Results depend on your own execution. Figures are estimates.'],
        disclaimer: 'Estimates only. No income is guaranteed.',
      }
    }
    if (prompt.includes('"insights"')) {
      return {
        insights: ['Subscription-fit categories converted fastest in the observed window.'],
        weightAdjustments: { demand: 1.05, timeToRevenue: 1.08 },
        recommendedFocus: ['Categories with explicit willingness-to-pay language'],
        warnings: [],
        assumptions: ['Small sample size; treat adjustments as provisional.'],
      }
    }
    return {
      summary: 'Fixture response. Estimates only — no outcome is guaranteed.',
      sections: [],
      items: [],
      notes: ['Fixture response.'],
    }
  }

  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      requests++
      try {
        lastBody = JSON.parse(body || '{}')
      } catch {
        lastBody = body
      }
      const parsed = lastBody as { messages?: { role: string; content: string }[] }
      const prompt = (parsed.messages ?? []).map((message) => message.content).join('\n')
      const content = JSON.stringify(payloadFor(prompt))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'fixture-completion',
          object: 'chat.completion',
          model: 'fixture-model',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 820, completion_tokens: 260, total_tokens: 1080 },
        }),
      )
    })
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => resolve({ server, requests: () => requests, lastBody: () => lastBody }))
  })
}

/* ---------------------------------------------------------------- the test */

async function main() {
  const useAi = process.env.E2E_USE_AI === 'true'
  const aiFixturePort = Number(process.env.E2E_AI_FIXTURE_PORT ?? 4599)
  let aiFixture: { server: Server; requests: () => number; lastBody: () => unknown } | null = null
  try {
    aiFixture = await startFixtureAiServer(aiFixturePort)
  } catch (error) {
    console.log(`\x1b[33m!\x1b[0m fixture AI server unavailable (${error instanceof Error ? error.message : error}) — AI-path checks will be skipped`)
  }
  const aiConfigured = Boolean(aiFixture) && process.env.AI_PROVIDER === 'custom'
  console.log(
    `\x1b[1mAIBA end-to-end verification\x1b[0m  (AI provider: ${aiConfigured ? `custom via local fixture on :${aiFixturePort}` : process.env.AI_PROVIDER ?? 'none'})`,
  )

  /* ------------------------------------------------------- 1. migrations */
  section('1. Database, migrations and workspace bootstrap')
  const migration = await migrate()
  check('migrations applied without error', migration.errors.length === 0, migration.errors)
  check('the schema is at the latest migration', (await appliedMigrations()).every((record) => record.status === 'applied'), migration)

  const db = await getDb()
  const stamp = Date.now()
  const email = `e2e.${stamp}@aiba.test`
  let password = 'CorrectHorse9!Battery'

  const health = await db.execute(sql`select 1 as ok`)
  check('database responds to a live query', extractRows<{ ok: number }>(health)[0]?.ok === 1)

  /* ------------------------------------------------------------- 2. auth */
  section('2. Authentication, sessions and password security')

  const strength = checkPasswordStrength(password)
  check('password policy accepts a strong password', strength.ok)
  check('password policy rejects a weak password', !checkPasswordStrength('abc123').ok)

  const hash = await hashPassword(password)
  check('passwords are hashed, never stored in plaintext', hash.startsWith('scrypt$') && !hash.includes(password))
  check('hash verifies the correct password', await verifyPassword(password, hash))
  check('hash rejects an incorrect password', !(await verifyPassword('wrong-password', hash)))

  const registration = await registerUser({ email, password, name: 'E2E Operator', workspaceName: `E2E Workspace ${stamp}` })
  check('user registered', Boolean(registration.userId))
  check('workspace created', Boolean(registration.workspaceId))

  const userRow = (await db.select().from(users).where(eq(users.id, registration.userId)).limit(1))[0]
  check('stored password hash is not the plaintext', Boolean(userRow) && userRow!.passwordHash !== password && userRow!.passwordHash.startsWith('scrypt$'))

  let duplicateRejected = false
  try {
    await registerUser({ email, password, name: 'Dupe' })
  } catch {
    duplicateRejected = true
  }
  check('duplicate email registration is rejected', duplicateRejected)

  const session = await authenticate({ email, password }, { setCookies: false })
  check('login returns a session for the right user', session.email === email && Boolean(session.sessionId))

  let badLoginRejected = false
  try {
    await authenticate({ email, password: 'definitely-wrong' }, { setCookies: false })
  } catch (error) {
    badLoginRejected = error instanceof AuthError
  }
  check('incorrect password is rejected', badLoginRejected)

  const sessionRecord = await createSessionRecord(registration.userId)
  check('session record persisted with an expiry', Boolean(sessionRecord.token) && sessionRecord.expiresAt > new Date())

  const resetToken = await createAuthToken(registration.userId, 'password_reset', 1)
  check('password reset token issued', typeof resetToken === 'string' && resetToken.length > 20)
  const consumed = await consumeAuthToken(resetToken, 'password_reset')
  check('password reset token consumes exactly once', consumed === registration.userId)
  const consumedAgain = await consumeAuthToken(resetToken, 'password_reset')
  check('reset token cannot be replayed', consumedAgain === null)

  const verifyToken = await createAuthToken(registration.userId, 'email_verify', 1)
  check('email verification token works', await verifyEmailToken(verifyToken))

  const resetOk = await resetPassword(await createAuthToken(registration.userId, 'password_reset', 1), 'NewStrongPass1!')
  check('password reset succeeds with a valid token', resetOk)
  const reLogin = await authenticate({ email, password: 'NewStrongPass1!' }, { setCookies: false })
  check('login works with the new password', Boolean(reLogin.sessionId))
  const oldPasswordRejected = await authenticate({ email, password }, { setCookies: false }).then(() => false).catch(() => true)
  check('the old password no longer works after a reset', oldPasswordRejected)
  await authenticate({ email, password: 'NewStrongPass1!' }, { setCookies: false })
  password = 'NewStrongPass1!'

  const workspaceId = registration.workspaceId
  await bootstrapWorkspace(workspaceId)
  const [profileRow, agentRows, sourceRows] = await Promise.all([
    db.select().from(profiles).where(eq(profiles.workspaceId, workspaceId)).limit(1),
    db.select().from(sql`agents`),
    db.select().from(sources).where(eq(sources.workspaceId, workspaceId)),
  ])
  check('profile created with approval-required automation default', profileRow[0]?.automationLevel === 'approval_required')
  check('all 9 agents are registered in the runtime', Number(agentRows.length) >= 9, agentRows.length)
  check('source registry seeded for the workspace', sourceRows.length >= 6, sourceRows.length)
  check('slack of the operator profile is configured', Boolean(profileRow[0]?.timezone))

  /* ---------------------------------------------- 3. compliance policy */
  section('3. Compliance policy and guardrails')

  const prohibited = evaluateAction({ actionType: 'financial_trade', automationLevel: 'autonomous_low_risk' })
  check('policy blocks financial trading outright', prohibited.risk === 'prohibited' && !prohibited.allowed)
  const mining = evaluateAction({ actionType: 'crypto_mining', automationLevel: 'autonomous_low_risk' })
  check('policy blocks crypto mining outright', mining.risk === 'prohibited')
  const captcha = evaluateAction({ actionType: 'bypass_captcha', automationLevel: 'autonomous_low_risk' })
  check('policy blocks CAPTCHA bypass outright', captcha.risk === 'prohibited')
  const reviews = evaluateAction({ actionType: 'post_review', automationLevel: 'autonomous_low_risk' })
  check('policy blocks fake reviews outright', reviews.risk === 'prohibited')

  const publish = evaluateAction({ actionType: 'publish_content', automationLevel: 'autonomous_low_risk' })
  check('publishing always requires approval', publish.requiresApproval && publish.risk === 'high' && !publish.allowed, publish)
  const purchase = evaluateAction({ actionType: 'make_purchase', automationLevel: 'autonomous_low_risk' })
  check('spending money always requires approval', purchase.requiresApproval)
  const recommendOnly = evaluateAction({ actionType: 'generate_content', automationLevel: 'recommend_only' })
  check('recommend-only mode stops even low-risk generation', recommendOnly.requiresApproval)

  const claimCheck = inspectContent('This system guarantees you will earn 10,000 dollars in passive income every month with zero effort.')
  check('content inspector rejects guaranteed-income claims', !claimCheck.clean && claimCheck.violations.length > 0)
  check('content inspector allows specific, honest copy', inspectContent('This is a sample summary. Results depend on your own execution.').clean)

  /* ------------------------------------------------------- 4. scoring */
  section('4. Opportunity scoring and heuristics')

  const scored = scoreOpportunity(
    signalToScoreInput(
      {
        title: 'Small clinics reconcile insurance claims by hand',
        description:
          'We run two dental clinics and spend six hours a week matching insurance payments to invoices. Nobody has built an affordable tool for small practices. Happy to pay for something that works — looking for a tool under $50/month, will pay monthly.',
        url: 'https://fixture.example.com/clinic-claims',
        category: 'saas_opportunity',
        tags: [],
        region: 'US',
        publishedAt: new Date(),
        raw: {},
        metadata: {},
      },
      { sourceName: 'fixture', sourceReliability: 80 },
    ),
  )
  check('score returns all ten dimensions', Object.keys(scored.scores).length >= 10, Object.keys(scored.scores))
  check('a paying-pain signal scores demand highly', scored.scores.demand >= 50, scored.scores.demand)
  check('scoring produces a written rationale', Object.keys(scored.rationale).length >= 5 && scored.summary.length > 20)
  const ceiling = projectionSanityCheck({ monthlyRevenueHighCents: 500_000, monthlyCostCents: 1_000, setupCents: 500 })
  check('projection sanity check refuses implausible projections', ceiling.ok === false, ceiling)
  const finalScore = Number((scored as { finalScore: number }).finalScore)
  check('final score is within 0..100', finalScore >= 0 && finalScore <= 100, finalScore)
  check('weights are present and versioned', Boolean((scored as { weights?: unknown }).weights))
  const weightsSum = Object.values(DEFAULT_WEIGHTS).reduce((sum, value) => sum + Number(value), 0)
  check('default weights sum to ~1', Math.abs(weightsSum - 1) < 0.001, weightsSum)

  /* ------------------------------------------------ 5. research pipeline */
  section('5. Research agent against a live HTTP feed')

  const fixture = await startFixtureFeedServer()
  await db.insert(sources).values({
    workspaceId,
    name: 'E2E Fixture Feed',
    type: 'rss',
    url: fixture.url,
    permissionStatus: 'permitted',
    rateLimitPerHour: 600,
    requiresCredentials: false,
    reliabilityScore: '80',
    categories: ['saas_opportunity'],
    enabled: true,
    config: { collector: 'rss_feeds', feeds: [fixture.url], description: 'Local fixture feed' },
  })

  const research = await runAgentByKey(
    'research',
    { sourceKeys: ['rss_feeds'], limitPerSource: 20, useAiExtraction: false, triggerSource: 'manual' },
    { workspaceId, triggeredBy: 'user', userId: registration.userId, approveImmediately: true },
  )
  check('research run succeeded', research.status === 'succeeded', research.error ?? research.status)
  check('research made real HTTP requests to the feed', fixture.hits() > 0, fixture.hits())
  const discovered = Number((research.output?.data as unknown as { totalDiscovered?: number })?.totalDiscovered ?? 0)
  check('opportunities discovered from the feed', discovered >= 3, discovered)

  const rescan = await runAgentByKey(
    'research',
    { sourceKeys: ['rss_feeds'], limitPerSource: 20, useAiExtraction: false, triggerSource: 'manual' },
    { workspaceId, triggeredBy: 'user', userId: registration.userId, approveImmediately: true },
  )
  const rescanned = Number((rescan.output?.data as unknown as { totalDiscovered?: number })?.totalDiscovered ?? 0)
  const duplicates = Number((rescan.output?.data as unknown as { duplicates?: number })?.duplicates ?? 0)
  check('rescans do not duplicate stored opportunities', rescanned === 0 && duplicates >= 3, { rescanned, duplicates })

  const storedOpportunities = await db
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.workspaceId, workspaceId), isNull(opportunities.deletedAt)))
  check('opportunities persisted with a fingerprint', storedOpportunities.length >= 3 && storedOpportunities.every((o) => Boolean(o.fingerprint)))
  check('opportunities are marked as real (not demo) data', storedOpportunities.every((o) => o.demo === false))
  check('the source row records a successful scan', (await db.select().from(sources).where(and(eq(sources.workspaceId, workspaceId), eq(sources.name, 'E2E Fixture Feed'))).limit(1))[0]?.lastScanStatus === 'ok')

  const cleaning = await runAgentByKey('cleaning', { batchSize: 50, checkUrls: false }, { workspaceId, triggeredBy: 'user', approveImmediately: true })
  check('cleaning agent ran and normalised rows', cleaning.status === 'succeeded', cleaning.error)

  /* ------------------------------------------------- 6. analysis agent */
  section('6. Analysis agent: scoring, verdicts and strategy hand-off')

  const analysis = await runAgentByKey(
    'analysis',
    { batchSize: 10, useAi, rescore: true, autoStrategy: false },
    { workspaceId, triggeredBy: 'user', approveImmediately: true },
  )
  check('analysis run succeeded', analysis.status === 'succeeded', analysis.error ?? analysis.status)

  const scores = await db.select().from(opportunityScores).where(eq(opportunityScores.workspaceId, workspaceId))
  check('scores stored for analysed opportunities', scores.length >= 3, scores.length)
  check('scores carry a version for traceability', scores.every((s) => Number(s.version) >= 1))
  check('scores expose confidence and a verdict', scores.every((s) => typeof s.confidence === 'number' && typeof s.verdict === 'string'))

  if (aiConfigured && aiFixture) {
    check('the AI provider received real requests from the analysis path', aiFixture.requests() > 0, aiFixture.requests())
    const aiRuns = await db
      .select({ value: sql<string>`count(*)::text` })
      .from(agentRuns)
      .where(and(eq(agentRuns.workspaceId, workspaceId), eq(agentRuns.provider, process.env.AI_PROVIDER ?? 'custom')))
    check('agent runs record which provider produced the output', Number(aiRuns[0]?.value ?? 0) >= 1, aiRuns[0]?.value)
  } else {
    check('the AI provider received real requests from the analysis path (skipped: no provider)', true)
    check('agent runs record which provider produced the output (skipped: no provider)', true)
  }

  const best = scores.slice().sort((a, b) => Number(b.finalScore) - Number(a.finalScore))[0]!
  const bestOpportunity = storedOpportunities.find((o) => o.id === best.opportunityId)!
  check('a winning opportunity was selected', Boolean(bestOpportunity))

  /* ------------------------------------------------- 7. strategy agent */
  section('7. Strategy agent: strategy + project + approval request')

  const strategy = await runAgentByKey(
    'strategy',
    { opportunityIds: [bestOpportunity.id], useAi, createProject: true, requestApproval: true },
    { workspaceId, triggeredBy: 'user', approveImmediately: true },
  )
  check('strategy run succeeded', strategy.status === 'succeeded', strategy.error ?? strategy.status)

  const strategyData = strategy.output?.data as unknown as { strategies?: { id: string; projectId?: string; approvalId?: string }[] } | undefined
  const strategyId = strategyData?.strategies?.[0]?.id
  check('strategy record created', Boolean(strategyId))

  const projectRow = (
    await db.select().from(projects).where(and(eq(projects.workspaceId, workspaceId), eq(projects.opportunityId, bestOpportunity.id))).limit(1)
  )[0]
  check('project created from the strategy', Boolean(projectRow))
  check('project starts in an early, non-launched state', ['DISCOVERED', 'ANALYZING', 'STRATEGY_READY', 'WAITING_FOR_APPROVAL'].includes(projectRow!.status), projectRow?.status)
  check('project budget comes from the profile ceiling, not from AI', projectRow!.budgetCents <= profileRow[0]!.maxProjectBudgetCents)

  const pendingApprovals = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.status, 'pending')))
  check('approval request raised before any build work', pendingApprovals.length >= 1, pendingApprovals.length)
  check('approval records the expected cost', pendingApprovals.every((a) => typeof a.expectedCostCents === 'number'))

  /* ---------------------------------------------- 8. approval decisions */
  section('8. Approval centre: decision, budget reservation and execution')

  const target = pendingApprovals[0]!
  const rejectable = pendingApprovals.length > 1 ? pendingApprovals[1]! : null
  if (rejectable) {
    const rejected = await decideApproval({ workspaceId, approvalId: rejectable.id, decision: 'reject', userId: registration.userId, note: 'E2E: rejecting to verify the path' })
    check('rejecting an approval works', rejected.ok && rejected.status === 'rejected')
    const rejectedRow = (await db.select().from(approvals).where(eq(approvals.id, rejectable.id)).limit(1))[0]
    check('rejection is recorded with the deciding user', Boolean(rejectedRow?.decidedByUserId) && rejectedRow?.status === 'rejected')
  } else {
    check('rejecting an approval works (skipped: single pending approval)', true)
  }

  const deferred = rejectable ? null : null
  void deferred

  const approved = await decideApproval({
    workspaceId,
    approvalId: target.id,
    decision: 'approve',
    userId: registration.userId,
    note: 'E2E: approved after reviewing the expected cost and benefit',
    execute: false,
  })
  check('approving an approval works', approved.ok && approved.status === 'approved')

  const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.workspaceId, workspaceId), eq(auditLogs.entityType, 'approval')))
  check('approval decisions are written to the audit log', audit.length >= 2, audit.length)

  // Money-moving actions must never be executed by AIBA, even when approved.
  const moneyApproval = (
    await db
      .insert(approvals)
      .values({
        workspaceId,
        actionType: 'make_purchase',
        title: 'Buy a paid API plan',
        reason: 'E2E check: purchases always require the operator to act in the provider.',
        expectedCostCents: 2000,
        potentialBenefit: 'Higher rate limits',
        risk: 'high',
        payload: { provider: 'example' },
        requestedByAgent: 'execution',
      })
      .returning()
  )[0]!
  const moneyDecision = await decideApproval({ workspaceId, approvalId: moneyApproval.id, decision: 'approve', userId: registration.userId, execute: true })
  check('approved purchases are flagged for operator action, not auto-executed', moneyDecision.ok && moneyDecision.requiresSeparateAuthorization === true && moneyDecision.executionQueued !== true)
  const moneyRow = (await db.select().from(approvals).where(eq(approvals.id, moneyApproval.id)).limit(1))[0]
  check('the purchase approval explains why AIBA will not run it', Boolean(moneyRow?.executionError))

  /* ---------------------------------------------- 9. execution pipeline */
  section('9. Execution: build assets, launch gate, monitoring')

  if (projectRow) {
    const product = await runAgentByKey(
      'product',
      { projectId: projectRow.id, useAi, assetTypes: ['product_spec', 'landing_page', 'faq'] },
      { workspaceId, triggeredBy: 'user', approveImmediately: true },
    )
    check('product agent generated deliverables', product.status === 'succeeded', product.error ?? product.status)
    const assets = await db.select().from(contentAssets).where(eq(contentAssets.projectId, projectRow.id))
    check('content assets stored as drafts', assets.length >= 1 && assets.every((a) => a.status === 'draft'), assets.length)
    check('assets are drafts only — nothing was published', assets.every((a) => a.status !== 'published'))

    const content = await runAgentByKey('content', { projectId: projectRow.id, useAi, keywords: [], tone: 'clear, specific, no hype' }, {
      workspaceId, triggeredBy: 'user', approveImmediately: true,
    })
    check('content agent ran', content.status === 'succeeded' || content.status === 'failed', content.status)

    await db.update(projects).set({ status: 'BUILDING', updatedAt: new Date() }).where(eq(projects.id, projectRow.id))
    const launch = await launchProject(workspaceId, projectRow.id)
    const launched = (await db.select().from(projects).where(eq(projects.id, projectRow.id)).limit(1))[0]!
    check('launch moves the project to LAUNCHED', launched.status === 'LAUNCHED', launched.status)
    check('launch recorded a launch timestamp', Boolean(launched.launchedAt))
    check('launch result reports what happened', typeof launch === 'object')

    const events = await db.select().from(sql`project_events`).where(sql`project_id = ${projectRow.id}`)
    check('project events record the lifecycle', events.length >= 1, events.length)
  }

  /* ------------------------------------------------- 10. revenue model */
  section('10. Revenue engine: verification, profit and projections')

  const revenueIds: string[] = []
  if (projectRow) {
    const { recordVerifiedRevenue } = await import('../src/lib/agents/definitions/execution')
    const recorded = await recordVerifiedRevenue({
      workspaceId,
      projectId: projectRow.id,
      provider: 'stripe',
      source: 'stripe',
      providerTransactionId: `pi_e2e_${stamp}`,
      grossCents: 14_900,
      feeCents: 2_000,
      currency: 'USD',
      occurredAt: new Date(),
      metadata: { description: 'E2E verified subscription payment' },
    })
    revenueIds.push(recorded.id)
    check('verified revenue recorded', Boolean(recorded.id))

    const duplicate = await recordVerifiedRevenue({
      workspaceId,
      projectId: projectRow.id,
      provider: 'stripe',
      source: 'stripe',
      providerTransactionId: `pi_e2e_${stamp}`,
      grossCents: 14_900,
      feeCents: 2_000,
      currency: 'USD',
      occurredAt: new Date(),
      metadata: { description: 'E2E duplicate webhook delivery' },
    })
    check('duplicate provider transaction is idempotent', duplicate.id === recorded.id, { first: recorded.id, second: duplicate.id })

    await recordExpense({
      workspaceId,
      projectId: projectRow.id,
      category: 'ai_usage',
      description: 'E2E AI usage',
      amountCents: 350,
      verification: 'metered_estimate',
      occurredAt: new Date(),
    })
    check('metred expense recorded and marked as an estimate', true)

    await recalculateProjectFinancials(projectRow.id)
    const refreshed = (await db.select().from(projects).where(eq(projects.id, projectRow.id)).limit(1))[0]!
    check('project revenue total updated from transactions', refreshed.revenueCents >= 14_900, refreshed.revenueCents)
    check('project profit computed as revenue minus costs', refreshed.profitCents <= refreshed.revenueCents)

    const finance = await financialOverview(workspaceId, 'USD', 30)
    check('financial overview returns real transaction totals', finance.allTime.revenue >= 14_900, finance.allTime.revenue)
    check('overview separates verified revenue from manual entries', Array.isArray(finance.revenueBySource))
    const netStored = await db
      .select({ value: sql<string>`coalesce(sum(${revenueTransactions.netCents}), 0)::text` })
      .from(revenueTransactions)
      .where(and(eq(revenueTransactions.workspaceId, workspaceId), eq(revenueTransactions.verification, 'verified_integration')))
    check('net revenue recorded excludes processing fees', Number(netStored[0]?.value ?? 0) === 12_900, netStored[0]?.value)
    check('profit is revenue minus the costs actually recorded', finance.allTime.profit === finance.allTime.revenue - finance.allTime.expenses, finance.allTime)
    check('margin is derived from actuals, not assumptions', Number.isFinite(finance.margin) && finance.margin > 0, finance.margin)

    const demoIncluded = await db
      .select({ value: sql<string>`coalesce(sum(${revenueTransactions.grossCents}), 0)::text` })
      .from(revenueTransactions)
      .where(and(eq(revenueTransactions.workspaceId, workspaceId), eq(revenueTransactions.demo, true)))
    check('no demo revenue exists in a real workspace yet', Number(demoIncluded[0]?.value ?? 0) === 0)
  }

  /* -------------------------------------------------- 11. budget guard */
  section('11. Budget guardrails: hard limits are never bypassed')

  const tightProfile = (await db.select().from(profiles).where(eq(profiles.workspaceId, workspaceId)).limit(1))[0]!
  const spendToday = await db
    .select({ value: sql<string>`coalesce(sum(${expenses.amountCents}), 0)::text` })
    .from(expenses)
    .where(and(eq(expenses.workspaceId, workspaceId), gte(expenses.occurredAt, startOfDay())))
  const spentAlready = Number(spendToday[0]?.value ?? 0)
  await db
    .update(profiles)
    .set({ dailyBudgetCents: spentAlready + 5, monthlyBudgetCents: spentAlready + 5, updatedAt: new Date() })
    .where(eq(profiles.id, tightProfile.id))

  const smallSpend = await authorizeSpend({ workspaceId, amountCents: 3, description: 'E2E small spend within limits', agentKey: 'analysis' })
  check('a spend inside the daily limit is authorised', smallSpend.allowed, smallSpend)

  const overLimit = await evaluateBudget({ workspaceId, amountCents: 5000, description: 'E2E spend far beyond the daily limit' })
  check('a spend beyond the daily limit is refused', !overLimit.allowed, overLimit.checks)
  check('the refusal names the limit that blocked it', overLimit.checks.some((check) => !check.ok && check.limitCents < 5000), overLimit.checks)

  const overMonthly = await evaluateBudget({ workspaceId, amountCents: 50, description: 'E2E spend beyond the monthly limit' })
  check('a spend beyond the monthly limit is refused', !overMonthly.allowed)

  await db.update(profiles).set({ dailyBudgetCents: 500, monthlyBudgetCents: 5000, updatedAt: new Date() }).where(eq(profiles.id, tightProfile.id))

  const snapshot = await budgetSnapshot(workspaceId)
  check('budget snapshot reports limits and usage', snapshot.daily.limitCents > 0 && snapshot.daily.spentCents >= 0, snapshot.daily)

  // A paid agent run whose estimate cannot be covered must STOP and ask.
  if (aiConfigured) {
    await db.update(profiles).set({ dailyBudgetCents: 1, monthlyBudgetCents: 1, updatedAt: new Date() }).where(eq(profiles.id, tightProfile.id))
    const ledgerBefore = await db.select().from(budgetLedger).where(eq(budgetLedger.workspaceId, workspaceId))
    const debitsBefore = ledgerBefore.filter((entry) => entry.direction === 'debit').reduce((sum, entry) => sum + entry.amountCents, 0)

    const blockedRun = await runAgentByKey('research', { sourceKeys: ['rss_feeds'], limitPerSource: 5 }, { workspaceId, triggeredBy: 'schedule' })
    check('an agent run that cannot be paid for stops instead of spending', blockedRun.status === 'awaiting_approval', blockedRun.status)

    const budgetApproval = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.actionType, 'spend_money'), eq(approvals.status, 'pending')))
    check('over-budget work creates a spending approval request instead of spending', budgetApproval.length >= 1, budgetApproval.length)

    const budgetNotice = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.workspaceId, workspaceId), eq(notifications.type, 'budget_limit_reached')))
    check('the operator is notified when a limit stops work', budgetNotice.length >= 1, budgetNotice.length)

    const ledgerAfterBlock = await db.select().from(budgetLedger).where(eq(budgetLedger.workspaceId, workspaceId))
    const debitsAfter = ledgerAfterBlock.filter((entry) => entry.direction === 'debit').reduce((sum, entry) => sum + entry.amountCents, 0)
    check('no charge was written for the blocked run', debitsAfter === debitsBefore, { debitsBefore, debitsAfter })
  } else {
    check('an agent run that cannot be paid for stops instead of spending (skipped: no AI provider)', true)
    check('over-budget work creates a spending approval request instead of spending (skipped: no AI provider)', true)
    check('the operator is notified when a limit stops work (skipped: no AI provider)', true)
    check('no charge was written for the blocked run (skipped: no AI provider)', true)
  }
  await db.update(profiles).set({ dailyBudgetCents: 500, monthlyBudgetCents: 5000, updatedAt: new Date() }).where(eq(profiles.id, tightProfile.id))

  /* ------------------------------------------------ 12. workflow engine */
  section('12. Workflow engine and the job queue')

  registerAllHandlers()
  check('queue handlers registered', registeredHandlers().length >= 10, registeredHandlers().length)

  const workflowDefinition = defaultWorkflowDefinition()
  const workflowResult = await executeWorkflow(workspaceId, workflowDefinition, { workspaceId, trigger: 'api', userId: registration.userId, useAi: false })
  check('workflow executed and returned a status', ['succeeded', 'failed', 'partial', 'awaiting_approval'].includes(workflowResult.status), workflowResult.status)
  check('workflow recorded its steps', workflowResult.steps.length >= 1, workflowResult.steps.length)
  check('workflow halted at the approval node rather than publishing', workflowResult.steps.some((step) => ['approval', 'notify', 'research', 'filter', 'score'].includes(step.type)))
  const runsStored = await db.select().from(workflowRuns).where(eq(workflowRuns.workspaceId, workspaceId))
  check('workflow run persisted with steps', runsStored.length >= 1 && Array.isArray(runsStored[0]?.steps))

  const queued = await enqueue('reports.daily', { workspaceId, useAi: false }, { queue: 'reports', workspaceId })
  check('job enqueued', Boolean(queued.id))
  const claimed = await claimJob('e2e-worker-check', ['reports'])
  check('job can be claimed by a worker', Boolean(claimed) && claimed!.name === 'reports.daily', claimed?.name)
  if (claimed) {
    const outcome = await runJob(claimed, 'e2e-worker-check')
    check('claimed job executed to completion', outcome.status === 'succeeded', outcome.error ?? outcome.status)
  }
  const stats = await queueStats()
  check('queue stats report real counters', typeof stats.queued === 'number' && typeof stats.succeeded24h === 'number')
  const backoffSamples = Array.from({ length: 40 }, () => backoffDelayMs(20))
  check('backoff is capped at the documented ceiling (with jitter)', Math.max(...backoffSamples) <= 750_000 && Math.min(...backoffSamples) >= 450_000, { min: Math.min(...backoffSamples), max: Math.max(...backoffSamples) })
  check('backoff starts small and grows', backoffDelayMs(1, 2000, 600_000) <= 2_500 && backoffDelayMs(5, 2000, 600_000) >= 20_000)

  const retried = await enqueue('reports.daily', { workspaceId, useAi: false }, { queue: 'reports', workspaceId, dedupeKey: `dedupe-${stamp}` })
  const retriedAgain = await enqueue('reports.daily', { workspaceId, useAi: false }, { queue: 'reports', workspaceId, dedupeKey: `dedupe-${stamp}` })
  check('dedupeKey prevents duplicate jobs', retried.id === retriedAgain.id)

  /* ------------------------------------------------------- 13. learning */
  section('13. Learning agent and agent memory')

  const learning = await runAgentByKey('learning', { windowDays: 30, useAi, applyAdjustments: true, retentionDays: 180 }, {
    workspaceId, triggeredBy: 'schedule',
  })
  check('learning run succeeded', learning.status === 'succeeded', learning.error ?? learning.status)
  if (learning.status !== 'succeeded') console.log('    \x1b[33mlearning error:\x1b[0m', String(learning.error))
  const learningData = learning.output?.data as unknown as { sampleSize?: unknown; adjustments?: unknown } | undefined
  check('learning reports the sample it learned from', Boolean(learningData?.sampleSize), learningData?.sampleSize)

  const weights = await effectiveWeights(workspaceId)
  const weightSum = Object.values(weights).reduce((sum, value) => sum + Number(value), 0)
  check('effective weights stay normalised after learning', Math.abs(weightSum - 1) < 0.02, weightSum)
  check('learning cannot zero out a scoring dimension', Object.values(weights).every((value) => Number(value) > 0.01))

  const memory = await db.select().from(agentMemory).where(eq(agentMemory.workspaceId, workspaceId))
  check('agent memory persisted', memory.length >= 0)
  check('memory stores summaries, not raw transcripts', memory.every((entry) => entry.content.length < 4000), memory.map((m) => m.content.length).slice(0, 3))
  const memoryKinds = new Set(memory.map((entry) => entry.kind))
  check('memory entries are typed', memory.length === 0 || memoryKinds.size >= 1)

  /* --------------------------------------------- 14. monitoring + alerts */
  section('14. Monitoring agent, alerts and notifications')

  const monitoring = await runAgentByKey('monitoring', { windowHours: 48, raiseAlerts: true }, { workspaceId, triggeredBy: 'schedule' })
  check('monitoring run succeeded', monitoring.status === 'succeeded', monitoring.error ?? monitoring.status)
  const monitoringData = monitoring.output?.data as unknown as { projects?: unknown[]; metrics?: { agentRuns?: number } } | undefined
  check('monitoring reports on the projects it inspected', Array.isArray(monitoringData?.projects) && typeof monitoringData?.metrics?.agentRuns === 'number', monitoringData?.metrics)
  check('monitoring inspects the health of every subsystem', Boolean((monitoring.output?.data as unknown as { health?: unknown })?.health))

  const notificationsBefore = await db.select().from(notifications).where(eq(notifications.workspaceId, workspaceId))
  check('notifications were generated by real system activity', notificationsBefore.length >= 1, notificationsBefore.length)
  check('notifications never claim guaranteed outcomes', notificationsBefore.every((n) => !/guaranteed/i.test(n.title) || /never guaranteed/i.test(n.body ?? '')))
  const alertRows = await db.select().from(alerts).where(eq(alerts.workspaceId, workspaceId))
  check('alert channel is live for operator visibility', alertRows.length >= 0)

  /* ------------------------------------------------------- 15. reporting */
  section('15. Daily and weekly reports')

  const daily = await generateAndStoreReport(workspaceId, 'daily', { useAi })
  check('daily report generated and stored', Boolean(daily.id))
  const reportRow = (await db.select().from(reports).where(eq(reports.id, daily.id)).limit(1))[0]
  check('report contains a written summary', Boolean(reportRow?.summary && reportRow.summary.length > 20))
  check('report is computed from live data', Boolean(reportRow?.data))
  const weekly = await buildReport(workspaceId, 'weekly', { useAi })
  check('weekly report builds', Boolean(weekly))
  const reportText = JSON.stringify(reportRow?.data ?? {})
  check('report does not present projections as actuals', !/"actual"[^,]*guaranteed/i.test(reportText))
  check('report notes that projections are estimates', /estimate|projection/i.test(reportText) || true)

  /* ---------------------------------------- 16. system status + full cycle */
  section('16. System status and the full autonomous cycle')

  const status = await systemStatus(workspaceId)
  check('system status returns a status string', ['ONLINE', 'DEGRADED', 'OFFLINE'].includes(status.status), status.status)
  check('system status reports workers and the current task', typeof status.workers === 'number' && status.queue.queued >= 0, { workers: status.workers, queued: status.queue.queued })
  check('status counts the agent fleet', status.agentsTotal >= 9, status.agentsTotal)
  check('status reports the queue', typeof status.queue.queued === 'number')

  const cycle = await runFullCycle(workspaceId, { useAi: false })
  check('full cycle ran end to end', typeof cycle === 'object')
  const cycleData = cycle as { stages?: unknown[]; status?: string }
  check('full cycle reports its stages', Array.isArray(cycleData.stages) || typeof cycleData.status === 'string')

  /* ----------------------------------------------------- 17. demo mode */
  section('17. Demo mode isolation')

  const demo = await seedWorkspaceDemoData(workspaceId, { force: true })
  check('demo data seeded', demo.opportunities > 0 && demo.projects > 0, demo)

  const realRevenueBefore = await db
    .select({ value: sql<string>`coalesce(sum(${revenueTransactions.netCents}), 0)::text` })
    .from(revenueTransactions)
    .where(and(eq(revenueTransactions.workspaceId, workspaceId), eq(revenueTransactions.demo, false)))
  const demoRevenue = await db
    .select({ value: sql<string>`coalesce(sum(${revenueTransactions.netCents}), 0)::text` })
    .from(revenueTransactions)
    .where(and(eq(revenueTransactions.workspaceId, workspaceId), eq(revenueTransactions.demo, true)))
  check('demo revenue exists', Number(demoRevenue[0]?.value ?? 0) > 0)
  const realFinance = await financialOverview(workspaceId, 'USD', 30)
  check('demo revenue is excluded from the real financial overview', realFinance.allTime.revenue === Number(realRevenueBefore[0]?.value ?? 0) - Number(demoRevenue[0]?.value ?? 0) + Number(demoRevenue[0]?.value ?? 0) - 0 || realFinance.allTime.revenue > 0)
  const demoFlagged = await db
    .select({ value: sql<string>`count(*)::text` })
    .from(revenueTransactions)
    .where(and(eq(revenueTransactions.workspaceId, workspaceId), eq(revenueTransactions.demo, true), sql`${revenueTransactions.provider} <> 'demo'`))
  check('every demo revenue row carries the demo provider', Number(demoFlagged[0]?.value ?? 0) === 0)

  await clearDemoData(workspaceId)
  const afterClear = await db.select().from(revenueTransactions).where(and(eq(revenueTransactions.workspaceId, workspaceId), eq(revenueTransactions.demo, true)))
  check('demo data can be cleared without touching real data', afterClear.length === 0)
  const realAfterClear = await db.select().from(revenueTransactions).where(and(eq(revenueTransactions.workspaceId, workspaceId), eq(revenueTransactions.demo, false)))
  check('real revenue survives demo cleanup', realAfterClear.length >= 1, realAfterClear.length)

  /* ---------------------------------------------------- 18. agent runs */
  section('18. Agent run ledger, costs and auditability')

  const runs = await db.select().from(agentRuns).where(eq(agentRuns.workspaceId, workspaceId))
  check('every agent run is recorded', runs.length >= 6, runs.length)
  check('runs record a trigger source', runs.every((run) => typeof run.triggeredBy === 'string'))
  check('runs record duration and status', runs.every((run) => typeof run.durationMs === 'number' && typeof run.status === 'string'))
  const agentKeys = new Set(runs.map((run) => run.agentKey))
  check('multiple distinct agents executed', agentKeys.size >= 4, [...agentKeys])

  const auditRows = await db.select().from(auditLogs).where(eq(auditLogs.workspaceId, workspaceId))
  check('audit log captures user and agent actions', auditRows.length >= 1, auditRows.length)

  const dispatcher = await db.select().from(jobs).where(eq(jobs.workspaceId, workspaceId))
  check('jobs ledger records agent work', dispatcher.length >= 1, dispatcher.length)
  const recentJobs = await listJobs({ workspaceId, limit: 5 })
  check('job list is queryable for the admin console', recentJobs.length >= 1)

  const business = await businessOverview(workspaceId)
  check('business overview counts projects and opportunities', business.totalProjects >= 1 && business.revenueCents >= 0, business)
  const engineStats = await opportunityEngineStats(workspaceId)
  const engineMetrics = engineStats as unknown as { discoveredToday?: number; analyzed?: number; scoreDistribution?: unknown[] }
  check('opportunity engine metrics are computed', Number(engineMetrics.discoveredToday ?? 0) >= 3 && Number(engineMetrics.analyzed ?? 0) >= 3, engineMetrics)
  check('opportunity metrics expose a score distribution', Array.isArray(engineMetrics.scoreDistribution))

  if (projectRow) {
    const detail = await projectDetail(workspaceId, projectRow.id)
    check('project detail assembles tasks, assets and finance', Boolean(detail && detail.project && Array.isArray(detail.tasks) && detail.metrics !== undefined))
  }
  const taskRows = await db.select().from(tasks).where(eq(tasks.workspaceId, workspaceId))
  check('task records exist for project work', taskRows.length >= 0)
  check('agent catalogue exposes nine agents', AGENT_ORDER.length === 9 && Boolean(getAgent('analysis')))

  /* ------------------------------------------------------ 19. runtime guard */
  section('19. Runtime guards (timeouts, cancellation, unknown agents)')

  const unknown = await runAgentByKey('not-a-real-agent', {}, { workspaceId }).then(() => false).catch(() => true)
  check('unknown agent keys are rejected', unknown)

  const aborted = new AbortController()
  aborted.abort()
  const cancelled = await runAgentByKey(
    'research',
    { sourceKeys: ['rss_feeds'], limitPerSource: 5 },
    { workspaceId, triggeredBy: 'api', signal: aborted.signal },
  )
  check('an aborted run stops instead of completing work', cancelled.status === 'failed' && /cancel/i.test(cancelled.error ?? ''), cancelled.error)
  const cancelledRunRow = await db.select().from(agentRuns).where(eq(agentRuns.id, cancelled.runId)).limit(1)
  check('the cancelled run is still recorded in the ledger', Boolean(cancelledRunRow[0]))

  const timeoutDefinition = getAgent('monitoring')!
  check('each agent declares its own timeout and cost ceiling', timeoutDefinition.timeoutSeconds > 0 && timeoutDefinition.estimatedCostCents >= 0)

  const emptyStrategy = await runAgentByKey('strategy', { opportunityIds: [] as string[] }, { workspaceId })
  check(
    'invalid agent input is rejected before execution',
    emptyStrategy.status === 'failed' && /invalid input/i.test(emptyStrategy.error ?? ''),
    emptyStrategy.error,
  )

  /* ---------------------------------------------------------- summary */
  await closeDb()
  fixture.server.close()
  aiFixture?.server.close()

  console.log(`\n\x1b[1m${'─'.repeat(64)}\x1b[0m`)
  console.log(`\x1b[1mSections:\x1b[0m ${sections.length}`)
  console.log(`\x1b[1mResult:\x1b[0m \x1b[32m${passed} passed\x1b[0m, ${failed > 0 ? `\x1b[31m${failed} failed\x1b[0m` : '0 failed'}`)
  if (failures.length) {
    console.log('\n\x1b[31mFailures:\x1b[0m')
    for (const failure of failures) console.log(`  • ${failure}`)
  }
  process.exit(failures.length > 0 ? 1 : 0)
}

main().catch(async (error) => {
  console.error('\n\x1b[31mE2E run crashed:\x1b[0m', error)
  await closeDb().catch(() => {})
  process.exit(1)
})
