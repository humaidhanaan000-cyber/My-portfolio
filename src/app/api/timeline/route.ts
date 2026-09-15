/**
 * GET /api/timeline — the live activity feed.
 *
 * Merges project events, agent runs, approvals, revenue, expenses and audit
 * entries into one chronological stream so the dashboard can show what the
 * system actually did, minute by minute.
 */
import { and, eq, gte, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { extractRows } from '@/lib/db'
import { ok, withApi } from '@/lib/api/http'

export const dynamic = 'force-dynamic'

export type TimelineEntry = {
  id: string
  kind: 'agent_run' | 'approval' | 'project_event' | 'revenue' | 'expense' | 'audit' | 'workflow'
  title: string
  detail: string
  status: string
  agentKey?: string | null
  projectId?: string | null
  link?: string | null
  costCents?: number | null
  at: string
  demo?: boolean
}

export const GET = withApi(async (ctx) => {
  const db = await getDb()
  const workspaceId = ctx.session.workspaceId
  const limit = Math.min(120, Math.max(1, Number(ctx.searchParams.get('limit') ?? 60)))
  const hours = Math.min(720, Math.max(1, Number(ctx.searchParams.get('hours') ?? 72)))
  const since = new Date(Date.now() - hours * 3_600_000)

  const rows = await db.execute(sql`
    select * from (
      select
        ar.id::text as id, 'agent_run' as kind,
        coalesce(ag.name, ar.agent_key) as title,
        coalesce(nullif(ar.output->>'summary', ''), nullif(ar.error, ''), 'Agent run') as detail,
        ar.status as status, ar.agent_key as agent_key, null::text as project_id,
        ('/dashboard/agents/' || ar.agent_key) as link, ar.cost_cents as cost_cents,
        ar.started_at as at, false as demo
      from agent_runs ar
      left join agents ag on ag.key = ar.agent_key
      where ar.workspace_id = ${workspaceId} and ar.started_at >= ${since.toISOString()}

      union all

      select a.id::text, 'approval', a.title,
        a.reason, a.status, a.requested_by_agent, a.project_id::text,
        '/dashboard/approvals', a.expected_cost_cents, a.created_at, false
      from approvals a
      where a.workspace_id = ${workspaceId} and a.created_at >= ${since.toISOString()}

      union all

      select pe.id::text, 'project_event', coalesce(p.name, 'Project'), pe.message,
        pe.type, null, pe.project_id::text, ('/dashboard/projects/' || pe.project_id::text),
        null, pe.created_at, false
      from project_events pe
      left join projects p on p.id = pe.project_id
      where pe.workspace_id = ${workspaceId} and pe.created_at >= ${since.toISOString()}

      union all

      select rt.id::text, 'revenue', ('Revenue: ' || coalesce(p.name, rt.source)),
        coalesce(rt.metadata->>'description', rt.description), rt.status, null, rt.project_id::text,
        '/dashboard/revenue', rt.net_cents, rt.occurred_at, rt.demo
      from revenue_transactions rt
      left join projects p on p.id = rt.project_id
      where rt.workspace_id = ${workspaceId} and rt.occurred_at >= ${since.toISOString()}

      union all

      select e.id::text, 'expense', ('Expense: ' || e.category),
        e.description, e.verification, null, e.project_id::text,
        '/dashboard/expenses', (e.amount_cents * -1), e.occurred_at, e.demo
      from expenses e
      where e.workspace_id = ${workspaceId} and e.occurred_at >= ${since.toISOString()}

      union all

      select w.id::text, 'workflow', w.name, coalesce(w.last_status, 'never run'),
        coalesce(w.last_status, 'idle'), null, null, ('/dashboard/workflows/' || w.id::text),
        null, coalesce(w.last_run_at, w.created_at), false
      from workflows w
      where w.workspace_id = ${workspaceId} and coalesce(w.last_run_at, w.created_at) >= ${since.toISOString()}

      union all

      select al.id::text, 'audit', al.action,
        coalesce(al.entity_type, '') || coalesce(' ' || al.entity_id::text, ''),
        al.actor_type, null, null, null, null, al.created_at, false
      from audit_logs al
      where al.workspace_id = ${workspaceId} and al.created_at >= ${since.toISOString()}
    ) events
    order by at desc
    limit ${limit}
  `)

  const entries: TimelineEntry[] = extractRows<Record<string, unknown>>(rows).map((row) => ({
    id: String(row.id),
    kind: row.kind as TimelineEntry['kind'],
    title: String(row.title ?? ''),
    detail: String(row.detail ?? ''),
    status: String(row.status ?? ''),
    agentKey: row.agent_key ? String(row.agent_key) : null,
    projectId: row.project_id ? String(row.project_id) : null,
    link: row.link ? String(row.link) : null,
    costCents: row.cost_cents === null || row.cost_cents === undefined ? null : Number(row.cost_cents),
    at: new Date(row.at as string).toISOString(),
    demo: Boolean(row.demo),
  }))

  const since24h = new Date(Date.now() - 86_400_000)
  const counts = await db.execute(sql`
    select
      (select count(*)::text from agent_runs where workspace_id = ${workspaceId} and started_at >= ${since24h.toISOString()}) as runs,
      (select count(*)::text from approvals where workspace_id = ${workspaceId} and status = 'pending') as pending,
      (select count(*)::text from projects where workspace_id = ${workspaceId} and status in ('BUILDING','LAUNCHED','MONITORING','OPTIMIZING')) as active
  `)
  const summary = extractRows<Record<string, string>>(counts)[0] ?? {}

  void and
  void eq
  void gte

  return ok(entries, {
    hours,
    limit,
    counts: {
      agentRuns24h: Number(summary.runs ?? 0),
      pendingApprovals: Number(summary.pending ?? 0),
      activeProjects: Number(summary.active ?? 0),
    },
  })
})
