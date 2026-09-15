import Link from 'next/link'
import { Callout } from '@/components/landing'

/** Status-page notes: what each component means and what to do when it is down. */
export function SectionFooter() {
  return (
    <div className="mt-10 grid gap-4 lg:grid-cols-2">
      <Callout tone="info" title="What DEGRADED means">
        The web process is serving requests but something needs attention — typically failed jobs in the queue, a database round trip above a second, or
        a required integration that is no longer reachable. The admin console shows the failing queue and the last error for each job.
      </Callout>
      <Callout tone="warning" title="What OFFLINE means">
        The database could not be reached, so AIBA cannot record revenue, approvals or job state. Agents will not run while the database is down: the
        worker fails closed rather than acting without a record. Check <code className="font-mono text-[11px]">DATABASE_URL</code> and the container
        logs, then run <code className="font-mono text-[11px]">npm run db:migrate</code>.
      </Callout>
      <Callout tone="info" title="Unconfigured is not a failure">
        An unconfigured AI provider, payment provider or storage driver is a supported state. Plans, budget guardrails, projects, approvals and the
        ledger all work without any third-party credentials — only the features that genuinely need them are unavailable.
      </Callout>
      <Callout tone="info" title="Health endpoints">
        <span className="mt-1 block font-mono text-[11px]">GET /api/health — liveness and readiness, used by Docker health checks</span>
        <span className="mt-1 block font-mono text-[11px]">GET /api/status — the public summary rendered above</span>
        <Link href="/api-docs" className="mt-2 inline-block text-[11px] text-accent-700 hover:underline">
          Read the full API reference
        </Link>
      </Callout>
    </div>
  )
}
