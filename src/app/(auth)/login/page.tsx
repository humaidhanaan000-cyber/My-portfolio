import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { LoginForm } from '@/components/auth/forms'
import { getSession } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to your AIBA workspace to review approvals, projects, revenue and agent activity.',
  robots: { index: false, follow: false },
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await getSession().catch(() => null)
  const params = await searchParams
  const next = typeof params.next === 'string' ? params.next : undefined
  if (session) redirect(next && next.startsWith('/') ? next : '/dashboard')

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight text-ink-900">Sign in</h1>
      <p className="mt-1 text-xs text-ink-500">Use the email and password you registered with.</p>
      <LoginForm nextPath={next} />
      <p className="mt-6 text-center text-xs text-ink-500">
        No account yet?{' '}
        <Link href="/register" className="font-medium text-accent-700 hover:underline">
          Create one
        </Link>
      </p>
    </>
  )
}
