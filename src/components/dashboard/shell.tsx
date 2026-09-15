'use client'

/**
 * Dashboard shell: navigation, live system status, notification bell and the
 * DEMO DATA banner. The status pill polls the real status endpoint, so what the
 * operator sees is what the server reports.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  Activity, AlertTriangle, BarChart3, BellRing, Boxes, Brain, CircleDollarSign, ClipboardCheck,
  Cpu, FileBarChart, Gauge, LayoutDashboard, Lightbulb, ListChecks, LogOut, Menu, Plug, Receipt,
  Settings, ShieldCheck, Workflow, X,
} from 'lucide-react'
import { Badge, Button, DemoBadge } from '@/components/ui'
import { api, ApiClientError } from '@/lib/client/api'
import { useApi } from '@/lib/client/hooks'
import { cn } from '@/lib/utils'

type SessionUser = {
  name: string
  email: string
  role: string
  workspaceName: string
  planKey: string
  demoMode: boolean
  onboarded: boolean
}

type StatusPayload = {
  status: 'ONLINE' | 'DEGRADED' | 'OFFLINE'
  agentsActive: number
  agentsTotal: number
  uptimeSeconds: number
  currentTask: string | null
  nextScheduledTask: { name: string; runAt: string } | null
  queue: { queued: number; running: number; failed: number; dead: number }
  ai: { configured: boolean; provider: string }
  workers: number
  version: string
}

const NAV: { href: string; label: string; icon: typeof LayoutDashboard; group: string }[] = [
  { href: '/dashboard', label: 'Command center', icon: LayoutDashboard, group: 'Operate' },
  { href: '/dashboard/opportunities', label: 'Opportunities', icon: Lightbulb, group: 'Operate' },
  { href: '/dashboard/projects', label: 'Projects', icon: Boxes, group: 'Operate' },
  { href: '/dashboard/approvals', label: 'Approvals', icon: ClipboardCheck, group: 'Operate' },
  { href: '/dashboard/workflows', label: 'Workflows', icon: Workflow, group: 'Operate' },
  { href: '/dashboard/agents', label: 'Agents', icon: Cpu, group: 'Automation' },
  { href: '/dashboard/sources', label: 'Sources', icon: Plug, group: 'Automation' },
  { href: '/dashboard/memory', label: 'Agent memory', icon: Brain, group: 'Automation' },
  { href: '/dashboard/revenue', label: 'Revenue', icon: CircleDollarSign, group: 'Money' },
  { href: '/dashboard/expenses', label: 'Expenses', icon: Receipt, group: 'Money' },
  { href: '/dashboard/budget', label: 'Budget limits', icon: Gauge, group: 'Money' },
  { href: '/dashboard/analytics', label: 'Analytics', icon: BarChart3, group: 'Money' },
  { href: '/dashboard/reports', label: 'Reports', icon: FileBarChart, group: 'Money' },
  { href: '/dashboard/notifications', label: 'Notifications', icon: BellRing, group: 'Account' },
  { href: '/dashboard/billing', label: 'Plan & billing', icon: ShieldCheck, group: 'Account' },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings, group: 'Account' },
]

const ADMIN_NAV = [
  { href: '/dashboard/admin', label: 'Admin console', icon: Activity },
  { href: '/dashboard/jobs', label: 'Jobs & queues', icon: ListChecks },
]

export function DashboardShell({ user, children }: { user: SessionUser; children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)

  const status = useApi<StatusPayload>('/api/dashboard/status', { pollMs: 30_000 })
  const alerts = useApi<{ unread: number }>('/api/notifications?limit=1', { pollMs: 45_000 })

  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  async function signOut() {
    setSigningOut(true)
    try {
      await api.post('/api/auth/logout')
      router.replace('/login')
      router.refresh()
    } catch (error) {
      if (error instanceof ApiClientError) setSigningOut(false)
    }
  }

  const groups = Array.from(new Set(NAV.map((entry) => entry.group)))
  const unread = alerts.data?.unread ?? 0

  return (
    <div className="flex min-h-screen bg-ink-50">
      {/* --------------------------------------------------------------- sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-ink-800 bg-ink-950 transition-transform lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center justify-between px-4 py-4">
          <Link href="/dashboard" className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-white text-xs font-bold text-ink-900">AI</span>
            <span className="text-sm font-semibold tracking-tight text-white">AIBA</span>
          </Link>
          <button type="button" onClick={() => setMobileOpen(false)} className="text-ink-400 lg:hidden" aria-label="Close navigation">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mx-3 mb-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2">
          <p className="truncate text-xs font-medium text-white">{user.workspaceName}</p>
          <p className="mt-0.5 flex items-center gap-2 text-[11px] text-ink-400">
            <span>{user.planKey} plan</span>
            {user.demoMode ? <DemoBadge className="scale-90" /> : null}
          </p>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {groups.map((group) => (
            <div key={group} className="mb-3">
              <p className="px-2 py-1 text-[10px] font-semibold tracking-widest text-ink-500 uppercase">{group}</p>
              <ul className="space-y-0.5">
                {NAV.filter((entry) => entry.group === group).map((entry) => {
                  const active = pathname === entry.href
                  return (
                    <li key={entry.href}>
                      <Link
                        href={entry.href}
                        className={cn(
                          'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium transition-colors',
                          active ? 'bg-accent-600 text-white' : 'text-ink-300 hover:bg-white/5 hover:text-white',
                        )}
                      >
                        <entry.icon className="h-3.5 w-3.5" />
                        {entry.label}
                        {entry.href === '/dashboard/approvals' ? <span className="ml-auto text-[10px] text-ink-400">queue</span> : null}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
          {user.role === 'admin' ? (
            <div className="mb-3">
              <p className="px-2 py-1 text-[10px] font-semibold tracking-widest text-ink-500 uppercase">Platform</p>
              <ul className="space-y-0.5">
                {ADMIN_NAV.map((entry) => (
                  <li key={entry.href}>
                    <Link
                      href={entry.href}
                      className={cn(
                        'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium transition-colors',
                        pathname === entry.href ? 'bg-accent-600 text-white' : 'text-ink-300 hover:bg-white/5 hover:text-white',
                      )}
                    >
                      <entry.icon className="h-3.5 w-3.5" />
                      {entry.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </nav>

        <div className="border-t border-white/10 p-3">
          <div className="mb-2 flex items-center gap-2">
            <div className="grid h-7 w-7 place-items-center rounded-full bg-white/10 text-[11px] font-semibold text-white">
              {user.name.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-white">{user.name}</p>
              <p className="truncate text-[10px] text-ink-400">{user.email}</p>
            </div>
          </div>
          <Button variant="ghost" size="sm" className="w-full justify-start text-ink-300 hover:bg-white/5 hover:text-white" onClick={signOut} loading={signingOut}>
            {!signingOut ? <LogOut className="h-3.5 w-3.5" /> : null}
            Sign out
          </Button>
        </div>
      </aside>

      {mobileOpen ? <div className="fixed inset-0 z-30 bg-ink-950/40 lg:hidden" onClick={() => setMobileOpen(false)} /> : null}

      {/* ---------------------------------------------------------------- content */}
      <div className="flex min-w-0 flex-1 flex-col lg:pl-64">
        <header className="sticky top-0 z-20 border-b border-ink-200 bg-white/90 backdrop-blur">
          <div className="flex items-center gap-3 px-4 py-2.5">
            <button type="button" onClick={() => setMobileOpen(true)} className="rounded-lg p-2 text-ink-500 hover:bg-ink-100 lg:hidden" aria-label="Open navigation">
              <Menu className="h-4 w-4" />
            </button>

            <StatusPill status={status.data} />

            <div className="ml-auto flex items-center gap-2">
              <Link href="/dashboard/notifications" className="relative rounded-lg p-2 text-ink-500 hover:bg-ink-100" aria-label="Notifications">
                <BellRing className="h-4 w-4" />
                {unread > 0 ? (
                  <span className="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-signal-critical px-1 text-[10px] font-semibold text-white">
                    {unread > 9 ? '9+' : unread}
                  </span>
                ) : null}
              </Link>
              <Link href="/dashboard/settings" className="hidden rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50 sm:inline-flex">
                Settings
              </Link>
            </div>
          </div>

          {user.demoMode ? (
            <div className="flex items-center gap-2 border-t border-violet-200 bg-violet-50 px-4 py-1.5 text-[11px] text-violet-800">
              <AlertTriangle className="h-3.5 w-3.5" />
              Demo mode is on. DEMO DATA is stored separately and is never counted as real revenue.
              <Link href="/dashboard/settings" className="ml-auto font-medium underline">
                Manage
              </Link>
            </div>
          ) : null}

          {!user.onboarded ? (
            <div className="flex items-center gap-2 border-t border-amber-200 bg-amber-50 px-4 py-1.5 text-[11px] text-amber-900">
              <AlertTriangle className="h-3.5 w-3.5" />
              Your setup wizard is not finished — budgets and automation level use defaults until you complete it.
              <Link href="/onboarding" className="ml-auto font-medium underline">
                Finish setup
              </Link>
            </div>
          ) : null}
        </header>

        <main className="flex-1 px-4 py-6">{children}</main>

        <footer className="border-t border-ink-200 px-4 py-3 text-[11px] text-ink-400">
          AIBA v{status.data?.version ?? '1.0.0'} · AI provider: {status.data?.ai.provider ?? 'unknown'} ·{' '}
          {status.data?.ai.configured ? 'configured' : 'not configured (heuristic mode)'} ·{' '}
          <Link href="/api-docs" className="underline hover:text-ink-700">
            API documentation
          </Link>
        </footer>
      </div>
    </div>
  )
}

function StatusPill({ status }: { status: StatusPayload | null }) {
  if (!status) {
    return (
      <div className="flex items-center gap-2 text-xs text-ink-400">
        <span className="h-2 w-2 rounded-full bg-ink-300" />
        Checking system status…
      </div>
    )
  }
  const tone = status.status === 'ONLINE' ? 'bg-signal-positive' : status.status === 'DEGRADED' ? 'bg-signal-warning' : 'bg-signal-critical'
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-600">
      <span className="flex items-center gap-1.5 font-medium">
        <span className={cn('h-2 w-2 rounded-full', tone, status.status === 'ONLINE' ? 'live-dot' : '')} />
        {status.status}
      </span>
      <span className="hidden sm:inline">agents {status.agentsActive}/{status.agentsTotal}</span>
      <span className="hidden md:inline">queue {status.queue.queued} queued · {status.queue.running} running</span>
      {status.currentTask ? <span className="hidden truncate lg:inline">now: {status.currentTask}</span> : null}
      {status.workers === 0 ? <Badge tone="warning">no worker heartbeat</Badge> : null}
      {!status.ai.configured ? <Badge tone="neutral">heuristic mode</Badge> : null}
    </div>
  )
}
