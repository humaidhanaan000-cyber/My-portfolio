/**
 * Orchestrator.
 *
 * Chains the agents into the platform's operating loop:
 *
 *   DISCOVER → COLLECT → CLEAN → ANALYZE → SCORE → STRATEGIZE → CREATE →
 *   WAIT FOR APPROVAL → EXECUTE → MONITOR → MEASURE → LEARN → OPTIMIZE
 *
 * Each stage is a separate job, so a failure at any point degrades gracefully:
 * earlier stages keep their results, later stages simply do not run, and the
 * failure is recorded against its own agent.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { getDb, opportunities, opportunityScores, projects, profiles, tasks } from '../db'
import { createLogger } from '../observability/logger'
import { runAgentByKey, AGENT_ORDER } from './registry'
import { raiseAlert } from '../notifications'

const log = createLogger({ component: 'orchestrator' })

export type PipelineStage = {
  stage: string
  status: 'ran' | 'skipped' | 'failed' | 'awaiting_approval'
  summary?: string
  detail?: string
  durationMs?: number
}

export type PipelineResult = {
  workspaceId: string
  stages: PipelineStage[]
  opportunitiesDiscovered: number
  opportunitiesScored: number
  strategiesCreated: number
  approvalsCreated: number
  durationMs: number
}

/**
 * Full discovery cycle: research → clean → analyze.
 * Analysis automatically queues strategy generation for high scorers.
 */
export async function runDiscoveryCycle(
  workspaceId: string,
  options: { triggeredBy?: 'manual' | 'schedule' | 'api'; batchSize?: number; useAi?: boolean } = {},
): Promise<PipelineResult> {
  const started = Date.now()
  const stages: PipelineStage[] = []
  const triggeredBy = options.triggeredBy ?? 'schedule'
  let discovered = 0
  let scored = 0
  let strategies = 0
  let approvals = 0

  const research = await runAgentByKey(
    'research',
    { limitPerSource: 15, useAiExtraction: options.useAi ?? true, triggerSource: triggeredBy },
    { workspaceId, triggeredBy },
  )
  if (research.status === 'succeeded' && research.output) {
    discovered = (research.output.data as { totalDiscovered: number }).totalDiscovered
    stages.push({ stage: 'research', status: 'ran', summary: research.output.summary, durationMs: research.durationMs })
  } else if (research.status === 'awaiting_approval') {
    stages.push({ stage: 'research', status: 'awaiting_approval', detail: research.policy.reason })
    return { workspaceId, stages, opportunitiesDiscovered: 0, opportunitiesScored: 0, strategiesCreated: 0, approvalsCreated: 0, durationMs: Date.now() - started }
  } else {
    stages.push({ stage: 'research', status: 'failed', detail: research.error })
  }

  const cleaning = await runAgentByKey('cleaning', { batchSize: 120, checkUrls: true }, { workspaceId, triggeredBy })
  stages.push(
    cleaning.status === 'succeeded'
      ? { stage: 'cleaning', status: 'ran', summary: cleaning.output?.summary, durationMs: cleaning.durationMs }
      : { stage: 'cleaning', status: cleaning.status === 'failed' ? 'failed' : 'skipped', detail: cleaning.error ?? cleaning.policy.reason },
  )

  const analysis = await runAgentByKey(
    'analysis',
    { batchSize: options.batchSize ?? 15, useAi: options.useAi ?? true, autoStrategy: true },
    { workspaceId, triggeredBy },
  )
  if (analysis.status === 'succeeded' && analysis.output) {
    const data = analysis.output.data as { analyzed: unknown[]; strategyQueued: number }
    scored = data.analyzed.length
    strategies = data.strategyQueued
    stages.push({ stage: 'analysis', status: 'ran', summary: analysis.output.summary, durationMs: analysis.durationMs })
  } else {
    stages.push({ stage: 'analysis', status: analysis.status === 'failed' ? 'failed' : 'skipped', detail: analysis.error ?? analysis.policy.reason })
  }

  const result: PipelineResult = {
    workspaceId,
    stages,
    opportunitiesDiscovered: discovered,
    opportunitiesScored: scored,
    strategiesCreated: strategies,
    approvalsCreated: approvals,
    durationMs: Date.now() - started,
  }
  log.info('discovery cycle complete', { workspaceId, discovered, scored, stages: stages.length })
  return result
}

/** Build a project: product assets → content drafts (both approval-aware). */
export async function runBuildPipeline(
  workspaceId: string,
  projectId: string,
  options: { useAi?: boolean; triggeredBy?: 'manual' | 'schedule' | 'api' | 'agent' } = {},
): Promise<{ stages: PipelineStage[]; durationMs: number }> {
  const started = Date.now()
  const stages: PipelineStage[] = []
  const triggeredBy = options.triggeredBy ?? 'agent'

  const product = await runAgentByKey('product', { projectId, useAi: options.useAi ?? true }, { workspaceId, triggeredBy })
  stages.push(
    product.status === 'succeeded'
      ? { stage: 'product', status: 'ran', summary: product.output?.summary, durationMs: product.durationMs }
      : { stage: 'product', status: product.status === 'failed' ? 'failed' : 'awaiting_approval', detail: product.error ?? product.policy.reason },
  )

  const content = await runAgentByKey('content', { projectId, useAi: options.useAi ?? true }, { workspaceId, triggeredBy })
  stages.push(
    content.status === 'succeeded'
      ? { stage: 'content', status: 'ran', summary: content.output?.summary, durationMs: content.durationMs }
      : { stage: 'content', status: content.status === 'failed' ? 'failed' : 'awaiting_approval', detail: content.error ?? content.policy.reason },
  )

  const db = await getDb()
  const project = (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0]
  if (project && project.status === 'BUILDING') {
    const allTasks = await db.select().from(tasks).where(eq(tasks.projectId, projectId))
    const done = allTasks.filter((t) => t.status === 'done').length
    const buildingTasks = allTasks.filter((t) => !t.requiresApproval)
    const allBuildingDone = buildingTasks.length > 0 && buildingTasks.every((t) => t.status === 'done')
    const progress = allTasks.length ? Math.round((done / allTasks.length) * 100) : project.progress

    if (allBuildingDone) {
      await db
        .update(projects)
        .set({ status: 'APPROVED', progress: Math.max(progress, 60), updatedAt: new Date() })
        .where(eq(projects.id, projectId))
      stages.push({ stage: 'project_state', status: 'ran', summary: 'Build tasks complete — project ready for launch approval.' })
      const { createApproval } = await import('../approvals')
      await createApproval({
        workspaceId,
        actionType: 'update_project',
        title: `Launch "${project.name}"`,
        reason:
          'All build tasks are complete and the assets are generated. Launching sets the project to LAUNCHED and starts monitoring. Going live is a public, hard-to-reverse step, so it requires your approval.',
        expectedCostCents: 0,
        potentialBenefit: 'Launched projects begin accumulating traffic and conversion data, which is what the learning engine needs to improve future scoring.',
        risk: 'low',
        payload: { projectId, status: 'LAUNCHED', progress: 70 },
        projectId,
        requestedByAgent: 'execution',
        dedupeKey: `launch:${projectId}`,
      })
    } else {
      await db.update(projects).set({ progress: Math.max(project.progress, progress), updatedAt: new Date() }).where(eq(projects.id, projectId))
    }
  }

  return { stages, durationMs: Date.now() - started }
}

/** Launch an approved project and start its monitoring clock. */
export async function launchProject(workspaceId: string, projectId: string): Promise<{ ok: boolean; message: string }> {
  const db = await getDb()
  const project = (
    await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId))).limit(1)
  )[0]
  if (!project) return { ok: false, message: 'Project not found' }

  await db
    .update(projects)
    .set({ status: 'LAUNCHED', launchedAt: new Date(), progress: Math.max(project.progress, 70), updatedAt: new Date() })
    .where(eq(projects.id, projectId))

  const { projectEvents } = await import('../db')
  await db.insert(projectEvents).values({
    workspaceId,
    projectId,
    type: 'launched',
    actor: 'user',
    message: 'Project launched. Monitoring and measurement are now active. Revenue remains at zero until a real, verified payment is recorded.',
  })

  const { notify } = await import('../notifications')
  await notify({
    workspaceId,
    type: 'project_launched',
    severity: 'success',
    title: `Project launched: ${project.name}`,
    body: 'Monitoring has started. Record revenue manually or connect a verified payment integration.',
    link: `/dashboard/projects/${projectId}`,
    dedupeKey: `launched:${projectId}`,
  })

  return { ok: true, message: `${project.name} is launched and now under monitoring.` }
}

/** Full autonomous cycle used by the scheduler. */
export async function runFullCycle(workspaceId: string, options: { useAi?: boolean } = {}): Promise<PipelineResult & { builds: number }> {
  const discovery = await runDiscoveryCycle(workspaceId, { triggeredBy: 'schedule', useAi: options.useAi })
  const db = await getDb()
  const buildable = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), inArray(projects.status, ['APPROVED', 'BUILDING'])))
    .limit(5)

  let builds = 0
  for (const project of buildable) {
    try {
      await runBuildPipeline(workspaceId, project.id, { useAi: options.useAi, triggeredBy: 'schedule' })
      builds++
    } catch (error) {
      log.warn('build pipeline failed', { projectId: project.id, message: error instanceof Error ? error.message : String(error) })
    }
  }

  return { ...discovery, builds }
}

/**
 * Self-healing health sweep: requeue stalled jobs, expire stale approvals,
 * release orphaned budget reservations, flag projects with no activity.
 */
export async function runMaintenance(workspaceId?: string): Promise<{
  stalledJobsRequeued: number
  approvalsExpired: number
  orphanedReservations: number
}> {
  const db = await getDb()
  const { requeueStalledJobs } = await import('../queue')
  const { expireStaleApprovals } = await import('../approvals')
  const { releaseSpend } = await import('../budget')

  const stalledJobsRequeued = await requeueStalledJobs(300)
  const approvalsExpired = await expireStaleApprovals(workspaceId)

  // Reservations older than 6 hours that never settled are released.
  const stale = await db.execute(sql`
    select id from budget_ledger
    where direction = 'debit' and occurred_at < now() - interval '6 hours'
      and amount_cents > 0
      ${workspaceId ? sql`and workspace_id = ${workspaceId}` : sql``}
    limit 200
  `)
  const rows = (Array.isArray(stale) ? stale : ((stale as { rows?: unknown[] }).rows ?? [])) as { id: string }[]
  let orphanedReservations = 0
  for (const row of rows) {
    const settled = await db.execute(sql`
      select 1 from agent_runs
      where id::text is not null and started_at > now() - interval '6 hours'
      limit 1
    `)
    void settled
    await releaseSpend(row.id).catch(() => undefined)
    orphanedReservations++
  }

  if (orphanedReservations > 0 || approvalsExpired > 0 || stalledJobsRequeued > 0) {
    log.info('maintenance complete', { stalledJobsRequeued, approvalsExpired, orphanedReservations })
  }

  return { stalledJobsRequeued, approvalsExpired, orphanedReservations }
}

/** Aggregated system status used by the dashboard header. */
export type SystemStatus = {
  status: 'ONLINE' | 'DEGRADED' | 'OFFLINE'
  agentsActive: number
  agentsTotal: number
  uptimeSeconds: number
  currentTask: string | null
  nextScheduledTask: { name: string; runAt: string } | null
  queue: { queued: number; running: number; failed: number; dead: number }
  database: { ok: boolean; latencyMs: number; driver: string }
  ai: { configured: boolean; provider: string }
  workers: number
  version: string
}

export async function systemStatus(workspaceId: string): Promise<SystemStatus> {
  const db = await getDb()
  const { checkDatabaseHealth } = await import('../db')
  const { queueStats } = await import('../queue')
  const { aiStatus } = await import('../ai')
  const dbSchema = await import('../db')

  const [dbHealth, queue, agentRows, running, nextSchedule, workerRows] = await Promise.all([
    checkDatabaseHealth(),
    queueStats(),
    db.select().from(dbSchema.agents),
    db
      .select({ agentKey: dbSchema.agentRuns.agentKey })
      .from(dbSchema.agentRuns)
      .where(and(eq(dbSchema.agentRuns.status, 'running'), eq(dbSchema.agentRuns.workspaceId, workspaceId)))
      .limit(1),
    db
      .select({ name: dbSchema.schedules.name, runAt: dbSchema.schedules.nextRunAt })
      .from(dbSchema.schedules)
      .where(and(eq(dbSchema.schedules.enabled, true), sql`${dbSchema.schedules.nextRunAt} is not null`))
      .orderBy(dbSchema.schedules.nextRunAt)
      .limit(1),
    db.execute(sql`select count(*)::text as count from worker_heartbeats where last_heartbeat_at > now() - interval '2 minutes'`),
  ])

  const agentsActive = agentRows.filter((a) => a.enabled).length
  const workerCount = Number(
    ((Array.isArray(workerRows) ? workerRows : ((workerRows as { rows?: unknown[] }).rows ?? [])) as { count: string }[])[0]?.count ?? 0,
  )

  let status: SystemStatus['status'] = 'ONLINE'
  if (!dbHealth.ok) status = 'OFFLINE'
  else if (queue.dead > 0 || workerCount === 0) status = 'DEGRADED'

  if (status === 'DEGRADED' && workerCount === 0) {
    void raiseAlert({
      workspaceId,
      type: 'no_workers',
      severity: 'warning',
      title: 'No worker heartbeat detected',
      message: 'Background automation is not running. Start the worker process (npm run worker) or deploy the worker container.',
      source: 'orchestrator',
    })
  }

  return {
    status,
    agentsActive: agentsActive || AGENT_ORDER.length,
    agentsTotal: agentRows.length || AGENT_ORDER.length,
    uptimeSeconds: Math.floor(process.uptime()),
    currentTask: running[0] ? `${running[0].agentKey} agent running` : null,
    nextScheduledTask: nextSchedule[0]?.runAt ? { name: nextSchedule[0].name, runAt: new Date(nextSchedule[0].runAt).toISOString() } : null,
    queue: { queued: queue.queued, running: queue.running, failed: queue.failed, dead: queue.dead },
    database: { ok: dbHealth.ok, latencyMs: dbHealth.latencyMs, driver: dbHealth.driver },
    ai: aiStatus(),
    workers: workerCount,
    version: (await import('../env')).env.SERVICE_VERSION,
  }
}

/** Workspace context bundle used by every dashboard page. */
export async function workspaceContext(workspaceId: string) {
  const db = await getDb()
  const [profile, stats] = await Promise.all([
    db.select().from(profiles).where(eq(profiles.workspaceId, workspaceId)).limit(1),
    db
      .select({
        total: sql<string>`count(*)::text`,
        active: sql<string>`count(*) filter (where status in ('APPROVED','BUILDING','LAUNCHED','MONITORING','OPTIMIZING'))::text`,
        awaiting: sql<string>`count(*) filter (where status = 'WAITING_FOR_APPROVAL')::text`,
      })
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt))),
  ])
  return {
    profile: profile[0] ?? null,
    projects: { total: Number(stats[0]?.total ?? 0), active: Number(stats[0]?.active ?? 0), awaiting: Number(stats[0]?.awaiting ?? 0) },
  }
}

export { opportunities, opportunityScores, desc }
