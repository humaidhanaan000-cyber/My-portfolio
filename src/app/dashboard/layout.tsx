import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { DashboardShell } from '@/components/dashboard/shell'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Dashboard',
  robots: { index: false, follow: false },
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession().catch(() => null)
  if (!session) redirect('/login?next=/dashboard')

  return (
    <DashboardShell
      user={{
        name: session.name,
        email: session.email,
        role: session.role,
        workspaceName: session.workspaceName,
        planKey: session.planKey,
        demoMode: session.demoMode,
        onboarded: session.onboarded,
      }}
    >
      {children}
    </DashboardShell>
  )
}
