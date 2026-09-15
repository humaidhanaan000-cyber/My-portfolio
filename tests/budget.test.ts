/**
 * Budget guardrail tests.
 *
 * The guardrails are the promise that AIBA cannot spend more than you allowed.
 * These tests run against the real ledger and the real expense table: recorded
 * costs count against the daily, monthly and per-project ceilings, reservations
 * count against the per-agent ceiling, and a failing check must return
 * `allowed: false` with `requiresApproval: true` instead of proceeding.
 */
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { evaluateBudget, authorizeSpend, settleSpend, releaseSpend, budgetSnapshot, recordExpense } from '../src/lib/budget'
import { getDb, profiles } from '../src/lib/db'
import { createProject, createWorkspaceFixture } from './helpers'

describe('budget guardrails', () => {
  it('counts recorded costs against the daily limit and blocks the spend that would exceed it', async () => {
    const fixture = await createWorkspaceFixture({ dailyBudgetCents: 500, monthlyBudgetCents: 5_000 })
    await recordExpense({ workspaceId: fixture.workspaceId, amountCents: 300, description: 'Model calls', category: 'ai_api' })

    const snapshot = await budgetSnapshot(fixture.workspaceId)
    expect(snapshot.daily.spentCents).toBe(300)
    expect(snapshot.daily.limitCents).toBe(500)
    expect(snapshot.daily.percentUsed).toBe(60)

    const fits = await evaluateBudget({ workspaceId: fixture.workspaceId, amountCents: 150, description: 'Another analysis' })
    expect(fits.allowed).toBe(true)
    expect(fits.checks.find((check) => check.scope === 'daily')?.remainingCents).toBe(200)

    const blocked = await evaluateBudget({ workspaceId: fixture.workspaceId, amountCents: 250, description: 'Would exceed the day' })
    expect(blocked.allowed).toBe(false)
    expect(blocked.requiresApproval).toBe(true)
    expect(blocked.reason).toContain('Blocked by')
    expect(blocked.reason).toContain('Workspace daily limit')
    expect(blocked.checks.some((check) => check.scope === 'daily' && !check.ok)).toBe(true)
  })

  it('enforces the monthly ceiling even when the current day is clear', async () => {
    const fixture = await createWorkspaceFixture({ dailyBudgetCents: 100_000, monthlyBudgetCents: 200 })
    await recordExpense({ workspaceId: fixture.workspaceId, amountCents: 200, description: 'Monthly ceiling reached', category: 'hosting' })

    const decision = await evaluateBudget({ workspaceId: fixture.workspaceId, amountCents: 50, description: 'Beyond the monthly ceiling' })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('Workspace monthly limit')
    expect(decision.checks.find((check) => check.scope === 'monthly')?.percentUsed).toBe(100)
  })

  it('enforces the per-project ceiling in addition to the workspace limits', async () => {
    const fixture = await createWorkspaceFixture({ dailyBudgetCents: 100_000, monthlyBudgetCents: 100_000 })
    const project = await createProject(fixture, { budgetCents: 300 })
    await recordExpense({ workspaceId: fixture.workspaceId, amountCents: 250, description: 'Project work', category: 'ai_api', projectId: project.id })

    const fits = await evaluateBudget({ workspaceId: fixture.workspaceId, amountCents: 40, description: 'Small increment', scope: 'project', projectId: project.id })
    expect(fits.allowed).toBe(true)

    const blocked = await evaluateBudget({ workspaceId: fixture.workspaceId, amountCents: 100, description: 'Too much for this project', scope: 'project', projectId: project.id })
    expect(blocked.allowed).toBe(false)
    expect(blocked.checks.some((check) => check.scope === 'project' && !check.ok)).toBe(true)

    // Other projects are unaffected — the ceiling is per project, not global.
    const other = await createProject(fixture, { budgetCents: 300 })
    const anotherProject = await evaluateBudget({ workspaceId: fixture.workspaceId, amountCents: 100, description: 'Fresh project', scope: 'project', projectId: other.id })
    expect(anotherProject.allowed).toBe(true)
  })

  it('reserves per-agent budget, blocks the agent that exceeds it, and leaves other agents alone', async () => {
    const fixture = await createWorkspaceFixture({ dailyBudgetCents: 100_000, monthlyBudgetCents: 100_000, perAgentDailyLimitCents: 150 })

    const first = await authorizeSpend({ workspaceId: fixture.workspaceId, amountCents: 150, description: 'Content generation', scope: 'agent', agentKey: 'content' })
    expect(first.allowed).toBe(true)
    expect(first.ledgerId).toBeTruthy()

    const otherAgent = await evaluateBudget({ workspaceId: fixture.workspaceId, amountCents: 40, description: 'Research run', scope: 'agent', agentKey: 'research' })
    expect(otherAgent.allowed).toBe(true)

    const blocked = await evaluateBudget({ workspaceId: fixture.workspaceId, amountCents: 10, description: 'Same agent again', scope: 'agent', agentKey: 'content' })
    expect(blocked.allowed).toBe(false)
    expect(blocked.requiresApproval).toBe(true)
    expect(blocked.reason).toContain('Agent daily limit')
  })

  it('releases a reservation when the action fails so the budget is not silently consumed', async () => {
    const fixture = await createWorkspaceFixture({ perAgentDailyLimitCents: 200 })
    const reservation = await authorizeSpend({ workspaceId: fixture.workspaceId, amountCents: 200, description: 'Reserved then released', scope: 'agent', agentKey: 'execution' })

    const blockedWhileReserved = await evaluateBudget({ workspaceId: fixture.workspaceId, amountCents: 50, description: 'Blocked by the reservation', scope: 'agent', agentKey: 'execution' })
    expect(blockedWhileReserved.allowed).toBe(false)

    await releaseSpend(reservation.ledgerId!)
    const afterRelease = await evaluateBudget({ workspaceId: fixture.workspaceId, amountCents: 200, description: 'Retry after release', scope: 'agent', agentKey: 'execution' })
    expect(afterRelease.allowed).toBe(true)
  })

  it('settles a reservation at the real metered cost rather than the estimate', async () => {
    const fixture = await createWorkspaceFixture({ dailyBudgetCents: 100_000, monthlyBudgetCents: 100_000, perAgentDailyLimitCents: 1_000 })
    const reservation = await authorizeSpend({ workspaceId: fixture.workspaceId, amountCents: 500, description: 'Estimated cost', scope: 'agent', agentKey: 'analysis' })
    await settleSpend(reservation.ledgerId!, 90, { description: 'Actual metered cost' })

    // The remaining allowance reflects the real cost: 1000 - 90.
    const next = await evaluateBudget({ workspaceId: fixture.workspaceId, amountCents: 900, description: 'Uses the released headroom', scope: 'agent', agentKey: 'analysis' })
    expect(next.allowed).toBe(true)
    expect(next.checks.find((check) => check.scope === 'agent')?.spentCents).toBe(90)
  })

  it('still applies the platform ceiling when the operator has not set a limit', async () => {
    const fixture = await createWorkspaceFixture({ dailyBudgetCents: 0, monthlyBudgetCents: 0 })
    const db = await getDb()
    await db.update(profiles).set({ dailyBudgetCents: 0, monthlyBudgetCents: 0, updatedAt: new Date() }).where(eq(profiles.workspaceId, fixture.workspaceId))

    const small = await evaluateBudget({ workspaceId: fixture.workspaceId, amountCents: 10, description: 'Small spend with no user limit' })
    expect(small.allowed).toBe(true)
    // Zero means "no user limit configured" — the snapshot says so rather than
    // implying an unlimited budget.
    expect(small.checks.find((check) => check.scope === 'daily')?.limitCents).toBe(0)

    const huge = await evaluateBudget({ workspaceId: fixture.workspaceId, amountCents: 500_000, description: 'Absurd single spend' })
    const ceiling = huge.checks.find((check) => check.scope === 'workspace')
    expect(ceiling).toBeDefined()
    expect(ceiling!.limitCents).toBeGreaterThan(0)
    expect(huge.allowed).toBe(false)
    expect(huge.requiresApproval).toBe(true)
  })

  it('reports every applicable limit with the numbers that produced the decision', async () => {
    const fixture = await createWorkspaceFixture({ dailyBudgetCents: 400, monthlyBudgetCents: 900, maxProjectBudgetCents: 200, perAgentDailyLimitCents: 100 })
    const project = await createProject(fixture)

    const decision = await evaluateBudget({
      workspaceId: fixture.workspaceId,
      amountCents: 50,
      description: 'Full check',
      scope: 'agent',
      projectId: project.id,
      agentKey: 'strategy',
    })

    const scopes = decision.checks.map((check) => check.scope)
    expect(scopes).toContain('daily')
    expect(scopes).toContain('monthly')
    expect(scopes).toContain('project')
    expect(scopes).toContain('agent')
    expect(decision.amountCents).toBe(50)
    expect(decision.currency).toBeTruthy()
    for (const check of decision.checks) {
      expect(check.percentUsed).toBeGreaterThanOrEqual(0)
      expect(check.remainingCents).toBe(check.limitCents - check.spentCents)
    }
  })
})
